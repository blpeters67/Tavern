/* Discord-flavoured markdown: parsed with simple-markdown's rule engine,
 * rendered to React by our own output function (so it works with React 19). */
import SimpleMarkdown from '@khanacademy/simple-markdown';
import { Fragment, useEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent, type ReactNode } from 'react';
import { Icon, mdiAt, mdiTextBoxOutline, mdiVolumeHigh } from '../components/icons';
import { displayName } from '../store/selectors';
import { useStore, type State as StoreState } from '../store/store';
import { ChannelType } from '../store/types';
import { formatDiscordTimestamp, formatFull } from './format';
import { splitEmoji, twemojiUrl, emojiShortcode } from './emoji';
import { emojiUrl } from './avatars';
import { claimEntrance, COLORED_FX, FX_BY_ID, hasEntrance, needsLetters, normalizeEffects, rand, runeFor, STYLED_ATTRS, stripStyled, transformFor } from './textEffects';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type MdNode = { type: string; [key: string]: any };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type State = Record<string, any>;

// The package ships both CJS and ESM builds; unwrap whichever we got.
const SM = ((SimpleMarkdown as unknown as { default?: typeof SimpleMarkdown }).default ?? SimpleMarkdown) as typeof SimpleMarkdown;
const { anyScopeRegex, defaultRules } = SM;

function atLineStart(prev: string | undefined | null): boolean {
  return !prev || prev.endsWith('\n');
}

function lineRule(re: RegExp) {
  return (source: string, state: State, prev: string) => (atLineStart(prev) && !state.inHeading ? re.exec(source) : null);
}

let order = 0;
const next = () => order++;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const rules: Record<string, any> = {
  codeBlock: {
    order: next(),
    match: anyScopeRegex(/^```(?:([a-z0-9_+\-.#]+?)\n)?\n*([^\n][\s\S]*?)\n*```/i),
    parse: (c: RegExpExecArray) => ({ lang: c[1] ?? '', content: c[2] }),
  },
  blockQuote: {
    order: next(),
    match(source: string, state: State, prev: string) {
      if (state.inQuote || !atLineStart(prev)) return null;
      return /^( *>>> [\s\S]*)|^( *> [^\n]*(?:\n *> [^\n]*)*\n?)/.exec(source);
    },
    parse(c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) {
      const all = c[0];
      const multi = /^ *>>> /.test(all);
      const content = multi ? all.replace(/^ *>>> /, '') : all.replace(/^ *> /gm, '');
      return { content: parse(content.replace(/\n$/, ''), { ...state, inQuote: true }) };
    },
  },
  heading: {
    order: next(),
    match: lineRule(/^(#{1,3}) +([^\n]+)(?:\n|$)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({
      level: c[1].length,
      content: parse(c[2].trim(), { ...state, inHeading: true }),
    }),
  },
  subtext: {
    order: next(),
    match: lineRule(/^-# +([^\n]+)(?:\n|$)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({
      content: parse(c[1].trim(), { ...state, inHeading: true }),
    }),
  },
  list: {
    order: next(),
    match: lineRule(/^(?: {0,4}(?:[-*]|\d{1,3}\.) +[^\n]+(?:\n|$))+/),
    parse(c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) {
      const lines = c[0].replace(/\n$/, '').split('\n');
      const ordered = /^ *\d/.test(lines[0]);
      const start = ordered ? parseInt(lines[0], 10) : 1;
      const items = lines.map((line) => {
        const m = /^( *)(?:[-*]|\d{1,3}\.) +(.*)$/.exec(line)!;
        return { nested: m[1].length >= 2, content: parse(m[2], { ...state, inHeading: true }) };
      });
      return { ordered, start, items };
    },
  },
  newline: {
    order: next(),
    match: anyScopeRegex(/^\n/),
    parse: () => ({}),
  },
  escape: { ...defaultRules.escape, order: next() },
  customEmoji: {
    order: next(),
    match: anyScopeRegex(/^<(a)?:(\w{2,32}):(\d+)>/),
    parse: (c: RegExpExecArray) => ({ animated: !!c[1], name: c[2], id: Number(c[3]) }),
  },
  timestamp: {
    order: next(),
    match: anyScopeRegex(/^<t:(-?\d{1,13})(?::([tTdDfFR]))?>/),
    parse: (c: RegExpExecArray) => ({ seconds: Number(c[1]), style: c[2] ?? 'f' }),
  },
  userMention: {
    order: next(),
    match: anyScopeRegex(/^<@!?(\d+)>/),
    parse: (c: RegExpExecArray) => ({ id: Number(c[1]) }),
  },
  characterMention: {
    order: next(),
    match: anyScopeRegex(/^<@c(\d+)>/),
    parse: (c: RegExpExecArray) => ({ id: Number(c[1]) }),
  },
  roleMention: {
    order: next(),
    match: anyScopeRegex(/^<@&(\d+)>/),
    parse: (c: RegExpExecArray) => ({ id: Number(c[1]) }),
  },
  channelMention: {
    order: next(),
    match: anyScopeRegex(/^<#(\d+)>/),
    parse: (c: RegExpExecArray) => ({ id: Number(c[1]) }),
  },
  everyone: {
    order: next(),
    match: anyScopeRegex(/^@(everyone|here)\b/),
    parse: (c: RegExpExecArray) => ({ which: c[1] }),
  },
  autolink: {
    order: next(),
    match: anyScopeRegex(/^<(https?:\/\/[^\s>]+)>/),
    parse: (c: RegExpExecArray) => ({ url: c[1] }),
  },
  // Tavern extension: [text]{#a78bfa large wave} — coloured, resized and/or
  // animated text, written by the formatting bar. Only hex colours, three
  // sizes and the effects in lib/textEffects.ts.
  styled: {
    order: next(),
    match: anyScopeRegex(new RegExp(`^\\[((?:\\\\[\\s\\S]|[^\\]\\\\\\n]){1,2000})\\]\\{(${STYLED_ATTRS})\\}`)),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => {
      const attrs = c[2].split(/ +/);
      return {
        color: attrs.find((a) => a.startsWith('#')) ?? null,
        size: attrs.find((a) => a === 'small' || a === 'large' || a === 'huge') ?? null,
        effects: normalizeEffects(attrs.filter((a) => a in FX_BY_ID)),
        content: parse(c[1], state),
      };
    },
  },
  link: {
    order: next(),
    match: anyScopeRegex(/^\[([^[\]\n]{1,256})\]\(<?(https?:\/\/[^\s)>]+)>?\)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({
      target: c[2],
      content: parse(c[1], { ...state, inLink: true }),
    }),
  },
  url: {
    order: next(),
    match(source: string, state: State) {
      if (state.inLink) return null;
      const m = /^https?:\/\/[^\s<]+/.exec(source);
      if (!m) return null;
      // Drop trailing punctuation and markdown, and any unbalanced closing
      // bracket, but keep balanced ones (wiki links like /Foo_(bar)).
      let url = m[0];
      for (;;) {
        const before = url;
        url = url.replace(/[.,:;"'!?*_~|]+$/, '');
        for (const [open, close] of [
          ['(', ')'],
          ['[', ']'],
        ]) {
          while (url.endsWith(close) && url.split(close).length > url.split(open).length) url = url.slice(0, -1);
        }
        if (url === before) break;
      }
      if (url.length < 10) return null;
      return [url] as unknown as RegExpExecArray;
    },
    parse: (c: RegExpExecArray) => ({ url: c[0] }),
  },
  strong: {
    order: next(),
    match: anyScopeRegex(/^\*\*((?:\\[\s\S]|[^\\])+?)\*\*(?!\*)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({ content: parse(c[1], state) }),
  },
  underline: {
    order: next(),
    match: anyScopeRegex(/^__((?:\\[\s\S]|[^\\])+?)__(?!_)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({ content: parse(c[1], state) }),
  },
  em: { ...defaultRules.em, order: next() },
  strike: {
    order: next(),
    match: anyScopeRegex(/^~~([\s\S]+?)~~(?!~)/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({ content: parse(c[1], state) }),
  },
  spoiler: {
    order: next(),
    match: anyScopeRegex(/^\|\|([\s\S]+?)\|\|/),
    parse: (c: RegExpExecArray, parse: (s: string, st: State) => MdNode[], state: State) => ({ content: parse(c[1], state) }),
  },
  inlineCode: {
    order: next(),
    match: anyScopeRegex(/^(`+)([\s\S]*?[^`])\1(?!`)/),
    parse: (c: RegExpExecArray) => ({ content: c[2].replace(/^ (?= *`)|(` *) $/g, '$1') }),
  },
  text: {
    order: next(),
    // Like simple-markdown's text rule, but stops at newlines so line-start
    // rules (quotes, headings, lists) get a chance on the next line.
    match: anyScopeRegex(/^[\s\S]+?(?=[^0-9A-Za-z\sÀ-￿]|\n|\w+:\S|$)/),
    parse: (c: RegExpExecArray) => ({ content: c[0] }),
  },
};

const parser = SM.parserFor(rules as never, { inline: true });

export function parseMarkdown(source: string): MdNode[] {
  return parser(source, { inline: true }) as MdNode[];
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

/** Names for mentions, for plain-text previews (reply bars, notifications). */
export interface NameLookups {
  userName: (id: number) => string | null;
  characterName: (id: number) => string | null;
  role: (id: number) => { name: string; color: number } | null;
  channelName: (id: number) => string | null;
}

/** Name lookups against a store snapshot. */
export function storeLookups(s: StoreState): NameLookups {
  return {
    userName: (id) => (s.users[id] ? displayName(s.users[id]) : null),
    characterName: (id) => s.characters[id]?.name ?? null,
    role: (id) => (s.roles[id] ? { name: s.roles[id].name, color: s.roles[id].color } : null),
    channelName: (id) => s.channels[id]?.name ?? null,
  };
}

/**
 * How to render one piece of markdown. Mentions look up their own user,
 * character, role or channel in the store (each subscribes to just that one),
 * so the context stays the same object and a message doesn't re-render when
 * someone unrelated changes.
 */
export interface MarkdownContext {
  onUser?: (e: MouseEvent, id: number) => void;
  onCharacter?: (e: MouseEvent, id: number) => void;
  onChannel?: (id: number) => void;
  jumbo?: boolean;
  /** In-character rendering: quoted text is speech, the rest is action. */
  rp?: RpState;
  /** The message being shown (entrance effects play once, for new messages). */
  messageId?: number;
  /** Showing effects as samples (the effects picker): entrances play, clicks do nothing. */
  fxPreview?: boolean;
  /** Inside a text-effect run: how its letters get split up and numbered. */
  fx?: FxRender;
}

/** A text-effect run's rendering state, shared by every piece of text inside it. */
interface FxRender {
  letters: boolean;
  words: boolean;
  swap: ((text: string, start: number) => string) | null;
  mock: boolean;
  runes: boolean;
  hearts: boolean;
  decode: boolean;
  censor: boolean;
  materialize: boolean;
  total: number;
  /** Running counts: letters, words, and letters for aLtErNaTiNg case. */
  n: { i: number; w: number; mock: number };
}

export interface RpState {
  /** Are we inside "quoted speech" right now (carries across formatting)? */
  inQuote: boolean;
}

const QUOTE_RE = /["“”«»]/;

/** Book look: "quoted" text is speech, everything else is action. */
function renderRpText(text: string, key: string, ctx: MarkdownContext): ReactNode {
  const rp = ctx.rp!;
  const out: ReactNode[] = [];
  let buf = '';
  let i = 0;
  const flush = (speech: boolean) => {
    if (!buf) return;
    out.push(
      <span key={`${key}-${i++}`} className={speech ? 'rp-speech' : 'rp-action'}>
        {ctx.fx ? renderFxText(buf, 0, ctx) : renderText(buf, 0, ctx.jumbo)}
      </span>,
    );
    buf = '';
  };
  for (const ch of text) {
    if (QUOTE_RE.test(ch)) {
      const opening = ch === '“' || ch === '«' || (ch === '"' && !rp.inQuote);
      if (opening && !rp.inQuote) {
        flush(false);
        rp.inQuote = true;
        buf += ch;
      } else if (rp.inQuote) {
        buf += ch;
        flush(true);
        rp.inQuote = false;
      } else {
        buf += ch;
      }
    } else {
      buf += ch;
    }
  }
  flush(rp.inQuote);
  return <Fragment key={key}>{out}</Fragment>;
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return (
    <span
      className={`spoiler ${shown ? 'revealed' : ''}`}
      role="button"
      tabIndex={shown ? -1 : 0}
      onClick={(e) => {
        if (!shown) {
          e.stopPropagation();
          setShown(true);
        }
      }}
      onKeyDown={(e) => e.key === 'Enter' && setShown(true)}
      aria-label={shown ? undefined : 'Spoiler'}
    >
      <span className="spoiler-inner">{children}</span>
    </span>
  );
}

export function EmojiImg({ emoji, jumbo }: { emoji: string; jumbo?: boolean }) {
  const [failed, setFailed] = useState(false);
  if (failed) return <span className={`emoji-native ${jumbo ? 'jumbo' : ''}`}>{emoji}</span>;
  const name = emojiShortcode(emoji);
  return (
    <img
      className={`emoji ${jumbo ? 'jumbo' : ''}`}
      src={twemojiUrl(emoji)}
      alt={emoji}
      title={name}
      draggable={false}
      onError={() => setFailed(true)}
    />
  );
}

function renderText(text: string, key: string | number, jumbo?: boolean): ReactNode {
  const parts = splitEmoji(text);
  if (parts.length === 1 && typeof parts[0] === 'string') return <Fragment key={key}>{text}</Fragment>;
  return (
    <Fragment key={key}>
      {parts.map((p, i) => (typeof p === 'string' ? p : <EmojiImg key={i} emoji={p.emoji} jumbo={jumbo} />))}
    </Fragment>
  );
}

export function renderNodes(nodes: MdNode[], ctx: MarkdownContext, keyPrefix = ''): ReactNode[] {
  return nodes.map((node, i) => renderNode(node, ctx, `${keyPrefix}${i}`));
}

function renderNode(node: MdNode, ctx: MarkdownContext, key: string): ReactNode {
  const kids = (n: MdNode[]) => renderNodes(n, ctx, `${key}.`);
  switch (node.type) {
    case 'text':
      if (ctx.rp) return renderRpText(node.content, key, ctx);
      return ctx.fx ? renderFxText(node.content, key, ctx) : renderText(node.content, key, ctx.jumbo);
    case 'styled':
      if (node.effects?.length) return <FxRun key={key} node={node} ctx={ctx} nodeKey={key} />;
      return (
        <span key={key} className={`md-styled${node.size ? ` md-size-${node.size}` : ''}`} style={node.color ? { color: node.color } : undefined}>
          {kids(node.content)}
        </span>
      );
    case 'newline':
      return <br key={key} />;
    case 'strong':
      return <strong key={key}>{kids(node.content)}</strong>;
    case 'em':
      return (
        <em key={key} className={ctx.rp ? (ctx.rp.inQuote ? 'rp-em-speech' : 'rp-em-action') : undefined}>
          {kids(node.content)}
        </em>
      );
    case 'underline':
      return <u key={key}>{kids(node.content)}</u>;
    case 'strike':
      return <s key={key}>{kids(node.content)}</s>;
    case 'spoiler':
      return <Spoiler key={key}>{kids(node.content)}</Spoiler>;
    case 'inlineCode':
      return (
        <code key={key} className="inline-code">
          {node.content}
        </code>
      );
    case 'codeBlock':
      return (
        <pre key={key} className="code-block">
          <code>{node.content}</code>
        </pre>
      );
    case 'blockQuote':
      return (
        <div key={key} className="blockquote">
          <div className="blockquote-bar" />
          <blockquote>{kids(node.content)}</blockquote>
        </div>
      );
    case 'heading': {
      const Tag = (['h1', 'h2', 'h3'] as const)[node.level - 1];
      return (
        <Tag key={key} className="md-heading">
          {kids(node.content)}
        </Tag>
      );
    }
    case 'subtext':
      return (
        <small key={key} className="md-subtext">
          {kids(node.content)}
        </small>
      );
    case 'list': {
      const Tag = node.ordered ? 'ol' : 'ul';
      return (
        <Tag key={key} className="md-list" start={node.ordered ? node.start : undefined}>
          {node.items.map((item: { nested: boolean; content: MdNode[] }, i: number) => (
            <li key={i} className={item.nested ? 'nested' : undefined}>
              {renderNodes(item.content, ctx, `${key}.${i}.`)}
            </li>
          ))}
        </Tag>
      );
    }
    case 'url':
    case 'autolink':
      return (
        <a key={key} href={node.url} target="_blank" rel="noreferrer noopener">
          {node.url}
        </a>
      );
    case 'link':
      return (
        <a key={key} href={node.target} target="_blank" rel="noreferrer noopener" title={node.target}>
          {kids(node.content)}
        </a>
      );
    case 'customEmoji':
      return (
        <img
          key={key}
          className={`emoji ${ctx.jumbo ? 'jumbo' : ''}`}
          src={emojiUrl(node.id)}
          alt={`:${node.name}:`}
          title={`:${node.name}:`}
          draggable={false}
        />
      );
    case 'timestamp': {
      const date = new Date(node.seconds * 1000);
      if (Number.isNaN(date.getTime())) return <Fragment key={key}>{`<t:${node.seconds}>`}</Fragment>;
      return (
        <span key={key} className="md-timestamp" title={formatFull(date)}>
          {formatDiscordTimestamp(node.seconds, node.style)}
        </span>
      );
    }
    case 'userMention':
      return <UserMention key={key} id={node.id} onClick={ctx.onUser} />;
    case 'characterMention':
      return <CharacterMention key={key} id={node.id} onClick={ctx.onCharacter} />;
    case 'roleMention':
      return <RoleMention key={key} id={node.id} />;
    case 'channelMention':
      return <ChannelMention key={key} id={node.id} onClick={ctx.onChannel} />;
    case 'everyone':
      return (
        <span key={key} className="mention">
          @{node.which}
        </span>
      );
    default:
      return null;
  }
}

// Each mention watches only the name it shows (a string), so presence changes
// or new messages elsewhere don't touch it.

function UserMention({ id, onClick }: { id: number; onClick?: (e: MouseEvent, id: number) => void }) {
  const name = useStore((s) => (s.users[id] ? displayName(s.users[id]) : null));
  return (
    <span className="mention interactive" role="button" tabIndex={0} onClick={(e) => onClick?.(e, id)}>
      @{name ?? 'unknown-user'}
    </span>
  );
}

function CharacterMention({ id, onClick }: { id: number; onClick?: (e: MouseEvent, id: number) => void }) {
  const name = useStore((s) => s.characters[id]?.name ?? null);
  return (
    <span className="mention interactive" role="button" tabIndex={0} onClick={(e) => onClick?.(e, id)}>
      @{name ?? 'unknown-character'}
    </span>
  );
}

function RoleMention({ id }: { id: number }) {
  const name = useStore((s) => s.roles[id]?.name ?? null);
  const color = useStore((s) => s.roles[id]?.color ?? 0);
  if (name === null) return <span className="mention">@deleted-role</span>;
  const style = color
    ? { color: `#${color.toString(16).padStart(6, '0')}`, backgroundColor: `rgba(${(color >> 16) & 255}, ${(color >> 8) & 255}, ${color & 255}, 0.1)` }
    : undefined;
  return (
    <span className="mention role-mention" style={style}>
      @{name}
    </span>
  );
}

function ChannelMention({ id, onClick }: { id: number; onClick?: (id: number) => void }) {
  const name = useStore((s) => s.channels[id]?.name ?? null);
  const emoji = useStore((s) => s.channels[id]?.emoji ?? null);
  const voice = useStore((s) => s.channels[id]?.type === ChannelType.VOICE);
  return (
    <span className="mention interactive channel-mention" role="button" tabIndex={0} onClick={() => name && onClick?.(id)}>
      {emoji ? <ChannelEmoji emoji={emoji} /> : <Icon path={!name ? mdiAt : voice ? mdiVolumeHigh : mdiTextBoxOutline} size={15} className="channel-mention-icon" />}
      {name ?? 'unknown'}
    </span>
  );
}

/** A channel's icon: unicode emoji (as Twemoji) or "c:<id>" custom emoji. */
export function ChannelEmoji({ emoji, className }: { emoji: string; className?: string }) {
  if (emoji.startsWith('c:')) {
    return <img className={`emoji channel-emoji ${className ?? ''}`} src={emojiUrl(Number(emoji.slice(2)))} alt="" draggable={false} />;
  }
  return (
    <span className={`channel-emoji ${className ?? ''}`}>
      <EmojiImg emoji={emoji} />
    </span>
  );
}

/** Plain-text preview of a message (for reply bars, notifications). */
export function plainText(content: string, ctx: NameLookups): string {
  return stripStyled(
    content
      .replace(/<@!?(\d+)>/g, (_, id) => `@${ctx.userName(Number(id)) ?? 'unknown-user'}`)
      .replace(/<@c(\d+)>/g, (_, id) => `@${ctx.characterName(Number(id)) ?? 'unknown-character'}`)
      .replace(/<@&(\d+)>/g, (_, id) => `@${ctx.role(Number(id))?.name ?? 'deleted-role'}`)
      .replace(/<#(\d+)>/g, (_, id) => `#${ctx.channelName(Number(id)) ?? 'unknown'}`)
      .replace(/<a?:(\w+):\d+>/g, ':$1:')
      .replace(/<t:(-?\d+)(?::[tTdDfFR])?>/g, (_, s) => formatDiscordTimestamp(Number(s), 'f')),
  );
}

// ---------------------------------------------------------------------------
// Text effects (see lib/textEffects.ts and styles/effects.css)
// ---------------------------------------------------------------------------

/** Past this many letters a run shows its colours but doesn't animate letter by letter. */
const MAX_FX_LETTERS = 1500;

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;

function graphemes(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
}

function countLetters(nodes: MdNode[]): number {
  let n = 0;
  for (const node of nodes) {
    if (node.type === 'text') n += graphemes(node.content).filter((g) => !/^\s$/.test(g)).length;
    else if (Array.isArray(node.content)) n += countLetters(node.content);
  }
  return n;
}

const LETTER_RE = /[\p{L}\p{N}]/u;

function letterSpan(content: ReactNode, text: string | null, fx: FxRender): ReactNode {
  const i = fx.n.i++;
  const style: Record<string, string | number> = { '--i': i, '--r': rand(i).toFixed(3) };
  if (fx.materialize) {
    const angle = rand(i, 3) * Math.PI * 2;
    const dist = 0.9 + rand(i, 5) * 1.2;
    style['--dx'] = `${(Math.cos(angle) * dist).toFixed(2)}em`;
    style['--dy'] = `${(Math.sin(angle) * dist).toFixed(2)}em`;
  }
  let cls = 'fx-ch';
  if (i === fx.total - 1) cls += ' fx-last';
  let inner = content;
  if (text !== null) {
    const rune = fx.runes ? runeFor(text) : null;
    if (rune) {
      cls += ' fx-layered';
      inner = (
        <>
          <span className="fx-rune-g" aria-hidden>
            {rune}
          </span>
          <span className="fx-rune-r">{text}</span>
        </>
      );
    } else if (fx.hearts && /[oaOA]/.test(text)) {
      cls += ' fx-layered';
      inner = (
        <>
          <span className="fx-h-l">{text}</span>
          <span className="fx-h-g" aria-hidden>
            ♥
          </span>
        </>
      );
    } else if (fx.censor && /[aeiouAEIOU]/.test(text)) {
      cls += ' fx-layered';
      inner = (
        <>
          <span className="fx-cl">{text}</span>
          <span className="fx-cg" aria-hidden />
        </>
      );
    } else if (fx.decode && LETTER_RE.test(text)) {
      cls += ' fx-layered';
      inner = (
        <>
          <span className="fx-dl">{text}</span>
          <span className="fx-dg" aria-hidden />
        </>
      );
    }
  }
  return (
    <span key={i} className={cls} style={style as CSSProperties}>
      {inner}
    </span>
  );
}

/** Text inside an effect run: split into words (which never break) and letters (which move). */
function renderFxText(text: string, key: string | number, ctx: MarkdownContext): ReactNode {
  const fx = ctx.fx!;
  const swapped = fx.swap ? fx.swap(text, fx.n.mock) : text;
  if (!fx.letters && !fx.words && !fx.mock) return renderText(swapped, key, ctx.jumbo);
  const out: ReactNode[] = [];
  let word: ReactNode[] = [];
  let k = 0;
  const flush = () => {
    if (!word.length) return;
    if (fx.letters || fx.words) {
      out.push(
        <span key={`w${k++}`} className="fx-w" style={{ '--w': fx.n.w++ } as CSSProperties}>
          {word}
        </span>,
      );
    } else out.push(<Fragment key={`w${k++}`}>{word}</Fragment>);
    word = [];
  };
  for (const part of splitEmoji(swapped)) {
    if (typeof part !== 'string') {
      const img = <EmojiImg key={`e${k++}`} emoji={part.emoji} jumbo={ctx.jumbo} />;
      word.push(fx.letters ? letterSpan(img, null, fx) : img);
      continue;
    }
    for (let g of graphemes(part)) {
      if (/^\s$/.test(g)) {
        flush();
        out.push(g);
        continue;
      }
      if (fx.mock && /\p{L}/u.test(g)) g = fx.n.mock++ % 2 ? g.toUpperCase() : g.toLowerCase();
      word.push(fx.letters ? letterSpan(g, g, fx) : g);
    }
  }
  flush();
  return <Fragment key={key}>{out}</Fragment>;
}

/** Offscreen effect runs pause, so a long chat full of fire doesn't cook the CPU. */
const fxObserver =
  typeof IntersectionObserver !== 'undefined'
    ? new IntersectionObserver((entries) => {
        for (const e of entries) e.target.classList.toggle('fx-off', !e.isIntersecting);
      })
    : null;

/** How long an entrance takes (ms), so the run can drop its entrance classes afterwards. */
function entranceMs(effects: string[], total: number, step: number): number {
  if (effects.includes('typewriter')) return total * step + step * 2 + 1700;
  if (effects.includes('decode')) return 350 + total * step * 1.4 + 200;
  if (effects.includes('materialize')) return 450 + total * 10 + 1000;
  if (effects.includes('unfold')) return total * 60 + 900; // words are fewer than letters; generous
  return 900;
}

function FxRun({ node, ctx, nodeKey }: { node: MdNode; ctx: MarkdownContext; nodeKey: string }) {
  const effects: string[] = node.effects;
  const ref = useRef<HTMLSpanElement>(null);
  const entrance = hasEntrance(effects);
  const [play, setPlay] = useState(() => entrance && (!!ctx.fxPreview || claimEntrance(`${ctx.messageId}:${nodeKey}`, ctx.messageId)));
  const [round, setRound] = useState(0);
  const [open, setOpen] = useState(false);
  const total = useMemo(() => countLetters(node.content), [node]);
  const step = Math.max(18, Math.min(55, 1800 / Math.max(1, total)));

  useEffect(() => {
    const el = ref.current;
    if (!el || !fxObserver) return;
    fxObserver.observe(el);
    return () => fxObserver.unobserve(el);
  }, []);
  useEffect(() => {
    if (!play) return;
    const t = window.setTimeout(() => setPlay(false), entranceMs(effects, total, step));
    return () => window.clearTimeout(t);
  }, [play, round]); // eslint-disable-line react-hooks/exhaustive-deps

  const letters = needsLetters(effects) && total <= MAX_FX_LETTERS;
  const fx: FxRender = {
    letters,
    words: letters || effects.some((id) => FX_BY_ID[id]?.scope === 'word'),
    swap: effects.includes('mock') ? null : transformFor(effects),
    mock: effects.includes('mock'),
    runes: letters && effects.includes('runes'),
    hearts: letters && effects.includes('hearts'),
    decode: letters && effects.includes('decode'),
    censor: letters && effects.includes('censor'),
    materialize: effects.includes('materialize'),
    total,
    n: { i: 0, w: 0, mock: 0 },
  };
  const redacted = effects.includes('redacted');
  const runes = effects.includes('runes');
  const classes = ['fx', ...effects.map((e) => `fx-${e}`)];
  if (node.size) classes.push(`md-styled md-size-${node.size}`);
  if (node.color || effects.some((e) => COLORED_FX.has(e))) classes.push('md-colored');
  if (play) classes.push('fx-play');
  if (open) classes.push('fx-open');
  if (entrance && !redacted && !runes && !ctx.fxPreview) classes.push('fx-replayable');
  const style = { '--fx-step': `${Math.round(step)}ms`, color: node.color ?? undefined } as CSSProperties;

  return (
    <span
      ref={ref}
      className={classes.join(' ')}
      style={style}
      role={redacted && !open ? 'button' : undefined}
      aria-label={redacted && !open ? 'Redacted text: click to reveal' : undefined}
      onClick={(e) => {
        if (ctx.fxPreview) return;
        if (redacted && !open) {
          e.stopPropagation();
          setOpen(true);
        } else if (runes) {
          setOpen((o) => !o);
        } else if (entrance && !play) {
          setRound((r) => r + 1);
          setPlay(true);
        }
      }}
    >
      <Fragment key={round}>{renderNodes(node.content, { ...ctx, fx }, `${nodeKey}.`)}</Fragment>
    </span>
  );
}
