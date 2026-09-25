"""End-to-end checks for the roleplay features: voice signaling, jukebox,
character sheets, dice, narration, DM Lock and channel changes.

Run from backend/ (needs ffmpeg for test audio):

    python tests/smoke_v2.py
"""

from __future__ import annotations

import http.server
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

import httpx
from websockets.sync.client import connect

PORT = int(os.environ.get("SMOKE_PORT", "8767"))
BASE = f"http://127.0.0.1:{PORT}"
P_DJ = 1 << 23
P_DM = 1 << 24
P_ADMIN = 1 << 30


class Gateway:
    def __init__(self, client: httpx.Client) -> None:
        cookie = "; ".join(f"{k}={v}" for k, v in client.cookies.items())
        self.ws = connect(f"ws://127.0.0.1:{PORT}/api/gateway", additional_headers={"Cookie": cookie})
        self.events: list[tuple[str, dict]] = []
        self.ops: list[dict] = []
        self.ready: dict | None = None
        self.lock = threading.Lock()
        threading.Thread(target=self._run, daemon=True).start()
        self.wait_for("READY")

    def _run(self) -> None:
        try:
            for raw in self.ws:
                msg = json.loads(raw)
                with self.lock:
                    if msg.get("op") == 0:
                        if msg["t"] == "READY":
                            self.ready = msg["d"]
                        self.events.append((msg["t"], msg["d"]))
                    else:
                        self.ops.append(msg)
        except Exception:
            pass

    def send(self, op: int, d: dict) -> None:
        self.ws.send(json.dumps({"op": op, "d": d}))

    def wait_for(self, name: str, pred=lambda d: True, timeout: float = 8.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for t, d in list(self.events):
                    if t == name and pred(d):
                        self.events.remove((t, d))
                        return d
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for {name}; saw {[t for t, _ in self.events]}")

    def wait_op(self, op: int, timeout: float = 5.0) -> dict:
        deadline = time.time() + timeout
        while time.time() < deadline:
            with self.lock:
                for m in list(self.ops):
                    if m.get("op") == op:
                        self.ops.remove(m)
                        return m
            time.sleep(0.02)
        raise AssertionError(f"timed out waiting for op {op}")

    def none_of(self, name: str, pred=lambda d: True, wait: float = 0.6) -> None:
        time.sleep(wait)
        with self.lock:
            hits = [d for t, d in self.events if t == name and pred(d)]
        assert not hits, f"unexpected {name}: {hits}"

    def drain(self) -> None:
        with self.lock:
            self.events.clear()

    def close(self) -> None:
        self.ws.close()


def ok(resp: httpx.Response, status: int = 200):
    assert resp.status_code == status, f"{resp.request.method} {resp.request.url} -> {resp.status_code}: {resp.text}"
    return resp.json() if resp.content else {}


def send(client: httpx.Client, channel_id: int, content: str = "", **extra) -> dict:
    return ok(client.post(f"/api/channels/{channel_id}/messages", data={"payload_json": json.dumps({"content": content, **extra})}))


def make_audio(path: Path, seconds: float, freq: int, fmt: str) -> None:
    codec = ["-c:a", "libmp3lame", "-b:a", "96k"] if fmt == "mp3" else ["-c:a", "pcm_s16le"]
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}", *codec, str(path)],
        check=True,
    )


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is needed for this test")
    data_dir = Path(tempfile.mkdtemp(prefix="tavern-smoke2-"))
    log_path = data_dir / "server.log"
    env = dict(
        os.environ,
        TAVERN_DATA_DIR=str(data_dir),
        PUBLIC_URL=BASE,
        LINK_EMBEDS="false",
        TAVERN_STATIC_DIR=str(data_dir / "nostatic"),
        JUKEBOX_ALLOW_PRIVATE_URLS="true",
    )
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
        run(log_path, data_dir)
        print("\nALL V2 SMOKE TESTS PASSED")
    finally:
        proc.terminate()
        proc.wait(5)
        errors = [line for line in log_path.read_text().splitlines() if "Traceback" in line or "ERROR" in line]
        if errors:
            print("\nServer log had errors:\n" + log_path.read_text())
            sys.exit(1)


def run(log_path: Path, data_dir: Path) -> None:
    a = httpx.Client(base_url=BASE, timeout=30)
    b = httpx.Client(base_url=BASE, timeout=30)
    c = httpx.Client(base_url=BASE, timeout=30)

    code = re.search(r"setup code: ([0-9A-F]+)", log_path.read_text()).group(1)
    me_a = ok(a.post("/api/auth/register", json={"email": "gm@example.com", "username": "gm", "password": "hunter22!", "invite": code}))["user"]
    server = ok(a.post("/api/servers", data={"name": "Castle Grounds"}))
    sid = server["id"]
    names = {r["name"] for r in server["roles"]}
    assert {"@everyone", "Dungeon Master", "DJ"} <= names, names
    dm_role = next(r for r in server["roles"] if r["name"] == "Dungeon Master")
    dj_role = next(r for r in server["roles"] if r["name"] == "DJ")
    assert dm_role["permissions"] & P_DM and dj_role["permissions"] & P_DJ
    general = next(ch for ch in server["channels"] if ch["type"] == 0)
    lounge = next(ch for ch in server["channels"] if ch["type"] == 2)
    assert general["name"] == "General" and lounge["name"] == "The Lounge"
    assert server["narrator_name"] == "The GM" and server["roleplay_mode"] is False
    assert server["jukebox"]["queue"] == [] and server["voice_states"] == []
    invite = ok(a.post(f"/api/channels/{general['id']}/invites", json={"max_age": 86400, "max_uses": 0}))
    me_b = ok(b.post("/api/auth/register", json={"email": "b@example.com", "username": "isaiah", "password": "password1", "invite": invite["code"]}))["user"]
    me_c = ok(c.post("/api/auth/register", json={"email": "c@example.com", "username": "colby", "password": "password1", "invite": invite["code"]}))["user"]
    gw_a, gw_b, gw_c = Gateway(a), Gateway(b), Gateway(c)
    print("setup ok (default roles + channels)")

    # --- channels: capitals, spaces, icons, voice ---------------------------------------
    wb = ok(a.post(f"/api/servers/{sid}/channels", json={"name": "World Building", "type": 0, "emoji": "📜"}))
    assert wb["name"] == "World Building" and wb["emoji"] == "📜"
    small = ok(a.post(f"/api/servers/{sid}/channels", json={"name": "Game Room", "type": 2, "user_limit": 1}))
    assert small["type"] == 2 and small["user_limit"] == 1
    # voice bitrate: 64 kbps until someone changes it, 8-256
    assert lounge["bitrate"] == 64 and small["bitrate"] == 64 and "bitrate" not in general
    assert ok(a.patch(f"/api/channels/{small['id']}", json={"bitrate": 128}))["bitrate"] == 128
    assert a.patch(f"/api/channels/{small['id']}", json={"bitrate": 4}).status_code == 400
    assert a.patch(f"/api/channels/{small['id']}", json={"bitrate": 512}).status_code == 400
    assert a.post(f"/api/servers/{sid}/channels", json={"name": "x", "type": 0, "emoji": "abc"}).status_code == 400
    wb = ok(a.patch(f"/api/channels/{wb['id']}", json={"emoji": "🗺️", "name": "Lore & Maps"}))
    assert wb["emoji"] == "🗺️" and wb["name"] == "Lore & Maps"
    gw_b.wait_for("CHANNEL_UPDATE", lambda d: d["id"] == wb["id"])
    print("channels ok")

    # --- characters + sheets ---------------------------------------------------------------
    isa = ok(b.post("/api/users/@me/characters", data={"name": "Isaiah Vale", "color": "#7AA2F7", "proxy": "i:text"}))
    assert isa["color"] == "#7aa2f7" and isa["sheet_visibility"] == "public"
    sheet = ok(b.get(f"/api/characters/{isa['id']}/sheet"))
    assert sheet["can_edit"] and sheet["sheet"]["abilities"]["dex"] == 10
    patch = {
        "species": "Half-Elf",
        "alignment": "CG",
        "classes": {"c1": {"name": "Rogue", "level": 5, "hit_die": 8}},
        "abilities": {"dex": 18, "wis": 12},
        "skills": {"stealth": {"prof": 2}},
        "attacks": {"a1": {"name": "Rapier", "ability": "dex", "proficient": True, "damage": "1d8", "damage_ability": True, "damage_type": "piercing"}},
        "inventory": {"i1": {"name": "Thieves' tools", "qty": 1}},
        "currency": {"gp": 42, "sp": 5},
        "notes": "Owes the guild money.",
        "bogus": 1,
    }
    sheet = ok(b.patch(f"/api/characters/{isa['id']}/sheet", json={"patch": patch}))["sheet"]
    assert sheet["skills"]["stealth"]["prof"] == 2 and "bogus" not in sheet and sheet["rev"] == 1
    up = gw_a.wait_for("CHARACTER_SHEET_UPDATE", lambda d: d["character_id"] == isa["id"])
    assert up["patch"]["currency"]["gp"] == 42
    cu = gw_c.wait_for("CHARACTER_UPDATE", lambda d: d["id"] == isa["id"])
    assert cu["summary"]["classes"] == "Rogue 5" and cu["summary"]["gold"] == 42.5
    # C (not a DM) can read the public sheet but not edit it
    assert ok(c.get(f"/api/characters/{isa['id']}/sheet"))["can_edit"] is False
    assert c.patch(f"/api/characters/{isa['id']}/sheet", json={"patch": {"xp": 5}}).status_code == 403
    # The owner of the server is a DM everywhere: they can edit
    sheet = ok(a.patch(f"/api/characters/{isa['id']}/sheet", json={"patch": {"hp": {"current": 3}, "inventory": {"i2": {"name": "Rope"}}}}))["sheet"]
    assert sheet["hp"]["current"] == 3 and set(sheet["inventory"]) == {"i1", "i2"}
    # Private sheet: C can't see it anymore, and the summary is hidden
    ok(b.patch(f"/api/users/@me/characters/{isa['id']}", data={"sheet_visibility": "private"}))
    cu = gw_c.wait_for("CHARACTER_UPDATE", lambda d: d["id"] == isa["id"] and d["sheet_visibility"] == "private")
    assert "summary" not in cu
    assert c.get(f"/api/characters/{isa['id']}/sheet").status_code == 404
    assert ok(a.get(f"/api/characters/{isa['id']}/sheet"))["sheet"]["hp"]["current"] == 3
    ok(b.patch(f"/api/users/@me/characters/{isa['id']}", data={"sheet_visibility": "public"}))
    print("character sheets ok")

    # --- dice ---------------------------------------------------------------------------------
    gw_a.drain(), gw_b.drain(), gw_c.drain()
    r = ok(b.post(f"/api/channels/{general['id']}/rolls", json={"kind": "custom", "expression": "2d20kh1+3", "label": "Luck"}))
    assert r["type"] == 20 and r["meta"]["roll"]["parts"][0]["expression"] == "2d20kh1+3"
    assert r["content"].startswith("🎲")
    gw_c.wait_for("MESSAGE_CREATE", lambda d: d["id"] == r["id"])
    r = ok(b.post(f"/api/channels/{general['id']}/rolls", json={"kind": "skill", "key": "stealth", "character_id": isa["id"], "dc": 15}))
    roll = r["meta"]["roll"]
    assert roll["parts"][0]["expression"] == "1d20+10" and roll["outcome"] in ("success", "failure") and roll["flavor"]
    assert r["character_id"] == isa["id"]
    assert b.post(f"/api/channels/{general['id']}/rolls", json={"kind": "custom", "expression": "1d1"}).status_code == 400
    # C can't roll for Isaiah; the DM can
    assert c.post(f"/api/channels/{general['id']}/rolls", json={"kind": "skill", "key": "stealth", "character_id": isa["id"]}).status_code == 403
    r = ok(a.post(f"/api/channels/{general['id']}/rolls", json={"kind": "attack", "key": "a1", "character_id": isa["id"], "adv": "adv"}))
    roll = r["meta"]["roll"]
    assert roll["rolled_by"] == me_a["id"] and roll["for_user_id"] == me_b["id"] and len(roll["parts"]) == 2
    assert roll["parts"][0]["expression"] == "2d20kh1+7" and roll["parts"][1]["expression"].startswith("1d8+4")
    # Private roll: only the roller and DMs see it
    secret = ok(b.post(f"/api/channels/{general['id']}/rolls", json={"kind": "skill", "key": "insight", "character_id": isa["id"], "private": True}))
    assert secret["dm_only"] is True
    gw_a.wait_for("MESSAGE_CREATE", lambda d: d["id"] == secret["id"])
    gw_c.none_of("MESSAGE_CREATE", lambda d: d["id"] == secret["id"])
    assert secret["id"] not in [m["id"] for m in ok(c.get(f"/api/channels/{general['id']}/messages"))]
    assert secret["id"] in [m["id"] for m in ok(a.get(f"/api/channels/{general['id']}/messages"))]
    assert c.put(f"/api/channels/{general['id']}/messages/{secret['id']}/reactions/%F0%9F%8D%BA/@me").status_code == 404
    print("dice ok (custom, skill, DM-for-player attack, private)")

    # --- narration ---------------------------------------------------------------------------
    n = send(a, general["id"], "The tavern falls quiet.", narrator=True)
    assert n["meta"] == {"narrator": True} and n["character_id"] is None and n["book"] is True
    # Book look is the sender's choice, per message (as a character or as yourself)
    bk = send(b, general["id"], 'She waves. "Hi!"', character_id=isa["id"], book=True)
    assert bk["book"] is True
    plain = send(b, general["id"], "just me", book=False)
    assert "book" not in plain
    hist = {m["id"]: m for m in ok(b.get(f"/api/channels/{general['id']}/messages"))}
    assert hist[bk["id"]]["book"] is True and "book" not in hist[plain["id"]]
    r = c.post(f"/api/channels/{general['id']}/messages", data={"payload_json": json.dumps({"content": "x", "narrator": True})})
    assert r.status_code == 403
    ok(b.put(f"/api/channels/{general['id']}/persona", json={"character_id": isa["id"]}))
    gw_c.wait_for("CHANNEL_PERSONA", lambda d: d["user_id"] == me_b["id"] and d["character_id"] == isa["id"])
    print("narration + persona broadcast ok")

    # --- search ---------------------------------------------------------------------------------
    send(b, general["id"], "The weathered leather book has a silver sigil")
    found = ok(c.get("/api/search", params={"q": "leath sig", "server_id": sid}))
    assert found["total"] == 0  # all words must match; "sig" prefix ok but "leath" is a prefix too
    found = ok(c.get("/api/search", params={"q": "weathered sil", "server_id": sid}))
    assert found["total"] == 1 and "sigil" in found["messages"][0]["content"]
    found = ok(c.get("/api/search", params={"q": "insight", "server_id": sid}))
    assert all(not m.get("dm_only") for m in found["messages"])  # C can't find B's private roll
    found = ok(a.get("/api/search", params={"q": "insight", "server_id": sid}))
    assert any(m.get("dm_only") for m in found["messages"])  # the DM can
    found = ok(c.get("/api/search", params={"has": "roll", "server_id": sid}))
    assert found["total"] >= 3
    assert c.get("/api/search", params={"q": "  ", "server_id": sid}).status_code == 400
    # a channel inside a hidden category stays out of server-wide results
    everyone = next(r for r in server["roles"] if r["name"] == "@everyone")
    vault = ok(a.post(f"/api/servers/{sid}/channels", json={"name": "GM Vault", "type": 4}))
    ok(a.put(f"/api/channels/{vault['id']}/permissions/0/{everyone['id']}", json={"allow": 0, "deny": 1}))
    notes = ok(a.post(f"/api/servers/{sid}/channels", json={"name": "plot-notes", "type": 0, "parent_id": vault["id"]}))
    send(a, notes["id"], "The duke is secretly a doppelganger")
    assert ok(c.get("/api/search", params={"q": "doppelganger", "server_id": sid}))["total"] == 0
    assert ok(a.get("/api/search", params={"q": "doppelganger", "server_id": sid}))["total"] == 1
    print("search ok")

    # --- custom status, admin role -------------------------------------------------------------
    ok(b.patch("/api/users/@me", json={"custom_status": "Taking a break"}))
    assert gw_c.wait_for("USER_UPDATE", lambda d: d["id"] == me_b["id"])["custom_status"] == "Taking a break"
    admin = ok(a.post(f"/api/servers/{sid}/roles", json={"name": "Admin", "permissions": P_ADMIN}))
    assert admin["permissions"] == P_ADMIN
    print("custom status + admin role ok")

    # --- roleplay mode + DJ permissions --------------------------------------------------------
    assert c.post(f"/api/servers/{sid}/jukebox/control", json={"action": "play"}).status_code == 403
    ok(a.put(f"/api/servers/{sid}/members/{me_b['id']}/roles/{dj_role['id']}"))
    assert c.put(f"/api/servers/{sid}/roleplay", json={"enabled": True}).status_code == 403

    # --- jukebox: uploads -------------------------------------------------------------------------
    tmp = data_dir / "audio"
    tmp.mkdir()
    make_audio(tmp / "Aurora.mp3", 4, 440, "mp3")
    make_audio(tmp / "Tavern Theme.wav", 3, 660, "wav")
    with open(tmp / "Aurora.mp3", "rb") as f1, open(tmp / "Tavern Theme.wav", "rb") as f2:
        up = ok(
            b.post(
                f"/api/servers/{sid}/jukebox/tracks",
                files=[("files", ("Aurora.mp3", f1, "audio/mpeg")), ("files", ("Tavern Theme.wav", f2, "audio/wav"))],
                data={"tags": json.dumps(["Ambient", "Fantasy"])},
            )
        )
    t1, t2 = up["tracks"]
    assert t1["status"] == "processing" and t1["tags"] == ["Ambient", "Fantasy"]
    r1 = gw_c.wait_for("JUKEBOX_TRACK_UPDATE", lambda d: d["id"] == t1["id"] and d["status"] == "ready", timeout=60)
    r2 = gw_c.wait_for("JUKEBOX_TRACK_UPDATE", lambda d: d["id"] == t2["id"] and d["status"] == "ready", timeout=60)
    assert 3800 <= r1["duration_ms"] <= 4300 and r1["url"].endswith(".mp3"), r1
    assert r2["url"].endswith(".m4a") and 2800 <= r2["duration_ms"] <= 3300, r2
    audio = b.get(r1["url"], headers={"Range": "bytes=0-99"})
    assert audio.status_code == 206 and len(audio.content) == 100
    assert httpx.get(BASE + r1["url"]).status_code == 401  # needs a login
    library = ok(c.get(f"/api/servers/{sid}/jukebox/tracks"))
    assert {t["id"] for t in library["tracks"]} == {t1["id"], t2["id"]}
    print("jukebox uploads ok (mp3 kept, wav converted, range requests)")

    # --- jukebox: link import via yt-dlp (generic extractor on a local file) ----------------------
    served = tmp / "served"
    served.mkdir()
    make_audio(served / "Link Song.mp3", 2, 520, "mp3")
    handler = lambda *args, **kw: http.server.SimpleHTTPRequestHandler(*args, directory=str(served), **kw)  # noqa: E731
    httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    link = f"http://127.0.0.1:{httpd.server_address[1]}/Link%20Song.mp3"
    imp = ok(b.post(f"/api/servers/{sid}/jukebox/import", json={"url": link, "tags": ["Combat"]}))["track"]
    done = gw_c.wait_for("JUKEBOX_TRACK_UPDATE", lambda d: d["id"] == imp["id"] and d["status"] in ("ready", "failed"), timeout=90)
    assert done["status"] == "ready", done
    assert done["tags"] == ["Combat"] and done["source_url"]
    httpd.shutdown()
    assert b.post(f"/api/servers/{sid}/jukebox/import", json={"url": "ftp://nope"}).status_code == 400
    print("jukebox link import ok")

    # --- jukebox: queue & playback ------------------------------------------------------------------
    gw_c.drain()
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "fade", "value": False}))
    gw_c.wait_for("JUKEBOX_STATE", lambda d: d["fade"] is False)
    ok(b.post(f"/api/servers/{sid}/jukebox/queue", json={"track_ids": [t1["id"], t2["id"]]}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["current"] is not None)
    assert st["playing"] and st["current"]["track_id"] == t1["id"] and len(st["queue"]) == 1
    assert str(t1["id"]) in st["tracks"] and st["started_at"] > 0
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "volume", "value": 55}))
    assert gw_c.wait_for("JUKEBOX_STATE", lambda d: d["volume"] == 55)
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "pause"}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: not d["playing"])
    assert st["position"] > 0
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "seek", "value": 3000}))
    assert gw_c.wait_for("JUKEBOX_STATE", lambda d: d["position"] == 3000)
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "play"}))
    # ~1s of track 1 left: the server should advance to track 2 on its own
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["current"] and d["current"]["track_id"] == t2["id"], timeout=6)
    assert st["playing"] and st["history"][-1]["track_id"] == t1["id"]
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "previous"}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["current"] and d["current"]["track_id"] == t1["id"])
    assert st["queue"][0]["track_id"] == t2["id"]
    ok(b.post(f"/api/servers/{sid}/jukebox/queue", json={"track_ids": [imp["id"]], "where": "next"}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: len(d["queue"]) == 2)
    assert st["queue"][0]["track_id"] == imp["id"]
    ok(b.put(f"/api/servers/{sid}/jukebox/queue", json={"qids": [st["queue"][1]["qid"], st["queue"][0]["qid"]]}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["queue"] and d["queue"][0]["track_id"] == t2["id"])
    ok(b.delete(f"/api/servers/{sid}/jukebox/queue/{st['queue'][0]['qid']}"))
    gw_c.wait_for("JUKEBOX_STATE", lambda d: len(d["queue"]) == 1)
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "repeat", "value": "one"}))
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "fade", "value": True}))
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "skip"}))
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["transition"] is not None)
    assert st["transition"]["then"] == "skip"
    st = gw_c.wait_for("JUKEBOX_STATE", lambda d: d["transition"] is None and d["current"]["track_id"] == imp["id"], timeout=6)
    ok(b.delete(f"/api/servers/{sid}/jukebox/queue"))
    gw_c.wait_for("JUKEBOX_STATE", lambda d: d["queue"] == [])
    print("jukebox playback ok (auto-advance, previous, reorder, fade skip, clear)")

    # --- roleplay mode --------------------------------------------------------------------------------
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": True}))
    assert gw_b.wait_for("SERVER_UPDATE", lambda d: d["roleplay_mode"])["roleplay_mode"]
    r = b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "pause"})
    assert r.status_code == 403 and "DM Lock" in r.json()["detail"]
    ok(a.post(f"/api/servers/{sid}/jukebox/control", json={"action": "fade_out"}))
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": False}))
    ok(b.post(f"/api/servers/{sid}/jukebox/control", json={"action": "play"}))
    # deleting the playing track moves on
    ok(b.delete(f"/api/servers/{sid}/jukebox/tracks/{imp['id']}"))
    gw_c.wait_for("JUKEBOX_TRACK_DELETE", lambda d: d["track_id"] == imp["id"])
    print("roleplay mode ok")

    # --- jukebox listeners + clock sync ------------------------------------------------------------
    gw_c.send(9, {"server_id": sid, "listening": True})
    lst = gw_a.wait_for("JUKEBOX_LISTENERS", lambda d: me_c["id"] in d["user_ids"])
    assert lst["server_id"] == sid
    gw_c.send(7, {"c": 12345})
    m = gw_c.wait_op(7)
    assert m["d"]["c"] == 12345 and abs(m["d"]["s"] - time.time() * 1000) < 5000
    gw_c.send(9, {"server_id": sid, "listening": False})
    gw_a.wait_for("JUKEBOX_LISTENERS", lambda d: me_c["id"] not in d["user_ids"])
    print("listeners + clock sync ok")

    # --- voice ---------------------------------------------------------------------------------------
    ice = ok(b.get("/api/voice/ice-servers"))["ice_servers"]
    assert any("stun:" in str(s["urls"]) for s in ice)
    gw_b.send(4, {"channel_id": lounge["id"], "self_mute": False, "self_deaf": False})
    vs = gw_a.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_b["id"] and d["channel_id"] == lounge["id"])
    assert vs["mute"] is False
    gw_c.send(4, {"channel_id": lounge["id"]})
    gw_b.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] == lounge["id"])
    gw_b.send(5, {"to": me_c["id"], "data": {"description": {"type": "offer", "sdp": "v=0"}}})
    sig = gw_c.wait_for("VOICE_SIGNAL", lambda d: d["from"] == me_b["id"])
    assert sig["data"]["description"]["type"] == "offer"
    gw_a.send(5, {"to": me_c["id"], "data": {"x": 1}})  # A isn't in voice: dropped
    gw_c.none_of("VOICE_SIGNAL", lambda d: d["from"] == me_a["id"])
    gw_b.send(6, {"speaking": True})
    assert gw_a.wait_for("VOICE_SPEAKING", lambda d: d["user_id"] == me_b["id"])["speaking"] is True
    # READY for a fresh connection includes the voice states
    gw_a2 = Gateway(a)
    srv = next(s for s in gw_a2.ready["servers"] if s["id"] == sid)
    assert {v["user_id"] for v in srv["voice_states"]} == {me_b["id"], me_c["id"]}
    gw_a2.close()
    # moderation: server mute, move, disconnect
    ok(a.patch(f"/api/servers/{sid}/members/{me_c['id']}/voice", json={"mute": True}))
    assert gw_b.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["mute"])["mute"]
    ok(a.patch(f"/api/servers/{sid}/members/{me_c['id']}/voice", json={"channel_id": small["id"]}))
    # The moved client must hear VOICE_MOVED before its new seat, or it can't reconnect.
    seat = None
    seen: list = []
    for _ in range(250):
        with gw_c.lock:
            seen = list(gw_c.events)
        seat = next((n for n, (t, d) in enumerate(seen) if t == "VOICE_STATE_UPDATE" and d["user_id"] == me_c["id"] and d["channel_id"] == small["id"]), None)
        if seat is not None:
            break
        time.sleep(0.02)
    moved_at = next(n for n, (t, d) in enumerate(seen) if t == "VOICE_MOVED" and d["channel_id"] == small["id"])
    assert seat is not None and moved_at < seat, (moved_at, seat)
    gw_c.wait_for("VOICE_MOVED", lambda d: d["channel_id"] == small["id"])
    gw_b.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] == small["id"])
    assert b.patch(f"/api/servers/{sid}/members/{me_c['id']}/voice", json={"disconnect": True}).status_code == 403
    # Game Room holds one person: B can't join while C is there
    gw_b.send(4, {"channel_id": small["id"]})
    err = gw_b.wait_for("VOICE_JOIN_ERROR")
    assert "full" in err["message"]
    ok(a.patch(f"/api/servers/{sid}/members/{me_c['id']}/voice", json={"disconnect": True}))
    gw_c.wait_for("VOICE_FORCE_DISCONNECT")
    gw_b.send(4, {"channel_id": None})
    gw_a.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_b["id"] and d["channel_id"] is None)
    # a dropped socket keeps its seat for a few seconds, then leaves
    gw_a.drain()
    gw_c.send(4, {"channel_id": lounge["id"]})
    gw_a.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] == lounge["id"])
    gw_c.close()
    gw_a.none_of("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] is None, wait=2)
    gw_c = Gateway(c)
    gw_c.send(4, {"channel_id": lounge["id"]})  # resume
    gw_a.wait_for("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] == lounge["id"])
    gw_a.none_of("VOICE_STATE_UPDATE", lambda d: d["user_id"] == me_c["id"] and d["channel_id"] is None, wait=1)
    # deleting the voice space kicks everyone out
    ok(a.delete(f"/api/channels/{lounge['id']}"))
    gw_c.wait_for("VOICE_FORCE_DISCONNECT")
    print("voice ok (states, signaling, speaking, READY, mute/move/disconnect, limit, resume)")

    for gw in (gw_a, gw_b, gw_c):
        gw.close()


if __name__ == "__main__":
    main()
