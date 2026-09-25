"""Voice helpers over HTTP: ICE server config for WebRTC and moderator
actions (server mute/deafen, move, disconnect)."""

from __future__ import annotations

import logging
import threading
import time

import httpx
from fastapi import APIRouter, Depends
from pydantic import BaseModel
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_db
from ..deps import ApiError, current_user, forbidden, not_found
from ..models import Channel, ChannelType, User
from ..permissions import P
from ..services import load_server
from ..voice import voice

log = logging.getLogger("tavern.voice")
router = APIRouter(tags=["voice"])

_cache: dict[str, object] = {"servers": None, "expires": 0.0}
_cache_lock = threading.Lock()
CF_TTL = 86400


def _cloudflare_servers() -> list[dict] | None:
    url = f"https://rtc.live.cloudflare.com/v1/turn/keys/{settings.cloudflare_turn_key_id}/credentials/generate-ice-servers"
    try:
        resp = httpx.post(
            url,
            headers={"Authorization": f"Bearer {settings.cloudflare_turn_api_token}"},
            json={"ttl": CF_TTL},
            timeout=10,
        )
        resp.raise_for_status()
        servers = resp.json().get("iceServers")
        if isinstance(servers, dict):
            servers = [servers]
        # Browsers time out on port 53; Cloudflare recommends dropping it.
        cleaned = []
        for s in servers or []:
            urls = s.get("urls")
            urls = [urls] if isinstance(urls, str) else list(urls or [])
            urls = [u for u in urls if ":53?" not in u and not u.endswith(":53")]
            if urls:
                cleaned.append({**s, "urls": urls})
        return cleaned
    except Exception as exc:  # noqa: BLE001
        log.warning("Couldn't get Cloudflare TURN credentials: %s", exc)
        return None


def ice_servers() -> list[dict]:
    with _cache_lock:
        if _cache["servers"] is not None and time.time() < float(_cache["expires"]):  # type: ignore[arg-type]
            return _cache["servers"]  # type: ignore[return-value]
    servers: list[dict] = []
    ttl = 3600.0
    if settings.cloudflare_turn_key_id and settings.cloudflare_turn_api_token:
        cf = _cloudflare_servers()
        if cf:
            servers.extend(cf)
            ttl = CF_TTL / 2
    if settings.turn_urls:
        entry: dict = {"urls": list(settings.turn_urls)}
        if settings.turn_username:
            entry["username"] = settings.turn_username
            entry["credential"] = settings.turn_credential or ""
        servers.append(entry)
    if settings.stun_urls and not any("stun:" in str(s.get("urls")) for s in servers):
        servers.insert(0, {"urls": list(settings.stun_urls)})
    with _cache_lock:
        _cache["servers"] = servers
        _cache["expires"] = time.time() + ttl
    return servers


@router.get("/api/voice/ice-servers")
def get_ice_servers(user: User = Depends(current_user)) -> dict:
    return {"ice_servers": ice_servers()}


class VoiceModIn(BaseModel):
    mute: bool | None = None
    deaf: bool | None = None
    channel_id: int | None = None
    disconnect: bool = False


@router.patch("/api/servers/{server_id}/members/{user_id}/voice")
def moderate_voice(server_id: int, user_id: int, body: VoiceModIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    ctx = load_server(db, server_id, user.id)
    if not ctx.is_member(user_id):
        raise not_found("That member")
    current = voice.channel_of(user_id)
    current_channel = db.get(Channel, current) if current else None
    if current_channel is None or current_channel.server_id != server_id:
        raise ApiError(400, "They aren't in a voice space here.")
    if user_id != user.id and not ctx.outranks(user.id, user_id) and user.id != ctx.server.owner_id:
        raise forbidden("You can only moderate members below your highest role.")

    if body.mute is not None or body.deaf is not None:
        if body.mute is not None and not ctx.has(user.id, P.MUTE_MEMBERS, current_channel):
            raise forbidden("You need Mute Members for that.")
        if body.deaf is not None and not ctx.has(user.id, P.DEAFEN_MEMBERS, current_channel):
            raise forbidden("You need Deafen Members for that.")
        voice.set_server_flags(user_id, body.mute, body.deaf)

    if body.disconnect:
        if user_id != user.id and not ctx.has(user.id, P.MOVE_MEMBERS, current_channel):
            raise forbidden("You need Move Members for that.")
        voice.disconnect(user_id, current_channel.id)
    elif body.channel_id is not None and body.channel_id != current_channel.id:
        target = db.get(Channel, body.channel_id)
        if target is None or target.server_id != server_id or target.type != ChannelType.VOICE:
            raise not_found("That voice space")
        if not ctx.has(user.id, P.MOVE_MEMBERS, current_channel) or not ctx.has(user.id, P.MOVE_MEMBERS, target):
            raise forbidden("You need Move Members for that.")
        if not ctx.has(user_id, P.CONNECT, target):
            raise forbidden("They can't connect to that voice space.")
        voice.move(user_id, target.id, frozenset(ctx.viewers(target)))
    return {"ok": True}
