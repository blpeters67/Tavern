"""Dice rolls. The server rolls, so results are the same for everyone and
nobody can fudge them. A roll becomes a message of type ROLL."""

from __future__ import annotations

import secrets
from typing import Literal

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from .. import dice, sheets
from ..db import get_db
from ..deps import ApiError, bad_request, current_user, forbidden, not_found, rate_limit
from ..models import Character, MessageType, User
from ..permissions import P
from ..services import create_message, load_channel

router = APIRouter(prefix="/api/channels", tags=["rolls"])

RollKind = Literal[
    "custom",
    "skill",
    "save",
    "ability",
    "initiative",
    "death_save",
    "attack",
    "damage",
    "spell_attack",
    "spell_damage",
    "hit_die",
]


class RollIn(BaseModel):
    kind: RollKind = "custom"
    key: str | None = Field(default=None, max_length=40)
    expression: str | None = Field(default=None, max_length=120)
    character_id: int | None = None
    narrator: bool = False
    adv: Literal["adv", "dis"] | None = None
    dc: int | None = Field(default=None, ge=1, le=60)
    label: str | None = Field(default=None, max_length=80)
    private: bool = False
    book: bool = False
    nonce: str | None = Field(default=None, max_length=64)


@router.post("/{channel_id}/rolls")
def roll(channel_id: int, body: RollIn, user: User = Depends(current_user), db: Session = Depends(get_db)) -> dict:
    access = load_channel(db, channel_id, user.id, P.SEND_MESSAGES)
    rate_limit(f"roll:{user.id}", 20, 10, "You're rolling too fast. Let the dice settle.")

    character = None
    if body.character_id:
        character = db.get(Character, body.character_id)
        if character is None or character.deleted:
            raise not_found("That character")
        if not access.has(P.USE_CHARACTERS):
            raise forbidden("Characters aren't allowed in this channel.")
        if character.owner_id != user.id:
            ctx = access.ctx
            if ctx is None or not ctx.is_dm(user.id):
                raise forbidden("Only Dungeon Masters can roll for other players.")
            if not ctx.is_member(character.owner_id):
                raise forbidden("That character's player isn't in this server.")

    narrator = False
    if body.narrator and character is None:
        if access.ctx is None or not access.ctx.is_dm(user.id):
            raise forbidden("Only Dungeon Masters can roll as the narrator.")
        narrator = True

    if body.private and access.ctx is None:
        raise bad_request("Private rolls only work in servers, where there's a Dungeon Master to see them.")

    sheet = None
    if body.kind != "custom":
        if character is None:
            raise bad_request("Pick a character to roll that check for.")
        sheet = sheets.clean(character.sheet) if character.sheet else sheets.default_sheet()

    try:
        result = dice.build_roll(
            kind=body.kind,
            key=body.key,
            expression=body.expression,
            sheet=sheet,
            adv=body.adv,
            dc=body.dc,
            label=body.label,
            seed=secrets.randbelow(1_000_000),
        )
    except dice.DiceError as exc:
        raise ApiError(400, str(exc)) from None

    result.update(
        {
            "v": 1,
            "kind": body.kind,
            "key": body.key,
            "rolled_by": user.id,
            "character_id": character.id if character else None,
            "for_user_id": character.owner_id if character else user.id,
            "private": bool(body.private),
            "narrator": narrator,
        }
    )
    meta = {"roll": result}
    if narrator:
        meta["narrator"] = True
    _msg, payload = create_message(
        db,
        access,
        user,
        content=dice.summary_text(result),
        character=character,
        type=MessageType.ROLL,
        meta=meta,
        nonce=body.nonce,
        dm_only=bool(body.private),
        book=body.book or narrator,
    )
    db.commit()
    return payload
