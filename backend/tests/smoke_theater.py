"""End-to-end checks for the theater: YouTube links (with YouTube faked),
playlists, search, the queue and controls, seats, what players report,
uploads (remux and convert), serving with byte ranges, and DM Lock.

Run from backend/ (needs ffmpeg):

    python tests/smoke_theater.py
"""

from __future__ import annotations

import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

import httpx

os.environ.setdefault("SMOKE_PORT", "8768")
sys.path.insert(0, str(Path(__file__).resolve().parent))
from smoke_v2 import BASE, PORT, Gateway, ok  # noqa: E402

P_DJ = 1 << 23


def make_video(path: Path, seconds: float, vcodec: list[str], acodec: list[str], size: str = "320x240") -> None:
    subprocess.run(
        [
            "ffmpeg",
            "-y",
            "-v",
            "error",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=size={size}:rate=24:duration={seconds}",
            "-f",
            "lavfi",
            "-i",
            f"sine=frequency=440:duration={seconds}",
            *vcodec,
            *acodec,
            "-shortest",
            str(path),
        ],
        check=True,
    )


def wait_video(gw: Gateway, vid: int, status: str, timeout: float = 60) -> dict:
    return gw.wait_for("THEATER_VIDEO_UPDATE", lambda d: d["id"] == vid and d["status"] == status, timeout=timeout)


def run(log_path: Path, data_dir: Path) -> None:
    a = httpx.Client(base_url=BASE, timeout=60)
    b = httpx.Client(base_url=BASE, timeout=60)
    code = re.search(r"setup code: ([0-9A-F]+)", log_path.read_text()).group(1)
    ok(a.post("/api/auth/register", json={"email": "gm@example.com", "username": "gm", "password": "hunter22!", "invite": code}))
    server = ok(a.post("/api/servers", data={"name": "Movie Night"}))
    sid = server["id"]
    assert server["theater"]["queue"] == [] and server["theater"]["current"] is None and server["theater"]["videos"] == {}
    general = next(ch for ch in server["channels"] if ch["type"] == 0)
    invite = ok(a.post(f"/api/channels/{general['id']}/invites", json={"max_age": 86400, "max_uses": 0}))
    me_b = ok(b.post("/api/auth/register", json={"email": "b@example.com", "username": "bea", "password": "password1", "invite": invite["code"]}))["user"]
    gw_a, gw_b = Gateway(a), Gateway(b)
    assert any(s["id"] == sid and "theater" in s for s in gw_b.ready["servers"])
    print("setup ok (theater in server payloads)")

    # --- search, then add from the results: ready at once, and it starts ----------------------
    res = ok(a.get(f"/api/servers/{sid}/theater/search", params={"q": "campfire stories"}))["results"]
    assert len(res) == 3 and res[0]["video_id"] is None
    first = res[0]
    added = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": first["url"], "title": first["title"], "channel": first["channel"], "duration_ms": first["duration_ms"], "queue": "end"}))["video"]
    assert added["status"] == "ready" and added["youtube_id"] == first["id"] and added["thumbnail_url"].startswith("https://i.ytimg.com/")
    st = gw_b.wait_for("THEATER_STATE", lambda d: d["current"] is not None)
    assert st["current"]["video_id"] == added["id"] and st["playing"] is True and str(added["id"]) in st["videos"]
    # Searching again marks it as in the library.
    res = ok(a.get(f"/api/servers/{sid}/theater/search", params={"q": "campfire stories"}))["results"]
    assert res[0]["video_id"] == added["id"]
    # Adding the same video again doesn't make a copy.
    again = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": first["url"]}))
    assert again.get("existing") is True and again["video"]["id"] == added["id"]
    print("search + add from results ok")

    # --- a pasted link: looked up first, then queued ------------------------------------------------
    gw_a.drain()
    link = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://youtu.be/abcdefghijk?t=30", "queue": "end"}))["video"]
    assert link["status"] == "processing"
    done = wait_video(gw_a, link["id"], "ready")
    assert done["title"] == "Video abcdefghijk" and done["duration_ms"] == 95_000 and done["channel"] == "Some Channel"
    st = gw_a.wait_for("THEATER_STATE", lambda d: any(e["video_id"] == link["id"] for e in d["queue"]))
    # Not allowed outside YouTube: fails with the reason.
    bad = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=NOEMBED1234"}))["video"]
    failed = wait_video(gw_a, bad["id"], "failed")
    assert "outside YouTube" in failed["error"]
    # Only YouTube links (other videos are uploads).
    assert a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://vimeo.com/123"}).status_code == 400
    print("links ok (lookup, queue after lookup, not embeddable, non-YouTube refused)")

    # --- a playlist: one row per video, queued in order ---------------------------------------------
    gw_a.drain()
    pl = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/playlist?list=PLabcdefghij12345", "queue": "end"}))
    assert pl.get("playlist") is True
    st = gw_a.wait_for("THEATER_STATE", lambda d: sum(1 for e in d["queue"] if d["videos"].get(str(e["video_id"]), {}).get("title", "").startswith("Episode")) == 3, timeout=15)
    titles = [st["videos"][str(e["video_id"])]["title"] for e in st["queue"] if st["videos"][str(e["video_id"])]["title"].startswith("Episode")]
    assert titles == ["Episode 1", "Episode 2", "Episode 3"], titles
    lib = ok(a.get(f"/api/servers/{sid}/theater/videos"))
    assert lib["search_enabled"] is True and lib["max_video_mb"] > 0
    assert sum(1 for v in lib["videos"] if v["title"].startswith("Episode")) == 3
    print("playlist ok (three rows, queued in order)")

    # --- controls, and who may use them ---------------------------------------------------------------
    assert b.post(f"/api/servers/{sid}/theater/control", json={"action": "pause"}).status_code == 403

    def act(action: str, value=None, pred=lambda d: True) -> dict:
        gw_b.drain()
        ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": action, "value": value}))
        return gw_b.wait_for("THEATER_STATE", pred)

    act("pause", pred=lambda d: d["playing"] is False)
    act("seek", 30_000, lambda d: d["position"] == 30_000)
    st = act("play", pred=lambda d: d["playing"] is True and d["started_at"])
    assert abs((st["server_now"] - st["started_at"]) - 30_000) < 2000, st
    act("skip", pred=lambda d: d["current"] and d["current"]["video_id"] == link["id"])
    act("previous", pred=lambda d: d["current"] and d["current"]["video_id"] == added["id"])
    assert a.post(f"/api/servers/{sid}/theater/control", json={"action": "fade"}).status_code == 400
    # A DJ may run it, until DM Lock is on.
    dj_role = next(r for r in server["roles"] if r["name"] == "DJ")
    ok(a.put(f"/api/servers/{sid}/members/{me_b['id']}/roles/{dj_role['id']}"))
    ok(b.post(f"/api/servers/{sid}/theater/control", json={"action": "pause"}))
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": True}))
    r = b.post(f"/api/servers/{sid}/theater/control", json={"action": "play"})
    assert r.status_code == 403 and "DM Lock" in r.text, r.text
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "play"}))
    ok(a.put(f"/api/servers/{sid}/roleplay", json={"enabled": False}))
    print("controls ok (pause, seek, play, skip, previous; DJ; DM Lock)")

    # --- seats ---------------------------------------------------------------------------------------------
    gw_a.drain()
    gw_b.send(10, {"server_id": sid, "seated": True})
    seats = gw_a.wait_for("THEATER_SEATS", lambda d: d["server_id"] == sid and me_b["id"] in d["user_ids"])
    assert ok(a.get(f"/api/servers/{sid}/theater"))["listeners"] == [me_b["id"]]
    gw_b.send(10, {"server_id": sid, "seated": False})
    gw_a.wait_for("THEATER_SEATS", lambda d: d["server_id"] == sid and d["user_ids"] == [])
    gw_b.send(10, {"server_id": sid, "seated": True})
    gw_a.wait_for("THEATER_SEATS", lambda d: me_b["id"] in d["user_ids"])
    gw_b.close()
    gw_a.wait_for("THEATER_SEATS", lambda d: d["user_ids"] == [], timeout=8)
    gw_b = Gateway(b)
    assert seats["user_ids"] == [me_b["id"]]
    print("seats ok (sit, stand, leaving drops the seat)")

    # --- what players report: a length, or that it can't play -------------------------------------------
    gw_a.drain()
    gw_b.send(10, {"server_id": sid, "seated": True})
    gw_a.wait_for("THEATER_SEATS", lambda d: me_b["id"] in d["user_ids"])
    nolen = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=NOLEN123456"}))["video"]
    nolen = wait_video(gw_a, nolen["id"], "ready")
    assert nolen["duration_ms"] == 0
    # Only what's on screen, from someone in a seat, counts.
    assert b.post(f"/api/servers/{sid}/theater/videos/{nolen['id']}/report", json={"duration_ms": 1500}).json()["ok"] is False
    ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": [nolen["id"]], "where": "now"}))
    gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] == nolen["id"])
    assert a.post(f"/api/servers/{sid}/theater/videos/{nolen['id']}/report", json={"duration_ms": 1500}).json()["ok"] is False
    assert ok(b.post(f"/api/servers/{sid}/theater/videos/{nolen['id']}/report", json={"duration_ms": 1500}))["ok"] is True
    gw_a.wait_for("THEATER_VIDEO_UPDATE", lambda d: d["id"] == nolen["id"] and d["duration_ms"] == 1500)
    # Now that the server knows it's 1.5 s long, it moves on by itself.
    st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] != nolen["id"], timeout=6)
    # A second report doesn't change a known length.
    b.post(f"/api/servers/{sid}/theater/videos/{nolen['id']}/report", json={"duration_ms": 99_000})
    assert next(v for v in ok(a.get(f"/api/servers/{sid}/theater/videos"))["videos"] if v["id"] == nolen["id"])["duration_ms"] == 1500
    # "Can't play here" from one viewer is checked on the server first: this one is fine, so it stays.
    playing = st["current"]["video_id"]
    ok(b.post(f"/api/servers/{sid}/theater/videos/{playing}/report", json={"error_code": 150}))
    time.sleep(0.8)
    assert next(v for v in ok(a.get(f"/api/servers/{sid}/theater/videos"))["videos"] if v["id"] == playing)["status"] == "ready"
    assert ok(a.get(f"/api/servers/{sid}/theater"))["current"]["video_id"] == playing
    # This one really is blocked now (the check agrees), so it's dropped for everyone.
    later = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=LATER123456"}))["video"]
    later = wait_video(gw_a, later["id"], "ready")
    ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": [later["id"]], "where": "now"}))
    gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] == later["id"])
    ok(b.post(f"/api/servers/{sid}/theater/videos/{later['id']}/report", json={"error_code": 150}))
    gone = gw_a.wait_for("THEATER_VIDEO_UPDATE", lambda d: d["id"] == later["id"] and d["status"] == "failed")
    assert "outside YouTube" in gone["error"]
    st = gw_a.wait_for("THEATER_STATE", lambda d: not d["current"] or d["current"]["video_id"] != later["id"])
    print("reports ok (seated + on screen only, length arms the timer, can't-play checked then dropped)")

    # --- shuffle never overrides "play now", "play next" or a picked queue entry ---------------------------
    ok(a.delete(f"/api/servers/{sid}/theater/queue"))
    ids = [v["id"] for v in ok(a.get(f"/api/servers/{sid}/theater/videos"))["videos"] if v["status"] == "ready" and not v["live"] and v["duration_ms"] > 5000][:4]
    assert len(ids) == 4, ids
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "shuffle", "value": True}))
    ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": ids[:3], "where": "end"}))
    for _ in range(3):
        gw_a.drain()
        ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": [ids[3]], "where": "now"}))
        st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] == ids[3], timeout=3)
    gw_a.drain()
    ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": [ids[1]], "where": "next"}))
    gw_a.wait_for("THEATER_STATE", lambda d: any(e.get("next") for e in d["queue"]))
    gw_a.drain()
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "skip"}))
    st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] != ids[3])
    assert st["current"]["video_id"] == ids[1], (st["current"], ids)
    target = st["queue"][-1]
    gw_a.drain()
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "jump", "value": target["qid"]}))
    st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["qid"] == target["qid"])
    assert all(e["qid"] != target["qid"] for e in st["queue"])
    assert a.post(f"/api/servers/{sid}/theater/control", json={"action": "jump", "value": "nope"}).status_code == 409
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "shuffle", "value": False}))
    print("shuffle ok (play now, play next and jump pick exactly)")

    # --- going back with repeat-all doesn't leave a duplicate --------------------------------------------
    ok(a.delete(f"/api/servers/{sid}/theater/queue"))
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "repeat", "value": "all"}))
    ok(a.post(f"/api/servers/{sid}/theater/queue", json={"video_ids": [ids[0]], "where": "end"}))
    gw_a.drain()
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "skip"}))
    st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] == ids[0])
    was = st["history"][-1]
    assert any(e.get("repeat_of") == was["qid"] for e in st["queue"])
    gw_a.drain()
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "previous"}))
    st = gw_a.wait_for("THEATER_STATE", lambda d: d["current"] and d["current"]["video_id"] == was["video_id"])
    assert sum(1 for e in st["queue"] if e["video_id"] == was["video_id"]) == 0, st["queue"]
    assert st["queue"][0]["video_id"] == ids[0]
    ok(a.post(f"/api/servers/{sid}/theater/control", json={"action": "repeat", "value": "off"}))
    print("previous + repeat-all ok (no duplicate)")

    # --- a deleted "queue when ready" doesn't hold up the next one --------------------------------------
    ok(a.delete(f"/api/servers/{sid}/theater/queue"))
    slow = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=SLOW1234567", "queue": "end"}))["video"]
    assert slow["status"] == "processing"
    ok(a.delete(f"/api/servers/{sid}/theater/videos/{slow['id']}"))
    gw_a.drain()
    nxt = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=afterslow01", "queue": "end"}))["video"]
    gw_a.wait_for("THEATER_STATE", lambda d: any(e["video_id"] == nxt["id"] for e in d["queue"]) or (d["current"] and d["current"]["video_id"] == nxt["id"]), timeout=8)
    print("queue-when-ready ok (a deleted one doesn't block the rest)")

    # --- live streams have no end ---------------------------------------------------------------------
    live = ok(a.post(f"/api/servers/{sid}/theater/add", json={"url": "https://www.youtube.com/watch?v=LIVE1234567"}))["video"]
    live = wait_video(gw_a, live["id"], "ready")
    assert live["live"] is True and live["duration_ms"] == 0
    ok(b.post(f"/api/servers/{sid}/theater/videos/{live['id']}/report", json={"duration_ms": 5000}))
    assert next(v for v in ok(a.get(f"/api/servers/{sid}/theater/videos"))["videos"] if v["id"] == live["id"])["duration_ms"] == 0
    print("live ok")

    # --- uploads ---------------------------------------------------------------------------------------
    tmp = Path(tempfile.mkdtemp())
    mp4 = tmp / "Dragon Flight.mp4"
    make_video(mp4, 3, ["-c:v", "libx264", "-pix_fmt", "yuv420p"], ["-c:a", "aac"])
    avi = tmp / "old_clip.avi"
    make_video(avi, 3, ["-c:v", "mpeg4"], ["-c:a", "mp3"] if shutil.which("ffmpeg") else [], size="640x360")
    gw_a.drain()
    with open(mp4, "rb") as f1, open(avi, "rb") as f2:
        up = ok(a.post(f"/api/servers/{sid}/theater/videos", files=[("files", (mp4.name, f1, "video/mp4")), ("files", (avi.name, f2, "video/x-msvideo"))]))["videos"]
    assert [v["title"] for v in up] == ["Dragon Flight", "old clip"] and all(v["status"] == "processing" for v in up)
    v1 = wait_video(gw_a, up[0]["id"], "ready")
    v2 = wait_video(gw_a, up[1]["id"], "ready", timeout=120)
    assert v1["kind"] == "file" and v1["url"].endswith(".mp4") and v1["mime"] == "video/mp4" and (v1["width"], v1["height"]) == (320, 240)
    assert 2500 <= v1["duration_ms"] <= 3500, v1["duration_ms"]
    assert v1["thumbnail_url"].startswith("/cdn/posters/")
    assert v2["url"].endswith(".mp4") and (v2["width"], v2["height"]) == (640, 360)
    # Served with byte ranges (so players can seek), members only.
    r = a.get(v1["url"], headers={"Range": "bytes=0-99"})
    assert r.status_code == 206 and len(r.content) == 100 and r.headers["content-type"] == "video/mp4", (r.status_code, r.headers)
    assert b.get(v1["url"]).status_code == 200
    assert httpx.get(BASE + v1["url"]).status_code in (401, 403)
    assert httpx.get(BASE + v1["thumbnail_url"]).status_code == 200
    # Not a video
    txt = tmp / "notes.txt"
    txt.write_text("hello")
    with open(txt, "rb") as f:
        assert a.post(f"/api/servers/{sid}/theater/videos", files=[("files", (txt.name, f, "text/plain"))]).status_code == 400
    print("uploads ok (remux, convert, poster, ranges, members only)")

    # --- edit, delete, and deleting the server cleans up files ---------------------------------------------
    ok(a.patch(f"/api/servers/{sid}/theater/videos/{v1['id']}", json={"title": "Dragon Flight (cut)", "tags": ["Intro", "intro", "Cutscene"]}))
    upd = gw_a.wait_for("THEATER_VIDEO_UPDATE", lambda d: d["id"] == v1["id"] and d["title"] == "Dragon Flight (cut)")
    assert upd["tags"] == ["Intro", "Cutscene"]
    videos_dir = data_dir / "uploads" / "videos"
    posters_dir = data_dir / "uploads" / "posters"
    assert (videos_dir / v2["url"].rsplit("/", 1)[1]).exists()
    ok(a.delete(f"/api/servers/{sid}/theater/videos/{v2['id']}"))
    gw_a.wait_for("THEATER_VIDEO_DELETE", lambda d: d["video_id"] == v2["id"])
    assert not (videos_dir / v2["url"].rsplit("/", 1)[1]).exists()
    ok(a.delete(f"/api/servers/{sid}"))
    time.sleep(0.3)
    assert not (videos_dir / v1["url"].rsplit("/", 1)[1]).exists()
    assert not list(posters_dir.glob("*.jpg"))
    print("edit + delete ok (files cleaned up with the server)")


def main() -> None:
    if not shutil.which("ffmpeg"):
        raise SystemExit("ffmpeg is needed for this test")
    data_dir = Path(tempfile.mkdtemp(prefix="tavern-theater-"))
    log_path = data_dir / "server.log"
    env = dict(os.environ, TAVERN_DATA_DIR=str(data_dir), PUBLIC_URL=BASE, LINK_EMBEDS="false", TAVERN_STATIC_DIR=str(data_dir / "nostatic"))
    log_file = open(log_path, "w")
    proc = subprocess.Popen(
        [sys.executable, str(Path(__file__).resolve().parent / "theater_fakes.py"), str(PORT)],
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
        print("\nALL THEATER TESTS PASSED")
    finally:
        proc.terminate()
        proc.wait(5)
        errors = [line for line in log_path.read_text().splitlines() if "Traceback" in line or "ERROR" in line]
        if errors:
            print("\nServer log had errors:\n" + log_path.read_text())
            sys.exit(1)


if __name__ == "__main__":
    main()
