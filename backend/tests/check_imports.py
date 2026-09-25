"""Offline checks for jukebox search, "add to queue" and Spotify imports.

YouTube and Spotify are faked (no network needed), but everything between them
runs for real: the database, the ordered queue, the audio processing (needs
ffmpeg). Run from backend/:

    python tests/check_imports.py
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

DATA = Path(tempfile.mkdtemp(prefix="tavern-imports-"))
os.environ.update(
    TAVERN_DATA_DIR=str(DATA),
    PUBLIC_URL="https://tavern.example.com",
    SPOTIFY_CLIENT_ID="test-id",
    SPOTIFY_CLIENT_SECRET="test-secret",
    LINK_EMBEDS="false",
)
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import httpx  # noqa: E402
from sqlalchemy import select  # noqa: E402

from tavern import jukebox as jb  # noqa: E402
from tavern import spotify  # noqa: E402
from tavern.db import SessionLocal, init_db  # noqa: E402
from tavern.files import ensure_dirs  # noqa: E402
from tavern.models import Track, User  # noqa: E402
from tavern.services import create_server  # noqa: E402


def tone(path: Path, seconds: float = 2.0, freq: int = 440) -> None:
    subprocess.run(
        ["ffmpeg", "-y", "-v", "error", "-f", "lavfi", "-i", f"sine=frequency={freq}:duration={seconds}", "-c:a", "aac", str(path)],
        check=True,
    )


def fake_download(track_id: int, url: str, *, meta_override=None, cover_url=None, keep_source=False) -> None:
    """Stands in for yt-dlp: 'downloads' a short tone and processes it for real."""
    downloads.append((track_id, url))
    src = DATA / f"dl-{track_id}.m4a"
    tone(src, 1.5, 300 + track_id * 10)
    if not keep_source:
        with SessionLocal() as db:
            t = db.get(Track, track_id)
            t.source_url = url
            db.commit()
    jb.process_file(track_id, src, meta=meta_override or {"title": f"Video {url[-11:]}"})


def fake_search(query: str, limit: int = 12):
    searches.append(query)
    q = query.lower()
    out = []
    if "river song" in q:
        out = [
            {"id": "aaaaaaaaaa1", "title": "River Song (Live at the Pub)", "channel": "Somebody", "duration_ms": 260000, "url": "https://www.youtube.com/watch?v=aaaaaaaaaa1"},
            {"id": "aaaaaaaaaa2", "title": "River Song", "channel": "The Bards - Topic", "duration_ms": 201000, "url": "https://www.youtube.com/watch?v=aaaaaaaaaa2"},
            {"id": "aaaaaaaaaa3", "title": "river song 1 hour loop", "channel": "Loops", "duration_ms": 3600000, "url": "https://www.youtube.com/watch?v=aaaaaaaaaa3"},
        ]
    elif "mountain" in q:
        out = [{"id": "bbbbbbbbbb1", "title": "The Bards - Mountain Hall (Official Audio)", "channel": "The Bards", "duration_ms": 180500, "url": "https://www.youtube.com/watch?v=bbbbbbbbbb1"}]
    elif "nothing like this" in q:
        out = [{"id": "cccccccccc1", "title": "Cooking with Grandma", "channel": "Food", "duration_ms": 900000, "url": "https://www.youtube.com/watch?v=cccccccccc1"}]
    return out


downloads: list[tuple[int, str]] = []
searches: list[str] = []


def main() -> None:
    if not shutil.which("ffmpeg"):
        sys.exit("needs ffmpeg")
    init_db()
    ensure_dirs()
    jb._download_one = fake_download  # type: ignore[assignment]
    jb.youtube_search = fake_search  # type: ignore[assignment]
    # Run the workers inline so the checks are deterministic.
    jb._workers.submit = lambda fn, *a, **k: fn(*a, **k)  # type: ignore[method-assign]

    with SessionLocal() as db:
        owner = User(email="dj@example.com", username="dj", password_hash="x", settings={})
        db.add(owner)
        db.flush()
        server = create_server(db, owner, "Test")
        db.commit()
        uid, sid = owner.id, server.id

    # --- Spotify link parsing -----------------------------------------------------
    assert spotify.parse_link("https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC?si=abc") == ("track", "4uLU6hMCjMI75M1A2tKUQC")
    assert spotify.parse_link("https://open.spotify.com/intl-de/album/1DFixLWuPkv3KT3TnV35m3") == ("album", "1DFixLWuPkv3KT3TnV35m3")
    assert spotify.parse_link("spotify:playlist:37i9dQZF1DXcBWIGoYBM5M") == ("playlist", "37i9dQZF1DXcBWIGoYBM5M")
    assert spotify.parse_link("https://www.youtube.com/watch?v=x") is None
    print("spotify links ok")

    # --- matching picks the studio audio, not the live/loop versions ---------------
    song = spotify.Song("River Song", ["The Bards"], "Tales", 200000, None, "https://open.spotify.com/track/r1")
    assert spotify.best_match(song, fake_search) == "https://www.youtube.com/watch?v=aaaaaaaaaa2"
    nomatch = spotify.Song("Nothing Like This", ["Nobody"], None, 200000, None, "https://open.spotify.com/track/n1")
    assert spotify.best_match(nomatch, fake_search) is None
    print("youtube matching ok")

    # --- reading Spotify responses (old and 2026 field names) -----------------------
    pages = {
        "/playlists/PL": {"name": "Road Trip", "items": {"items": [{"item": {"type": "track", "id": "t1", "name": "River Song", "duration_ms": 200000, "artists": [{"name": "The Bards"}], "album": {"name": "Tales", "images": [{"url": "https://i.scdn.co/image/a", "width": 640, "height": 640}]}, "external_urls": {"spotify": "https://open.spotify.com/track/t1"}}}], "next": None}},
        "/playlists/OLD": {"name": "Old", "tracks": {"items": [{"track": {"type": "track", "id": "t2", "name": "Mountain Hall", "duration_ms": 181000, "artists": [{"name": "The Bards"}], "album": {"name": "Tales", "images": []}}}], "next": None}},
        "/playlists/HIDDEN": {"name": "Not mine"},
    }
    spotify._get = lambda path, token: pages[path]  # type: ignore[assignment]
    spotify.app_token = lambda: "app"  # type: ignore[assignment]
    assert [s.title for s in spotify.read_link("playlist", "PL", "user").songs] == ["River Song"]
    assert [s.url for s in spotify.read_link("playlist", "OLD").songs] == ["https://open.spotify.com/track/t2"]
    try:
        spotify.read_link("playlist", "HIDDEN")
        raise AssertionError("hidden playlist should fail")
    except spotify.SpotifyError as exc:
        assert "Connect your Spotify" in str(exc)
    print("spotify reading ok")

    # --- a YouTube search result straight into the queue ------------------------------
    with SessionLocal() as db:
        t = Track(server_id=sid, uploader_id=uid, title="Searching", source_url="https://www.youtube.com/watch?v=zzzzzzzzzz1", status="processing")
        db.add(t)
        db.commit()
        first_id = t.id
    jb.queue_requests.add(sid, first_id, uid, "end")
    jb._download_one(first_id, "https://www.youtube.com/watch?v=zzzzzzzzzz1")
    with SessionLocal() as db:
        assert db.get(Track, first_id).status == "ready", db.get(Track, first_id).error
        st = jb.jukebox._load(db, sid)
        playing = st["current"]["track_id"] if st["current"] else None
    assert playing == first_id, st
    print("queue after download ok")

    # --- an album from Spotify: in order, duplicates reused, queued in order ----------
    album = spotify.Collection(
        "album",
        "Tales",
        [
            spotify.Song("River Song", ["The Bards"], "Tales", 200000, None, "https://open.spotify.com/track/t1"),
            spotify.Song("Mountain Hall", ["The Bards"], "Tales", 181000, None, "https://open.spotify.com/track/t2"),
            spotify.Song("Nothing Like This", ["Nobody"], "Tales", 200000, None, "https://open.spotify.com/track/t3"),
        ],
    )
    spotify.read_link = lambda kind, sid_, token=None: album  # type: ignore[assignment]
    # Mountain Hall is already in the library.
    with SessionLocal() as db:
        existing = Track(server_id=sid, uploader_id=uid, title="Mountain Hall", source_url="https://open.spotify.com/track/t2", status="ready", file="x.m4a", duration_ms=181000)
        placeholder = Track(server_id=sid, uploader_id=uid, title="Spotify album", source_url="https://open.spotify.com/album/A", status="processing")
        db.add_all([existing, placeholder])
        db.commit()
        existing_id, ph_id = existing.id, placeholder.id
    downloads.clear()
    jb._spotify_import(ph_id, "album", "A" * 22, sid, uid, ["road"], "end")
    with SessionLocal() as db:
        river = db.get(Track, ph_id)
        assert river.title == "River Song" and river.artist == "The Bards" and river.status == "ready", (river.title, river.status, river.error)
        assert river.source_url == "https://open.spotify.com/track/t1"
        missing = db.scalar(select(Track).where(Track.source_url == "https://open.spotify.com/track/t3"))
        assert missing is not None and missing.status == "failed" and "YouTube" in (missing.error or "")
        st = jb.jukebox._load(db, sid)
        queued = [e["track_id"] for e in st["queue"]]
    assert [u for _, u in downloads] == ["https://www.youtube.com/watch?v=aaaaaaaaaa2"], downloads
    assert queued == [ph_id, existing_id], (queued, ph_id, existing_id)
    print("spotify album ok (order, duplicates, misses)")

    # --- everything already there: no new rows, placeholder removed -------------------
    single = spotify.Collection("track", "Mountain Hall", [album.songs[1]])
    spotify.read_link = lambda kind, sid_, token=None: single  # type: ignore[assignment]
    with SessionLocal() as db:
        ph = Track(server_id=sid, uploader_id=uid, title="Spotify track", source_url="https://open.spotify.com/track/t2x", status="processing")
        db.add(ph)
        db.commit()
        ph2 = ph.id
    jb._spotify_import(ph2, "track", "B" * 22, sid, uid, [], "next")
    with SessionLocal() as db:
        assert db.get(Track, ph2) is None
        st = jb.jukebox._load(db, sid)
        assert st["queue"][0]["track_id"] == existing_id
    print("spotify duplicate ok")

    # --- a Spotify sign-in that can't be renewed any more ----------------------------
    real_post = spotify.httpx.post

    def dead_refresh(url, data=None, headers=None, timeout=None):
        if data and data.get("grant_type") == "refresh_token":
            body = {"error": "invalid_grant", "error_description": "Refresh token revoked"}
        else:
            body = {"error": "invalid_client", "error_description": "Invalid client"}
        return httpx.Response(400, json=body, request=httpx.Request("POST", url))

    spotify.httpx.post = dead_refresh  # type: ignore[assignment]
    try:
        stale = {"access": "old", "refresh": "dead", "expires": 0, "name": "dj"}
        with SessionLocal() as db:
            db.get(User, uid).spotify_auth = stale
            ph_song = Track(server_id=sid, uploader_id=uid, title="Spotify track", source_url="https://open.spotify.com/track/" + "C" * 22, status="processing")
            ph_list = Track(server_id=sid, uploader_id=uid, title="Spotify playlist", source_url="https://open.spotify.com/playlist/" + "D" * 22, status="processing")
            db.add_all([ph_song, ph_list])
            db.commit()
            song_id, list_id = ph_song.id, ph_list.id
        # Songs don't need the sign-in, so they still import.
        new_song = spotify.Collection("track", "River Song", [spotify.Song("River Song", ["The Bards"], "Tales", 200000, None, "https://open.spotify.com/track/t9")])
        spotify.read_link = lambda kind, sid_, token=None: new_song  # type: ignore[assignment]
        jb._spotify_import(song_id, "track", "C" * 22, sid, uid, [], None)
        with SessionLocal() as db:
            assert db.get(Track, song_id).status == "ready", db.get(Track, song_id).error
            assert db.get(User, uid).spotify_auth == stale
        # Playlists do: a clear message, and the dead sign-in is forgotten.
        jb._spotify_import(list_id, "playlist", "D" * 22, sid, uid, [], None)
        with SessionLocal() as db:
            t = db.get(Track, list_id)
            assert t.status == "failed" and "Connect Spotify again" in (t.error or ""), (t.status, t.error)
            assert db.get(User, uid).spotify_auth is None
        # A wrong API key still says so.
        try:
            spotify._token_request({"grant_type": "client_credentials"})
            raise AssertionError("a wrong key should fail")
        except spotify.SpotifyError as exc:
            assert "API key" in str(exc) and not isinstance(exc, spotify.ConnectionExpired), exc
    finally:
        spotify.httpx.post = real_post  # type: ignore[assignment]
    print("expired spotify sign-in ok")
    print("\nALL IMPORT CHECKS PASSED")


if __name__ == "__main__":
    try:
        main()
    finally:
        shutil.rmtree(DATA, ignore_errors=True)
