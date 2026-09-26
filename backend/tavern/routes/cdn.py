"""Serving uploaded files. Avatars and server icons live at unguessable URLs
and are public; custom emojis need a login; attachments need access to the
channel they were posted in."""

from __future__ import annotations

import mimetypes

from fastapi import APIRouter, Depends
from fastapi.responses import FileResponse
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_db
from ..deps import ApiError, current_user
from ..files import INLINE_TYPES, bucket_path, ensure_preview, wants_preview
from ..models import Attachment, Emoji, Message, User
from ..permissions import P
from ..services import load_channel

router = APIRouter(prefix="/cdn", tags=["cdn"])

SANDBOX = "default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'unsafe-inline'; sandbox"


def _serve(path, media_type: str, *, cache: str, filename: str | None = None, inline: bool = True) -> FileResponse:
    if not path.is_file():
        raise ApiError(404, "File not found.")
    return FileResponse(
        path,
        media_type=media_type,
        filename=filename,
        content_disposition_type="inline" if inline else "attachment",
        headers={
            "Cache-Control": cache,
            "X-Content-Type-Options": "nosniff",
            "Content-Security-Policy": SANDBOX,
            "Cross-Origin-Resource-Policy": "same-origin",
        },
    )


def _image_type(name: str) -> str:
    guessed, _ = mimetypes.guess_type(name)
    return guessed if guessed in ("image/webp", "image/gif", "image/png", "image/jpeg") else "application/octet-stream"


@router.get("/avatars/{name}")
def avatar(name: str) -> FileResponse:
    return _serve(bucket_path("avatars", name), _image_type(name), cache="public, max-age=31536000, immutable")


@router.get("/icons/{name}")
def icon(name: str) -> FileResponse:
    return _serve(bucket_path("icons", name), _image_type(name), cache="public, max-age=31536000, immutable")


@router.get("/emojis/{emoji_id}")
def emoji(emoji_id: str, _user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    try:
        eid = int(emoji_id.split(".")[0])
    except ValueError:
        raise ApiError(404, "Emoji not found.")
    row = db.get(Emoji, eid)
    if row is None:
        raise ApiError(404, "Emoji not found.")
    return _serve(bucket_path("emojis", row.file), _image_type(row.file), cache="private, max-age=604800")


def _readable_attachment(db: Session, attachment_id: int, user: User) -> Attachment:
    """An attachment in a channel this person can read the history of."""
    att = db.get(Attachment, attachment_id)
    if att is None or att.message_id is None:
        raise ApiError(404, "File not found.")
    msg = db.get(Message, att.message_id)
    if msg is None:
        raise ApiError(404, "File not found.")
    load_channel(db, msg.channel_id, user.id, P.READ_MESSAGE_HISTORY)
    return att


def _original(att: Attachment) -> FileResponse:
    inline = att.content_type in INLINE_TYPES
    media_type = att.content_type if inline else "application/octet-stream"
    return _serve(
        bucket_path("attachments", att.file),
        media_type,
        cache="private, max-age=86400",
        filename=att.filename,
        inline=inline,
    )


@router.api_route("/attachments/{attachment_id}/{filename}", methods=["GET", "HEAD"])
def attachment(attachment_id: int, filename: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    return _original(_readable_attachment(db, attachment_id, user))


@router.get("/previews/{attachment_id}.webp")
def attachment_preview(attachment_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    """A big image as chat shows it (made on first request, then kept). Images
    without a sensible preview (animated ones) get the original."""
    att = _readable_attachment(db, attachment_id, user)
    if not wants_preview(att.content_type, att.size, att.width, att.height):
        raise ApiError(404, "File not found.")
    db.close()  # making a preview can take a moment; don't hold a connection for it
    path = ensure_preview(att.file)
    if path is None:
        return _original(att)
    return _serve(path, "image/webp", cache="private, max-age=604800, immutable")


@router.get("/covers/{name}")
def cover(name: str) -> FileResponse:
    return _serve(bucket_path("covers", name), _image_type(name), cache="public, max-age=31536000, immutable")


@router.api_route("/music/{track_id}/{name}", methods=["GET", "HEAD"])
def music(track_id: int, name: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    from ..models import Member, Track

    track = db.get(Track, track_id)
    if track is None or track.file != name or db.get(Member, (track.server_id, user.id)) is None:
        raise ApiError(404, "File not found.")
    return _serve(bucket_path("music", name), track.mime or "audio/mpeg", cache="private, max-age=604800, immutable")


@router.get("/posters/{name}")
def poster(name: str) -> FileResponse:
    return _serve(bucket_path("posters", name), _image_type(name), cache="public, max-age=31536000, immutable")


@router.api_route("/videos/{video_id}/{name}", methods=["GET", "HEAD"])
def video(video_id: int, name: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    """A theater upload. Byte ranges are served, so players can seek."""
    from ..models import Member, Video

    v = db.get(Video, video_id)
    if v is None or v.file != name or db.get(Member, (v.server_id, user.id)) is None:
        raise ApiError(404, "File not found.")
    return _serve(bucket_path("videos", name), v.mime or "video/mp4", cache="private, max-age=604800, immutable")


@router.api_route("/boards/{board_id}/{name}", methods=["GET", "HEAD"])
def board_image(board_id: int, name: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> FileResponse:
    """A board's background picture or a free token's portrait (server members only)."""
    from ..models import Board, BoardToken, Member

    b = db.get(Board, board_id)
    if b is None or db.get(Member, (b.server_id, user.id)) is None:
        raise ApiError(404, "File not found.")
    known = b.background == name or db.scalar(select(BoardToken.id).where(BoardToken.board_id == b.id, BoardToken.avatar == name).limit(1)) is not None
    if not known:
        raise ApiError(404, "File not found.")
    return _serve(bucket_path("boards", name), _image_type(name), cache="private, max-age=604800")
