"""Real-time event hub.

Every browser tab holds one WebSocket. Route handlers (which run in worker
threads) call `gateway.publish(user_ids, event, data)`; the hub hops onto the
event loop and pushes the JSON to every socket those users have open.

Wire format (loosely modelled on Discord's gateway):
    server -> client  {"op": 10, "d": {"heartbeat_interval": ms}}   hello
                      {"op": 0, "t": "EVENT_NAME", "d": {...}}      dispatch
                      {"op": 11}                                    heartbeat ack
    client -> server  {"op": 1}                                     heartbeat
"""

from __future__ import annotations

import asyncio
import json
import logging
from collections import defaultdict
from collections.abc import Iterable
from typing import Any

from starlette.websockets import WebSocket

log = logging.getLogger("tavern.gateway")


class Connection:
    MAX_QUEUE = 5000

    def __init__(self, ws: WebSocket, user_id: int, session_id: int) -> None:
        self.ws = ws
        self.user_id = user_id
        self.session_id = session_id
        self.queue: asyncio.Queue[str | None] = asyncio.Queue()
        self.task: asyncio.Task[None] | None = None
        self.closed = False

    def send(self, text: str) -> None:
        if self.closed:
            return
        if self.queue.qsize() > self.MAX_QUEUE:
            log.warning("Dropping slow client for user %s", self.user_id)
            self.close(4008, "Too slow")
            return
        self.queue.put_nowait(text)

    def close(self, code: int = 1000, reason: str = "") -> None:
        if self.closed:
            return
        self.closed = True
        self.queue.put_nowait(None)
        asyncio.ensure_future(self._close(code, reason))

    async def _close(self, code: int, reason: str) -> None:
        try:
            await self.ws.close(code=code, reason=reason)
        except Exception:  # already closed
            pass

    async def writer(self) -> None:
        try:
            while True:
                item = await self.queue.get()
                if item is None:
                    break
                await self.ws.send_text(item)
        except Exception:  # socket went away; the reader loop cleans up
            pass


class Gateway:
    def __init__(self) -> None:
        self._conns: dict[int, set[Connection]] = defaultdict(set)
        self._online: frozenset[int] = frozenset()
        self._loop: asyncio.AbstractEventLoop | None = None

    def bind_loop(self, loop: asyncio.AbstractEventLoop) -> None:
        self._loop = loop

    # -- presence ---------------------------------------------------------
    def is_online(self, user_id: int) -> bool:
        return user_id in self._online

    def _refresh_online(self) -> None:
        self._online = frozenset(uid for uid, conns in self._conns.items() if conns)

    # -- connection bookkeeping (event loop only) --------------------------
    def add(self, conn: Connection) -> bool:
        """Register a connection. Returns True if it's the user's first."""
        first = not self._conns.get(conn.user_id)
        self._conns[conn.user_id].add(conn)
        conn.task = asyncio.create_task(conn.writer())
        self._refresh_online()
        return first

    def remove(self, conn: Connection) -> bool:
        """Unregister a connection. Returns True if the user is now offline."""
        conns = self._conns.get(conn.user_id)
        if conns is not None:
            conns.discard(conn)
            if not conns:
                del self._conns[conn.user_id]
        if not conn.closed:
            conn.closed = True
            conn.queue.put_nowait(None)
        self._refresh_online()
        return conn.user_id not in self._conns

    # -- publishing (any thread) --------------------------------------------
    def publish(self, user_ids: Iterable[int], event: str, data: dict[str, Any]) -> None:
        users = set(user_ids)
        if not users or self._loop is None:
            return
        text = json.dumps({"op": 0, "t": event, "d": data}, separators=(",", ":"), default=str)
        self._call(self._deliver, users, text)

    def _deliver(self, users: set[int], text: str) -> None:
        for uid in users:
            for conn in list(self._conns.get(uid, ())):
                conn.send(text)

    def disconnect_sessions(self, session_ids: Iterable[int], code: int = 4004, reason: str = "Session ended") -> None:
        ids = set(session_ids)
        if ids:
            self._call(self._disconnect, lambda c: c.session_id in ids, code, reason)

    def disconnect_user(self, user_id: int, code: int = 4004, reason: str = "Session ended") -> None:
        self._call(self._disconnect, lambda c: c.user_id == user_id, code, reason)

    def _disconnect(self, predicate, code: int, reason: str) -> None:
        for conns in list(self._conns.values()):
            for conn in list(conns):
                if predicate(conn):
                    conn.close(code, reason)

    def _call(self, fn, *args) -> None:
        loop = self._loop
        if loop is None or loop.is_closed():
            return
        try:
            running = asyncio.get_running_loop()
        except RuntimeError:
            running = None
        if running is loop:
            fn(*args)
        else:
            loop.call_soon_threadsafe(fn, *args)


gateway = Gateway()
