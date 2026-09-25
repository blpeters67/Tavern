"""Your own account: profile, avatar, password, status and app settings."""

from __future__ import annotations

from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Request, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import get_db, queue_event
from ..deps import ApiError, current_user, field_errors, not_found, rate_limit
from ..files import delete_files, save_image
from ..gateway import gateway
from ..models import AuthSession, User
from ..security import hash_password, verify_password
from ..serializers import DEFAULT_SETTINGS, me_payload, merged_settings, user_payload
from ..services import publish_user_update, related_user_ids
from .auth import EMAIL_RE, normalize_email, validate_password, validate_username

router = APIRouter(prefix="/api/users", tags=["users"])


@router.get("/@me")
def get_me(user: User = Depends(current_user)) -> dict:
    return me_payload(user)


class MePatch(BaseModel):
    display_name: str | None = Field(default=None, max_length=64)
    username: str | None = Field(default=None, max_length=64)
    email: str | None = Field(default=None, max_length=254)
    password: str | None = Field(default=None, max_length=512)
    new_password: str | None = Field(default=None, max_length=512)
    banner_color: int | None = Field(default=None, ge=0, le=0xFFFFFF)
    about: str | None = Field(default=None, max_length=400)
    status: Literal["online", "idle", "dnd", "invisible"] | None = None
    custom_status: str | None = Field(default=None, max_length=200)


@router.patch("/@me")
def update_me(body: MePatch, request: Request, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    fields = body.model_fields_set
    errors: dict[str, str] = {}
    sensitive = {"username", "email", "new_password"} & fields
    if sensitive:
        rate_limit(f"account-edit:{user.id}", 10, 900)
        if not body.password or not verify_password(user.password_hash, body.password):
            raise field_errors({"password": "Password does not match."})

    presence_changed = False
    if "display_name" in fields:
        name = (body.display_name or "").strip() or None
        if name and len(name) > 32:
            errors["display_name"] = "Must be 32 characters or fewer."
        else:
            user.display_name = name
    if "username" in fields and body.username is not None:
        username = body.username.strip().lower()
        if err := validate_username(username):
            errors["username"] = err
        elif username != user.username and db.scalar(select(User.id).where(User.username == username)):
            errors["username"] = "Username is unavailable. Try adding numbers, letters, underscores _ , or periods."
        else:
            user.username = username
    if "email" in fields and body.email is not None:
        email = normalize_email(body.email)
        if not EMAIL_RE.match(email):
            errors["email"] = "Not a well formed email address."
        elif email != user.email and db.scalar(select(User.id).where(User.email == email)):
            errors["email"] = "Email is already registered."
        else:
            user.email = email
    if "new_password" in fields and body.new_password is not None:
        if err := validate_password(body.new_password):
            errors["new_password"] = err
        else:
            user.password_hash = hash_password(body.new_password)
            # Log out every other device.
            current = getattr(request.state, "session_id", None)
            others = list(db.scalars(select(AuthSession.id).where(AuthSession.user_id == user.id, AuthSession.id != current)))
            db.execute(delete(AuthSession).where(AuthSession.id.in_(others)))
            gateway.disconnect_sessions(others, 4004, "Password changed")
    if "banner_color" in fields:
        user.banner_color = body.banner_color
    if "about" in fields:
        user.about = (body.about or "").strip()[:190] or None
    if "custom_status" in fields:
        user.custom_status = " ".join((body.custom_status or "").split())[:128] or None
    if "status" in fields and body.status and body.status != user.status:
        user.status = body.status
        presence_changed = True

    if errors:
        db.rollback()
        raise field_errors(errors)

    publish_user_update(db, user)
    if presence_changed:
        queue_event(
            db, related_user_ids(db, user.id) - {user.id}, "PRESENCE_UPDATE", {"user_id": user.id, "status": user_payload(user)["status"]}
        )
    db.commit()
    return me_payload(user)


@router.put("/@me/avatar")
def set_avatar(file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    rate_limit(f"avatar:{user.id}", 20, 600)
    name, _animated = save_image(file, "avatars", square=True, size=256)
    old = user.avatar
    user.avatar = name
    publish_user_update(db, user)
    db.commit()
    delete_files("avatars", [old])
    return me_payload(user)


@router.delete("/@me/avatar")
def remove_avatar(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    old = user.avatar
    user.avatar = None
    publish_user_update(db, user)
    db.commit()
    delete_files("avatars", [old])
    return me_payload(user)


@router.patch("/@me/settings")
def update_settings(body: dict[str, Any], user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    current = merged_settings(user)
    for key, value in body.items():
        if key not in DEFAULT_SETTINGS:
            raise ApiError(400, f"Unknown setting: {key}")
        if not isinstance(value, type(DEFAULT_SETTINGS[key])):
            raise ApiError(400, f"Bad value for {key}")
        current[key] = value
    user.settings = current
    queue_event(db, [user.id], "ME_UPDATE", me_payload(user))
    db.commit()
    return current


@router.get("/{user_id}")
def get_user(user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    if user_id not in related_user_ids(db, user.id):
        raise not_found("That user")
    other = db.get(User, user_id)
    if other is None:
        raise not_found("That user")
    return user_payload(other)
