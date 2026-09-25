/** Turning what you typed into what gets sent (and back, for editing). */
import type { Channel, Character, Emoji, User } from '../store/types';
import { emojiByName } from './emoji';

export interface InsertedMention {
  display: string; // what the text box shows, e.g. "@Lady Vex"
  token: string; // what gets sent, e.g. "<@c12>"
}

export interface ProxyMatch {
  character: Character;
  content: string;
}

const endsWithWordChar = (s: string) => /[\p{L}\p{N}]$/u.test(s);
const startsWithWordChar = (s: string) => /^[\p{L}\p{N}]/u.test(s);

/** Tupperbox-style proxy tags: "x: hello" or "[hello]". Longest tag wins. */
export function matchProxy(text: string, characters: Character[]): ProxyMatch | null {
  let best: { ch: Character; score: number; content: string } | null = null;
  for (const ch of characters) {
    const prefix = ch.proxy_prefix ?? '';
    const suffix = ch.proxy_suffix ?? '';
    if (!prefix && !suffix) continue;
    if (prefix && !text.startsWith(prefix)) continue;
    if (suffix && !text.endsWith(suffix)) continue;
    if (text.length < prefix.length + suffix.length) continue;
    let inner = text.slice(prefix.length, text.length - suffix.length);
    // A letter/number prefix like "x" needs a space after it so "xylophone" doesn't trigger it.
    if (prefix && endsWithWordChar(prefix) && inner && !/^\s/.test(inner)) continue;
    if (suffix && startsWithWordChar(suffix) && inner && !/\s$/.test(inner)) continue;
    inner = inner.trim();
    if (!inner) continue;
    const score = prefix.length + suffix.length;
    if (!best || score > best.score) best = { ch, score, content: inner };
  }
  return best ? { character: best.ch, content: best.content } : null;
}

export interface EncodeContext {
  mentions: InsertedMention[];
  members: User[]; // people who can be @mentioned here
  channels: Channel[]; // channels that can be #mentioned
  emojis: Emoji[]; // custom emojis available here (current server first)
}

const CODE_SPLIT = /(```[\s\S]*?```|`[^`\n]*`)/g;

function mapOutsideCode(text: string, fn: (part: string) => string): string {
  return text
    .split(CODE_SPLIT)
    .map((part, i) => (i % 2 === 1 ? part : fn(part)))
    .join('');
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Convert @names, #channels and :emoji: into tokens before sending. */
export function encodeMessage(text: string, ctx: EncodeContext): string {
  return mapOutsideCode(text, (part) => {
    // Mentions picked from autocomplete (longest first so "@Vex the Bold" beats "@Vex").
    const inserted = [...ctx.mentions].sort((a, b) => b.display.length - a.display.length);
    for (const m of inserted) {
      part = part.replace(new RegExp(`${escapeRe(m.display)}(?![\\p{L}\\p{N}_])`, 'gu'), m.token);
    }
    // Plain @username for anyone typed by hand.
    part = part.replace(/(^|[^\w<])@([a-zA-Z0-9_.]{2,32})/g, (all, lead: string, name: string) => {
      const find = (n: string) => ctx.members.find((u) => u.username === n.toLowerCase());
      const user = find(name);
      if (user) return `${lead}<@${user.id}>`;
      // "@benji." at the end of a sentence: the period isn't part of the name.
      const trimmed = name.replace(/\.+$/, '');
      const u2 = trimmed !== name ? find(trimmed) : undefined;
      return u2 ? `${lead}<@${u2.id}>${name.slice(trimmed.length)}` : all;
    });
    // #Channel Names can have spaces and capitals now: try the longest names first.
    const named = ctx.channels.filter((c) => c.name).sort((a, b) => b.name!.length - a.name!.length);
    for (const ch of named) {
      part = part.replace(new RegExp(`(^|[^\\w<&])#${escapeRe(ch.name!)}(?![\\p{L}\\p{N}_])`, 'giu'), (_all, lead: string) => `${lead}<#${ch.id}>`);
    }
    part = part.replace(/(^|[^<\w]):([a-zA-Z0-9_+-]{2,32}):/g, (all, lead: string, name: string) => {
      const custom = ctx.emojis.find((e) => e.name === name);
      if (custom) return `${lead}<${custom.animated ? 'a' : ''}:${custom.name}:${custom.id}>`;
      const std = emojiByName(name);
      return std ? `${lead}${std.u}` : all;
    });
    return part;
  });
}

export interface DecodeContext {
  users: Record<number, User>;
  characters: Record<number, Character>;
  channels: Record<number, Channel>;
}

/** Turn tokens back into editable text for the edit box. */
export function decodeForEdit(content: string, ctx: DecodeContext): { text: string; mentions: InsertedMention[] } {
  const mentions: InsertedMention[] = [];
  const text = mapOutsideCode(content, (part) =>
    part
      .replace(/<@!?(\d+)>/g, (all, id) => {
        const u = ctx.users[Number(id)];
        return u ? `@${u.username}` : all;
      })
      .replace(/<@c(\d+)>/g, (all, id) => {
        const c = ctx.characters[Number(id)];
        if (!c) return all;
        const display = `@${c.name}`;
        mentions.push({ display, token: all });
        return display;
      })
      .replace(/<#(\d+)>/g, (all, id) => {
        const c = ctx.channels[Number(id)];
        return c?.name ? `#${c.name}` : all;
      })
      .replace(/<a?:(\w+):(\d+)>/g, (all) => all),
  );
  return { text, mentions };
}

/** Find the @, # or : token being typed right before the caret. */
export function currentToken(text: string, caret: number): { trigger: '@' | '#' | ':'; query: string; start: number } | null {
  const before = text.slice(0, caret);
  const m = /(^|[\s(])([@#:])([^\s@#:]*)$/.exec(before);
  if (!m) {
    // Allow spaces for character names: "@Lady V"
    const spaced = /(^|[\s(])@([^\s@#:][^@#:\n]{0,30})$/.exec(before);
    if (spaced) return { trigger: '@', query: spaced[2], start: before.length - spaced[2].length - 1 };
    return null;
  }
  const trigger = m[2] as '@' | '#' | ':';
  const query = m[3];
  if (trigger === ':' && query.length < 2) return null;
  return { trigger, query, start: before.length - query.length - 1 };
}
