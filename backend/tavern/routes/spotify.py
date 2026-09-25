"""Connecting a Spotify account, so a DJ can import their own playlists.

Songs and albums import with just the server's API key; Spotify only shows a
playlist's songs to its owner (or collaborators), so that needs the owner's
sign-in. Tokens stay on the server and are only used to read playlists.
"""

from __future__ import annotations

from html import escape

from fastapi import APIRouter, Depends, Query
from fastapi.responses import HTMLResponse
from sqlalchemy.orm import Session

from .. import spotify
from ..db import get_db
from ..deps import ApiError, current_user, rate_limit
from ..models import User

router = APIRouter(prefix="/api/spotify", tags=["spotify"])


@router.get("/status")
def status(user: User = Depends(current_user)) -> dict:
    auth = user.spotify_auth or {}
    return {
        "configured": spotify.configured(),
        "connected": bool(auth.get("refresh") or auth.get("access")),
        "name": auth.get("name"),
        "redirect_uri": spotify.redirect_uri(),
    }


@router.get("/connect")
def connect(user: User = Depends(current_user)) -> dict:
    if not spotify.configured():
        raise ApiError(400, "Spotify isn't set up on this server (SPOTIFY_CLIENT_ID and SPOTIFY_CLIENT_SECRET).")
    rate_limit(f"spotify-connect:{user.id}", 10, 600)
    return {"url": spotify.authorize_url(user.id)}


def _page(title: str, text: str, ok: bool) -> HTMLResponse:
    color = "#23a55a" if ok else "#f23f43"
    body = f"""<!doctype html><html lang="en"><head><meta charset="utf-8"><title>{escape(title)}</title>
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>body{{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#101828;color:#dfe4ee;
font:16px/1.45 system-ui,sans-serif}}main{{max-width:420px;padding:32px;text-align:center}}h1{{font-size:22px;margin:0 0 8px;color:{color}}}
p{{margin:0;color:#aab3c5}}</style></head><body><main><h1>{escape(title)}</h1><p>{escape(text)}</p></main></body></html>"""
    return HTMLResponse(body, status_code=200 if ok else 400)


@router.get("/callback", response_class=HTMLResponse)
def callback(
    code: str | None = Query(default=None, max_length=2000),
    state: str | None = Query(default=None, max_length=200),
    error: str | None = Query(default=None, max_length=200),
    db: Session = Depends(get_db),
) -> HTMLResponse:
    user_id = spotify.take_state(state or "")
    if error or not code or user_id is None:
        reason = "You cancelled, or the sign-in link expired." if error or user_id is None else "Spotify didn't send a sign-in code."
        return _page("Spotify isn't connected", f"{reason} Close this window and try again from the jukebox.", ok=False)
    try:
        auth = spotify.exchange_code(code)
    except spotify.SpotifyError as exc:
        return _page("Spotify isn't connected", str(exc), ok=False)
    auth["name"] = spotify.account_name(auth["access"])
    user = db.get(User, user_id)
    if user is None:
        return _page("Spotify isn't connected", "That Tavern account doesn't exist anymore.", ok=False)
    user.spotify_auth = auth
    db.commit()
    who = f" as {auth['name']}" if auth.get("name") else ""
    return _page("Spotify connected", f"Tavern can now read your playlists{who}. You can close this window.", ok=True)


@router.delete("/connection")
def disconnect(user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    user.spotify_auth = None
    db.commit()
    return {"ok": True}
