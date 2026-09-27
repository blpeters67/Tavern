"""The WebSocket endpoint browsers connect to for live updates."""

from __future__ import annotations

import asyncio
import json
import logging
import time

from fastapi import APIRouter, WebSocket
from starlette.concurrency import run_in_threadpool
from starlette.websockets import WebSocketDisconnect

from ..db import SessionLocal
from ..deps import SESSION_COOKIE, authenticate_token, origin_allowed
from ..gateway import Connection, gateway
from ..models import User
from ..serializers import user_payload
from ..board import board
from ..jukebox import jukebox
from ..services import build_ready, related_user_ids
from ..theater import theater
from ..voice import voice

log = logging.getLogger("tavern.gateway")
router = APIRouter()

HEARTBEAT_MS = 30_000
HEARTBEAT_GRACE = 2.5  # close the socket after this many missed intervals


def _authenticate(token: str | None) -> tuple[int, int] | None:
    with SessionLocal() as db:
        result = authenticate_token(db, token)
        if result is None:
            return None
        user, sess = result
        return user.id, sess.id


def _ready_json(user_id: int, session_id: int) -> str:
    with SessionLocal() as db:
        data = build_ready(db, user_id, session_id)
    return json.dumps({"op": 0, "t": "READY", "d": data}, separators=(",", ":"), default=str)


def _broadcast_presence(user_id: int) -> None:
    with SessionLocal() as db:
        user = db.get(User, user_id)
        if user is None:
            return
        status = user_payload(user)["status"]
        audience = related_user_ids(db, user_id) - {user_id}
    gateway.publish(audience, "PRESENCE_UPDATE", {"user_id": user_id, "status": status})


def _member_ids(server_id: int) -> list[int]:
    from sqlalchemy import select

    from ..models import Member

    with SessionLocal() as db:
        return list(db.scalars(select(Member.user_id).where(Member.server_id == server_id)))


async def _jukebox_listen(conn: Connection, d: dict) -> None:
    server_id = d.get("server_id")
    if not isinstance(server_id, int):
        return
    members = await run_in_threadpool(_member_ids, server_id)
    if conn.user_id not in members:
        return
    jukebox.set_listening(server_id, conn.user_id, id(conn), bool(d.get("listening")), members)


async def _theater_seat(conn: Connection, d: dict) -> None:
    server_id = d.get("server_id")
    if not isinstance(server_id, int):
        return
    members = await run_in_threadpool(_member_ids, server_id)
    if conn.user_id not in members:
        return
    theater.set_listening(server_id, conn.user_id, id(conn), bool(d.get("seated")), members)


async def _board_view(conn: Connection, d: dict) -> None:
    server_id = d.get("server_id")
    if not isinstance(server_id, int):
        return
    members = await run_in_threadpool(_member_ids, server_id)
    if conn.user_id not in members:
        return
    viewing = bool(d.get("viewing"))
    board.set_viewing(server_id, conn.user_id, id(conn), viewing, members)
    if viewing:
        # Joiners get everyone else's pointer right away; after this they only
        # hear about it when someone moves or switches tools.
        snap = board.cursors(server_id)
        others = [
            {"user_id": u, "x": round(x, 1), "y": round(y, 1), "tool": t}
            for u, (x, y, t) in snap.items()
            if u != conn.user_id
        ]
        if others:
            conn.send(json.dumps({"op": 0, "t": "BOARD_CURSORS", "d": {"server_id": server_id, "cursors": others}}))


async def _board_cursor(conn: Connection, d: dict) -> None:
    server_id = d.get("server_id")
    if not isinstance(server_id, int):
        return
    if d.get("hidden"):
        # Sharing off: the pointer is forgotten and the others are told to
        # drop it, so a frozen ghost never lingers on their maps.
        targets = board.hide_cursor(server_id, conn.user_id)
        if not targets:
            return
        gateway.publish(
            targets,
            "BOARD_CURSOR",
            {"server_id": server_id, "user_id": conn.user_id, "hidden": True},
        )
        return
    x = d.get("x")
    y = d.get("y")
    tool = d.get("tool")
    if isinstance(x, bool) or isinstance(y, bool):
        return
    if not isinstance(x, (int, float)) or not isinstance(y, (int, float)):
        return
    if not isinstance(tool, str) or len(tool) > 24:
        return
    targets = board.set_cursor(server_id, conn.user_id, float(x), float(y), tool)
    if not targets:
        return
    gateway.publish(
        targets,
        "BOARD_CURSOR",
        {"server_id": server_id, "user_id": conn.user_id, "x": round(float(x), 1), "y": round(float(y), 1), "tool": tool},
    )


@router.websocket("/api/gateway")
async def gateway_socket(ws: WebSocket) -> None:
    origin = ws.headers.get("origin")
    if origin and not origin_allowed(origin, ws.headers.get("host")):
        await ws.close(code=4003)
        return

    auth = await run_in_threadpool(_authenticate, ws.cookies.get(SESSION_COOKIE))
    await ws.accept()
    if auth is None:
        await ws.close(code=4001, reason="Not logged in")
        return
    user_id, session_id = auth

    conn = Connection(ws, user_id, session_id)
    first = gateway.add(conn)
    try:
        conn.send(json.dumps({"op": 10, "d": {"heartbeat_interval": HEARTBEAT_MS}}))
        conn.send(await run_in_threadpool(_ready_json, user_id, session_id))
        if first:
            await run_in_threadpool(_broadcast_presence, user_id)

        timeout = HEARTBEAT_MS / 1000 * HEARTBEAT_GRACE
        while True:
            try:
                message = await asyncio.wait_for(ws.receive(), timeout=timeout)
            except asyncio.TimeoutError:
                conn.close(4009, "Heartbeat timed out")
                break
            if message["type"] == "websocket.disconnect":
                break
            raw = message.get("text")
            if not raw:
                continue
            try:
                data = json.loads(raw)
            except ValueError:
                continue
            if not isinstance(data, dict):
                continue
            op = data.get("op")
            d = data.get("d") if isinstance(data.get("d"), dict) else {}
            if op == 1:
                conn.send('{"op":11}')
            elif op == 7:
                # Clock sync for the jukebox: echo the client's time with ours.
                conn.send(json.dumps({"op": 7, "d": {"c": d.get("c"), "s": time.time() * 1000}}))
            elif op == 4:
                await voice.handle_update(conn, d)
            elif op == 5:
                voice.handle_signal(conn, d)
            elif op == 6:
                voice.handle_speaking(conn, d)
            elif op == 9:
                await _jukebox_listen(conn, d)
            elif op == 10:
                await _theater_seat(conn, d)
            elif op == 12:
                await _board_view(conn, d)
            elif op == 13:
                await _board_cursor(conn, d)
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("Gateway connection for user %s crashed", user_id)
    finally:
        voice.connection_closed(conn)
        for server_id in jukebox.connection_closed(user_id, id(conn)):
            members = await run_in_threadpool(_member_ids, server_id)
            gateway.publish(members, "JUKEBOX_LISTENERS", {"server_id": server_id, "user_ids": jukebox.listeners(server_id)})
        for server_id in theater.connection_closed(user_id, id(conn)):
            members = await run_in_threadpool(_member_ids, server_id)
            gateway.publish(members, "THEATER_SEATS", {"server_id": server_id, "user_ids": theater.listeners(server_id)})
        for server_id in board.connection_closed(user_id, id(conn)):
            members = await run_in_threadpool(_member_ids, server_id)
            gateway.publish(members, "BOARD_VIEWERS", {"server_id": server_id, "user_ids": board.viewers(server_id)})
        offline = gateway.remove(conn)
        if offline:
            # Give page refreshes a moment to reconnect before showing
            # everyone that this person went offline.
            await asyncio.sleep(4)
            if not gateway.is_online(user_id):
                try:
                    await run_in_threadpool(_broadcast_presence, user_id)
                except Exception:
                    log.exception("Presence broadcast failed")
