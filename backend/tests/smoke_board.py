"""End-to-end checks for the game board: saved boards and switching,
background pictures, tokens (placing, moving, permissions), drawings and undo,
the tracker, and the "who has it open" presence.

Run from backend/:

    python tests/smoke_board.py
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
import tempfile
import time
from io import BytesIO
from pathlib import Path

import httpx
from PIL import Image

os.environ.setdefault("SMOKE_PORT", "8769")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_v2 import BASE, PORT, Gateway, ok  # noqa: E402


def png_bytes(width: int = 640, height: int = 480, color: tuple[int, int, int] = (40, 90, 40)) -> bytes:
    buf = BytesIO()
    Image.new("RGB", (width, height), color).save(buf, "PNG")
    return buf.getvalue()


def run(log_path: Path, data_dir: Path) -> None:
    a = httpx.Client(base_url=BASE, timeout=30)
    b = httpx.Client(base_url=BASE, timeout=30)
    c = httpx.Client(base_url=BASE, timeout=30)
    d = httpx.Client(base_url=BASE, timeout=30)

    code = re.search(r"setup code: ([0-9A-F]+)", log_path.read_text()).group(1)
    ok(a.post("/api/auth/register", json={"email": "gm@example.com", "username": "gm", "password": "hunter22!", "invite": code}))
    server = ok(a.post("/api/servers", data={"name": "Map Room"}))
    sid = server["id"]
    general = next(ch for ch in server["channels"] if ch["type"] == 0)
    invite = ok(a.post(f"/api/channels/{general['id']}/invites", json={"max_age": 86400, "max_uses": 0}))
    me_b = ok(b.post("/api/auth/register", json={"email": "b@example.com", "username": "isaiah", "password": "password1", "invite": invite["code"]}))["user"]
    me_c = ok(c.post("/api/auth/register", json={"email": "c@example.com", "username": "colby", "password": "password1", "invite": invite["code"]}))["user"]
    me_d = ok(d.post("/api/auth/register", json={"email": "d@example.com", "username": "outsider", "password": "password1", "invite": invite["code"]}))["user"]
    ok(a.delete(f"/api/servers/{sid}/members/{me_d['id']}"))  # D joins via the invite, then gets shown the door
    gw_a, gw_b, gw_c = Gateway(a), Gateway(b), Gateway(c)

    # --- the board starts empty; only whoever runs the server can make one ----
    st = ok(b.get(f"/api/servers/{sid}/board"))
    assert st == {"server_id": sid, "boards": [], "active_id": None, "board": None, "viewers": []}, st
    assert httpx.get(f"{BASE}/api/servers/{sid}/board").status_code == 401  # needs a login
    assert d.get(f"/api/servers/{sid}/board").status_code == 404  # not a member
    assert b.post(f"/api/servers/{sid}/board/boards", json={"name": "Nope"}).status_code == 403
    created = ok(a.post(f"/api/servers/{sid}/board/boards", json={"name": "  Goblin Ambush  "}))
    bid = created["id"]
    st = gw_b.wait_for("BOARD_STATE", lambda s: s["active_id"] == bid)
    assert st["board"]["name"] == "Goblin Ambush" and st["board"]["grid_size"] == 70 and st["board"]["snap"] is True
    assert st["board"]["tokens"] == [] and st["board"]["drawings"] == [] and st["board"]["tracker"] == []
    assert [x["name"] for x in st["boards"]] == ["Goblin Ambush"]
    print("boards ok (empty state, permissions, first board is active)")

    # --- background picture: uploaded by the controller, served to members only ----
    up = ok(a.post(f"/api/servers/{sid}/board/boards/{bid}/background", files={"file": ("map.png", png_bytes(), "image/png")}))
    assert up["background_url"].startswith(f"/cdn/boards/{bid}/") and up["bg_width"] == 640 and up["bg_height"] == 480
    st = gw_c.wait_for("BOARD_STATE", lambda s: (s["board"] or {}).get("background_url"))
    assert st["board"]["bg_width"] == 640
    img = b.get(up["background_url"])
    assert img.status_code == 200 and img.headers["content-type"].startswith("image/png")
    assert httpx.get(BASE + up["background_url"]).status_code == 401
    assert d.get(up["background_url"]).status_code == 404
    assert b.post(f"/api/servers/{sid}/board/boards/{bid}/background", files={"file": ("map.png", png_bytes(), "image/png")}).status_code == 403
    assert a.post(f"/api/servers/{sid}/board/boards/{bid}/background", files={"file": ("x.png", b"not an image", "image/png")}).status_code == 400
    print("background ok (upload, broadcast, member-only serving)")

    # --- tokens: players place their own character's, the controller anything ----
    isa = ok(b.post("/api/users/@me/characters", data={"name": "Isaiah Vale"}))
    ok(b.patch(f"/api/characters/{isa['id']}/sheet", json={"patch": {"hp": {"current": 18, "max": 24}}}))
    tok_b = ok(b.post(f"/api/servers/{sid}/board/boards/{bid}/tokens", json={"character_id": isa["id"], "x": 100, "y": 200, "disposition": "ally"}))
    assert tok_b["name"] == "Isaiah Vale" and tok_b["hp"] == {"current": 18, "max": 24} and tok_b["disposition"] == "ally"
    ev = gw_a.wait_for("BOARD_TOKEN_CREATE", lambda t: t["id"] == tok_b["id"])
    assert ev["character_id"] == isa["id"]
    assert c.post(f"/api/servers/{sid}/board/boards/{bid}/tokens", json={"character_id": isa["id"]}).status_code == 403
    assert c.post(f"/api/servers/{sid}/board/boards/{bid}/tokens", json={"name": "Wolf"}).status_code == 403
    assert b.post(f"/api/servers/{sid}/board/boards/{bid}/tokens", json={"character_id": isa["id"]}).status_code == 400  # already on the board
    wolf = ok(a.post(f"/api/servers/{sid}/board/boards/{bid}/tokens", json={"name": "Wolf", "x": 400, "y": 300, "disposition": "enemy"}))
    assert wolf["hp"] is None and wolf["character_id"] is None
    av = ok(a.post(f"/api/servers/{sid}/board/boards/{bid}/tokens/{wolf['id']}/avatar", files={"file": ("wolf.png", png_bytes(256, 256), "image/png")}))
    assert av["avatar"].endswith(".webp")
    gw_b.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == wolf["id"] and t["avatar"])
    ok(a.patch(f"/api/servers/{sid}/board/boards/{bid}/tokens/{wolf['id']}", json={"hp": 5, "hp_max": 11}))
    ev = gw_b.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == wolf["id"] and t["hp"])
    assert ev["hp"] == {"current": 5, "max": 11}
    assert b.post(f"/api/servers/{sid}/board/boards/{bid}/tokens/{wolf['id']}/avatar", files={"file": ("x.png", png_bytes(), "image/png")}).status_code == 403
    assert a.post(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}/avatar", files={"file": ("x.png", png_bytes(), "image/png")}).status_code == 400  # wears its character's picture
    print("tokens ok (place, own-character rule, pictures, hit points)")

    # --- character edits reach the board: rename + hit points re-send the token ----
    ok(b.patch(f"/api/users/@me/characters/{isa['id']}", data={"name": "Isaiah the Grey"}))
    ev = gw_a.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == tok_b["id"] and t["name"] == "Isaiah the Grey")
    assert ev["hp"] == {"current": 18, "max": 24}
    ok(b.patch(f"/api/characters/{isa['id']}/sheet", json={"patch": {"hp": {"current": 3, "max": 24}}}))
    ev = gw_a.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == tok_b["id"] and t["hp"] and t["hp"]["current"] == 3)
    assert ev["name"] == "Isaiah the Grey"
    print("character edits ok (rename and hit points reach the board)")

    # --- moving: the owner drags their token, the DM anything, nobody else ----
    ok(b.patch(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}", json={"x": 130.5, "y": 210}))
    ev = gw_a.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == tok_b["id"] and t["x"] == 130.5)
    assert ev["y"] == 210
    assert c.patch(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}", json={"x": 0}).status_code == 403
    ok(a.patch(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}", json={"x": 500, "y": 500, "disposition": "enemy"}))
    ev = gw_c.wait_for("BOARD_TOKEN_UPDATE", lambda t: t["id"] == tok_b["id"] and t["x"] == 500)
    assert ev["disposition"] == "enemy"
    assert b.patch(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}", json={"disposition": "bogus"}).status_code == 400
    print("moving ok (own token, DM override, bad values refused)")

    # --- drawings: anyone may draw; undo takes back your own (or anyone's, as DM) ----
    pen = ok(c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "pen", "color": "#ff0000", "width": 4, "data": {"points": [[0, 0], [10, 10], [20, 5]]}}))
    assert pen["kind"] == "pen" and len(pen["data"]["points"]) == 3 and pen["color"] == "#ff0000"
    gw_a.wait_for("BOARD_DRAW_ADD", lambda x: x["id"] == pen["id"])
    arrow = ok(a.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "arrow", "data": {"from": [1, 2], "to": [3, 4]}}))
    label = ok(c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "text", "data": {"at": [5, 6], "text": "flank here"}}))
    assert label["data"]["text"] == "flank here" and label["data"]["size"] == 24
    assert c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "pen", "data": {"points": [[0, 0]]}}).status_code == 400
    assert c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "text", "data": {"at": [0, 0], "text": "   "}}).status_code == 400
    assert c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "laser", "data": {}}).status_code == 400
    bad = ok(c.post(f"/api/servers/{sid}/board/boards/{bid}/drawings", json={"kind": "pen", "color": "red", "data": {"points": [[0, 0], [1, 1]]}}))
    assert bad["color"] == "#e5484d"
    ok(c.delete(f"/api/servers/{sid}/board/boards/{bid}/drawings/{bad['id']}"))
    gw_a.wait_for("BOARD_DRAW_DELETE", lambda x: x["drawing_id"] == bad["id"])
    assert c.delete(f"/api/servers/{sid}/board/boards/{bid}/drawings/{arrow['id']}").status_code == 403
    ok(a.delete(f"/api/servers/{sid}/board/boards/{bid}/drawings/{pen['id']}"))  # the DM undoes C's stroke
    assert b.delete(f"/api/servers/{sid}/board/boards/{bid}/drawings").status_code == 403
    ok(a.delete(f"/api/servers/{sid}/board/boards/{bid}/drawings"))
    gw_b.wait_for("BOARD_DRAWS_CLEAR", lambda x: x["board_id"] == bid)
    print("drawings ok (pen/arrow/text, undo, clear)")

    # --- grid, snapping and the tracker ----
    tracker = [{"id": "t1", "name": "Benji", "initiative": 22, "current": True}, {"name": "Goblin Scout", "initiative": 14}]
    ok(a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"grid_size": 100, "snap": False, "tracker": tracker}))
    st = gw_b.wait_for("BOARD_STATE", lambda s: s["board"] and s["board"]["grid_size"] == 100)
    assert st["board"]["snap"] is False and st["board"]["tracker"][0]["initiative"] == 22 and st["board"]["tracker"][0]["current"] is True
    assert len(st["board"]["tracker"][1]["id"]) >= 4  # entries without an id get one
    assert b.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"grid_size": 50}).status_code == 403
    assert a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"grid_size": 5}).status_code == 400

    # --- the board's designated channel: a text channel of this server only ----
    voice = ok(a.post(f"/api/servers/{sid}/channels", json={"name": "War Room", "type": 2}))
    assert a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"channel_id": voice["id"]}).status_code == 400
    assert a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"channel_id": 99999}).status_code == 400
    ok(a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"channel_id": general["id"]}))
    st = gw_b.wait_for("BOARD_STATE", lambda s: s["board"] and s["board"]["channel_id"] == general["id"])
    ok(a.patch(f"/api/servers/{sid}/board/boards/{bid}", json={"channel_id": None}))
    st = gw_b.wait_for("BOARD_STATE", lambda s: s["board"] and s["board"]["channel_id"] is None)
    print("board channel ok (text only, clears)")

    # --- several boards: new ones wait to be picked; deleting the active one falls back ----
    second = ok(a.post(f"/api/servers/{sid}/board/boards", json={"name": "Forest Road"}))
    st = gw_b.wait_for("BOARD_STATE", lambda s: len(s["boards"]) == 2)
    assert st["active_id"] == bid
    ok(a.post(f"/api/servers/{sid}/board/boards/{second['id']}/activate"))
    st = gw_c.wait_for("BOARD_STATE", lambda s: s["active_id"] == second["id"])
    assert st["board"]["name"] == "Forest Road" and st["board"]["tokens"] == []
    ok(a.delete(f"/api/servers/{sid}/board/boards/{second['id']}"))
    st = gw_c.wait_for("BOARD_STATE", lambda s: s["active_id"] == bid)
    assert len(st["boards"]) == 1
    print("switching ok (activate, delete falls back)")

    # --- who has the board open ----
    gw_c.send(12, {"server_id": sid, "viewing": True})
    viewers = gw_a.wait_for("BOARD_VIEWERS", lambda v: me_c["id"] in v["user_ids"])
    assert viewers["server_id"] == sid
    gw_c.send(12, {"server_id": sid, "viewing": False})
    gw_a.wait_for("BOARD_VIEWERS", lambda v: me_c["id"] not in v["user_ids"])

    # --- live cursors: relayed to other viewers, dropped for outsiders, snapshot on join ----
    me_a = gw_a.ready["user"]["id"]  # a plain id (the others hold the user dict)
    gw_a.send(12, {"server_id": sid, "viewing": True})
    gw_a.wait_for("BOARD_VIEWERS", lambda v: me_a in v["user_ids"])
    gw_c.send(12, {"server_id": sid, "viewing": True})
    gw_a.wait_for("BOARD_VIEWERS", lambda v: me_c["id"] in v["user_ids"])
    gw_c.send(13, {"server_id": sid, "x": 120.5, "y": 340.5, "tool": "pen"})
    cur = gw_a.wait_for("BOARD_CURSOR", lambda v: v["user_id"] == me_c["id"])
    assert cur["x"] == 120.5 and cur["y"] == 340.5 and cur["tool"] == "pen" and cur["server_id"] == sid
    gw_b.send(13, {"server_id": sid, "x": 7.0, "y": 7.0, "tool": "rect"})  # b isn't viewing: dropped
    gw_c.send(13, {"server_id": sid, "x": 200.5, "y": 100.5, "tool": "select"})
    gw_a.wait_for("BOARD_CURSOR", lambda v: v["x"] == 200.5)
    time.sleep(0.3)
    assert not any(t == "BOARD_CURSOR" and d.get("x") == 7.0 for t, d in gw_a.events), "cursor from a non-viewer leaked"
    gw_a.send(13, {"server_id": sid, "x": 55.5, "y": 66.5, "tool": "text"})
    gw_c.wait_for("BOARD_CURSOR", lambda v: v["user_id"] == me_a and v["tool"] == "text")
    # A viewer leaving drops their pointer: the next joiner's snapshot only has the rest.
    gw_c.send(12, {"server_id": sid, "viewing": False})
    gw_a.wait_for("BOARD_VIEWERS", lambda v: me_c["id"] not in v["user_ids"])
    gw_b.send(12, {"server_id": sid, "viewing": True})
    snap = gw_b.wait_for("BOARD_CURSORS", lambda v: any(c["user_id"] == me_a for c in v["cursors"]))
    assert snap["server_id"] == sid and all(c["user_id"] != me_c["id"] for c in snap["cursors"])
    # Sharing off: the others are told to drop the pointer and a fresh joiner's
    # snapshot leaves it out; sharing on again publishes a spot right away.
    gw_a.send(13, {"server_id": sid, "hidden": True})
    hid = gw_b.wait_for("BOARD_CURSOR", lambda v: v["user_id"] == me_a and v.get("hidden") is True)
    assert hid["server_id"] == sid
    gw_c.send(12, {"server_id": sid, "viewing": True})
    gw_c.wait_for("BOARD_VIEWERS", lambda v: me_c["id"] in v["user_ids"])
    time.sleep(0.3)
    assert not any(t == "BOARD_CURSORS" and any(c["user_id"] == me_a for c in d["cursors"]) for t, d in gw_c.events), "hidden cursor leaked into a snapshot"
    gw_a.send(13, {"server_id": sid, "x": 88.5, "y": 99.5, "tool": "pen"})
    back = gw_b.wait_for("BOARD_CURSOR", lambda v: v["user_id"] == me_a and v.get("x") == 88.5)
    assert back.get("hidden") is not True and back["tool"] == "pen"
    print("cursor hide ok (removal relayed, snapshot clean, resume publishes)")
    gw_c.send(12, {"server_id": sid, "viewing": False})
    gw_a.send(12, {"server_id": sid, "viewing": False})
    gw_b.send(12, {"server_id": sid, "viewing": False})
    gw_a.wait_for("BOARD_VIEWERS", lambda v: not v["user_ids"])
    print("cursors ok (relay, viewer-only, snapshot, cleanup)")

    # --- a fresh connection's READY carries the whole board ----
    gw_b2 = Gateway(b)
    srv = next(s for s in gw_b2.ready["servers"] if s["id"] == sid)
    assert srv["board"]["active_id"] == bid
    assert {t["name"] for t in srv["board"]["board"]["tokens"]} == {"Isaiah the Grey", "Wolf"}
    gw_b2.close()
    print("viewers + READY ok")

    # --- DM Lock: DMs always, DJs only while it's off (like the jukebox) ----
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": True}))
    r = b.post(f"/api/servers/{sid}/board/boards", json={"name": "Locked"})
    assert r.status_code == 403 and "DM Lock" in r.json()["detail"]
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": False}))
    dj = next(r for r in server["roles"] if r["name"] == "DJ")
    ok(a.put(f"/api/servers/{sid}/members/{me_b['id']}/roles/{dj['id']}"))
    ok(b.post(f"/api/servers/{sid}/board/boards", json={"name": "DJ board"}))
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": True}))
    assert b.post(f"/api/servers/{sid}/board/boards", json={"name": "Nope"}).status_code == 403
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": False}))
    st = ok(a.get(f"/api/servers/{sid}/board"))
    dj_board = next(x for x in st["boards"] if x["name"] == "DJ board")
    ok(a.delete(f"/api/servers/{sid}/board/boards/{dj_board['id']}"))

    # --- removing tokens ----
    ok(b.delete(f"/api/servers/{sid}/board/boards/{bid}/tokens/{tok_b['id']}"))
    gw_a.wait_for("BOARD_TOKEN_DELETE", lambda t: t["token_id"] == tok_b["id"])
    assert c.delete(f"/api/servers/{sid}/board/boards/{bid}/tokens/{wolf['id']}").status_code == 403
    ok(a.delete(f"/api/servers/{sid}/board/boards/{bid}/tokens/{wolf['id']}"))

    for gw in (gw_a, gw_b, gw_c):
        gw.close()
    print("board ok (lock, removal)")


def main() -> None:
    data_dir = Path(tempfile.mkdtemp(prefix="tavern-board-"))
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
        for _ in range(150):
            try:
                if httpx.get(f"{BASE}/api/health").status_code == 200:
                    break
            except httpx.HTTPError:
                time.sleep(0.1)
        else:
            raise SystemExit("server didn't start:\n" + log_path.read_text())
        run(log_path, data_dir)
        print("\nALL BOARD SMOKE TESTS PASSED")
    finally:
        proc.terminate()
        proc.wait(5)
        errors = [line for line in log_path.read_text().splitlines() if "Traceback" in line or "ERROR" in line]
        if errors:
            print("\nServer log had errors:\n" + log_path.read_text())
            sys.exit(1)


if __name__ == "__main__":
    main()
