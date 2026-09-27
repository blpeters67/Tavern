"""Game board HTTP API: the saved boards, their backgrounds, tokens and
drawings. Running a board (creating and switching boards, backgrounds, other
people's tokens) needs the same rights as the jukebox: DJs normally, only
Dungeon Masters while DM Lock is on. Players place and move their own
character's token; anyone can draw."""

from __future__ import annotations

import re
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from ..board import (
    DISPOSITIONS,
    MAX_BOARDS,
    MAX_DRAWINGS,
    MAX_STROKE_POINTS,
    MAX_TEXT,
    MAX_TOKENS,
    board,
    bump_rev,
    drawing_payload,
    publish_state,
    token_payload,
)
from ..config import settings
from ..db import get_db, queue_event
from ..deps import bad_request, current_user, forbidden, not_found, rate_limit
from ..files import delete_files, save_board_image, save_image
from ..models import Board, BoardDrawing, BoardToken, Channel, ChannelType, Character, User
from ..permissions import ServerContext
from ..security import random_key
from ..services import load_server

router = APIRouter(prefix="/api/servers", tags=["board"])

COLOR_RE = re.compile(r"#[0-9a-fA-F]{6}")


def _require_control(ctx: ServerContext, user: User) -> None:
    if not ctx.can_control_jukebox(user.id):
        if ctx.server.roleplay_mode:
            raise forbidden("DM Lock is on, so only Dungeon Masters can run the game board.")
        raise forbidden("You need the DJ role to run the game board.")


def _get_board(db: Session, server_id: int, board_id: int) -> Board:
    row = db.get(Board, board_id)
    if row is None or row.server_id != server_id:
        raise not_found("That board")
    return row


def _get_token(db: Session, row: Board, token_id: int) -> BoardToken:
    t = db.get(BoardToken, token_id)
    if t is None or t.board_id != row.id:
        raise not_found("That token")
    return t


def _token_character(db: Session, t: BoardToken) -> Character | None:
    return db.get(Character, t.character_id) if t.character_id else None


def _may_edit_token(db: Session, ctx: ServerContext, user_id: int, t: BoardToken) -> bool:
    """Whoever runs the board may touch any token; players only their own characters'."""
    if ctx.can_control_jukebox(user_id):
        return True
    if t.character_id is not None:
        ch = db.get(Character, t.character_id)
        return ch is not None and ch.owner_id == user_id
    return False


def _clean_tracker(entries: list[dict[str, Any]]) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    for e in entries[:50]:
        if not isinstance(e, dict):
            continue
        item: dict[str, Any] = {
            "id": str(e.get("id") or random_key(4))[:16],
            "name": str(e.get("name") or "?")[:80],
            "token_id": e.get("token_id") if isinstance(e.get("token_id"), int) else None,
            "current": bool(e.get("current")),
        }
        init = e.get("initiative")
        if isinstance(init, (int, float)):
            item["initiative"] = int(init)
        elif init is not None:
            item["initiative"] = str(init)[:12]
        out.append(item)
    return out


# ---------------------------------------------------------------------------
# The board itself
# ---------------------------------------------------------------------------


@router.get("/{server_id}/board")
def get_board(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    return board.payload(db, ctx.server)


class BoardIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)


@router.post("/{server_id}/board/boards")
def create_board(server_id: int, body: BoardIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    count = len(list(db.scalars(select(Board.id).where(Board.server_id == server_id))))
    if count >= MAX_BOARDS:
        raise bad_request(f"A server holds up to {MAX_BOARDS} boards.")
    name = " ".join(body.name.split())[:100] or "New board"
    row = Board(server_id=server_id, name=name, created_by=user.id)
    db.add(row)
    db.flush()
    # The first board becomes the one everyone sees; later ones wait to be picked.
    if ctx.server.active_board_id is None:
        ctx.server.active_board_id = row.id
    publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    return {"id": row.id}


class BoardPatch(BaseModel):
    name: str | None = Field(default=None, max_length=100)
    grid_size: int | None = Field(default=None, ge=20, le=400)
    snap: bool | None = None
    channel_id: int | None = None
    tracker: list[dict[str, Any]] | None = None


@router.patch("/{server_id}/board/boards/{board_id}")
def edit_board(server_id: int, board_id: int, body: BoardPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    fields = body.model_fields_set
    changed = False
    if "name" in fields and body.name is not None:
        name = " ".join(body.name.split())
        if not name:
            raise bad_request("Boards need a name.")
        row.name = name[:100]
        changed = True
    if "grid_size" in fields and body.grid_size is not None:
        row.grid_size = body.grid_size
        changed = True
    if "snap" in fields and body.snap is not None:
        row.snap = bool(body.snap)
        changed = True
    if "channel_id" in fields:
        # The board's own channel: its rolls land there. Must be a text channel
        # of this server; None clears it.
        if body.channel_id is None:
            row.channel_id = None
        else:
            ch = db.get(Channel, body.channel_id)
            if ch is None or ch.server_id != server_id or ch.type != ChannelType.TEXT:
                raise bad_request("Pick a text channel from this server.")
            row.channel_id = ch.id
        changed = True
    if "tracker" in fields and body.tracker is not None:
        row.tracker = _clean_tracker(body.tracker)
        changed = True
    if changed:
        bump_rev(row)
        publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/board/boards/{board_id}")
def delete_board(server_id: int, board_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    background = row.background
    avatars = list(db.scalars(select(BoardToken.avatar).where(BoardToken.board_id == row.id)))
    db.delete(row)
    if ctx.server.active_board_id == row.id:
        remaining = [b.id for b in db.scalars(select(Board).where(Board.server_id == server_id)) if b.id != row.id]
        ctx.server.active_board_id = remaining[0] if remaining else None
    publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    delete_files("boards", [background, *avatars])
    return {"ok": True}


@router.post("/{server_id}/board/boards/{board_id}/activate")
def activate_board(server_id: int, board_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    ctx.server.active_board_id = row.id
    publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Background picture
# ---------------------------------------------------------------------------


@router.post("/{server_id}/board/boards/{board_id}/background")
def set_background(
    server_id: int,
    board_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    rate_limit(f"board-bg:{user.id}", 20, 600)
    name, width, height = save_board_image(file, settings.board_max_mb * 1024 * 1024)
    old = row.background
    row.background = name
    row.bg_width, row.bg_height = width, height
    bump_rev(row)
    publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    delete_files("boards", [old])
    return {"ok": True, "background_url": f"/cdn/boards/{row.id}/{name}", "bg_width": width, "bg_height": height}


@router.delete("/{server_id}/board/boards/{board_id}/background")
def clear_background(server_id: int, board_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    old = row.background
    row.background = None
    row.bg_width = None
    row.bg_height = None
    bump_rev(row)
    publish_state(db, ctx.server, ctx.member_ids)
    db.commit()
    delete_files("boards", [old])
    return {"ok": True}


# ---------------------------------------------------------------------------
# Tokens
# ---------------------------------------------------------------------------


class TokenIn(BaseModel):
    character_id: int | None = None
    name: str | None = Field(default=None, max_length=80)
    x: float = 0
    y: float = 0
    disposition: str = "neutral"
    size: int = Field(default=1, ge=1, le=6)


@router.post("/{server_id}/board/boards/{board_id}/tokens")
def add_token(server_id: int, board_id: int, body: TokenIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    row = _get_board(db, server_id, board_id)
    control = ctx.can_control_jukebox(user.id)
    character: Character | None = None
    if body.character_id is not None:
        character = db.get(Character, body.character_id)
        if character is None or character.deleted:
            raise not_found("That character")
        if not control and character.owner_id != user.id:
            raise forbidden("You can only place your own character's token.")
        existing = db.scalar(select(BoardToken.id).where(BoardToken.board_id == row.id, BoardToken.character_id == character.id))
        if existing is not None:
            raise bad_request(f"{character.name} is already on this board.")
        name = None
    else:
        if not control:
            raise forbidden("Only whoever runs the board can place tokens that aren't a character.")
        name = " ".join((body.name or "").split())[:80]
        if not name:
            raise bad_request("Tokens need a name.")
    count = len(list(db.scalars(select(BoardToken.id).where(BoardToken.board_id == row.id))))
    if count >= MAX_TOKENS:
        raise bad_request(f"A board holds up to {MAX_TOKENS} tokens.")
    t = BoardToken(
        board_id=row.id,
        character_id=character.id if character is not None else None,
        name=name,
        x=max(-50000.0, min(50000.0, float(body.x))),
        y=max(-50000.0, min(50000.0, float(body.y))),
        disposition=body.disposition if body.disposition in DISPOSITIONS else "neutral",
        size=body.size,
        owner_id=character.owner_id if character is not None else None,
    )
    db.add(t)
    db.flush()
    payload = token_payload(t, character)
    queue_event(db, ctx.member_ids, "BOARD_TOKEN_CREATE", payload)
    db.commit()
    return payload


class TokenPatch(BaseModel):
    x: float | None = None
    y: float | None = None
    disposition: str | None = None
    size: int | None = Field(default=None, ge=1, le=6)
    name: str | None = Field(default=None, max_length=80)
    hp: int | None = Field(default=None, ge=0, le=100000)
    hp_max: int | None = Field(default=None, ge=0, le=100000)


@router.patch("/{server_id}/board/boards/{board_id}/tokens/{token_id}")
def move_token(server_id: int, board_id: int, token_id: int, body: TokenPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Dragging sends these often: the client throttles to ~10 a second, and
    the final position is always sent again when the drag ends."""
    ctx = load_server(db, server_id, user.id)
    row = _get_board(db, server_id, board_id)
    t = _get_token(db, row, token_id)
    if not _may_edit_token(db, ctx, user.id, t):
        raise forbidden("You can only move your own character's token.")
    control = ctx.can_control_jukebox(user.id)
    fields = body.model_fields_set
    if ("x" in fields and body.x is not None) or ("y" in fields and body.y is not None):
        rate_limit(f"board-token:{user.id}", 150, 10)
        if "x" in fields and body.x is not None:
            t.x = max(-50000.0, min(50000.0, float(body.x)))
        if "y" in fields and body.y is not None:
            t.y = max(-50000.0, min(50000.0, float(body.y)))
    if "disposition" in fields and body.disposition is not None:
        if body.disposition not in DISPOSITIONS:
            raise bad_request("Unknown disposition.")
        t.disposition = body.disposition
    if "size" in fields and body.size is not None:
        t.size = body.size
    if control:
        if "name" in fields and body.name is not None and t.character_id is None:
            name = " ".join(body.name.split())[:80]
            if name:
                t.name = name
        if "hp" in fields:
            t.hp = body.hp
        if "hp_max" in fields:
            t.hp_max = body.hp_max
    character = _token_character(db, t)
    payload = token_payload(t, character)
    queue_event(db, ctx.member_ids, "BOARD_TOKEN_UPDATE", payload)
    db.commit()
    return payload


@router.delete("/{server_id}/board/boards/{board_id}/tokens/{token_id}")
def remove_token(server_id: int, board_id: int, token_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    row = _get_board(db, server_id, board_id)
    t = _get_token(db, row, token_id)
    if not _may_edit_token(db, ctx, user.id, t):
        raise forbidden("You can only remove your own character's token.")
    avatar = t.avatar
    db.delete(t)
    queue_event(db, ctx.member_ids, "BOARD_TOKEN_DELETE", {"server_id": server_id, "board_id": row.id, "token_id": token_id})
    db.commit()
    delete_files("boards", [avatar])
    return {"ok": True}


@router.post("/{server_id}/board/boards/{board_id}/tokens/{token_id}/avatar")
def set_token_avatar(
    server_id: int,
    board_id: int,
    token_id: int,
    file: UploadFile = File(...),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """A picture for a free token (an NPC, a marker). Character tokens always
    wear their character's picture."""
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    t = _get_token(db, row, token_id)
    if t.character_id is not None:
        raise bad_request("That token wears its character's picture.")
    rate_limit(f"board-avatar:{user.id}", 30, 600)
    name, _animated = save_image(file, "boards", square=True, size=256)
    old = t.avatar
    t.avatar = name
    queue_event(db, ctx.member_ids, "BOARD_TOKEN_UPDATE", token_payload(t))
    db.commit()
    delete_files("boards", [old])
    return {"ok": True, "avatar": name}


# ---------------------------------------------------------------------------
# Drawings (pen, arrows, shapes, text)
# ---------------------------------------------------------------------------


def _point(p: Any) -> list[float] | None:
    if isinstance(p, (list, tuple)) and len(p) == 2:
        try:
            x, y = float(p[0]), float(p[1])
        except (TypeError, ValueError):
            return None
        if -50000 <= x <= 50000 and -50000 <= y <= 50000:
            return [round(x, 1), round(y, 1)]
    return None


def _clean_drawing(kind: str, data: dict[str, Any]) -> dict[str, Any]:
    if kind == "pen":
        points = [pt for pt in (_point(p) for p in (data.get("points") or [])) if pt][:MAX_STROKE_POINTS]
        if len(points) < 2:
            raise bad_request("That stroke had no points in it.")
        return {"points": points}
    if kind in ("arrow", "line", "rect", "ellipse"):
        a, b = _point(data.get("from")), _point(data.get("to"))
        if a is None or b is None:
            raise bad_request("That shape had no ends.")
        return {"from": a, "to": b}
    if kind == "text":
        at = _point(data.get("at"))
        text = " ".join(str(data.get("text") or "").split())[:MAX_TEXT]
        if at is None or not text:
            raise bad_request("That label had no text.")
        try:
            size = int(data.get("size") or 24)
        except (TypeError, ValueError):
            size = 24
        return {"at": at, "text": text, "size": max(10, min(96, size))}
    raise bad_request("Unknown drawing.")


class DrawingIn(BaseModel):
    kind: Literal["pen", "arrow", "line", "rect", "ellipse", "text"]
    color: str = "#e5484d"
    width: float = 3.0
    data: dict[str, Any] = Field(default_factory=dict)


@router.post("/{server_id}/board/boards/{board_id}/drawings")
def add_drawing(server_id: int, board_id: int, body: DrawingIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    row = _get_board(db, server_id, board_id)
    rate_limit(f"board-draw:{user.id}", 240, 10)
    data = _clean_drawing(body.kind, body.data)
    color = body.color if COLOR_RE.fullmatch(body.color or "") else "#e5484d"
    width = max(1.0, min(24.0, float(body.width or 3)))
    d = BoardDrawing(board_id=row.id, kind=body.kind, color=color, width=width, data=data, author_id=user.id)
    db.add(d)
    db.flush()
    # Keep the newest drawings only; clients are told what fell off.
    ids = list(db.scalars(select(BoardDrawing.id).where(BoardDrawing.board_id == row.id).order_by(BoardDrawing.id)))
    pruned = ids[: max(0, len(ids) - MAX_DRAWINGS)]
    if pruned:
        db.execute(delete(BoardDrawing).where(BoardDrawing.id.in_(pruned)))
        for old_id in pruned:
            queue_event(db, ctx.member_ids, "BOARD_DRAW_DELETE", {"server_id": server_id, "board_id": row.id, "drawing_id": old_id})
    payload = drawing_payload(d)
    queue_event(db, ctx.member_ids, "BOARD_DRAW_ADD", payload)
    db.commit()
    return payload


@router.delete("/{server_id}/board/boards/{board_id}/drawings/{drawing_id}")
def remove_drawing(server_id: int, board_id: int, drawing_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Undo: your own last stroke, or anything when you run the board."""
    ctx = load_server(db, server_id, user.id)
    row = _get_board(db, server_id, board_id)
    d = db.get(BoardDrawing, drawing_id)
    if d is None or d.board_id != row.id:
        raise not_found("That drawing")
    if d.author_id != user.id and not ctx.can_control_jukebox(user.id):
        raise forbidden("You can only undo your own drawing.")
    db.delete(d)
    queue_event(db, ctx.member_ids, "BOARD_DRAW_DELETE", {"server_id": server_id, "board_id": row.id, "drawing_id": drawing_id})
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/board/boards/{board_id}/drawings")
def clear_drawings(server_id: int, board_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    row = _get_board(db, server_id, board_id)
    db.execute(delete(BoardDrawing).where(BoardDrawing.board_id == row.id))
    queue_event(db, ctx.member_ids, "BOARD_DRAWS_CLEAR", {"server_id": server_id, "board_id": row.id})
    db.commit()
    return {"ok": True}
