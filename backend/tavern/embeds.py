"""Link previews ("embeds") for URLs posted in chat.

Runs in a background thread after a message is sent: fetches each link,
reads its OpenGraph / Twitter card tags, and pushes a MESSAGE_UPDATE with the
results. Private and loopback addresses are refused so nobody can make the
server poke at your home network.
"""

from __future__ import annotations

import ipaddress
import logging
import re
import socket
import threading
import time
from collections import OrderedDict
from html.parser import HTMLParser
from io import BytesIO
from typing import Any
from urllib.parse import parse_qs, urljoin, urlsplit

import httpx
from PIL import Image

log = logging.getLogger("tavern.embeds")

USER_AGENT = "Mozilla/5.0 (compatible; TavernBot/1.0; link previews for a private self-hosted chat)"
MAX_HTML = 1_000_000
MAX_IMAGE_PROBE = 256_000
MAX_EMBEDS = 5

URL_RE = re.compile(r"https?://[^\s<>\"'`|]+", re.IGNORECASE)
CODE_BLOCK_RE = re.compile(r"```.*?```", re.DOTALL)
INLINE_CODE_RE = re.compile(r"`[^`\n]*`")
SUPPRESSED_RE = re.compile(r"<https?://[^\s>]+>", re.IGNORECASE)


# ---------------------------------------------------------------------------
# URL extraction
# ---------------------------------------------------------------------------


def _trim(url: str) -> str:
    while url and url[-1] in ".,:;!?'\"*_~":
        url = url[:-1]
    # Drop unbalanced closing brackets: "(see https://x.com/a)" -> "https://x.com/a"
    for open_c, close_c in (("(", ")"), ("[", "]")):
        while url.endswith(close_c) and url.count(close_c) > url.count(open_c):
            url = url[:-1]
    return url


def extract_urls(content: str) -> list[str]:
    text = CODE_BLOCK_RE.sub(" ", content)
    text = INLINE_CODE_RE.sub(" ", text)
    text = SUPPRESSED_RE.sub(" ", text)  # <url> means "don't embed", like Discord
    urls: list[str] = []
    for match in URL_RE.finditer(text):
        url = _trim(match.group(0))
        if url and url not in urls:
            urls.append(url)
        if len(urls) >= MAX_EMBEDS:
            break
    return urls


# ---------------------------------------------------------------------------
# Safe fetching
# ---------------------------------------------------------------------------


def _is_public_host(host: str) -> bool:
    try:
        infos = socket.getaddrinfo(host, None, proto=socket.IPPROTO_TCP)
    except (socket.gaierror, UnicodeError):
        return False
    if not infos:
        return False
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped:
            ip = ip.ipv4_mapped
        if not ip.is_global or ip.is_multicast:
            return False
    return True


def fetch(url: str, max_bytes: int = MAX_HTML) -> tuple[str, str, bytes] | None:
    """GET a URL (following up to 4 redirects, re-checking each hop).
    Returns (final_url, content_type, body_prefix) or None."""
    headers = {
        "User-Agent": USER_AGENT,
        "Accept": "text/html,application/xhtml+xml,image/*,video/*;q=0.9,*/*;q=0.5",
        "Accept-Language": "en-US,en;q=0.8",
    }
    try:
        with httpx.Client(timeout=httpx.Timeout(6.0), follow_redirects=False, headers=headers) as client:
            for _ in range(5):
                parts = urlsplit(url)
                if parts.scheme not in ("http", "https") or not parts.hostname:
                    return None
                if not _is_public_host(parts.hostname):
                    return None
                with client.stream("GET", url) as resp:
                    if resp.is_redirect and "location" in resp.headers:
                        url = urljoin(url, resp.headers["location"])
                        continue
                    if resp.status_code >= 400:
                        return None
                    ctype = resp.headers.get("content-type", "").split(";")[0].strip().lower()
                    limit = MAX_IMAGE_PROBE if ctype.startswith("image/") else max_bytes
                    if ctype.startswith("video/") or ctype.startswith("audio/"):
                        return str(resp.url), ctype, b""
                    body = bytearray()
                    for chunk in resp.iter_bytes():
                        body += chunk
                        if len(body) >= limit:
                            break
                        if "html" in ctype and b"</head>" in body[-len(chunk) - 8 :].lower():
                            break
                    return str(resp.url), ctype, bytes(body)
    except (httpx.HTTPError, ValueError, OSError):
        return None
    return None


# ---------------------------------------------------------------------------
# HTML meta parsing
# ---------------------------------------------------------------------------


class _MetaParser(HTMLParser):
    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.meta: dict[str, str] = {}
        self.title: str | None = None
        self._in_title = False
        self.done = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if self.done:
            return
        a = {k.lower(): (v or "") for k, v in attrs}
        if tag == "meta":
            key = (a.get("property") or a.get("name") or a.get("itemprop") or "").strip().lower()
            content = a.get("content")
            if key and content and key not in self.meta:
                self.meta[key] = content.strip()
        elif tag == "title":
            self._in_title = True
        elif tag == "body":
            self.done = True

    def handle_endtag(self, tag: str) -> None:
        if tag == "title":
            self._in_title = False
        elif tag == "head":
            self.done = True

    def handle_data(self, data: str) -> None:
        if self._in_title and not self.done:
            self.title = (self.title or "") + data


def _decode(body: bytes, ctype_header: str = "") -> str:
    charset = None
    m = re.search(rb"<meta[^>]+charset=[\"']?([A-Za-z0-9_\-]+)", body[:4096], re.IGNORECASE)
    if m:
        charset = m.group(1).decode("ascii", "ignore")
    try:
        return body.decode(charset or "utf-8", errors="replace")
    except LookupError:
        return body.decode("utf-8", errors="replace")


def _int(value: str | None) -> int | None:
    try:
        n = int(float(value)) if value else None
    except ValueError:
        return None
    return n if n and 0 < n < 20000 else None


def _color(value: str | None) -> int | None:
    if value and re.fullmatch(r"#?[0-9a-fA-F]{6}", value.strip()):
        return int(value.strip().lstrip("#"), 16)
    return None


def _clip(value: str | None, n: int) -> str | None:
    if not value:
        return None
    value = re.sub(r"\s+", " ", value).strip()
    return value if len(value) <= n else value[: n - 1].rstrip() + "…"


def youtube_id(url: str) -> str | None:
    parts = urlsplit(url)
    host = (parts.hostname or "").lower().removeprefix("www.").removeprefix("m.")
    if host == "youtu.be":
        vid = parts.path.strip("/").split("/")[0]
    elif host in ("youtube.com", "music.youtube.com"):
        if parts.path == "/watch":
            vid = (parse_qs(parts.query).get("v") or [""])[0]
        elif parts.path.startswith(("/shorts/", "/embed/", "/live/")):
            vid = parts.path.split("/")[2] if len(parts.path.split("/")) > 2 else ""
        else:
            vid = ""
    else:
        return None
    return vid if re.fullmatch(r"[A-Za-z0-9_-]{6,20}", vid or "") else None


def _image_size(data: bytes) -> tuple[int | None, int | None]:
    try:
        with Image.open(BytesIO(data)) as img:
            return img.size
    except Exception:
        return None, None


def build_embed(url: str) -> dict[str, Any] | None:
    yt = youtube_id(url)
    fetched = fetch(url)
    if fetched is None:
        if yt:
            return _youtube_embed(url, yt, {}, None)
        return None
    final_url, ctype, body = fetched

    if ctype in ("image/png", "image/jpeg", "image/gif", "image/webp", "image/avif"):
        w, h = _image_size(body)
        return {"type": "image", "url": url, "thumbnail": {"url": url, "width": w, "height": h}}
    if ctype in ("video/mp4", "video/webm"):
        return {"type": "video", "url": url, "video": {"url": url, "width": None, "height": None}}
    if "html" not in ctype:
        return None

    parser = _MetaParser()
    try:
        parser.feed(_decode(body))
    except Exception:
        pass
    meta = parser.meta

    if yt:
        return _youtube_embed(url, yt, meta, parser.title)

    title = meta.get("og:title") or meta.get("twitter:title") or parser.title
    description = meta.get("og:description") or meta.get("twitter:description") or meta.get("description")
    site_name = meta.get("og:site_name") or meta.get("application-name")
    image = (
        meta.get("og:image:secure_url")
        or meta.get("og:image")
        or meta.get("og:image:url")
        or meta.get("twitter:image")
        or meta.get("twitter:image:src")
    )
    if not (title or description or image):
        return None

    embed: dict[str, Any] = {
        "type": "link",
        "url": url,
        "title": _clip(title, 256),
        "description": _clip(description, 350),
        "site_name": _clip(site_name, 100),
        "color": _color(meta.get("theme-color")),
    }

    video_url = meta.get("og:video:secure_url") or meta.get("og:video:url") or meta.get("og:video")
    video_type = (meta.get("og:video:type") or "").lower()
    if video_url and video_type == "video/mp4" and (site_name or "").lower() in ("tenor", "giphy", "imgur"):
        return {
            "type": "gifv",
            "url": url,
            "video": {
                "url": urljoin(final_url, video_url),
                "width": _int(meta.get("og:video:width")),
                "height": _int(meta.get("og:video:height")),
            },
        }

    if image and not image.startswith("data:"):
        img = {
            "url": urljoin(final_url, image),
            "width": _int(meta.get("og:image:width")),
            "height": _int(meta.get("og:image:height")),
        }
        large = meta.get("twitter:card") == "summary_large_image" or (meta.get("og:type") or "").startswith("video")
        embed["image" if large else "thumbnail"] = img
    return embed


def _youtube_embed(url: str, vid: str, meta: dict[str, str], title: str | None) -> dict[str, Any]:
    return {
        "type": "video",
        "url": url,
        "title": _clip(meta.get("og:title") or title, 256),
        "description": _clip(meta.get("og:description"), 200),
        "site_name": "YouTube",
        "color": 0xFF0000,
        "provider": "youtube",
        "thumbnail": {"url": f"https://i.ytimg.com/vi/{vid}/hqdefault.jpg", "width": 480, "height": 360},
        "video": {"url": f"https://www.youtube-nocookie.com/embed/{vid}?autoplay=1", "width": 1280, "height": 720},
    }


# ---------------------------------------------------------------------------
# Cache + message unfurling
# ---------------------------------------------------------------------------

_cache: OrderedDict[str, tuple[float, dict[str, Any] | None]] = OrderedDict()
_cache_lock = threading.Lock()
CACHE_TTL = 3600
CACHE_MAX = 500


def cached_embed(url: str) -> dict[str, Any] | None:
    now = time.monotonic()
    with _cache_lock:
        hit = _cache.get(url)
        if hit and hit[0] > now:
            _cache.move_to_end(url)
            return hit[1]
    try:
        embed = build_embed(url)
    except Exception:
        log.exception("Embed failed for %s", url)
        embed = None
    with _cache_lock:
        _cache[url] = (now + CACHE_TTL, embed)
        while len(_cache) > CACHE_MAX:
            _cache.popitem(last=False)
    return embed


def unfurl_message(message_id: int, content: str) -> None:
    """Background task: fetch embeds for a message and broadcast them."""
    from .db import SessionLocal, queue_event
    from .models import Channel, Message
    from .permissions import channel_access

    urls = extract_urls(content)
    embeds = [e for e in (cached_embed(u) for u in urls) if e]
    with SessionLocal() as db:
        msg = db.get(Message, message_id)
        if msg is None or msg.content != content or msg.suppress_embeds:
            return
        if (msg.embeds or []) == embeds:
            return
        msg.embeds = embeds
        channel = db.get(Channel, msg.channel_id)
        if channel is None:
            return
        access = channel_access(db, channel, msg.author_id)
        queue_event(db, access.audience(), "MESSAGE_UPDATE", {"id": msg.id, "channel_id": msg.channel_id, "embeds": embeds})
        db.commit()
