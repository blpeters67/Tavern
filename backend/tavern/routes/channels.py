"""Channel editing, permission overwrites, typing, read state and the
"speaking as" memory. Messages live in messages.py."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..db import get_db, queue_event
from ..deps import ApiError, current_user, forbidden, not_found
from ..files import delete_files
from ..models import (
    Attachment,
    Channel,
    ChannelRecipient,
    ChannelType,
    Character,
    Message,
    MessageType,
    OverwriteType,
    PermissionOverwrite,
    ReadState,
    Server,
    User,
    VOICE_BITRATE_MAX,
    VOICE_BITRATE_MIN,
)
from ..permissions import P, ServerContext
from ..serializers import channel_payload, private_channel_payload
from ..services import create_message, load_channel, mark_read, users_and_characters
from ..voice import voice
from .servers import clean_channel_emoji, clean_channel_name

router = APIRouter(prefix="/api/channels", tags=["channels"])


def _publish_channel(db: Session, ctx: ServerContext, channel: Channel) -> dict:
    ows = list(db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id == channel.id)))
    payload = channel_payload(channel, ows)
    queue_event(db, ctx.member_ids, "CHANNEL_UPDATE", payload)
    return payload


class ChannelPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    topic: str | None = Field(default=None, max_length=1024)
    parent_id: int | None = None
    emoji: str | None = Field(default=None, max_length=64)
    user_limit: int | None = Field(default=None, ge=0, le=99)
    bitrate: int | None = Field(default=None, ge=VOICE_BITRATE_MIN, le=VOICE_BITRATE_MAX)


@router.patch("/{channel_id}")
def update_channel(channel_id: int, body: ChannelPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    channel = access.channel
    fields = body.model_fields_set

    if channel.type == ChannelType.GROUP_DM:
        if "name" in fields:
            new_name = " ".join((body.name or "").split())[:100] or None
            if new_name != channel.name:
                channel.name = new_name
                payload = private_channel_payload(db, channel)
                queue_event(db, access.audience(), "CHANNEL_UPDATE", payload)
                create_message(db, access, user, content=new_name or "", type=MessageType.CHANNEL_NAME_CHANGE)
        db.commit()
        return private_channel_payload(db, channel)
    if channel.type == ChannelType.DM:
        raise ApiError(400, "DMs can't be renamed.")

    assert access.ctx is not None
    if not access.has(P.MANAGE_CHANNELS):
        raise forbidden()
    if "name" in fields and body.name is not None:
        channel.name = clean_channel_name(body.name, channel.type)
    if "topic" in fields and channel.type == ChannelType.TEXT:
        channel.topic = (body.topic or "").strip() or None
    if "emoji" in fields and channel.type in (ChannelType.TEXT, ChannelType.VOICE):
        channel.emoji = clean_channel_emoji(db, channel.server_id, body.emoji)
    if "user_limit" in fields and channel.type == ChannelType.VOICE and body.user_limit is not None:
        channel.user_limit = body.user_limit
    if "bitrate" in fields and channel.type == ChannelType.VOICE and body.bitrate is not None:
        channel.bitrate = body.bitrate
    if "parent_id" in fields and channel.type in (ChannelType.TEXT, ChannelType.VOICE):
        if body.parent_id is None:
            channel.parent_id = None
        else:
            parent = db.get(Channel, body.parent_id)
            if parent is None or parent.server_id != channel.server_id or parent.type != ChannelType.CATEGORY:
                raise ApiError(400, "That category doesn't exist.")
            channel.parent_id = parent.id
    payload = _publish_channel(db, access.ctx, channel)
    db.commit()
    return payload


@router.delete("/{channel_id}")
def delete_channel(channel_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    channel = access.channel

    if channel.type == ChannelType.DM:
        # "Close DM": hide it until someone sends a new message.
        rec = db.get(ChannelRecipient, (channel_id, user.id))
        if rec is not None:
            rec.hidden = True
        queue_event(db, [user.id], "CHANNEL_DELETE", {"id": channel_id})
        db.commit()
        return {"ok": True}

    if channel.type == ChannelType.GROUP_DM:
        # Leave the group.
        from .dms import remove_recipient

        remove_recipient(db, access, user, user.id)
        db.commit()
        return {"ok": True}

    assert access.ctx is not None
    if not access.has(P.MANAGE_CHANNELS):
        raise forbidden()
    server = db.get(Server, channel.server_id)
    files = list(
        db.scalars(select(Attachment.file).join(Message, Attachment.message_id == Message.id).where(Message.channel_id == channel_id))
    )
    members = access.ctx.member_ids
    if channel.type == ChannelType.CATEGORY:
        children = list(db.scalars(select(Channel).where(Channel.parent_id == channel_id)))
        for child in children:
            child.parent_id = None
        db.flush()
        for child in children:
            _publish_channel(db, access.ctx, child)
    if server is not None and server.system_channel_id == channel_id:
        server.system_channel_id = None
        queue_event(
            db,
            members,
            "SERVER_UPDATE",
            {"id": server.id, "name": server.name, "icon": server.icon, "owner_id": server.owner_id, "system_channel_id": None},
        )
    db.delete(channel)
    queue_event(db, members, "CHANNEL_DELETE", {"id": channel_id, "server_id": channel.server_id})
    db.commit()
    if channel.type == ChannelType.VOICE:
        voice.disconnect_channel(channel_id)
    delete_files("attachments", files)
    return {"ok": True}


# ---------------------------------------------------------------------------
# Permission overwrites
# ---------------------------------------------------------------------------


class OverwriteIn(BaseModel):
    allow: int = Field(default=0, ge=0)
    deny: int = Field(default=0, ge=0)


def _overwrite_target_ok(db: Session, ctx: ServerContext, target_type: int, target_id: int) -> None:
    if target_type == OverwriteType.ROLE:
        if target_id not in ctx.roles:
            raise not_found("That role")
    elif target_type == OverwriteType.MEMBER:
        if not ctx.is_member(target_id):
            raise not_found("That member")
    else:
        raise ApiError(400, "Unknown overwrite type.")


@router.put("/{channel_id}/permissions/{target_type}/{target_id}")
def put_overwrite(
    channel_id: int, target_type: int, target_id: int, body: OverwriteIn, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    if access.ctx is None:
        raise ApiError(400, "DMs don't have permissions.")
    if not access.has(P.MANAGE_ROLES):
        raise forbidden()
    _overwrite_target_ok(db, access.ctx, target_type, target_id)
    allow = body.allow & P.CHANNEL_MASK
    deny = body.deny & P.CHANNEL_MASK & ~allow
    mine = access.perms
    ow = db.get(PermissionOverwrite, (channel_id, target_type, target_id))
    old_allow, old_deny = (ow.allow, ow.deny) if ow else (0, 0)
    if mine != P.ALL and (((old_allow ^ allow) | (old_deny ^ deny)) & ~mine):
        raise forbidden("You can't change permissions you don't have yourself.")
    if allow == 0 and deny == 0:
        if ow is not None:
            db.delete(ow)
    elif ow is None:
        db.add(PermissionOverwrite(channel_id=channel_id, target_type=target_type, target_id=target_id, allow=allow, deny=deny))
    else:
        ow.allow, ow.deny = allow, deny
    db.flush()
    payload = _publish_channel(db, access.ctx, access.channel)
    db.commit()
    return payload


@router.delete("/{channel_id}/permissions/{target_type}/{target_id}")
def delete_overwrite(
    channel_id: int, target_type: int, target_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    if access.ctx is None:
        raise ApiError(400, "DMs don't have permissions.")
    if not access.has(P.MANAGE_ROLES):
        raise forbidden()
    db.execute(
        delete(PermissionOverwrite).where(
            PermissionOverwrite.channel_id == channel_id,
            PermissionOverwrite.target_type == target_type,
            PermissionOverwrite.target_id == target_id,
        )
    )
    db.flush()
    payload = _publish_channel(db, access.ctx, access.channel)
    db.commit()
    return payload


# ---------------------------------------------------------------------------
# Typing, read state, persona memory
# ---------------------------------------------------------------------------


class TypingIn(BaseModel):
    character_id: int | None = None
    narrator: bool = False


@router.post("/{channel_id}/typing")
def typing(channel_id: int, body: TypingIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, P.SEND_MESSAGES)
    character_id = None
    if body.character_id:
        ch = db.get(Character, body.character_id)
        if ch is not None and ch.owner_id == user.id and not ch.deleted and access.has(P.USE_CHARACTERS):
            character_id = ch.id
    narrator = bool(body.narrator and access.ctx is not None and access.ctx.is_dm(user.id))
    if not rate_limit_ok(f"typing:{user.id}:{channel_id}:{character_id}:{narrator}", 1, 2.5):
        return {"ok": True}
    queue_event(
        db,
        access.audience() - {user.id},
        "TYPING_START",
        {"channel_id": channel_id, "user_id": user.id, "character_id": character_id, "narrator": narrator},
    )
    db.commit()
    return {"ok": True}


def rate_limit_ok(key: str, limit: int, window: float) -> bool:
    from ..security import limiter

    return limiter.hit(key, limit, window)


class AckIn(BaseModel):
    message_id: int


@router.post("/{channel_id}/ack")
def ack(channel_id: int, body: AckIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    target = min(body.message_id, access.channel.last_message_id or 0)
    state = mark_read(db, user.id, channel_id, target)
    queue_event(db, [user.id], "READ_STATE_UPDATE", {"channel_id": channel_id, "last_read_id": state.last_read_id, "mention_count": 0})
    db.commit()
    return {"ok": True}


class PersonaIn(BaseModel):
    character_id: int | None = None  # None / 0 = yourself, -1 = narrator


@router.put("/{channel_id}/persona")
def remember_persona(channel_id: int, body: PersonaIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    character_id = body.character_id or 0
    if character_id == -1:
        if access.ctx is None or not access.ctx.is_dm(user.id):
            raise forbidden("Only Dungeon Masters can narrate.")
    elif character_id:
        ch = db.get(Character, character_id)
        if ch is None or ch.owner_id != user.id or ch.deleted:
            raise not_found("That character")
    state = db.get(ReadState, (user.id, channel_id))
    if state is None:
        state = ReadState(user_id=user.id, channel_id=channel_id, last_read_id=0)
        db.add(state)
    state.last_character_id = character_id
    queue_event(db, [user.id], "PERSONA_UPDATE", {"channel_id": channel_id, "character_id": character_id})
    # Everyone else can see who you're playing (for "In character" in the member list).
    queue_event(
        db,
        access.audience() - {user.id},
        "CHANNEL_PERSONA",
        {"channel_id": channel_id, "user_id": user.id, "character_id": character_id},
    )
    db.commit()
    return {"ok": True}


@router.get("/{channel_id}")
def get_channel(channel_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, perm=0)
    if access.is_private:
        payload = private_channel_payload(db, access.channel)
        payload.update(users_and_characters(db, payload["recipient_ids"], user.id))
        return payload
    ows = db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id == channel_id))
    return channel_payload(access.channel, ows)
