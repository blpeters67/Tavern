"""Characters: the extra identities you can speak as."""

from __future__ import annotations

import json
import re
from typing import Any

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from .. import sheets
from ..db import get_db, queue_event
from ..deps import ApiError, current_user, field_errors, forbidden, not_found, rate_limit
from ..files import delete_files, save_image
from ..models import Character, Member, Server, User, utcnow
from ..permissions import ServerContext
from ..serializers import character_payload
from ..services import publish_character

router = APIRouter(prefix="/api/users/@me/characters", tags=["characters"])
sheet_router = APIRouter(prefix="/api/characters", tags=["characters"])

MAX_CHARACTERS = 100
COLOR_RE = re.compile(r"^#[0-9a-fA-F]{6}$")


def _check_color(raw: str | None) -> str | None:
    if raw is None or not raw.strip():
        return None
    raw = raw.strip()
    if not COLOR_RE.match(raw):
        raise field_errors({"color": "Pick a colour like #a78bfa."})
    return raw.lower()


def _check_visibility(raw: str | None) -> str:
    return raw if raw in ("public", "private") else "public"


def parse_proxy(raw: str | None) -> tuple[str | None, str | None]:
    """Turn a Tupperbox-style tag like `x:text` or `[text]` into (prefix, suffix)."""
    if raw is None or not raw.strip():
        return None, None
    raw = raw.strip()
    lowered = raw.lower()
    if lowered.count("text") != 1:
        raise field_errors({"proxy": 'Write the word "text" where your message goes, like x:text or [text].'})
    idx = lowered.index("text")
    prefix = raw[:idx].rstrip() or None
    suffix = raw[idx + 4 :].lstrip() or None
    if not prefix and not suffix:
        raise field_errors({"proxy": 'Add something before or after "text", like x:text or [text].'})
    if (prefix and len(prefix) > 32) or (suffix and len(suffix) > 32):
        raise field_errors({"proxy": "Keep the tag under 32 characters on each side."})
    return prefix, suffix


def _own_character(db: Session, user: User, character_id: int) -> Character:
    ch = db.get(Character, character_id)
    if ch is None or ch.owner_id != user.id or ch.deleted:
        raise not_found("That character")
    return ch


def _check_name(name: str) -> str:
    name = " ".join(name.split())
    if not 1 <= len(name) <= 80:
        raise field_errors({"name": "Must be between 1 and 80 characters."})
    return name


def _check_proxy_unique(db: Session, user: User, prefix: str | None, suffix: str | None, exclude: int | None = None) -> None:
    if prefix is None and suffix is None:
        return
    q = select(Character).where(
        Character.owner_id == user.id,
        Character.deleted.is_(False),
        Character.proxy_prefix.is_(prefix) if prefix is None else Character.proxy_prefix == prefix,
        Character.proxy_suffix.is_(suffix) if suffix is None else Character.proxy_suffix == suffix,
    )
    clash = db.scalar(q)
    if clash is not None and clash.id != exclude:
        raise field_errors({"proxy": f"{clash.name} already uses that tag."})


@router.get("")
def list_characters(user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    chars = db.scalars(
        select(Character).where(Character.owner_id == user.id, Character.deleted.is_(False)).order_by(Character.position, Character.id)
    )
    return [character_payload(c, private=True) for c in chars]


@router.post("")
def create_character(
    name: str = Form(...),
    proxy: str | None = Form(None),
    color: str | None = Form(None),
    sheet_visibility: str | None = Form(None),
    avatar: UploadFile | None = File(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    rate_limit(f"char-create:{user.id}", 30, 600)
    count = db.scalar(select(func.count()).select_from(Character).where(Character.owner_id == user.id, Character.deleted.is_(False))) or 0
    if count >= MAX_CHARACTERS:
        raise ApiError(400, f"You can have up to {MAX_CHARACTERS} characters.")
    name = _check_name(name)
    prefix, suffix = parse_proxy(proxy)
    _check_proxy_unique(db, user, prefix, suffix)
    position = (db.scalar(select(func.max(Character.position)).where(Character.owner_id == user.id)) or 0) + 1
    ch = Character(
        owner_id=user.id,
        name=name,
        proxy_prefix=prefix,
        proxy_suffix=suffix,
        position=position,
        color=_check_color(color),
        sheet_visibility=_check_visibility(sheet_visibility),
    )
    if avatar is not None and avatar.filename:
        ch.avatar, _ = save_image(avatar, "avatars", square=True, size=256)
    db.add(ch)
    db.flush()
    publish_character(db, ch, "CHARACTER_CREATE")
    db.commit()
    return character_payload(ch, private=True)


@router.patch("/{character_id}")
def update_character(
    character_id: int,
    name: str | None = Form(None),
    proxy: str | None = Form(None),
    avatar: UploadFile | None = File(None),
    remove_avatar: bool = Form(False),
    clear_proxy: bool = Form(False),
    color: str | None = Form(None),
    clear_color: bool = Form(False),
    sheet_visibility: str | None = Form(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    rate_limit(f"char-edit:{user.id}", 60, 600)
    ch = _own_character(db, user, character_id)
    old_avatar = None
    if name is not None:
        ch.name = _check_name(name)
    if clear_color:
        ch.color = None
    elif color is not None:
        ch.color = _check_color(color)
    if sheet_visibility is not None:
        ch.sheet_visibility = _check_visibility(sheet_visibility)
    if clear_proxy:
        ch.proxy_prefix = ch.proxy_suffix = None
    elif proxy is not None:
        prefix, suffix = parse_proxy(proxy)
        _check_proxy_unique(db, user, prefix, suffix, exclude=ch.id)
        ch.proxy_prefix, ch.proxy_suffix = prefix, suffix
    if avatar is not None and avatar.filename:
        old_avatar = ch.avatar
        ch.avatar, _ = save_image(avatar, "avatars", square=True, size=256)
    elif remove_avatar:
        old_avatar = ch.avatar
        ch.avatar = None
    publish_character(db, ch, "CHARACTER_UPDATE")
    db.commit()
    if old_avatar and old_avatar != ch.avatar:
        # Old messages point at the character, not the file, so this is safe.
        delete_files("avatars", [old_avatar])
    return character_payload(ch, private=True)


@router.delete("/{character_id}")
def delete_character(character_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ch = _own_character(db, user, character_id)
    # Soft delete: past messages keep showing the name and picture.
    ch.deleted = True
    ch.proxy_prefix = ch.proxy_suffix = None
    publish_character(db, ch, "CHARACTER_UPDATE")
    db.commit()
    return {"ok": True}


class PositionIn(BaseModel):
    id: int
    position: int


@router.patch("")
def reorder_characters(body: list[PositionIn], user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    chars = {c.id: c for c in db.scalars(select(Character).where(Character.owner_id == user.id, Character.deleted.is_(False)))}
    for item in body:
        ch = chars.get(item.id)
        if ch is not None and ch.position != item.position:
            ch.position = item.position
            publish_character(db, ch, "CHARACTER_UPDATE")
    db.commit()
    return [character_payload(c, private=True) for c in sorted(chars.values(), key=lambda c: (c.position, c.id))]


# ---------------------------------------------------------------------------
# Character sheets (readable by others, editable by the owner and DMs)
# ---------------------------------------------------------------------------


def _shared_servers(db: Session, a: int, b: int) -> list[Server]:
    mine = select(Member.server_id).where(Member.user_id == a)
    ids = list(db.scalars(select(Member.server_id).where(Member.user_id == b, Member.server_id.in_(mine))))
    return list(db.scalars(select(Server).where(Server.id.in_(ids)))) if ids else []


def sheet_access(db: Session, viewer_id: int, ch: Character) -> tuple[bool, bool]:
    """(can view, can edit) for one character sheet."""
    if ch.owner_id == viewer_id:
        return True, not ch.deleted
    shared = _shared_servers(db, viewer_id, ch.owner_id)
    if not shared:
        return False, False
    is_dm = any(ServerContext.load(db, srv).is_dm(viewer_id) for srv in shared)
    can_view = is_dm or (ch.sheet_visibility or "public") == "public"
    return can_view, is_dm and not ch.deleted


def sheet_audience(db: Session, ch: Character) -> set[int]:
    """Everyone who should get live sheet updates."""
    audience = {ch.owner_id}
    server_ids = list(db.scalars(select(Member.server_id).where(Member.user_id == ch.owner_id)))
    for srv in db.scalars(select(Server).where(Server.id.in_(server_ids))) if server_ids else []:
        ctx = ServerContext.load(db, srv)
        if (ch.sheet_visibility or "public") == "public":
            audience |= set(ctx.member_ids)
        else:
            audience |= ctx.dm_ids()
    return audience


def _load_viewable(db: Session, user: User, character_id: int) -> tuple[Character, bool]:
    ch = db.get(Character, character_id)
    if ch is None:
        raise not_found("That character")
    can_view, can_edit = sheet_access(db, user.id, ch)
    if not can_view:
        raise not_found("That character sheet")
    return ch, can_edit


@sheet_router.get("/{character_id}/sheet")
def get_sheet(character_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ch, can_edit = _load_viewable(db, user, character_id)
    sheet = sheets.clean(ch.sheet) if ch.sheet else sheets.default_sheet()
    return {"character_id": ch.id, "sheet": sheet, "can_edit": can_edit}


class SheetPatch(BaseModel):
    patch: dict[str, Any]


@sheet_router.patch("/{character_id}/sheet")
def patch_sheet(character_id: int, body: SheetPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ch, can_edit = _load_viewable(db, user, character_id)
    if not can_edit:
        raise forbidden("Only the owner and Dungeon Masters can edit this sheet.")
    rate_limit(f"sheet-edit:{user.id}", 240, 60)
    if len(json.dumps(body.patch)) > sheets.MAX_SHEET_BYTES:
        raise ApiError(413, "That change is too big.")
    old = sheets.clean(ch.sheet) if ch.sheet else sheets.default_sheet()
    patch = dict(body.patch)
    patch.pop("rev", None)
    patch.pop("v", None)
    new = sheets.clean(sheets.merge_patch(old, patch))
    new["rev"] = int(old.get("rev", 0)) + 1
    if len(json.dumps(new)) > sheets.MAX_SHEET_BYTES:
        raise ApiError(413, "That sheet is too big. Trim some notes or spell descriptions.")
    change = sheets.make_patch(old, new)
    ch.sheet = new
    ch.sheet_updated_at = utcnow()
    queue_event(
        db,
        sheet_audience(db, ch),
        "CHARACTER_SHEET_UPDATE",
        {"character_id": ch.id, "patch": change, "rev": new["rev"], "updated_by": user.id},
    )
    publish_character(db, ch, "CHARACTER_UPDATE")
    db.commit()
    return {"character_id": ch.id, "sheet": new, "can_edit": True}
