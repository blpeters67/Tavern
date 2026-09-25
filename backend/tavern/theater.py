"""The theater: videos everyone watches together, on the same kind of shared
clock as the jukebox (see playback.py).

YouTube videos play in YouTube's own embedded player on each viewer's
screen, so nothing is downloaded or stored and no video goes through Tavern
(or the Cloudflare tunnel, whose free plan doesn't allow serving video).
Tavern only looks up a video's title and length with yt-dlp. Uploaded video
files are kept like attachments, remuxed or converted so every browser can
play them.
"""

from __future__ import annotations

import json
import logging
import re
import subprocess
import threading
from collections import deque
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import parse_qs, urlsplit

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal, queue_event
from .files import bucket_path, delete_files, video_size
from .jukebox import FFMPEG, FFPROBE, _clean_text, _ydl_base, _ydl_error, ytdlp_available, youtube_id
from .models import Member, TheaterState, Video
from .playback import PlaybackManager, QueueRequests
from .security import random_key
from .serializers import iso

log = logging.getLogger("tavern.theater")

PLAYLIST_LIMIT = 200
_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="theater")
# Converting uploads is slow; it gets its own worker so lookups never wait behind it.
_transcoder = ThreadPoolExecutor(max_workers=1, thread_name_prefix="theater-ffmpeg")
_verifying: set[int] = set()
_verify_lock = threading.Lock()


def video_payload(v: Video, progress: float | None = None) -> dict[str, Any]:
    if v.poster:
        thumb = f"/cdn/posters/{v.poster}"
    elif v.youtube_id:
        thumb = f"https://i.ytimg.com/vi/{v.youtube_id}/hqdefault.jpg"
    else:
        thumb = None
    data = {
        "id": v.id,
        "server_id": v.server_id,
        "kind": v.kind,
        "youtube_id": v.youtube_id,
        "title": v.title,
        "channel": v.channel,
        "tags": list(v.tags or []),
        "duration_ms": v.duration_ms,
        "live": bool(v.live),
        "url": f"/cdn/videos/{v.id}/{v.file}" if v.kind == "file" and v.file and v.status == "ready" else None,
        "mime": v.mime,
        "width": v.width,
        "height": v.height,
        "thumbnail_url": thumb,
        "source_url": v.source_url,
        "status": v.status,
        "error": v.error,
        "uploader_id": v.uploader_id,
        "created_at": iso(v.created_at),
    }
    if progress is not None:
        data["progress"] = progress
    return data


class TheaterManager(PlaybackManager):
    """What's on the screen, and where it is, for everyone who takes a seat."""

    state_model = TheaterState
    item_model = Video
    key = "video_id"
    items_key = "videos"
    state_event = "THEATER_STATE"
    listeners_event = "THEATER_SEATS"
    name = "Theater"

    def item_payload(self, item: Video) -> dict[str, Any]:
        return video_payload(item)


theater = TheaterManager()
queue_requests = QueueRequests(theater)


# ---------------------------------------------------------------------------
# Library rows
# ---------------------------------------------------------------------------


def publish_video(db: Session, video: Video, progress: float | None = None) -> None:
    members = list(db.scalars(select(Member.user_id).where(Member.server_id == video.server_id)))
    queue_event(db, members, "THEATER_VIDEO_UPDATE", video_payload(video, progress))


def _fail(video_id: int, message: str) -> None:
    with SessionLocal() as db:
        v = db.get(Video, video_id)
        if v is not None:
            v.status = "failed"
            v.error = message[:300]
            publish_video(db, v)
            db.commit()
    theater.progress.pop(video_id, None)
    # Even if it was deleted meanwhile: requests queued after it mustn't wait forever.
    queue_requests.finished(video_id, ok=False)


def _ready(video_id: int) -> None:
    theater.progress.pop(video_id, None)
    queue_requests.finished(video_id, ok=True)


# ---------------------------------------------------------------------------
# YouTube
# ---------------------------------------------------------------------------


def youtube_playlist_id(url: str | None) -> str | None:
    """The playlist in a YouTube link (list=...), if any. Mixes/radio (RD...) are skipped: they never end."""
    if not url or "youtu" not in url:
        return None
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return None
    host = (parts.hostname or "").lower()
    if not (host == "youtu.be" or host.endswith("youtube.com") or host.endswith("youtube-nocookie.com")):
        return None
    lid = (parse_qs(parts.query).get("list") or [None])[0]
    if lid and re.fullmatch(r"[\w-]{10,64}", lid) and not lid.startswith("RD"):
        return lid
    return None


def is_youtube_link(url: str) -> bool:
    try:
        host = (urlsplit(url.strip()).hostname or "").lower()
    except ValueError:
        return False
    return host == "youtu.be" or host.endswith("youtube.com") or host.endswith("youtube-nocookie.com")


def _duration_ms(value: Any) -> int:
    try:
        return max(0, int(float(value) * 1000)) if value else 0
    except (TypeError, ValueError):
        return 0


def lookup_youtube(yid: str) -> dict[str, Any]:
    """Title, channel, length and whether it can play outside YouTube (no download).
    Raises ValueError with a reason when it can't be watched in the theater."""
    import yt_dlp

    opts = _ydl_base() | {"skip_download": True, "noplaylist": True}
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(f"https://www.youtube.com/watch?v={yid}", download=False, process=False) or {}
    except yt_dlp.utils.DownloadError as exc:
        text = str(exc)
        if any(s in text for s in ("Private video", "Video unavailable", "has been removed", "account associated with this video", "This video is not available")):
            raise ValueError("That video is gone or private.") from None
        raise
    live_status = info.get("live_status")
    if live_status == "is_upcoming":
        raise ValueError("That live stream hasn't started yet.")
    if info.get("playable_in_embed") is False:
        raise ValueError("The owner doesn't allow this video to play outside YouTube.")
    if (info.get("age_limit") or 0) >= 18:
        raise ValueError("Age-restricted videos can only be watched on YouTube itself.")
    if info.get("availability") in ("private", "needs_auth", "subscriber_only", "premium_only"):
        raise ValueError("That video isn't public, so it can't play here.")
    live = live_status == "is_live" or bool(info.get("is_live"))
    return {
        "title": _clean_text(info.get("title")) or "YouTube video",
        "channel": _clean_text(info.get("channel") or info.get("uploader")),
        "duration_ms": 0 if live else _duration_ms(info.get("duration")),
        "live": live,
    }


def submit_lookup(video_id: int, yid: str, verify: bool = False) -> None:
    _workers.submit(_lookup, video_id, yid, verify)


def request_verify(video_id: int, yid: str) -> None:
    """A viewer's player says a video can't play here: check for ourselves (once
    at a time per video) before taking it away from everyone. It may only be
    blocked where that viewer is."""
    with _verify_lock:
        if video_id in _verifying:
            return
        _verifying.add(video_id)

    def run() -> None:
        try:
            _lookup(video_id, yid, verify=True)
        finally:
            with _verify_lock:
                _verifying.discard(video_id)

    _workers.submit(run)


def _lookup(video_id: int, yid: str, verify: bool = False) -> None:
    """Fill in a video's details. With `verify`, the video is already playable
    (it came from search results) and this only checks it may play outside
    YouTube, taking it out of the queue if not."""
    try:
        meta = lookup_youtube(yid)
    except ValueError as exc:
        _fail(video_id, str(exc))
        if verify:
            with SessionLocal() as db:
                v = db.get(Video, video_id)
                if v is not None:
                    theater.drop_item(db, v.server_id, video_id)
                    db.commit()
        return
    except Exception as exc:  # noqa: BLE001 - network/extractor trouble
        log.info("Looking up YouTube %s failed: %s", yid, exc)
        if not verify:
            _fail(video_id, _ydl_error(exc))
        return
    with SessionLocal() as db:
        v = db.get(Video, video_id)
        if v is None:
            # Deleted while we looked: let the requests queued after it go ahead.
            if not verify:
                theater.progress.pop(video_id, None)
                queue_requests.finished(video_id, ok=False)
            return
        # Keep a title someone already typed or picked from search results.
        if not v.title or v.title == v.source_url or v.title == "YouTube video":
            v.title = meta["title"][:200]
        v.channel = v.channel or meta["channel"]
        if meta["duration_ms"] and not v.duration_ms:
            v.duration_ms = meta["duration_ms"]
            theater.set_duration(db, v.server_id, v.id, v.duration_ms)
        v.live = meta["live"]
        v.status = "ready"
        v.error = None
        publish_video(db, v)
        db.commit()
        theater._durations.pop(video_id, None)
    if not verify:
        _ready(video_id)


def list_playlist(lid: str) -> tuple[str, list[dict[str, Any]]]:
    """The videos in a YouTube playlist (flat: no per-video lookups)."""
    import yt_dlp

    opts = _ydl_base() | {"extract_flat": "in_playlist", "skip_download": True, "playlistend": PLAYLIST_LIMIT}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"https://www.youtube.com/playlist?list={lid}", download=False) or {}
    out: list[dict[str, Any]] = []
    for e in info.get("entries") or []:
        vid = e.get("id") if isinstance(e, dict) else None
        if not vid or not re.fullmatch(r"[\w-]{11}", str(vid)):
            continue
        if e.get("live_status") == "is_upcoming":
            continue
        title = _clean_text(e.get("title"))
        if title in ("[Private video]", "[Deleted video]"):
            continue
        out.append(
            {
                "id": vid,
                "title": title or "YouTube video",
                "channel": _clean_text(e.get("channel") or e.get("uploader")),
                "duration_ms": _duration_ms(e.get("duration")),
                "live": e.get("live_status") == "is_live",
            }
        )
    return _clean_text(info.get("title")) or "YouTube playlist", out[:PLAYLIST_LIMIT]


def submit_playlist(placeholder_id: int, lid: str, server_id: int, uploader_id: int, tags: list[str], queue: str | None) -> None:
    _workers.submit(_playlist, placeholder_id, lid, server_id, uploader_id, tags, queue)


def _playlist(placeholder_id: int, lid: str, server_id: int, uploader_id: int, tags: list[str], queue: str | None) -> None:
    try:
        _name, entries = list_playlist(lid)
    except Exception as exc:  # noqa: BLE001
        log.info("Reading YouTube playlist %s failed: %s", lid, exc)
        _fail(placeholder_id, _ydl_error(exc))
        return
    if not entries:
        _fail(placeholder_id, "There are no playable videos in that playlist.")
        return
    order: list[int] = []
    with SessionLocal() as db:
        placeholder = db.get(Video, placeholder_id)
        if placeholder is None:
            return
        used = False
        members = list(db.scalars(select(Member.user_id).where(Member.server_id == server_id)))
        for e in entries:
            existing = db.scalar(select(Video).where(Video.server_id == server_id, Video.youtube_id == e["id"], Video.status == "ready", Video.id != placeholder_id))
            if existing is not None:
                order.append(existing.id)
                continue
            if not used:
                v = placeholder
                used = True
            else:
                v = Video(server_id=server_id, uploader_id=uploader_id, kind="youtube", tags=list(tags))
                db.add(v)
            v.youtube_id = e["id"]
            v.title = e["title"][:200]
            v.channel = e["channel"]
            v.duration_ms = e["duration_ms"]
            v.live = e["live"]
            v.source_url = f"https://www.youtube.com/watch?v={e['id']}"
            v.status = "ready"
            v.error = None
            db.flush()
            queue_event(db, members, "THEATER_VIDEO_UPDATE", video_payload(v))
            order.append(v.id)
        if not used:
            db.delete(placeholder)
            queue_event(db, members, "THEATER_VIDEO_DELETE", {"server_id": server_id, "video_id": placeholder_id})
        db.commit()
    theater.progress.pop(placeholder_id, None)
    if queue and order:
        # One block, in playlist order ("now" plays the first and the rest follow).
        with SessionLocal() as db:
            theater.enqueue(db, server_id, uploader_id, order, queue)
            db.commit()


# ---------------------------------------------------------------------------
# Uploaded videos
# ---------------------------------------------------------------------------

WEB_VIDEO = {"h264", "vp8", "vp9", "av1"}
WEB_AUDIO_MP4 = {"aac", "mp3"}
WEB_AUDIO_WEBM = {"opus", "vorbis"}


def probe_video(path: Path) -> dict[str, Any]:
    info: dict[str, Any] = {"duration_ms": 0, "container": "", "video": None, "audio": None}
    if not FFPROBE:
        return info
    res = subprocess.run([FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)], capture_output=True, timeout=60, check=False)
    if res.returncode != 0:
        return info
    try:
        data = json.loads(res.stdout or b"{}")
    except ValueError:
        return info
    fmt = data.get("format") or {}
    info["container"] = fmt.get("format_name") or ""
    info["duration_ms"] = _duration_ms(fmt.get("duration"))
    for stream in data.get("streams") or []:
        kind = stream.get("codec_type")
        if kind == "video" and info["video"] is None and not (stream.get("disposition") or {}).get("attached_pic"):
            info["video"] = stream.get("codec_name")
            info["pix_fmt"] = stream.get("pix_fmt")
        elif kind == "audio" and info["audio"] is None:
            info["audio"] = stream.get("codec_name")
    return info


def submit_video_upload(video_id: int, path: Path) -> None:
    _transcoder.submit(process_video, video_id, path)


def _set_progress(video_id: int, progress: float) -> None:
    theater.progress[video_id] = progress
    with SessionLocal() as db:
        v = db.get(Video, video_id)
        if v is not None:
            publish_video(db, v, progress)
            db.commit()


def process_video(video_id: int, src: Path) -> None:
    """Make an upload playable everywhere: copy it into MP4/WebM when the codecs
    already work in browsers, otherwise convert to H.264/AAC."""
    out: Path | None = None
    try:
        if not FFMPEG or not FFPROBE:
            raise ValueError("Video uploads need ffmpeg on the server.")
        info = probe_video(src)
        if not info["video"]:
            raise ValueError("That file doesn't have any video in it.")
        vcodec, acodec, container = info["video"], info["audio"], info["container"]
        webm = container.startswith("matroska") or "webm" in container
        mp4ish = "mp4" in container or "mov" in container
        base = [FFMPEG, "-y", "-v", "error", "-i", str(src), "-map", "0:v:0", "-map", "0:a:0?", "-sn", "-dn"]
        if mp4ish and vcodec == "h264" and info.get("pix_fmt") in (None, "yuv420p", "yuvj420p") and acodec in (None, *WEB_AUDIO_MP4):
            out = bucket_path("videos", f"{random_key(16)}.mp4")
            cmd = [*base, "-c", "copy", "-movflags", "+faststart", str(out)]
            mime = "video/mp4"
        elif webm and vcodec in ("vp8", "vp9", "av1") and acodec in (None, *WEB_AUDIO_WEBM):
            out = bucket_path("videos", f"{random_key(16)}.webm")
            cmd = [*base, "-c", "copy", str(out)]
            mime = "video/webm"
        else:
            out = bucket_path("videos", f"{random_key(16)}.mp4")
            cmd = [
                *base,
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "23",
                "-pix_fmt",
                "yuv420p",
                "-vf",
                "scale='min(1920,iw)':-2",
                "-c:a",
                "aac",
                "-b:a",
                "160k",
                "-movflags",
                "+faststart",
                "-progress",
                "pipe:1",
                "-nostats",
                str(out),
            ]
            mime = "video/mp4"
        total = info["duration_ms"]
        # One pipe for progress and errors (two pipes read one after the other can
        # deadlock once the unread one fills up), and a watchdog for stuck files.
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        watchdog = threading.Timer(3 * 3600, proc.kill)
        watchdog.daemon = True
        watchdog.start()
        errors: deque[str] = deque(maxlen=20)
        last = 0.0
        try:
            assert proc.stdout is not None
            for raw in proc.stdout:
                line = raw.decode("utf-8", "replace").strip()
                if line.startswith("out_time_ms="):
                    if total <= 0:
                        continue
                    try:
                        done = int(line.split("=", 1)[1]) / 1000
                    except ValueError:
                        continue
                    frac = max(0.0, min(0.99, done / total))
                    if frac - last >= 0.04:
                        last = frac
                        _set_progress(video_id, frac)
                elif line and not re.match(r"^\w+=", line):
                    errors.append(line)
            code = proc.wait()
        finally:
            watchdog.cancel()
        if code != 0 or not out.exists() or out.stat().st_size == 0:
            log.info("ffmpeg failed for video %s: %s", video_id, " | ".join(errors)[-500:])
            raise ValueError("That video couldn't be converted. Try an MP4 file.")
        width, height = video_size(out)
        after = probe_video(out)
        duration = after["duration_ms"] or total
        poster = None
        try:
            at = f"{min(3.0, max(0.0, duration / 1000 * 0.1)):.2f}"
            poster_name = f"{random_key(16)}.jpg"
            res = subprocess.run(
                [FFMPEG, "-y", "-v", "error", "-ss", at, "-i", str(out), "-frames:v", "1", "-vf", "scale='min(960,iw)':-2", "-q:v", "4", str(bucket_path("posters", poster_name))],
                capture_output=True,
                timeout=60,
                check=False,
            )
            if res.returncode == 0 and bucket_path("posters", poster_name).exists():
                poster = poster_name
        except (OSError, subprocess.SubprocessError):
            poster = None
        with SessionLocal() as db:
            v = db.get(Video, video_id)
            if v is None:
                delete_files("videos", [out.name])
                delete_files("posters", [poster])
                return
            v.file = out.name
            v.mime = mime
            v.size = out.stat().st_size
            v.width, v.height = width, height
            v.duration_ms = duration
            v.poster = poster
            v.status = "ready"
            v.error = None
            publish_video(db, v)
            db.commit()
        out = None
        _ready(video_id)
    except ValueError as exc:
        _fail(video_id, str(exc))
    except Exception as exc:  # noqa: BLE001
        log.exception("Processing video %s failed", video_id)
        _fail(video_id, str(exc) or "Processing failed.")
    finally:
        src.unlink(missing_ok=True)
        if out is not None:
            out.unlink(missing_ok=True)


def reset_stuck_videos() -> None:
    """Uploads still 'processing' after a restart will never finish."""
    with SessionLocal() as db:
        for v in db.scalars(select(Video).where(Video.status == "processing")):
            v.status = "failed"
            v.error = "Tavern restarted before this finished. Try again."
        db.commit()


def theater_available() -> dict[str, bool]:
    return {"lookups": ytdlp_available()}


__all__ = [
    "is_youtube_link",
    "publish_video",
    "queue_requests",
    "request_verify",
    "submit_lookup",
    "submit_playlist",
    "submit_video_upload",
    "theater",
    "video_payload",
    "youtube_id",
    "youtube_playlist_id",
]
