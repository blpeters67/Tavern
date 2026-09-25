"""D&D 5e character sheets.

A sheet is one JSON document stored on the character. Clients send JSON Merge
Patches (RFC 7396); the server merges, then runs the result through `clean()`,
which drops unknown keys, coerces types and clamps sizes. Lists that several
people might edit at once (inventory, spells...) are objects keyed by a short
id, so a DM adding an item and the owner editing another merge cleanly.

The frontend mirrors the maths in `src/lib/sheet.ts`; keep them in sync.
"""

from __future__ import annotations

import math
import re
from typing import Any

ABILITIES = ("str", "dex", "con", "int", "wis", "cha")
ABILITY_NAMES = {
    "str": "Strength",
    "dex": "Dexterity",
    "con": "Constitution",
    "int": "Intelligence",
    "wis": "Wisdom",
    "cha": "Charisma",
}

SKILLS: dict[str, tuple[str, str]] = {
    "acrobatics": ("dex", "Acrobatics"),
    "animal_handling": ("wis", "Animal Handling"),
    "arcana": ("int", "Arcana"),
    "athletics": ("str", "Athletics"),
    "deception": ("cha", "Deception"),
    "history": ("int", "History"),
    "insight": ("wis", "Insight"),
    "intimidation": ("cha", "Intimidation"),
    "investigation": ("int", "Investigation"),
    "medicine": ("wis", "Medicine"),
    "nature": ("int", "Nature"),
    "perception": ("wis", "Perception"),
    "performance": ("cha", "Performance"),
    "persuasion": ("cha", "Persuasion"),
    "religion": ("int", "Religion"),
    "sleight_of_hand": ("dex", "Sleight of Hand"),
    "stealth": ("dex", "Stealth"),
    "survival": ("wis", "Survival"),
}

CONDITIONS = (
    "blinded",
    "charmed",
    "deafened",
    "frightened",
    "grappled",
    "incapacitated",
    "invisible",
    "paralyzed",
    "petrified",
    "poisoned",
    "prone",
    "restrained",
    "stunned",
    "unconscious",
)

ALIGNMENTS = ("", "LG", "NG", "CG", "LN", "N", "CN", "LE", "NE", "CE", "U")
CURRENCIES = ("cp", "sp", "ep", "gp", "pp")
MAX_SHEET_BYTES = 256 * 1024
ITEM_ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,24}$")

# ---------------------------------------------------------------------------
# Schema
# ---------------------------------------------------------------------------
# Each spec is a tuple: ("str", max_len) | ("int", lo, hi) | ("num", lo, hi)
# | ("bool",) | ("enum", values) | ("obj", {key: spec}) | ("map", item_spec, max_items)


def _s(n: int) -> tuple:
    return ("str", n)


def _i(lo: int, hi: int) -> tuple:
    return ("int", lo, hi)


SORT = _i(-100000, 100000)

CLASS_SPEC = ("obj", {"name": _s(40), "subclass": _s(60), "level": _i(1, 20), "hit_die": ("enum", (6, 8, 10, 12)), "sort": SORT})
ATTACK_SPEC = (
    "obj",
    {
        "name": _s(80),
        "ability": ("enum", ("", *ABILITIES)),
        "proficient": ("bool",),
        "attack_bonus": _i(-30, 30),
        "damage": _s(60),
        "damage_ability": ("bool",),
        "damage_bonus": _i(-30, 30),
        "damage_type": _s(40),
        "range": _s(40),
        "notes": _s(500),
        "sort": SORT,
    },
)
SPELL_SPEC = (
    "obj",
    {
        "name": _s(80),
        "level": _i(0, 9),
        "prepared": ("bool",),
        "school": _s(30),
        "casting_time": _s(40),
        "range": _s(40),
        "components": _s(120),
        "duration": _s(60),
        "concentration": ("bool",),
        "ritual": ("bool",),
        "attack": ("bool",),  # spell attack roll
        "save": ("enum", ("", *ABILITIES)),
        "damage": _s(60),
        "description": _s(6000),
        "sort": SORT,
    },
)
ITEM_SPEC = (
    "obj",
    {
        "name": _s(120),
        "qty": _i(0, 1_000_000),
        "weight": ("num", 0, 100_000),
        "value": _s(40),
        "equipped": ("bool",),
        "attuned": ("bool",),
        "description": _s(4000),
        "sort": SORT,
    },
)
RESOURCE_SPEC = (
    "obj",
    {"name": _s(60), "current": _i(0, 9999), "max": _i(0, 9999), "reset": ("enum", ("long", "short", "none")), "sort": SORT},
)
FEATURE_SPEC = ("obj", {"name": _s(120), "source": _s(60), "description": _s(8000), "sort": SORT})

SHEET_SPEC = (
    "obj",
    {
        "v": _i(1, 1),
        "rev": _i(0, 2_000_000_000),
        "species": _s(60),
        "background": _s(60),
        "alignment": ("enum", ALIGNMENTS),
        "xp": _i(0, 10_000_000),
        "inspiration": ("bool",),
        "classes": ("map", CLASS_SPEC, 10),
        "abilities": ("obj", {a: _i(1, 30) for a in ABILITIES}),
        "saves": ("obj", {a: ("obj", {"prof": ("bool",), "bonus": _i(-30, 30)}) for a in ABILITIES}),
        "skills": ("obj", {k: ("obj", {"prof": ("enum", (0, 0.5, 1, 2)), "bonus": _i(-30, 30)}) for k in SKILLS}),
        "jack_of_all_trades": ("bool",),
        "prof_bonus_override": _i(0, 12),
        "ac": _i(0, 50),
        "ac_note": _s(80),
        "initiative_bonus": _i(-30, 30),
        "speed": _s(40),
        "hp": ("obj", {"max": _i(0, 9999), "current": _i(-9999, 9999), "temp": _i(0, 9999)}),
        "hit_dice_used": _i(0, 40),
        "death_saves": ("obj", {"success": _i(0, 3), "failure": _i(0, 3)}),
        "exhaustion": _i(0, 6),
        "conditions": ("obj", {c: ("bool",) for c in CONDITIONS}),
        "attacks": ("map", ATTACK_SPEC, 100),
        "spellcasting_ability": ("enum", ("", "int", "wis", "cha", "str", "dex", "con")),
        "spell_slots": ("obj", {str(n): ("obj", {"max": _i(0, 20), "used": _i(0, 20)}) for n in range(1, 10)}),
        "spells": ("map", SPELL_SPEC, 500),
        "currency": ("obj", {c: _i(0, 1_000_000_000) for c in CURRENCIES}),
        "inventory": ("map", ITEM_SPEC, 500),
        "resources": ("map", RESOURCE_SPEC, 50),
        "features": ("map", FEATURE_SPEC, 300),
        "proficiencies": ("obj", {"armor": _s(400), "weapons": _s(400), "tools": _s(400), "languages": _s(400)}),
        "personality": ("obj", {"traits": _s(2000), "ideals": _s(2000), "bonds": _s(2000), "flaws": _s(2000)}),
        "details": (
            "obj",
            {k: _s(60) for k in ("pronouns", "age", "height", "weight", "eyes", "hair", "skin", "faith")},
        ),
        "appearance": _s(8000),
        "backstory": _s(20000),
        "notes": _s(20000),
    },
)


def _default(spec: tuple) -> Any:
    kind = spec[0]
    if kind == "str":
        return ""
    if kind in ("int", "num"):
        return max(spec[1], 0) if spec[1] <= 0 <= spec[2] else spec[1]
    if kind == "bool":
        return False
    if kind == "enum":
        return spec[1][0]
    if kind == "obj":
        return {k: _default(v) for k, v in spec[1].items()}
    if kind == "map":
        return {}
    raise ValueError(kind)


def _clean(value: Any, spec: tuple) -> Any:
    kind = spec[0]
    if kind == "str":
        if not isinstance(value, str):
            value = "" if value is None or isinstance(value, (dict, list)) else str(value)
        value = value.replace("\x00", "")
        return value[: spec[1]]
    if kind == "int":
        try:
            n = int(float(value))
        except (TypeError, ValueError, OverflowError):
            return _default(spec)
        return min(max(n, spec[1]), spec[2])
    if kind == "num":
        try:
            f = float(value)
        except (TypeError, ValueError, OverflowError):
            return _default(spec)
        if math.isnan(f) or math.isinf(f):
            return _default(spec)
        return round(min(max(f, spec[1]), spec[2]), 2)
    if kind == "bool":
        return bool(value) if not isinstance(value, str) else value.lower() in ("1", "true", "yes", "on")
    if kind == "enum":
        return value if value in spec[1] else spec[1][0]
    if kind == "obj":
        src = value if isinstance(value, dict) else {}
        return {k: _clean(src.get(k), sub) if k in src else _default(sub) for k, sub in spec[1].items()}
    if kind == "map":
        src = value if isinstance(value, dict) else {}
        out = {}
        for key, item in src.items():
            if len(out) >= spec[2]:
                break
            if isinstance(key, str) and ITEM_ID_RE.match(key) and isinstance(item, dict):
                out[key] = _clean(item, spec[1])
        return out
    raise ValueError(kind)


def default_sheet() -> dict[str, Any]:
    sheet = _default(SHEET_SPEC)
    sheet["v"] = 1
    sheet["abilities"] = {a: 10 for a in ABILITIES}
    sheet["ac"] = 10
    sheet["speed"] = "30 ft"
    sheet["hp"] = {"max": 10, "current": 10, "temp": 0}
    return sheet


def clean(sheet: Any) -> dict[str, Any]:
    base = default_sheet()
    if isinstance(sheet, dict):
        merged = merge_patch(base, sheet)
    else:
        merged = base
    out = _clean(merged, SHEET_SPEC)
    out["v"] = 1
    return out


def merge_patch(target: Any, patch: Any) -> Any:
    """RFC 7396: objects merge recursively, null deletes, anything else replaces."""
    if not isinstance(patch, dict):
        return patch
    result = dict(target) if isinstance(target, dict) else {}
    for key, value in patch.items():
        if value is None:
            result.pop(key, None)
        else:
            result[key] = merge_patch(result.get(key), value)
    return result


_MISSING = object()


def diff(old: Any, new: Any) -> Any:
    """Smallest merge patch that turns `old` into `new` (or _MISSING if equal)."""
    if old == new:
        return _MISSING
    if isinstance(old, dict) and isinstance(new, dict):
        patch: dict[str, Any] = {}
        for key in old.keys() - new.keys():
            patch[key] = None
        for key, value in new.items():
            if key not in old:
                patch[key] = value
            else:
                d = diff(old[key], value)
                if d is not _MISSING:
                    patch[key] = d
        return patch
    return new


def make_patch(old: dict[str, Any], new: dict[str, Any]) -> dict[str, Any]:
    d = diff(old, new)
    return {} if d is _MISSING else d


# ---------------------------------------------------------------------------
# Derived numbers
# ---------------------------------------------------------------------------


def ability_mod(score: int) -> int:
    return math.floor((score - 10) / 2)


def total_level(sheet: dict[str, Any]) -> int:
    levels = sum(int(c.get("level", 0) or 0) for c in (sheet.get("classes") or {}).values())
    return max(1, min(20, levels or 1))


def prof_bonus(sheet: dict[str, Any]) -> int:
    override = int(sheet.get("prof_bonus_override") or 0)
    if override > 0:
        return override
    return 2 + (total_level(sheet) - 1) // 4


def mod_of(sheet: dict[str, Any], ability: str) -> int:
    return ability_mod(int((sheet.get("abilities") or {}).get(ability, 10)))


def _jack(sheet: dict[str, Any]) -> int:
    return prof_bonus(sheet) // 2 if sheet.get("jack_of_all_trades") else 0


def skill_mod(sheet: dict[str, Any], key: str) -> int:
    ability, _name = SKILLS[key]
    entry = (sheet.get("skills") or {}).get(key) or {}
    prof = float(entry.get("prof") or 0)
    if prof == 0:
        extra = _jack(sheet)
    else:
        extra = math.floor(prof * prof_bonus(sheet))
    return mod_of(sheet, ability) + extra + int(entry.get("bonus") or 0)


def save_mod(sheet: dict[str, Any], ability: str) -> int:
    entry = (sheet.get("saves") or {}).get(ability) or {}
    return mod_of(sheet, ability) + (prof_bonus(sheet) if entry.get("prof") else 0) + int(entry.get("bonus") or 0)


def check_mod(sheet: dict[str, Any], ability: str) -> int:
    return mod_of(sheet, ability) + _jack(sheet)


def initiative_mod(sheet: dict[str, Any]) -> int:
    return mod_of(sheet, "dex") + _jack(sheet) + int(sheet.get("initiative_bonus") or 0)


def attack_numbers(sheet: dict[str, Any], attack: dict[str, Any]) -> tuple[int, str]:
    """(to-hit bonus, damage expression) for one attack row."""
    ability = attack.get("ability") or ""
    mod = mod_of(sheet, ability) if ability else 0
    to_hit = mod + (prof_bonus(sheet) if attack.get("proficient") else 0) + int(attack.get("attack_bonus") or 0)
    dmg_bonus = (mod if attack.get("damage_ability") and ability else 0) + int(attack.get("damage_bonus") or 0)
    dice = (attack.get("damage") or "").strip()
    if dice and dmg_bonus:
        dice = f"{dice}{dmg_bonus:+d}"
    elif not dice and dmg_bonus:
        dice = str(dmg_bonus)
    return to_hit, dice


def spell_numbers(sheet: dict[str, Any]) -> tuple[int, int] | None:
    """(spell save DC, spell attack bonus) or None without a casting ability."""
    ability = sheet.get("spellcasting_ability") or ""
    if not ability:
        return None
    attack = prof_bonus(sheet) + mod_of(sheet, ability)
    return 8 + attack, attack


def class_line(sheet: dict[str, Any]) -> str:
    classes = sorted((sheet.get("classes") or {}).values(), key=lambda c: (c.get("sort", 0), c.get("name", "")))
    parts = []
    for c in classes:
        name = (c.get("name") or "").strip()
        if name:
            parts.append(f"{name} {c.get('level', 1)}")
    return " / ".join(parts)


def summary(sheet: dict[str, Any] | None) -> dict[str, Any] | None:
    """The bits shown on profile cards without opening the sheet."""
    if not sheet:
        return None
    hp = sheet.get("hp") or {}
    return {
        "level": total_level(sheet),
        "classes": class_line(sheet),
        "species": sheet.get("species") or "",
        "alignment": sheet.get("alignment") or "",
        "ac": sheet.get("ac", 10),
        "hp": {"current": hp.get("current", 0), "max": hp.get("max", 0), "temp": hp.get("temp", 0)},
        "gold": gold_value(sheet),
    }


def gold_value(sheet: dict[str, Any]) -> float:
    c = sheet.get("currency") or {}
    total = c.get("pp", 0) * 10 + c.get("gp", 0) + c.get("ep", 0) * 0.5 + c.get("sp", 0) * 0.1 + c.get("cp", 0) * 0.01
    return round(total, 2)
