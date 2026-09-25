"""Theater HTTP API: the video library (YouTube links, uploads), the queue and
the controls. Changing what plays needs the same rights as the jukebox: DJs
normally, only Dungeon Masters while DM Lock is on. Taking a seat and your own
volume are client-side and need nothing."""

from __future__ import annotations

import json
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
from ..files import bucket_path, clean_filename, delete_files
from ..jukebox import youtube_search, ytdlp_available
from ..models import User, Video
from ..permissions import ServerContext
from ..security import random_key
from ..services import load_server
from ..theater import (
    is_youtube_link,
    queue_requests,
    request_verify,
    submit_lookup,
    submit_playlist,
    submit_video_upload,
    theater,
    video_payload,
    youtube_id,
    youtube_playlist_id,
)

router = APIRouter(prefix="/api/servers", tags=["theater"])

MAX_VIDEOS = 5000
TAG_RE = re.compile(r"[^\w &'-]", re.UNICODE)
VIDEO_EXTS = {".mp4", ".m4v", ".mov", ".webm", ".mkv", ".avi", ".wmv", ".flv", ".mpg", ".mpeg", ".ogv", ".3gp", ".ts"}


def _require_control(ctx: ServerContext, user: User) -> None:
    if not ctx.can_control_jukebox(user.id):
        if ctx.server.roleplay_mode:
            raise forbidden("DM Lock is on, so only Dungeon Masters can change the theater.")
        raise forbidden("You need the DJ role to run the theater.")


def _clean_tags(tags: list[str] | None) -> list[str]:
    out: list[str] = []
    for raw in tags or []:
        tag = " ".join(TAG_RE.sub("", str(raw)).split())[:24]
        if tag and tag.lower() not in {t.lower() for t in out}:
            out.append(tag)
    return out[:12]


def _get_video(db: Session, server_id: int, video_id: int) -> Video:
    v = db.get(Video, video_id)
    if v is None or v.server_id != server_id:
        raise not_found("That video")
    return v


@router.get("/{server_id}/theater")
def get_theater(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    load_server(db, server_id, user.id)
    return theater.payload(db, server_id)


@router.get("/{server_id}/theater/videos")
def list_videos(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    load_server(db, server_id, user.id)
    videos = db.scalars(select(Video).where(Video.server_id == server_id).order_by(Video.id.desc()))
    return {
        "videos": [video_payload(v, theater.progress.get(v.id)) for v in videos],
        "search_enabled": ytdlp_available(),
        "max_video_mb": settings.theater_max_video_mb,
    }


@router.post("/{server_id}/theater/videos")
def upload_videos(
    server_id: int,
    files: list[UploadFile] = File(...),
    tags: str = Form("[]"),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    rate_limit(f"theater-upload:{user.id}", 30, 600)
    try:
        tag_list = _clean_tags(json.loads(tags or "[]"))
    except ValueError:
        tag_list = []
    count = len(list(db.scalars(select(Video.id).where(Video.server_id == server_id))))
    if count + len(files) > MAX_VIDEOS:
        raise bad_request(f"The theater holds up to {MAX_VIDEOS} videos.")
    limit = settings.theater_max_video_mb * 1024 * 1024
    created: list[tuple[Video, Path]] = []
    try:
        for upload in files[:10]:
            filename = clean_filename(upload.filename)
            ext = Path(filename).suffix.lower()
            if ext not in VIDEO_EXTS and not (upload.content_type or "").startswith("video/"):
                raise bad_request(f"{filename} isn't a video file.")
            tmp = bucket_path("tmp", f"vid-{random_key(12)}{ext[:10]}")
            size = 0
            with open(tmp, "wb") as out:
                while chunk := upload.file.read(1024 * 1024):
                    size += len(chunk)
                    if size > limit:
                        out.close()
                        tmp.unlink(missing_ok=True)
                        raise ApiError(413, f"{filename} is bigger than {settings.theater_max_video_mb} MB.")
                    out.write(chunk)
            if size == 0:
                tmp.unlink(missing_ok=True)
                continue
            title = re.sub(r"[_]+", " ", Path(filename).stem).strip()[:200] or "Untitled"
            v = Video(server_id=server_id, uploader_id=user.id, kind="file", title=title, tags=tag_list, status="processing", size=size)
            db.add(v)
            db.flush()
            created.append((v, tmp))
    except BaseException:
        for _v, tmp in created:
            tmp.unlink(missing_ok=True)
        raise
    for v, _tmp in created:
        queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", video_payload(v, 0.0))
    db.commit()
    for v, tmp in created:
        theater.progress[v.id] = 0.0
        submit_video_upload(v.id, tmp)
    return {"videos": [video_payload(v) for v, _ in created]}


class AddIn(BaseModel):
    url: str = Field(max_length=1024)
    tags: list[str] = Field(default_factory=list)
    # Also put it in the queue ("end", "next" or "now").
    queue: Literal["end", "next", "now"] | None = None
    # Known already when it comes from search results (then it's ready at once).
    title: str | None = Field(default=None, max_length=200)
    channel: str | None = Field(default=None, max_length=200)
    duration_ms: int | None = Field(default=None, ge=0, le=86_400_000)


@router.post("/{server_id}/theater/add")
def add_link(server_id: int, body: AddIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """Add a YouTube video (or a whole playlist) to the library, and maybe the queue."""
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    url = body.url.strip()
    if not is_youtube_link(url):
        err = "Paste a YouTube link. Other videos can be uploaded as files."
        raise ApiError(400, err, {"url": err})
    yid = youtube_id(url)
    lid = youtube_playlist_id(url)
    tags = _clean_tags(body.tags)
    if lid and (not yid or "/playlist" in url):
        if not ytdlp_available():
            raise ApiError(400, "Playlists need yt-dlp on the server.")
        rate_limit(f"theater-add:{user.id}", 30, 600)
        v = Video(server_id=server_id, uploader_id=user.id, kind="youtube", title="YouTube playlist", tags=tags, source_url=url, status="processing")
        db.add(v)
        db.flush()
        queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", video_payload(v, 0.0))
        db.commit()
        submit_playlist(v.id, lid, server_id, user.id, tags, body.queue)
        return {"video": video_payload(v, 0.0), "playlist": True}
    if not yid:
        err = "That doesn't look like a YouTube video link."
        raise ApiError(400, err, {"url": err})

    existing = db.scalar(select(Video).where(Video.server_id == server_id, Video.youtube_id == yid, Video.status.in_(("ready", "processing"))))
    if existing is not None:
        if body.queue:
            if existing.status == "ready":
                theater.enqueue(db, server_id, user.id, [existing.id], body.queue)
                db.commit()
            elif not queue_requests.wants(existing.id):
                queue_requests.add(server_id, existing.id, user.id, body.queue)
        return {"video": video_payload(existing), "existing": True}

    rate_limit(f"theater-add:{user.id}", 60, 600)
    known = bool(body.title and body.duration_ms)
    lookups = ytdlp_available()
    v = Video(
        server_id=server_id,
        uploader_id=user.id,
        kind="youtube",
        youtube_id=yid,
        title=(body.title or "YouTube video").strip()[:200] or "YouTube video",
        channel=(body.channel or None),
        duration_ms=body.duration_ms or 0,
        tags=tags,
        source_url=f"https://www.youtube.com/watch?v={yid}",
        # From search results (or with no way to look it up): ready right away.
        status="ready" if known or not lookups else "processing",
    )
    db.add(v)
    db.flush()
    queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", video_payload(v))
    if v.status == "ready" and body.queue:
        theater.enqueue(db, server_id, user.id, [v.id], body.queue)
    db.commit()
    if v.status == "processing":
        if body.queue:
            queue_requests.add(server_id, v.id, user.id, body.queue)
        submit_lookup(v.id, yid)
    elif lookups:
        # Double-check it may play outside YouTube; it leaves the queue if not.
        submit_lookup(v.id, yid, verify=True)
    return {"video": video_payload(v)}


@router.get("/{server_id}/theater/search")
def search_youtube(
    server_id: int,
    q: str = Query(min_length=1, max_length=200),
    user: User = Depends(current_user),
    db: Session = Depends(get_db),
) -> dict:
    """Find videos on YouTube to watch together."""
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    if not ytdlp_available():
        raise ApiError(400, "Searching YouTube needs yt-dlp on the server.")
    rate_limit(f"theater-search:{user.id}", 40, 60, "Searching too quickly. Give it a moment.")
    try:
        results = youtube_search(q.strip())
    except Exception as exc:  # noqa: BLE001 - network/extractor trouble
        from ..jukebox import _ydl_error

        raise ApiError(502, f"YouTube search failed: {_ydl_error(exc)}") from None
    ids = [r["id"] for r in results]
    have: dict[str, Video] = {}
    if ids:
        for v in db.scalars(select(Video).where(Video.server_id == server_id, Video.youtube_id.in_(ids), Video.status.in_(("ready", "processing")))):
            have[v.youtube_id or ""] = v
    return {
        "results": [
            r | {"video_id": have[r["id"]].id if r["id"] in have else None, "video_status": have[r["id"]].status if r["id"] in have else None}
            for r in results
        ]
    }


class VideoPatch(BaseModel):
    title: str | None = Field(default=None, max_length=200)
    tags: list[str] | None = None


@router.patch("/{server_id}/theater/videos/{video_id}")
def edit_video(server_id: int, video_id: int, body: VideoPatch, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    v = _get_video(db, server_id, video_id)
    fields = body.model_fields_set
    if "title" in fields and body.title is not None:
        title = " ".join(body.title.split())
        if not title:
            raise bad_request("Videos need a title.")
        v.title = title[:200]
    if "tags" in fields:
        v.tags = _clean_tags(body.tags)
    payload = video_payload(v)
    queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", payload)
    if theater.uses_item(db, server_id, video_id):
        theater.mutate(db, server_id, user.id, lambda state, now: None, ctx.member_ids)
    db.commit()
    return payload


@router.delete("/{server_id}/theater/videos/{video_id}")
def delete_video(server_id: int, video_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    v = _get_video(db, server_id, video_id)
    files = (v.file, v.poster)
    db.delete(v)
    queue_event(db, ctx.member_ids, "THEATER_VIDEO_DELETE", {"server_id": server_id, "video_id": video_id})
    theater.drop_item(db, server_id, video_id)
    db.commit()
    # A "queue it when it's ready" request for it would hold up the ones after it.
    queue_requests.finished(video_id, ok=False)
    theater.progress.pop(video_id, None)
    delete_files("videos", [files[0]])
    delete_files("posters", [files[1]])
    return {"ok": True}


@router.post("/{server_id}/theater/videos/{video_id}/retry")
def retry_video(server_id: int, video_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    v = _get_video(db, server_id, video_id)
    if v.status != "failed" or v.kind != "youtube" or not v.youtube_id:
        raise bad_request("Only YouTube videos that failed can be tried again.")
    if not ytdlp_available():
        raise bad_request("Checking videos needs yt-dlp on the server.")
    v.status = "processing"
    v.error = None
    queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", video_payload(v))
    db.commit()
    submit_lookup(v.id, v.youtube_id)
    return video_payload(v)


class ReportIn(BaseModel):
    # Its length, when the library didn't know it (the player does).
    duration_ms: int | None = Field(default=None, gt=0, le=86_400_000)
    # YouTube player errors: 100 = gone/private, 101/150 = not allowed outside YouTube.
    error_code: int | None = None


@router.post("/{server_id}/theater/videos/{video_id}/report")
def report_video(server_id: int, video_id: int, body: ReportIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    """What a viewer's player found out about the video on screen: how long it
    is, or that it can't play. Only someone in a seat can tell us, only about
    what's showing now, and a "can't play" is double-checked before it's taken
    away from everyone (it may only be blocked where that viewer is)."""
    ctx = load_server(db, server_id, user.id)
    v = _get_video(db, server_id, video_id)
    rate_limit(f"theater-report:{user.id}", 30, 60)
    if user.id not in theater.listeners(server_id) or not theater.is_current(db, server_id, video_id):
        return {"ok": False}
    changed = False
    if body.duration_ms and not v.duration_ms and not v.live:
        # It has to be at least as long as everyone has already been watching it.
        if body.duration_ms >= max(1000, theater.elapsed(db, server_id) - 3000):
            v.duration_ms = body.duration_ms
            changed = True
            theater.set_duration(db, server_id, v.id, v.duration_ms)
    if body.error_code in (100, 101, 150) and v.kind == "youtube" and v.status == "ready":
        if ytdlp_available() and v.youtube_id:
            request_verify(v.id, v.youtube_id)
        elif ctx.can_control_jukebox(user.id):
            # Nothing to check with here, so a DJ's word is enough.
            v.status = "failed"
            v.error = "That video is gone or private." if body.error_code == 100 else "The owner doesn't allow this video to play outside YouTube."
            changed = True
    if changed:
        queue_event(db, ctx.member_ids, "THEATER_VIDEO_UPDATE", video_payload(v))
        if v.status == "failed":
            theater.drop_item(db, server_id, v.id)
        db.commit()
    return {"ok": True}


# ---------------------------------------------------------------------------
# Queue & playback
# ---------------------------------------------------------------------------


class QueueIn(BaseModel):
    video_ids: list[int] = Field(min_length=1, max_length=500)
    where: Literal["end", "next", "now"] = "end"


@router.post("/{server_id}/theater/queue")
def enqueue(server_id: int, body: QueueIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    ready = {v.id for v in db.scalars(select(Video).where(Video.server_id == server_id, Video.id.in_(body.video_ids), Video.status == "ready"))}
    ids = [vid for vid in body.video_ids if vid in ready]
    if not ids:
        raise bad_request("Those videos aren't ready to play yet.")
    theater.enqueue(db, server_id, user.id, ids, body.where)
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/theater/queue/{qid}")
def dequeue(server_id: int, qid: str, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    theater.remove(db, server_id, user.id, qid)
    db.commit()
    return {"ok": True}


class QueueOrderIn(BaseModel):
    qids: list[str]


@router.put("/{server_id}/theater/queue")
def reorder_queue(server_id: int, body: QueueOrderIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    try:
        theater.reorder(db, server_id, user.id, body.qids)
    except ValueError:
        raise ApiError(409, "The queue changed. Try again.") from None
    db.commit()
    return {"ok": True}


@router.delete("/{server_id}/theater/queue")
def clear_queue(server_id: int, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    theater.clear(db, server_id, user.id)
    db.commit()
    return {"ok": True}


class ControlIn(BaseModel):
    action: Literal["play", "pause", "skip", "previous", "stop", "seek", "repeat", "shuffle", "jump"]
    value: Any = None


@router.post("/{server_id}/theater/control")
def control(server_id: int, body: ControlIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    _require_control(ctx, user)
    rate_limit(f"theater-control:{user.id}", 60, 10)
    try:
        theater.control(db, server_id, user.id, body.action, body.value)
    except KeyError:
        raise ApiError(409, "The queue changed. Try again.") from None
    except (TypeError, ValueError):
        raise bad_request("That theater action didn't make sense.") from None
    db.commit()
    return {"ok": True}
