"""Jukebox HTTP API: library (uploads, link imports, edits) and controls.

Everything that changes what plays needs `can_control_jukebox`: DJs normally,
only Dungeon Masters while DM Lock is on. Listening and your own volume
are client-side and need nothing."""

from __future__ import annotations

import re
from pathlib import Path
from typing import Any, Literal

from fastapi import APIRouter, Depends, File, Form, Query, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db, queue_event
from ..deps import ApiError, bad_request, current_user, forbidden, not_found, rate_limit
from ..files import bucket_path, clean_filename, delete_files, save_image
from .. import spotify
from ..jukebox import (
    jukebox,
    queue_requests,
    submit_import,
    submit_spotify,
    submit_upload,
    track_payload,
    url_import_error,
    youtube_id,
    youtube_search,
    ytdlp_available,
)
from ..models import Track, User
from ..permissions import ServerContext
from ..security import random_key
from ..services import load_server

router = APIRouter(prefix="/api/servers", tags=["jukebox"])

MAX_TRACKS = 5000
TAG_RE = re.compile(r"[^\w &'-]", re.UNICODE)


def _require_control(ctx: ServerContext, user: User) -> None:
    if not ctx.can_control_jukebox(user.id):
        if ctx.server.roleplay_mode:
            raise forbidden("DM Lock is on, so only Dungeon Masters can change the jukebox.")
        raise forbidden("You need the DJ role to change the jukebox.")


def _clean_tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in tags or []:
        tag = " ".join(TAG_RE.sub("", str(raw)).split())[:24]
        if tag and tag.lower() not in {t.lower() for t in out}:
            out.append(tag)
    return out[:12]


def _get_track(db: Session, server_id: int, track_id: int) -> Track:
    t = db.get(Track, track_id)
    if t is None or t.server_id != server_id:
        raise not_found("That track")
    return t


@router.get("/{server_id}/jukebox")
def get_jukebox(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    load_server(db, server_id, user.id)
    return jukebox.payload(db, server_id)


@router.get("/{server_id}/jukebox/tracks")
def list_tracks(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    load_server(db, server_id, user.id)
    tracks = db.scalars(select(Track).where(Track.server_id == server_id).order_by(Track.id.desc()))
    return {
        "tracks": [track_payload(t, jukebox.progress.get(t.id)) for t in tracks],
        "imports_enabled": settings.jukebox_url_imports and ytdlp_available(),
        "spotify": spotify.configured(),
        "max_track_mb": settings.jukebox_max_track_mb,
    }


@router.post("/{server_id}/jukebox/tracks")
def upload_tracks(
    server_id: int,
    files: list[UploadFile] = File(...),
    tags: str = Form("[]"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    rate_limit(f"jukebox-upload:{user.id}", 60, 600)
    try:
        import json

        tag_list = _clean_tags(json.loads(tags or "[]"))
    except ValueError:
        tag_list = []
    count = len(list(db.scalars(select(Track.id).where(Track.server_id == server_id))))
    if count + len(files) > MAX_TRACKS:
        raise bad_request(f"The library holds up to {MAX_TRACKS} tracks.")
    limit = settings.jukebox_max_track_mb * 1024 * 1024
    created: list[tuple[Track, Path]] = []
    try:
        for upload in files[:50]:
            filename = clean_filename(upload.filename)
            tmp = bucket_path("tmp", f"up-{random_key(12)}{Path(filename).suffix.lower()[:10]}")
            size = 0
            with open(tmp, "wb") as out:
                while chunk := upload.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        raise ApiError(413, f"{filename} is bigger than {settings.jukebox_max_track_mb} MB.")
                    out.write(chunk)
            if size == 0:
                tmp.unlink(missing_ok=True)
                continue
            title = re.sub(r"[_]+", " ", Path(filename).stem).strip()[:200] or "Untitled"
            t = Track(server_id=server_id, uploader_id=user.id, title=title, tags=tag_list, status="processing", size=size)
            db.add(t)
            db.flush()
            created.append((t, tmp))
    except BaseException:
        for _t, tmp in created:
            tmp.unlink(missing_ok=True)
        raise
    members = ctx.member_ids
    for t, _tmp in created:
        queue_event(db, members, "JUKEBOX_TRACK_UPDATE", track_payload(t, 0.0))
    db.commit()
    for t, tmp in created:
        submit_upload(t.id, tmp)
    return {"tracks": [track_payload(t) for t, _ in created]}


class ImportIn(BaseModel):
    url: str = Field(max_length=1024)
    tags: list[str] = Field(default_factory=list)
    # Also put it in the queue once it's downloaded ("end", "next" or "now").
    queue: Literal["end", "next", "now"] | None = None
    # Title to show while it downloads (e.g. from a search result).
    title: str | None = Field(default=None, max_length=200)


def _library_copy(db: Session, server_id: int, url: str) -> Track | None:
    """A track already in this library from the same YouTube video (or link)."""
    vid = youtube_id(url)
    if vid:
        rows = db.scalars(
            select(Track).where(Track.server_id == server_id, Track.source_url.like(f"%{vid}%"), Track.status.in_(("ready", "processing")))
        )
        return next((t for t in rows if youtube_id(t.source_url) == vid), None)
    return db.scalar(select(Track).where(Track.server_id == server_id, Track.source_url == url, Track.status.in_(("ready", "processing"))))


def _check_imports() -> None:
    if not settings.jukebox_url_imports:
        raise forbidden("Link imports are turned off on this server.")
    if not ytdlp_available():
        raise ApiError(400, "Link imports need yt-dlp installed on the server.")


@router.post("/{server_id}/jukebox/import")
def import_link(server_id: int, body: ImportIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    _check_imports()
    url = body.url.strip()
    link = spotify.parse_link(url)
    if link is not None:
        if not spotify.configured():
            err = "Spotify links need a Spotify API key on the server (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET in .env)."
            raise ApiError(400, err, {"url": err})
        kind, spotify_id = link
        url = f"https://open.spotify.com/{kind}/{spotify_id}"
    elif err := url_import_error(url):
        raise ApiError(400, err, {"url": err})
    # Already in the library? Don't download it twice.
    existing = _library_copy(db, server_id, url)
    if existing is not None:
        if body.queue:
            if existing.status == "ready":
                jukebox.enqueue(db, server_id, user.id, [existing.id], body.queue)
                db.commit()
            elif not queue_requests.wants(existing.id):
                queue_requests.add(server_id, existing.id, user.id, body.queue)
        return {"track": track_payload(existing, jukebox.progress.get(existing.id)), "existing": True}
    rate_limit(f"jukebox-import:{user.id}", 30, 600)
    title = (body.title or "").strip() or (f"Spotify {link[0]}" if link else url)
    t = Track(server_id=server_id, uploader_id=user.id, title=title[:200], tags=_clean_tags(body.tags), source_url=url, status="processing")
    db.add(t)
    db.flush()
    queue_event(db, ctx.member_ids, "JUKEBOX_TRACK_UPDATE", track_payload(t, 0.0))
    db.commit()
    if link is not None:
        # The worker reads the songs, then queues them in order if asked.
        submit_spotify(t.id, link[0], link[1], server_id, user.id, list(t.tags or []), body.queue)
        return {"track": track_payload(t, 0.0)}
    if body.queue:
        queue_requests.add(server_id, t.id, user.id, body.queue)
    submit_import(t.id, url, server_id, user.id, list(t.tags or []))
    return {"track": track_payload(t, 0.0)}


@router.get("/{server_id}/jukebox/search")
def search_youtube(
    server_id: int,
    q: str = Query(min_length=1, max_length=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Find songs on YouTube to add to the queue or the library."""
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    _check_imports()
    rate_limit(f"jukebox-search:{user.id}", 40, 60, "Searching too quickly. Give it a moment.")
    try:
        results = youtube_search(q.strip())
    except Exception as exc:  # noqa: BLE001 - network/extractor trouble
        from ..jukebox import _ydl_error

        raise ApiError(502, f"YouTube search failed: {_ydl_error(exc)}") from None
    # Mark results that are already in the library.
    ids = [r["id"] for r in results]
    have: dict[str, Track] = {}
    if ids:
        for t in db.scalars(select(Track).where(Track.server_id == server_id, Track.source_url.is_not(None), Track.status.in_(("ready", "processing")))):
            vid = youtube_id(t.source_url)
            if vid in ids:
                have[vid] = t
    return {
        "results": [
            r | {"track_id": have[r["id"]].id if r["id"] in have else None, "track_status": have[r["id"]].status if r["id"] in have else None}
            for r in results
        ]
    }


class TrackPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    artist: str | None = Field(default=None, max_length=200)
    album: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None


@router.patch("/{server_id}/jukebox/tracks/{track_id}")
def edit_track(server_id: int, track_id: int, body: TrackPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    t = _get_track(db, server_id, track_id)
    fields = body.model_fields_set
    if "title" in fields and body.title is not None:
        title = " ".join(body.title.split())
        if not title:
            raise bad_request("Tracks need a title.")
        t.title = title[:200]
    if "artist" in fields:
        t.artist = " ".join((body.artist or "").split())[:200] or None
    if "album" in fields:
        t.album = " ".join((body.album or "").split())[:200] or None
    if "tags" in fields:
        t.tags = _clean_tags(body.tags)
    payload = track_payload(t)
    queue_event(db, ctx.member_ids, "JUKEBOX_TRACK_UPDATE", payload)
    if jukebox.uses_track(db, server_id, track_id):
        jukebox.mutate(db, server_id, user.id, lambda state, now: None, ctx.member_ids)
    db.commit()
    return payload


@router.put("/{server_id}/jukebox/tracks/{track_id}/cover")
def set_cover(server_id: int, track_id: int, file: UploadFile = File(...), user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    t = _get_track(db, server_id, track_id)
    old = t.cover
    t.cover, _ = save_image(file, "covers", square=True, size=512)
    payload = track_payload(t)
    queue_event(db, ctx.member_ids, "JUKEBOX_TRACK_UPDATE", payload)
    if jukebox.uses_track(db, server_id, track_id):
        jukebox.mutate(db, server_id, user.id, lambda state, now: None, ctx.member_ids)
    db.commit()
    delete_files("covers", [old])
    return payload


@router.delete("/{server_id}/jukebox/tracks/{track_id}")
def delete_track(server_id: int, track_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    t = _get_track(db, server_id, track_id)
    files = (t.file, t.cover)
    db.delete(t)
    queue_event(db, ctx.member_ids, "JUKEBOX_TRACK_DELETE", {"server_id": server_id, "track_id": track_id})
    jukebox.drop_track(db, server_id, track_id)
    db.commit()
    # A "queue it when it's ready" request for it would hold up the ones after it.
    queue_requests.finished(track_id, ok=False)
    delete_files("music", [files[0]])
    delete_files("covers", [files[1]])
    return {"ok": True}


@router.post("/{server_id}/jukebox/tracks/{track_id}/retry")
def retry_track(server_id: int, track_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    t = _get_track(db, server_id, track_id)
    if t.status != "failed" or not t.source_url:
        raise bad_request("Only failed link imports can be retried.")
    if err := url_import_error(t.source_url):
        raise bad_request(err)
    t.status = "processing"
    t.error = None
    queue_event(db, ctx.member_ids, "JUKEBOX_TRACK_UPDATE", track_payload(t, 0.0))
    db.commit()
    submit_import(t.id, t.source_url, server_id, user.id, list(t.tags or []))
    return track_payload(t)


# ---------------------------------------------------------------------------
# Queue & playback
# ---------------------------------------------------------------------------


class QueueIn(BaseModel):
    track_ids: list[int] = Field(min_length=1, max_length=500)
    where: Literal["end", "next", "now"] = "end"


@router.post("/{server_id}/jukebox/queue")
def enqueue(server_id: int, body: QueueIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    ready = {
        t.id
        for t in db.scalars(select(Track).where(Track.server_id == server_id, Track.id.in_(body.track_ids), Track.status == "ready"))
    }
    ids = [tid for tid in body.track_ids if tid in ready]
    if not ids:
        raise bad_request("Those tracks aren't ready to play yet.")
    jukebox.enqueue(db, server_id, user.id, ids, body.where)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/jukebox/queue/{qid}")
def dequeue(server_id: int, qid: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    jukebox.remove(db, server_id, user.id, qid)
    db.commit()
    return {"ok": True}


class QueueOrderIn(BaseModel):
    qids: list[str]


@router.put("/{server_id}/jukebox/queue")
def reorder_queue(server_id: int, body: QueueOrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    try:
        jukebox.reorder(db, server_id, user.id, body.qids)
    except ValueError:
        raise ApiError(409, "The queue changed. Try again.") from None
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/jukebox/queue")
def clear_queue(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    jukebox.clear(db, server_id, user.id)
    db.commit()
    return {"ok": True}


class ControlIn(BaseModel):
    action: Literal["play", "pause", "skip", "previous", "stop", "fade_out", "seek", "volume", "repeat", "shuffle", "fade", "jump"]
    value: Any = None


@router.post("/{server_id}/jukebox/control")
def control(server_id: int, body: ControlIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    rate_limit(f"jukebox-control:{user.id}", 60, 10)
    try:
        jukebox.control(db, server_id, user.id, body.action, body.value)
    except KeyError:
        raise ApiError(409, "The queue changed. Try again.") from None
    except (TypeError, ValueError):
        raise bad_request("That jukebox action didn't make sense.") from None
    db.commit()
    return {"ok": True}
