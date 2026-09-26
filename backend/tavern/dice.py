"""Dice notation, rolling (server-side, so nobody can fudge) and the
sheet-aware checks: skills, saves, abilities, initiative, attacks, spells.

Notation: terms joined by + or -.  Each term is a number or `NdS` with
optional modifiers: `kh`/`kl` keep highest/lowest (default 1), `dh`/`dl`
drop, `!` explode.  `d%` is a d100.  Examples: 1d20+5, 2d20kh1+3, 4d6dl1, 8d6.
"""

from __future__ import annotations

import re
import secrets
from dataclasses import dataclass, field
from typing import Any

from . import sheets

MAX_TERMS = 20
MAX_DICE = 200
MAX_SIDES = 1000
MAX_EXPLODE = 100

TERM_RE = re.compile(r"(\d{0,3})d(\d{1,4}|%)((?:kh\d*|kl\d*|dh\d*|dl\d*|k\d*|!)*)|(\d{1,6})")
MOD_RE = re.compile(r"(kh|kl|dh|dl|k|!)(\d*)")


class DiceError(ValueError):
    pass


@dataclass
class DiceTerm:
    sign: int
    count: int = 0
    sides: int = 0
    keep: tuple[str, int] | None = None  # ("h"|"l", n) keep, or ("dh"|"dl", n) drop
    explode: bool = False
    number: int | None = None


@dataclass
class ParsedExpr:
    terms: list[DiceTerm] = field(default_factory=list)

    def notation(self) -> str:
        out = []
        for i, t in enumerate(self.terms):
            sign = "-" if t.sign < 0 else ("+" if i else "")
            if t.number is not None:
                out.append(f"{sign}{t.number}")
                continue
            s = f"{sign}{t.count}d{t.sides}"
            if t.keep:
                kind, n = t.keep
                s += {"h": "kh", "l": "kl"}.get(kind, kind) + str(n)
            if t.explode:
                s += "!"
            out.append(s)
        return "".join(out) or "0"


def parse(expr: str) -> ParsedExpr:
    text = re.sub(r"\s+", "", (expr or "").lower())
    if not text:
        raise DiceError("Enter some dice, like 1d20+5.")
    if len(text) > 120:
        raise DiceError("That roll is too long.")
    parsed = ParsedExpr()
    pos = 0
    sign = 1
    expect_term = True
    total_dice = 0
    while pos < len(text):
        ch = text[pos]
        if ch in "+-":
            if not expect_term and parsed.terms:
                sign = 1 if ch == "+" else -1
                expect_term = True
                pos += 1
                continue
            if expect_term and not parsed.terms:
                sign = 1 if ch == "+" else -1
                pos += 1
                continue
            raise DiceError("Two signs in a row.")
        if not expect_term:
            raise DiceError(f"Unexpected '{ch}'.")
        m = TERM_RE.match(text, pos)
        if not m or m.end() == pos:
            raise DiceError(f"I don't understand '{text[pos:pos + 8]}'.")
        if m.group(4) is not None:
            parsed.terms.append(DiceTerm(sign=sign, number=int(m.group(4))))
        else:
            count = int(m.group(1) or 1)
            sides = 100 if m.group(2) == "%" else int(m.group(2))
            if count < 1:
                raise DiceError("Roll at least one die.")
            if sides < 2 or sides > MAX_SIDES:
                raise DiceError(f"Dice need between 2 and {MAX_SIDES} sides.")
            total_dice += count
            if total_dice > MAX_DICE:
                raise DiceError(f"That's more than {MAX_DICE} dice.")
            term = DiceTerm(sign=sign, count=count, sides=sides)
            for mod, num in MOD_RE.findall(m.group(3) or ""):
                if mod == "!":
                    if sides < 3:
                        raise DiceError("Only dice with 3+ sides can explode.")
                    term.explode = True
                    continue
                n = int(num) if num else 1
                if n < 0 or n > count:
                    raise DiceError("Can't keep or drop more dice than you roll.")
                term.keep = ({"kh": "h", "k": "h", "kl": "l"}.get(mod, mod), n)
            parsed.terms.append(term)
        if len(parsed.terms) > MAX_TERMS:
            raise DiceError("That roll has too many parts.")
        pos = m.end()
        expect_term = False
        sign = 1
    if expect_term:
        raise DiceError("The roll ends with a sign.")
    return parsed


def _die(sides: int) -> int:
    return secrets.randbelow(sides) + 1


def roll_parsed(parsed: ParsedExpr, *, crit_double: bool = False) -> dict[str, Any]:
    """Roll it. `crit_double` doubles the number of dice (critical hit damage)."""
    terms_out = []
    total = 0
    for t in parsed.terms:
        if t.number is not None:
            terms_out.append({"kind": "num", "sign": t.sign, "value": t.number})
            total += t.sign * t.number
            continue
        count = t.count * (2 if crit_double else 1)
        rolls: list[dict[str, Any]] = []
        explosions = 0
        for _ in range(count):
            v = _die(t.sides)
            rolls.append({"v": v})
            while t.explode and v == t.sides and explosions < MAX_EXPLODE:
                explosions += 1
                v = _die(t.sides)
                rolls.append({"v": v, "exp": True})
        if t.keep:
            kind, n = t.keep
            order = sorted(range(len(rolls)), key=lambda i: rolls[i]["v"])
            if kind == "h":
                dropped = order[: len(rolls) - n]
            elif kind == "l":
                dropped = order[n:]
            elif kind == "dh":
                dropped = order[len(rolls) - n :]
            else:  # dl
                dropped = order[:n]
            for i in dropped:
                rolls[i]["drop"] = True
        value = sum(r["v"] for r in rolls if not r.get("drop"))
        terms_out.append({"kind": "dice", "sign": t.sign, "count": count, "sides": t.sides, "rolls": rolls, "value": value})
        total += t.sign * value
    return {"total": total, "terms": terms_out}


def natural_d20(result: dict[str, Any]) -> int | None:
    """The kept d20 of a check, for crit / fumble highlighting."""
    for term in result["terms"]:
        if term["kind"] == "dice" and term["sides"] == 20:
            kept = [r["v"] for r in term["rolls"] if not r.get("drop")]
            if len(kept) == 1:
                return kept[0]
    return None


# ---------------------------------------------------------------------------
# Flavour text for checks against a DC
# ---------------------------------------------------------------------------

FLAVOR: dict[str, tuple[tuple[str, ...], tuple[str, ...]]] = {
    "acrobatics": (
        ("You land it cleanly, light on your feet.", "A neat tumble. Nobody saw you wobble."),
        ("Your footing goes. That's going to bruise.", "You overbalance and hit the ground."),
    ),
    "animal_handling": (
        ("The animal settles under your hand.", "It calms, ears forward, trusting you."),
        ("The animal shies away, spooked.", "It snorts and wants nothing to do with you."),
    ),
    "arcana": (
        ("The runes make sense. You know this magic.", "You recall the lore behind the spell."),
        ("The symbols swim together. No idea.", "Whatever this magic is, it's beyond you for now."),
    ),
    "athletics": (
        ("You haul yourself through with raw strength.", "Muscle wins the day."),
        ("Your grip slips and you fall short.", "It's heavier than it looked."),
    ),
    "deception": (
        ("They buy every word.", "Your lie goes down smooth as ale."),
        ("Their eyes narrow. They don't believe you.", "Your story has a hole in it, and they found it."),
    ),
    "history": (
        ("You remember the old tales. This is familiar.", "A detail from your studies clicks into place."),
        ("The past stays murky.", "You can't place where you've heard of it."),
    ),
    "insight": (
        ("You read them like an open book.", "Something in their eyes gives them away."),
        ("You can't tell what they're thinking.", "Their face gives nothing away."),
    ),
    "intimidation": (
        ("They flinch and back down.", "Your threat lands. They go pale."),
        ("They laugh it off.", "They square up instead of backing down."),
    ),
    "investigation": (
        ("You spot the detail everyone else missed.", "The clues line up."),
        ("Nothing stands out. Maybe look elsewhere.", "The trail goes cold."),
    ),
    "medicine": (
        ("You stop the bleeding and steady them.", "You know exactly what's wrong."),
        ("Your hands aren't steady enough.", "The wound resists your care."),
    ),
    "nature": (
        ("You know this plant, and this beast.", "The wilds make sense to you."),
        ("You're not sure what that is.", "Nature keeps its secrets this time."),
    ),
    "perception": (
        ("You notice it just in time.", "Nothing gets past you."),
        ("You don't notice anything unusual.", "It slips right past your notice."),
    ),
    "performance": (
        ("The room hangs on every note.", "The crowd roars for more."),
        ("A note goes sour. Someone coughs.", "The crowd drifts back to their drinks."),
    ),
    "persuasion": (
        ("They come around to your way of thinking.", "Your words win them over."),
        ("They aren't convinced.", "They politely decline."),
    ),
    "religion": (
        ("You recognise the rites and the gods behind them.", "Holy lore comes back to you."),
        ("The symbols mean nothing to you.", "You can't recall which faith this is."),
    ),
    "sleight_of_hand": (
        ("Quick fingers. Nobody noticed a thing.", "It's in your pocket before they blink."),
        ("Your hand is caught mid-motion.", "Clumsy. Someone definitely saw that."),
    ),
    "stealth": (
        ("You move quietly, keeping to the shadows.", "Not a sound. You're a ghost."),
        ("A board creaks under your boot.", "Someone turns your way. You've been heard."),
    ),
    "survival": (
        ("You find the trail and follow it true.", "The land tells you where to go."),
        ("The tracks vanish into the brush.", "You're not sure which way is north."),
    ),
    "save": (
        ("You shrug off the worst of it.", "You hold firm."),
        ("It takes hold of you.", "You couldn't resist it."),
    ),
    "ability": (
        ("You pull it off.", "Success."),
        ("Not this time.", "You come up short."),
    ),
    "attack": (
        ("A clean hit.", "Your strike lands."),
        ("You miss.", "It glances off harmlessly."),
    ),
}


def flavor(kind: str, key: str | None, success: bool, seed: int) -> str:
    table = FLAVOR.get(key or "") or FLAVOR.get(kind) or FLAVOR["ability"]
    options = table[0] if success else table[1]
    return options[seed % len(options)]


# ---------------------------------------------------------------------------
# Building a roll request into message metadata
# ---------------------------------------------------------------------------


def _with_advantage(mod: int, adv: str | None) -> str:
    die = "2d20kh1" if adv == "adv" else "2d20kl1" if adv == "dis" else "1d20"
    return f"{die}{mod:+d}" if mod else die


def _advantage_expression(expression: str, adv: str | None) -> str:
    """Advantage/disadvantage on a plain roll: the first single die (a d20 if one
    was picked, otherwise whatever it is) rolls twice, keeping the better or worse
    one — 1d20+5 becomes 2d20kh1+5, 1d8 becomes 2d8kl1."""
    if not adv:
        return expression
    parsed = parse(expression)
    candidates = [t for t in parsed.terms if t.number is None and t.count == 1 and not t.keep and not t.explode]
    pick = next((t for t in candidates if t.sides == 20), candidates[0] if candidates else None)
    if pick is None:
        return expression
    pick.count = 2
    pick.keep = ("h" if adv == "adv" else "l", 1)
    return parsed.notation()


def _part(label: str, expression: str, *, crit_double: bool = False, check: bool = False) -> dict[str, Any]:
    parsed = parse(expression)
    result = roll_parsed(parsed, crit_double=crit_double)
    part: dict[str, Any] = {"label": label, "expression": parsed.notation(), **result}
    if crit_double:
        part["crit_damage"] = True
    if check:
        nat = natural_d20(result)
        part["d20"] = nat
        part["crit"] = nat == 20
        part["fumble"] = nat == 1
    return part


def build_roll(
    *,
    kind: str,
    key: str | None,
    expression: str | None,
    sheet: dict[str, Any] | None,
    adv: str | None,
    dc: int | None,
    label: str | None,
    seed: int,
) -> dict[str, Any]:
    """Returns {"title", "parts": [...], "outcome"?, "flavor"?}."""
    adv = adv if adv in ("adv", "dis") else None
    title = (label or "").strip()[:80]
    parts: list[dict[str, Any]] = []
    outcome_part: dict[str, Any] | None = None
    flavor_key = key

    if kind == "custom":
        if not expression:
            raise DiceError("Enter some dice, like 1d20+5.")
        expression = _advantage_expression(expression, adv)
        part = _part(title or "Roll", expression, check=True)
        parts.append(part)
        outcome_part = part if dc is not None else None
        title = title or parse(expression).notation()
    else:
        if sheet is None:
            raise DiceError("That roll needs a character sheet.")
        if kind == "skill":
            if key not in sheets.SKILLS:
                raise DiceError("Unknown skill.")
            name = sheets.SKILLS[key][1]
            part = _part(f"{name} Check", _with_advantage(sheets.skill_mod(sheet, key), adv), check=True)
            title = title or f"{name} Check"
        elif kind == "save":
            if key not in sheets.ABILITIES:
                raise DiceError("Unknown saving throw.")
            name = sheets.ABILITY_NAMES[key]
            part = _part(f"{name} Save", _with_advantage(sheets.save_mod(sheet, key), adv), check=True)
            title = title or f"{name} Saving Throw"
            flavor_key = "save"
        elif kind == "ability":
            if key not in sheets.ABILITIES:
                raise DiceError("Unknown ability.")
            name = sheets.ABILITY_NAMES[key]
            part = _part(f"{name} Check", _with_advantage(sheets.check_mod(sheet, key), adv), check=True)
            title = title or f"{name} Check"
            flavor_key = "ability"
        elif kind == "initiative":
            part = _part("Initiative", _with_advantage(sheets.initiative_mod(sheet), adv), check=True)
            title = title or "Initiative"
            dc = None
        elif kind == "death_save":
            part = _part("Death Save", _with_advantage(0, adv), check=True)
            title = title or "Death Saving Throw"
            nat = part.get("d20")
            if nat == 20:
                part["note"] = "Natural 20: back on your feet with 1 hit point!"
            elif nat == 1:
                part["note"] = "Natural 1: that's two failures."
            dc = 10
            flavor_key = "save"
        elif kind == "attack":
            attack = ((sheet.get("attacks") or {}).get(key or "")) or None
            if attack is None:
                raise DiceError("That attack isn't on the sheet anymore.")
            to_hit, damage = sheets.attack_numbers(sheet, attack)
            name = attack.get("name") or "Attack"
            hit = _part("To Hit", _with_advantage(to_hit, adv), check=True)
            parts.append(hit)
            if damage:
                dmg = _part(
                    f"Damage{' (' + attack['damage_type'] + ')' if attack.get('damage_type') else ''}",
                    damage,
                    crit_double=bool(hit.get("crit")),
                )
                parts.append(dmg)
            title = title or name
            outcome_part = hit if dc is not None else None
            flavor_key = "attack"
            part = None
        elif kind == "damage":
            attack = ((sheet.get("attacks") or {}).get(key or "")) or None
            if attack is None:
                raise DiceError("That attack isn't on the sheet anymore.")
            _to_hit, damage = sheets.attack_numbers(sheet, attack)
            if not damage:
                raise DiceError("That attack has no damage dice.")
            part = _part("Damage", damage)
            title = title or f"{attack.get('name') or 'Attack'} Damage"
            dc = None
        elif kind == "spell_attack":
            numbers = sheets.spell_numbers(sheet)
            if numbers is None:
                raise DiceError("Pick a spellcasting ability on the sheet first.")
            spell = ((sheet.get("spells") or {}).get(key or "")) or {}
            hit = _part("Spell Attack", _with_advantage(numbers[1], adv), check=True)
            parts.append(hit)
            if spell.get("damage"):
                parts.append(_part("Damage", spell["damage"], crit_double=bool(hit.get("crit"))))
            title = title or (spell.get("name") or "Spell Attack")
            outcome_part = hit if dc is not None else None
            flavor_key = "attack"
            part = None
        elif kind == "spell_damage":
            spell = ((sheet.get("spells") or {}).get(key or "")) or {}
            if not spell.get("damage"):
                raise DiceError("That spell has no damage dice.")
            part = _part("Damage", spell["damage"])
            title = title or f"{spell.get('name') or 'Spell'} Damage"
            dc = None
        elif kind == "hit_die":
            classes = list((sheet.get("classes") or {}).values())
            die = max((int(c.get("hit_die") or 8) for c in classes), default=8)
            con = sheets.mod_of(sheet, "con")
            part = _part("Hit Die", f"1d{die}{con:+d}" if con else f"1d{die}")
            title = title or "Hit Die"
            dc = None
        else:
            raise DiceError("Unknown roll type.")
        if part is not None:
            parts.insert(0, part)
            outcome_part = part if dc is not None else None

    out: dict[str, Any] = {"title": title, "parts": parts}
    if adv:
        out["adv"] = adv
    if dc is not None and outcome_part is not None:
        success = outcome_part["total"] >= dc
        if kind == "death_save":
            nat = outcome_part.get("d20")
            success = nat == 20 or (nat != 1 and outcome_part["total"] >= 10)
        out["dc"] = dc
        out["outcome"] = "success" if success else "failure"
        out["flavor"] = flavor(kind, flavor_key, success, seed)
    return out


def summary_text(roll: dict[str, Any]) -> str:
    """Plain-text version for search, notifications and old clients."""
    bits = []
    for part in roll.get("parts", []):
        bits.append(f"{part['label']}: {part['total']} ({part['expression']})")
    text = f"🎲 {roll.get('title') or 'Roll'} — " + ", ".join(bits)
    if roll.get("outcome"):
        text += f" — DC {roll.get('dc')} {roll['outcome'].title()}"
    return text[:1000]
