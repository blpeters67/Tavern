"""Upload handling: avatars/icons/emojis get normalised with Pillow;
attachments are stored as-is with a random name."""

from __future__ import annotations

import json
import logging
import mimetypes
import os
import re
import shutil
import subprocess
import threading
import unicodedata
from io import BytesIO
from pathlib import Path

from fastapi import UploadFile
from PIL import Image, ImageOps

from .config import settings
from .deps import ApiError, bad_request
from .security import random_key

log = logging.getLogger("tavern.files")

Image.MAX_IMAGE_PIXELS = 60_000_000

BUCKETS = ("avatars", "icons", "emojis", "attachments", "previews", "music", "covers", "videos", "posters", "boards", "tmp")

FFPROBE = shutil.which("ffprobe")

mimetypes.add_type("image/webp", ".webp")
mimetypes.add_type("image/avif", ".avif")
mimetypes.add_type("video/webm", ".webm")
mimetypes.add_type("video/quicktime", ".mov")
mimetypes.add_type("video/x-matroska", ".mkv")
mimetypes.add_type("audio/mp4", ".m4a")
mimetypes.add_type("audio/ogg", ".ogg")
mimetypes.add_type("audio/ogg", ".opus")
mimetypes.add_type("audio/flac", ".flac")
mimetypes.add_type("audio/wav", ".wav")
mimetypes.add_type("text/markdown", ".md")

# Types that are safe to show inline in the browser. Anything else (HTML, SVG,
# PDF, executables...) is served as a download so it can't run on our origin.
INLINE_TYPES = {
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "image/avif",
    "image/bmp",
    "video/mp4",
    "video/webm",
    "video/quicktime",
    "video/ogg",
    "audio/mpeg",
    "audio/mp4",
    "audio/aac",
    "audio/ogg",
    "audio/wav",
    "audio/x-wav",
    "audio/webm",
    "audio/flac",
    "text/plain",
}

IMAGE_TYPES = {"image/png", "image/jpeg", "image/gif", "image/webp", "image/avif", "image/bmp"}


def bucket_path(bucket: str, name: str) -> Path:
    assert bucket in BUCKETS
    # `name` always comes from our own random_key(); guard anyway.
    if "/" in name or "\\" in name or name.startswith("."):
        raise ApiError(404, "Not found")
    return settings.uploads_dir / bucket / name


def ensure_dirs() -> None:
    for b in BUCKETS:
        (settings.uploads_dir / b).mkdir(parents=True, exist_ok=True)


def delete_files(bucket: str, names: list[str | None]) -> None:
    for name in names:
        if not name:
            continue
        try:
            bucket_path(bucket, name).unlink(missing_ok=True)
            if bucket == "attachments":
                bucket_path("previews", preview_name(name)).unlink(missing_ok=True)
        except Exception:  # pragma: no cover - best effort
            log.warning("Couldn't delete %s/%s", bucket, name)


def _read_limited(upload: UploadFile, limit: int) -> bytes:
    data = upload.file.read(limit + 1)
    if len(data) > limit:
        raise ApiError(413, f"That file is too big. The limit is {limit // (1024 * 1024)} MB.")
    if not data:
        raise bad_request("That file is empty.")
    return data


def save_image(upload: UploadFile, bucket: str, *, square: bool, size: int, limit_mb: int = 10) -> tuple[str, bool]:
    """Validate and store an avatar/icon/emoji. Returns (filename, animated)."""
    data = _read_limited(upload, limit_mb * 1024 * 1024)
    try:
        img = Image.open(BytesIO(data))
        img.load()
    except Exception:
        raise bad_request("That doesn't look like an image we can use. Try a PNG, JPG, GIF or WEBP.")

    # Animated GIFs are kept as uploaded so they stay animated.
    if img.format == "GIF" and getattr(img, "is_animated", False):
        name = f"{random_key()}.gif"
        bucket_path(bucket, name).write_bytes(data)
        return name, True

    img = ImageOps.exif_transpose(img)
    img = img.convert("RGBA")
    if square:
        w, h = img.size
        side = min(w, h)
        left, top = (w - side) // 2, (h - side) // 2
        img = img.crop((left, top, left + side, top + side))
        if side > size:
            img = img.resize((size, size), Image.Resampling.LANCZOS)
    else:
        img.thumbnail((size, size), Image.Resampling.LANCZOS)

    name = f"{random_key()}.webp"
    img.save(bucket_path(bucket, name), "WEBP", quality=90, method=4)
    return name, False


def clean_filename(name: str | None) -> str:
    name = (name or "file").replace("\\", "/").split("/")[-1]
    name = unicodedata.normalize("NFC", name)
    name = re.sub(r"[\x00-\x1f\x7f]", "", name)
    name = re.sub(r"\s+", "_", name).strip("._") or "file"
    if len(name) > 180:
        stem, dot, ext = name.rpartition(".")
        name = (stem[:170] + dot + ext[:9]) if dot else name[:180]
    return name


def guess_type(filename: str, declared: str | None) -> str:
    guessed, _ = mimetypes.guess_type(filename)
    ctype = (guessed or declared or "application/octet-stream").split(";")[0].strip().lower()
    return ctype[:128]


def save_attachment(upload: UploadFile, limit: int) -> dict:
    """Stream an upload to disk. Returns the fields for an Attachment row."""
    filename = clean_filename(upload.filename)
    ext = Path(filename).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", ext or ""):
        ext = ""
    stored = f"{random_key(16)}{ext}"
    path = bucket_path("attachments", stored)
    size = 0
    try:
        with open(path, "wb") as out:
            while chunk := upload.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ApiError(413, f"Your files are too big. The limit is {limit // (1024 * 1024)} MB per message.")
                out.write(chunk)
    except BaseException:
        path.unlink(missing_ok=True)
        raise

    content_type = guess_type(filename, upload.content_type)
    width = height = None
    if content_type in IMAGE_TYPES:
        try:
            with Image.open(path) as img:
                width, height = img.size
                orientation = img.getexif().get(0x0112)
                if orientation in (5, 6, 7, 8):
                    width, height = height, width
        except Exception:
            pass
    elif content_type.startswith("video/"):
        # So the player has the right shape before the video loads.
        width, height = video_size(path)
    return {
        "filename": filename,
        "file": stored,
        "content_type": content_type,
        "size": size,
        "width": width,
        "height": height,
    }


def save_board_image(upload: UploadFile, limit: int) -> tuple[str, int, int]:
    """Store a game board picture (a battle map, a token portrait) as uploaded:
    maps are big and often pixel-exact PNGs, so nothing is re-encoded. Returns
    (stored name, width, height)."""
    filename = clean_filename(upload.filename)
    ext = Path(filename).suffix.lower()
    if not re.fullmatch(r"\.[a-z0-9]{1,10}", ext or ""):
        ext = ""
    stored = f"{random_key(16)}{ext}"
    path = bucket_path("boards", stored)
    size = 0
    try:
        with open(path, "wb") as out:
            while chunk := upload.file.read(1024 * 1024):
                size += len(chunk)
                if size > limit:
                    raise ApiError(413, f"That picture is too big. The limit is {limit // (1024 * 1024)} MB.")
                out.write(chunk)
        if size == 0:
            raise bad_request("That file is empty.")
        try:
            with Image.open(path) as img:
                img.verify()
            with Image.open(path) as img:
                if img.format not in ("PNG", "JPEG", "WEBP", "GIF", "BMP", "AVIF", "MPO"):
                    raise bad_request("That doesn't look like a picture we can use. Try a PNG, JPG or WEBP.")
                width, height = img.size
        except ApiError:
            raise
        except Exception:
            raise bad_request("That doesn't look like a picture we can use. Try a PNG, JPG or WEBP.") from None
    except BaseException:
        path.unlink(missing_ok=True)
        raise
    return stored, width, height


# ---------------------------------------------------------------------------
# Chat-sized previews of image attachments
# ---------------------------------------------------------------------------

# Chat shows an image at most 550x350; twice that covers high-density screens.
PREVIEW_BOX = (1100, 700)
# Smaller images are sent as they are (a preview wouldn't save much).
PREVIEW_MIN_BYTES = 300 * 1024
# GIFs stay as uploaded so they keep moving.
PREVIEW_TYPES = {"image/png", "image/jpeg", "image/webp", "image/bmp", "image/avif"}

_preview_locks: dict[str, threading.Lock] = {}
_preview_locks_guard = threading.Lock()
# Decoding a big image takes a lot of memory for a moment: a couple at a time.
_preview_slots = threading.BoundedSemaphore(2)


def preview_name(stored: str) -> str:
    """The preview's file for an attachment's stored name ("p1": change it if the size or format ever does)."""
    return f"{Path(stored).stem}.p1.webp"


def wants_preview(content_type: str, size: int, width: int | None, height: int | None) -> bool:
    """Would chat load this image faster as a preview?"""
    if content_type not in PREVIEW_TYPES or not width or not height:
        return False
    return size > PREVIEW_MIN_BYTES or width > PREVIEW_BOX[0] or height > PREVIEW_BOX[1]


def ensure_preview(stored: str) -> Path | None:
    """The chat-sized WebP of an image attachment: made the first time someone
    asks for it, then kept. None when there's no sensible preview (an animated
    image, one that won't decode): show the original instead."""
    dst = bucket_path("previews", preview_name(stored))
    if dst.is_file():
        return dst
    src = bucket_path("attachments", stored)
    if not src.is_file():
        return None
    with _preview_locks_guard:
        lock = _preview_locks.setdefault(stored, threading.Lock())
    try:
        with lock:  # everyone opening the same new image waits for one preview
            if dst.is_file():
                return dst
            with _preview_slots:
                made = _make_preview(src, dst)
            return dst if made else None
    finally:
        with _preview_locks_guard:
            _preview_locks.pop(stored, None)


def _make_preview(src: Path, dst: Path) -> bool:
    tmp = dst.with_name(f"{dst.name}.{random_key(6)}.tmp")
    try:
        with Image.open(src) as img:
            if getattr(img, "n_frames", 1) > 1:
                return False
            # JPEGs can decode straight at a smaller scale (much faster for photos).
            side = max(PREVIEW_BOX)
            img.draft("RGB", (side, side))
            out = ImageOps.exif_transpose(img)
            out.thumbnail(PREVIEW_BOX, Image.Resampling.LANCZOS)
            if out.mode not in ("RGB", "RGBA"):
                alpha = out.mode in ("LA", "PA", "La", "RGBa") or (out.mode == "P" and "transparency" in out.info)
                out = out.convert("RGBA" if alpha else "RGB")
            out.save(tmp, "WEBP", quality=80, method=4)
        os.replace(tmp, dst)
        return True
    except Exception:
        log.warning("Couldn't make a preview of %s", src.name, exc_info=True)
        tmp.unlink(missing_ok=True)
        return False


def video_size(path: Path) -> tuple[int | None, int | None]:
    """How big a video shows on screen. Phone videos are often stored sideways
    with a rotation flag, so that is applied."""
    if not FFPROBE:
        return None, None
    try:
        out = subprocess.run(
            [
                FFPROBE,
                "-v",
                "error",
                "-select_streams",
                "v:0",
                "-show_entries",
                "stream=width,height:stream_side_data=rotation:stream_tags=rotate",
                "-of",
                "json",
                str(path),
            ],
            capture_output=True,
            timeout=15,
            check=False,
        )
        stream = (json.loads(out.stdout or b"{}").get("streams") or [{}])[0]
        width, height = int(stream.get("width") or 0), int(stream.get("height") or 0)
        rotation = 0
        for side in stream.get("side_data_list") or []:
            if "rotation" in side:
                rotation = int(float(side["rotation"]))
        if not rotation:
            rotation = int(float((stream.get("tags") or {}).get("rotate") or 0))
        if abs(rotation) % 180 == 90:
            width, height = height, width
        return (width or None, height or None)
    except (OSError, ValueError, subprocess.SubprocessError):
        return None, None
