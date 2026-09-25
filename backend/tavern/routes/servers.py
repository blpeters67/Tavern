"""Servers, members, roles, bans, custom emojis and channel layout."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends, File, Form, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from ..db import get_db, queue_event
from ..deps import ApiError, current_user, field_errors, forbidden, not_found, rate_limit
from ..files import delete_files, save_image
from ..models import (
    Attachment,
    Ban,
    Channel,
    ChannelType,
    Emoji,
    Member,
    MemberRole,
    Message,
    OverwriteType,
    PermissionOverwrite,
    Role,
    Server,
    Track,
    User,
    Video,
)
from ..jukebox import jukebox
from ..theater import theater
from ..permissions import P, ServerContext
from ..voice import voice
from ..serializers import (
    channel_payload,
    emoji_payload,
    iso,
    member_payload,
    role_payload,
    server_payload,
    server_summary,
    user_payload,
)
from ..services import create_server, load_server, remove_member, require_server_perm, users_and_characters

router = APIRouter(prefix="/api/servers", tags=["servers"])

EMOJI_NAME_RE = re.compile(r"^[A-Za-z0-9_]{2,32}$")
MAX_EMOJIS = 200


def _server_summary(server: Server) -> dict:
    return server_summary(server)


def _clean_server_name(name: str) -> str:
    name = " ".join((name or "").split())
    if not 2 <= len(name) <= 100:
        raise field_errors({"name": "Must be between 2 and 100 characters."})
    return name


def clean_channel_name(name: str, type_: int) -> str:
    """Channel names keep their capitals and spaces ("World Building")."""
    name = re.sub(r"[\x00-\x1f\x7f<>]", "", name or "")
    name = " ".join(name.split()).lstrip("#").strip()
    if not 1 <= len(name) <= 100:
        raise field_errors({"name": "Must be between 1 and 100 characters."})
    return name


# ---------------------------------------------------------------------------
# Servers
# ---------------------------------------------------------------------------


@router.post("")
def create(
    name: str = Form(...),
    icon: UploadFile | None = File(None),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    rate_limit(f"server-create:{user.id}", 10, 3600)
    name = _clean_server_name(name)
    icon_name = None
    if icon is not None and icon.filename:
        icon_name, _ = save_image(icon, "icons", square=True, size=256)
    server = create_server(db, user, name, icon_name)
    payload = server_payload(db, server)
    payload.update(users_and_characters(db, [user.id], user.id))
    queue_event(db, [user.id], "SERVER_CREATE", payload)
    db.commit()
    return payload


class ServerPatch(BaseModel):
    name: str | None = Field(default=None, max_length=200)
    system_channel_id: int | None = None
    tagline: str | None = Field(default=None, max_length=200)
    narrator_name: str | None = Field(default=None, max_length=64)


@router.patch("/{server_id}")
def update(server_id: int, body: ServerPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_SERVER)
    server = ctx.server
    if "name" in body.model_fields_set and body.name is not None:
        server.name = _clean_server_name(body.name)
    if "system_channel_id" in body.model_fields_set:
        if body.system_channel_id is None:
            server.system_channel_id = None
        else:
            ch = db.get(Channel, body.system_channel_id)
            if ch is None or ch.server_id != server.id or ch.type != ChannelType.TEXT:
                raise ApiError(400, "Pick a text channel in this server.")
            server.system_channel_id = ch.id
    if "tagline" in body.model_fields_set:
        server.tagline = " ".join((body.tagline or "").split())[:100] or None
    if "narrator_name" in body.model_fields_set:
        server.narrator_name = " ".join((body.narrator_name or "").split())[:32] or None
    queue_event(db, ctx.member_ids, "SERVER_UPDATE", _server_summary(server))
    db.commit()
    return _server_summary(server)


class RoleplayIn(BaseModel):
    enabled: bool


@router.put("/{server_id}/roleplay")
def set_roleplay_mode(server_id: int, body: RoleplayIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """DM Lock (stored as roleplay_mode) hands the jukebox to Dungeon Masters only."""
    ctx = load_server(db, server_id, user.id)
    if not ctx.is_dm(user.id):
        raise forbidden("Only Dungeon Masters can turn DM Lock on or off.")
    ctx.server.roleplay_mode = body.enabled
    queue_event(db, ctx.member_ids, "SERVER_UPDATE", _server_summary(ctx.server))
    db.commit()
    return _server_summary(ctx.server)


@router.put("/{server_id}/icon")
def set_icon(server_id: int, file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_SERVER)
    old = ctx.server.icon
    ctx.server.icon, _ = save_image(file, "icons", square=True, size=256)
    queue_event(db, ctx.member_ids, "SERVER_UPDATE", _server_summary(ctx.server))
    db.commit()
    delete_files("icons", [old])
    return _server_summary(ctx.server)


@router.delete("/{server_id}/icon")
def remove_icon(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_SERVER)
    old = ctx.server.icon
    ctx.server.icon = None
    queue_event(db, ctx.member_ids, "SERVER_UPDATE", _server_summary(ctx.server))
    db.commit()
    delete_files("icons", [old])
    return _server_summary(ctx.server)


@router.delete("/{server_id}")
def delete_server(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    if ctx.server.owner_id != user.id:
        raise forbidden("Only the server owner can delete it.")
    channel_ids = select(Channel.id).where(Channel.server_id == server_id)
    attachment_files = list(
        db.scalars(select(Attachment.file).join(Message, Attachment.message_id == Message.id).where(Message.channel_id.in_(channel_ids)))
    )
    emoji_files = list(db.scalars(select(Emoji.file).where(Emoji.server_id == server_id)))
    tracks = list(db.scalars(select(Track).where(Track.server_id == server_id)))
    music_files = [t.file for t in tracks]
    cover_files = [t.cover for t in tracks]
    videos = list(db.scalars(select(Video).where(Video.server_id == server_id)))
    video_files = [v.file for v in videos]
    poster_files = [v.poster for v in videos]
    icon = ctx.server.icon
    members = ctx.member_ids
    db.delete(ctx.server)
    queue_event(db, members, "SERVER_DELETE", {"id": server_id})
    db.commit()
    voice.disconnect_server(server_id)
    jukebox.forget(server_id)
    theater.forget(server_id)
    delete_files("attachments", attachment_files)
    delete_files("emojis", emoji_files)
    delete_files("icons", [icon])
    delete_files("music", music_files)
    delete_files("covers", cover_files)
    delete_files("videos", video_files)
    delete_files("posters", poster_files)
    return {"ok": True}


class TransferIn(BaseModel):
    user_id: int


@router.post("/{server_id}/transfer")
def transfer(server_id: int, body: TransferIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    if ctx.server.owner_id != user.id:
        raise forbidden("Only the owner can transfer ownership.")
    if not ctx.is_member(body.user_id):
        raise not_found("That member")
    ctx.server.owner_id = body.user_id
    queue_event(db, ctx.member_ids, "SERVER_UPDATE", _server_summary(ctx.server))
    db.commit()
    return _server_summary(ctx.server)


# ---------------------------------------------------------------------------
# Members & bans
# ---------------------------------------------------------------------------


@router.delete("/{server_id}/members/@me")
def leave(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    if ctx.server.owner_id == user.id:
        raise ApiError(400, "You own this server. Transfer ownership or delete the server instead.")
    remove_member(db, ctx, user.id)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/members/{user_id}")
def kick(server_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.KICK_MEMBERS)
    if not ctx.is_member(user_id):
        raise not_found("That member")
    if user_id == user.id or not ctx.outranks(user.id, user_id):
        raise forbidden("You can only kick members below your highest role.")
    remove_member(db, ctx, user_id)
    db.commit()
    return {"ok": True}


class BanIn(BaseModel):
    reason: str | None = Field(default=None, max_length=512)


@router.put("/{server_id}/bans/{user_id}")
def ban(server_id: int, user_id: int, body: BanIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.BAN_MEMBERS)
    if user_id == user.id or user_id == ctx.server.owner_id:
        raise forbidden("You can't ban that person.")
    if ctx.is_member(user_id) and not ctx.outranks(user.id, user_id):
        raise forbidden("You can only ban members below your highest role.")
    if db.get(User, user_id) is None:
        raise not_found("That user")
    if db.get(Ban, (server_id, user_id)) is None:
        db.add(Ban(server_id=server_id, user_id=user_id, reason=(body.reason or "").strip() or None, moderator_id=user.id))
    if ctx.is_member(user_id):
        remove_member(db, ctx, user_id)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/bans/{user_id}")
def unban(server_id: int, user_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.BAN_MEMBERS)
    db.execute(delete(Ban).where(Ban.server_id == server_id, Ban.user_id == user_id))
    db.commit()
    return {"ok": True}


@router.get("/{server_id}/bans")
def list_bans(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.BAN_MEMBERS)
    out = []
    for b in db.scalars(select(Ban).where(Ban.server_id == server_id).order_by(Ban.created_at.desc())):
        banned = db.get(User, b.user_id)
        if banned is not None:
            out.append({"user": user_payload(banned), "reason": b.reason, "created_at": iso(b.created_at)})
    return out


def _publish_member(db: Session, ctx: ServerContext, user_id: int) -> None:
    member = db.get(Member, (ctx.server.id, user_id))
    if member is None:
        return
    role_ids = list(db.scalars(select(MemberRole.role_id).where(MemberRole.server_id == ctx.server.id, MemberRole.user_id == user_id)))
    queue_event(db, ctx.member_ids, "MEMBER_UPDATE", member_payload(member, role_ids))


@router.put("/{server_id}/members/{user_id}/roles/{role_id}")
def add_member_role(server_id: int, user_id: int, role_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    role = ctx.roles.get(role_id)
    if role is None or role.is_default:
        raise not_found("That role")
    if not ctx.is_member(user_id):
        raise not_found("That member")
    if not ctx.can_manage_role(user.id, role):
        raise forbidden("You can only give out roles below your highest role.")
    if db.get(MemberRole, (server_id, user_id, role_id)) is None:
        db.add(MemberRole(server_id=server_id, user_id=user_id, role_id=role_id))
        db.flush()
    _publish_member(db, ctx, user_id)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/members/{user_id}/roles/{role_id}")
def remove_member_role(
    server_id: int, user_id: int, role_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    ctx = load_server(db, server_id, user.id)
    role = ctx.roles.get(role_id)
    if role is None or role.is_default:
        raise not_found("That role")
    if not ctx.can_manage_role(user.id, role):
        raise forbidden("You can only manage roles below your highest role.")
    db.execute(delete(MemberRole).where(MemberRole.server_id == server_id, MemberRole.user_id == user_id, MemberRole.role_id == role_id))
    db.flush()
    _publish_member(db, ctx, user_id)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Roles
# ---------------------------------------------------------------------------


def _publish_roles(db: Session, ctx: ServerContext) -> list[dict]:
    db.flush()
    roles = [role_payload(r) for r in db.scalars(select(Role).where(Role.server_id == ctx.server.id))]
    queue_event(db, ctx.member_ids, "ROLES_UPDATE", {"server_id": ctx.server.id, "roles": roles})
    return roles


def _check_grant(ctx: ServerContext, user_id: int, old: int, new: int) -> None:
    """Non-owners can't hand out permissions they don't have themselves."""
    mine = ctx.base_permissions(user_id)
    if mine == P.ALL:
        return
    if (old ^ new) & ~mine:
        raise forbidden("You can't grant or remove permissions you don't have.")


class RoleIn(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    color: int | None = Field(default=None, ge=0, le=0xFFFFFF)
    permissions: int | None = Field(default=None, ge=0)
    hoist: bool | None = None
    mentionable: bool | None = None


@router.post("/{server_id}/roles")
def create_role(server_id: int, body: RoleIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_ROLES)
    if len(ctx.roles) >= 250:
        raise ApiError(400, "That's a lot of roles. Delete some first.")
    perms = (body.permissions if body.permissions is not None else 0) & P.ALL
    _check_grant(ctx, user.id, 0, perms)
    # New roles go to the bottom, just above @everyone.
    for r in ctx.roles.values():
        if not r.is_default:
            r.position += 1
    role = Role(
        server_id=server_id,
        name=(body.name or "new role").strip()[:100] or "new role",
        color=body.color or 0,
        permissions=perms,
        position=1,
        hoist=bool(body.hoist),
        mentionable=bool(body.mentionable),
    )
    db.add(role)
    db.flush()
    _publish_roles(db, ctx)
    db.commit()
    return role_payload(role)


@router.patch("/{server_id}/roles/{role_id}")
def update_role(server_id: int, role_id: int, body: RoleIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    role = ctx.roles.get(role_id)
    if role is None:
        raise not_found("That role")
    if role.is_default:
        require_server_perm(ctx, user.id, P.MANAGE_ROLES)
    elif not ctx.can_manage_role(user.id, role):
        raise forbidden("You can only edit roles below your highest role.")
    fields = body.model_fields_set
    if "name" in fields and body.name is not None and not role.is_default:
        name = body.name.strip()
        if not 1 <= len(name) <= 100:
            raise field_errors({"name": "Must be between 1 and 100 characters."})
        role.name = name
    if "color" in fields and body.color is not None and not role.is_default:
        role.color = body.color
    if "permissions" in fields and body.permissions is not None:
        new = body.permissions & P.ALL
        _check_grant(ctx, user.id, role.permissions, new)
        role.permissions = new
    if "hoist" in fields and body.hoist is not None and not role.is_default:
        role.hoist = body.hoist
    if "mentionable" in fields and body.mentionable is not None and not role.is_default:
        role.mentionable = body.mentionable
    _publish_roles(db, ctx)
    db.commit()
    return role_payload(role)


@router.delete("/{server_id}/roles/{role_id}")
def delete_role(server_id: int, role_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    role = ctx.roles.get(role_id)
    if role is None or role.is_default:
        raise not_found("That role")
    if not ctx.can_manage_role(user.id, role):
        raise forbidden("You can only delete roles below your highest role.")
    affected_members = [uid for uid, rids in ctx.member_roles.items() if role_id in rids]
    affected_channels = list(
        db.scalars(
            select(PermissionOverwrite.channel_id).where(
                PermissionOverwrite.target_type == OverwriteType.ROLE, PermissionOverwrite.target_id == role_id
            )
        )
    )
    db.execute(
        delete(PermissionOverwrite).where(PermissionOverwrite.target_type == OverwriteType.ROLE, PermissionOverwrite.target_id == role_id)
    )
    db.execute(delete(MemberRole).where(MemberRole.role_id == role_id))
    removed_position = role.position
    db.delete(role)
    for r in ctx.roles.values():
        if r.id != role_id and not r.is_default and r.position > removed_position:
            r.position -= 1
    db.flush()
    ctx.roles.pop(role_id, None)
    queue_event(db, ctx.member_ids, "ROLE_DELETE", {"server_id": server_id, "role_id": role_id})
    _publish_roles(db, ctx)
    for uid in affected_members:
        _publish_member(db, ctx, uid)
    for cid in set(affected_channels):
        ch = db.get(Channel, cid)
        if ch is not None:
            ows = db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id == cid))
            queue_event(db, ctx.member_ids, "CHANNEL_UPDATE", channel_payload(ch, ows))
    db.commit()
    return {"ok": True}


class RoleOrderIn(BaseModel):
    role_ids: list[int]  # top to bottom, excluding @everyone


@router.put("/{server_id}/roles/order")
def reorder_roles(server_id: int, body: RoleOrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_ROLES)
    movable = {r.id: r for r in ctx.roles.values() if not r.is_default}
    if sorted(body.role_ids) != sorted(movable):
        raise ApiError(400, "The role list is out of date. Refresh and try again.")
    my_top = ctx.highest_position(user.id)
    count = len(body.role_ids)
    changes = {}
    for index, rid in enumerate(body.role_ids):
        new_pos = count - index
        role = movable[rid]
        if role.position != new_pos:
            if role.position >= my_top or new_pos >= my_top:
                raise forbidden("You can't move roles at or above your highest role.")
            changes[rid] = new_pos
    for rid, pos in changes.items():
        movable[rid].position = pos
    roles = _publish_roles(db, ctx)
    db.commit()
    return roles


# ---------------------------------------------------------------------------
# Custom emojis
# ---------------------------------------------------------------------------


def _publish_emojis(db: Session, ctx: ServerContext) -> list[dict]:
    db.flush()
    emojis = [emoji_payload(e) for e in db.scalars(select(Emoji).where(Emoji.server_id == ctx.server.id))]
    queue_event(db, ctx.member_ids, "EMOJIS_UPDATE", {"server_id": ctx.server.id, "emojis": emojis})
    return emojis


@router.post("/{server_id}/emojis")
def create_emoji(
    server_id: int,
    name: str = Form(...),
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_EMOJIS)
    name = name.strip().strip(":").replace(" ", "_").replace("-", "_")
    if not EMOJI_NAME_RE.match(name):
        raise field_errors({"name": "Emoji names need 2-32 letters, numbers or underscores."})
    if db.scalar(select(Emoji.id).where(Emoji.server_id == server_id, Emoji.name == name)):
        raise field_errors({"name": "This server already has an emoji with that name."})
    if (db.scalar(select(func.count()).select_from(Emoji).where(Emoji.server_id == server_id)) or 0) >= MAX_EMOJIS:
        raise ApiError(400, f"Servers can have up to {MAX_EMOJIS} emojis.")
    stored, animated = save_image(file, "emojis", square=False, size=128, limit_mb=2)
    emoji = Emoji(server_id=server_id, name=name, file=stored, animated=animated, creator_id=user.id)
    db.add(emoji)
    _publish_emojis(db, ctx)
    db.commit()
    return emoji_payload(emoji)


class EmojiPatch(BaseModel):
    name: str = Field(max_length=64)


@router.patch("/{server_id}/emojis/{emoji_id}")
def rename_emoji(
    server_id: int, emoji_id: int, body: EmojiPatch, user: User = Depends(current_user), db: Session = Depends(get_db)
) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_EMOJIS)
    emoji = db.get(Emoji, emoji_id)
    if emoji is None or emoji.server_id != server_id:
        raise not_found("That emoji")
    name = body.name.strip().strip(":").replace(" ", "_").replace("-", "_")
    if not EMOJI_NAME_RE.match(name):
        raise field_errors({"name": "Emoji names need 2-32 letters, numbers or underscores."})
    clash = db.scalar(select(Emoji.id).where(Emoji.server_id == server_id, Emoji.name == name))
    if clash and clash != emoji_id:
        raise field_errors({"name": "This server already has an emoji with that name."})
    emoji.name = name
    _publish_emojis(db, ctx)
    db.commit()
    return emoji_payload(emoji)


@router.delete("/{server_id}/emojis/{emoji_id}")
def delete_emoji(server_id: int, emoji_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_EMOJIS)
    emoji = db.get(Emoji, emoji_id)
    if emoji is None or emoji.server_id != server_id:
        raise not_found("That emoji")
    stored = emoji.file
    db.delete(emoji)
    _publish_emojis(db, ctx)
    db.commit()
    delete_files("emojis", [stored])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Channels (creation + layout; editing lives in channels.py)
# ---------------------------------------------------------------------------


class ChannelIn(BaseModel):
    name: str = Field(max_length=200)
    type: int = ChannelType.TEXT
    parent_id: int | None = None
    topic: str | None = Field(default=None, max_length=1024)
    emoji: str | None = Field(default=None, max_length=64)
    user_limit: int = Field(default=0, ge=0, le=99)


@router.post("/{server_id}/channels")
def create_channel(server_id: int, body: ChannelIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    if body.type not in (ChannelType.TEXT, ChannelType.VOICE, ChannelType.CATEGORY):
        raise ApiError(400, "Unknown channel type.")
    parent = None
    if body.parent_id is not None and body.type in (ChannelType.TEXT, ChannelType.VOICE):
        parent = db.get(Channel, body.parent_id)
        if parent is None or parent.server_id != server_id or parent.type != ChannelType.CATEGORY:
            raise ApiError(400, "That category doesn't exist.")
    # Creating inside a category needs Manage Channels there; otherwise server-wide.
    if not ctx.has(user.id, P.MANAGE_CHANNELS, parent):
        raise forbidden()
    if (db.scalar(select(func.count()).select_from(Channel).where(Channel.server_id == server_id)) or 0) >= 500:
        raise ApiError(400, "This server has too many channels.")

    name = clean_channel_name(body.name, body.type)
    if body.type == ChannelType.CATEGORY:
        siblings = select(func.max(Channel.position)).where(Channel.server_id == server_id, Channel.type == ChannelType.CATEGORY)
    else:
        siblings = select(func.max(Channel.position)).where(
            Channel.server_id == server_id,
            Channel.type == body.type,
            Channel.parent_id == parent.id if parent else Channel.parent_id.is_(None),
        )
    position = (db.scalar(siblings) or 0) + 1
    channel = Channel(
        server_id=server_id,
        type=body.type,
        name=name,
        topic=(body.topic or "").strip() or None if body.type == ChannelType.TEXT else None,
        parent_id=parent.id if parent else None,
        position=position,
        emoji=clean_channel_emoji(db, server_id, body.emoji) if body.type != ChannelType.CATEGORY else None,
        user_limit=body.user_limit if body.type == ChannelType.VOICE else 0,
    )
    db.add(channel)
    db.flush()
    payload = channel_payload(channel, [])
    queue_event(db, ctx.member_ids, "CHANNEL_CREATE", payload)
    db.commit()
    return payload


def clean_channel_emoji(db: Session, server_id: int | None, raw: str | None) -> str | None:
    """A channel icon: one unicode emoji, or "c:<id>" for this server's emoji."""
    raw = (raw or "").strip()
    if not raw:
        return None
    m = re.fullmatch(r"c:(\d+)", raw)
    if m:
        emoji = db.get(Emoji, int(m.group(1)))
        if emoji is None or emoji.server_id != server_id:
            raise field_errors({"emoji": "That emoji isn't from this server."})
        return f"c:{emoji.id}"
    if len(raw) > 16 or raw.isascii() or any(ch.isspace() for ch in raw):
        raise field_errors({"emoji": "Pick a single emoji."})
    return raw


class ChannelPosition(BaseModel):
    id: int
    position: int
    parent_id: int | None = None


@router.patch("/{server_id}/channels")
def reorder_channels(
    server_id: int, body: list[ChannelPosition], user: User = Depends(current_user), db: Session = Depends(get_db)
) -> list[dict]:
    ctx = load_server(db, server_id, user.id)
    require_server_perm(ctx, user.id, P.MANAGE_CHANNELS)
    channels = {c.id: c for c in db.scalars(select(Channel).where(Channel.server_id == server_id))}
    changed = []
    for item in body:
        ch = channels.get(item.id)
        if ch is None:
            raise ApiError(400, "That channel isn't in this server.")
        parent_id = item.parent_id if ch.type in (ChannelType.TEXT, ChannelType.VOICE) else None
        if parent_id is not None:
            parent = channels.get(parent_id)
            if parent is None or parent.type != ChannelType.CATEGORY:
                raise ApiError(400, "That category doesn't exist.")
        if ch.position != item.position or ch.parent_id != parent_id:
            ch.position = item.position
            ch.parent_id = parent_id
            changed.append(ch)
    db.flush()
    out = []
    for ch in changed:
        ows = list(db.scalars(select(PermissionOverwrite).where(PermissionOverwrite.channel_id == ch.id)))
        payload = channel_payload(ch, ows)
        out.append(payload)
        queue_event(db, ctx.member_ids, "CHANNEL_UPDATE", payload)
    db.commit()
    return out
