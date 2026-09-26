"""Runtime configuration, read once from environment variables.

Every setting has a sensible default so `uvicorn tavern.main:app` works out of
the box for local development. In Docker, values come from the `.env` file.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path
from urllib.parse import urlsplit


def _env(name: str, default: str | None = None) -> str | None:
    value = os.environ.get(name)
    if value is None or value.strip() == "":
        return default
    return value.strip()


def _env_bool(name: str, default: bool) -> bool:
    value = _env(name)
    if value is None:
        return default
    return value.lower() in {"1", "true", "yes", "on"}


def _env_list(name: str, default: str) -> tuple[str, ...]:
    raw = _env(name, default) or ""
    return tuple(part.strip() for part in raw.split(",") if part.strip())


def _env_int(name: str, default: int) -> int:
    value = _env(name)
    try:
        return int(value) if value is not None else default
    except ValueError:
        return default


@dataclass(frozen=True)
class Settings:
    data_dir: Path
    public_url: str
    static_dir: Path | None
    smtp_host: str | None
    smtp_port: int
    smtp_user: str | None
    smtp_password: str | None
    smtp_from: str | None
    smtp_security: str
    max_upload_mb: int
    cookie_secure: bool
    trust_proxy_headers: bool
    extra_origins: tuple[str, ...]
    embeds_enabled: bool
    log_level: str
    # Voice spaces (WebRTC)
    stun_urls: tuple[str, ...]
    turn_urls: tuple[str, ...]
    turn_username: str | None
    turn_credential: str | None
    cloudflare_turn_key_id: str | None
    cloudflare_turn_api_token: str | None
    # Jukebox
    jukebox_url_imports: bool
    jukebox_max_track_mb: int
    jukebox_allow_private_urls: bool
    # Spotify links (read song names; audio comes from YouTube)
    spotify_client_id: str | None
    spotify_client_secret: str | None
    # Theater: biggest uploaded video (YouTube videos aren't stored at all)
    theater_max_video_mb: int
    # Game board: biggest uploaded picture (battle maps are often large PNGs)
    board_max_mb: int

    @property
    def db_path(self) -> Path:
        return self.data_dir / "tavern.db"

    @property
    def uploads_dir(self) -> Path:
        return self.data_dir / "uploads"

    @property
    def smtp_enabled(self) -> bool:
        return bool(self.smtp_host and self.smtp_user and self.smtp_password)

    @property
    def public_origin(self) -> str:
        parts = urlsplit(self.public_url)
        return f"{parts.scheme}://{parts.netloc}"

    @property
    def max_upload_bytes(self) -> int:
        return self.max_upload_mb * 1024 * 1024


def load_settings() -> Settings:
    backend_dir = Path(__file__).resolve().parent.parent
    public_url = (_env("PUBLIC_URL", "http://localhost:8080") or "").rstrip("/")

    static = _env("TAVERN_STATIC_DIR")
    if static:
        static_dir: Path | None = Path(static)
    else:
        guess = backend_dir.parent / "frontend" / "dist"
        static_dir = guess if guess.exists() else None

    smtp_user = _env("SMTP_USER")
    # Gmail app passwords are shown with spaces ("abcd efgh ijkl mnop"); the
    # spaces are cosmetic, so strip them to save people a confusing failure.
    smtp_password = _env("SMTP_PASSWORD")
    if smtp_password:
        smtp_password = smtp_password.replace(" ", "")

    return Settings(
        data_dir=Path(_env("TAVERN_DATA_DIR", str(backend_dir / "data")) or "data").resolve(),
        public_url=public_url,
        static_dir=static_dir,
        smtp_host=_env("SMTP_HOST", "smtp.gmail.com" if smtp_user else None),
        smtp_port=_env_int("SMTP_PORT", 587),
        smtp_user=smtp_user,
        smtp_password=smtp_password,
        smtp_from=_env("SMTP_FROM", smtp_user),
        smtp_security=(_env("SMTP_SECURITY", "starttls") or "starttls").lower(),
        max_upload_mb=max(1, _env_int("MAX_UPLOAD_MB", 100)),
        cookie_secure=_env_bool("COOKIE_SECURE", public_url.startswith("https://")),
        trust_proxy_headers=_env_bool("TRUST_PROXY_HEADERS", True),
        extra_origins=tuple(o.strip().rstrip("/") for o in (_env("ALLOWED_ORIGINS", "") or "").split(",") if o.strip()),
        embeds_enabled=_env_bool("LINK_EMBEDS", True),
        log_level=(_env("LOG_LEVEL", "info") or "info").lower(),
        stun_urls=_env_list("STUN_URLS", "stun:stun.cloudflare.com:3478,stun:stun.l.google.com:19302"),
        turn_urls=_env_list("TURN_URLS", ""),
        turn_username=_env("TURN_USERNAME"),
        turn_credential=_env("TURN_CREDENTIAL"),
        cloudflare_turn_key_id=_env("CLOUDFLARE_TURN_KEY_ID"),
        cloudflare_turn_api_token=_env("CLOUDFLARE_TURN_API_TOKEN"),
        jukebox_url_imports=_env_bool("JUKEBOX_URL_IMPORTS", True),
        jukebox_max_track_mb=max(1, _env_int("JUKEBOX_MAX_TRACK_MB", 300)),
        jukebox_allow_private_urls=_env_bool("JUKEBOX_ALLOW_PRIVATE_URLS", False),
        spotify_client_id=_env("SPOTIFY_CLIENT_ID"),
        spotify_client_secret=_env("SPOTIFY_CLIENT_SECRET"),
        theater_max_video_mb=max(1, _env_int("THEATER_MAX_VIDEO_MB", 500)),
        board_max_mb=max(1, _env_int("BOARD_MAX_MB", 64)),
    )


settings = load_settings()
