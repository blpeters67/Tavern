"""SQLite engine, sessions, and the post-commit event queue.

Route handlers queue gateway events with `queue_event(db, ...)`. The events are
only sent to clients after the transaction commits, so nobody ever sees a
message that was rolled back.
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Iterator
from typing import Any

from sqlalchemy import create_engine, event, inspect, text
from sqlalchemy.orm import Session, sessionmaker

from .config import settings
from .models import Base

log = logging.getLogger("tavern.db")

settings.data_dir.mkdir(parents=True, exist_ok=True)

engine = create_engine(
    f"sqlite:///{settings.db_path}",
    connect_args={"check_same_thread": False, "timeout": 30},
)


@event.listens_for(engine, "connect")
def _sqlite_pragmas(dbapi_conn, _record) -> None:  # pragma: no cover - trivial
    cur = dbapi_conn.cursor()
    cur.execute("PRAGMA journal_mode=WAL")
    cur.execute("PRAGMA foreign_keys=ON")
    cur.execute("PRAGMA synchronous=NORMAL")
    cur.execute("PRAGMA busy_timeout=30000")
    cur.close()


SessionLocal = sessionmaker(bind=engine, expire_on_commit=False, autoflush=False)


def get_db() -> Iterator[Session]:
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()


# ---------------------------------------------------------------------------
# Post-commit gateway events
# ---------------------------------------------------------------------------


def queue_event(db: Session, audience: Iterable[int], name: str, data: dict[str, Any]) -> None:
    """Send `name` to every user id in `audience` once `db` commits."""
    users = {int(u) for u in audience}
    if users:
        db.info.setdefault("events", []).append((users, name, data))


@event.listens_for(SessionLocal, "after_commit")
def _flush_events(session: Session) -> None:
    events = session.info.pop("events", None)
    if not events:
        return
    from .gateway import gateway  # local import: gateway imports db helpers

    for users, name, data in events:
        gateway.publish(users, name, data)


@event.listens_for(SessionLocal, "after_rollback")
def _drop_events(session: Session) -> None:
    session.info.pop("events", None)


# ---------------------------------------------------------------------------
# Schema setup
# ---------------------------------------------------------------------------


# Stored in SQLite's `PRAGMA user_version`. Tavern 1.x never set it (0).
SCHEMA_VERSION = 3


def init_db() -> None:
    settings.uploads_dir.mkdir(parents=True, exist_ok=True)
    with engine.connect() as conn:
        version = conn.exec_driver_sql("PRAGMA user_version").scalar() or 0
        had_data = inspect(conn).has_table("servers")
    Base.metadata.create_all(engine)
    _add_missing_columns()
    _setup_search()
    if version < SCHEMA_VERSION:
        if had_data and version < 2:
            _upgrade_to_v2()
        if had_data and version < 3:
            _upgrade_to_v3()
        with engine.begin() as conn:
            conn.exec_driver_sql(f"PRAGMA user_version = {SCHEMA_VERSION}")


def _upgrade_to_v2() -> None:
    """One-time changes for a database made by Tavern 1.x, which had no voice
    spaces, jukebox or roleplay roles and kept channel names lowercase."""
    from sqlalchemy import select

    from .models import Channel, ChannelType, PermissionOverwrite, Role, Server
    from .permissions import P

    with SessionLocal() as db:
        servers = db.scalars(select(Server)).all()
        for server in servers:
            roles = db.scalars(select(Role).where(Role.server_id == server.id)).all()
            # Voice spaces are new, so nobody had permission to use them yet.
            for role in roles:
                if role.is_default:
                    role.permissions |= P.CONNECT | P.SPEAK | P.STREAM
            # The two roles every new server starts with, just above @everyone.
            if not any(role.permissions & (P.DUNGEON_MASTER | P.DJ) for role in roles):
                for role in roles:
                    if not role.is_default:
                        role.position += 2
                db.add(Role(server_id=server.id, name="Dungeon Master", color=0xE0B252, permissions=P.DUNGEON_MASTER | P.DJ, position=2, hoist=True))
                db.add(Role(server_id=server.id, name="DJ", color=0xA78BFA, permissions=P.DJ, position=1))
            channels = db.scalars(select(Channel).where(Channel.server_id == server.id)).all()
            if not any(ch.type == ChannelType.VOICE for ch in channels):
                db.add(Channel(server_id=server.id, type=ChannelType.VOICE, name="The Lounge", position=0))
            # 1.x started every server with a "Text Channels" category, which now
            # repeats the sidebar's own heading. Unwrap it unless it has permissions.
            for cat in [ch for ch in channels if ch.type == ChannelType.CATEGORY and (ch.name or "").strip().lower() == "text channels"]:
                children = [ch for ch in channels if ch.parent_id == cat.id]
                has_overwrites = db.scalar(select(PermissionOverwrite.channel_id).where(PermissionOverwrite.channel_id == cat.id).limit(1))
                if has_overwrites is not None or any(ch.type != ChannelType.TEXT for ch in children):
                    continue
                # Same order as before: loose channels first, then the category's.
                loose = sorted((ch for ch in channels if ch.type == ChannelType.TEXT and ch.parent_id is None), key=lambda ch: (ch.position, ch.id))
                for i, ch in enumerate(loose + sorted(children, key=lambda ch: (ch.position, ch.id))):
                    ch.parent_id = None
                    ch.position = i
                db.delete(cat)
            # 1.x turned "Tavern Hall" into "tavern-hall"; names keep their case now.
            for ch in channels:
                if ch.type == ChannelType.TEXT and ch.name and ch.name == ch.name.lower():
                    pretty = _title_channel_name(ch.name)
                    if pretty:
                        ch.name = pretty[:100]
            if server.narrator_name is None:
                server.narrator_name = "The GM"
        db.commit()
    if servers:
        log.info("Upgraded %d server(s) from Tavern 1.x: voice spaces, roleplay roles, channel names", len(servers))


def _upgrade_to_v3() -> None:
    """2.1 made the roleplay look ("book look") a choice per message. Messages
    sent as a character before then keep the look they had."""
    with engine.begin() as conn:
        n = conn.execute(text("UPDATE messages SET book = 1 WHERE character_id IS NOT NULL AND book = 0")).rowcount
    if n:
        log.info("Kept the roleplay look on %d earlier character message(s)", n)


_SPECIAL_WORDS = {
    "ooc": "OOC", "ic": "IC", "rp": "RP", "rpg": "RPG", "ttrpg": "TTRPG", "dnd": "DnD",
    "dm": "DM", "dms": "DMs", "gm": "GM", "gms": "GMs", "npc": "NPC", "npcs": "NPCs", "pc": "PC", "pcs": "PCs",
    "faq": "FAQ", "lfg": "LFG", "afk": "AFK", "irl": "IRL", "nsfw": "NSFW", "sfw": "SFW",
    "pvp": "PvP", "pve": "PvE", "qna": "QnA", "vc": "VC", "tv": "TV",
}
_SMALL_WORDS = {"a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to", "vs", "with"}


def _title_channel_name(slug: str) -> str:
    """"ooc-chat" -> "OOC Chat", "lore-of-the-world" -> "Lore of the World"."""
    words = [w for w in slug.split("-") if w]
    out = []
    for i, word in enumerate(words):
        if word in _SPECIAL_WORDS:
            out.append(_SPECIAL_WORDS[word])
        elif i > 0 and word in _SMALL_WORDS:
            out.append(word)
        else:
            out.append(word[:1].upper() + word[1:])
    return " ".join(out)


FTS_TRIGGERS = (
    """CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END""",
    """CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
    END""",
    """CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE OF content ON messages BEGIN
        INSERT INTO messages_fts(messages_fts, rowid, content) VALUES ('delete', old.id, old.content);
        INSERT INTO messages_fts(rowid, content) VALUES (new.id, new.content);
    END""",
)


def _setup_search() -> None:
    """Full-text index over message content (SQLite FTS5), kept in sync by triggers."""
    with engine.begin() as conn:
        exists = conn.execute(text("SELECT name FROM sqlite_master WHERE type='table' AND name='messages_fts'")).first()
        try:
            conn.execute(
                text(
                    "CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5("
                    "content, content='messages', content_rowid='id', tokenize='unicode61 remove_diacritics 2')"
                )
            )
        except Exception:  # pragma: no cover - SQLite built without FTS5
            log.warning("SQLite has no FTS5; message search is disabled.")
            return
        for trigger in FTS_TRIGGERS:
            conn.execute(text(trigger))
        if not exists:
            conn.execute(text("INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')"))


def _add_missing_columns() -> None:
    """Tiny forward-only migration: add columns that exist on a model but not in
    the database yet. Covers the common "added a field" case without needing a
    migration tool. Renames and removals still need manual care."""
    insp = inspect(engine)
    with engine.begin() as conn:
        for table in Base.metadata.sorted_tables:
            if not insp.has_table(table.name):
                continue
            existing = {c["name"] for c in insp.get_columns(table.name)}
            for column in table.columns:
                if column.name in existing:
                    continue
                col_type = column.type.compile(dialect=engine.dialect)
                default_sql = ""
                default = column.default.arg if column.default is not None and column.default.is_scalar else None
                if isinstance(default, bool):
                    default_sql = f" DEFAULT {int(default)}"
                elif isinstance(default, (int, float)):
                    default_sql = f" DEFAULT {default}"
                elif isinstance(default, str):
                    escaped = default.replace("'", "''")
                    default_sql = f" DEFAULT '{escaped}'"
                elif not column.nullable:
                    log.warning("Can't auto-add NOT NULL column %s.%s without a default", table.name, column.name)
                    continue
                log.info("Adding column %s.%s", table.name, column.name)
                conn.execute(text(f'ALTER TABLE "{table.name}" ADD COLUMN "{column.name}" {col_type}{default_sql}'))
