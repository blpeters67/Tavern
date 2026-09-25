import emojiRegex from 'emoji-regex';
import { load, save } from './storage';

export interface EmojiEntry {
  u: string; // the emoji itself
  f: string; // twemoji file name
  n: string[]; // shortcodes, display name first
  k: string; // search keywords
  s?: [string, string][]; // skin tone variants [emoji, file]
}

export interface EmojiData {
  categories: { id: string; name: string; emojis: number[] }[];
  emojis: EmojiEntry[];
}

let data: EmojiData | null = null;
let loading: Promise<EmojiData> | null = null;
const byName = new Map<string, EmojiEntry>();
const byChar = new Map<string, EmojiEntry>();

function strip(u: string): string {
  return u.replace(/️/g, '');
}

export function loadEmojiData(): Promise<EmojiData> {
  if (data) return Promise.resolve(data);
  loading ??= import('../generated/emoji.json').then((m) => {
    data = (m.default ?? m) as unknown as EmojiData;
    for (const e of data.emojis) {
      for (const n of e.n) if (!byName.has(n)) byName.set(n, e);
      byChar.set(strip(e.u), e);
      for (const [u] of e.s ?? []) byChar.set(strip(u), e);
    }
    return data;
  });
  return loading;
}

export const emojiDataSync = () => data;

// Start loading soon after startup so :shortcodes: work in the chat box.
setTimeout(() => void loadEmojiData(), 1500);

/** Twemoji file name: codepoints in hex, dropping U+FE0F unless it's a ZWJ sequence. */
export function twemojiFile(unicode: string): string {
  const text = unicode.includes('‍') ? unicode : unicode.replace(/️/g, '');
  return [...text].map((c) => c.codePointAt(0)!.toString(16)).join('-');
}

export const twemojiUrl = (unicode: string) => `/twemoji/${twemojiFile(unicode)}.svg`;

export function emojiByChar(unicode: string): EmojiEntry | undefined {
  return byChar.get(strip(unicode));
}

export function emojiShortcode(unicode: string): string {
  const e = emojiByChar(unicode);
  return e ? `:${e.n[0]}:` : unicode;
}

export function emojiByName(name: string): EmojiEntry | undefined {
  return byName.get(name);
}

export function searchEmoji(query: string, limit = 50): EmojiEntry[] {
  if (!data) return [];
  const q = query.toLowerCase().replace(/^:|:$/g, '');
  if (!q) return [];
  const exact: EmojiEntry[] = [];
  const prefix: EmojiEntry[] = [];
  const contains: EmojiEntry[] = [];
  const keyword: EmojiEntry[] = [];
  for (const e of data.emojis) {
    if (e.n.some((n) => n === q)) exact.push(e);
    else if (e.n.some((n) => n.startsWith(q))) prefix.push(e);
    else if (e.n.some((n) => n.includes(q))) contains.push(e);
    else if (q.length > 2 && e.k.includes(q)) keyword.push(e);
    if (exact.length + prefix.length >= limit) break;
  }
  return [...exact, ...prefix, ...contains, ...keyword].slice(0, limit);
}

// Skin tone: 0 = default yellow, 1..5 = light..dark
export function getSkinTone(): number {
  return load<number>('skinTone', 0);
}
export function setSkinTone(t: number) {
  save('skinTone', t);
}

export function withSkin(e: EmojiEntry, tone: number): { u: string; f: string } {
  if (tone > 0 && e.s?.[tone - 1]) {
    const [u, f] = e.s[tone - 1];
    return { u, f };
  }
  return { u: e.u, f: e.f };
}

// Frequently used (unicode chars or "c:<id>" for custom emojis)
export function recordEmojiUse(key: string) {
  const counts = load<Record<string, number>>('emojiUse', {});
  counts[key] = (counts[key] ?? 0) + 1;
  const trimmed = Object.fromEntries(
    Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 60),
  );
  save('emojiUse', trimmed);
  frequentCache = null;
}

// Every message's toolbar asks for the favourites, so they're worked out once
// (again after you use an emoji, or another tab does).
let frequentCache: string[] | null = null;
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (e) => {
    if (e.key?.endsWith('emojiUse')) frequentCache = null;
  });
}

export function frequentEmoji(limit = 16): string[] {
  if (!frequentCache) {
    const counts = load<Record<string, number>>('emojiUse', {});
    const list = Object.entries(counts)
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => k);
    const defaults = ['👍', '😂', '❤️', '😭', '🔥', '🍺', '⚔️', '🎲', '😮', '👀', '🙏', '💀', '✨', '😅', '🤔', '🎉'];
    for (const d of defaults) if (!list.includes(d)) list.push(d);
    frequentCache = list;
  }
  return frequentCache.slice(0, limit);
}

export type TextPart = string | { emoji: string };

/** Split text into plain strings and unicode emoji. */
export function splitEmoji(text: string): TextPart[] {
  const re = emojiRegex();
  const out: TextPart[] = [];
  let last = 0;
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    out.push({ emoji: m[0] });
    last = idx + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const CUSTOM_RE = /<a?:\w{2,32}:\d+>/g;

/** True when a message is nothing but (up to 30) emoji, for big "jumbo" rendering. */
export function isEmojiOnly(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) return false;
  const custom = trimmed.match(CUSTOM_RE)?.length ?? 0;
  const rest = trimmed.replace(CUSTOM_RE, '');
  const unicode = [...rest.matchAll(emojiRegex())].length;
  if (custom + unicode === 0 || custom + unicode > 30) return false;
  return rest.replace(emojiRegex(), '').trim() === '';
}
