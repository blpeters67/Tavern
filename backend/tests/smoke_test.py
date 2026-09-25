"""End-to-end smoke test against a real running server.

Starts uvicorn on a temp data dir, then drives the API and the WebSocket
gateway the way two browsers would. Run from backend/:

    python tests/smoke_test.py
"""

from __future__ import annotations

import io
import json
import os
import re
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
from PIL import Image
from websockets.sync.client import connect

PORT = int(os.environ.get("SMOKE_PORT", "8765"))
BASE = f"http://127.0.0.1:{PORT}"


class Gateway:
    """Collects gateway events on a background thread."""

    def __init__(self, client: httpx.Client) -> None:
        cookie = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
        self.ws = connect(f"ws://127.0.0.1:{PORT}/api/gateway", additional_headers={"Cookie": cookie})
        self.events: list[tuple[str, dict]] = []
        self.ready: dict | None = None
        self._stop = False
        self.thread = threading.Thread(target=self._run, daemon=True)
        self.thread.start()
        self.wait_for("READY")

    def _run(self) -> None:
        try:
            for raw in self.ws:
                msg = json.loads(raw)
                if msg.get("op") == 0:
                    if msg["t"] == "READY":
                        self.ready = msg["d"]
                    self.events.append((msg["t"], msg["d"]))
        except Exception:
            pass

    def wait_for(self, name: str, pred=lambda d: True, timeout: float = 5.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            for t, d in list(self.events):
                if t == name and pred(d):
                    self.events.remove((t, d))
                    return d
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for {name}; saw {[t for t, _ in self.events]}")

    def none_of(self, name: str, pred=lambda d: True, wait: float = 0.6) -> None:
        time.sleep(wait)
        hits = [d for t, d in self.events if t == name and pred(d)]
        assert not hits, f"unexpected {name}: {hits}"

    def close(self) -> None:
        self.ws.close()


def png_bytes(color=(200, 50, 50), size=(64, 48)) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", size, color).save(buf, "PNG")
    return buf.getvalue()


def ok(resp: httpx.Response, status: int = 200) -> dict | list:
    assert resp.status_code == status, f"{resp.request.method} {resp.request.url} -> {resp.status_code}: {resp.text}"
    return resp.json() if resp.content else {}


def send(client: httpx.Client, channel_id: int, content: str = "", files=None, **extra) -> dict:
    payload = {"content": content, **extra}
    return ok(client.post(f"/api/channels/{channel_id}/messages", data={"payload_json": json.dumps(payload)}, files=files or None))


def main() -> None:
    data_dir = Path(tempfile.mkdtemp(prefix="tavern-smoke-"))
    log_path = data_dir / "server.log"
    env = dict(os.environ, TAVERN_DATA_DIR=str(data_dir), PUBLIC_URL=BASE, LINK_EMBEDS="false", TAVERN_STATIC_DIR=str(data_dir / "nostatic"))
    log_file = open(log_path, "w")
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "tavern.main:app", "--port", str(PORT), "--log-level", "warning"],
        cwd=Path(__file__).resolve().parent.parent,
        env=env,
        stdout=log_file,
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(100):
            try:
                if httpx.get(f"{BASE}/api/health").status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        else:
            raise SystemExit("server didn't start:\n" + log_path.read_text())
        run(log_path)
        print("\nALL SMOKE TESTS PASSED")
    finally:
        proc.terminate()
        proc.wait(5)
        errors = [line for line in log_path.read_text().splitlines() if "Traceback" in line or "ERROR" in line]
        if errors:
            print("\nServer log had errors:\n" + log_path.read_text())
            sys.exit(1)


def run(log_path: Path) -> None:
    a = httpx.Client(base_url=BASE)
    b = httpx.Client(base_url=BASE)
    c = httpx.Client(base_url=BASE)

    # --- first-run setup ----------------------------------------------------
    assert ok(a.get("/api/auth/status"))["setup_required"] is True
    code = re.search(r"setup code: ([0-9A-F]+)", log_path.read_text()).group(1)
    r = a.post("/api/auth/register", json={"email": "benji@example.com", "username": "benji", "password": "hunter22!", "invite": "WRONG"})
    assert r.status_code == 400 and "invite" in r.json()["errors"], r.text
    me_a = ok(a.post("/api/auth/register", json={"email": "Benji@Example.com", "username": "Benji", "display_name": "Benji", "password": "hunter22!", "invite": code}))["user"]
    assert me_a["username"] == "benji" and me_a["is_admin"] is True
    assert ok(a.get("/api/auth/status"))["setup_required"] is False
    print("setup + owner registration ok")

    # --- server + invite ------------------------------------------------------
    server = ok(a.post("/api/servers", data={"name": "The Rusty Mug"}, files={"icon": ("i.png", png_bytes(), "image/png")}))
    general = next(ch for ch in server["channels"] if ch["type"] == 0)
    assert general["name"] == "General" and server["icon"]
    icon = httpx.get(f"{BASE}/cdn/icons/{server['icon']}")
    assert icon.status_code == 200 and icon.headers["content-type"] == "image/webp"
    invite = ok(a.post(f"/api/channels/{general['id']}/invites", json={"max_age": 86400, "max_uses": 0}))
    info = ok(httpx.get(f"{BASE}/api/invites/{invite['code']}"))
    assert info["server"]["name"] == "The Rusty Mug" and info["member_count"] == 1
    print("server + invite ok")

    gw_a = Gateway(a)
    assert gw_a.ready and len(gw_a.ready["servers"]) == 1

    # registration without invite fails, with invite works
    r = b.post("/api/auth/register", json={"email": "kate@example.com", "username": "kate", "password": "password1"})
    assert r.status_code == 400 and "invite" in r.json()["errors"]
    r = b.post("/api/auth/register", json={"email": "kate@example.com", "username": "benji", "password": "password1", "invite": invite["url"]})
    assert r.status_code == 400 and "username" in r.json()["errors"]
    me_b = ok(b.post("/api/auth/register", json={"email": "kate@example.com", "username": "kate", "display_name": "Kate", "password": "password1", "invite": invite["url"]}))["user"]
    added = gw_a.wait_for("MEMBER_ADD")
    assert added["member"]["user_id"] == me_b["id"] and added["users"][0]["username"] == "kate"
    join_msg = gw_a.wait_for("MESSAGE_CREATE", lambda d: d["type"] == 7)
    assert "{}" in join_msg["content"]
    print("invite registration + join message ok")

    gw_b = Gateway(b)
    assert gw_b.ready["servers"][0]["name"] == "The Rusty Mug"
    assert {u["username"] for u in gw_b.ready["users"]} == {"benji", "kate"}
    pres = gw_a.wait_for("PRESENCE_UPDATE", lambda d: d["user_id"] == me_b["id"])
    assert pres["status"] == "online"

    # --- login / logout -------------------------------------------------------
    r = c.post("/api/auth/login", json={"login": "kate", "password": "nope"})
    assert r.status_code == 400
    ok(c.post("/api/auth/login", json={"login": "KATE@example.com", "password": "password1"}))
    ok(c.get("/api/users/@me"))
    ok(c.post("/api/auth/logout"))
    assert c.get("/api/users/@me").status_code == 401
    print("login/logout ok")

    # --- characters -------------------------------------------------------------
    xar = ok(b.post("/api/users/@me/characters", data={"name": "Xargorf", "proxy": "x:text"}, files={"avatar": ("x.png", png_bytes((20, 120, 40)), "image/png")}))
    assert xar["proxy_prefix"] == "x:" and xar["proxy_suffix"] is None and xar["avatar"]
    public_char = gw_a.wait_for("CHARACTER_CREATE")
    assert public_char["name"] == "Xargorf" and "proxy_prefix" not in public_char
    r = b.post("/api/users/@me/characters", data={"name": "Dup", "proxy": "x:text"})
    assert r.status_code == 400 and "proxy" in r.json()["errors"]
    vex = ok(b.post("/api/users/@me/characters", data={"name": "Lady Vex", "proxy": "[text]"}))
    assert vex["proxy_prefix"] == "[" and vex["proxy_suffix"] == "]"
    upd = ok(b.patch(f"/api/users/@me/characters/{vex['id']}", data={"clear_proxy": "true"}))
    assert upd["proxy_prefix"] is None
    print("characters ok")

    # --- messages ----------------------------------------------------------------
    m1 = send(a, general["id"], f"Hello <@{me_b['id']}>, welcome!", nonce="n-1")
    assert m1["nonce"] == "n-1" and m1["mentions"] == [me_b["id"]]
    got = gw_b.wait_for("MESSAGE_CREATE", lambda d: d["id"] == m1["id"])
    assert got["author"]["username"] == "benji"

    m2 = send(b, general["id"], "*The half-orc grunts.*", character_id=xar["id"], reply_to_id=m1["id"])
    assert m2["character"]["name"] == "Xargorf" and m2["reply_to"]["id"] == m1["id"] and m2["mentions"] == [me_a["id"]]
    gw_a.wait_for("MESSAGE_CREATE", lambda d: d["id"] == m2["id"])

    m3 = send(a, general["id"], f"Hey <@c{xar['id']}>!")
    assert m3["mentions"] == [me_b["id"]]

    # someone else's character is refused
    r = a.post(f"/api/channels/{general['id']}/messages", data={"payload_json": json.dumps({"content": "hi", "character_id": xar["id"]})})
    assert r.status_code == 404

    # attachments
    m4 = send(a, general["id"], "look", files=[("files", ("map.png", png_bytes((10, 10, 200), (300, 200)), "image/png")), ("files", ("notes.html", b"<script>alert(1)</script>", "text/html"))])
    att_img, att_html = m4["attachments"]
    assert att_img["width"] == 300 and att_img["height"] == 200
    r = b.get(att_img["url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/png"
    r = b.get(att_html["url"])
    assert r.headers["content-type"] == "application/octet-stream" and "attachment" in r.headers["content-disposition"]
    assert httpx.get(BASE + att_img["url"]).status_code == 401
    r = b.get(att_img["url"], headers={"Range": "bytes=0-9"})
    assert r.status_code == 206 and len(r.content) == 10
    print("messages + attachments ok")

    # chat-sized previews of big images
    assert "preview_url" not in att_img  # small images are sent as they are
    photo = Image.new("RGB", (2400, 1600), (30, 90, 160))
    exif = Image.Exif()
    exif[0x0112] = 6  # a phone photo stored sideways
    buf = io.BytesIO()
    photo.save(buf, "JPEG", exif=exif.tobytes(), quality=85)
    frames = [Image.new("RGB", (1300, 800), c) for c in ((255, 0, 0), (0, 255, 0))]
    anim = io.BytesIO()
    frames[0].save(anim, "WEBP", save_all=True, append_images=frames[1:], duration=100, loop=0)
    m5 = send(a, general["id"], "photos", files=[("files", ("photo.jpg", buf.getvalue(), "image/jpeg")), ("files", ("spin.webp", anim.getvalue(), "image/webp"))])
    att_photo, att_anim = m5["attachments"]
    assert (att_photo["width"], att_photo["height"]) == (1600, 2400) and att_photo["preview_url"]
    r = b.get(att_photo["preview_url"])
    assert r.status_code == 200 and r.headers["content-type"] == "image/webp", r.headers
    with Image.open(io.BytesIO(r.content)) as prev:
        assert prev.size == (467, 700), prev.size  # upright, fitted to 1100x700
    previews = log_path.parent / "uploads" / "previews"
    assert len(list(previews.iterdir())) == 1
    assert b.get(att_photo["preview_url"]).content == r.content  # made once, then served from disk
    r = b.get(att_anim["preview_url"])  # animated: no preview, the original instead
    assert r.status_code == 200 and r.content == anim.getvalue()
    assert httpx.get(BASE + att_photo["preview_url"]).status_code == 401
    assert b.get(f"/cdn/previews/{att_img['id']}.webp").status_code == 404  # small image: no preview
    ok(a.delete(f"/api/channels/{general['id']}/messages/{m5['id']}"))
    assert not list(previews.iterdir()), "preview left behind"
    print("image previews ok")

    # history
    hist = ok(b.get(f"/api/channels/{general['id']}/messages"))
    ids = [m["id"] for m in hist]
    assert ids == sorted(ids) and m4["id"] == ids[-1]
    older = ok(b.get(f"/api/channels/{general['id']}/messages", params={"before": m2["id"]}))
    assert all(m["id"] < m2["id"] for m in older)
    around = ok(b.get(f"/api/channels/{general['id']}/messages", params={"around": m2["id"], "limit": 3}))
    assert m2["id"] in [m["id"] for m in around]

    # edit / delete
    edited = ok(a.patch(f"/api/channels/{general['id']}/messages/{m1['id']}", json={"content": "Hello everyone, welcome!"}))
    assert edited["edited_at"] and edited["mentions"] == []
    gw_b.wait_for("MESSAGE_UPDATE", lambda d: d["id"] == m1["id"])
    r = b.patch(f"/api/channels/{general['id']}/messages/{m1['id']}", json={"content": "hax"})
    assert r.status_code == 403
    r = b.delete(f"/api/channels/{general['id']}/messages/{m1['id']}")
    assert r.status_code == 403
    ok(a.delete(f"/api/channels/{general['id']}/messages/{m3['id']}"))
    gw_b.wait_for("MESSAGE_DELETE", lambda d: d["id"] == m3["id"])
    print("edit/delete ok")

    # reactions
    ok(b.put(f"/api/channels/{general['id']}/messages/{m2['id']}/reactions/{httpx.URL('/' + '🍺').path[1:]}/@me"))
    rx = gw_a.wait_for("MESSAGE_REACTION_ADD")
    assert rx["emoji"]["name"] == "🍺" and rx["user_id"] == me_b["id"]
    ok(a.put(f"/api/channels/{general['id']}/messages/{m2['id']}/reactions/%F0%9F%8D%BA/@me"))
    msg = next(m for m in ok(a.get(f"/api/channels/{general['id']}/messages")) if m["id"] == m2["id"])
    assert msg["reactions"][0]["count"] == 2
    ok(a.delete(f"/api/channels/{general['id']}/messages/{m2['id']}/reactions/%F0%9F%8D%BA/@me"))
    gw_b.wait_for("MESSAGE_REACTION_REMOVE")
    assert a.put(f"/api/channels/{general['id']}/messages/{m2['id']}/reactions/abc/@me").status_code == 400
    print("reactions ok")

    # custom emoji
    emoji = ok(a.post(f"/api/servers/{server['id']}/emojis", data={"name": "smug"}, files={"file": ("s.png", png_bytes(), "image/png")}))
    gw_b.wait_for("EMOJIS_UPDATE")
    ok(b.put(f"/api/channels/{general['id']}/messages/{m2['id']}/reactions/smug:{emoji['id']}/@me"))
    assert b.get(f"/cdn/emojis/{emoji['id']}").status_code == 200
    print("custom emoji ok")

    # pins
    r = b.put(f"/api/channels/{general['id']}/pins/{m2['id']}")
    assert r.status_code == 403  # @everyone can't pin by default
    ok(a.put(f"/api/channels/{general['id']}/pins/{m2['id']}"))
    gw_b.wait_for("MESSAGE_UPDATE", lambda d: d["id"] == m2["id"] and d.get("pinned") is True)
    sysmsg = gw_b.wait_for("MESSAGE_CREATE", lambda d: d["type"] == 6)
    assert sysmsg["meta"]["message_id"] == m2["id"]
    pins = ok(b.get(f"/api/channels/{general['id']}/pins"))
    assert [p["id"] for p in pins] == [m2["id"]]
    print("pins ok")

    # --- roles & permissions ------------------------------------------------------
    ooc = ok(a.post(f"/api/servers/{server['id']}/channels", json={"name": "OOC Chat!", "type": 0}))
    assert ooc["name"] == "OOC Chat!"
    gw_b.wait_for("CHANNEL_CREATE", lambda d: d["id"] == ooc["id"])
    everyone = next(r for r in server["roles"] if r["is_default"])
    # No characters in OOC
    ok(a.put(f"/api/channels/{ooc['id']}/permissions/0/{everyone['id']}", json={"allow": 0, "deny": 1 << 7}))
    r = b.post(f"/api/channels/{ooc['id']}/messages", data={"payload_json": json.dumps({"content": "hi", "character_id": xar["id"]})})
    assert r.status_code == 403
    send(b, ooc["id"], "ooc hi as myself")

    gm_room = ok(a.post(f"/api/servers/{server['id']}/channels", json={"name": "gm-notes", "type": 0}))
    ok(a.put(f"/api/channels/{gm_room['id']}/permissions/0/{everyone['id']}", json={"allow": 0, "deny": 1}))
    gw_b.wait_for("CHANNEL_UPDATE", lambda d: d["id"] == gm_room["id"])
    assert b.get(f"/api/channels/{gm_room['id']}/messages").status_code == 404
    secret = send(a, gm_room["id"], "the dragon is actually a cat")
    gw_b.none_of("MESSAGE_CREATE", lambda d: d["id"] == secret["id"])

    gm = ok(a.post(f"/api/servers/{server['id']}/roles", json={"name": "Game Master", "color": 0xE67E22, "permissions": 1 << 8, "hoist": True}))
    gw_b.wait_for("ROLES_UPDATE")
    ok(a.put(f"/api/channels/{gm_room['id']}/permissions/0/{gm['id']}", json={"allow": 1, "deny": 0}))
    ok(a.put(f"/api/servers/{server['id']}/members/{me_b['id']}/roles/{gm['id']}"))
    mu = gw_b.wait_for("MEMBER_UPDATE", lambda d: d["user_id"] == me_b["id"])
    assert mu["role_ids"] == [gm["id"]]
    assert len(ok(b.get(f"/api/channels/{gm_room['id']}/messages"))) == 1
    ok(b.put(f"/api/channels/{general['id']}/pins/{m4['id']}"))  # GM can pin now
    # Kate (GM) can't give herself admin
    assert b.patch(f"/api/servers/{server['id']}/roles/{gm['id']}", json={"permissions": 1 << 30}).status_code == 403
    assert b.delete(f"/api/servers/{server['id']}/members/{me_a['id']}").status_code == 403
    print("roles & permissions ok")

    # --- DMs --------------------------------------------------------------------
    dm = ok(a.post("/api/users/@me/channels", json={"recipient_ids": [me_b["id"]]}))
    assert dm["type"] == 1 and sorted(dm["recipient_ids"]) == sorted([me_a["id"], me_b["id"]])
    gw_b.none_of("CHANNEL_CREATE", lambda d: d["id"] == dm["id"], wait=0.3)
    dm_msg = send(a, dm["id"], "psst")
    gw_b.wait_for("CHANNEL_CREATE", lambda d: d["id"] == dm["id"])
    gw_b.wait_for("MESSAGE_CREATE", lambda d: d["id"] == dm_msg["id"])
    again = ok(b.post("/api/users/@me/channels", json={"recipient_ids": [me_a["id"]]}))
    assert again["id"] == dm["id"]
    send(b, dm["id"], "*whispers back*", character_id=xar["id"])
    print("DMs ok")

    # --- read state -----------------------------------------------------------
    ping = send(a, general["id"], f"<@{me_b['id']}> ping")
    gw_b.close()
    time.sleep(0.2)
    gw_b = Gateway(b)
    rs = {r["channel_id"]: r for r in gw_b.ready["read_states"]}
    assert rs[general["id"]]["mention_count"] >= 1
    # The newest mention the count includes, so a client doesn't count it again
    # when the same message also arrives as an event.
    assert rs[general["id"]]["last_mention_id"] == ping["id"]
    last = gw_b.ready["servers"][0]["channels"]
    general_now = next(ch for ch in last if ch["id"] == general["id"])
    ok(b.post(f"/api/channels/{general['id']}/ack", json={"message_id": general_now["last_message_id"]}))
    gw_b.wait_for("READ_STATE_UPDATE")
    ok(b.put(f"/api/channels/{general['id']}/persona", json={"character_id": xar["id"]}))
    gw_b.close()
    gw_b = Gateway(b)
    rs = {r["channel_id"]: r for r in gw_b.ready["read_states"]}
    assert rs[general["id"]]["mention_count"] == 0 and rs[general["id"]]["last_character_id"] == xar["id"]
    assert rs[general["id"]]["last_mention_id"] == 0
    print("read state + persona memory ok")

    # --- settings & profile -------------------------------------------------------
    s = ok(b.patch("/api/users/@me/settings", json={"immersive": True, "switch_hotkey": False}))
    assert s["immersive"] is True and s["switch_proxy"] is True
    assert b.patch("/api/users/@me/settings", json={"bogus": 1}).status_code == 400
    upd = ok(b.patch("/api/users/@me", json={"display_name": "Kate the Great", "status": "dnd"}))
    assert upd["display_name"] == "Kate the Great"
    gw_a.wait_for("USER_UPDATE", lambda d: d["id"] == me_b["id"])
    gw_a.wait_for("PRESENCE_UPDATE", lambda d: d["user_id"] == me_b["id"] and d["status"] == "dnd")
    assert b.patch("/api/users/@me", json={"username": "katie"}).status_code == 400  # needs password
    ok(b.patch("/api/users/@me", json={"username": "katie", "password": "password1"}))
    ok(b.put("/api/users/@me/avatar", files={"file": ("a.png", png_bytes((1, 2, 3), (500, 300)), "image/png")}))
    print("settings/profile ok")

    # --- password reset --------------------------------------------------------------
    d = httpx.Client(base_url=BASE)
    ok(d.post("/api/auth/forgot", json={"login": "katie"}))
    ok(d.post("/api/auth/forgot", json={"login": "nobody@example.com"}))
    link = None
    for _ in range(50):
        m = re.search(r"reset-password#token=([\w-]+)", log_path.read_text())
        if m:
            link = m.group(1)
            break
        time.sleep(0.1)
    assert link, "reset link never logged"
    assert ok(d.post("/api/auth/reset/check", json={"token": link}))["valid"] is True
    assert d.post("/api/auth/reset", json={"token": link, "password": "short"}).status_code == 400
    ok(d.post("/api/auth/reset", json={"token": link, "password": "brand-new-pass"}))
    assert ok(d.post("/api/auth/reset/check", json={"token": link}))["valid"] is False
    assert b.get("/api/users/@me").status_code == 401  # old session killed
    ok(b.post("/api/auth/login", json={"login": "katie", "password": "brand-new-pass"}))
    print("password reset ok")

    # --- kick / ban ------------------------------------------------------------------
    ok(a.put(f"/api/servers/{server['id']}/bans/{me_b['id']}", json={"reason": "testing"}))
    gw_a.wait_for("MEMBER_REMOVE", lambda d: d["user_id"] == me_b["id"])
    assert b.get(f"/api/channels/{general['id']}/messages").status_code == 404
    r = b.post(f"/api/invites/{invite['code']}")
    assert r.status_code == 403
    ok(a.delete(f"/api/servers/{server['id']}/bans/{me_b['id']}"))
    ok(b.post(f"/api/invites/{invite['code']}"))
    print("ban/unban ok")

    # --- CSRF guard ---------------------------------------------------------------------
    r = a.post(f"/api/channels/{general['id']}/typing", json={}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    ok(a.post(f"/api/channels/{general['id']}/typing", json={}, headers={"Origin": BASE}))
    print("origin guard ok")

    # --- channel + server deletion ------------------------------------------------------
    ok(a.delete(f"/api/channels/{gm_room['id']}"))
    ok(a.delete(f"/api/servers/{server['id']}"))
    gw_a.wait_for("SERVER_DELETE")
    print("deletion ok")
    gw_a.close()
    gw_b.close()


if __name__ == "__main__":
    main()
