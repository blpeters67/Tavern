/**
 * Dice rolls. The server does the rolling (so nobody can fudge a result) and
 * posts the roll as a message of type ROLL whose meta.roll holds the details.
 * This module is the one way the UI asks for a roll, plus a little bookkeeping
 * so only rolls that arrive live get the tumbling-dice animation.
 */

import { api, errorMessage } from '../api/http';
import { toast } from '../components/Toasts';
import { isDm, personaFor } from '../store/selectors';
import { getState } from '../store/store';
import { ChannelType, type Message, MessageType, NARRATOR } from '../store/types';
import { on } from './events';
import { bookLookFor } from './bookLook';

export type RollKind =
  | 'custom'
  | 'skill' // key: skill key, e.g. "stealth"
  | 'save' // key: ability, e.g. "dex"
  | 'ability' // key: ability
  | 'initiative'
  | 'death_save'
  | 'attack' // key: attack id on the sheet (rolls to-hit + damage)
  | 'damage' // key: attack id
  | 'spell_attack' // key: spell id (optional; adds its damage)
  | 'spell_damage' // key: spell id
  | 'hit_die';

export interface RollRequest {
  kind: RollKind;
  key?: string | null;
  /** Dice notation for custom rolls: 2d6+3, 4d6kh3, 1d20!, d%. */
  expression?: string | null;
  /**
   * Whose sheet to roll with. Omit to use whoever you're speaking as in that
   * channel (your character, or the narrator for Dungeon Masters). Pass null
   * for a plain roll as yourself.
   */
  characterId?: number | null;
  narrator?: boolean;
  adv?: 'adv' | 'dis' | null;
  dc?: number | null;
  label?: string | null;
  /** Only the Dungeon Masters (and you) see it. Servers only. */
  private?: boolean;
}

/**
 * Mirror of dice.py `_advantage_expression`. With advantage or disadvantage a
 * plain single die rolls twice, keeping the better or worse one: 1d20+5 becomes
 * 2d20kh1+5, and a d20 is preferred when several dice were picked. The server
 * applies this to the real roll; the tray only previews it (the text is
 * normalised, so use it for display, not for sending).
 */
export function withAdvantage(expression: string, adv: 'adv' | 'dis' | null | undefined): string {
  if (!adv) return expression;
  const text = (expression || '').replace(/\s+/g, '').toLowerCase();
  const term = /(\d*)d(\d+|%)((?:kh\d*|kl\d*|dh\d*|dl\d*|k\d*|!)*)/g;
  let pick: { index: number; length: number; sides: number } | null = null;
  let m: RegExpExecArray | null;
  while ((m = term.exec(text))) {
    if (Number(m[1] || 1) !== 1 || m[3]) continue;
    const sides = m[2] === '%' ? 100 : Number(m[2]);
    if (!pick || (sides === 20 && pick.sides !== 20)) pick = { index: m.index, length: m[0].length, sides };
  }
  if (!pick) return expression;
  const die = `2d${pick.sides === 100 ? '100' : pick.sides}${adv === 'adv' ? 'kh' : 'kl'}1`;
  return text.slice(0, pick.index) + die + text.slice(pick.index + pick.length);
}

let nonceCounter = 0;

/** Ask the server to roll. Returns the created message, or null on failure (after a toast). */
export async function roll(channelId: number, req: RollRequest): Promise<Message | null> {
  const s = getState();
  let characterId = req.characterId;
  let narrator = !!req.narrator;
  if (characterId === undefined) {
    const persona = personaFor(s, channelId);
    if (persona === NARRATOR) {
      characterId = null;
      narrator = true;
    } else {
      characterId = persona > 0 ? persona : null;
    }
  }
  const body = {
    kind: req.kind,
    key: req.key ?? null,
    expression: req.expression?.trim() || null,
    character_id: characterId || null,
    narrator: narrator && !characterId,
    adv: req.adv ?? null,
    dc: req.dc ?? null,
    label: req.label?.trim() || null,
    private: !!req.private,
    // Rolls follow the book look you have on in that channel.
    book: narrator || bookLookFor(channelId, !!characterId),
    nonce: `roll-${Date.now()}-${++nonceCounter}`,
  };
  try {
    return await api.post<Message>(`/api/channels/${channelId}/rolls`, body);
  } catch (err) {
    toast(errorMessage(err));
    return null;
  }
}

/**
 * The channel a roll from outside the chat (a character sheet, the voice
 * view) should land in: the open text channel if it belongs to that server,
 * otherwise the last channel you had open there. Null if there's none.
 */
export function rollTargetChannel(serverId: number | null): number | null {
  const s = getState();
  const active = s.activeChannelId !== null ? s.channels[s.activeChannelId] : undefined;
  const textish = (type: number) => type === ChannelType.TEXT || type === ChannelType.DM || type === ChannelType.GROUP_DM;
  if (active && textish(active.type) && (serverId === null || active.server_id === serverId)) return active.id;
  if (serverId !== null) {
    const last = s.lastChannelByServer[serverId];
    const c = last ? s.channels[last] : undefined;
    if (c && c.type === ChannelType.TEXT) return c.id;
    const system = s.servers[serverId]?.system_channel_id;
    if (system && s.channels[system]) return system;
  }
  return null;
}

/** Whether you can make private (Dungeon Master only) rolls in a channel's server. */
export function canRollPrivately(channelId: number): boolean {
  return getState().channels[channelId]?.server_id != null;
}

/** Whether you're a Dungeon Master where this channel lives (can roll for others). */
export function canRollForOthers(channelId: number): boolean {
  const s = getState();
  const serverId = s.channels[channelId]?.server_id;
  return serverId != null && isDm(s, serverId);
}

// ---------------------------------------------------------------------------
// Live rolls: animate only rolls that arrive while you're watching, once each.
// ---------------------------------------------------------------------------

const live = new Set<number>();
const animated = new Set<number>();

on('message-create', (m: Message) => {
  if (m.type === MessageType.ROLL) {
    live.add(m.id);
    if (live.size > 200) live.delete(live.values().next().value as number);
  }
});

/** True the first time a live roll is shown; false for history and repeats. */
export function claimRollAnimation(messageId: number): boolean {
  if (!live.has(messageId) || animated.has(messageId)) return false;
  animated.add(messageId);
  return true;
}

/** Whether a roll has been (or is being) animated already. */
export function rollWasLive(messageId: number): boolean {
  return live.has(messageId);
}

// ---------------------------------------------------------------------------
// Chat commands: /roll 2d6+3, /r stealth adv, /roll dex save dc 15, /proll ...
// ---------------------------------------------------------------------------

const ABILITY_WORDS: Record<string, string> = {
  str: 'str',
  strength: 'str',
  dex: 'dex',
  dexterity: 'dex',
  con: 'con',
  constitution: 'con',
  int: 'int',
  intelligence: 'int',
  wis: 'wis',
  wisdom: 'wis',
  cha: 'cha',
  charisma: 'cha',
};

const SKILL_NAMES: Record<string, string> = {
  acrobatics: 'acrobatics',
  'animal handling': 'animal_handling',
  arcana: 'arcana',
  athletics: 'athletics',
  deception: 'deception',
  history: 'history',
  insight: 'insight',
  intimidation: 'intimidation',
  investigation: 'investigation',
  medicine: 'medicine',
  nature: 'nature',
  perception: 'perception',
  performance: 'performance',
  persuasion: 'persuasion',
  religion: 'religion',
  'sleight of hand': 'sleight_of_hand',
  stealth: 'stealth',
  survival: 'survival',
};

const SKILL_ALIASES: Record<string, string> = {
  acro: 'acrobatics',
  animal: 'animal_handling',
  ah: 'animal_handling',
  arc: 'arcana',
  ath: 'athletics',
  athl: 'athletics',
  dec: 'deception',
  decep: 'deception',
  hist: 'history',
  ins: 'insight',
  intim: 'intimidation',
  intimidate: 'intimidation',
  inv: 'investigation',
  invest: 'investigation',
  investigate: 'investigation',
  med: 'medicine',
  nat: 'nature',
  per: 'perception',
  perc: 'perception',
  perf: 'performance',
  pers: 'persuasion',
  persuade: 'persuasion',
  rel: 'religion',
  sleight: 'sleight_of_hand',
  soh: 'sleight_of_hand',
  sneak: 'stealth',
  surv: 'survival',
};

const DICE_TOKEN = /^[0-9dDkKhHlL%!+\-*/().]+$/;

function matchSkill(phrase: string): string | null {
  if (SKILL_NAMES[phrase]) return SKILL_NAMES[phrase];
  const squashed = phrase.replace(/[\s_-]+/g, ' ');
  if (SKILL_NAMES[squashed]) return SKILL_NAMES[squashed];
  if (SKILL_ALIASES[squashed]) return SKILL_ALIASES[squashed];
  if (squashed.length >= 3) {
    const hits = Object.keys(SKILL_NAMES).filter((n) => n.startsWith(squashed));
    if (hits.length === 1) return SKILL_NAMES[hits[0]];
  }
  return null;
}

/** A named check like "stealth", "dex save", "wis", "init". */
function matchCheck(phrase: string): Pick<RollRequest, 'kind' | 'key'> | null {
  const p = phrase
    .toLowerCase()
    .replace(/\bcheck\b|\bthrow\b|\broll\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!p) return null;
  if (/^(init|initiative)$/.test(p)) return { kind: 'initiative' };
  if (/^death( save| saving)?$/.test(p) || p === 'ds') return { kind: 'death_save' };
  if (/^(hit ?die|hd)$/.test(p)) return { kind: 'hit_die' };
  const ab = /^([a-z]+)( (save|saving|sv))?$/.exec(p);
  if (ab && ABILITY_WORDS[ab[1]]) return { kind: ab[2] ? 'save' : 'ability', key: ABILITY_WORDS[ab[1]] };
  const saveFirst = /^(save|saving) ([a-z]+)$/.exec(p);
  if (saveFirst && ABILITY_WORDS[saveFirst[2]]) return { kind: 'save', key: ABILITY_WORDS[saveFirst[2]] };
  const skill = matchSkill(p);
  if (skill) return { kind: 'skill', key: skill };
  return null;
}

/**
 * Turn "/roll ..." into a roll request. Null if the text isn't a roll command;
 * { error } if it is one we can't make sense of.
 */
export function parseRollCommand(text: string): RollRequest | { error: string } | null {
  const m = /^\/(roll|r|proll|pr)(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!m) return null;
  const req: RollRequest = { kind: 'custom', private: /^p/i.test(m[1]) };
  const words = (m[2] ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length) return { ...req, expression: '1d20' };
  let expr = '';
  const rest: string[] = [];
  let label: string[] | null = null;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    const lw = w.toLowerCase();
    if (label) {
      label.push(w);
      continue;
    }
    if (lw === 'adv' || lw === 'advantage') req.adv = 'adv';
    else if (lw === 'dis' || lw === 'disadv' || lw === 'disadvantage') req.adv = 'dis';
    else if (lw === 'private' || lw === 'secret' || lw === 'hidden') req.private = true;
    else if (lw === 'dc' && /^\d+$/.test(words[i + 1] ?? '')) req.dc = Number(words[++i]);
    else if (/^dc\d+$/.test(lw)) req.dc = Number(lw.slice(2));
    else if ((lw === 'for' || lw === '#') && (expr || rest.length)) label = [];
    else if (!rest.length && DICE_TOKEN.test(w) && /\d|d/i.test(w) && lw !== 'hd' && lw !== 'd') expr += w;
    else if (!rest.length && /^[+\-*/]$/.test(w) && expr) expr += w;
    else rest.push(w);
  }
  if (req.dc != null && (req.dc < 1 || req.dc > 60)) return { error: 'DC has to be between 1 and 60.' };
  if (expr) {
    const extra = [...rest, ...(label ?? [])].join(' ').trim();
    return { ...req, expression: expr, label: extra || null };
  }
  const phrase = rest.join(' ');
  const check = matchCheck(phrase);
  if (check) return { ...req, ...check, label: label?.join(' ') || null };
  return { error: `I don't know how to roll "${phrase}". Try /roll 1d20+5, /roll stealth or /roll dex save.` };
}
