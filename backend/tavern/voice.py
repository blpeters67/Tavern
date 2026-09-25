"""Voice spaces: who is connected where, plus WebRTC signaling relay.

Audio and video go browser-to-browser (a mesh); the server only tracks voice
state and forwards offers/answers/ICE candidates between people in the same
voice space. Everything here runs on the event loop thread, except the
helpers marked "any thread", which hop onto the loop first.
"""

from __future__ import annotations

import asyncio
import json
import logging
import time
from dataclasses import dataclass, field
from typing import Any

from starlette.concurrency import run_in_threadpool

from .gateway import Connection, gateway

log = logging.getLogger("tavern.voice")

RESUME_GRACE = 12.0  # seconds a dropped socket keeps its voice seat


@dataclass
class VoiceState:
    user_id: int
    server_id: int
    channel_id: int
    conn: Connection | None
    audience: frozenset[int] = frozenset()
    self_mute: bool = False
    self_deaf: bool = False
    mute: bool = False  # server mute (or no Speak permission)
    deaf: bool = False  # server deafen
    self_video: bool = False
    self_stream: bool = False
    speaking: bool = False
    can_stream: bool = True
    joined_at: float = field(default_factory=time.time)

    def payload(self) -> dict[str, Any]:
        return {
            "user_id": self.user_id,
            "server_id": self.server_id,
            "channel_id": self.channel_id,
            "self_mute": self.self_mute,
            "self_deaf": self.self_deaf,
            "mute": self.mute,
            "deaf": self.deaf,
            "self_video": self.self_video,
            "self_stream": self.self_stream,
            "speaking": self.speaking,
            "joined_at": int(self.joined_at * 1000),
        }


def _left_payload(state: VoiceState) -> dict[str, Any]:
    data = state.payload()
    data["channel_id"] = None
    data["speaking"] = False
    return data


class VoiceManager:
    def __init__(self) -> None:
        self._states: dict[int, VoiceState] = {}
        self._pending: dict[int, asyncio.TimerHandle] = {}
        self._speak_times: dict[int, list[float]] = {}
        # Read by worker threads (READY, REST), replaced wholesale on change.
        self._snapshot: tuple[dict[str, Any], ...] = ()

    # -- reads (any thread) ---------------------------------------------------
    def snapshot(self) -> tuple[dict[str, Any], ...]:
        return self._snapshot

    def states_for_server(self, server_id: int) -> list[dict[str, Any]]:
        return [s for s in self._snapshot if s["server_id"] == server_id]

    def channel_of(self, user_id: int) -> int | None:
        for s in self._snapshot:
            if s["user_id"] == user_id:
                return s["channel_id"]
        return None

    def count_in(self, channel_id: int) -> int:
        return sum(1 for s in self._snapshot if s["channel_id"] == channel_id)

    def _refresh(self) -> None:
        self._snapshot = tuple(s.payload() for s in self._states.values())

    def _broadcast(self, state: VoiceState, payload: dict[str, Any]) -> None:
        audience = set(state.audience) | {state.user_id}
        gateway.publish(audience, "VOICE_STATE_UPDATE", payload)

    # -- client ops (event loop) ------------------------------------------------
    async def handle_update(self, conn: Connection, data: dict[str, Any]) -> None:
        channel_id = data.get("channel_id")
        flags = {k: bool(data.get(k)) for k in ("self_mute", "self_deaf", "self_video", "self_stream")}
        current = self._states.get(conn.user_id)

        if channel_id is None:
            if current is not None and (current.conn is conn or current.conn is None):
                self._leave(current)
            return
        if not isinstance(channel_id, int):
            return

        if current is not None and current.channel_id == channel_id:
            # Same space: either a flag change or a reconnect resuming its seat.
            pending = self._pending.pop(conn.user_id, None)
            if pending is not None:
                pending.cancel()
            if current.conn is not conn:
                old = current.conn
                current.conn = conn
                if old is not None and not old.closed:
                    old.send(json.dumps({"op": 0, "t": "VOICE_SESSION_REPLACED", "d": {"channel_id": channel_id}}))
            self._apply_flags(current, flags)
            self._refresh()
            self._broadcast(current, current.payload())
            return

        check = await run_in_threadpool(_check_join, conn.user_id, channel_id)
        if isinstance(check, str):
            conn.send(json.dumps({"op": 0, "t": "VOICE_JOIN_ERROR", "d": {"channel_id": channel_id, "message": check}}))
            return
        server_id, audience, can_speak, can_stream, limit, bypass_limit = check
        if limit and not bypass_limit and self._count(channel_id) >= limit:
            conn.send(
                json.dumps({"op": 0, "t": "VOICE_JOIN_ERROR", "d": {"channel_id": channel_id, "message": "That voice space is full."}})
            )
            return

        if current is not None:
            self._leave(current, replaced_by=conn)
        state = VoiceState(
            user_id=conn.user_id,
            server_id=server_id,
            channel_id=channel_id,
            conn=conn,
            audience=frozenset(audience),
            mute=not can_speak,
            can_stream=can_stream,
        )
        self._apply_flags(state, flags)
        self._states[conn.user_id] = state
        self._refresh()
        self._broadcast(state, state.payload())

    def _apply_flags(self, state: VoiceState, flags: dict[str, bool]) -> None:
        state.self_mute = flags["self_mute"] or flags["self_deaf"]
        state.self_deaf = flags["self_deaf"]
        state.self_video = flags["self_video"] and state.can_stream
        state.self_stream = flags["self_stream"] and state.can_stream
        if state.self_mute or state.mute:
            state.speaking = False

    def _count(self, channel_id: int) -> int:
        return sum(1 for s in self._states.values() if s.channel_id == channel_id)

    def _leave(self, state: VoiceState, replaced_by: Connection | None = None) -> None:
        pending = self._pending.pop(state.user_id, None)
        if pending is not None:
            pending.cancel()
        if self._states.get(state.user_id) is state:
            del self._states[state.user_id]
        self._refresh()
        self._broadcast(state, _left_payload(state))
        old = state.conn
        if replaced_by is not None and old is not None and old is not replaced_by and not old.closed:
            old.send(json.dumps({"op": 0, "t": "VOICE_SESSION_REPLACED", "d": {"channel_id": state.channel_id}}))

    def handle_signal(self, conn: Connection, data: dict[str, Any]) -> None:
        me = self._states.get(conn.user_id)
        target_id = data.get("to")
        if me is None or me.conn is not conn or not isinstance(target_id, int):
            return
        target = self._states.get(target_id)
        if target is None or target.channel_id != me.channel_id or target.conn is None:
            return
        payload = data.get("data")
        text = json.dumps({"op": 0, "t": "VOICE_SIGNAL", "d": {"from": conn.user_id, "data": payload}}, separators=(",", ":"))
        if len(text) > 200_000:
            return
        target.conn.send(text)

    def handle_speaking(self, conn: Connection, data: dict[str, Any]) -> None:
        state = self._states.get(conn.user_id)
        if state is None or state.conn is not conn:
            return
        speaking = bool(data.get("speaking")) and not (state.self_mute or state.mute)
        if speaking == state.speaking:
            return
        now = time.monotonic()
        recent = [t for t in self._speak_times.get(conn.user_id, []) if now - t < 1.0]
        if len(recent) >= 12 and speaking:
            return
        recent.append(now)
        self._speak_times[conn.user_id] = recent
        state.speaking = speaking
        self._refresh()
        gateway.publish(
            set(state.audience) | {state.user_id},
            "VOICE_SPEAKING",
            {"user_id": state.user_id, "channel_id": state.channel_id, "speaking": speaking},
        )

    def connection_closed(self, conn: Connection) -> None:
        state = self._states.get(conn.user_id)
        if state is None or state.conn is not conn:
            return
        state.conn = None
        state.speaking = False
        loop = asyncio.get_running_loop()

        def expire() -> None:
            self._pending.pop(state.user_id, None)
            if self._states.get(state.user_id) is state and state.conn is None:
                self._leave(state)

        self._pending[state.user_id] = loop.call_later(RESUME_GRACE, expire)

    # -- moderation & housekeeping (any thread) ---------------------------------
    def disconnect(self, user_id: int, channel_id: int | None = None) -> None:
        gateway._call(self._disconnect, user_id, channel_id)

    def _disconnect(self, user_id: int, channel_id: int | None) -> None:
        state = self._states.get(user_id)
        if state is None or (channel_id is not None and state.channel_id != channel_id):
            return
        conn = state.conn
        self._leave(state)
        if conn is not None and not conn.closed:
            conn.send(json.dumps({"op": 0, "t": "VOICE_FORCE_DISCONNECT", "d": {"channel_id": state.channel_id}}))

    def disconnect_channel(self, channel_id: int) -> None:
        gateway._call(self._disconnect_channel, channel_id)

    def _disconnect_channel(self, channel_id: int) -> None:
        for state in [s for s in self._states.values() if s.channel_id == channel_id]:
            self._disconnect(state.user_id, channel_id)

    def disconnect_server_member(self, server_id: int, user_id: int) -> None:
        gateway._call(self._disconnect_server_member, server_id, user_id)

    def _disconnect_server_member(self, server_id: int, user_id: int) -> None:
        state = self._states.get(user_id)
        if state is not None and state.server_id == server_id:
            self._disconnect(user_id, None)

    def disconnect_server(self, server_id: int) -> None:
        gateway._call(self._disconnect_server, server_id)

    def _disconnect_server(self, server_id: int) -> None:
        for state in [s for s in self._states.values() if s.server_id == server_id]:
            self._disconnect(state.user_id, None)

    def set_server_flags(self, user_id: int, mute: bool | None, deaf: bool | None) -> None:
        gateway._call(self._set_server_flags, user_id, mute, deaf)

    def _set_server_flags(self, user_id: int, mute: bool | None, deaf: bool | None) -> None:
        state = self._states.get(user_id)
        if state is None:
            return
        if mute is not None:
            state.mute = mute
        if deaf is not None:
            state.deaf = deaf
        if state.mute:
            state.speaking = False
        self._refresh()
        self._broadcast(state, state.payload())

    def move(self, user_id: int, channel_id: int, audience: frozenset[int]) -> None:
        gateway._call(self._move, user_id, channel_id, audience)

    def _move(self, user_id: int, channel_id: int, audience: frozenset[int]) -> None:
        state = self._states.get(user_id)
        if state is None or state.channel_id == channel_id:
            return
        # Tell the moved client first, so it's already looking at the new space
        # when its own state update arrives (that update is what reconnects it).
        if state.conn is not None:
            state.conn.send(json.dumps({"op": 0, "t": "VOICE_MOVED", "d": {"channel_id": channel_id}}))
        # Then tell the old space they left and put them in the new one.
        self._broadcast(state, _left_payload(state))
        state.channel_id = channel_id
        state.audience = audience
        state.speaking = False
        state.joined_at = time.time()
        self._refresh()
        self._broadcast(state, state.payload())


def _check_join(user_id: int, channel_id: int):
    """Runs in a worker thread. Returns an error string or join details."""
    from .db import SessionLocal
    from .models import Channel, ChannelType
    from .permissions import P, channel_access

    with SessionLocal() as db:
        channel = db.get(Channel, channel_id)
        if channel is None or channel.type != ChannelType.VOICE:
            return "That voice space doesn't exist."
        access = channel_access(db, channel, user_id)
        if not access.has(P.VIEW_CHANNEL | P.CONNECT):
            return "You don't have permission to join that voice space."
        assert access.ctx is not None
        audience = access.ctx.viewers(channel)
        return (
            channel.server_id,
            audience,
            access.has(P.SPEAK),
            access.has(P.STREAM),
            channel.user_limit or 0,
            access.has(P.MOVE_MEMBERS),
        )


voice = VoiceManager()
