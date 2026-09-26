"""FastAPI application: API routes, the gateway, uploaded files and the
built frontend (single-page app) all served from one process."""

from __future__ import annotations

import asyncio
import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import FileResponse, JSONResponse
from starlette.datastructures import Headers, MutableHeaders
from starlette.exceptions import HTTPException as StarletteHTTPException

from . import __version__
from .config import settings
from .db import init_db
from .deps import ApiError, origin_allowed
from .files import ensure_dirs
from .gateway import gateway
from .jukebox import jukebox, reset_stuck_tracks
from .theater import reset_stuck_videos, theater
from .routes import auth, cdn, channels, characters, dms, gateway_ws, invites, messages, rolls, search, servers, users
from .routes import boards as board_routes
from .routes import jukebox as jukebox_routes
from .routes import spotify as spotify_routes
from .routes import theater as theater_routes
from .routes import voice as voice_routes

log = logging.getLogger("tavern")

# YouTube's player script (for the theater) and WebAssembly (voice isolation)
# are the only things beyond our own files that may run.
APP_CSP = (
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval' https://www.youtube.com https://s.ytimg.com; style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data: blob: https: http:; media-src 'self' blob: https: mediastream:; font-src 'self' data:; "
    "connect-src 'self' ws: wss:; frame-src 'self' https://www.youtube-nocookie.com https://www.youtube.com; "
    "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"
)
# The theater's screen: a page of ours that holds YouTube's player, so the
# player always gets a real web address as its referrer (YouTube refuses to
# play without one), even inside a picture-in-picture window. Only Tavern
# itself may frame it.
THEATER_FRAME = "/theater-frame.html"
THEATER_FRAME_CSP = (
    "default-src 'none'; script-src https://www.youtube.com https://s.ytimg.com; style-src 'unsafe-inline'; "
    "img-src 'self' data: https:; connect-src 'self' https://www.youtube.com; "
    "frame-src https://www.youtube.com https://www.youtube-nocookie.com; "
    "base-uri 'none'; form-action 'none'; frame-ancestors 'self'"
)
UNSAFE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}


def _body_limit(path: str) -> int:
    """Largest request body worth reading for this path (each route still
    checks every file's own limit as it streams in)."""
    mb = 1024 * 1024
    if path.endswith("/theater/videos"):
        return settings.theater_max_video_mb * mb * 10
    if path.endswith("/jukebox/tracks"):
        return settings.jukebox_max_track_mb * mb * 50
    if path.endswith("/background"):
        return settings.board_max_mb * mb * 2
    if "/board/" in path and path.endswith("/avatar"):
        return 12 * mb
    return settings.max_upload_bytes


class GuardMiddleware:
    """Pure-ASGI middleware: blocks cross-site writes (CSRF), rejects
    oversized uploads early, and adds security headers."""

    def __init__(self, app) -> None:
        self.app = app

    async def __call__(self, scope, receive, send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = Headers(scope=scope)
        path: str = scope["path"]
        if scope["method"] in UNSAFE_METHODS and path.startswith("/api/"):
            origin = headers.get("origin")
            if origin and not origin_allowed(origin, headers.get("host")):
                await JSONResponse({"detail": "Request blocked (bad origin)."}, status_code=403)(scope, receive, send)
                return
            length = headers.get("content-length")
            limit = _body_limit(path)
            if length and length.isdigit() and int(length) > limit + 4 * 1024 * 1024:
                await JSONResponse({"detail": f"That upload is too big. The limit is {limit // (1024 * 1024)} MB."}, status_code=413)(
                    scope, receive, send
                )
                return

        async def send_with_headers(message) -> None:
            if message["type"] == "http.response.start":
                h = MutableHeaders(scope=message)
                h.setdefault("X-Content-Type-Options", "nosniff")
                h.setdefault("Referrer-Policy", "strict-origin-when-cross-origin")
                if h.get("content-type", "").startswith("text/html"):
                    if path == THEATER_FRAME:
                        h["Content-Security-Policy"] = THEATER_FRAME_CSP
                        h["X-Frame-Options"] = "SAMEORIGIN"
                    else:
                        h.setdefault("Content-Security-Policy", APP_CSP)
                        h.setdefault("X-Frame-Options", "DENY")
            await send(message)

        await self.app(scope, receive, send_with_headers)


def _setup_logging() -> None:
    level = getattr(logging, settings.log_level.upper(), logging.INFO)
    logging.basicConfig(level=level, format="%(asctime)s %(levelname)-7s %(name)s: %(message)s")
    logging.getLogger("httpx").setLevel(logging.WARNING)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    ensure_dirs()
    gateway.bind_loop(asyncio.get_running_loop())
    reset_stuck_tracks()
    reset_stuck_videos()
    jukebox.resume_all()
    theater.resume_all()
    auth.init_setup_code()
    log.info("Tavern %s ready at %s", __version__, settings.public_url)
    if not settings.smtp_enabled:
        log.warning("Email isn't configured (SMTP_USER / SMTP_PASSWORD). Password reset links will be printed here instead.")
    yield


def create_app() -> FastAPI:
    _setup_logging()
    app = FastAPI(title="Tavern", version=__version__, lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)
    app.add_middleware(GuardMiddleware)

    @app.exception_handler(ApiError)
    async def api_error(_request: Request, exc: ApiError) -> JSONResponse:
        body: dict = {"detail": exc.message}
        if exc.errors:
            body["errors"] = exc.errors
        if exc.code:
            body["code"] = exc.code
        return JSONResponse(body, status_code=exc.status)

    @app.exception_handler(RequestValidationError)
    async def validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
        errors: dict[str, str] = {}
        for err in exc.errors():
            loc = [str(p) for p in err.get("loc", ()) if p not in ("body", "query", "path", "form")]
            errors[".".join(loc) or "request"] = err.get("msg", "Invalid value")
        return JSONResponse({"detail": "Some of that didn't look right.", "errors": errors}, status_code=400)

    @app.exception_handler(StarletteHTTPException)
    async def http_error(_request: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse({"detail": exc.detail if isinstance(exc.detail, str) else "Error"}, status_code=exc.status_code)

    for module in (auth, users, characters, servers, channels, messages, rolls, search, dms, invites, cdn, gateway_ws, voice_routes, jukebox_routes, theater_routes, spotify_routes, board_routes):
        app.include_router(module.router)
    app.include_router(characters.sheet_router)

    @app.get("/api/health")
    def health() -> dict:
        return {"ok": True, "version": __version__}

    _mount_frontend(app)
    return app


def _mount_frontend(app: FastAPI) -> None:
    static_dir = settings.static_dir
    if static_dir is None or not (static_dir / "index.html").exists():
        log.warning("No built frontend found; only the API is being served.")

        @app.get("/{_path:path}", include_in_schema=False)
        def no_frontend(_path: str) -> JSONResponse:
            return JSONResponse({"detail": "Frontend not built. Run `npm run build` in frontend/."}, status_code=404)

        return

    root = static_dir.resolve()
    index = root / "index.html"

    @app.api_route("/{full_path:path}", methods=["GET", "HEAD"], include_in_schema=False)
    def spa(full_path: str):
        if full_path.startswith(("api/", "cdn/")):
            return JSONResponse({"detail": "Not found"}, status_code=404)
        if full_path:
            candidate = (root / full_path).resolve()
            if candidate.is_file() and root in candidate.parents:
                if full_path.startswith("assets/"):
                    cache = "public, max-age=31536000, immutable"
                elif full_path.startswith("twemoji/"):
                    cache = "public, max-age=604800"
                else:
                    cache = "public, max-age=3600"
                return FileResponse(candidate, headers={"Cache-Control": cache})
        return FileResponse(index, headers={"Cache-Control": "no-cache"})


app = create_app()
