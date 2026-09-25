"""Request helpers: errors, auth dependency, sessions, client IPs, origins."""

from __future__ import annotations

from datetime import timedelta
from urllib.parse import urlsplit

from fastapi import Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from .config import settings
from .db import get_db
from .models import AuthSession, User, utcnow
from .security import hash_token, limiter, new_token

SESSION_COOKIE = "tavern_session"
SESSION_TTL = timedelta(days=30)


class ApiError(Exception):
    """An error the frontend can show. `errors` maps form fields to messages."""

    def __init__(self, status: int, message: str, errors: dict[str, str] | None = None, code: str | None = None):
        super().__init__(message)
        self.status = status
        self.message = message
        self.errors = errors or {}
        self.code = code


def bad_request(message: str, errors: dict[str, str] | None = None) -> ApiError:
    return ApiError(400, message, errors)


def field_errors(errors: dict[str, str]) -> ApiError:
    return ApiError(400, next(iter(errors.values())), errors)


def forbidden(message: str = "You don't have permission to do that.") -> ApiError:
    return ApiError(403, message)


def not_found(what: str = "That") -> ApiError:
    return ApiError(404, f"{what} doesn't exist or you can't see it.")


def rate_limit(key: str, limit: int, window: float, message: str = "You're doing that too fast. Try again in a bit.") -> None:
    if not limiter.hit(key, limit, window):
        raise ApiError(429, message)


def client_ip(request: Request) -> str:
    if settings.trust_proxy_headers:
        cf = request.headers.get("cf-connecting-ip")
        if cf:
            return cf.strip()
        forwarded = request.headers.get("x-forwarded-for")
        if forwarded:
            return forwarded.split(",")[0].strip()
    return request.client.host if request.client else "unknown"


def origin_allowed(origin: str, host: str | None) -> bool:
    origin = origin.rstrip("/")
    if origin == settings.public_origin or origin in settings.extra_origins:
        return True
    netloc = urlsplit(origin).netloc
    return bool(host) and netloc == host


# ---------------------------------------------------------------------------
# Sessions
# ---------------------------------------------------------------------------


def authenticate_token(db: Session, token: str | None) -> tuple[User, AuthSession] | None:
    if not token or len(token) > 128:
        return None
    sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    now = utcnow()
    if sess is None or sess.expires_at <= now:
        return None
    user = db.get(User, sess.user_id)
    if user is None:
        return None
    # Sliding expiry, written at most once an hour.
    if now - sess.last_used_at > timedelta(hours=1):
        sess.last_used_at = now
        sess.expires_at = now + SESSION_TTL
        db.commit()
    return user, sess


def start_session(db: Session, request: Request, response: Response, user: User) -> AuthSession:
    token, token_hash = new_token()
    sess = AuthSession(
        token_hash=token_hash,
        user_id=user.id,
        expires_at=utcnow() + SESSION_TTL,
        user_agent=(request.headers.get("user-agent") or "")[:255],
        ip=client_ip(request),
    )
    db.add(sess)
    response.set_cookie(
        SESSION_COOKIE,
        token,
        max_age=int(SESSION_TTL.total_seconds()),
        httponly=True,
        samesite="lax",
        secure=settings.cookie_secure,
        path="/",
    )
    return sess


def clear_session_cookie(response: Response) -> None:
    response.delete_cookie(SESSION_COOKIE, path="/", httponly=True, samesite="lax", secure=settings.cookie_secure)


def current_user(request: Request, db: Session = Depends(get_db)) -> User:
    result = authenticate_token(db, request.cookies.get(SESSION_COOKIE))
    if result is None:
        raise ApiError(401, "You need to log in again.")
    user, sess = result
    request.state.session_id = sess.id
    return user
