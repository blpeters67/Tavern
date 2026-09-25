import { Color, FontSize, TextStyle } from '@tiptap/extension-text-style';
import type { JSONContent } from '@tiptap/core';
import { EditorContent, useEditor, useEditorState, type Editor } from '@tiptap/react';
import { Placeholder } from '@tiptap/extensions';
import StarterKit from '@tiptap/starter-kit';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { characterAvatar, emojiUrl, userAvatar } from '../lib/avatars';
import { currentToken, encodeMessage, matchProxy, type InsertedMention } from '../lib/compose';
import { searchEmoji, loadEmojiData } from '../lib/emoji';
import { calmColor, colorHex, soften } from '../lib/format';
import { EmojiImg } from '../lib/markdown';
import { channelPermissions, P } from '../lib/permissions';
import { effectsInSelection, TextEffects } from '../lib/fxEditor';
import { docToMarkdown, normalizeHex, SIZES, sizeName, textToContent, type SizeName } from '../lib/richtext';
import { bookLookFor, setBookLook, useBookLook } from '../lib/bookLook';
import { parseRollCommand, roll } from '../lib/rolls';
import { afterPointerRelease } from '../lib/pointer';
import { CharacterEditorModal } from '../modals/CharacterModals';
import { cyclePersona, openModal, openSettings, resetTyping, sendMessage, sendTyping, setPersona } from '../store/actions';
import { channelTitle, displayName, isDm, myChannelPerms, myCharacters, narratorName, permCtx, personaFor, roleColor } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Channel, Character, User } from '../store/types';
import { ChannelType, MessageType, NARRATOR } from '../store/types';
import ChannelIcon from './ChannelIcon';
import DiceTray from './DiceTray';
import EffectsPicker from './EffectsPicker';
import EmojiPicker, { type PickedEmoji } from './EmojiPicker';
import {
  Icon,
  mdiCheck,
  mdiCloseCircle,
  mdiDiceD20,
  mdiEmoticonHappy,
  mdiEyeOff,
  mdiFileDocumentOutline,
  mdiFormatBold,
  mdiFormatColorText,
  mdiFormatItalic,
  mdiFormatQuoteClose,
  mdiFormatSize,
  mdiFormatStrikethrough,
  mdiFormatUnderline,
  mdiMenuDown,
  mdiPlus,
  mdiPlusCircle,
  mdiSend,
  mdiStarFourPoints,
  mdiBookOpenPageVariant,
  mdiBookOpenPageVariantOutline,
  TextFxIcon,
} from './icons';
import { hideTooltip, Modal, Popout, tip, usePopout } from './layers';
import { toast } from './Toasts';
import { Avatar, Button } from './ui';

const MAX_LENGTH = 4000;

/** Unsent messages per channel, kept as editor documents for this session. */
const drafts = new Map<number, JSONContent>();

function filesTooPowerful(limitMb: number) {
  openModal((close) => (
    <Modal
      title="Your files are too powerful"
      onClose={close}
      centered
      footer={
        <Button onClick={close} grow>
          Okay
        </Button>
      }
    >
      <p className="modal-text center">Uploads can add up to {limitMb} MB per message. Try fewer or smaller files.</p>
    </Modal>
  ));
}

interface AcItem {
  key: string;
  section: string;
  label: ReactNode;
  sub?: ReactNode;
  icon: ReactNode;
  insert: string;
  mention?: InsertedMention;
}

function isTouch() {
  return window.matchMedia('(pointer: coarse)').matches;
}

// ---------------------------------------------------------------------------
// Who and what can be mentioned here
// ---------------------------------------------------------------------------

function mentionableUsers(channel: Channel): User[] {
  const s = getState();
  if (channel.server_id === null) return (channel.recipient_ids ?? []).map((id) => s.users[id]).filter(Boolean);
  const ctx = permCtx(s, channel.server_id);
  const members = Object.values(s.members[channel.server_id] ?? {});
  return members
    .filter((m) => ctx && channelPermissions({ ...ctx, member: m }, m.user_id, channel) & P.VIEW_CHANNEL)
    .map((m) => s.users[m.user_id])
    .filter(Boolean);
}

function linkableChannels(serverId: number | null): Channel[] {
  if (serverId === null) return [];
  const s = getState();
  return Object.values(s.channels).filter(
    (c) => c.server_id === serverId && (c.type === ChannelType.TEXT || c.type === ChannelType.VOICE) && (myChannelPerms(s, c) & P.VIEW_CHANNEL) !== 0,
  );
}

function buildItems(channel: Channel, trigger: '@' | '#' | ':', query: string): AcItem[] {
  const s = getState();
  const q = query.toLowerCase();
  const out: AcItem[] = [];
  if (trigger === '@') {
    const users = mentionableUsers(channel);
    const perms = myChannelPerms(s, channel);
    const immersive = s.me!.settings.immersive;
    const userMatches = users
      .filter((u) => !q || u.username.startsWith(q) || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)))
      .slice(0, 8);
    for (const u of userMatches) {
      out.push({
        key: `u${u.id}`,
        section: 'Members',
        label: displayName(u),
        sub: u.username,
        icon: <Avatar src={userAvatar(u)} size={24} status={u.status} />,
        insert: `@${u.username}`,
      });
    }
    // Characters can always be @mentioned; it pings whoever plays them.
    const ids = new Set(users.map((u) => u.id));
    const chars = Object.values(s.characters)
      .filter((c) => !c.deleted && ids.has(c.owner_id) && (!q || c.name.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name))
      .slice(0, 8);
    for (const c of chars) {
      out.push({
        key: `c${c.id}`,
        section: 'Characters',
        label: <span style={c.color ? { color: calmColor(c.color) } : undefined}>{c.name}</span>,
        sub: immersive && c.owner_id !== s.me!.id ? undefined : displayName(s.users[c.owner_id]),
        icon: <img className="ac-avatar" src={characterAvatar(c)} alt="" />,
        insert: `@${c.name}`,
        mention: { display: `@${c.name}`, token: `<@c${c.id}>` },
      });
    }
    if (channel.server_id !== null) {
      const canEveryone = (perms & P.MENTION_EVERYONE) !== 0;
      const roles = Object.values(s.roles)
        .filter((r) => r.server_id === channel.server_id && !r.is_default && (r.mentionable || canEveryone) && (!q || r.name.toLowerCase().includes(q)))
        .slice(0, 6);
      for (const r of roles) {
        out.push({
          key: `r${r.id}`,
          section: 'Roles',
          label: <span style={{ color: r.color ? colorHex(r.color) : undefined }}>@{r.name}</span>,
          sub: 'Notify everyone with this role',
          icon: <span className="ac-at">@</span>,
          insert: `@${r.name}`,
          mention: { display: `@${r.name}`, token: `<@&${r.id}>` },
        });
      }
      if (canEveryone) {
        for (const [word, desc] of [
          ['everyone', 'Notify everyone who can see this channel.'],
          ['here', 'Notify everyone online who can see this channel.'],
        ]) {
          if (word.startsWith(q)) out.push({ key: word, section: 'Roles', label: `@${word}`, sub: desc, icon: <span className="ac-at">@</span>, insert: `@${word}` });
        }
      }
    }
  } else if (trigger === '#') {
    const channels = linkableChannels(channel.server_id)
      .filter((c) => !q || (c.name ?? '').toLowerCase().includes(q))
      .sort((a, b) => a.type - b.type || a.position - b.position)
      .slice(0, 10);
    for (const c of channels) {
      out.push({
        key: `ch${c.id}`,
        section: 'Channels',
        label: c.name,
        sub: c.parent_id ? s.channels[c.parent_id]?.name : c.type === ChannelType.VOICE ? 'Voice space' : undefined,
        icon: <ChannelIcon channel={c} size={20} />,
        insert: `#${c.name}`,
        mention: { display: `#${c.name}`, token: `<#${c.id}>` },
      });
    }
  } else {
    const customs = Object.values(s.emojis)
      .filter((e) => s.servers[e.server_id] && e.name.toLowerCase().includes(q))
      .sort((a, b) => Number(b.server_id === channel.server_id) - Number(a.server_id === channel.server_id))
      .slice(0, 6);
    for (const e of customs) {
      out.push({
        key: `e${e.id}`,
        section: `Emoji matching :${query}`,
        label: `:${e.name}:`,
        sub: s.servers[e.server_id]?.name,
        icon: <img className="emoji" src={emojiUrl(e.id)} alt="" />,
        insert: `:${e.name}:`,
      });
    }
    for (const e of searchEmoji(q, 10 - Math.min(customs.length, 4))) {
      out.push({ key: `u${e.f}`, section: `Emoji matching :${query}`, label: `:${e.n[0]}:`, icon: <EmojiImg emoji={e.u} />, insert: e.u });
    }
  }
  return out.slice(0, 20);
}

// ---------------------------------------------------------------------------
// Persona picker
// ---------------------------------------------------------------------------

function NarratorBadge({ size = 20 }: { size?: number }) {
  return (
    <span className="narrator-badge" style={{ width: size, height: size }}>
      <Icon path={mdiStarFourPoints} size={Math.round(size * 0.62)} />
    </span>
  );
}

function PersonaPicker({ channelId, current, chars, onDone }: { channelId: number; current: number; chars: Character[]; onDone: () => void }) {
  const me = useStore((s) => s.me)!;
  const serverId = useStore((s) => s.channels[channelId]?.server_id ?? null);
  const dm = useStore((s) => isDm(s, serverId));
  const narrator = useStore((s) => narratorName(s, serverId));
  const pick = (id: number) => {
    setPersona(channelId, id);
    onDone();
    window.dispatchEvent(new CustomEvent('tavern:focus-input'));
  };
  const tag = (c: Character) => (c.proxy_prefix || c.proxy_suffix ? `${c.proxy_prefix ?? ''}text${c.proxy_suffix ?? ''}` : null);
  return (
    <div className="persona-picker">
      <div className="persona-picker-title">Speak as</div>
      <div className="persona-options scroller-thin">
        <button className={`persona-option ${current === 0 ? 'selected' : ''}`} onClick={() => pick(0)}>
          <img src={userAvatar(me)} alt="" />
          <span className="persona-name">{displayName(me)}</span>
          <span className="persona-tag you">yourself</span>
          {current === 0 && <Icon path={mdiCheck} size={18} className="persona-check" />}
        </button>
        {dm && (
          <button className={`persona-option narrator ${current === NARRATOR ? 'selected' : ''}`} onClick={() => pick(NARRATOR)}>
            <NarratorBadge size={32} />
            <span className="persona-name">{narrator}</span>
            <span className="persona-tag gm">narrator</span>
            {current === NARRATOR && <Icon path={mdiCheck} size={18} className="persona-check" />}
          </button>
        )}
        {chars.map((c) => (
          <button key={c.id} className={`persona-option ${current === c.id ? 'selected' : ''}`} onClick={() => pick(c.id)}>
            <img src={characterAvatar(c)} alt="" />
            <span className="persona-name" style={c.color ? { color: calmColor(c.color) } : undefined}>
              {c.name}
            </span>
            {tag(c) && <code className="persona-tag">{tag(c)}</code>}
            {current === c.id && <Icon path={mdiCheck} size={18} className="persona-check" />}
          </button>
        ))}
      </div>
      <div className="persona-picker-footer">
        <button
          className="persona-footer-button"
          onClick={() => {
            onDone();
            openModal((close) => <CharacterEditorModal onClose={close} />);
          }}
        >
          <Icon path={mdiPlus} size={16} /> New Character
        </button>
        <button
          className="persona-footer-button"
          onClick={() => {
            onDone();
            openSettings({ kind: 'user', section: 'characters' });
          }}
        >
          Manage
        </button>
      </div>
      {me.settings.switch_hotkey && (chars.length > 0 || dm) && (
        <div className="persona-hint">
          <kbd>Alt</kbd> + <kbd>↑</kbd>/<kbd>↓</kbd> switches while you type
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

export function TypingIndicator({ channelId }: { channelId: number }) {
  const typing = useStore((s) => s.typing[channelId]);
  const users = useStore((s) => s.users);
  const characters = useStore((s) => s.characters);
  const me = useStore((s) => s.me)!;
  const narrator = useStore((s) => narratorName(s, s.channels[channelId]?.server_id));
  const entries = Object.entries(typing ?? {}).filter(([uid]) => Number(uid) !== me.id);
  if (!entries.length) return <div className="typing" />;
  const names = entries.map(([uid, e]) => {
    if (e.narrator) return narrator;
    const ch = e.characterId ? characters[e.characterId] : undefined;
    if (ch) return me.settings.immersive ? ch.name : `${ch.name} (${displayName(users[Number(uid)])})`;
    return displayName(users[Number(uid)]);
  });
  let text: ReactNode;
  if (names.length === 1)
    text = (
      <>
        <strong>{names[0]}</strong> is typing...
      </>
    );
  else if (names.length === 2)
    text = (
      <>
        <strong>{names[0]}</strong> and <strong>{names[1]}</strong> are typing...
      </>
    );
  else if (names.length === 3)
    text = (
      <>
        <strong>{names[0]}</strong>, <strong>{names[1]}</strong>, and <strong>{names[2]}</strong> are typing...
      </>
    );
  else text = <>Several people are typing...</>;
  return (
    <div className="typing active" aria-live="polite">
      <span className="typing-dots">
        <i />
        <i />
        <i />
      </span>
      <span className="typing-text">{text}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Formatting bar
// ---------------------------------------------------------------------------

/** Colours that read well on the navy chat. */
export const TEXT_COLORS = [
  '#e0b252',
  '#f0a35e',
  '#f47b7b',
  '#e879b9',
  '#b48cf2',
  '#8fa6ff',
  '#7aa2f7',
  '#5ccfe6',
  '#5fd3a1',
  '#a3d977',
  '#d8c9a7',
  '#9aa5b8',
];

/** Keep the editor's selection when clicking toolbar buttons. */
const keepFocus = (e: { preventDefault: () => void }) => {
  e.preventDefault();
  hideTooltip();
};

const SIZE_LABELS: [SizeName | null, string][] = [
  ['small', 'Small'],
  [null, 'Normal'],
  ['large', 'Large'],
  ['huge', 'Huge'],
];

function FormatButton({
  label,
  icon,
  active,
  onClick,
  keys,
  disabled,
  className,
}: {
  label: string;
  icon: string | ReactNode;
  active?: boolean;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  keys?: string;
  disabled?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      className={`format-button ${active ? 'active' : ''} ${className ?? ''}`}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      {...tip(keys ? `${label} (${keys})` : label)}
      onMouseDown={keepFocus}
      onClick={onClick}
    >
      {typeof icon === 'string' ? <Icon path={icon} size={18} /> : icon}
    </button>
  );
}

/** The book look switch, in the formatting bar (or next to the box when the bar is turned off). */
export interface BookSwitch {
  on: boolean;
  /** Narration always uses the book look. */
  locked: boolean;
  toggle: () => void;
}

function bookTip(book: BookSwitch): string {
  if (book.locked) return 'Narration always uses the book look';
  return book.on ? 'Book look is on: "speech" in white, the rest as italic action. Everyone sees it.' : 'Book look is off. Click to write like a story.';
}

function FormatBar({ editor, onMenu, book }: { editor: Editor; onMenu: (open: boolean) => void; book: BookSwitch | null }) {
  const state = useEditorState({
    editor,
    selector: ({ editor: e }) => ({
      bold: e.isActive('bold'),
      italic: e.isActive('italic'),
      underline: e.isActive('underline'),
      strike: e.isActive('strike'),
      color: normalizeHex(e.getAttributes('textStyle').color),
      size: sizeName(e.getAttributes('textStyle').fontSize),
      effects: effectsInSelection(e.state).join(' '),
    }),
  });
  const sizePop = usePopout();
  const colorPop = usePopout();
  const fxPop = usePopout();
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl';
  useEffect(() => onMenu(sizePop.isOpen || colorPop.isOpen || fxPop.isOpen), [sizePop.isOpen, colorPop.isOpen, fxPop.isOpen]); // eslint-disable-line react-hooks/exhaustive-deps
  const effects = state?.effects ? state.effects.split(' ') : [];

  const chain = () => editor.chain().focus();
  const setSize = (size: SizeName | null) => {
    if (size) chain().setFontSize(SIZES[size]).run();
    else chain().unsetFontSize().run();
    sizePop.close();
  };
  const setColor = (color: string | null) => {
    if (color) chain().setColor(color).run();
    else chain().unsetColor().run();
  };
  const wrap = (open: string, close: string) => {
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      chain()
        .insertContent(open + close)
        .setTextSelection(from + open.length)
        .run();
    } else {
      chain()
        .insertContentAt(to, close)
        .insertContentAt(from, open)
        .setTextSelection({ from: from + open.length, to: to + open.length })
        .run();
    }
  };

  return (
    <div className="format-bar" role="toolbar" aria-label="Text formatting">
      <FormatButton label="Bold" keys={`${mod}+B`} icon={mdiFormatBold} active={state?.bold} onClick={() => chain().toggleBold().run()} />
      <FormatButton label="Italic" keys={`${mod}+I`} icon={mdiFormatItalic} active={state?.italic} onClick={() => chain().toggleItalic().run()} />
      <FormatButton label="Underline" keys={`${mod}+U`} icon={mdiFormatUnderline} active={state?.underline} onClick={() => chain().toggleUnderline().run()} />
      <FormatButton label="Strikethrough" icon={mdiFormatStrikethrough} active={state?.strike} onClick={() => chain().toggleStrike().run()} />
      <span className="format-sep" />
      <button
        type="button"
        className={`format-button wide ${state?.size ? 'active' : ''}`}
        aria-label="Text size"
        {...tip('Text Size')}
        onMouseDown={keepFocus}
        onClick={(e) => sizePop.toggle(e)}
      >
        <Icon path={mdiFormatSize} size={18} />
        <span className="format-label">{state?.size ? SIZE_LABELS.find(([k]) => k === state.size)?.[1] : 'Size'}</span>
        <Icon path={mdiMenuDown} size={14} />
      </button>
      <button
        type="button"
        className={`format-button ${state?.color ? 'active' : ''}`}
        aria-label="Text colour"
        {...tip('Text Colour')}
        onMouseDown={keepFocus}
        onClick={(e) => colorPop.toggle(e)}
      >
        <span className="format-color">
          <Icon path={mdiFormatColorText} size={18} />
          <i style={{ background: state?.color ?? 'var(--text-normal)' }} />
        </span>
      </button>
      <FormatButton
        label="Text Effects"
        icon={<TextFxIcon size={19} />}
        active={effects.length > 0 || fxPop.isOpen}
        onClick={(e) => fxPop.toggle(e)}
        className="fx-button"
      />
      <span className="format-sep" />
      <FormatButton label="Speech: wrap in quotes" icon={mdiFormatQuoteClose} onClick={() => wrap('"', '"')} />
      <FormatButton label="Spoiler" icon={mdiEyeOff} onClick={() => wrap('||', '||')} />
      {book && (
        <>
          <span className="format-sep" />
          <button
            type="button"
            className={`format-button wide book-format ${book.on ? 'active' : ''}`}
            aria-label="Book look"
            aria-pressed={book.on}
            disabled={book.locked}
            {...tip(bookTip(book))}
            onMouseDown={keepFocus}
            onClick={book.toggle}
          >
            <Icon path={book.on ? mdiBookOpenPageVariant : mdiBookOpenPageVariantOutline} size={18} />
            <span className="format-label">Book</span>
          </button>
        </>
      )}
      {fxPop.anchor && (
        <Popout anchor={fxPop.anchor} side="top-start" onClose={fxPop.close} className="format-popout fx-popout" gap={6}>
          <EffectsPicker
            active={effects}
            onToggle={(id) => editor.chain().focus().toggleTextEffect(id).run()}
            onClear={() => editor.chain().focus().clearTextEffects().run()}
          />
        </Popout>
      )}
      {sizePop.anchor && (
        <Popout anchor={sizePop.anchor} side="top-start" onClose={sizePop.close} className="format-popout" gap={6}>
          <div className="menu format-size-menu">
            {SIZE_LABELS.map(([key, label]) => (
              <button
                key={label}
                className={`menu-item format-size-item ${state?.size === key ? 'current' : ''}`}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => setSize(key)}
              >
                <span className={`menu-label ${key ? `md-size-${key}` : ''}`}>{label}</span>
                {state?.size === key && <Icon path={mdiCheck} size={16} className="menu-icon" />}
              </button>
            ))}
          </div>
        </Popout>
      )}
      {colorPop.anchor && (
        <Popout anchor={colorPop.anchor} side="top-start" onClose={colorPop.close} className="format-popout" gap={6}>
          <div className="format-colors">
            <div className="format-swatches">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c}
                  className={`format-swatch ${state?.color === c ? 'on' : ''}`}
                  style={{ background: c }}
                  aria-label={c}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    setColor(c);
                    colorPop.close();
                  }}
                />
              ))}
            </div>
            <div className="format-colors-row">
              <label className="format-custom" {...tip('Pick any colour')}>
                <input type="color" value={state?.color ?? '#e0b252'} onChange={(e) => setColor(e.target.value)} aria-label="Custom colour" />
                Custom
              </label>
              <button
                className="format-default"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  setColor(null);
                  colorPop.close();
                }}
              >
                Default
              </button>
            </div>
          </div>
        </Popout>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The input
// ---------------------------------------------------------------------------

function FileTile({ file, onRemove }: { file: File; onRemove: () => void }) {
  const url = useMemo(() => (file.type.startsWith('image/') ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  return (
    <div className="upload-tile">
      <div className="upload-tile-media">{url ? <img src={url} alt="" /> : <Icon path={mdiFileDocumentOutline} size={48} />}</div>
      <div className="upload-tile-name">{file.name}</div>
      <div className="upload-tile-actions">
        <button className="upload-tile-action danger" aria-label="Remove attachment" {...tip('Remove Attachment')} onClick={onRemove}>
          <Icon path={mdiCloseCircle} size={20} />
        </button>
      </div>
    </div>
  );
}

interface Token {
  trigger: '@' | '#' | ':';
  query: string;
  start: number;
  /** Characters between the token start and the caret. */
  length: number;
}

function tokenAtCaret(editor: Editor): Token | null {
  const { selection } = editor.state;
  if (!selection.empty) return null;
  const $from = selection.$from;
  if (!$from.parent.isTextblock) return null;
  const before = $from.parent.textBetween(0, $from.parentOffset, '\n', '\n');
  const t = currentToken(before, before.length);
  return t ? { ...t, length: before.length - t.start } : null;
}

export default function ChatInput({ channel }: { channel: Channel }) {
  const me = useStore((s) => s.me)!;
  const settings = me.settings;
  const perms = useStore((s) => myChannelPerms(s, s.channels[channel.id]));
  const personaId = useStore((s) => personaFor(s, channel.id));
  const chars = useStore(useShallow((s) => myCharacters(s)));
  const narrator = useStore((s) => narratorName(s, channel.server_id));
  const reply = useStore((s) => s.replyTo[channel.id]);
  const replyMsg = useStore((s) => (reply ? s.messages[channel.id]?.list.find((m) => m.id === reply.messageId) : undefined));
  const replyName = useStore((s) => {
    if (!replyMsg) return '';
    if (replyMsg.meta?.narrator) return narratorName(s, channel.server_id);
    const ch = replyMsg.character_id ? s.characters[replyMsg.character_id] : undefined;
    return ch ? ch.name : displayName(s.users[replyMsg.author_id] ?? replyMsg.author);
  });
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const filesRef = useRef(files);
  filesRef.current = files;
  const [token, setToken] = useState<Token | null>(null);
  const [acIndex, setAcIndex] = useState(0);
  const [acDismissed, setAcDismissed] = useState<string | null>(null);
  const [focused, setFocused] = useState(false);
  const [formatMenu, setFormatMenu] = useState(false);
  const mentions = useRef<InsertedMention[]>([]);
  const fileInput = useRef<HTMLInputElement>(null);
  const personaPop = usePopout();
  const emojiPop = usePopout();
  const dicePop = usePopout();

  const canSend = (perms & P.SEND_MESSAGES) !== 0;
  const canAttach = (perms & P.ATTACH_FILES) !== 0;
  const canCharacters = (perms & P.USE_CHARACTERS) !== 0;

  const proxy = settings.switch_proxy && canCharacters ? matchProxy(text, chars) : null;
  const effectivePersona = proxy ? proxy.character.id : personaId;
  const personaChar = effectivePersona > 0 ? chars.find((c) => c.id === effectivePersona) : undefined;
  const asNarrator = !proxy && personaId === NARRATOR;
  const bookOn = useBookLook(channel.id, !!personaChar);
  const myRoleColor = useStore((s) => roleColor(s, channel.server_id, me.id));

  const title = channel.type === ChannelType.TEXT ? (channel.name ?? '') : `@${channelTitle(getState(), channel)}`;
  const placeholder = canSend
    ? `Message ${title}${personaChar ? ` as ${personaChar.name}` : asNarrator ? ` as ${narrator}` : ''}`
    : 'You do not have permission to send messages in this channel.';

  const tokenKey = token ? `${token.trigger}${token.query}@${token.start}` : null;
  const items = useMemo(
    () => (token && tokenKey !== acDismissed ? buildItems(channel, token.trigger, token.query) : []),
    [tokenKey, acDismissed, channel], // eslint-disable-line react-hooks/exhaustive-deps
  );
  useEffect(() => setAcIndex(0), [tokenKey]);

  // The editor's callbacks are created once; they read the latest values from here.
  const live = useRef({ items, acIndex, tokenKey, reply, canCharacters, personaId, chars, settings, send: () => {}, choose: (_: AcItem) => {} });
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;

  const editor = useEditor({
    extensions: [
      StarterKit.configure({
        heading: false,
        blockquote: false,
        bulletList: false,
        orderedList: false,
        listItem: false,
        listKeymap: false,
        codeBlock: false,
        horizontalRule: false,
        link: false,
        dropcursor: false,
        gapcursor: false,
        trailingNode: false,
      }),
      TextStyle,
      Color,
      FontSize,
      TextEffects,
      Placeholder.configure({ placeholder: () => placeholderRef.current }),
    ],
    content: drafts.get(channel.id) ?? '',
    editable: canSend,
    editorProps: {
      attributes: {
        class: 'composer-editor',
        role: 'textbox',
        'aria-multiline': 'true',
        spellcheck: 'true',
      },
      handleKeyDown: (_view, e) => {
        const l = live.current;
        if (l.items.length) {
          if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            setAcIndex((i) => (i + (e.key === 'ArrowDown' ? 1 : -1) + l.items.length) % l.items.length);
            return true;
          }
          if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
            l.choose(l.items[l.acIndex] ?? l.items[0]);
            return true;
          }
          if (e.key === 'Escape') {
            setAcDismissed(l.tokenKey);
            return true;
          }
        }
        if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && l.settings.switch_hotkey && l.canCharacters) {
          cyclePersona(channel.id, e.key === 'ArrowDown' ? 1 : -1);
          return true;
        }
        if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
          if (isTouch()) return false;
          l.send();
          return true;
        }
        if (e.key === 'ArrowUp' && !e.altKey && editorRef.current?.isEmpty) return editLast();
        if (e.key === 'Escape' && l.reply) {
          setState((st) => ({ replyTo: { ...st.replyTo, [channel.id]: undefined } }));
          return true;
        }
        return false;
      },
      handlePaste: (_view, e) => {
        const cd = e.clipboardData;
        if (!cd) return false;
        if (cd.files.length) {
          addFileList(cd.files);
          return true;
        }
        const plain = cd.getData('text/plain');
        if (plain) {
          // Paste as plain text: formatting from web pages doesn't map onto messages.
          editorRef.current?.chain().insertContent(textToContent(plain.replace(/\r\n?/g, '\n'))).scrollIntoView().run();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      const md = docToMarkdown(e.getJSON());
      setText(md);
      setToken(tokenAtCaret(e));
      if (md.trim() && !md.startsWith('/')) {
        const l = live.current;
        const px = l.settings.switch_proxy && l.canCharacters ? matchProxy(md, l.chars) : null;
        const persona = px ? px.character.id : l.personaId;
        sendTyping(channel.id, persona > 0 ? persona : null, persona === NARRATOR);
      }
    },
    onSelectionUpdate: ({ editor: e }) => setToken(tokenAtCaret(e)),
    onFocus: () => setFocused(true),
    // Folding the toolbar away moves the messages above it, so a click that
    // took the focus away must finish first or it would miss what it aimed at.
    onBlur: () => afterPointerRelease(() => setFocused(!!editorRef.current?.isFocused)),
    onCreate: ({ editor: e }) => setText(docToMarkdown(e.getJSON())),
  });
  const editorRef = useRef<Editor | null>(editor);
  editorRef.current = editor;

  // Refresh the placeholder when who we're speaking as changes.
  useEffect(() => {
    if (editor && !editor.isDestroyed) editor.view.dispatch(editor.state.tr.setMeta('addToHistory', false));
  }, [editor, placeholder]);

  useEffect(() => {
    editor?.setEditable(canSend);
  }, [editor, canSend]);

  // Keep the draft when switching channels.
  useEffect(() => {
    const id = channel.id;
    return () => {
      const e = editorRef.current;
      if (!e || e.isDestroyed) return;
      if (e.isEmpty) drafts.delete(id);
      else drafts.set(id, e.getJSON());
    };
  }, [channel.id]);

  useEffect(() => {
    void loadEmojiData();
    const focus = () => editorRef.current?.commands.focus('end');
    const insert = (ev: Event) => {
      const t = (ev as CustomEvent<string>).detail;
      const e = editorRef.current;
      if (!e) return;
      const current = docToMarkdown(e.getJSON());
      e.chain()
        .focus('end')
        .insertContent(current && !current.endsWith(' ') ? ` ${t} ` : `${t} `)
        .run();
    };
    const addFiles = (ev: Event) => addFilesRef.current((ev as CustomEvent<File[]>).detail);
    window.addEventListener('tavern:focus-input', focus);
    window.addEventListener('tavern:insert-text', insert);
    window.addEventListener('tavern:add-files', addFiles);
    // Start typing anywhere to jump into the box, like Discord.
    const onKey = (ev: globalThis.KeyboardEvent) => {
      if (ev.ctrlKey || ev.metaKey || ev.altKey || ev.key.length !== 1) return;
      const t = ev.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable="true"], .modal-root, .settings-layer, .popout, .sheet-layer')) return;
      editorRef.current?.commands.focus('end');
    };
    document.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('tavern:focus-input', focus);
      window.removeEventListener('tavern:insert-text', insert);
      window.removeEventListener('tavern:add-files', addFiles);
      document.removeEventListener('keydown', onKey);
    };
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  function addFileList(list: FileList | File[] | null) {
    if (!list || !canAttach) {
      if (list && !canAttach) toast("You can't upload files in this channel.");
      return;
    }
    const arr = Array.from(list);
    if (!arr.length) return;
    const limitMb = getState().maxUploadMb;
    const total = [...filesRef.current, ...arr].reduce((sum, f) => sum + f.size, 0);
    if (total > limitMb * 1024 * 1024) {
      filesTooPowerful(limitMb);
      return;
    }
    const next = [...filesRef.current, ...arr];
    if (next.length > 10) toast('You can upload up to 10 files at a time.');
    filesRef.current = next.slice(0, 10);
    setFiles(filesRef.current);
    editorRef.current?.commands.focus();
  }
  const addFilesRef = useRef(addFileList);
  addFilesRef.current = addFileList;

  const choose = (item: AcItem) => {
    const e = editorRef.current;
    if (!e || !token) return;
    const pos = e.state.selection.from;
    if (item.mention) mentions.current.push(item.mention);
    e.chain()
      .focus()
      .insertContentAt({ from: pos - token.length, to: pos }, `${item.insert} `)
      .run();
  };

  const clear = () => {
    editorRef.current?.commands.clearContent(true);
    setText('');
    setFiles([]);
    mentions.current = [];
    drafts.delete(channel.id);
  };

  const send = () => {
    const e = editorRef.current;
    if (!e) return;
    const raw = docToMarkdown(e.getJSON()).trim();
    if (!raw && !files.length) return;
    if (raw.length > MAX_LENGTH) {
      toast(`Your message is too long (${raw.length}/${MAX_LENGTH} characters).`);
      return;
    }
    // Dice commands: /roll 1d20+5, /r stealth, /proll ...
    const cmd = !files.length ? parseRollCommand(raw.replace(/​/g, '')) : null;
    if (cmd) {
      if ('error' in cmd) {
        toast(cmd.error);
        return;
      }
      void roll(channel.id, cmd);
      clear();
      resetTyping(channel.id);
      return;
    }
    const s = getState();
    let content = raw;
    let characterId: number | null = personaId > 0 ? personaId : null;
    let narrate = personaId === NARRATOR;
    if (proxy) {
      content = proxy.content;
      characterId = proxy.character.id;
      narrate = false;
    }
    if (!canCharacters) {
      characterId = null;
      narrate = false;
    }
    const serverId = channel.server_id;
    content = encodeMessage(content, {
      mentions: mentions.current,
      members: mentionableUsers(channel),
      channels: linkableChannels(serverId),
      emojis: Object.values(s.emojis).sort((a, b) => Number(b.server_id === serverId) - Number(a.server_id === serverId)),
    });
    sendMessage(channel.id, content, files, characterId, reply, { narrator: narrate, book: narrate || bookLookFor(channel.id, !!characterId) });
    clear();
    setState((st) => ({ replyTo: { ...st.replyTo, [channel.id]: undefined } }));
    resetTyping(channel.id);
    window.dispatchEvent(new CustomEvent('tavern:sent'));
  };

  function editLast(): boolean {
    const s = getState();
    const list = s.messages[channel.id]?.list ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      if (list[i].author_id === me.id && list[i].type === MessageType.DEFAULT) {
        setState({ editing: { channelId: channel.id, messageId: list[i].id } });
        return true;
      }
    }
    return false;
  }

  live.current = { items, acIndex, tokenKey, reply, canCharacters, personaId, chars, settings, send, choose };

  const onPickEmoji = (p: PickedEmoji) => {
    const insert = p.kind === 'custom' ? `:${p.emoji.name}:` : p.emoji;
    editorRef.current?.chain().focus().insertContent(insert).run();
    emojiPop.close();
  };

  const remaining = MAX_LENGTH - text.trim().length;
  const showPersona = settings.switch_picker && canCharacters && canSend;
  const speakerColor = (proxy?.character ?? personaChar)?.color ?? (personaChar ? null : myRoleColor);
  const bookColor = asNarrator ? 'var(--gold)' : speakerColor ? soften(speakerColor, 0.2) : null;
  const showFormat = !!editor && canSend && settings.format_toolbar && (focused || formatMenu);
  const book: BookSwitch | null = canSend ? { on: bookOn || asNarrator, locked: asNarrator, toggle: () => setBookLook(channel.id, !bookOn) } : null;

  let lastSection = '';
  return (
    <div className="chat-form">
      {items.length > 0 && (
        <div className="autocomplete" role="listbox">
          {items.map((item, i) => {
            const header = item.section !== lastSection ? item.section : null;
            lastSection = item.section;
            return (
              <div key={item.key}>
                {header && <div className="ac-section">{header}</div>}
                <button
                  className={`ac-item ${i === acIndex ? 'selected' : ''}`}
                  role="option"
                  aria-selected={i === acIndex}
                  onMouseEnter={() => setAcIndex(i)}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(item);
                  }}
                >
                  <span className="ac-icon">{item.icon}</span>
                  <span className="ac-label">{item.label}</span>
                  {item.sub && <span className="ac-sub">{item.sub}</span>}
                </button>
              </div>
            );
          })}
        </div>
      )}
      {reply && (
        <div className="reply-bar">
          <span className="reply-bar-text">
            Replying to <strong>{replyName || 'a message'}</strong>
          </span>
          <button
            className={`reply-bar-mention ${reply.mention ? 'on' : ''}`}
            onClick={() => setState((st) => ({ replyTo: { ...st.replyTo, [channel.id]: { ...reply, mention: !reply.mention } } }))}
            {...tip(reply.mention ? 'Click to disable pinging the original author.' : 'Click to enable pinging the original author.')}
          >
            @ {reply.mention ? 'ON' : 'OFF'}
          </button>
          <button className="reply-bar-close" aria-label="Cancel reply" onClick={() => setState((st) => ({ replyTo: { ...st.replyTo, [channel.id]: undefined } }))}>
            <Icon path={mdiCloseCircle} size={16} />
          </button>
        </div>
      )}
      <div
        className={`chat-input ${reply ? 'has-reply' : ''} ${!canSend ? 'disabled' : ''} ${showFormat ? 'formatting' : ''} ${
          personaChar || asNarrator ? 'in-character' : ''
        } ${canSend && (bookOn || asNarrator) ? 'book' : ''}`}
        style={bookColor ? ({ '--book-color': bookColor } as React.CSSProperties) : undefined}
      >
        {files.length > 0 && (
          <div className="upload-previews scroller-thin">
            {files.map((f, i) => (
              <FileTile key={`${f.name}${i}${f.size}`} file={f} onRemove={() => setFiles((cur) => cur.filter((_, j) => j !== i))} />
            ))}
          </div>
        )}
        {showFormat && editor && <FormatBar editor={editor} onMenu={setFormatMenu} book={book} />}
        <div className="chat-input-row">
          {canAttach && canSend && (
            <button className="input-button upload" aria-label="Upload a file" {...tip('Upload a File')} onClick={() => fileInput.current?.click()}>
              <Icon path={mdiPlusCircle} size={24} />
            </button>
          )}
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              addFileList(e.target.files);
              e.target.value = '';
            }}
          />
          {showPersona && (
            <button
              className={`persona-button ${proxy ? 'proxied' : ''} ${personaPop.isOpen ? 'open' : ''} ${asNarrator ? 'narrator' : ''}`}
              onClick={personaPop.toggle}
              aria-label="Choose who to speak as"
              {...tip(
                proxy
                  ? `Proxy tag: sending as ${proxy.character.name}`
                  : `Speaking as ${personaChar ? personaChar.name : asNarrator ? narrator : displayName(me)}${chars.length ? '' : ' (make a character in Settings)'}`,
              )}
            >
              {asNarrator ? <NarratorBadge size={24} /> : <img src={personaChar ? characterAvatar(personaChar) : userAvatar(me)} alt="" />}
              <Icon path={mdiMenuDown} size={16} className="persona-caret" />
            </button>
          )}
          {canSend && !asNarrator && !settings.format_toolbar && (
            <button
              className={`input-button book-toggle ${bookOn ? 'on' : ''}`}
              aria-label="Book look"
              aria-pressed={bookOn}
              {...tip(bookOn ? 'Book look is on: "speech" in white, the rest as italic action. Everyone sees it.' : 'Book look is off. Click to write like a story.')}
              onMouseDown={keepFocus}
              onClick={() => setBookLook(channel.id, !bookOn)}
            >
              <Icon path={bookOn ? mdiBookOpenPageVariant : mdiBookOpenPageVariantOutline} size={22} />
            </button>
          )}
          <div className="chat-textarea" style={personaChar?.color ? ({ '--persona-color': personaChar.color } as React.CSSProperties) : undefined}>
            <EditorContent editor={editor} aria-label={placeholder} />
          </div>
          {canSend && (
            <div className="input-buttons">
              <button className={`input-button dice ${dicePop.isOpen ? 'active' : ''}`} aria-label="Roll dice" onClick={dicePop.toggle} {...tip('Roll Dice')}>
                <Icon path={mdiDiceD20} size={24} />
              </button>
              <button className={`input-button emoji ${emojiPop.isOpen ? 'active' : ''}`} aria-label="Select emoji" onClick={emojiPop.toggle} {...tip('Select Emoji')}>
                <Icon path={mdiEmoticonHappy} size={24} />
              </button>
              <button className="input-button send" aria-label="Send" onClick={send} disabled={!text.trim() && !files.length}>
                <Icon path={mdiSend} size={22} />
              </button>
            </div>
          )}
        </div>
        {remaining < 300 && <div className={`char-count ${remaining < 0 ? 'over' : ''}`}>{remaining}</div>}
      </div>
      <TypingIndicator channelId={channel.id} />
      {personaPop.anchor && (
        <Popout anchor={personaPop.anchor} side="top-start" onClose={personaPop.close} className="persona-popout" gap={12}>
          <PersonaPicker channelId={channel.id} current={personaId} chars={chars} onDone={personaPop.close} />
        </Popout>
      )}
      {emojiPop.anchor && (
        <Popout anchor={emojiPop.anchor} side="top-end" onClose={emojiPop.close} className="emoji-popout" gap={16}>
          <EmojiPicker serverId={channel.server_id} onPick={onPickEmoji} onClose={emojiPop.close} />
        </Popout>
      )}
      {dicePop.anchor && (
        <Popout anchor={dicePop.anchor} side="top-end" onClose={dicePop.close} className="dice-popout" gap={16}>
          <DiceTray channelId={channel.id} onClose={dicePop.close} />
        </Popout>
      )}
    </div>
  );
}
