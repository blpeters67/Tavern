"""Registration (invite-gated), login, logout and password resets."""

from __future__ import annotations

import logging
import re
import secrets
from datetime import timedelta

from fastapi import APIRouter, BackgroundTasks, Depends, Request, Response
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import SessionLocal, get_db
from ..deps import (
    SESSION_COOKIE,
    ApiError,
    clear_session_cookie,
    client_ip,
    field_errors,
    rate_limit,
    start_session,
)
from ..gateway import gateway
from ..mailer import send_password_reset
from ..models import AuthSession, PasswordReset, Server, User, utcnow
from ..security import hash_password, hash_token, new_token, password_needs_rehash, verify_password
from ..serializers import me_payload
from ..services import join_server
from .invites import extract_invite_code, find_invite

log = logging.getLogger("tavern.auth")
router = APIRouter(prefix="/api/auth", tags=["auth"])

EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
USERNAME_RE = re.compile(r"^(?!.*\.\.)[a-z0-9_.]{2,32}$")
RESET_TTL = timedelta(hours=1)

# One-time code that lets the very first account be created without an
# invite. Printed to the server log on startup while no accounts exist.
_setup: dict[str, str | None] = {"code": None}


def init_setup_code() -> None:
    with SessionLocal() as db:
        if (db.scalar(select(func.count(User.id))) or 0) > 0:
            _setup["code"] = None
            return
    code = secrets.token_hex(4).upper()
    _setup["code"] = code
    bar = "=" * 64
    log.warning(
        "\n%s\n  Tavern has no accounts yet.\n  Create the owner account here:\n    %s/register?setup=%s\n  (setup code: %s)\n%s",
        bar,
        settings.public_url,
        code,
        code,
        bar,
    )


def normalize_email(email: str) -> str:
    return email.strip().lower()


def validate_username(username: str) -> str | None:
    if not 2 <= len(username) <= 32:
        return "Must be between 2 and 32 characters."
    if not USERNAME_RE.match(username):
        return "Please only use numbers, lowercase letters, underscore _ and period . (no two periods in a row)."
    return None


def validate_password(password: str) -> str | None:
    if len(password) < 8:
        return "Must be at least 8 characters long."
    if len(password) > 256:
        return "Must be 256 characters or fewer."
    return None


# ---------------------------------------------------------------------------


@router.get("/status")
def auth_status(db: Session = Depends(get_db)) -> dict:
    no_users = (db.scalar(select(func.count(User.id))) or 0) == 0
    return {"setup_required": no_users, "email_enabled": settings.smtp_enabled}


class RegisterIn(BaseModel):
    email: str = Field(default="", max_length=254)
    username: str = Field(default="", max_length=64)
    display_name: str | None = Field(default=None, max_length=64)
    password: str = Field(default="", max_length=512)
    invite: str | None = Field(default=None, max_length=300)


@router.post("/register")
def register(body: RegisterIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    rate_limit(f"register:{client_ip(request)}", 10, 3600)
    errors: dict[str, str] = {}

    email = normalize_email(body.email)
    username = body.username.strip().lower()
    display_name = (body.display_name or "").strip() or None

    if not EMAIL_RE.match(email):
        errors["email"] = "Not a well formed email address."
    if err := validate_username(username):
        errors["username"] = err
    if display_name and len(display_name) > 32:
        errors["display_name"] = "Must be 32 characters or fewer."
    if err := validate_password(body.password):
        errors["password"] = err

    first_user = (db.scalar(select(func.count(User.id))) or 0) == 0
    invite = None
    code = extract_invite_code(body.invite or "")
    if first_user:
        expected = _setup["code"]
        if not expected or not secrets.compare_digest(code.upper(), expected):
            errors["invite"] = "That setup code isn't right. Check the server log for the current code."
    else:
        invite = find_invite(db, code) if code else None
        if invite is None:
            errors["invite"] = "You need a valid invite link to create an account. Ask a friend for one."

    if "email" not in errors and db.scalar(select(User.id).where(User.email == email)):
        errors["email"] = "Email is already registered."
    if "username" not in errors and db.scalar(select(User.id).where(User.username == username)):
        errors["username"] = "Username is unavailable. Try adding numbers, letters, underscores _ , or periods."
    if errors:
        raise field_errors(errors)

    user = User(
        email=email,
        username=username,
        display_name=display_name,
        password_hash=hash_password(body.password),
        is_admin=first_user,
        settings={},
    )
    db.add(user)
    db.flush()

    if first_user:
        _setup["code"] = None
    elif invite is not None:
        server = db.get(Server, invite.server_id)
        if server is not None:
            join_server(db, user, server, invite)

    start_session(db, request, response, user)
    db.commit()
    return {"user": me_payload(user), "server_id": invite.server_id if invite else None}


class LoginIn(BaseModel):
    login: str = Field(default="", max_length=254)
    password: str = Field(default="", max_length=512)


@router.post("/login")
def login(body: LoginIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    ip = client_ip(request)
    ident = body.login.strip().lower()
    rate_limit(f"login-ip:{ip}", 30, 300)
    rate_limit(f"login:{ip}:{ident}", 8, 300, "Too many login attempts. Wait a few minutes and try again.")

    if not ident:
        raise field_errors({"login": "This field is required."})
    if not body.password:
        raise field_errors({"password": "This field is required."})

    column = User.email if "@" in ident else User.username
    user = db.scalar(select(User).where(column == ident))
    if user is None or not verify_password(user.password_hash, body.password):
        msg = "Login or password is invalid."
        raise field_errors({"login": msg, "password": msg})

    if password_needs_rehash(user.password_hash):
        user.password_hash = hash_password(body.password)
    start_session(db, request, response, user)
    db.commit()
    return {"user": me_payload(user)}


@router.post("/logout")
def logout(request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    token = request.cookies.get(SESSION_COOKIE)
    if token:
        sess = db.scalar(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
        if sess is not None:
            gateway.disconnect_sessions([sess.id], 4004, "Logged out")
            db.delete(sess)
            db.commit()
    clear_session_cookie(response)
    return {"ok": True}


class ForgotIn(BaseModel):
    login: str = Field(default="", max_length=254)


@router.post("/forgot")
def forgot_password(body: ForgotIn, request: Request, background: BackgroundTasks, db: Session = Depends(get_db)) -> dict:
    ident = body.login.strip().lower()
    if not ident:
        raise field_errors({"login": "Enter your email or username first."})
    rate_limit(f"forgot-ip:{client_ip(request)}", 6, 900)
    rate_limit(f"forgot:{ident}", 3, 900, "We already sent a few reset emails. Check your inbox and spam folder.")

    column = User.email if "@" in ident else User.username
    user = db.scalar(select(User).where(column == ident))
    # Same response either way so nobody can probe for accounts.
    if user is not None:
        token, token_hash = new_token()
        db.add(PasswordReset(token_hash=token_hash, user_id=user.id, expires_at=utcnow() + RESET_TTL))
        db.commit()
        link = f"{settings.public_url}/reset-password#token={token}"
        background.add_task(send_password_reset, user.email, user.display_name or user.username, link)
    return {"ok": True, "email_enabled": settings.smtp_enabled}


def _valid_reset(db: Session, token: str) -> PasswordReset | None:
    if not token or len(token) > 128:
        return None
    reset = db.scalar(select(PasswordReset).where(PasswordReset.token_hash == hash_token(token)))
    if reset is None or reset.used_at is not None or reset.expires_at <= utcnow():
        return None
    return reset


class ResetCheckIn(BaseModel):
    token: str = Field(default="", max_length=128)


@router.post("/reset/check")
def check_reset(body: ResetCheckIn, request: Request, db: Session = Depends(get_db)) -> dict:
    rate_limit(f"reset-check:{client_ip(request)}", 30, 900)
    return {"valid": _valid_reset(db, body.token) is not None}


class ResetIn(BaseModel):
    token: str = Field(default="", max_length=128)
    password: str = Field(default="", max_length=512)


@router.post("/reset")
def reset_password(body: ResetIn, request: Request, response: Response, db: Session = Depends(get_db)) -> dict:
    rate_limit(f"reset:{client_ip(request)}", 10, 900)
    reset = _valid_reset(db, body.token)
    if reset is None:
        raise ApiError(
            400, "This password reset link is invalid or has expired. Request a new one from the login page.", code="invalid_token"
        )
    if err := validate_password(body.password):
        raise field_errors({"password": err})
    user = db.get(User, reset.user_id)
    if user is None:
        raise ApiError(400, "Account not found.")

    user.password_hash = hash_password(body.password)
    reset.used_at = utcnow()
    # A reset logs out every other device and burns any other reset links.
    old_sessions = list(db.scalars(select(AuthSession.id).where(AuthSession.user_id == user.id)))
    db.execute(delete(AuthSession).where(AuthSession.user_id == user.id))
    db.execute(delete(PasswordReset).where(PasswordReset.user_id == user.id, PasswordReset.id != reset.id))
    gateway.disconnect_sessions(old_sessions, 4004, "Password changed")
    start_session(db, request, response, user)
    db.commit()
    return {"user": me_payload(user)}
