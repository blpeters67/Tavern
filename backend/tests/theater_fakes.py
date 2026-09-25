"""Runs the real Tavern server with YouTube faked (tests can't reach it).

    python tests/theater_fakes.py 8768
"""

from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import time  # noqa: E402

import uvicorn  # noqa: E402

import tavern.routes.theater as routes  # noqa: E402
import tavern.theater as theater  # noqa: E402


def fake_search(query: str, limit: int = 12):
    words = query.strip().title()
    stem = "".join(c for c in query if c.isalnum())[:5].ljust(5, "x")
    out = []
    for i in range(3):
        vid = f"{stem}{i}srch"[:11].ljust(11, "z")
        out.append(
            {
                "id": vid,
                "title": f"{words} part {i + 1}",
                "channel": "Tavern Tales",
                "duration_ms": (60 + i) * 1000,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            }
        )
    return out


_looked_up: set[str] = set()


def fake_lookup(yid: str) -> dict:
    if yid.startswith("SLOW"):
        time.sleep(1.5)
    if yid.startswith("LATER"):
        # Fine the first time; blocked once someone's player says so (checked again).
        if yid in _looked_up:
            raise ValueError("The owner doesn't allow this video to play outside YouTube.")
        _looked_up.add(yid)
    if yid.startswith("NOEMBED"):
        raise ValueError("The owner doesn't allow this video to play outside YouTube.")
    if yid.startswith("LIVE"):
        return {"title": "A live stream", "channel": "Live", "duration_ms": 0, "live": True}
    if yid.startswith("NOLEN"):
        return {"title": "Mystery length", "channel": None, "duration_ms": 0, "live": False}
    return {"title": f"Video {yid}", "channel": "Some Channel", "duration_ms": 95_000, "live": False}


def fake_playlist(lid: str):
    return "Road trip", [
        {"id": f"PL{i}xxxxxxxx"[:11], "title": f"Episode {i + 1}", "channel": "Show", "duration_ms": (30 + i) * 1000, "live": False} for i in range(3)
    ]


theater.lookup_youtube = fake_lookup
theater.list_playlist = fake_playlist
routes.youtube_search = fake_search
routes.ytdlp_available = lambda: True
theater.ytdlp_available = lambda: True

if __name__ == "__main__":
    uvicorn.run("tavern.main:app", host="127.0.0.1", port=int(sys.argv[1]), log_level="warning")
