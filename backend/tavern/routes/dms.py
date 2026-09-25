"""Direct messages and group DMs."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db, queue_event
from ..deps import bad_request, current_user, forbidden, not_found, rate_limit
from ..models import Channel, ChannelRecipient, ChannelType, MessageType, User
from ..permissions import ChannelAccess, P, private_channel_recipients
from ..serializers import private_channel_payload
from ..services import create_message, load_channel, shares_server, users_and_characters

router = APIRouter(tags=["dms"])

MAX_GROUP = 10


def _dm_payload_for(db: Session, channel: Channel, viewer_id: int) -> dict:
    payload = private_channel_payload(db, channel)
    payload.update(users_and_characters(db, payload["recipient_ids"], viewer_id))
    return payload


def _can_message(db: Session, me: int, other: int) -> bool:
    if shares_server(db, me, other):
        return True
    # Or you're already in a DM/group together.
    mine = select(ChannelRecipient.channel_id).where(ChannelRecipient.user_id == me)
    together = db.scalar(
        select(ChannelRecipient.channel_id).where(ChannelRecipient.user_id == other, ChannelRecipient.channel_id.in_(mine))
    )
    return together is not None


def _find_dm(db: Session, me: int, other: int) -> Channel | None:
    candidates = db.scalars(
        select(Channel)
        .join(ChannelRecipient, ChannelRecipient.channel_id == Channel.id)
        .where(Channel.type == ChannelType.DM, ChannelRecipient.user_id == me)
    )
    for ch in candidates:
        if set(private_channel_recipients(db, ch.id)) == {me, other}:
            return ch
    return None


class OpenDmIn(BaseModel):
    recipient_ids: list[int] = Field(min_length=1, max_length=MAX_GROUP)


@router.post("/api/users/@me/channels")
def open_dm(body: OpenDmIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    rate_limit(f"dm-open:{user.id}", 30, 600)
    others = sorted({uid for uid in body.recipient_ids if uid != user.id})
    if not others:
        raise bad_request("Pick someone to message.")
    for uid in others:
        if db.get(User, uid) is None:
            raise not_found("That user")
        if not _can_message(db, user.id, uid):
            raise forbidden("You can only message people you share a server with.")

    if len(others) == 1:
        channel = _find_dm(db, user.id, others[0])
        if channel is None:
            channel = Channel(type=ChannelType.DM)
            db.add(channel)
            db.flush()
            db.add(ChannelRecipient(channel_id=channel.id, user_id=user.id, hidden=False))
            # The other person sees it once there's a message in it.
            db.add(ChannelRecipient(channel_id=channel.id, user_id=others[0], hidden=True))
        else:
            rec = db.get(ChannelRecipient, (channel.id, user.id))
            if rec is not None:
                rec.hidden = False
        db.flush()
        payload = _dm_payload_for(db, channel, user.id)
        queue_event(db, [user.id], "CHANNEL_CREATE", payload)
        db.commit()
        return payload

    if len(others) + 1 > MAX_GROUP:
        raise bad_request(f"Group DMs can have up to {MAX_GROUP} people.")
    channel = Channel(type=ChannelType.GROUP_DM, owner_id=user.id)
    db.add(channel)
    db.flush()
    for uid in [user.id, *others]:
        db.add(ChannelRecipient(channel_id=channel.id, user_id=uid, hidden=False))
    db.flush()
    for uid in [user.id, *others]:
        queue_event(db, [uid], "CHANNEL_CREATE", _dm_payload_for(db, channel, uid))
    db.commit()
    return _dm_payload_for(db, channel, user.id)


def _group_access(db: Session, channel_id: int, user: User) -> ChannelAccess:
    access = load_channel(db, channel_id, user.id, perm=0)
    if access.channel.type != ChannelType.GROUP_DM:
        raise bad_request("That only works in group DMs.")
    return access


@router.put("/api/channels/{channel_id}/recipients/{user_id}")
def add_recipient(channel_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = _group_access(db, channel_id, user)
    recipients = access.recipients or []
    if user_id in recipients:
        return _dm_payload_for(db, access.channel, user.id)
    if len(recipients) >= MAX_GROUP:
        raise bad_request(f"Group DMs can have up to {MAX_GROUP} people.")
    if db.get(User, user_id) is None:
        raise not_found("That user")
    if not _can_message(db, user.id, user_id):
        raise forbidden("You can only add people you share a server with.")
    db.add(ChannelRecipient(channel_id=channel_id, user_id=user_id, hidden=False))
    db.flush()
    channel = access.channel
    new_access = ChannelAccess(channel=channel, perms=P.PRIVATE_CHANNEL, ctx=None, recipients=[*recipients, user_id])
    queue_event(db, [user_id], "CHANNEL_CREATE", _dm_payload_for(db, channel, user_id))
    update = _dm_payload_for(db, channel, 0)
    queue_event(db, recipients, "CHANNEL_UPDATE", update)
    create_message(db, new_access, user, type=MessageType.RECIPIENT_ADD, meta={"user_id": user_id})
    db.commit()
    return _dm_payload_for(db, channel, user.id)


def remove_recipient(db: Session, access: ChannelAccess, actor: User, target_id: int) -> None:
    channel = access.channel
    recipients = [r for r in (access.recipients or []) if r != target_id]
    rec = db.get(ChannelRecipient, (channel.id, target_id))
    if rec is None:
        raise not_found("That person")
    db.delete(rec)
    queue_event(db, [target_id], "CHANNEL_DELETE", {"id": channel.id})
    if not recipients:
        db.delete(channel)
        return
    if channel.owner_id == target_id:
        channel.owner_id = recipients[0]
    db.flush()
    remaining_access = ChannelAccess(channel=channel, perms=P.PRIVATE_CHANNEL, ctx=None, recipients=recipients)
    queue_event(db, recipients, "CHANNEL_UPDATE", _dm_payload_for(db, channel, 0))
    create_message(db, remaining_access, actor, type=MessageType.RECIPIENT_REMOVE, meta={"user_id": target_id})


@router.delete("/api/channels/{channel_id}/recipients/{user_id}")
def kick_recipient(channel_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = _group_access(db, channel_id, user)
    if user_id != user.id and access.channel.owner_id != user.id:
        raise forbidden("Only the group owner can remove people.")
    remove_recipient(db, access, user, user_id)
    db.commit()
    return {"ok": True}
