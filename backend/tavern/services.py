"""Shared business logic used by several route modules."""

from __future__ import annotations

import re
from collections.abc import Iterable, Sequence
from typing import Any

from sqlalchemy import and_, delete, func, select, update
from sqlalchemy.orm import Session

from .config import settings
from .db import queue_event
from .deps import ApiError, forbidden, not_found
from .gateway import gateway
from .models import (
    Attachment,
    Channel,
    ChannelRecipient,
    ChannelType,
    Character,
    Emoji,
    Invite,
    Member,
    MemberRole,
    Message,
    MessageMention,
    MessageType,
    ReadState,
    Role,
    Server,
    User,
    utcnow,
)
from .permissions import ChannelAccess, P, ServerContext, channel_access
from .serializers import (
    character_payload,
    iso,
    me_payload,
    member_payload,
    message_payload,
    private_channel_payload,
    private_channel_payloads,
    server_payload,
    user_payload,
)

USER_MENTION_RE = re.compile(r"<@!?(\d+)>")
CHAR_MENTION_RE = re.compile(r"<@c(\d+)>")
ROLE_MENTION_RE = re.compile(r"<@&(\d+)>")
EVERYONE_RE = re.compile(r"@(everyone|here)\b")
CODE_RE = re.compile(r"```.*?```|`[^`\n]*`", re.DOTALL)

JOIN_MESSAGES = [
    "{} just walked into the tavern.",
    "{} pulled up a chair.",
    "Welcome, {}. First round's on you.",
    "{} kicked the door open. Everyone look busy.",
    "{} has arrived. Someone fetch another mug.",
    "{} joined the party.",
    "{} wandered in out of the rain.",
    "Look alive, {} is here.",
    "{} slid into the corner booth.",
    "{} took a seat by the fire.",
]


# ---------------------------------------------------------------------------
# Lookups
# ---------------------------------------------------------------------------


def related_user_ids(db: Session, user_id: int) -> set[int]:
    """Everyone who shares a server or a DM with `user_id` (plus themselves)."""
    my_servers = select(Member.server_id).where(Member.user_id == user_id)
    my_dms = select(ChannelRecipient.channel_id).where(ChannelRecipient.user_id == user_id)
    ids = set(db.scalars(select(Member.user_id).where(Member.server_id.in_(my_servers))))
    ids |= set(db.scalars(select(ChannelRecipient.user_id).where(ChannelRecipient.channel_id.in_(my_dms))))
    ids.add(user_id)
    return ids


def shares_server(db: Session, a: int, b: int) -> bool:
    mine = select(Member.server_id).where(Member.user_id == a)
    return db.scalar(select(func.count()).select_from(Member).where(Member.user_id == b, Member.server_id.in_(mine))) > 0


def server_member_ids(db: Session, server_id: int) -> list[int]:
    return list(db.scalars(select(Member.user_id).where(Member.server_id == server_id)))


def load_server(db: Session, server_id: int, user_id: int) -> ServerContext:
    server = db.get(Server, server_id)
    if server is None:
        raise not_found("That server")
    ctx = ServerContext.load(db, server)
    if not ctx.is_member(user_id):
        raise not_found("That server")
    return ctx


def require_server_perm(ctx: ServerContext, user_id: int, perm: int) -> None:
    if not ctx.has(user_id, perm):
        raise forbidden()


def load_channel(db: Session, channel_id: int, user_id: int, perm: int = P.VIEW_CHANNEL) -> ChannelAccess:
    channel = db.get(Channel, channel_id)
    if channel is None:
        raise not_found("That channel")
    access = channel_access(db, channel, user_id)
    if not access.has(P.VIEW_CHANNEL):
        raise not_found("That channel")
    if perm and not access.has(perm):
        raise forbidden()
    return access


def load_message(db: Session, access: ChannelAccess, message_id: int) -> Message:
    msg = db.get(Message, message_id)
    if msg is None or msg.channel_id != access.channel.id:
        raise not_found("That message")
    return msg


# ---------------------------------------------------------------------------
# Broadcast helpers
# ---------------------------------------------------------------------------


def publish_user_update(db: Session, user: User) -> None:
    others = related_user_ids(db, user.id) - {user.id}
    queue_event(db, others, "USER_UPDATE", user_payload(user))
    queue_event(db, [user.id], "ME_UPDATE", me_payload(user))


def publish_character(db: Session, ch: Character, event: str) -> None:
    others = related_user_ids(db, ch.owner_id) - {ch.owner_id}
    queue_event(db, others, event, character_payload(ch))
    queue_event(db, [ch.owner_id], event, character_payload(ch, private=True))


def users_and_characters(db: Session, user_ids: Iterable[int], viewer_id: int) -> dict[str, list[dict[str, Any]]]:
    ids = set(user_ids)
    if not ids:
        return {"users": [], "characters": []}
    users = [user_payload(u) for u in db.scalars(select(User).where(User.id.in_(ids)))]
    chars = [
        character_payload(c, private=c.owner_id == viewer_id)
        for c in db.scalars(select(Character).where(Character.owner_id.in_(ids), Character.deleted.is_(False)))
    ]
    return {"users": users, "characters": chars}


# ---------------------------------------------------------------------------
# Servers & membership
# ---------------------------------------------------------------------------


def create_server(db: Session, owner: User, name: str, icon: str | None = None) -> Server:
    server = Server(name=name, icon=icon, owner_id=owner.id, narrator_name="The GM")
    db.add(server)
    db.flush()
    db.add(Role(server_id=server.id, name="@everyone", permissions=P.DEFAULT_EVERYONE, position=0, is_default=True))
    # Every server starts with the two roleplay roles.
    db.add(Role(server_id=server.id, name="Dungeon Master", color=0xE0B252, permissions=P.DUNGEON_MASTER | P.DJ, position=2, hoist=True))
    db.add(Role(server_id=server.id, name="DJ", color=0xA78BFA, permissions=P.DJ, position=1))
    general = Channel(server_id=server.id, type=ChannelType.TEXT, name="General", emoji=None, position=0)
    db.add(general)
    db.add(Channel(server_id=server.id, type=ChannelType.VOICE, name="The Lounge", position=0))
    db.flush()
    server.system_channel_id = general.id
    db.add(Member(server_id=server.id, user_id=owner.id))
    db.flush()
    return server


def join_server(db: Session, user: User, server: Server, invite: Invite | None = None) -> None:
    """Add `user` to `server`, post the join message and notify everyone."""
    from .models import Ban

    if db.get(Ban, (server.id, user.id)) is not None:
        raise forbidden("You're banned from that server.")
    if db.get(Member, (server.id, user.id)) is not None:
        return
    db.add(Member(server_id=server.id, user_id=user.id))
    if invite is not None:
        invite.uses += 1

    # New members start with every existing channel marked as read.
    for ch_id, last_id in db.execute(
        select(Channel.id, Channel.last_message_id).where(Channel.server_id == server.id, Channel.type == ChannelType.TEXT)
    ):
        state = db.get(ReadState, (user.id, ch_id))
        if state is None:
            db.add(ReadState(user_id=user.id, channel_id=ch_id, last_read_id=last_id or 0))
        else:
            state.last_read_id = max(state.last_read_id, last_id or 0)
    db.flush()

    existing = [uid for uid in server_member_ids(db, server.id) if uid != user.id]

    # Tell the newcomer about the whole server, including everyone in it.
    payload = server_payload(db, server)
    payload.update(users_and_characters(db, existing + [user.id], user.id))
    queue_event(db, [user.id], "SERVER_CREATE", payload)

    # Tell everyone else about the newcomer.
    member = db.get(Member, (server.id, user.id))
    assert member is not None
    add_payload = {"server_id": server.id, "member": member_payload(member, [])}
    add_payload.update(users_and_characters(db, [user.id], viewer_id=0))
    queue_event(db, existing, "MEMBER_ADD", add_payload)

    if server.system_channel_id:
        channel = db.get(Channel, server.system_channel_id)
        if channel is not None and channel.server_id == server.id:
            count = db.scalar(select(func.count()).select_from(Message).where(Message.channel_id == channel.id)) or 0
            template = JOIN_MESSAGES[(user.id + count) % len(JOIN_MESSAGES)]
            access = channel_access(db, channel, user.id)
            create_message(db, access, user, content=template, type=MessageType.MEMBER_JOIN)


def remove_member(db: Session, ctx: ServerContext, user_id: int) -> None:
    server_id = ctx.server.id
    db.execute(delete(MemberRole).where(MemberRole.server_id == server_id, MemberRole.user_id == user_id))
    db.execute(delete(Member).where(Member.server_id == server_id, Member.user_id == user_id))
    remaining = [uid for uid in ctx.member_ids if uid != user_id]
    queue_event(db, [user_id], "SERVER_DELETE", {"id": server_id})
    queue_event(db, remaining, "MEMBER_REMOVE", {"server_id": server_id, "user_id": user_id})
    from .voice import voice

    voice.disconnect_server_member(server_id, user_id)


def attachment_files_for(db: Session, message_filter) -> list[str]:
    return list(db.scalars(select(Attachment.file).join(Message, Attachment.message_id == Message.id).where(message_filter)))


# ---------------------------------------------------------------------------
# Messages
# ---------------------------------------------------------------------------


def _strip_code(content: str) -> str:
    return CODE_RE.sub(" ", content)


def resolve_mentions(
    db: Session, access: ChannelAccess, author_id: int, content: str, reply_target: Message | None
) -> tuple[set[int], bool, set[int]]:
    """Returns (explicitly mentioned users, mentions everyone?, everyone to ping)."""
    text = _strip_code(content)
    viewers = access.audience()
    explicit: set[int] = set()

    for m in USER_MENTION_RE.finditer(text):
        uid = int(m.group(1))
        if uid in viewers:
            explicit.add(uid)

    char_ids = {int(m.group(1)) for m in CHAR_MENTION_RE.finditer(text)}
    if char_ids:
        for ch in db.scalars(select(Character).where(Character.id.in_(char_ids), Character.deleted.is_(False))):
            if ch.owner_id in viewers:
                explicit.add(ch.owner_id)

    can_everyone = access.has(P.MENTION_EVERYONE)
    if access.ctx is not None:
        for m in ROLE_MENTION_RE.finditer(text):
            role = access.ctx.roles.get(int(m.group(1)))
            if role is None or role.is_default or not (role.mentionable or can_everyone):
                continue
            explicit |= {uid for uid, rids in access.ctx.member_roles.items() if role.id in rids and uid in viewers}

    if reply_target is not None and reply_target.author_id in viewers:
        explicit.add(reply_target.author_id)

    targets = set(explicit)
    everyone = False
    if can_everyone:
        found = {m.group(1) for m in EVERYONE_RE.finditer(text)}
        if "everyone" in found:
            everyone = True
            targets |= viewers
        elif "here" in found:
            everyone = True
            targets |= {v for v in viewers if gateway.is_online(v)}

    explicit.discard(author_id)
    targets.discard(author_id)
    return explicit, everyone, targets


def mark_read(db: Session, user_id: int, channel_id: int, message_id: int) -> ReadState:
    state = db.get(ReadState, (user_id, channel_id))
    if state is None:
        state = ReadState(user_id=user_id, channel_id=channel_id, last_read_id=message_id)
        db.add(state)
    elif message_id > state.last_read_id:
        state.last_read_id = message_id
    return state


def create_message(
    db: Session,
    access: ChannelAccess,
    author: User,
    *,
    content: str = "",
    character: Character | None = None,
    reply_to: Message | None = None,
    mention_reply: bool = True,
    attachments: Sequence[dict[str, Any]] = (),
    type: int = MessageType.DEFAULT,
    meta: dict[str, Any] | None = None,
    nonce: str | None = None,
    dm_only: bool = False,
    book: bool = False,
) -> tuple[Message, dict[str, Any]]:
    channel = access.channel
    msg = Message(
        channel_id=channel.id,
        author_id=author.id,
        character_id=character.id if character else None,
        type=type,
        content=content,
        reply_to_id=reply_to.id if reply_to else None,
        mention_reply=bool(reply_to) and mention_reply,
        meta=meta,
        embeds=[],
        mention_ids=[],
        dm_only=dm_only,
        book=book,
    )
    targets: set[int] = set()
    if type == MessageType.DEFAULT and not dm_only:
        explicit, everyone, targets = resolve_mentions(db, access, author.id, content, reply_to if (reply_to and mention_reply) else None)
        msg.mention_ids = sorted(explicit)
        msg.mention_everyone = everyone
        if access.is_private:
            # Every DM counts toward the red badge, like a mention.
            targets |= set(access.recipients or []) - {author.id}
    db.add(msg)
    db.flush()

    for a in attachments:
        db.add(Attachment(message_id=msg.id, uploader_id=author.id, **a))
    for uid in targets:
        db.add(MessageMention(message_id=msg.id, user_id=uid, channel_id=channel.id))
    if not dm_only:
        channel.last_message_id = msg.id
    mark_read(db, author.id, channel.id, msg.id)

    audience = message_audience(access, msg)
    if access.is_private:
        hidden = list(
            db.scalars(select(ChannelRecipient.user_id).where(ChannelRecipient.channel_id == channel.id, ChannelRecipient.hidden.is_(True)))
        )
        if hidden:
            db.execute(update(ChannelRecipient).where(ChannelRecipient.channel_id == channel.id).values(hidden=False))
            db.flush()
            payload = private_channel_payload(db, channel)
            for uid in hidden:
                data = dict(payload)
                data.update(users_and_characters(db, payload["recipient_ids"], uid))
                queue_event(db, [uid], "CHANNEL_CREATE", data)

    db.flush()
    payload = message_payload(db, msg, nonce=nonce)
    queue_event(db, audience, "MESSAGE_CREATE", payload)
    return msg, payload


def message_audience(access: ChannelAccess, msg: Message) -> set[int]:
    """Who receives live events for this message."""
    audience = access.audience()
    if msg.dm_only and access.ctx is not None:
        return {uid for uid in audience if uid == msg.author_id or access.ctx.is_dm(uid)}
    return audience


def can_see_message(access: ChannelAccess, msg: Message, user_id: int) -> bool:
    if not msg.dm_only:
        return True
    return msg.author_id == user_id or (access.ctx is not None and access.ctx.is_dm(user_id))


def refresh_mentions(db: Session, access: ChannelAccess, msg: Message) -> None:
    """Recompute who a message pings after an edit."""
    reply_target = db.get(Message, msg.reply_to_id) if (msg.reply_to_id and msg.mention_reply) else None
    explicit, everyone, targets = resolve_mentions(db, access, msg.author_id, msg.content, reply_target)
    msg.mention_ids = sorted(explicit)
    msg.mention_everyone = everyone
    db.execute(delete(MessageMention).where(MessageMention.message_id == msg.id))
    for uid in targets:
        db.add(MessageMention(message_id=msg.id, user_id=uid, channel_id=msg.channel_id))


# ---------------------------------------------------------------------------
# READY
# ---------------------------------------------------------------------------


def build_ready(db: Session, user_id: int, session_id: int) -> dict[str, Any]:
    user = db.get(User, user_id)
    if user is None:
        raise ApiError(401, "Account not found")

    server_ids = list(db.scalars(select(Member.server_id).where(Member.user_id == user_id)))
    servers = [server_payload(db, s) for s in db.scalars(select(Server).where(Server.id.in_(server_ids)))] if server_ids else []

    dm_channels = list(
        db.scalars(
            select(Channel)
            .join(ChannelRecipient, ChannelRecipient.channel_id == Channel.id)
            .where(ChannelRecipient.user_id == user_id, ChannelRecipient.hidden.is_(False))
        )
    )
    private_channels = private_channel_payloads(db, dm_channels)

    related = related_user_ids(db, user_id)
    people = users_and_characters(db, related, user_id)

    # Unread mentions per channel, and the newest one counted. Both come from one
    # query (one snapshot), so the client can tell which live MESSAGE_CREATEs
    # this count already includes: one sent while READY was being built arrives
    # as an event too, and mustn't be counted twice.
    mention_counts: dict[int, tuple[int, int]] = {
        channel_id: (count, newest)
        for channel_id, count, newest in db.execute(
            select(MessageMention.channel_id, func.count(), func.max(MessageMention.message_id))
            .select_from(MessageMention)
            .outerjoin(
                ReadState,
                and_(ReadState.channel_id == MessageMention.channel_id, ReadState.user_id == user_id),
            )
            .where(MessageMention.user_id == user_id, MessageMention.message_id > func.coalesce(ReadState.last_read_id, 0))
            .group_by(MessageMention.channel_id)
        ).all()
    }
    read_states = []
    seen = set()
    for rs in db.scalars(select(ReadState).where(ReadState.user_id == user_id)):
        seen.add(rs.channel_id)
        count, newest = mention_counts.get(rs.channel_id, (0, 0))
        read_states.append(
            {
                "channel_id": rs.channel_id,
                "last_read_id": rs.last_read_id,
                "last_character_id": rs.last_character_id,
                "mention_count": count,
                "last_mention_id": newest,
            }
        )
    for channel_id, (count, newest) in mention_counts.items():
        if channel_id not in seen:
            read_states.append(
                {"channel_id": channel_id, "last_read_id": 0, "last_character_id": None, "mention_count": count, "last_mention_id": newest}
            )

    personas = []
    if server_ids:
        server_channel_ids = select(Channel.id).where(Channel.server_id.in_(server_ids))
        for rs in db.scalars(
            select(ReadState).where(ReadState.channel_id.in_(server_channel_ids), ReadState.last_character_id.is_not(None), ReadState.last_character_id != 0, ReadState.user_id != user_id)
        ):
            personas.append({"channel_id": rs.channel_id, "user_id": rs.user_id, "character_id": rs.last_character_id})

    return {
        "user": me_payload(user),
        "session_id": session_id,
        "servers": servers,
        "personas": personas,
        "private_channels": private_channels,
        "users": people["users"],
        "characters": people["characters"],
        "read_states": read_states,
        "server_time": iso(utcnow()),
        "limits": {"max_upload_mb": settings.max_upload_mb},
    }


def custom_emoji(db: Session, emoji_id: int) -> Emoji | None:
    return db.get(Emoji, emoji_id)
