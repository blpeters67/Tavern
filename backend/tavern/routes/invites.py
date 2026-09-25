"""Invite links: create, inspect (works logged out), accept, revoke."""

from __future__ import annotations

import re
import secrets
import string
from datetime import timedelta

from fastapi import APIRouter, Depends, Request
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import ApiError, client_ip, current_user, forbidden, not_found, rate_limit
from ..gateway import gateway
from ..models import Invite, Member, Server, User, utcnow
from ..permissions import P
from ..serializers import iso, user_payload
from ..services import join_server, load_channel, load_server, server_member_ids

router = APIRouter(tags=["invites"])

CODE_ALPHABET = string.ascii_letters + string.digits
MAX_AGES = {0, 1800, 3600, 21600, 43200, 86400, 604800}
MAX_USES = {0, 1, 5, 10, 25, 50, 100}


def extract_invite_code(raw: str) -> str:
    """Accept a bare code or a full invite link."""
    raw = (raw or "").strip()
    m = re.search(r"/invite/([A-Za-z0-9]+)", raw)
    if m:
        return m.group(1)
    m = re.search(r"[?&]setup=([A-Za-z0-9]+)", raw)
    if m:
        return m.group(1)
    return re.sub(r"[^A-Za-z0-9]", "", raw)[:32]


def find_invite(db: Session, code: str) -> Invite | None:
    if not code:
        return None
    invite = db.get(Invite, code)
    if invite is None:
        return None
    if invite.expires_at is not None and invite.expires_at <= utcnow():
        return None
    if invite.max_uses and invite.uses >= invite.max_uses:
        return None
    return invite


def invite_payload(db: Session, invite: Invite, *, full: bool = False) -> dict:
    server = db.get(Server, invite.server_id)
    assert server is not None
    member_ids = server_member_ids(db, server.id)
    inviter = db.get(User, invite.inviter_id) if invite.inviter_id else None
    data = {
        "code": invite.code,
        "url": f"{settings.public_url}/invite/{invite.code}",
        "server": {"id": server.id, "name": server.name, "icon": server.icon},
        "channel_id": invite.channel_id,
        "inviter": user_payload(inviter) if inviter else None,
        "member_count": len(member_ids),
        "online_count": sum(1 for uid in member_ids if gateway.is_online(uid)),
        "expires_at": iso(invite.expires_at),
    }
    if full:
        data.update({"uses": invite.uses, "max_uses": invite.max_uses, "created_at": iso(invite.created_at)})
    return data


class InviteIn(BaseModel):
    max_age: int = Field(default=604800)
    max_uses: int = Field(default=0)


@router.post("/api/channels/{channel_id}/invites")
def create_invite(channel_id: int, body: InviteIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, P.CREATE_INVITE)
    if access.channel.server_id is None:
        raise ApiError(400, "You can't make invites for DMs.")
    if body.max_age not in MAX_AGES or body.max_uses not in MAX_USES:
        raise ApiError(400, "Pick one of the listed invite options.")
    code = "".join(secrets.choice(CODE_ALPHABET) for _ in range(8))
    invite = Invite(
        code=code,
        server_id=access.channel.server_id,
        channel_id=channel_id,
        inviter_id=user.id,
        expires_at=(utcnow() + timedelta(seconds=body.max_age)) if body.max_age else None,
        max_uses=body.max_uses,
    )
    db.add(invite)
    db.commit()
    return invite_payload(db, invite, full=True)


@router.get("/api/invites/{code}")
def get_invite(code: str, request: Request, db: Session = Depends(get_db)) -> dict:
    rate_limit(f"invite-view:{client_ip(request)}", 60, 60)
    invite = find_invite(db, extract_invite_code(code))
    if invite is None:
        raise not_found("That invite")
    return invite_payload(db, invite)


@router.post("/api/invites/{code}")
def accept_invite(code: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    invite = find_invite(db, extract_invite_code(code))
    if invite is None:
        raise not_found("That invite")
    server = db.get(Server, invite.server_id)
    if server is None:
        raise not_found("That server")
    already = db.get(Member, (server.id, user.id)) is not None
    if not already:
        join_server(db, user, server, invite)
        db.commit()
    return {"server_id": server.id, "channel_id": invite.channel_id, "already_member": already}


@router.get("/api/servers/{server_id}/invites")
def list_invites(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> list[dict]:
    ctx = load_server(db, server_id, user.id)
    if not ctx.has(user.id, P.MANAGE_SERVER):
        raise forbidden()
    invites = db.scalars(select(Invite).where(Invite.server_id == server_id).order_by(Invite.created_at.desc()))
    return [invite_payload(db, i, full=True) for i in invites if find_invite(db, i.code) is not None]


@router.delete("/api/invites/{code}")
def delete_invite(code: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    invite = db.get(Invite, code)
    if invite is None:
        raise not_found("That invite")
    ctx = load_server(db, invite.server_id, user.id)
    if invite.inviter_id != user.id and not ctx.has(user.id, P.MANAGE_SERVER):
        raise forbidden()
    db.delete(invite)
    db.commit()
    return {"ok": True}
