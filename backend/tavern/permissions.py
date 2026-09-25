"""Discord-style permission bits and resolution.

The frontend has a mirror of this file in `src/lib/permissions.ts`; keep the
bit values in sync. Bits stay below 2**31 so JavaScript bitwise ops work.
"""

from __future__ import annotations

from collections.abc import Iterable
from dataclasses import dataclass, field

from sqlalchemy import select
from sqlalchemy.orm import Session

from .models import Channel, ChannelRecipient, ChannelType, Member, MemberRole, OverwriteType, PermissionOverwrite, Role, Server


class P:
    VIEW_CHANNEL = 1 << 0
    SEND_MESSAGES = 1 << 1
    READ_MESSAGE_HISTORY = 1 << 2
    EMBED_LINKS = 1 << 3
    ATTACH_FILES = 1 << 4
    ADD_REACTIONS = 1 << 5
    MENTION_EVERYONE = 1 << 6
    USE_CHARACTERS = 1 << 7
    PIN_MESSAGES = 1 << 8
    MANAGE_MESSAGES = 1 << 9
    CREATE_INVITE = 1 << 10
    MANAGE_CHANNELS = 1 << 11
    MANAGE_ROLES = 1 << 12
    MANAGE_EMOJIS = 1 << 13
    KICK_MEMBERS = 1 << 14
    BAN_MEMBERS = 1 << 15
    MANAGE_SERVER = 1 << 16
    # Voice spaces
    CONNECT = 1 << 17
    SPEAK = 1 << 18
    STREAM = 1 << 19  # camera and screen share
    MUTE_MEMBERS = 1 << 20
    DEAFEN_MEMBERS = 1 << 21
    MOVE_MEMBERS = 1 << 22  # move between voice spaces and disconnect
    # Roleplay
    DJ = 1 << 23  # control the jukebox (unless DM Lock is on)
    DUNGEON_MASTER = 1 << 24  # roll for others, edit sheets, narrate, DM Lock
    ADMINISTRATOR = 1 << 30

    ALL = ((1 << 25) - 1) | ADMINISTRATOR

    # Permissions that make sense as channel overwrites.
    CHANNEL_MASK = (
        VIEW_CHANNEL
        | SEND_MESSAGES
        | READ_MESSAGE_HISTORY
        | EMBED_LINKS
        | ATTACH_FILES
        | ADD_REACTIONS
        | MENTION_EVERYONE
        | USE_CHARACTERS
        | PIN_MESSAGES
        | MANAGE_MESSAGES
        | CREATE_INVITE
        | MANAGE_CHANNELS
        | MANAGE_ROLES
        | CONNECT
        | SPEAK
        | STREAM
        | MUTE_MEMBERS
        | DEAFEN_MEMBERS
        | MOVE_MEMBERS
    )

    DEFAULT_EVERYONE = (
        VIEW_CHANNEL
        | SEND_MESSAGES
        | READ_MESSAGE_HISTORY
        | EMBED_LINKS
        | ATTACH_FILES
        | ADD_REACTIONS
        | MENTION_EVERYONE
        | USE_CHARACTERS
        | CREATE_INVITE
        | CONNECT
        | SPEAK
        | STREAM
    )

    # What every participant of a DM / group DM can do.
    PRIVATE_CHANNEL = (
        VIEW_CHANNEL
        | SEND_MESSAGES
        | READ_MESSAGE_HISTORY
        | EMBED_LINKS
        | ATTACH_FILES
        | ADD_REACTIONS
        | MENTION_EVERYONE
        | USE_CHARACTERS
        | PIN_MESSAGES
    )


def _apply(perms: int, overwrites: list[PermissionOverwrite], everyone_id: int, role_ids: set[int], user_id: int) -> int:
    """Apply one channel's overwrites in Discord's order: @everyone, roles, member."""
    everyone = next((o for o in overwrites if o.target_type == OverwriteType.ROLE and o.target_id == everyone_id), None)
    if everyone:
        perms = (perms & ~everyone.deny) | everyone.allow
    allow = deny = 0
    for o in overwrites:
        if o.target_type == OverwriteType.ROLE and o.target_id in role_ids:
            allow |= o.allow
            deny |= o.deny
    perms = (perms & ~deny) | allow
    member = next((o for o in overwrites if o.target_type == OverwriteType.MEMBER and o.target_id == user_id), None)
    if member:
        perms = (perms & ~member.deny) | member.allow
    return perms


@dataclass
class ServerContext:
    """Everything needed to answer permission questions for one server,
    loaded once per request."""

    server: Server
    roles: dict[int, Role]
    everyone: Role
    member_roles: dict[int, set[int]]  # user_id -> role ids (excluding @everyone)
    _overwrites: dict[int, list[PermissionOverwrite]] = field(default_factory=dict)
    _channels: dict[int, Channel] = field(default_factory=dict)
    db: Session | None = None

    @classmethod
    def load(cls, db: Session, server: Server) -> "ServerContext":
        roles = {r.id: r for r in db.scalars(select(Role).where(Role.server_id == server.id))}
        everyone = next(r for r in roles.values() if r.is_default)
        member_roles: dict[int, set[int]] = {uid: set() for uid in db.scalars(select(Member.user_id).where(Member.server_id == server.id))}
        for mr in db.scalars(select(MemberRole).where(MemberRole.server_id == server.id)):
            member_roles.setdefault(mr.user_id, set()).add(mr.role_id)
        return cls(server=server, roles=roles, everyone=everyone, member_roles=member_roles, db=db)

    # -- membership -------------------------------------------------------
    def is_member(self, user_id: int) -> bool:
        return user_id in self.member_roles

    @property
    def member_ids(self) -> list[int]:
        return list(self.member_roles.keys())

    def highest_position(self, user_id: int) -> int:
        if user_id == self.server.owner_id:
            return 1 << 30
        return max((self.roles[r].position for r in self.member_roles.get(user_id, ()) if r in self.roles), default=0)

    # -- permissions ------------------------------------------------------
    def base_permissions(self, user_id: int) -> int:
        if user_id not in self.member_roles:
            return 0
        if user_id == self.server.owner_id:
            return P.ALL
        perms = self.everyone.permissions
        for rid in self.member_roles[user_id]:
            role = self.roles.get(rid)
            if role:
                perms |= role.permissions
        if perms & P.ADMINISTRATOR:
            return P.ALL
        return perms

    def overwrites_for(self, channel_id: int) -> list[PermissionOverwrite]:
        if channel_id not in self._overwrites:
            assert self.db is not None
            self._overwrites[channel_id] = list(
                self.db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id == channel_id))
            )
        return self._overwrites[channel_id]

    def preload(self, channels: Iterable[Channel]) -> None:
        """Answering for many channels at once (search): fetch all their
        overwrites in one query instead of one per channel."""
        ids = []
        for ch in channels:
            self._channels[ch.id] = ch
            if ch.id not in self._overwrites:
                self._overwrites[ch.id] = []
                ids.append(ch.id)
        if ids:
            assert self.db is not None
            for o in self.db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id.in_(ids))):
                self._overwrites[o.channel_id].append(o)

    def _channel(self, channel_id: int) -> Channel | None:
        if channel_id not in self._channels:
            assert self.db is not None
            ch = self.db.get(Channel, channel_id)
            if ch is None:
                return None
            self._channels[channel_id] = ch
        return self._channels[channel_id]

    def channel_permissions(self, user_id: int, channel: Channel) -> int:
        if user_id not in self.member_roles:
            return 0
        base = self.base_permissions(user_id)
        if base == P.ALL:
            return base
        role_ids = self.member_roles.get(user_id, set())
        perms = base
        if channel.parent_id:
            parent = self._channel(channel.parent_id)
            if parent is not None:
                perms = _apply(perms, self.overwrites_for(parent.id), self.everyone.id, role_ids, user_id)
        perms = _apply(perms, self.overwrites_for(channel.id), self.everyone.id, role_ids, user_id)
        if not perms & P.VIEW_CHANNEL:
            return 0
        return perms

    def permissions(self, user_id: int, channel: Channel | None = None) -> int:
        if channel is None:
            return self.base_permissions(user_id)
        return self.channel_permissions(user_id, channel)

    def has(self, user_id: int, perm: int, channel: Channel | None = None) -> bool:
        return (self.permissions(user_id, channel) & perm) == perm

    def viewers(self, channel: Channel) -> set[int]:
        return {uid for uid in self.member_roles if self.channel_permissions(uid, channel) & P.VIEW_CHANNEL}

    def is_dm(self, user_id: int) -> bool:
        """Dungeon Master (or better) in this server."""
        return self.has(user_id, P.DUNGEON_MASTER)

    def dm_ids(self) -> set[int]:
        return {uid for uid in self.member_roles if self.is_dm(uid)}

    def can_control_jukebox(self, user_id: int) -> bool:
        """DJs run the jukebox, except while DM Lock is on, when only DMs do."""
        if self.is_dm(user_id):
            return True
        if getattr(self.server, "roleplay_mode", False):
            return False
        return self.has(user_id, P.DJ)

    def can_manage_role(self, user_id: int, role: Role) -> bool:
        if user_id == self.server.owner_id:
            return True
        if not self.has(user_id, P.MANAGE_ROLES):
            return False
        return role.position < self.highest_position(user_id)

    def outranks(self, actor_id: int, target_id: int) -> bool:
        if target_id == self.server.owner_id:
            return False
        if actor_id == self.server.owner_id:
            return True
        return self.highest_position(actor_id) > self.highest_position(target_id)


def private_channel_recipients(db: Session, channel_id: int) -> list[int]:
    return list(db.scalars(select(ChannelRecipient.user_id).where(ChannelRecipient.channel_id == channel_id)))


@dataclass
class ChannelAccess:
    """Resolved view of one channel for one user."""

    channel: Channel
    perms: int
    ctx: ServerContext | None
    recipients: list[int] | None

    def has(self, perm: int) -> bool:
        return (self.perms & perm) == perm

    def audience(self) -> set[int]:
        if self.ctx is not None:
            return self.ctx.viewers(self.channel)
        return set(self.recipients or [])

    @property
    def is_private(self) -> bool:
        return self.channel.type in ChannelType.PRIVATE


def channel_access(db: Session, channel: Channel, user_id: int) -> ChannelAccess:
    if channel.type in ChannelType.PRIVATE:
        recipients = private_channel_recipients(db, channel.id)
        perms = P.PRIVATE_CHANNEL if user_id in recipients else 0
        return ChannelAccess(channel=channel, perms=perms, ctx=None, recipients=recipients)
    server = db.get(Server, channel.server_id)
    assert server is not None
    ctx = ServerContext.load(db, server)
    return ChannelAccess(channel=channel, perms=ctx.channel_permissions(user_id, channel), ctx=ctx, recipients=None)


def bits_in(perms: int, wanted: Iterable[int]) -> bool:
    return all(perms & w for w in wanted)
