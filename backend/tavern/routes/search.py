"""Message search, backed by the SQLite FTS5 index built in db.py."""

from __future__ import annotations

import re

from fastapi import APIRouter, Depends
from sqlalchemy import func, or_, select, text
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import bad_request, current_user, rate_limit
from ..models import Channel, ChannelType, Message, User
from ..permissions import P
from ..serializers import messages_payload
from ..services import load_channel, load_server

router = APIRouter(prefix="/api", tags=["search"])

WORD_RE = re.compile(r"[\w'’-]+", re.UNICODE)


def fts_query(raw: str) -> str | None:
    """Turn what someone typed into a safe FTS5 query: every word must appear,
    the last one as a prefix so results show up while typing."""
    words = [w.replace('"', "") for w in WORD_RE.findall(raw or "")][:12]
    words = [w for w in words if w.strip("'’-")]
    if not words:
        return None
    parts = [f'"{w}"' for w in words[:-1]] + [f'"{words[-1]}"*']
    return " ".join(parts)


@router.get("/search")
def search(
    q: str = "",
    server_id: int | None = None,
    channel_id: int | None = None,
    author_id: int | None = None,
    has: str | None = None,
    limit: int = 25,
    offset: int = 0,
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    rate_limit(f"search:{user.id}", 30, 10)
    limit = max(1, min(50, limit))
    offset = max(0, min(5000, offset))
    query = fts_query(q)
    if query is None and author_id is None and not has:
        raise bad_request("Type something to search for.")

    is_dm = False
    if channel_id is not None:
        access = load_channel(db, channel_id, user.id, P.READ_MESSAGE_HISTORY)
        channel_ids = [channel_id]
        is_dm = access.ctx is not None and access.ctx.is_dm(user.id)
    elif server_id is not None:
        ctx = load_server(db, server_id, user.id)
        channels = list(db.scalars(select(Channel).where(Channel.server_id == server_id)))
        ctx.preload(channels)  # categories too: their overwrites apply to the channels in them
        channel_ids = [c.id for c in channels if c.type == ChannelType.TEXT and ctx.has(user.id, P.VIEW_CHANNEL | P.READ_MESSAGE_HISTORY, c)]
        is_dm = ctx.is_dm(user.id)
    else:
        raise bad_request("Search a server or a channel.")
    if not channel_ids:
        return {"total": 0, "messages": []}

    stmt = select(Message).where(Message.channel_id.in_(channel_ids), Message.type.in_((0, 20)))
    if query is not None:
        stmt = stmt.where(Message.id.in_(select(text("rowid")).select_from(text("messages_fts")).where(text("messages_fts MATCH :q"))))
    if author_id is not None:
        stmt = stmt.where(Message.author_id == author_id)
    if has == "image":
        from ..models import Attachment

        stmt = stmt.where(Message.id.in_(select(Attachment.message_id).where(Attachment.content_type.like("image/%"))))
    elif has == "file":
        from ..models import Attachment

        stmt = stmt.where(Message.id.in_(select(Attachment.message_id)))
    elif has == "roll":
        stmt = stmt.where(Message.type == 20)
    if not is_dm:
        stmt = stmt.where(or_(Message.dm_only.is_(False), Message.author_id == user.id))
    params = {"q": query} if query is not None else {}
    try:
        total = db.scalar(select(func.count()).select_from(stmt.subquery()), params) or 0
        rows = list(db.scalars(stmt.order_by(Message.id.desc()).limit(limit).offset(offset), params))
    except Exception:
        raise bad_request("That search didn't work. Try different words.") from None
    return {"total": total, "messages": messages_payload(db, rows)}
