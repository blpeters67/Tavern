"""Spotify links for the jukebox.

Spotify doesn't hand out audio, so a Spotify link is read for its song names
(title, artists, album, length, cover) with the Web API, and each song's audio
is then found on YouTube and downloaded with yt-dlp (what spotDL does).

Needs SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET (a free app at
developer.spotify.com). Songs and albums work with just that. Spotify only
lets apps read playlists that the signed-in person owns or collaborates on, so
for playlists each DJ connects their own Spotify account once.
"""

from __future__ import annotations

import base64
import logging
import re
import secrets
import threading
import time
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlencode

import httpx

from .config import settings

log = logging.getLogger("tavern.spotify")

API = "https://api.spotify.com/v1"
ACCOUNTS = "https://accounts.spotify.com"
SCOPES = "playlist-read-private playlist-read-collaborative"
MAX_SONGS = 200

LINK_RE = re.compile(
    r"^(?:https?://open\.spotify\.com/(?:intl-[a-z]{2}(?:-[a-z]{2})?/)?(?:embed/)?|spotify:)(track|album|playlist)[/:]([A-Za-z0-9]{22})",
    re.IGNORECASE,
)


class SpotifyError(Exception):
    """Something to tell the DJ."""


class ConnectionExpired(SpotifyError):
    """A DJ's Spotify sign-in can't be renewed any more (Spotify ends them after
    a while, 180 days by default, or when access is removed)."""


@dataclass
class Song:
    title: str
    artists: list[str]
    album: str | None
    duration_ms: int
    cover: str | None
    url: str  # the song on Spotify (used to spot duplicates)
    isrc: str | None = None

    @property
    def artist(self) -> str:
        return ", ".join(self.artists)


@dataclass
class Collection:
    kind: str
    name: str
    songs: list[Song] = field(default_factory=list)


def configured() -> bool:
    return bool(settings.spotify_client_id and settings.spotify_client_secret)


def parse_link(url: str) -> tuple[str, str] | None:
    """("track" | "album" | "playlist", id) for a Spotify link, else None."""
    m = LINK_RE.match(url.strip())
    return (m.group(1).lower(), m.group(2)) if m else None


def redirect_uri() -> str:
    return f"{settings.public_url}/api/spotify/callback"


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------

_app_token: dict[str, Any] = {"token": None, "expires": 0.0}
_app_lock = threading.Lock()


def _basic() -> str:
    raw = f"{settings.spotify_client_id}:{settings.spotify_client_secret}".encode()
    return "Basic " + base64.b64encode(raw).decode()


def _token_request(data: dict[str, str]) -> dict[str, Any]:
    try:
        resp = httpx.post(f"{ACCOUNTS}/api/token", data=data, headers={"Authorization": _basic()}, timeout=15)
    except httpx.HTTPError as exc:
        raise SpotifyError(f"Couldn't reach Spotify ({exc.__class__.__name__}).") from None
    if resp.status_code in (400, 401):
        error = detail = ""
        try:
            body = resp.json()
            if isinstance(body, dict):
                error = str(body.get("error") or "")
                detail = str(body.get("error_description") or "")
        except ValueError:
            pass
        if error == "invalid_client" or "invalid_client" in resp.text or "Invalid client" in detail:
            raise SpotifyError("Spotify didn't accept the API key. Check SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET.")
        if error == "invalid_grant" and data.get("grant_type") == "refresh_token":
            raise ConnectionExpired("Your Spotify connection expired. Connect Spotify again.")
        raise SpotifyError(f"Spotify said no: {detail or error or resp.status_code}.")
    resp.raise_for_status()
    return resp.json()


def app_token() -> str:
    """A client-credentials token (no Spotify user), cached until it expires."""
    with _app_lock:
        if _app_token["token"] and time.time() < _app_token["expires"] - 60:
            return _app_token["token"]
        data = _token_request({"grant_type": "client_credentials"})
        _app_token["token"] = data["access_token"]
        _app_token["expires"] = time.time() + int(data.get("expires_in", 3600))
        return _app_token["token"]


# Sign-in "state" values waiting for Spotify's callback: state -> (user id, expiry)
_pending_states: dict[str, tuple[int, float]] = {}


def authorize_url(user_id: int) -> str:
    now = time.time()
    for key in [k for k, (_, exp) in _pending_states.items() if exp < now]:
        _pending_states.pop(key, None)
    state = secrets.token_urlsafe(24)
    _pending_states[state] = (user_id, now + 600)
    query = urlencode(
        {
            "client_id": settings.spotify_client_id,
            "response_type": "code",
            "redirect_uri": redirect_uri(),
            "scope": SCOPES,
            "state": state,
        }
    )
    return f"{ACCOUNTS}/authorize?{query}"


def take_state(state: str) -> int | None:
    entry = _pending_states.pop(state, None)
    if entry is None or entry[1] < time.time():
        return None
    return entry[0]


def exchange_code(code: str) -> dict[str, Any]:
    """Trade the callback's code for tokens: {access, refresh, expires}."""
    data = _token_request({"grant_type": "authorization_code", "code": code, "redirect_uri": redirect_uri()})
    return {
        "access": data["access_token"],
        "refresh": data.get("refresh_token"),
        "expires": time.time() + int(data.get("expires_in", 3600)),
    }


def fresh_user_token(auth: dict[str, Any]) -> tuple[str, dict[str, Any] | None]:
    """A usable token for a connected account, plus updated auth to save (or None)."""
    if auth.get("access") and time.time() < float(auth.get("expires", 0)) - 60:
        return auth["access"], None
    if not auth.get("refresh"):
        raise ConnectionExpired("Your Spotify connection expired. Connect Spotify again.")
    data = _token_request({"grant_type": "refresh_token", "refresh_token": auth["refresh"]})
    updated = {
        "access": data["access_token"],
        "refresh": data.get("refresh_token") or auth["refresh"],
        "expires": time.time() + int(data.get("expires_in", 3600)),
        "name": auth.get("name"),
    }
    return updated["access"], updated


# ---------------------------------------------------------------------------
# Reading songs
# ---------------------------------------------------------------------------


def _get(url: str, token: str) -> dict[str, Any]:
    if not url.startswith("http"):
        url = API + url
    for attempt in range(3):
        try:
            resp = httpx.get(url, headers={"Authorization": f"Bearer {token}"}, timeout=20)
        except httpx.HTTPError as exc:
            raise SpotifyError(f"Couldn't reach Spotify ({exc.__class__.__name__}).") from None
        if resp.status_code == 429 and attempt < 2:
            time.sleep(min(10, int(resp.headers.get("Retry-After", "2") or 2)))
            continue
        break
    if resp.status_code == 404:
        raise SpotifyError("Spotify couldn't find that. Is the link right, and is it public?")
    if resp.status_code == 401:
        raise SpotifyError("Spotify didn't accept the sign-in. Try connecting Spotify again.")
    if resp.status_code == 403:
        raise SpotifyError(
            "Spotify refused. Spotify only lets developer apps work while the account that made the API key has Premium."
        )
    if resp.status_code == 429:
        raise SpotifyError("Spotify says we're asking too often. Try again in a minute.")
    if resp.status_code >= 400:
        raise SpotifyError(f"Spotify had a problem ({resp.status_code}).")
    return resp.json()


def _song(t: dict[str, Any], album: dict[str, Any] | None = None) -> Song | None:
    if not t or t.get("type") not in (None, "track") or t.get("is_local"):
        return None
    alb = t.get("album") or album or {}
    images = alb.get("images") or []
    cover = max(images, key=lambda i: (i.get("width") or 0) * (i.get("height") or 0)).get("url") if images else None
    tid = t.get("id")
    url = (t.get("external_urls") or {}).get("spotify") or (f"https://open.spotify.com/track/{tid}" if tid else "")
    name = (t.get("name") or "").strip()
    if not name or not url:
        return None
    return Song(
        title=name,
        artists=[a.get("name") for a in t.get("artists") or [] if a.get("name")],
        album=alb.get("name"),
        duration_ms=int(t.get("duration_ms") or 0),
        cover=cover,
        url=url,
        isrc=(t.get("external_ids") or {}).get("isrc"),
    )


def _pages(first: dict[str, Any] | None, token: str, key: str) -> list[dict[str, Any]]:
    """Walk a paging object; `key` is the per-entry field holding the track, if any."""
    out: list[dict[str, Any]] = []
    page = first
    while page and len(out) < MAX_SONGS:
        for entry in page.get("items") or []:
            track = entry.get(key) or entry.get("track") if key else entry
            if track:
                out.append(track)
        nxt = page.get("next")
        page = _get(nxt, token) if nxt and len(out) < MAX_SONGS else None
    return out[:MAX_SONGS]


def read_link(kind: str, spotify_id: str, user_token: str | None = None) -> Collection:
    """Songs behind a Spotify track/album/playlist link."""
    if kind == "track":
        t = _get(f"/tracks/{spotify_id}", user_token or app_token())
        song = _song(t)
        if song is None:
            raise SpotifyError("That Spotify song can't be imported.")
        return Collection("track", song.title, [song])
    if kind == "album":
        token = user_token or app_token()
        alb = _get(f"/albums/{spotify_id}", token)
        tracks = _pages(alb.get("tracks"), token, "")
        songs = [s for s in (_song(t, alb) for t in tracks) if s]
        return Collection("album", alb.get("name") or "Album", songs)
    if kind == "playlist":
        token = user_token or app_token()
        pl = _get(f"/playlists/{spotify_id}", token)
        # Spotify renamed "tracks"/"track" to "items"/"item" in 2026; accept both.
        page = pl.get("items") if isinstance(pl.get("items"), dict) else pl.get("tracks")
        if not page or not page.get("items"):
            if user_token:
                raise SpotifyError(
                    "Spotify only shares playlists you own or collaborate on. Add this one to your library as your own playlist, then try again."
                )
            raise SpotifyError("Spotify only shares playlists with the person who owns them. Connect your Spotify account (button below), then try again.")
        tracks = _pages(page, token, "item")
        songs = [s for s in (_song(t) for t in tracks) if s]
        return Collection("playlist", pl.get("name") or "Playlist", songs)
    raise SpotifyError("That kind of Spotify link isn't supported.")


def account_name(token: str) -> str | None:
    try:
        me = _get("/me", token)
    except SpotifyError:
        return None
    return me.get("display_name") or me.get("id")


# ---------------------------------------------------------------------------
# Matching a song to a YouTube video
# ---------------------------------------------------------------------------

_JUNK = ("live", "cover", "remix", "karaoke", "instrumental", "slowed", "sped up", "reverb", "8d", "nightcore", "reaction", "tutorial", "lesson", "1 hour", "10 hours", "loop")


def _norm(text: str | None) -> str:
    text = (text or "").lower()
    text = re.sub(r"\((?:feat|ft|with)\.?[^)]*\)|\[(?:feat|ft|with)\.?[^\]]*\]", " ", text)
    text = re.sub(r"[^\w\s]", " ", text)
    return " ".join(text.split())


def score(song: Song, cand: dict[str, Any]) -> float:
    """How likely a search result is this song (higher is better)."""
    title = _norm(cand.get("title"))
    channel = _norm(cand.get("channel"))
    want = _norm(song.title)
    artists = [_norm(a) for a in song.artists if a]
    s = 0.0
    if want and want in title:
        s += 40
    else:
        words = [w for w in want.split() if len(w) > 1]
        if words:
            s += 30 * sum(w in title for w in words) / len(words)
    if artists:
        if any(a and (a in title or a in channel) for a in artists):
            s += 25
        if artists[0] and channel.startswith(artists[0]):
            s += 10
    if channel.endswith(" topic"):
        s += 12  # YouTube's auto-generated "Artist - Topic" uploads are the studio audio
    if "official audio" in title or "provided to youtube" in title:
        s += 6
    if "official video" in title or "music video" in title:
        s -= 3  # videos often have intros/outros
    for junk in _JUNK:
        if junk in title and junk not in want:
            s -= 18
    dur = cand.get("duration_ms")
    if dur and song.duration_ms:
        off = abs(dur - song.duration_ms) / 1000
        if off <= 3:
            s += 25
        elif off <= 8:
            s += 15
        elif off <= 20:
            s += 3
        else:
            s -= min(40, off / 3)
    return s


def best_match(song: Song, search) -> str | None:
    """Pick the YouTube video for `song`. `search(query) -> results` (see jukebox.youtube_search)."""
    queries = [f"{song.artists[0]} - {song.title}" if song.artists else song.title]
    if song.artists:
        queries.append(f"{song.title} {song.artists[0]} audio")
    best: tuple[float, str] | None = None
    for q in queries:
        try:
            results = search(q)
        except Exception as exc:  # noqa: BLE001
            log.info("YouTube search for %r failed: %s", q, exc)
            continue
        for cand in results:
            sc = score(song, cand)
            if best is None or sc > best[0]:
                best = (sc, cand["url"])
        if best and best[0] >= 75:
            break  # confident enough
    if best is None or best[0] < 20:
        return None
    return best[1]
