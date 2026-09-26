"""The game board: one shared battle map per server that everyone looks at
together — like the theater, but with tokens, drawings and a grid.

The board itself lives in the database (boards, board_tokens, board_drawings).
What's kept in memory is only who has the board open right now, the same way
the theater keeps track of its audience.
"""

from __future__ import annotations

import logging
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import queue_event
from .gateway import gateway
from .models import Board, BoardDrawing, BoardToken, Character, Member, Server

log = logging.getLogger("tavern.board")

# The ring colours: ally is green, enemy is red, everything else is grey.
DISPOSITIONS = ("ally", "neutral", "enemy")
# What can be drawn on a board (the ruler is a local measuring tool, not saved).
DRAW_KINDS = ("pen", "arrow", "rect", "ellipse", "text")
# A board keeps at most this many drawings; the oldest fall off.
MAX_DRAWINGS = 2000
# Most points in one pen stroke, and the longest text label.
MAX_STROKE_POINTS = 4000
MAX_TEXT = 500
# Caps per server / board, so one runaway client can't fill the database.
MAX_BOARDS = 20
MAX_TOKENS = 300


def token_payload(t: BoardToken, character: Character | None = None) -> dict[str, Any]:
    """A token as the client draws it. Character tokens resolve live from the
    character (name, picture, hit points); free tokens carry their own."""
    hp: dict[str, int] | None = None
    if character is not None:
        name = character.name
        avatar = character.avatar
        if character.sheet:
            from .sheets import summary

            s = summary(character.sheet)
            if s and s.get("hp") and s["hp"].get("max"):
                hp = {"current": max(0, s["hp"].get("current", 0)), "max": s["hp"]["max"]}
    else:
        name = t.name or "Token"
        avatar = t.avatar
        if t.hp_max:
            hp = {"current": t.hp if t.hp is not None else t.hp_max, "max": t.hp_max}
    return {
        "id": t.id,
        "board_id": t.board_id,
        "character_id": t.character_id,
        "name": name,
        "avatar": avatar,
        "x": round(t.x, 1),
        "y": round(t.y, 1),
        "disposition": t.disposition if t.disposition in DISPOSITIONS else "neutral",
        "size": t.size,
        "owner_id": t.owner_id,
        "hp": hp,
    }


def tokens_payload(db: Session, tokens: list[BoardToken]) -> list[dict[str, Any]]:
    char_ids = {t.character_id for t in tokens if t.character_id}
    chars = {c.id: c for c in db.scalars(select(Character).where(Character.id.in_(char_ids)))} if char_ids else {}
    return [token_payload(t, chars.get(t.character_id) if t.character_id else None) for t in tokens]


def drawing_payload(d: BoardDrawing) -> dict[str, Any]:
    return {
        "id": d.id,
        "board_id": d.board_id,
        "kind": d.kind,
        "color": d.color,
        "width": d.width,
        "data": d.data or {},
        "author_id": d.author_id,
    }


def boards_for(db: Session, server_id: int) -> list[Board]:
    return list(db.scalars(select(Board).where(Board.server_id == server_id).order_by(Board.id)))


def active_board(db: Session, server: Server) -> Board | None:
    if server.active_board_id is None:
        return None
    row = db.get(Board, server.active_board_id)
    if row is None or row.server_id != server.id:
        return None
    return row


def board_full(db: Session, row: Board) -> dict[str, Any]:
    """One board with everything on it (tokens, drawings, tracker)."""
    tokens = list(db.scalars(select(BoardToken).where(BoardToken.board_id == row.id).order_by(BoardToken.id)))
    drawings = list(db.scalars(select(BoardDrawing).where(BoardDrawing.board_id == row.id).order_by(BoardDrawing.id)))
    return {
        "id": row.id,
        "name": row.name,
        "background_url": f"/cdn/boards/{row.id}/{row.background}" if row.background else None,
        "bg_width": row.bg_width,
        "bg_height": row.bg_height,
        "grid_size": row.grid_size,
        "snap": bool(row.snap),
        "tokens": tokens_payload(db, tokens),
        "drawings": [drawing_payload(d) for d in drawings],
        "tracker": list(row.tracker or []),
        "rev": row.rev,
    }


def bump_rev(row: Board) -> None:
    """Structural change: newer full states win on clients."""
    row.rev = int(row.rev or 0) + 1


class BoardManager:
    """Who has the board open (kept on the event loop, like the theater's seats)."""

    def __init__(self) -> None:
        self._viewers: dict[int, dict[int, set[int]]] = {}  # server -> user -> conn ids (loop only)
        self._snap: dict[int, tuple[int, ...]] = {}  # safe to read from any thread

    def viewers(self, server_id: int) -> list[int]:
        return list(self._snap.get(server_id, ()))

    def _resnap(self, server_id: int) -> None:
        self._snap[server_id] = tuple(sorted(self._viewers.get(server_id, {}).keys()))

    def set_viewing(self, server_id: int, user_id: int, conn_id: int, viewing: bool, member_ids: list[int]) -> None:
        users = self._viewers.setdefault(server_id, {})
        before = set(users)
        if viewing:
            users.setdefault(user_id, set()).add(conn_id)
        else:
            conns = users.get(user_id)
            if conns is not None:
                conns.discard(conn_id)
                if not conns:
                    users.pop(user_id, None)
        self._resnap(server_id)
        if set(users) != before:
            gateway.publish(member_ids, "BOARD_VIEWERS", {"server_id": server_id, "user_ids": self.viewers(server_id)})

    def connection_closed(self, user_id: int, conn_id: int) -> list[int]:
        """Drop a closed socket from every board's viewers; returns servers that changed."""
        changed = []
        for server_id, users in self._viewers.items():
            conns = users.get(user_id)
            if conns and conn_id in conns:
                conns.discard(conn_id)
                if not conns:
                    users.pop(user_id, None)
                    changed.append(server_id)
                self._resnap(server_id)
        return changed

    def payload(self, db: Session, server: Server) -> dict[str, Any]:
        """Everything the client needs about a server's boards: the list (for
        the switcher), the active one in full, and who has it open."""
        rows = boards_for(db, server.id)
        active = active_board(db, server)
        return {
            "server_id": server.id,
            "boards": [{"id": b.id, "name": b.name} for b in rows],
            "active_id": active.id if active is not None else None,
            "board": board_full(db, active) if active is not None else None,
            "viewers": self.viewers(server.id),
        }


board = BoardManager()


def publish_state(db: Session, server: Server, member_ids: list[int] | None = None) -> None:
    """Queue the whole board payload for every member (structural changes)."""
    if member_ids is None:
        member_ids = list(db.scalars(select(Member.user_id).where(Member.server_id == server.id)))
    queue_event(db, member_ids, "BOARD_STATE", board.payload(db, server))
