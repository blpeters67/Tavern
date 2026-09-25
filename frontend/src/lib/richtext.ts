/**
 * The message box is a small rich-text editor (TipTap); messages are stored
 * as Discord-flavoured markdown. This turns the editor's document into that
 * markdown: **bold**, *italic*, __underline__, ~~strike~~, `code`, and
 * Tavern's [text]{#e0b252 large wave} for colour, size and text effects.
 *
 * Plain text is passed through untouched, so people who type markdown by
 * hand (||spoilers||, > quotes, links) get what they typed.
 */

import type { JSONContent } from '@tiptap/core';
import { parseEffects } from './textEffects';

export const SIZES = { small: '0.8em', large: '1.3em', huge: '1.75em' } as const;
export type SizeName = keyof typeof SIZES;

export function sizeName(css: unknown): SizeName | null {
  if (typeof css !== 'string') return null;
  for (const [name, value] of Object.entries(SIZES)) if (value === css) return name as SizeName;
  return null;
}

export function normalizeHex(color: unknown): string | null {
  if (typeof color !== 'string') return null;
  const c = color.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  const short = /^#([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(c);
  if (short) return `#${short[1]}${short[1]}${short[2]}${short[2]}${short[3]}${short[3]}`;
  const rgb = /^rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  if (rgb) return `#${[rgb[1], rgb[2], rgb[3]].map((n) => Math.min(255, Number(n)).toString(16).padStart(2, '0')).join('')}`;
  return null;
}

// Outer to inner. Styled spans wrap everything so their [ ] hold whole runs.
const RANK: Record<string, number> = { t: 0, b: 1, u: 2, i: 3, s: 4, c: 5 };

interface Seg {
  text: string;
  keys: string[];
  br?: boolean;
}

function keysOf(marks: JSONContent['marks']): string[] {
  const keys: string[] = [];
  for (const m of marks ?? []) {
    if (m.type === 'bold') keys.push('b');
    else if (m.type === 'italic') keys.push('i');
    else if (m.type === 'underline') keys.push('u');
    else if (m.type === 'strike') keys.push('s');
    else if (m.type === 'code') keys.push('c');
    else if (m.type === 'textStyle') {
      const attrs = [normalizeHex(m.attrs?.color), sizeName(m.attrs?.fontSize), ...parseEffects(m.attrs?.effects)].filter(Boolean);
      if (attrs.length) keys.push(`t:${attrs.join(' ')}`);
    }
  }
  return keys.sort((a, b) => RANK[a[0]] - RANK[b[0]]);
}

function opener(key: string): string {
  switch (key[0]) {
    case 't':
      return '[';
    case 'b':
      return '**';
    case 'u':
      return '__';
    case 'i':
      return '*';
    case 's':
      return '~~';
    default:
      return '`';
  }
}

function closer(key: string): string {
  if (key[0] === 't') return `]{${key.slice(2)}}`;
  return opener(key);
}

/** Flatten a paragraph into text segments and line breaks. */
function segments(block: JSONContent): Seg[] {
  const out: Seg[] = [];
  for (const node of block.content ?? []) {
    if (node.type === 'hardBreak') out.push({ text: '\n', keys: [], br: true });
    else if (node.type === 'text' && node.text) out.push({ text: node.text, keys: keysOf(node.marks) });
  }
  return out;
}

function escapeIn(text: string, open: string[]): string {
  if (open.some((k) => k[0] === 'c')) return text;
  return open.some((k) => k[0] === 't') ? text.replace(/\\/g, '\\\\').replace(/\]/g, '\\]') : text;
}

interface Tok {
  k: 'o' | 'c' | 't';
  s: string;
  key?: string;
}

function inline(block: JSONContent): string {
  const toks: Tok[] = [];
  const open: string[] = [];
  const closeTo = (n: number) => {
    while (open.length > n) {
      const key = open.pop()!;
      toks.push({ k: 'c', s: closer(key), key });
    }
  };
  for (const seg of segments(block)) {
    if (seg.br) {
      closeTo(0);
      toks.push({ k: 't', s: '\n' });
      continue;
    }
    let k = 0;
    while (k < open.length && k < seg.keys.length && open[k] === seg.keys[k]) k++;
    closeTo(k);
    for (const key of seg.keys.slice(k)) {
      toks.push({ k: 'o', s: opener(key), key });
      open.push(key);
    }
    toks.push({ k: 't', s: escapeIn(seg.text, open) });
  }
  closeTo(0);

  // Markdown markers can't hug whitespace ("** bold**" isn't bold): move
  // spaces from just inside a marker to just outside it.
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.k !== 't' || t.s === '\n') continue;
    let j = i - 1;
    while (j >= 0 && toks[j].k === 'o') j--;
    if (j < i - 1) {
      const lead = /^\s+/.exec(t.s);
      if (lead) {
        t.s = t.s.slice(lead[0].length);
        toks.splice(j + 1, 0, { k: 't', s: lead[0] });
        i++;
      }
    }
    let e = i + 1;
    while (e < toks.length && toks[e].k === 'c') e++;
    if (e > i + 1) {
      const trail = /\s+$/.exec(t.s);
      if (trail) {
        t.s = t.s.slice(0, -trail[0].length);
        toks.splice(e, 0, { k: 't', s: trail[0] });
      }
    }
  }
  // Drop runs that ended up empty.
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < toks.length; i++) {
      if (toks[i].k === 't' && toks[i].s === '') {
        toks.splice(i, 1);
        changed = true;
        break;
      }
      if (i < toks.length - 1 && toks[i].k === 'o' && toks[i + 1].k === 'c' && toks[i].key === toks[i + 1].key) {
        toks.splice(i, 2);
        changed = true;
        break;
      }
    }
  }
  // "*a*" then "**b**" would fuse into "*a***b**"; a zero-width space keeps them apart.
  let out = '';
  let prev: Tok | null = null;
  for (const t of toks) {
    if (prev?.k === 'c' && t.k === 'o' && out && '*_~`'.includes(t.s[0]) && out.endsWith(t.s[0])) out += '\u200b';
    out += t.s;
    prev = t;
  }
  return out;
}

/** Editor document -> markdown message content. */
export function docToMarkdown(doc: JSONContent | null | undefined): string {
  if (!doc?.content) return '';
  return doc.content.map((block) => inline(block)).join('\n');
}

/** Plain text (with newlines) -> editor content: one paragraph, hard breaks between lines. */
export function textToContent(text: string): JSONContent[] {
  const out: JSONContent[] = [];
  text.split('\n').forEach((line, i) => {
    if (i > 0) out.push({ type: 'hardBreak' });
    if (line) out.push({ type: 'text', text: line });
  });
  return out;
}

export function textToDoc(text: string): JSONContent {
  const content = textToContent(text);
  return { type: 'doc', content: [{ type: 'paragraph', content: content.length ? content : undefined }] };
}
