/**
 * Text effects: wave, fire, runes, typewriter... Written into messages with
 * Tavern's styled-text syntax, next to colour and size:
 *
 *     [It's alive!]{shake gold}     [ᚱᚢᚾᛖᛊ]{runes}     [Hello]{#e0b252 large wave}
 *
 * Some ideas come from teebarjunk's godot-text_effects (nervous, jump,
 * rain, sparkle, heart, woo, uwu, l33t, cuss, and the console / embers /
 * wave-function-collapse / word reveals); the rest are made for roleplay.
 * Rendering lives in lib/markdown.tsx (FxRun) and styles/effects.css.
 *
 * One effect per group at a time; picking another in the same group swaps it.
 */

import type { Message } from '../store/types';
import { on } from './events';

export type FxGroup = 'motion' | 'light' | 'voice' | 'letters' | 'entrance';

export interface FxDef {
  id: string;
  label: string;
  group: FxGroup;
  /** Where the animation runs: every letter, every word, or the whole run. */
  scope: 'letter' | 'word' | 'whole' | 'none';
  desc: string;
}

export const FX_GROUPS: { id: FxGroup; label: string }[] = [
  { id: 'motion', label: 'Motion' },
  { id: 'light', label: 'Light & Magic' },
  { id: 'voice', label: 'Voice' },
  { id: 'letters', label: 'Letters' },
  { id: 'entrance', label: 'Entrances' },
];

export const EFFECTS: FxDef[] = [
  // Motion
  { id: 'wave', label: 'Wave', group: 'motion', scope: 'letter', desc: 'Letters ride a gentle wave.' },
  { id: 'wiggle', label: 'Wiggle', group: 'motion', scope: 'letter', desc: 'Letters rock side to side.' },
  { id: 'shake', label: 'Shake', group: 'motion', scope: 'letter', desc: 'Furious trembling. For rage, fear and earthquakes.' },
  { id: 'nervous', label: 'Nervous', group: 'motion', scope: 'word', desc: 'Every word jitters on its own.' },
  { id: 'bounce', label: 'Bounce', group: 'motion', scope: 'word', desc: 'Words hop one after another.' },
  { id: 'float', label: 'Float', group: 'motion', scope: 'letter', desc: 'Letters drift lazily, like a dream or underwater.' },
  { id: 'tipsy', label: 'Tipsy', group: 'motion', scope: 'letter', desc: 'Letters sway like they had one too many.' },
  { id: 'heartbeat', label: 'Heartbeat', group: 'motion', scope: 'whole', desc: 'Thumps like a pounding heart.' },
  { id: 'ripple', label: 'Ripple', group: 'motion', scope: 'letter', desc: 'A swell rolls through the letters.' },
  { id: 'drip', label: 'Drip', group: 'motion', scope: 'letter', desc: 'Letters slip down and fade, like rain or tears.' },
  // Light & magic
  { id: 'rainbow', label: 'Rainbow', group: 'light', scope: 'letter', desc: 'Colours flow through the letters.' },
  { id: 'sparkle', label: 'Sparkle', group: 'light', scope: 'letter', desc: 'Letters glint and twinkle.' },
  { id: 'glow', label: 'Glow', group: 'light', scope: 'whole', desc: 'A soft magical glow that breathes.' },
  { id: 'gold', label: 'Gold', group: 'light', scope: 'letter', desc: 'Gilded letters with a gleam sweeping across. Holy, royal, rich.' },
  { id: 'fire', label: 'Fire', group: 'light', scope: 'letter', desc: 'Letters flicker like flames.' },
  { id: 'frost', label: 'Frost', group: 'light', scope: 'letter', desc: 'Icy blue with a cold shimmer.' },
  { id: 'shadow', label: 'Shadow', group: 'light', scope: 'letter', desc: 'Dark smoke curls around the letters. Necromancy, the void.' },
  { id: 'ghost', label: 'Ghostly', group: 'light', scope: 'letter', desc: 'Letters fade in and out like a haunting.' },
  { id: 'toxic', label: 'Toxic', group: 'light', scope: 'letter', desc: 'Sickly green and bubbling. Poisons and potions.' },
  { id: 'neon', label: 'Neon', group: 'light', scope: 'whole', desc: 'A glowing sign that flickers now and then.' },
  { id: 'glitch', label: 'Glitch', group: 'light', scope: 'letter', desc: 'Red and blue ghosts tear across the letters. Tech, curses, corruption.' },
  { id: 'storm', label: 'Storm', group: 'light', scope: 'whole', desc: 'Lightning flashes through the words.' },
  // Voice
  { id: 'whisper', label: 'Whisper', group: 'voice', scope: 'none', desc: 'Small, soft and faded.' },
  { id: 'shout', label: 'Shout', group: 'voice', scope: 'whole', desc: 'Big, bold and shaking.' },
  { id: 'echo', label: 'Echo', group: 'voice', scope: 'whole', desc: 'The words ring out with fading echoes.' },
  { id: 'telepathy', label: 'Telepathy', group: 'voice', scope: 'letter', desc: 'A voice inside your head, glowing violet.' },
  { id: 'demonic', label: 'Demonic', group: 'voice', scope: 'whole', desc: 'A deep, rumbling voice from below.' },
  // Letters
  { id: 'runes', label: 'Runes', group: 'letters', scope: 'letter', desc: 'Written in an ancient script. Hover (or tap) to read it.' },
  { id: 'redacted', label: 'Redacted', group: 'letters', scope: 'letter', desc: 'Blacked out until someone clicks it.' },
  { id: 'censor', label: 'Censored', group: 'letters', scope: 'letter', desc: 'Letters keep scrambling into #$%&!' },
  { id: 'mock', label: 'Mocking', group: 'letters', scope: 'none', desc: 'aLtErNaTiNg CaSe, for maximum sarcasm.' },
  { id: 'uwu', label: 'UwU', group: 'letters', scope: 'none', desc: "R's and L's become W's. Vewy cute." },
  { id: 'leet', label: 'L33t', group: 'letters', scope: 'none', desc: 'H4ck3r sp34k.' },
  { id: 'hearts', label: 'Lovestruck', group: 'letters', scope: 'letter', desc: "A pink wave where o's and a's turn into hearts." },
  // Entrances: play once when the message arrives (click to replay)
  { id: 'typewriter', label: 'Typewriter', group: 'entrance', scope: 'letter', desc: 'Letters type out one by one.' },
  { id: 'decode', label: 'Decode', group: 'entrance', scope: 'letter', desc: 'Scrambled symbols settle into words, like a transmission.' },
  { id: 'materialize', label: 'Materialize', group: 'entrance', scope: 'letter', desc: 'Letters drift in from everywhere and gather.' },
  { id: 'unfold', label: 'Unfold', group: 'entrance', scope: 'word', desc: 'Words fade in one at a time.' },
  { id: 'slam', label: 'Slam', group: 'entrance', scope: 'whole', desc: 'Crashes onto the page.' },
];

export const FX_BY_ID: Record<string, FxDef> = Object.fromEntries(EFFECTS.map((e) => [e.id, e]));

/** Effects that bring their own colour (styles/effects.css), which then wins over the book look's. */
export const COLORED_FX = new Set(['gold', 'fire', 'frost', 'shadow', 'ghost', 'toxic', 'storm', 'telepathy', 'demonic', 'hearts']);
export const FX_IDS = EFFECTS.map((e) => e.id);
const GROUP_ORDER: Record<FxGroup, number> = { motion: 0, light: 1, voice: 2, letters: 3, entrance: 4 };

/** Effects that need every letter wrapped (so they can move or change one by one). */
export function needsLetters(effects: string[]): boolean {
  return effects.some((id) => FX_BY_ID[id]?.scope === 'letter');
}

/** Canonical order: one per group, in group order. */
export function normalizeEffects(effects: string[]): string[] {
  const byGroup = new Map<FxGroup, string>();
  for (const id of effects) {
    const def = FX_BY_ID[id];
    if (def) byGroup.set(def.group, id);
  }
  return [...byGroup.entries()].sort((a, b) => GROUP_ORDER[a[0]] - GROUP_ORDER[b[0]]).map(([, id]) => id);
}

/** Add an effect (replacing any other in its group) or remove it. */
export function toggleEffect(effects: string[], id: string, on: boolean): string[] {
  const def = FX_BY_ID[id];
  if (!def) return effects;
  const rest = effects.filter((e) => e !== id && FX_BY_ID[e]?.group !== (on ? def.group : '__none__'));
  return normalizeEffects(on ? [...rest, id] : rest);
}

export function parseEffects(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return normalizeEffects(value.split(/\s+/).filter((t) => t in FX_BY_ID));
}

export function hasEntrance(effects: string[]): boolean {
  return effects.some((id) => FX_BY_ID[id]?.group === 'entrance');
}

// ---------------------------------------------------------------------------
// Letter swaps
// ---------------------------------------------------------------------------

const LEET: Record<string, string> = { a: '4', e: '3', i: '1', o: '0', s: '5', t: '7' };

function uwu(text: string): string {
  return text
    .replace(/[rl]/g, 'w')
    .replace(/[RL]/g, 'W')
    .replace(/n([aeiou])/g, 'ny$1')
    .replace(/N([aeiou])/g, 'Ny$1')
    .replace(/N([AEIOU])/g, 'NY$1');
}

function leet(text: string): string {
  return text.replace(/[aeiost]/gi, (c) => LEET[c.toLowerCase()] ?? c);
}

/** Letter swaps that change what's written (the message itself stays as typed). */
export function transformFor(effects: string[]): ((text: string, start: number) => string) | null {
  if (effects.includes('uwu')) return (t) => uwu(t);
  if (effects.includes('leet')) return (t) => leet(t);
  if (effects.includes('mock')) {
    // Alternate case across the whole run, counting letters only.
    return (t, start) => {
      let n = start;
      return Array.from(t)
        .map((c) => {
          if (!/\p{L}/u.test(c)) return c;
          return n++ % 2 ? c.toUpperCase() : c.toLowerCase();
        })
        .join('');
    };
  }
  return null;
}

/** Elder Futhark, near enough. */
const RUNES: Record<string, string> = {
  a: 'ᚨ',
  b: 'ᛒ',
  c: 'ᚲ',
  d: 'ᛞ',
  e: 'ᛖ',
  f: 'ᚠ',
  g: 'ᚷ',
  h: 'ᚺ',
  i: 'ᛁ',
  j: 'ᛃ',
  k: 'ᚲ',
  l: 'ᛚ',
  m: 'ᛗ',
  n: 'ᚾ',
  o: 'ᛟ',
  p: 'ᛈ',
  q: 'ᚲ',
  r: 'ᚱ',
  s: 'ᛊ',
  t: 'ᛏ',
  u: 'ᚢ',
  v: 'ᚹ',
  w: 'ᚹ',
  x: 'ᛉ',
  y: 'ᛃ',
  z: 'ᛉ',
};

export function runeFor(ch: string): string | null {
  return RUNES[ch.toLowerCase()] ?? null;
}

export const SCRAMBLE_GLYPHS = '#$%&@!*?§¤∆Ω≈';

/** A stable pseudo-random number in [0, 1) for letter `i` (so a message looks the same each time). */
export function rand(i: number, seed = 0): number {
  const x = Math.sin((i + 1) * 12.9898 + seed * 78.233) * 43758.5453;
  return x - Math.floor(x);
}

// ---------------------------------------------------------------------------
// Entrances play once, for messages that arrive while you're watching.
// ---------------------------------------------------------------------------

const liveMessages = new Set<number>();
const played = new Set<string>();

on('message-create', (m: Message) => markLive(m.id));

export function markLive(messageId: number): void {
  liveMessages.add(messageId);
  if (liveMessages.size > 300) liveMessages.delete(liveMessages.values().next().value as number);
}

/** True the first time an entrance is shown for a message that just arrived. */
export function claimEntrance(key: string, messageId: number | undefined): boolean {
  if (messageId === undefined || !liveMessages.has(messageId) || played.has(key)) return false;
  played.add(key);
  return true;
}

/** Strip effect/colour/size wrappers for plain-text uses (notifications, reply bars). */
export function stripStyled(text: string): string {
  return text.replace(STYLED_RE_GLOBAL, (_, inner: string) => inner.replace(/\\([\\\]])/g, '$1'));
}

const ATTR = `(?:#[0-9a-fA-F]{6}|small|large|huge|${FX_IDS.join('|')})`;
/** The attribute list of the styled-text syntax: colour, size and effects, space separated. */
export const STYLED_ATTRS = `${ATTR}(?: +${ATTR}){0,7}`;
const STYLED_RE_GLOBAL = new RegExp(`\\[((?:\\\\[\\s\\S]|[^\\]\\\\\\n])+)\\]\\{${STYLED_ATTRS}\\}`, 'g');
