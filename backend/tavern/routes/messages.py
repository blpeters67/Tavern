"""Messages: history, sending (with uploads and characters), edits,
deletes, reactions and pins."""

from __future__ import annotations

import json
import re

from fastapi import APIRouter, BackgroundTasks, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field, ValidationError
from sqlalchemy import delete, func, or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db, queue_event
from ..deps import bad_request, current_user, forbidden, not_found, rate_limit
from ..embeds import extract_urls, unfurl_message
from ..files import delete_files, save_attachment
from ..models import Attachment, Character, Emoji, Message, MessageType, Reaction, User, utcnow
from ..permissions import P
from ..serializers import iso, message_payload, messages_payload
from ..services import can_see_message, create_message, load_channel, load_message, message_audience, refresh_mentions

router = APIRouter(prefix="/api/channels", tags=["messages"])

MAX_CONTENT = 4000
MAX_FILES = 10
MAX_REACTION_KINDS = 20
MAX_PINS = 250
CUSTOM_EMOJI_RE = re.compile(r"^(?:a:)?([A-Za-z0-9_]{2,32}):(\d+)$")


@router.get("/{channel_id}/messages")
def list_messages(
    channel_id: int,
    before: int | None = None,
    after: int | None = None,
    around: int | None = None,
    limit: int = 50,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> list[dict]:
    access = load_channel(db, channel_id, user.id)
    if not access.has(P.READ_MESSAGE_HISTORY):
        return []
    limit = max(1, min(100, limit))
    base = select(Message).where(Message.channel_id == channel_id)
    if access.ctx is not None and not access.ctx.is_dm(user.id):
        base = base.where(or_(Message.dm_only.is_(False), Message.author_id == user.id))
    if around is not None:
        half = limit // 2
        older = list(db.scalars(base.where(Message.id < around).order_by(Message.id.desc()).limit(half)))
        newer = list(db.scalars(base.where(Message.id >= around).order_by(Message.id.asc()).limit(limit - half)))
        msgs = list(reversed(older)) + newer
    elif after is not None:
        msgs = list(db.scalars(base.where(Message.id > after).order_by(Message.id.asc()).limit(limit)))
    else:
        q = base.where(Message.id < before) if before is not None else base
        msgs = list(reversed(list(db.scalars(q.order_by(Message.id.desc()).limit(limit)))))
    return messages_payload(db, msgs)


class MessageIn(BaseModel):
    content: str = Field(default="", max_length=MAX_CONTENT + 200)
    character_id: int | None = None
    narrator: bool = False
    book: bool = False
    reply_to_id: int | None = None
    mention_reply: bool = True
    nonce: str | None = Field(default=None, max_length=64)


def _clean_content(content: str) -> str:
    # Trim surrounding blank lines/spaces but keep indentation inside.
    content = content.replace("\r\n", "\n").strip()
    if len(content) > MAX_CONTENT:
        raise bad_request(f"Messages can be up to {MAX_CONTENT} characters long.")
    return content


@router.post("/{channel_id}/messages")
def send_message(
    channel_id: int,
    background: BackgroundTasks,
    payload_json: str = Form("{}"),
    files: list[UploadFile] | None = File(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    try:
        body = MessageIn.model_validate(json.loads(payload_json or "{}"))
    except (ValueError, ValidationError):
        raise bad_request("Couldn't read that message.")
    rate_limit(f"send:{user.id}", 15, 10, "You're sending messages too quickly. Slow down a little.")

    access = load_channel(db, channel_id, user.id, P.SEND_MESSAGES)
    content = _clean_content(body.content)
    uploads = [f for f in (files or []) if f.filename]
    if not content and not uploads:
        raise bad_request("You can't send an empty message.")
    if uploads and not access.has(P.ATTACH_FILES):
        raise forbidden("You can't upload files in this channel.")
    if len(uploads) > MAX_FILES:
        raise bad_request(f"You can upload up to {MAX_FILES} files at a time.")

    character = None
    meta = None
    if body.narrator:
        if access.ctx is None or not access.ctx.is_dm(user.id):
            raise forbidden("Only Dungeon Masters can narrate.")
        if not access.has(P.USE_CHARACTERS):
            raise forbidden("Roleplay isn't allowed in this channel.")
        meta = {"narrator": True}
    elif body.character_id:
        character = db.get(Character, body.character_id)
        if character is None or character.owner_id != user.id or character.deleted:
            raise not_found("That character")
        if not access.has(P.USE_CHARACTERS):
            raise forbidden("Characters aren't allowed in this channel.")

    reply_to = None
    if body.reply_to_id:
        reply_to = db.get(Message, body.reply_to_id)
        if (
            reply_to is None
            or reply_to.channel_id != channel_id
            or reply_to.type not in MessageType.USER
            or not can_see_message(access, reply_to, user.id)
        ):
            raise bad_request("You can't reply to that message.")

    saved: list[dict] = []
    try:
        remaining = settings.max_upload_bytes
        for upload in uploads:
            info = save_attachment(upload, remaining)
            remaining -= info["size"]
            saved.append(info)
        msg, payload = create_message(
            db,
            access,
            user,
            content=content,
            character=character,
            reply_to=reply_to,
            mention_reply=body.mention_reply,
            attachments=saved,
            nonce=body.nonce,
            meta=meta,
            book=body.book or body.narrator,
        )
        db.commit()
    except BaseException:
        db.rollback()
        delete_files("attachments", [s["file"] for s in saved])
        raise

    if content and settings.embeds_enabled and access.has(P.EMBED_LINKS) and extract_urls(content):
        background.add_task(unfurl_message, msg.id, content)
    return payload


class EditIn(BaseModel):
    content: str | None = Field(default=None, max_length=MAX_CONTENT + 200)
    suppress_embeds: bool | None = None


@router.patch("/{channel_id}/messages/{message_id}")
def edit_message(
    channel_id: int,
    message_id: int,
    body: EditIn,
    background: BackgroundTasks,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    access = load_channel(db, channel_id, user.id)
    msg = load_message(db, access, message_id)
    if msg.type != MessageType.DEFAULT:
        raise bad_request("System messages can't be edited.")
    schedule_unfurl = False

    if body.content is not None:
        if msg.author_id != user.id:
            raise forbidden("You can only edit your own messages.")
        content = _clean_content(body.content)
        has_files = db.scalar(select(func.count()).select_from(Attachment).where(Attachment.message_id == msg.id)) or 0
        if not content and not has_files:
            raise bad_request("A message can't be empty. Delete it instead.")
        if content != msg.content:
            old_urls = extract_urls(msg.content)
            msg.content = content
            msg.edited_at = utcnow()
            refresh_mentions(db, access, msg)
            new_urls = extract_urls(content)
            if new_urls != old_urls:
                msg.embeds = []
                schedule_unfurl = bool(new_urls) and settings.embeds_enabled and access.has(P.EMBED_LINKS)

    if body.suppress_embeds is not None:
        if msg.author_id != user.id and not access.has(P.MANAGE_MESSAGES):
            raise forbidden()
        msg.suppress_embeds = body.suppress_embeds
        if body.suppress_embeds:
            msg.embeds = []
        else:
            schedule_unfurl = settings.embeds_enabled and bool(extract_urls(msg.content))

    db.flush()
    payload = message_payload(db, msg)
    queue_event(db, message_audience(access, msg), "MESSAGE_UPDATE", payload)
    db.commit()
    if schedule_unfurl and not msg.suppress_embeds:
        background.add_task(unfurl_message, msg.id, msg.content)
    return payload


@router.delete("/{channel_id}/messages/{message_id}")
def delete_message(channel_id: int, message_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id)
    msg = load_message(db, access, message_id)
    if not can_see_message(access, msg, user.id):
        raise not_found("That message")
    can_manage = access.ctx is not None and access.has(P.MANAGE_MESSAGES)
    if msg.author_id != user.id and not can_manage:
        raise forbidden("You can only delete your own messages.")
    files = list(db.scalars(select(Attachment.file).where(Attachment.message_id == msg.id)))
    audience = message_audience(access, msg)
    db.delete(msg)
    db.flush()
    channel = access.channel
    if channel.last_message_id == message_id:
        channel.last_message_id = db.scalar(
            select(func.max(Message.id)).where(Message.channel_id == channel_id, Message.dm_only.is_(False))
        )
    queue_event(
        db,
        audience,
        "MESSAGE_DELETE",
        {"id": message_id, "channel_id": channel_id, "last_message_id": channel.last_message_id},
    )
    db.commit()
    delete_files("attachments", files)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Reactions
# ---------------------------------------------------------------------------


def _parse_emoji(db: Session, raw: str) -> tuple[str, int | None, str, bool]:
    raw = raw.strip()
    m = CUSTOM_EMOJI_RE.match(raw)
    if m:
        emoji = db.get(Emoji, int(m.group(2)))
        if emoji is None:
            raise not_found("That emoji")
        return f"c:{emoji.id}", emoji.id, emoji.name, emoji.animated
    if not raw or len(raw) > 32 or any(ch.isspace() for ch in raw) or raw.isascii():
        raise bad_request("That isn't an emoji.")
    return raw, None, raw, False


@router.put("/{channel_id}/messages/{message_id}/reactions/{emoji}/@me")
def add_reaction(channel_id: int, message_id: int, emoji: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, P.READ_MESSAGE_HISTORY)
    msg = load_message(db, access, message_id)
    if not can_see_message(access, msg, user.id):
        raise not_found("That message")
    key, emoji_id, name, animated = _parse_emoji(db, emoji)
    rate_limit(f"react:{user.id}", 30, 10)
    existing_kinds = set(db.scalars(select(Reaction.emoji_key).where(Reaction.message_id == msg.id)))
    if key not in existing_kinds:
        if not access.has(P.ADD_REACTIONS):
            raise forbidden("You can't add new reactions here.")
        if len(existing_kinds) >= MAX_REACTION_KINDS:
            raise bad_request("That message has too many different reactions.")
    already = db.scalar(select(Reaction.id).where(Reaction.message_id == msg.id, Reaction.user_id == user.id, Reaction.emoji_key == key))
    if already is None:
        db.add(Reaction(message_id=msg.id, user_id=user.id, emoji_key=key, emoji_id=emoji_id, emoji_name=name, animated=animated))
        queue_event(
            db,
            message_audience(access, msg),
            "MESSAGE_REACTION_ADD",
            {
                "channel_id": channel_id,
                "message_id": msg.id,
                "user_id": user.id,
                "emoji": {"id": emoji_id, "name": name, "animated": animated},
            },
        )
        db.commit()
    return {"ok": True}


@router.delete("/{channel_id}/messages/{message_id}/reactions/{emoji}/@me")
def remove_reaction(
    channel_id: int, message_id: int, emoji: str, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    access = load_channel(db, channel_id, user.id)
    msg = load_message(db, access, message_id)
    key, emoji_id, name, animated = _parse_emoji(db, emoji)
    result = db.execute(delete(Reaction).where(Reaction.message_id == msg.id, Reaction.user_id == user.id, Reaction.emoji_key == key))
    if result.rowcount:
        queue_event(
            db,
            message_audience(access, msg),
            "MESSAGE_REACTION_REMOVE",
            {
                "channel_id": channel_id,
                "message_id": msg.id,
                "user_id": user.id,
                "emoji": {"id": emoji_id, "name": name, "animated": animated},
            },
        )
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Pins
# ---------------------------------------------------------------------------


@router.get("/{channel_id}/pins")
def list_pins(channel_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    access = load_channel(db, channel_id, user.id, P.READ_MESSAGE_HISTORY)
    pinned = list(
        db.scalars(
            select(Message).where(Message.channel_id == access.channel.id, Message.pinned.is_(True)).order_by(Message.pinned_at.desc())
        )
    )
    out = messages_payload(db, pinned)
    for data, m in zip(out, pinned):
        data["pinned_at"] = iso(m.pinned_at)
    return out


def _can_pin(access) -> bool:
    return access.has(P.PIN_MESSAGES) or access.has(P.MANAGE_MESSAGES)


@router.put("/{channel_id}/pins/{message_id}")
def pin_message(channel_id: int, message_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id)
    if not _can_pin(access):
        raise forbidden("You don't have permission to pin messages here.")
    msg = load_message(db, access, message_id)
    if msg.type not in MessageType.USER or msg.dm_only:
        raise bad_request("You can't pin that.")
    if msg.pinned:
        return {"ok": True}
    count = db.scalar(select(func.count()).select_from(Message).where(Message.channel_id == channel_id, Message.pinned.is_(True))) or 0
    if count >= MAX_PINS:
        raise bad_request(f"This channel already has {MAX_PINS} pins. Unpin something first.")
    msg.pinned = True
    msg.pinned_at = utcnow()
    audience = access.audience()
    queue_event(db, audience, "MESSAGE_UPDATE", {"id": msg.id, "channel_id": channel_id, "pinned": True})
    create_message(db, access, user, type=MessageType.CHANNEL_PINNED_MESSAGE, meta={"message_id": msg.id})
    queue_event(db, audience, "CHANNEL_PINS_UPDATE", {"channel_id": channel_id})
    db.commit()
    return {"ok": True}


@router.delete("/{channel_id}/pins/{message_id}")
def unpin_message(channel_id: int, message_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id)
    if not _can_pin(access):
        raise forbidden("You don't have permission to unpin messages here.")
    msg = load_message(db, access, message_id)
    if not msg.pinned:
        return {"ok": True}
    msg.pinned = False
    msg.pinned_at = None
    audience = access.audience()
    queue_event(db, audience, "MESSAGE_UPDATE", {"id": msg.id, "channel_id": channel_id, "pinned": False})
    queue_event(db, audience, "CHANNEL_PINS_UPDATE", {"channel_id": channel_id})
    db.commit()
    return {"ok": True}
