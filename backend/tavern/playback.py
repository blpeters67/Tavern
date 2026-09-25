"""Shared playback: a queue and one clock per server that everyone follows.
The jukebox (music) and the theater (videos) are both built on this.

Playback state is authoritative on the server. `started_at` is the server
time (epoch ms) at which position 0 of the current item played, so any
client can work out exactly where it is right now. Timers advance the queue
when an item ends; fades are "transitions" the server waits out before
acting, so every listener fades together.
"""

from __future__ import annotations

import asyncio
import json
import logging
import random
import secrets
import threading
import time
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from .db import SessionLocal, queue_event
from .gateway import gateway
from .models import Member

log = logging.getLogger("tavern.playback")

FADE_MS = 2500
PREVIOUS_RESTART_MS = 4000
HISTORY_LIMIT = 50
QUEUE_LIMIT = 500


def now_ms() -> float:
    return time.time() * 1000


class PlaybackManager:
    """Subclasses say what they play (the table, the payload, event names)."""

    #: Table holding each server's saved state (one JSON column, `data`).
    state_model: Any = None
    #: Table of the things that play (they have `duration_ms`).
    item_model: Any = None
    #: Name of the id field in queue entries ("track_id", "video_id").
    key = "track_id"
    #: Where the payload lists the items the queue refers to.
    items_key = "tracks"
    state_event = "JUKEBOX_STATE"
    listeners_event = "JUKEBOX_LISTENERS"
    name = "Jukebox"

    def __init__(self) -> None:
        self._lock = threading.RLock()
        self._states: dict[int, dict[str, Any]] = {}
        self._durations: dict[int, int] = {}
        self._timers: dict[int, asyncio.TimerHandle] = {}
        self._armed_rev: dict[int, int] = {}  # newest state whose end timer is armed (loop only)
        self._listeners: dict[int, dict[int, set[int]]] = {}  # server -> user -> conn ids (loop only)
        self._listener_snap: dict[int, tuple[int, ...]] = {}  # safe to read from any thread
        self.progress: dict[int, float] = {}

    # -- what's being played (subclasses) -------------------------------------------------
    def default_state(self) -> dict[str, Any]:
        return {
            "queue": [],
            "current": None,
            "history": [],
            "playing": False,
            "started_at": None,
            "position": 0,
            "repeat": "off",
            "shuffle": False,
            "fade": False,
            "transition": None,
            "rev": 0,
            "updated_by": None,
        }

    def item_payload(self, item: Any) -> dict[str, Any]:
        raise NotImplementedError

    def _entry(self, item_id: int, user_id: int | None) -> dict[str, Any]:
        return {"qid": secrets.token_hex(5), self.key: item_id, "added_by": user_id}

    def _repeat_copy(self, entry: dict[str, Any]) -> dict[str, Any]:
        """The copy "repeat all" puts back at the end of the queue (it remembers
        which play it came from, so going back to that play can take it out again)."""
        copy = self._entry(entry[self.key], entry.get("added_by"))
        copy["repeat_of"] = entry["qid"]
        return copy

    # -- loading & saving -------------------------------------------------------
    def _load(self, db: Session, server_id: int) -> dict[str, Any]:
        state = self._states.get(server_id)
        if state is None:
            row = db.get(self.state_model, server_id)
            state = self.default_state()
            if row is not None and isinstance(row.data, dict):
                state.update(row.data)
            self._states[server_id] = state
        return state

    def _save(self, db: Session, server_id: int, state: dict[str, Any]) -> None:
        row = db.get(self.state_model, server_id)
        data = json.loads(json.dumps(state))
        if row is None:
            db.add(self.state_model(server_id=server_id, data=data))
        else:
            row.data = data

    def _duration(self, db: Session, item_id: int) -> int:
        if item_id not in self._durations:
            item = db.get(self.item_model, item_id)
            self._durations[item_id] = item.duration_ms if item is not None else 0
        return self._durations[item_id]

    def set_duration(self, db: Session, server_id: int, item_id: int, duration_ms: int) -> None:
        """An item's length became known (a player reported it): re-arm the end timer."""
        self._durations[item_id] = duration_ms
        with self._lock:
            state = self._load(db, server_id)
            snapshot = json.loads(json.dumps(state))
        if snapshot["current"] and snapshot["current"][self.key] == item_id:
            self._reschedule(db, server_id, snapshot)

    def forget(self, server_id: int) -> None:
        with self._lock:
            self._states.pop(server_id, None)
        gateway._call(self._disarm, server_id)

    def elapsed(self, db: Session, server_id: int) -> float:
        """How far into the current item everyone is (ms)."""
        with self._lock:
            return self._position(self._load(db, server_id), now_ms())

    # -- payloads -------------------------------------------------------------------
    def payload(self, db: Session, server_id: int) -> dict[str, Any]:
        with self._lock:
            state = json.loads(json.dumps(self._load(db, server_id)))
        key = self.key
        ids = {e[key] for e in state["queue"]}
        if state["current"]:
            ids.add(state["current"][key])
        ids |= {e[key] for e in state["history"][-10:]}
        items = {}
        if ids:
            for item in db.scalars(select(self.item_model).where(self.item_model.id.in_(ids))):
                items[str(item.id)] = self.item_payload(item)
        state["history"] = state["history"][-10:]
        state["server_id"] = server_id
        state[self.items_key] = items
        state["server_now"] = now_ms()
        state["listeners"] = self.listeners(server_id)
        return state

    def _publish(self, db: Session, server_id: int, member_ids: list[int] | None = None) -> None:
        if member_ids is None:
            member_ids = list(db.scalars(select(Member.user_id).where(Member.server_id == server_id)))
        queue_event(db, member_ids, self.state_event, self.payload(db, server_id))

    # -- mutation core ----------------------------------------------------------------
    def mutate(self, db: Session, server_id: int, actor_id: int | None, fn, member_ids: list[int] | None = None) -> bool:
        """Run `fn(state, now)` under the lock, persist, broadcast (on commit) and
        reschedule the end-of-item timer. `fn` returns False (before changing
        anything) when there's nothing to do."""
        with self._lock:
            state = self._load(db, server_id)
            if fn(state, now_ms()) is False:
                return False
            state["rev"] = int(state.get("rev", 0)) + 1
            state["updated_by"] = actor_id
            self._save(db, server_id, state)
            snapshot = json.loads(json.dumps(state))
        self._publish(db, server_id, member_ids)
        self._reschedule(db, server_id, snapshot)
        return True

    def _position(self, state: dict[str, Any], now: float) -> float:
        if state["current"] is None:
            return 0
        if state["playing"] and state["started_at"] is not None:
            return max(0.0, now - state["started_at"])
        return float(state.get("position") or 0)

    def _start(self, state: dict[str, Any], entry: dict[str, Any] | None, now: float) -> None:
        state["current"] = entry
        state["transition"] = None
        state["position"] = 0
        if entry is None:
            state["playing"] = False
            state["started_at"] = None
        else:
            state["playing"] = True
            state["started_at"] = now

    def _retire_current(self, state: dict[str, Any]) -> None:
        """The current item is done (or replaced): into the history, and back into the queue on repeat-all."""
        cur = state["current"]
        if cur is None:
            return
        state["history"].append(cur)
        del state["history"][:-HISTORY_LIMIT]
        if state["repeat"] == "all":
            state["queue"].append(self._repeat_copy(cur))

    def _advance(self, state: dict[str, Any], now: float, finished: bool) -> None:
        cur = state["current"]
        if cur is not None and finished and state["repeat"] == "one":
            self._start(state, cur, now)
            return
        self._retire_current(state)
        queue = state["queue"]
        if not queue:
            self._start(state, None, now)
            return
        index = 0
        if state["shuffle"]:
            # "Play next" still means next, shuffle or not.
            pinned = next((i for i, e in enumerate(queue) if e.get("next")), None)
            index = pinned if pinned is not None else random.randrange(len(queue))
        entry = queue.pop(index)
        entry.pop("next", None)
        self._start(state, entry, now)

    def _pause(self, state: dict[str, Any], now: float) -> None:
        state["position"] = self._position(state, now)
        state["playing"] = False
        state["started_at"] = None
        state["transition"] = None

    # -- actions ------------------------------------------------------------------------
    def control(self, db: Session, server_id: int, actor_id: int, action: str, value: Any = None) -> None:
        def run(state: dict[str, Any], now: float) -> None:
            fade = bool(state.get("fade"))
            if action == "play":
                if state["current"] is None:
                    self._advance(state, now, finished=False)
                elif not state["playing"]:
                    state["started_at"] = now - float(state.get("position") or 0)
                    state["playing"] = True
                state["transition"] = None
            elif action == "pause":
                if state["playing"] and fade:
                    state["transition"] = {"kind": "fade_out", "until": now + FADE_MS, "then": "pause"}
                elif state["playing"]:
                    self._pause(state, now)
            elif action == "fade_out":
                if state["playing"]:
                    state["transition"] = {"kind": "fade_out", "until": now + FADE_MS * 1.6, "then": "pause"}
            elif action == "skip":
                if state["playing"] and fade:
                    state["transition"] = {"kind": "fade_out", "until": now + FADE_MS, "then": "skip"}
                else:
                    self._advance(state, now, finished=False)
            elif action == "previous":
                if self._position(state, now) > PREVIOUS_RESTART_MS or not state["history"]:
                    if state["current"] is not None:
                        self._seek(state, 0, now)
                else:
                    prev = state["history"].pop()
                    # The copy repeat-all made when it finished comes back out of the queue.
                    state["queue"] = [e for e in state["queue"] if e.get("repeat_of") != prev["qid"]]
                    cur = state["current"]
                    if cur is not None:
                        # What was on comes straight back after it (shuffle or not).
                        state["queue"].insert(0, {**cur, "next": True})
                    self._start(state, self._entry(prev[self.key], prev.get("added_by")), now)
            elif action == "jump":
                # Play one particular queue entry now.
                entry = next((e for e in state["queue"] if e["qid"] == value), None)
                if entry is None:
                    raise KeyError("That's no longer in the queue.")
                state["queue"].remove(entry)
                entry.pop("next", None)
                self._retire_current(state)
                self._start(state, entry, now)
            elif action == "stop":
                if state["current"] is not None:
                    self._pause(state, now)
                    state["position"] = 0
            elif action == "seek":
                if state["current"] is not None:
                    self._seek(state, float(value or 0), now)
            elif action == "volume":
                state["volume"] = max(0, min(100, int(value)))
            elif action == "repeat":
                state["repeat"] = value if value in ("off", "all", "one") else "off"
            elif action == "shuffle":
                state["shuffle"] = bool(value)
            elif action == "fade":
                state["fade"] = bool(value)
            else:
                raise ValueError(action)

        self.mutate(db, server_id, actor_id, run)

    def _seek(self, state: dict[str, Any], ms: float, now: float) -> None:
        duration = self._durations.get(state["current"][self.key], 0) if state["current"] else 0
        ms = max(0.0, min(ms, max(0, duration - 500))) if duration else max(0.0, ms)
        if state["playing"]:
            state["started_at"] = now - ms
        else:
            state["position"] = ms
        state["transition"] = None

    def enqueue(self, db: Session, server_id: int, actor_id: int, item_ids: list[int], where: str) -> None:
        for item_id in item_ids:
            self._duration(db, item_id)

        def run(state: dict[str, Any], now: float) -> bool | None:
            entries = [self._entry(item_id, actor_id) for item_id in item_ids]
            room = QUEUE_LIMIT - len(state["queue"])
            entries = entries[: max(0, room)]
            if not entries:
                return False
            if where == "now":
                # The first one plays right away (never a shuffled pick); the rest go to the front.
                first, rest = entries[0], entries[1:]
                state["queue"][0:0] = rest
                self._retire_current(state)
                self._start(state, first, now)
                return None
            if where == "next":
                for e in entries:
                    e["next"] = True
                state["queue"][0:0] = entries
            else:
                state["queue"].extend(entries)
            if state["current"] is None:
                self._advance(state, now, finished=False)
            return None

        self.mutate(db, server_id, actor_id, run)

    def remove(self, db: Session, server_id: int, actor_id: int, qid: str) -> None:
        def run(state: dict[str, Any], now: float) -> None:
            state["queue"] = [e for e in state["queue"] if e["qid"] != qid]

        self.mutate(db, server_id, actor_id, run)

    def reorder(self, db: Session, server_id: int, actor_id: int, qids: list[str]) -> None:
        def run(state: dict[str, Any], now: float) -> None:
            by_id = {e["qid"]: e for e in state["queue"]}
            if sorted(by_id) != sorted(qids):
                raise ValueError("stale")
            state["queue"] = [by_id[q] for q in qids]

        self.mutate(db, server_id, actor_id, run)

    def clear(self, db: Session, server_id: int, actor_id: int) -> None:
        def run(state: dict[str, Any], now: float) -> None:
            state["queue"] = []

        self.mutate(db, server_id, actor_id, run)

    def drop_item(self, db: Session, server_id: int, item_id: int) -> None:
        """An item was deleted from the library (or can't play): pull it out of the queue."""
        key = self.key

        def run(state: dict[str, Any], now: float) -> None:
            state["queue"] = [e for e in state["queue"] if e[key] != item_id]
            state["history"] = [e for e in state["history"] if e[key] != item_id]
            if state["current"] and state["current"][key] == item_id:
                state["current"] = None
                self._advance(state, now, finished=False)

        self.mutate(db, server_id, None, run)
        self._durations.pop(item_id, None)

    def uses_item(self, db: Session, server_id: int, item_id: int) -> bool:
        with self._lock:
            state = self._load(db, server_id)
            if state["current"] and state["current"][self.key] == item_id:
                return True
            return any(e[self.key] == item_id for e in state["queue"])

    def is_current(self, db: Session, server_id: int, item_id: int) -> bool:
        with self._lock:
            state = self._load(db, server_id)
            return bool(state["current"] and state["current"][self.key] == item_id)

    # -- timers ---------------------------------------------------------------------------
    def _reschedule(self, db: Session, server_id: int, state: dict[str, Any]) -> None:
        at = None
        if state.get("transition"):
            at = float(state["transition"]["until"])
        elif state["playing"] and state["current"] and state["started_at"] is not None:
            duration = self._duration(db, state["current"][self.key])
            if duration > 0:
                at = float(state["started_at"]) + duration + 250
        rev = state["rev"]
        gateway._call(self._arm, server_id, at, rev)

    def _cancel_timer(self, server_id: int) -> None:
        handle = self._timers.pop(server_id, None)
        if handle is not None:
            handle.cancel()

    def _disarm(self, server_id: int) -> None:
        self._cancel_timer(server_id)
        self._armed_rev.pop(server_id, None)

    def _arm(self, server_id: int, at: float | None, rev: int) -> None:
        # Changes made on different threads can reach the loop out of order:
        # an older state's timer must never replace a newer one's.
        if rev < self._armed_rev.get(server_id, -1):
            return
        self._armed_rev[server_id] = rev
        self._cancel_timer(server_id)
        if at is None:
            return
        loop = asyncio.get_running_loop()
        delay = max(0.0, (at - now_ms()) / 1000)

        def fire() -> None:
            self._timers.pop(server_id, None)
            loop.run_in_executor(None, self._on_timer, server_id, rev)

        self._timers[server_id] = loop.call_later(delay, fire)

    def _on_timer(self, server_id: int, rev: int) -> None:
        try:
            with SessionLocal() as db:

                def run(st: dict[str, Any], now: float) -> bool | None:
                    # Checked under the same lock as the change: anything that
                    # happened since this timer was set (a skip, a seek) wins.
                    if st.get("rev") != rev:
                        return False
                    transition = st.get("transition")
                    if transition:
                        then = transition.get("then")
                        st["transition"] = None
                        if then == "pause":
                            self._pause(st, now)
                        elif then == "skip":
                            self._advance(st, now, finished=False)
                    else:
                        self._advance(st, now, finished=True)
                    return None

                if self.mutate(db, server_id, None, run):
                    db.commit()
        except Exception:
            log.exception("%s timer failed for server %s", self.name, server_id)

    def resume_all(self) -> None:
        """On startup: re-arm timers for servers that were playing."""
        with SessionLocal() as db:
            for row in db.scalars(select(self.state_model)):
                state = self._load(db, row.server_id)
                if state.get("playing") or state.get("transition"):
                    self._reschedule(db, row.server_id, json.loads(json.dumps(state)))

    # -- listeners (event loop) -----------------------------------------------------------
    def listeners(self, server_id: int) -> list[int]:
        return list(self._listener_snap.get(server_id, ()))

    def _snap(self, server_id: int) -> None:
        self._listener_snap[server_id] = tuple(sorted(self._listeners.get(server_id, {}).keys()))

    def set_listening(self, server_id: int, user_id: int, conn_id: int, listening: bool, member_ids: list[int]) -> None:
        users = self._listeners.setdefault(server_id, {})
        before = set(users)
        if listening:
            users.setdefault(user_id, set()).add(conn_id)
        else:
            conns = users.get(user_id)
            if conns is not None:
                conns.discard(conn_id)
                if not conns:
                    users.pop(user_id, None)
        self._snap(server_id)
        if set(users) != before:
            gateway.publish(member_ids, self.listeners_event, {"server_id": server_id, "user_ids": self.listeners(server_id)})

    def connection_closed(self, user_id: int, conn_id: int) -> list[int]:
        """Drop a closed socket from every listener list; returns servers that changed."""
        changed = []
        for server_id, users in self._listeners.items():
            conns = users.get(user_id)
            if conns and conn_id in conns:
                conns.discard(conn_id)
                if not conns:
                    users.pop(user_id, None)
                    changed.append(server_id)
                self._snap(server_id)
        return changed


class QueueRequests:
    """"Add to the queue" for items that aren't ready yet (a download or a
    lookup is still running): they join the queue when they're ready, in the
    order they were asked for, skipping any that failed."""

    def __init__(self, manager: PlaybackManager) -> None:
        self._manager = manager
        self._lock = threading.Lock()
        # server -> [(item id, actor, where, ready)]
        self._pending: dict[int, list[list[Any]]] = {}

    def add(self, server_id: int, item_id: int, actor_id: int, where: str) -> None:
        with self._lock:
            self._pending.setdefault(server_id, []).append([item_id, actor_id, where, None])

    def wants(self, item_id: int) -> bool:
        with self._lock:
            return any(e[0] == item_id for entries in self._pending.values() for e in entries)

    def finished(self, item_id: int, ok: bool) -> None:
        ready: list[tuple[int, list[tuple[int, int, str]]]] = []
        with self._lock:
            for server_id, entries in self._pending.items():
                for e in entries:
                    if e[0] == item_id and e[3] is None:
                        e[3] = ok
                # Hand over the finished prefix, in order.
                batch = []
                while entries and entries[0][3] is not None:
                    item, actor, where, good = entries.pop(0)
                    if good:
                        batch.append((item, actor, where))
                if batch:
                    ready.append((server_id, batch))
            for server_id in [s for s, e in self._pending.items() if not e]:
                del self._pending[server_id]
        for server_id, batch in ready:
            try:
                with SessionLocal() as db:
                    for item, actor, where in batch:
                        # It may have been deleted (or failed) since it finished.
                        row = db.get(self._manager.item_model, item)
                        if row is None or getattr(row, "status", "ready") != "ready" or getattr(row, "server_id", server_id) != server_id:
                            continue
                        self._manager.enqueue(db, server_id, actor, [item], where)
                    db.commit()
            except Exception:
                log.exception("Queueing finished items failed for server %s", server_id)
