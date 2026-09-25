"""The jukebox: a per-server music library, a queue, and one shared playback
clock that every listener follows.

Playback state is authoritative on the server. `started_at` is the server
time (epoch ms) at which position 0 of the current track played, so any
client can work out exactly where the song is right now. Timers advance the
queue when a track ends; fades are "transitions" the server waits out before
acting, so every listener fades together.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import subprocess
import tempfile
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

from PIL import Image
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import SessionLocal, queue_event
from .files import bucket_path, delete_files
from .models import JukeboxState, Member, Track, utcnow
from .playback import PlaybackManager
from .security import random_key
from .serializers import iso

log = logging.getLogger("tavern.jukebox")

TARGET_LUFS = -16.0
KEEP_CODECS = {"mp3", "aac"}

FFMPEG = shutil.which("ffmpeg")
FFPROBE = shutil.which("ffprobe")

_workers = ThreadPoolExecutor(max_workers=2, thread_name_prefix="jukebox")


def track_payload(t: Track, progress: float | None = None) -> dict[str, Any]:
    data = {
        "id": t.id,
        "server_id": t.server_id,
        "title": t.title,
        "artist": t.artist,
        "album": t.album,
        "tags": list(t.tags or []),
        "duration_ms": t.duration_ms,
        "url": f"/cdn/music/{t.id}/{t.file}" if t.file and t.status == "ready" else None,
        "cover_url": f"/cdn/covers/{t.cover}" if t.cover else None,
        "gain_db": t.gain_db or 0.0,
        "source_url": t.source_url,
        "status": t.status,
        "error": t.error,
        "uploader_id": t.uploader_id,
        "created_at": iso(t.created_at),
    }
    if progress is not None:
        data["progress"] = progress
    return data


class JukeboxManager(PlaybackManager):
    """The jukebox: music everyone listening hears at the same moment."""

    state_model = JukeboxState
    item_model = Track
    key = "track_id"
    items_key = "tracks"
    state_event = "JUKEBOX_STATE"
    listeners_event = "JUKEBOX_LISTENERS"
    name = "Jukebox"

    def default_state(self) -> dict[str, Any]:
        return super().default_state() | {"volume": 70, "fade": True}

    def item_payload(self, item: Track) -> dict[str, Any]:
        return track_payload(item)

    # Older names, used around the jukebox routes.
    def drop_track(self, db: Session, server_id: int, track_id: int) -> None:
        self.drop_item(db, server_id, track_id)

    def uses_track(self, db: Session, server_id: int, track_id: int) -> bool:
        return self.uses_item(db, server_id, track_id)


jukebox = JukeboxManager()


# ---------------------------------------------------------------------------
# Media processing (worker threads)
# ---------------------------------------------------------------------------


def _run(cmd: list[str], timeout: int = 600) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, timeout=timeout, check=False)


def probe(path: Path) -> dict[str, Any]:
    """Duration, codec, container and tags of an audio file."""
    info: dict[str, Any] = {"duration_ms": 0, "codec": None, "container": "", "tags": {}, "has_cover": False}
    if FFPROBE:
        res = _run([FFPROBE, "-v", "quiet", "-print_format", "json", "-show_format", "-show_streams", str(path)], timeout=60)
        if res.returncode == 0:
            try:
                data = json.loads(res.stdout or b"{}")
            except ValueError:
                data = {}
            fmt = data.get("format") or {}
            info["container"] = fmt.get("format_name") or ""
            try:
                info["duration_ms"] = int(float(fmt.get("duration") or 0) * 1000)
            except ValueError:
                pass
            info["tags"] = {str(k).lower(): str(v) for k, v in (fmt.get("tags") or {}).items()}
            for stream in data.get("streams") or []:
                if stream.get("codec_type") == "audio" and info["codec"] is None:
                    info["codec"] = stream.get("codec_name")
                    info["tags"].update({str(k).lower(): str(v) for k, v in (stream.get("tags") or {}).items() if str(k).lower() not in info["tags"]})
                if stream.get("codec_type") == "video" and (stream.get("disposition") or {}).get("attached_pic"):
                    info["has_cover"] = True
            return info
    try:
        import mutagen

        f = mutagen.File(str(path), easy=True)
        if f is not None:
            info["duration_ms"] = int((getattr(f.info, "length", 0) or 0) * 1000)
            mime = (getattr(f, "mime", None) or [""])[0]
            info["codec"] = "mp3" if "mpeg" in mime else "aac" if "mp4" in mime else mime.split("/")[-1] or None
            info["container"] = "mp4" if "mp4" in mime else info["codec"] or ""
            for key in ("title", "artist", "album"):
                val = (f.tags or {}).get(key) if f.tags else None
                if val:
                    info["tags"][key] = val[0] if isinstance(val, list) else str(val)
    except Exception:
        pass
    return info


def loudness_gain(path: Path) -> float:
    """dB to add so the track plays near TARGET_LUFS."""
    if not FFMPEG:
        return 0.0
    res = _run([FFMPEG, "-nostats", "-hide_banner", "-i", str(path), "-map", "0:a:0", "-af", "ebur128=framelog=quiet", "-f", "null", "-"])
    text = (res.stderr or b"").decode("utf-8", "replace")
    matches = re.findall(r"I:\s+(-?\d+(?:\.\d+)?) LUFS", text)
    if not matches:
        return 0.0
    integrated = float(matches[-1])
    if integrated < -70:
        return 0.0
    return round(max(-12.0, min(6.0, TARGET_LUFS - integrated)), 2)


def save_cover(data: bytes) -> str | None:
    try:
        from io import BytesIO

        img = Image.open(BytesIO(data))
        img.load()
        img = img.convert("RGB")
        w, h = img.size
        side = min(w, h)
        img = img.crop(((w - side) // 2, (h - side) // 2, (w - side) // 2 + side, (h - side) // 2 + side))
        if side > 512:
            img = img.resize((512, 512), Image.Resampling.LANCZOS)
        name = f"{random_key()}.webp"
        img.save(bucket_path("covers", name), "WEBP", quality=86, method=4)
        return name
    except Exception:
        return None


def _embedded_cover(path: Path) -> bytes | None:
    if FFMPEG:
        res = _run([FFMPEG, "-v", "quiet", "-i", str(path), "-an", "-map", "0:v:0", "-frames:v", "1", "-f", "image2pipe", "-c:v", "png", "-"], 60)
        if res.returncode == 0 and res.stdout:
            return res.stdout
    try:
        import mutagen

        f = mutagen.File(str(path))
        if f is not None and f.tags is not None:
            for key in f.tags.keys():
                if key.startswith("APIC"):
                    return f.tags[key].data
            if "covr" in f.tags:
                return bytes(f.tags["covr"][0])
            if hasattr(f, "pictures") and f.pictures:
                return f.pictures[0].data
    except Exception:
        pass
    return None


def _clean_text(value: Any, limit: int = 200) -> str | None:
    if value is None:
        return None
    text = " ".join(str(value).split())
    return text[:limit] or None


def _publish_track(db: Session, track: Track, progress: float | None = None) -> None:
    members = list(db.scalars(select(Member.user_id).where(Member.server_id == track.server_id)))
    queue_event(db, members, "JUKEBOX_TRACK_UPDATE", track_payload(track, progress))


def _fail(track_id: int, message: str) -> None:
    with SessionLocal() as db:
        t = db.get(Track, track_id)
        if t is not None:
            t.status = "failed"
            t.error = message[:300]
            _publish_track(db, t)
            db.commit()
    jukebox.progress.pop(track_id, None)
    # Even if it was deleted meanwhile: requests queued after it mustn't wait forever.
    queue_requests.finished(track_id, ok=False)


def process_file(track_id: int, src: Path, *, meta: dict[str, Any] | None = None, cover_file: Path | None = None) -> None:
    """Probe, convert if needed, measure loudness, grab cover art, mark ready."""
    meta = meta or {}
    final: Path | None = None
    try:
        info = probe(src)
        if not info["codec"] and not info["duration_ms"]:
            raise ValueError("That file doesn't contain audio I can read.")
        codec = (info["codec"] or "").lower()
        container = info["container"] or ""
        keep = codec in KEEP_CODECS and (codec != "aac" or "mp4" in container or "m4a" in container or "mov" in container)
        if keep:
            ext = ".mp3" if codec == "mp3" else ".m4a"
            name = f"{random_key(16)}{ext}"
            final = bucket_path("music", name)
            shutil.move(str(src), final)
        else:
            if not FFMPEG:
                raise ValueError("Only MP3 and M4A files work without ffmpeg installed.")
            name = f"{random_key(16)}.m4a"
            final = bucket_path("music", name)
            res = _run([FFMPEG, "-y", "-v", "error", "-i", str(src), "-vn", "-map", "0:a:0", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(final)], 1800)
            if res.returncode != 0 or not final.exists():
                raise ValueError("Couldn't convert that audio file.")
            src.unlink(missing_ok=True)
            info2 = probe(final)
            info["duration_ms"] = info2["duration_ms"] or info["duration_ms"]
        mime = "audio/mpeg" if final.suffix == ".mp3" else "audio/mp4"
        gain = loudness_gain(final)

        cover_name = None
        cover_bytes = None
        if cover_file is not None and cover_file.exists():
            cover_bytes = cover_file.read_bytes()
        elif info["has_cover"] or not FFPROBE:
            cover_bytes = _embedded_cover(final)
        if cover_bytes:
            cover_name = save_cover(cover_bytes)

        tags = info["tags"]
        with SessionLocal() as db:
            t = db.get(Track, track_id)
            if t is None:
                final.unlink(missing_ok=True)
                delete_files("covers", [cover_name])
                queue_requests.finished(track_id, ok=False)
                return
            t.title = _clean_text(meta.get("title") or tags.get("title")) or t.title
            t.artist = _clean_text(meta.get("artist") or tags.get("artist") or tags.get("album_artist")) or t.artist
            t.album = _clean_text(meta.get("album") or tags.get("album")) or t.album
            t.duration_ms = int(info["duration_ms"] or meta.get("duration_ms") or 0)
            t.file = final.name
            t.mime = mime
            t.size = final.stat().st_size
            t.gain_db = gain
            if cover_name and not t.cover:
                t.cover = cover_name
            elif cover_name:
                delete_files("covers", [cover_name])
            t.status = "ready"
            t.error = None
            _publish_track(db, t)
            db.commit()
        jukebox._durations.pop(track_id, None)
        jukebox.progress.pop(track_id, None)
        queue_requests.finished(track_id, ok=True)
    except subprocess.TimeoutExpired:
        if final is not None:
            final.unlink(missing_ok=True)
        _fail(track_id, "Processing took too long.")
    except Exception as exc:  # noqa: BLE001 - report anything to the DJ
        log.warning("Processing track %s failed: %s", track_id, exc)
        if final is not None:
            final.unlink(missing_ok=True)
        _fail(track_id, str(exc) or "Processing failed.")
    finally:
        src.unlink(missing_ok=True)


class QueueRequests:
    """Songs a DJ asked to queue before they finished downloading.

    They join the queue in the order they were asked for, even when a later
    one finishes downloading first.
    """

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._waiting: dict[int, list[dict[str, Any]]] = {}  # server id -> requests in order
        self._server_of: dict[int, int] = {}

    def add(self, server_id: int, track_id: int, actor_id: int, where: str) -> None:
        with self._lock:
            self._waiting.setdefault(server_id, []).append({"track": track_id, "actor": actor_id, "where": where, "ok": None})
            self._server_of[track_id] = server_id

    def wants(self, track_id: int) -> bool:
        with self._lock:
            return track_id in self._server_of

    def finished(self, track_id: int, ok: bool) -> None:
        with self._lock:
            server_id = self._server_of.get(track_id)
            if server_id is None:
                return
            waiting = self._waiting.get(server_id, [])
            for req in waiting:
                if req["track"] == track_id:
                    req["ok"] = ok
            ready: list[dict[str, Any]] = []
            while waiting and waiting[0]["ok"] is not None:
                req = waiting.pop(0)
                self._server_of.pop(req["track"], None)
                if req["ok"]:
                    ready.append(req)
            if not waiting:
                self._waiting.pop(server_id, None)
        if not ready:
            return
        with SessionLocal() as db:
            for req in ready:
                # It may have been deleted since it finished.
                t = db.get(Track, req["track"])
                if t is None or t.status != "ready" or t.server_id != server_id:
                    continue
                jukebox.enqueue(db, server_id, req["actor"], [req["track"]], req["where"])
            db.commit()


queue_requests = QueueRequests()

YOUTUBE_ID_RE = re.compile(r"(?:[?&]v=|youtu\.be/|/shorts/|/embed/|/live/)([\w-]{11})")


def youtube_id(url: str | None) -> str | None:
    """The 11-character video id in a YouTube link, if it is one."""
    if not url or ("youtu" not in url):
        return None
    m = YOUTUBE_ID_RE.search(url)
    return m.group(1) if m else None


_search_cache: dict[str, tuple[float, list[dict[str, Any]]]] = {}
_search_lock = threading.Lock()


def youtube_search(query: str, limit: int = 12) -> list[dict[str, Any]]:
    """Search YouTube (no download). Results are cached for a few minutes."""
    key = " ".join(query.lower().split())
    with _search_lock:
        hit = _search_cache.get(key)
        if hit and time.monotonic() - hit[0] < 600:
            return hit[1]
    import yt_dlp

    opts = _ydl_base() | {"extract_flat": True, "skip_download": True}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(f"ytsearch{limit}:{query}", download=False)
    results: list[dict[str, Any]] = []
    for e in (info or {}).get("entries") or []:
        vid = e.get("id") if isinstance(e, dict) else None
        if not vid or not re.fullmatch(r"[\w-]{11}", str(vid)):
            continue  # channels and playlists
        if e.get("live_status") in ("is_live", "is_upcoming"):
            continue
        duration = e.get("duration")
        results.append(
            {
                "id": vid,
                "title": _clean_text(e.get("title")) or "Untitled",
                "channel": _clean_text(e.get("channel") or e.get("uploader")),
                "duration_ms": int(float(duration) * 1000) if duration else None,
                "url": f"https://www.youtube.com/watch?v={vid}",
                "thumbnail": f"https://i.ytimg.com/vi/{vid}/mqdefault.jpg",
            }
        )
    with _search_lock:
        _search_cache[key] = (time.monotonic(), results)
        while len(_search_cache) > 200:
            _search_cache.pop(next(iter(_search_cache)))
    return results


def submit_upload(track_id: int, path: Path) -> None:
    _workers.submit(process_file, track_id, path)


# ---------------------------------------------------------------------------
# Link imports with yt-dlp
# ---------------------------------------------------------------------------


def url_import_error(url: str) -> str | None:
    """Returns a reason to refuse this URL, or None if it's fine."""
    try:
        parts = urlsplit(url.strip())
    except ValueError:
        return "That isn't a valid link."
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return "Paste a full http(s) link."
    if not settings.jukebox_allow_private_urls:
        from .embeds import _is_public_host

        if not _is_public_host(parts.hostname):
            return "That link points at a private network address."
    return None


def ytdlp_available() -> bool:
    try:
        import yt_dlp  # noqa: F401

        return True
    except ImportError:
        return False


def _ydl_base() -> dict[str, Any]:
    opts: dict[str, Any] = {
        "quiet": True,
        "no_warnings": True,
        "noprogress": True,
        "socket_timeout": 20,
        "retries": 3,
        "extractor_retries": 2,
        "cachedir": str(settings.data_dir / "cache" / "yt-dlp"),
    }
    if shutil.which("deno"):
        opts["js_runtimes"] = {"deno": {}}
    elif shutil.which("node"):
        opts["js_runtimes"] = {"node": {}}
    return opts


def submit_import(track_id: int, url: str, server_id: int, uploader_id: int, tags: list[str]) -> None:
    _workers.submit(_import, track_id, url, server_id, uploader_id, tags)


def _import(track_id: int, url: str, server_id: int, uploader_id: int, tags: list[str]) -> None:
    try:
        import yt_dlp
    except ImportError:
        _fail(track_id, "Link imports need yt-dlp installed on the server.")
        return
    try:
        opts = _ydl_base() | {"extract_flat": "in_playlist", "playlist_items": "1:100"}
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=False)
    except Exception as exc:  # noqa: BLE001
        _fail(track_id, _ydl_error(exc))
        return
    if info is None:
        _fail(track_id, "Couldn't find anything to download at that link.")
        return

    entries: list[dict[str, Any]]
    if info.get("_type") == "playlist" or info.get("entries") is not None:
        entries = [e for e in (info.get("entries") or []) if e][:100]
        if not entries:
            _fail(track_id, "That playlist is empty.")
            return
    else:
        entries = [info]

    # One placeholder track already exists; add rows for the rest of a playlist.
    track_ids = [track_id]
    with SessionLocal() as db:
        first = db.get(Track, track_id)
        if first is None:
            return
        first.title = _clean_text(entries[0].get("title")) or first.title
        _publish_track(db, first, 0.0)
        for entry in entries[1:]:
            t = Track(
                server_id=server_id,
                uploader_id=uploader_id,
                title=_clean_text(entry.get("title")) or "Untitled",
                tags=list(tags),
                source_url=(entry.get("webpage_url") or entry.get("url") or url)[:1024],
                status="processing",
            )
            db.add(t)
            db.flush()
            track_ids.append(t.id)
            _publish_track(db, t, 0.0)
        db.commit()
    # Queued a whole playlist: the rest follow the first, in order.
    if len(track_ids) > 1 and queue_requests.wants(track_id):
        for tid in track_ids[1:]:
            queue_requests.add(server_id, tid, uploader_id, "end")

    for tid, entry in zip(track_ids, entries):
        target = entry.get("webpage_url") or entry.get("url") or url
        if entry is info:
            target = info.get("webpage_url") or url
        _download_one(tid, str(target))


def _ydl_error(exc: Exception) -> str:
    text = str(exc)
    text = re.sub(r"\x1b\[[0-9;]*m", "", text)
    text = text.replace("ERROR: ", "")
    if "Unsupported URL" in text:
        return "That site isn't supported."
    if "Sign in to confirm" in text or "confirm your age" in text:
        return "That video needs a login, so it can't be imported."
    if "Private video" in text:
        return "That video is private."
    if "File is larger than max-filesize" in text:
        return f"That file is bigger than {settings.jukebox_max_track_mb} MB."
    return text.strip()[:250] or "Download failed."


def _download_one(track_id: int, url: str, *, meta_override: dict[str, Any] | None = None, cover_url: str | None = None, keep_source: bool = False) -> None:
    """Download one video's audio. `meta_override` (title/artist/album) and
    `cover_url` replace what YouTube says, e.g. with Spotify's names and art;
    `keep_source` keeps the link the DJ gave (so duplicates are spotted)."""
    import yt_dlp

    tmp = Path(tempfile.mkdtemp(prefix="dl-", dir=settings.uploads_dir / "tmp"))
    last_sent = [0.0]

    def hook(d: dict[str, Any]) -> None:
        if d.get("status") != "downloading":
            return
        total = d.get("total_bytes") or d.get("total_bytes_estimate") or 0
        if not total:
            return
        pct = round(min(0.99, d.get("downloaded_bytes", 0) / total), 3)
        jukebox.progress[track_id] = pct
        if time.monotonic() - last_sent[0] < 1.0:
            return
        last_sent[0] = time.monotonic()
        with SessionLocal() as db:
            t = db.get(Track, track_id)
            if t is not None:
                _publish_track(db, t, pct)
                db.commit()

    opts = _ydl_base() | {
        "format": "bestaudio[ext=m4a]/bestaudio[acodec=mp3]/bestaudio/best",
        "outtmpl": str(tmp / "audio.%(ext)s"),
        "noplaylist": True,
        "writethumbnail": not cover_url,
        "max_filesize": settings.jukebox_max_track_mb * 1024 * 1024,
        "progress_hooks": [hook],
    }
    try:
        with yt_dlp.YoutubeDL(opts) as ydl:
            info = ydl.extract_info(url, download=True)
        if info is None:
            raise ValueError("Nothing was downloaded.")
        audio = next((p for p in tmp.iterdir() if p.stem == "audio" and p.suffix.lower() not in (".jpg", ".jpeg", ".png", ".webp", ".part")), None)
        if audio is None:
            raise ValueError("The download didn't produce an audio file.")
        cover = next((p for p in tmp.iterdir() if p.suffix.lower() in (".jpg", ".jpeg", ".png", ".webp")), None)
        if cover_url:
            cover = _fetch_cover(cover_url, tmp) or cover
        meta = {
            "title": info.get("track") or info.get("title"),
            "artist": info.get("artist") or info.get("creator") or info.get("uploader") or info.get("channel"),
            "album": info.get("album"),
            "duration_ms": int((info.get("duration") or 0) * 1000),
        }
        meta.update({k: v for k, v in (meta_override or {}).items() if v})
        if not keep_source:
            with SessionLocal() as db:
                t = db.get(Track, track_id)
                if t is not None:
                    t.source_url = (info.get("webpage_url") or url)[:1024]
                    db.commit()
        process_file(track_id, audio, meta=meta, cover_file=cover)
    except Exception as exc:  # noqa: BLE001
        log.info("Import of %s failed: %s", url, exc)
        _fail(track_id, _ydl_error(exc))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def _fetch_cover(url: str, folder: Path) -> Path | None:
    """Download cover art (e.g. from Spotify's image server)."""
    import httpx

    try:
        resp = httpx.get(url, timeout=15, follow_redirects=True)
        resp.raise_for_status()
        if len(resp.content) > 8 * 1024 * 1024:
            return None
        path = folder / "cover.jpg"
        path.write_bytes(resp.content)
        return path
    except Exception as exc:  # noqa: BLE001
        log.info("Couldn't fetch cover %s: %s", url, exc)
        return None


def submit_spotify(track_id: int, kind: str, spotify_id: str, server_id: int, uploader_id: int, tags: list[str], queue: str | None) -> None:
    _workers.submit(_spotify_import, track_id, kind, spotify_id, server_id, uploader_id, tags, queue)


def _spotify_import(track_id: int, kind: str, spotify_id: str, server_id: int, uploader_id: int, tags: list[str], queue: str | None) -> None:
    """Read the songs behind a Spotify link, then fetch each one's audio from YouTube."""
    from . import spotify
    from .models import User

    try:
        # Songs and albums only need the API key. Playlists need the DJ's own
        # Spotify sign-in, if they connected one.
        user_token = None
        if kind == "playlist":
            with SessionLocal() as db:
                user = db.get(User, uploader_id)
                if user is not None and user.spotify_auth:
                    try:
                        token, updated = spotify.fresh_user_token(user.spotify_auth)
                    except spotify.ConnectionExpired:
                        # Forget the dead sign-in so the Library offers to connect again.
                        user.spotify_auth = None
                        db.commit()
                        raise
                    if updated is not None:
                        user.spotify_auth = updated
                        db.commit()
                    user_token = token
        collection = spotify.read_link(kind, spotify_id, user_token)
    except spotify.SpotifyError as exc:
        _fail(track_id, str(exc))
        return
    except Exception as exc:  # noqa: BLE001
        log.warning("Reading Spotify %s %s failed: %s", kind, spotify_id, exc)
        _fail(track_id, "Couldn't read that Spotify link.")
        return
    if not collection.songs:
        _fail(track_id, "There are no songs at that Spotify link.")
        return

    # One row per song, in order. Songs already in the library aren't fetched again.
    todo: list[tuple[int, Any]] = []
    order: list[tuple[int, bool]] = []  # (track id, already ready)
    with SessionLocal() as db:
        placeholder = db.get(Track, track_id)
        if placeholder is None:
            return
        used_placeholder = False
        for song in collection.songs:
            existing = db.scalar(
                select(Track).where(
                    Track.server_id == server_id,
                    Track.source_url == song.url[:1024],
                    Track.status.in_(("ready", "processing")),
                    Track.id != track_id,
                )
            )
            if existing is not None:
                order.append((existing.id, existing.status == "ready"))
                continue
            if not used_placeholder:
                t = placeholder
                used_placeholder = True
            else:
                t = Track(server_id=server_id, uploader_id=uploader_id, tags=list(tags), status="processing")
                db.add(t)
            t.title = _clean_text(song.title) or "Untitled"
            t.artist = _clean_text(song.artist)
            t.album = _clean_text(song.album)
            t.source_url = song.url[:1024]
            db.flush()
            _publish_track(db, t, 0.0)
            todo.append((t.id, song))
            order.append((t.id, False))
        if not used_placeholder:
            # Everything was already in the library: drop the placeholder row.
            members = list(db.scalars(select(Member.user_id).where(Member.server_id == server_id)))
            db.delete(placeholder)
            queue_event(db, members, "JUKEBOX_TRACK_DELETE", {"server_id": server_id, "track_id": track_id})
        db.commit()

    if queue:
        for i, (tid, ready) in enumerate(order):
            queue_requests.add(server_id, tid, uploader_id, queue if i == 0 else "end")
        for tid, ready in order:
            if ready:
                queue_requests.finished(tid, ok=True)

    for tid, song in todo:
        try:
            url = spotify.best_match(song, youtube_search)
        except Exception as exc:  # noqa: BLE001
            log.info("Matching %s failed: %s", song.url, exc)
            url = None
        if not url:
            _fail(tid, "Couldn't find this song on YouTube.")
            continue
        _download_one(
            tid,
            url,
            meta_override={"title": song.title, "artist": song.artist, "album": song.album, "duration_ms": song.duration_ms},
            cover_url=song.cover,
            keep_source=True,
        )


def reset_stuck_tracks() -> None:
    """Tracks still 'processing' after a restart will never finish."""
    with SessionLocal() as db:
        for t in db.scalars(select(Track).where(Track.status == "processing")):
            t.status = "failed"
            t.error = "The server restarted while this was processing. Try again."
        db.commit()
    shutil.rmtree(settings.uploads_dir / "tmp", ignore_errors=True)
    (settings.uploads_dir / "tmp").mkdir(parents=True, exist_ok=True)


def utc_now():  # re-exported for routes
    return utcnow()
