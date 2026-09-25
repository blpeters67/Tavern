/**
 * D&D 5e character sheet: types, defaults and the derived maths.
 * Mirrors backend/tavern/sheets.py — keep the formulas in sync.
 */

export type Ability = 'str' | 'dex' | 'con' | 'int' | 'wis' | 'cha';
export const ABILITIES: Ability[] = ['str', 'dex', 'con', 'int', 'wis', 'cha'];
export const ABILITY_NAMES: Record<Ability, string> = {
  str: 'Strength',
  dex: 'Dexterity',
  con: 'Constitution',
  int: 'Intelligence',
  wis: 'Wisdom',
  cha: 'Charisma',
};
export const ABILITY_SHORT: Record<Ability, string> = { str: 'STR', dex: 'DEX', con: 'CON', int: 'INT', wis: 'WIS', cha: 'CHA' };

export const SKILLS: Record<string, [Ability, string]> = {
  acrobatics: ['dex', 'Acrobatics'],
  animal_handling: ['wis', 'Animal Handling'],
  arcana: ['int', 'Arcana'],
  athletics: ['str', 'Athletics'],
  deception: ['cha', 'Deception'],
  history: ['int', 'History'],
  insight: ['wis', 'Insight'],
  intimidation: ['cha', 'Intimidation'],
  investigation: ['int', 'Investigation'],
  medicine: ['wis', 'Medicine'],
  nature: ['int', 'Nature'],
  perception: ['wis', 'Perception'],
  performance: ['cha', 'Performance'],
  persuasion: ['cha', 'Persuasion'],
  religion: ['int', 'Religion'],
  sleight_of_hand: ['dex', 'Sleight of Hand'],
  stealth: ['dex', 'Stealth'],
  survival: ['wis', 'Survival'],
};
export const SKILL_KEYS = Object.keys(SKILLS);

export const CONDITIONS = [
  'blinded',
  'charmed',
  'deafened',
  'frightened',
  'grappled',
  'incapacitated',
  'invisible',
  'paralyzed',
  'petrified',
  'poisoned',
  'prone',
  'restrained',
  'stunned',
  'unconscious',
] as const;

export const ALIGNMENTS: { key: string; name: string }[] = [
  { key: 'LG', name: 'Lawful Good' },
  { key: 'NG', name: 'Neutral Good' },
  { key: 'CG', name: 'Chaotic Good' },
  { key: 'LN', name: 'Lawful Neutral' },
  { key: 'N', name: 'True Neutral' },
  { key: 'CN', name: 'Chaotic Neutral' },
  { key: 'LE', name: 'Lawful Evil' },
  { key: 'NE', name: 'Neutral Evil' },
  { key: 'CE', name: 'Chaotic Evil' },
];
export function alignmentName(key: string): string {
  if (key === 'U') return 'Unaligned';
  return ALIGNMENTS.find((a) => a.key === key)?.name ?? '';
}

export const CURRENCIES = ['pp', 'gp', 'ep', 'sp', 'cp'] as const;
export type Currency = (typeof CURRENCIES)[number];
export const CURRENCY_NAMES: Record<Currency, string> = { pp: 'Platinum', gp: 'Gold', ep: 'Electrum', sp: 'Silver', cp: 'Copper' };

export interface ClassEntry {
  name: string;
  subclass: string;
  level: number;
  hit_die: 6 | 8 | 10 | 12;
  sort: number;
}
export interface Attack {
  name: string;
  ability: '' | Ability;
  proficient: boolean;
  attack_bonus: number;
  damage: string;
  damage_ability: boolean;
  damage_bonus: number;
  damage_type: string;
  range: string;
  notes: string;
  sort: number;
}
export interface Spell {
  name: string;
  level: number;
  prepared: boolean;
  school: string;
  casting_time: string;
  range: string;
  components: string;
  duration: string;
  concentration: boolean;
  ritual: boolean;
  attack: boolean;
  save: '' | Ability;
  damage: string;
  description: string;
  sort: number;
}
export interface Item {
  name: string;
  qty: number;
  weight: number;
  value: string;
  equipped: boolean;
  attuned: boolean;
  description: string;
  sort: number;
}
export interface Resource {
  name: string;
  current: number;
  max: number;
  reset: 'long' | 'short' | 'none';
  sort: number;
}
export interface Feature {
  name: string;
  source: string;
  description: string;
  sort: number;
}

export interface Sheet {
  v: 1;
  rev: number;
  species: string;
  background: string;
  alignment: string;
  xp: number;
  inspiration: boolean;
  classes: Record<string, ClassEntry>;
  abilities: Record<Ability, number>;
  saves: Record<Ability, { prof: boolean; bonus: number }>;
  skills: Record<string, { prof: 0 | 0.5 | 1 | 2; bonus: number }>;
  jack_of_all_trades: boolean;
  prof_bonus_override: number;
  ac: number;
  ac_note: string;
  initiative_bonus: number;
  speed: string;
  hp: { max: number; current: number; temp: number };
  hit_dice_used: number;
  death_saves: { success: number; failure: number };
  exhaustion: number;
  conditions: Record<string, boolean>;
  attacks: Record<string, Attack>;
  spellcasting_ability: '' | Ability;
  spell_slots: Record<string, { max: number; used: number }>;
  spells: Record<string, Spell>;
  currency: Record<Currency, number>;
  inventory: Record<string, Item>;
  resources: Record<string, Resource>;
  features: Record<string, Feature>;
  proficiencies: { armor: string; weapons: string; tools: string; languages: string };
  personality: { traits: string; ideals: string; bonds: string; flaws: string };
  details: { pronouns: string; age: string; height: string; weight: string; eyes: string; hair: string; skin: string; faith: string };
  appearance: string;
  backstory: string;
  notes: string;
}

export function defaultSheet(): Sheet {
  const abilities = Object.fromEntries(ABILITIES.map((a) => [a, 10])) as Record<Ability, number>;
  const saves = Object.fromEntries(ABILITIES.map((a) => [a, { prof: false, bonus: 0 }])) as Sheet['saves'];
  const skills = Object.fromEntries(SKILL_KEYS.map((k) => [k, { prof: 0, bonus: 0 }])) as Sheet['skills'];
  const slots = Object.fromEntries(Array.from({ length: 9 }, (_, i) => [String(i + 1), { max: 0, used: 0 }]));
  return {
    v: 1,
    rev: 0,
    species: '',
    background: '',
    alignment: '',
    xp: 0,
    inspiration: false,
    classes: {},
    abilities,
    saves,
    skills,
    jack_of_all_trades: false,
    prof_bonus_override: 0,
    ac: 10,
    ac_note: '',
    initiative_bonus: 0,
    speed: '30 ft',
    hp: { max: 10, current: 10, temp: 0 },
    hit_dice_used: 0,
    death_saves: { success: 0, failure: 0 },
    exhaustion: 0,
    conditions: Object.fromEntries(CONDITIONS.map((c) => [c, false])),
    attacks: {},
    spellcasting_ability: '',
    spell_slots: slots,
    spells: {},
    currency: { pp: 0, gp: 0, ep: 0, sp: 0, cp: 0 },
    inventory: {},
    resources: {},
    features: {},
    proficiencies: { armor: '', weapons: '', tools: '', languages: '' },
    personality: { traits: '', ideals: '', bonds: '', flaws: '' },
    details: { pronouns: '', age: '', height: '', weight: '', eyes: '', hair: '', skin: '', faith: '' },
    appearance: '',
    backstory: '',
    notes: '',
  };
}

/** RFC 7396 JSON Merge Patch: objects merge, null deletes, anything else replaces. */
export function mergePatch<T>(target: T, patch: unknown): T {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) return patch as T;
  const base: Record<string, unknown> =
    target && typeof target === 'object' && !Array.isArray(target) ? { ...(target as Record<string, unknown>) } : {};
  for (const [key, value] of Object.entries(patch as Record<string, unknown>)) {
    if (value === null) delete base[key];
    else base[key] = mergePatch(base[key], value);
  }
  return base as T;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

// ---------------------------------------------------------------------------
// Derived numbers
// ---------------------------------------------------------------------------

export function abilityMod(score: number): number {
  return Math.floor((score - 10) / 2);
}

export function totalLevel(sheet: Sheet): number {
  const levels = Object.values(sheet.classes || {}).reduce((n, c) => n + (c.level || 0), 0);
  return Math.max(1, Math.min(20, levels || 1));
}

export function profBonus(sheet: Sheet): number {
  if (sheet.prof_bonus_override > 0) return sheet.prof_bonus_override;
  return 2 + Math.floor((totalLevel(sheet) - 1) / 4);
}

export function modOf(sheet: Sheet, ability: Ability): number {
  return abilityMod(sheet.abilities?.[ability] ?? 10);
}

function jack(sheet: Sheet): number {
  return sheet.jack_of_all_trades ? Math.floor(profBonus(sheet) / 2) : 0;
}

export function skillMod(sheet: Sheet, key: string): number {
  const [ability] = SKILLS[key];
  const entry = sheet.skills?.[key] ?? { prof: 0, bonus: 0 };
  const extra = entry.prof ? Math.floor(entry.prof * profBonus(sheet)) : jack(sheet);
  return modOf(sheet, ability) + extra + (entry.bonus || 0);
}

export function saveMod(sheet: Sheet, ability: Ability): number {
  const entry = sheet.saves?.[ability] ?? { prof: false, bonus: 0 };
  return modOf(sheet, ability) + (entry.prof ? profBonus(sheet) : 0) + (entry.bonus || 0);
}

export function checkMod(sheet: Sheet, ability: Ability): number {
  return modOf(sheet, ability) + jack(sheet);
}

export function initiativeMod(sheet: Sheet): number {
  return modOf(sheet, 'dex') + jack(sheet) + (sheet.initiative_bonus || 0);
}

export function passive(sheet: Sheet, key: string): number {
  return 10 + skillMod(sheet, key);
}

export function attackNumbers(sheet: Sheet, attack: Attack): { toHit: number; damage: string } {
  const mod = attack.ability ? modOf(sheet, attack.ability) : 0;
  const toHit = mod + (attack.proficient ? profBonus(sheet) : 0) + (attack.attack_bonus || 0);
  const dmgBonus = (attack.damage_ability && attack.ability ? mod : 0) + (attack.damage_bonus || 0);
  let damage = (attack.damage || '').trim();
  if (damage && dmgBonus) damage = `${damage}${dmgBonus > 0 ? '+' : ''}${dmgBonus}`;
  else if (!damage && dmgBonus) damage = String(dmgBonus);
  return { toHit, damage };
}

export function spellNumbers(sheet: Sheet): { dc: number; attack: number } | null {
  const ability = sheet.spellcasting_ability;
  if (!ability) return null;
  const attack = profBonus(sheet) + modOf(sheet, ability);
  return { dc: 8 + attack, attack };
}

export function classLine(sheet: Sheet): string {
  return Object.values(sheet.classes || {})
    .sort((a, b) => a.sort - b.sort || a.name.localeCompare(b.name))
    .filter((c) => c.name.trim())
    .map((c) => `${c.name} ${c.level}`)
    .join(' / ');
}

export function goldValue(sheet: Sheet): number {
  const c = sheet.currency;
  return Math.round((c.pp * 10 + c.gp + c.ep * 0.5 + c.sp * 0.1 + c.cp * 0.01) * 100) / 100;
}

export function inventoryWeight(sheet: Sheet): number {
  return Math.round(Object.values(sheet.inventory || {}).reduce((n, i) => n + (i.weight || 0) * (i.qty || 0), 0) * 100) / 100;
}

export const XP_LEVELS = [0, 300, 900, 2700, 6500, 14000, 23000, 34000, 48000, 64000, 85000, 100000, 120000, 140000, 165000, 195000, 225000, 265000, 305000, 355000];

export function signed(n: number): string {
  return n >= 0 ? `+${n}` : `${n}`;
}

export function sorted<T extends { sort: number }>(map: Record<string, T> | undefined): [string, T][] {
  return Object.entries(map || {}).sort((a, b) => a[1].sort - b[1].sort || a[0].localeCompare(b[0]));
}

export function nextSort(map: Record<string, { sort: number }> | undefined): number {
  return Object.values(map || {}).reduce((n, v) => Math.max(n, v.sort), 0) + 1;
}
