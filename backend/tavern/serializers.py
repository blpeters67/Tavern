"""Turn ORM rows into the JSON shapes the frontend expects."""

from __future__ import annotations

from collections import defaultdict
from collections.abc import Iterable, Sequence
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .files import wants_preview
from .models import (
    Attachment,
    Channel,
    ChannelRecipient,
    ChannelType,
    Character,
    Emoji,
    Member,
    MemberRole,
    Message,
    PermissionOverwrite,
    Reaction,
    Role,
    Server,
    User,
    VOICE_BITRATE_DEFAULT,
)

DEFAULT_SETTINGS: dict[str, Any] = {
    # Ways to switch who you're speaking as
    "switch_picker": True,
    "switch_proxy": True,
    "switch_hotkey": True,
    "switch_remember": True,
    # False = puppeteer mode (show who plays each character)
    "immersive": False,
    # Composer & chat
    "format_toolbar": True,
    "ic_cards": True,  # in-character messages as coloured cards
    "ic_serif": True,  # book font for in-character messages
    "dice_animations": True,
    "dice_sounds": True,
    "fx_motion": True,  # animate text effects (wave, fire...)
    "voice_sounds": True,
}


def iso(dt: datetime | None) -> str | None:
    if dt is None:
        return None
    return dt.replace(tzinfo=timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def merged_settings(user: User) -> dict[str, Any]:
    merged = dict(DEFAULT_SETTINGS)
    for key, value in (user.settings or {}).items():
        if key in DEFAULT_SETTINGS:
            merged[key] = value
    return merged


# ---------------------------------------------------------------------------
# Users & characters
# ---------------------------------------------------------------------------


def presence_of(user: User) -> str:
    from .gateway import gateway

    if user.status == "invisible" or not gateway.is_online(user.id):
        return "offline"
    return user.status


def user_payload(user: User) -> dict[str, Any]:
    return {
        "id": user.id,
        "username": user.username,
        "display_name": user.display_name,
        "avatar": user.avatar,
        "banner_color": user.banner_color,
        "about": user.about,
        "created_at": iso(user.created_at),
        "status": presence_of(user),
        "custom_status": user.custom_status,
    }


def me_payload(user: User) -> dict[str, Any]:
    data = user_payload(user)
    data.update(
        {
            "email": user.email,
            "status": user.status,
            "settings": merged_settings(user),
            "is_admin": user.is_admin,
        }
    )
    return data


def character_payload(ch: Character, private: bool = False) -> dict[str, Any]:
    from .sheets import summary

    data: dict[str, Any] = {
        "id": ch.id,
        "owner_id": ch.owner_id,
        "name": ch.name,
        "avatar": ch.avatar,
        "color": ch.color,
        "position": ch.position,
        "deleted": ch.deleted,
        "sheet_visibility": ch.sheet_visibility or "public",
        "has_sheet": ch.sheet is not None,
        "sheet_rev": (ch.sheet or {}).get("rev", 0) if ch.sheet else 0,
    }
    if private or (ch.sheet_visibility or "public") == "public":
        data["summary"] = summary(ch.sheet)
    if private:
        data["proxy_prefix"] = ch.proxy_prefix
        data["proxy_suffix"] = ch.proxy_suffix
    return data


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------


def role_payload(role: Role) -> dict[str, Any]:
    return {
        "id": role.id,
        "server_id": role.server_id,
        "name": role.name,
        "color": role.color,
        "permissions": role.permissions,
        "position": role.position,
        "hoist": role.hoist,
        "mentionable": role.mentionable,
        "is_default": role.is_default,
    }


def overwrite_payload(o: PermissionOverwrite) -> dict[str, Any]:
    return {"type": o.target_type, "id": o.target_id, "allow": o.allow, "deny": o.deny}


def channel_payload(
    ch: Channel,
    overwrites: Iterable[PermissionOverwrite] = (),
    recipients: Iterable[int] | None = None,
) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": ch.id,
        "type": ch.type,
        "server_id": ch.server_id,
        "name": ch.name,
        "topic": ch.topic,
        "parent_id": ch.parent_id,
        "position": ch.position,
        "last_message_id": ch.last_message_id,
    }
    if ch.type not in ChannelType.PRIVATE:
        data["emoji"] = ch.emoji
    if ch.type == ChannelType.VOICE:
        data["user_limit"] = ch.user_limit or 0
        data["bitrate"] = ch.bitrate or VOICE_BITRATE_DEFAULT
    if ch.type in ChannelType.PRIVATE:
        data["recipient_ids"] = sorted(recipients or [])
        data["owner_id"] = ch.owner_id
        data["icon"] = ch.icon
    else:
        data["overwrites"] = [overwrite_payload(o) for o in overwrites]
    return data


def emoji_payload(e: Emoji) -> dict[str, Any]:
    return {
        "id": e.id,
        "server_id": e.server_id,
        "name": e.name,
        "animated": e.animated,
        "creator_id": e.creator_id,
    }


def member_payload(m: Member, role_ids: Iterable[int]) -> dict[str, Any]:
    return {"user_id": m.user_id, "server_id": m.server_id, "role_ids": sorted(role_ids), "joined_at": iso(m.joined_at)}


def server_summary(server: Server) -> dict[str, Any]:
    return {
        "id": server.id,
        "name": server.name,
        "icon": server.icon,
        "owner_id": server.owner_id,
        "system_channel_id": server.system_channel_id,
        "tagline": server.tagline,
        "narrator_name": server.narrator_name or "The GM",
        "roleplay_mode": bool(server.roleplay_mode),
    }


def server_payload(db: Session, server: Server) -> dict[str, Any]:
    roles = list(db.scalars(select(Role).where(Role.server_id == server.id)))
    channels = list(db.scalars(select(Channel).where(Channel.server_id == server.id)))
    channel_ids = [c.id for c in channels]
    overwrites: dict[int, list[PermissionOverwrite]] = defaultdict(list)
    if channel_ids:
        for o in db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id.in_(channel_ids))):
            overwrites[o.channel_id].append(o)
    members = list(db.scalars(select(Member).where(Member.server_id == server.id)))
    member_roles: dict[int, list[int]] = defaultdict(list)
    for mr in db.scalars(select(MemberRole).where(MemberRole.server_id == server.id)):
        member_roles[mr.user_id].append(mr.role_id)
    emojis = list(db.scalars(select(Emoji).where(Emoji.server_id == server.id)))
    from .board import board
    from .jukebox import jukebox
    from .theater import theater
    from .voice import voice

    return {
        **server_summary(server),
        "created_at": iso(server.created_at),
        "voice_states": voice.states_for_server(server.id),
        "jukebox": jukebox.payload(db, server.id),
        "theater": theater.payload(db, server.id),
        "board": board.payload(db, server),
        "roles": [role_payload(r) for r in roles],
        "channels": [channel_payload(c, overwrites.get(c.id, [])) for c in channels],
        "members": [member_payload(m, member_roles.get(m.user_id, [])) for m in members],
        "emojis": [emoji_payload(e) for e in emojis],
    }


def private_channel_payload(db: Session, ch: Channel) -> dict[str, Any]:
    recipients = db.scalars(select(ChannelRecipient.user_id).where(ChannelRecipient.channel_id == ch.id))
    return channel_payload(ch, recipients=list(recipients))


def private_channel_payloads(db: Session, channels: Sequence[Channel]) -> list[dict[str, Any]]:
    """Several DMs at once, with every recipient list in one query."""
    recipients: dict[int, list[int]] = defaultdict(list)
    if channels:
        rows = db.execute(
            select(ChannelRecipient.channel_id, ChannelRecipient.user_id).where(ChannelRecipient.channel_id.in_([c.id for c in channels]))
        )
        for channel_id, user_id in rows:
            recipients[channel_id].append(user_id)
    return [channel_payload(c, recipients=recipients.get(c.id, [])) for c in channels]


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def attachment_payload(a: Attachment) -> dict[str, Any]:
    data: dict[str, Any] = {
        "id": a.id,
        "filename": a.filename,
        "content_type": a.content_type,
        "size": a.size,
        "width": a.width,
        "height": a.height,
        "url": f"/cdn/attachments/{a.id}/{a.filename}",
    }
    # Big images show in chat as a smaller preview; the original opens on click.
    if wants_preview(a.content_type, a.size, a.width, a.height):
        data["preview_url"] = f"/cdn/previews/{a.id}.webp"
    return data


def _reaction_groups(reactions: Sequence[Reaction]) -> list[dict[str, Any]]:
    groups: dict[str, dict[str, Any]] = {}
    for r in sorted(reactions, key=lambda r: r.id):
        g = groups.get(r.emoji_key)
        if g is None:
            g = groups[r.emoji_key] = {
                "emoji": {"id": r.emoji_id, "name": r.emoji_name, "animated": r.animated},
                "count": 0,
                "user_ids": [],
            }
        g["count"] += 1
        g["user_ids"].append(r.user_id)
    return list(groups.values())


def _reply_preview(ref: Message | None, ref_id: int, users: dict[int, User], chars: dict[int, Character]) -> dict[str, Any]:
    if ref is None:
        return {"id": ref_id, "deleted": True}
    author = users.get(ref.author_id)
    char = chars.get(ref.character_id) if ref.character_id else None
    return {
        "id": ref.id,
        "deleted": False,
        "author_id": ref.author_id,
        "character_id": ref.character_id,
        "content": ref.content[:300],
        "has_attachments": False,  # filled in by caller
        "author": user_payload(author) if author else None,
        "character": character_payload(char) if char else None,
    }


def messages_payload(db: Session, messages: Sequence[Message], nonce: str | None = None) -> list[dict[str, Any]]:
    """Serialize messages with all related rows loaded in a few batched queries."""
    if not messages:
        return []
    ids = [m.id for m in messages]
    reply_ids = {m.reply_to_id for m in messages if m.reply_to_id}

    refs: dict[int, Message] = {}
    if reply_ids:
        refs = {m.id: m for m in db.scalars(select(Message).where(Message.id.in_(reply_ids)))}

    all_msgs = list(messages) + list(refs.values())
    user_ids = {m.author_id for m in all_msgs}
    char_ids = {m.character_id for m in all_msgs if m.character_id}
    users = {u.id: u for u in db.scalars(select(User).where(User.id.in_(user_ids)))}
    chars = {c.id: c for c in db.scalars(select(Character).where(Character.id.in_(char_ids)))} if char_ids else {}

    attachments: dict[int, list[Attachment]] = defaultdict(list)
    attach_ids = ids + list(refs.keys())
    for a in db.scalars(select(Attachment).where(Attachment.message_id.in_(attach_ids)).order_by(Attachment.id)):
        attachments[a.message_id].append(a)  # type: ignore[index]

    reactions: dict[int, list[Reaction]] = defaultdict(list)
    for r in db.scalars(select(Reaction).where(Reaction.message_id.in_(ids))):
        reactions[r.message_id].append(r)

    out = []
    for m in messages:
        author = users.get(m.author_id)
        char = chars.get(m.character_id) if m.character_id else None
        data: dict[str, Any] = {
            "id": m.id,
            "channel_id": m.channel_id,
            "type": m.type,
            "author_id": m.author_id,
            "character_id": m.character_id,
            "author": user_payload(author) if author else None,
            "character": character_payload(char) if char else None,
            "content": m.content,
            "created_at": iso(m.created_at),
            "edited_at": iso(m.edited_at),
            "pinned": m.pinned,
            "mention_everyone": m.mention_everyone,
            "mentions": list(m.mention_ids or []),
            "mention_reply": m.mention_reply,
            "attachments": [attachment_payload(a) for a in attachments.get(m.id, [])],
            "embeds": [] if m.suppress_embeds else list(m.embeds or []),
            "reactions": _reaction_groups(reactions.get(m.id, [])),
            "reply_to": None,
            "meta": m.meta,
        }
        if m.dm_only:
            data["dm_only"] = True
        if m.book:
            data["book"] = True
        if m.reply_to_id:
            ref = refs.get(m.reply_to_id)
            preview = _reply_preview(ref, m.reply_to_id, users, chars)
            if ref is not None:
                preview["has_attachments"] = bool(attachments.get(ref.id))
            data["reply_to"] = preview
        if nonce is not None:
            data["nonce"] = nonce
        out.append(data)
    return out


def message_payload(db: Session, message: Message, nonce: str | None = None) -> dict[str, Any]:
    return messages_payload(db, [message], nonce=nonce)[0]
