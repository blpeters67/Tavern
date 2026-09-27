"""Database models.

All timestamps are stored as naive UTC datetimes (SQLite has no timezone type);
`serializers.iso()` adds the `Z` back when sending them to clients.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from sqlalchemy import (
    JSON,
    BigInteger,
    Boolean,
    DateTime,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column


def utcnow() -> datetime:
    return datetime.now(timezone.utc).replace(tzinfo=None)


class Base(DeclarativeBase):
    pass


# ---------------------------------------------------------------------------
# Channel / message type constants (numbers borrowed from Discord's API)
# ---------------------------------------------------------------------------


# Voice spaces: everyone's microphone is sent at the space's bitrate (kbps),
# like Discord's per-channel setting. Browsers use 32 when nobody says.
VOICE_BITRATE_DEFAULT = 64
VOICE_BITRATE_MIN = 8
VOICE_BITRATE_MAX = 256


class ChannelType:
    TEXT = 0
    DM = 1
    VOICE = 2
    GROUP_DM = 3
    CATEGORY = 4

    PRIVATE = (DM, GROUP_DM)
    SERVER = (TEXT, VOICE, CATEGORY)


class MessageType:
    DEFAULT = 0
    RECIPIENT_ADD = 1
    RECIPIENT_REMOVE = 2
    CHANNEL_NAME_CHANGE = 4
    CHANNEL_PINNED_MESSAGE = 6
    MEMBER_JOIN = 7
    # Tavern-specific: a dice roll. Details live in meta["roll"].
    ROLL = 20

    SYSTEM = (RECIPIENT_ADD, RECIPIENT_REMOVE, CHANNEL_NAME_CHANGE, CHANNEL_PINNED_MESSAGE, MEMBER_JOIN)
    # Messages people write (and can reply to, react to and pin).
    USER = (DEFAULT, ROLL)


class OverwriteType:
    ROLE = 0
    MEMBER = 1


# ---------------------------------------------------------------------------
# Accounts
# ---------------------------------------------------------------------------


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    email: Mapped[str] = mapped_column(String(254), unique=True, index=True)
    username: Mapped[str] = mapped_column(String(32), unique=True, index=True)
    display_name: Mapped[str | None] = mapped_column(String(32))
    password_hash: Mapped[str] = mapped_column(String(255))
    avatar: Mapped[str | None] = mapped_column(String(80))
    banner_color: Mapped[int | None] = mapped_column(Integer)
    about: Mapped[str | None] = mapped_column(String(190))
    # online / idle / dnd / invisible — what the user picked, not live presence
    status: Mapped[str] = mapped_column(String(16), default="online")
    # Free text shown under your name, e.g. "Taking a break".
    custom_status: Mapped[str | None] = mapped_column(String(128))
    settings: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    is_admin: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    # A connected Spotify account (tokens for reading their playlists). Never sent to clients.
    spotify_auth: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class AuthSession(Base):
    __tablename__ = "sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    last_used_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    user_agent: Mapped[str | None] = mapped_column(String(255))
    ip: Mapped[str | None] = mapped_column(String(64))


class PasswordReset(Base):
    __tablename__ = "password_resets"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    token_hash: Mapped[str] = mapped_column(String(64), unique=True, index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime] = mapped_column(DateTime)
    used_at: Mapped[datetime | None] = mapped_column(DateTime)


class Character(Base):
    __tablename__ = "characters"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(80))
    avatar: Mapped[str | None] = mapped_column(String(80))
    proxy_prefix: Mapped[str | None] = mapped_column(String(32))
    proxy_suffix: Mapped[str | None] = mapped_column(String(32))
    position: Mapped[int] = mapped_column(Integer, default=0)
    # Dialogue colour for in-character messages, "#rrggbb".
    color: Mapped[str | None] = mapped_column(String(7))
    # D&D 5e character sheet (see sheets.py). None until first edited.
    sheet: Mapped[dict[str, Any] | None] = mapped_column(JSON)
    # "public": anyone who shares a server can read it; "private": owner + DMs.
    sheet_visibility: Mapped[str] = mapped_column(String(16), default="public")
    sheet_updated_at: Mapped[datetime | None] = mapped_column(DateTime)
    # Soft-deleted so old messages keep their name and avatar.
    deleted: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# ---------------------------------------------------------------------------
# Servers, roles, members
# ---------------------------------------------------------------------------


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    name: Mapped[str] = mapped_column(String(100))
    icon: Mapped[str | None] = mapped_column(String(80))
    owner_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    # Where "X joined the server" messages go. Not a real FK to avoid a cycle.
    system_channel_id: Mapped[int | None] = mapped_column(Integer)
    # Small line under the server name, e.g. "A home for roleplay".
    tagline: Mapped[str | None] = mapped_column(String(100))
    # Name Dungeon Masters post under when narrating.
    narrator_name: Mapped[str | None] = mapped_column(String(32))
    # While on, only Dungeon Masters control the jukebox.
    roleplay_mode: Mapped[bool] = mapped_column(Boolean, default=False)
    # The game board everyone in this server is looking at. Not a real FK to
    # avoid a cycle (boards point back at servers).
    active_board_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Role(Base):
    __tablename__ = "roles"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    color: Mapped[int] = mapped_column(Integer, default=0)
    permissions: Mapped[int] = mapped_column(BigInteger, default=0)
    position: Mapped[int] = mapped_column(Integer, default=0)
    hoist: Mapped[bool] = mapped_column(Boolean, default=False)
    mentionable: Mapped[bool] = mapped_column(Boolean, default=False)
    # The implicit @everyone role every member has.
    is_default: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Member(Base):
    __tablename__ = "members"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class MemberRole(Base):
    __tablename__ = "member_roles"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    role_id: Mapped[int] = mapped_column(ForeignKey("roles.id", ondelete="CASCADE"), primary_key=True, index=True)


class Ban(Base):
    __tablename__ = "bans"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    reason: Mapped[str | None] = mapped_column(String(512))
    moderator_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Emoji(Base):
    __tablename__ = "emojis"
    __table_args__ = (UniqueConstraint("server_id", "name"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(32))
    file: Mapped[str] = mapped_column(String(80))
    animated: Mapped[bool] = mapped_column(Boolean, default=False)
    creator_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Invite(Base):
    __tablename__ = "invites"

    code: Mapped[str] = mapped_column(String(16), primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id", ondelete="SET NULL"))
    inviter_id: Mapped[int | None] = mapped_column(ForeignKey("users.id", ondelete="SET NULL"))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    expires_at: Mapped[datetime | None] = mapped_column(DateTime)
    max_uses: Mapped[int] = mapped_column(Integer, default=0)
    uses: Mapped[int] = mapped_column(Integer, default=0)


# ---------------------------------------------------------------------------
# Channels & messages
# ---------------------------------------------------------------------------


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int | None] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    type: Mapped[int] = mapped_column(Integer, default=ChannelType.TEXT)
    name: Mapped[str | None] = mapped_column(String(100))
    topic: Mapped[str | None] = mapped_column(String(1024))
    parent_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id", ondelete="SET NULL"))
    position: Mapped[int] = mapped_column(Integer, default=0)
    owner_id: Mapped[int | None] = mapped_column(Integer)  # group DM owner
    icon: Mapped[str | None] = mapped_column(String(80))  # group DM picture
    # Channel icon in the sidebar: a unicode emoji or "c:<custom emoji id>".
    emoji: Mapped[str | None] = mapped_column(String(64))
    # Voice spaces: max people (0 = unlimited).
    user_limit: Mapped[int] = mapped_column(Integer, default=0)
    # Voice spaces: microphone bitrate in kbps (None = VOICE_BITRATE_DEFAULT).
    bitrate: Mapped[int | None] = mapped_column(Integer)
    last_message_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ChannelRecipient(Base):
    """Participants of DMs and group DMs."""

    __tablename__ = "channel_recipients"

    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True, index=True)
    # "Close DM" hides it from the sidebar until a new message arrives.
    hidden: Mapped[bool] = mapped_column(Boolean, default=False)


class PermissionOverwrite(Base):
    __tablename__ = "permission_overwrites"

    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True)
    target_type: Mapped[int] = mapped_column(Integer, primary_key=True)
    target_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    allow: Mapped[int] = mapped_column(BigInteger, default=0)
    deny: Mapped[int] = mapped_column(BigInteger, default=0)


class Message(Base):
    __tablename__ = "messages"
    __table_args__ = (Index("ix_messages_channel_id_id", "channel_id", "id"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"))
    author_id: Mapped[int] = mapped_column(ForeignKey("users.id"), index=True)
    character_id: Mapped[int | None] = mapped_column(ForeignKey("characters.id"))
    type: Mapped[int] = mapped_column(Integer, default=MessageType.DEFAULT)
    content: Mapped[str] = mapped_column(Text, default="")
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)
    edited_at: Mapped[datetime | None] = mapped_column(DateTime)
    reply_to_id: Mapped[int | None] = mapped_column(Integer, index=True)
    mention_reply: Mapped[bool] = mapped_column(Boolean, default=True)
    mention_everyone: Mapped[bool] = mapped_column(Boolean, default=False)
    mention_ids: Mapped[list[int]] = mapped_column(JSON, default=list)
    pinned: Mapped[bool] = mapped_column(Boolean, default=False)
    pinned_at: Mapped[datetime | None] = mapped_column(DateTime)
    embeds: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    suppress_embeds: Mapped[bool] = mapped_column(Boolean, default=False)
    # Private rolls: only the author and Dungeon Masters can see the message.
    dm_only: Mapped[bool] = mapped_column(Boolean, default=False)
    # "Book look": the sender wanted it shown as roleplay prose (a tinted box,
    # "speech" in white, everything else as italic action).
    book: Mapped[bool] = mapped_column(Boolean, default=False)
    # Extra data: pinned message id, dice roll details, narrator flag...
    meta: Mapped[dict[str, Any] | None] = mapped_column(JSON)


class MessageMention(Base):
    """Who a message pinged. Used for red mention badges."""

    __tablename__ = "message_mentions"
    __table_args__ = (Index("ix_mentions_user_channel", "user_id", "channel_id", "message_id"),)

    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), primary_key=True)
    user_id: Mapped[int] = mapped_column(Integer, primary_key=True)
    channel_id: Mapped[int] = mapped_column(Integer)


class Attachment(Base):
    __tablename__ = "attachments"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    message_id: Mapped[int | None] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), index=True)
    uploader_id: Mapped[int] = mapped_column(Integer)
    filename: Mapped[str] = mapped_column(String(255))
    file: Mapped[str] = mapped_column(String(80))
    content_type: Mapped[str] = mapped_column(String(128))
    size: Mapped[int] = mapped_column(Integer)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class Reaction(Base):
    __tablename__ = "reactions"
    __table_args__ = (UniqueConstraint("message_id", "user_id", "emoji_key"),)

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    message_id: Mapped[int] = mapped_column(ForeignKey("messages.id", ondelete="CASCADE"), index=True)
    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    # Unicode emoji itself, or "c:<id>" for custom emojis.
    emoji_key: Mapped[str] = mapped_column(String(64))
    emoji_id: Mapped[int | None] = mapped_column(Integer)
    emoji_name: Mapped[str] = mapped_column(String(64))
    animated: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class ReadState(Base):
    __tablename__ = "read_states"

    user_id: Mapped[int] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"), primary_key=True)
    channel_id: Mapped[int] = mapped_column(ForeignKey("channels.id", ondelete="CASCADE"), primary_key=True)
    last_read_id: Mapped[int] = mapped_column(Integer, default=0)
    # Remembered "speaking as" choice for this channel. 0 = yourself, NULL = never picked.
    last_character_id: Mapped[int | None] = mapped_column(Integer)


# ---------------------------------------------------------------------------
# Jukebox
# ---------------------------------------------------------------------------


class Track(Base):
    """A song in a server's jukebox library."""

    __tablename__ = "tracks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    uploader_id: Mapped[int | None] = mapped_column(Integer)
    title: Mapped[str] = mapped_column(String(200))
    artist: Mapped[str | None] = mapped_column(String(200))
    album: Mapped[str | None] = mapped_column(String(200))
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    file: Mapped[str | None] = mapped_column(String(80))
    mime: Mapped[str | None] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer, default=0)
    cover: Mapped[str | None] = mapped_column(String(80))
    # Loudness correction so quiet and loud songs play at a similar level.
    gain_db: Mapped[float] = mapped_column(default=0.0)
    source_url: Mapped[str | None] = mapped_column(String(1024))
    # processing -> ready | failed
    status: Mapped[str] = mapped_column(String(16), default="processing")
    error: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class JukeboxState(Base):
    """Queue and playback position, saved so a restart picks up where it was."""

    __tablename__ = "jukebox_states"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# ---------------------------------------------------------------------------
# Theater
# ---------------------------------------------------------------------------


class Video(Base):
    """A video in a server's theater library: a YouTube video (played in
    YouTube's own player, so nothing is downloaded) or an uploaded file."""

    __tablename__ = "videos"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    uploader_id: Mapped[int | None] = mapped_column(Integer)
    # "youtube" or "file"
    kind: Mapped[str] = mapped_column(String(16), default="youtube")
    youtube_id: Mapped[str | None] = mapped_column(String(16), index=True)
    title: Mapped[str] = mapped_column(String(200))
    channel: Mapped[str | None] = mapped_column(String(200))
    tags: Mapped[list[str]] = mapped_column(JSON, default=list)
    duration_ms: Mapped[int] = mapped_column(Integer, default=0)
    live: Mapped[bool] = mapped_column(Boolean, default=False)
    # Uploads: the file (and a still for the poster).
    file: Mapped[str | None] = mapped_column(String(80))
    mime: Mapped[str | None] = mapped_column(String(64))
    size: Mapped[int] = mapped_column(Integer, default=0)
    width: Mapped[int | None] = mapped_column(Integer)
    height: Mapped[int | None] = mapped_column(Integer)
    poster: Mapped[str | None] = mapped_column(String(80))
    source_url: Mapped[str | None] = mapped_column(String(1024))
    # processing -> ready | failed
    status: Mapped[str] = mapped_column(String(16), default="processing")
    error: Mapped[str | None] = mapped_column(String(300))
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class TheaterState(Base):
    """The theater's queue and playback position (same shape as the jukebox's)."""

    __tablename__ = "theater_states"

    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), primary_key=True)
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)


# ---------------------------------------------------------------------------
# Game board
# ---------------------------------------------------------------------------


class Board(Base):
    """One saved game board: a background picture with a grid, tokens and
    drawings on top. A server can keep several and switch between them; every
    server member sees the same one at the same time."""

    __tablename__ = "boards"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    server_id: Mapped[int] = mapped_column(ForeignKey("servers.id", ondelete="CASCADE"), index=True)
    name: Mapped[str] = mapped_column(String(100))
    # The background picture (a file in the "boards" bucket) and its pixel size.
    background: Mapped[str | None] = mapped_column(String(80))
    bg_width: Mapped[int | None] = mapped_column(Integer)
    bg_height: Mapped[int | None] = mapped_column(Integer)
    # Grid: square size in board pixels, and whether tokens snap to it.
    grid_size: Mapped[int] = mapped_column(Integer, default=70)
    snap: Mapped[bool] = mapped_column(Boolean, default=True)
    # The text channel this board's rolls land in (usually the game's channel,
    # so rolls keep going there even while someone browses another channel).
    channel_id: Mapped[int | None] = mapped_column(ForeignKey("channels.id", ondelete="SET NULL"))
    # The combat tracker: [{"id", "name", "token_id", "initiative", "current"}].
    tracker: Mapped[list[dict[str, Any]]] = mapped_column(JSON, default=list)
    # Bumped on structural changes so clients can drop stale full states.
    rev: Mapped[int] = mapped_column(Integer, default=0)
    created_by: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BoardToken(Base):
    """A token on a board. A character's token follows the character (name,
    picture, hit points); a free token (an NPC, a marker) carries its own."""

    __tablename__ = "board_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    character_id: Mapped[int | None] = mapped_column(ForeignKey("characters.id", ondelete="SET NULL"))
    name: Mapped[str | None] = mapped_column(String(80))
    avatar: Mapped[str | None] = mapped_column(String(80))
    x: Mapped[float] = mapped_column(default=0.0)
    y: Mapped[float] = mapped_column(default=0.0)
    # ally | neutral | enemy — the ring drawn around the token.
    disposition: Mapped[str] = mapped_column(String(8), default="neutral")
    # Size in grid squares.
    size: Mapped[int] = mapped_column(Integer, default=1)
    # Whose token it is (players move their own characters; DMs move anything).
    owner_id: Mapped[int | None] = mapped_column(Integer)
    # Free tokens carry their own hit points for the bar underneath.
    hp: Mapped[int | None] = mapped_column(Integer)
    hp_max: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


class BoardDrawing(Base):
    """A pen stroke, arrow, shape or text label drawn on a board."""

    __tablename__ = "board_drawings"

    id: Mapped[int] = mapped_column(Integer, primary_key=True)
    board_id: Mapped[int] = mapped_column(ForeignKey("boards.id", ondelete="CASCADE"), index=True)
    # pen | arrow | rect | ellipse | text
    kind: Mapped[str] = mapped_column(String(8), default="pen")
    color: Mapped[str] = mapped_column(String(9), default="#e5484d")
    width: Mapped[float] = mapped_column(default=3.0)
    # pen: {"points": [[x, y], ...]}; arrow/rect/ellipse: {"from", "to"};
    # text: {"at", "text", "size"}.
    data: Mapped[dict[str, Any]] = mapped_column(JSON, default=dict)
    author_id: Mapped[int | None] = mapped_column(Integer)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=utcnow)


# SQLite hands a deleted row's id to the next insert unless AUTOINCREMENT is
# set. Never reuse ids: read markers, cached file URLs and client state all
# assume an id always means the same thing.
for _table in Base.metadata.tables.values():
    _table.dialect_options["sqlite"]["autoincrement"] = True
