import { memo, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { characterAvatar, emojiUrl, userAvatar } from '../lib/avatars';
import { decodeForEdit, encodeMessage, type InsertedMention } from '../lib/compose';
import { emojiShortcode, frequentEmoji, isEmojiOnly, recordEmojiUse, emojiByChar } from '../lib/emoji';
import { formatBytes, formatFull, formatTime, formatTimestamp, hexAlpha, mixHex, readableOn, soften } from '../lib/format';
import { EmojiImg, parseMarkdown, plainText, renderNodes, storeLookups } from '../lib/markdown';
import { P } from '../lib/permissions';
import {
  addReaction,
  channelPath,
  deleteMessage,
  discardPending,
  editMessage,
  jumpToMessage,
  openContextMenu,
  openModal,
  setPinned,
  suppressEmbeds,
  toggleReaction,
} from '../store/actions';
import { displayName, myChannelPerms, narratorName, roleColor } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Attachment, Embed, Message, PendingMessage, ReactionEmoji, ReactionGroup, ReplyRef, User } from '../store/types';
import { MessageType } from '../store/types';
import EmojiPicker, { type PickedEmoji } from './EmojiPicker';
import {
  Icon,
  mdiArrowLeft,
  mdiArrowRight,
  mdiClose,
  mdiDelete,
  mdiDotsHorizontal,
  mdiDownload,
  mdiEmoticonPlus,
  mdiEyeOff,
  mdiFileDocumentOutline,
  mdiPencil,
  mdiPin,
  mdiPlay,
  mdiReply,
  mdiStarFourPoints,
} from './icons';
import { MenuItem, MenuSeparator, Modal, Popout, tip, usePopout } from './layers';
import { openCharacterProfile, openUserProfile, userMenu } from './Profiles';
import RollView from './RollView';
import VideoPlayer from './VideoPlayer';
import { useMarkdownCtx } from './useMarkdownCtx';
import { Button } from './ui';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function fitSize(w: number | null, h: number | null, maxW = 550, maxH = 350): { width?: number; height?: number } {
  if (!w || !h) return {};
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.round(w * scale), height: Math.round(h * scale) };
}

const isImage = (a: Attachment) => /^image\/(png|jpeg|gif|webp|avif|bmp)$/.test(a.content_type);
const isVideo = (a: Attachment) => /^video\/(mp4|webm|quicktime|ogg)$/.test(a.content_type);
const isAudio = (a: Attachment) => a.content_type.startsWith('audio/');

function reactionKey(e: ReactionEmoji) {
  return e.id ? `c${e.id}` : e.name;
}

export function openImageViewer(src: string, alt: string, original?: string) {
  openModal((close) => (
    <div className="image-viewer" onMouseDown={(e) => e.target === e.currentTarget && close()}>
      <img src={src} alt={alt} />
      <a className="image-viewer-link" href={original ?? src} target="_blank" rel="noreferrer noopener">
        Open in Browser
      </a>
    </div>
  ));
}

/**
 * The parts of a user a message shows. Watching just these (not the whole
 * user) means someone going idle or changing their status doesn't re-render
 * every message they've sent.
 */
function shownUser(u: User | undefined): Pick<User, 'id' | 'username' | 'display_name' | 'avatar'> | undefined {
  return u ? { id: u.id, username: u.username, display_name: u.display_name, avatar: u.avatar } : undefined;
}

// ---------------------------------------------------------------------------
// Context menu
// ---------------------------------------------------------------------------

function startReply(m: Message) {
  setState((s) => ({ replyTo: { ...s.replyTo, [m.channel_id]: { messageId: m.id, mention: true } } }));
  window.dispatchEvent(new CustomEvent('tavern:focus-input'));
}

function startEdit(m: Message) {
  setState({ editing: { channelId: m.channel_id, messageId: m.id } });
}

export function confirmDelete(m: Message) {
  openModal((close) => (
    <Modal
      title="Delete Message"
      onClose={close}
      footer={
        <>
          <Button look="link" onClick={close}>
            Cancel
          </Button>
          <Button
            look="danger"
            onClick={() => {
              close();
              void deleteMessage(m);
            }}
          >
            Delete
          </Button>
        </>
      }
    >
      <p className="modal-text">Are you sure you want to delete this message?</p>
      <div className="message-preview-box">
        <MessageItem message={m} groupStart preview />
      </div>
      <p className="modal-tip">
        <strong>Protip:</strong> hold Shift while clicking Delete Message to skip this.
      </p>
    </Modal>
  ));
}

export function messageMenu(m: Message) {
  const s = getState();
  const channel = s.channels[m.channel_id];
  const perms = myChannelPerms(s, channel);
  const mine = m.author_id === s.me?.id;
  const canManage = !!channel?.server_id && (perms & P.MANAGE_MESSAGES) !== 0;
  const canPin = (perms & (P.PIN_MESSAGES | P.MANAGE_MESSAGES)) !== 0;
  const isDefault = m.type === MessageType.DEFAULT;
  const isUser = isDefault || m.type === MessageType.ROLL;
  const quick = frequentEmoji(4);
  return (
    <>
      {isUser && (
        <div className="menu-reactions">
          {quick.map((q) =>
            q.startsWith('c:') ? null : (
              <button key={q} className="menu-reaction" onClick={() => addReaction(m, { id: null, name: q, animated: false })} {...tip(emojiShortcode(q))}>
                <EmojiImg emoji={q} />
              </button>
            ),
          )}
        </div>
      )}
      {isDefault && mine && <MenuItem label="Edit Message" icon={mdiPencil} onClick={() => startEdit(m)} />}
      {isUser && (perms & P.SEND_MESSAGES) !== 0 && <MenuItem label="Reply" icon={mdiReply} onClick={() => startReply(m)} />}
      {isUser && canPin && !m.dm_only && <MenuItem label={m.pinned ? 'Unpin Message' : 'Pin Message'} icon={mdiPin} onClick={() => setPinned(m, !m.pinned)} />}
      {m.content && <MenuItem label={isDefault ? 'Copy Text' : 'Copy Result'} onClick={() => void navigator.clipboard?.writeText(m.content)} />}
      {isDefault && m.embeds.length > 0 && (mine || canManage) && <MenuItem label="Remove Embeds" onClick={() => suppressEmbeds(m)} />}
      {(mine || canManage) && (
        <>
          <MenuSeparator />
          {/* Shift is read when Delete is clicked (holding it while opening the menu doesn't count). */}
          <MenuItem label="Delete Message" danger icon={mdiDelete} onClick={(ev) => (ev.shiftKey ? void deleteMessage(m) : confirmDelete(m))} />
        </>
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

function ReplyPreview({ reply, channelId, serverId }: { reply: ReplyRef; channelId: number; serverId: number | null }) {
  const author = useStore(useShallow((s) => (reply.author_id ? shownUser(s.users[reply.author_id]) : undefined))) ?? reply.author ?? null;
  const ch = useStore((s) => (reply.character_id ? s.characters[reply.character_id] : undefined)) ?? (reply.character_id ? (reply.character ?? null) : null);
  const immersive = useStore((s) => s.me!.settings.immersive);
  const color = useStore((s) => (ch || !reply.author_id ? undefined : roleColor(s, serverId, reply.author_id)));
  // The quoted text with mentions spelled out: a string, so it only re-renders when it reads differently.
  const text = useStore((s) => (reply.content ? plainText(reply.content, storeLookups(s)) : ''));
  const nodes = useMemo(() => (text ? parseMarkdown(text.replace(/\n/g, ' ')) : null), [text]);
  const ctx = useMarkdownCtx(serverId);
  if (reply.deleted || !reply.author_id) {
    return (
      <div className="reply-preview">
        <span className="reply-spine" />
        <span className="reply-deleted-icon">
          <Icon path={mdiReply} size={12} />
        </span>
        <span className="reply-content deleted">Original message was deleted</span>
      </div>
    );
  }
  const name = ch ? ch.name : displayName(author);
  const avatar = ch ? characterAvatar(ch) : userAvatar(author ?? { id: reply.author_id, avatar: null });
  return (
    <div className="reply-preview">
      <span className="reply-spine" />
      <img className="reply-avatar" src={avatar} alt="" />
      <span
        className="reply-name"
        style={{ color }}
        onClick={(e) =>
          ch ? openCharacterProfile(e.currentTarget.getBoundingClientRect(), ch.id, serverId) : openUserProfile(e.currentTarget.getBoundingClientRect(), reply.author_id!, serverId)
        }
      >
        @{name}
      </span>
      {ch && !immersive && author && <span className="reply-player">({displayName(author)})</span>}
      <span className="reply-content" onClick={() => jumpToMessage(channelId, reply.id)} role="button">
        {nodes ? (
          renderNodes(nodes, { ...ctx, onUser: undefined, onCharacter: undefined })
        ) : (
          <em className="reply-attachment">Click to see attachment</em>
        )}
      </span>
      {!text && reply.has_attachments && <Icon path={mdiFileDocumentOutline} size={16} className="reply-attachment-icon" />}
    </div>
  );
}

function MediaAttachment({ a, maxW = 550, maxH = 350, grid }: { a: Attachment; maxW?: number; maxH?: number; grid?: boolean }) {
  const size = grid ? {} : fitSize(a.width, a.height, maxW, maxH);
  if (isVideo(a)) {
    if (!grid) return <VideoPlayer src={a.url} width={a.width} height={a.height} maxW={maxW} maxH={maxH} filename={a.filename} />;
    return (
      <div className="attachment-media video">
        <VideoPlayer src={a.url} width={a.width} height={a.height} fill filename={a.filename} />
      </div>
    );
  }
  return (
    <a
      className="attachment-media"
      href={a.url}
      onClick={(e) => {
        e.preventDefault();
        openImageViewer(a.url, a.filename);
      }}
      style={size.width ? { width: size.width, height: size.height } : undefined}
    >
      {/* Big images come as a chat-sized preview; clicking opens the original. */}
      <img
        src={a.preview_url ?? a.url}
        alt={a.filename}
        loading="lazy"
        decoding="async"
        style={size.width ? { width: size.width, height: size.height } : { maxWidth: maxW, maxHeight: maxH }}
      />
    </a>
  );
}

function FileCard({ a }: { a: Attachment }) {
  return (
    <div className={`file-card ${isAudio(a) ? 'audio' : ''}`}>
      <div className="file-card-row">
        <Icon path={mdiFileDocumentOutline} size={30} className="file-card-icon" />
        <div className="file-card-info">
          <a className="file-card-name" href={a.url} target="_blank" rel="noreferrer noopener" download={a.filename}>
            {a.filename}
          </a>
          <div className="file-card-size">{formatBytes(a.size)}</div>
        </div>
        <a className="file-card-download" href={a.url} download={a.filename} aria-label="Download" {...tip('Download')}>
          <Icon path={mdiDownload} size={24} />
        </a>
      </div>
      {isAudio(a) && <audio src={a.url} controls preload="metadata" />}
    </div>
  );
}

function Attachments({ list }: { list: Attachment[] }) {
  const media = list.filter((a) => isImage(a) || isVideo(a));
  const files = list.filter((a) => !isImage(a) && !isVideo(a));
  return (
    <>
      {media.length === 1 && <MediaAttachment a={media[0]} />}
      {media.length > 1 && (
        <div className={`media-grid count-${Math.min(media.length, 4)}`}>
          {media.map((a) => (
            <MediaAttachment key={a.id} a={a} grid />
          ))}
        </div>
      )}
      {files.map((a) => (
        <FileCard key={a.id} a={a} />
      ))}
    </>
  );
}

function YouTube({ e }: { e: Embed }) {
  const [playing, setPlaying] = useState(false);
  if (!e.video || !e.thumbnail) return null;
  return (
    <div className="embed-video">
      {playing ? (
        <iframe
          src={e.video.url}
          title={e.title ?? 'YouTube video'}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
          referrerPolicy="strict-origin-when-cross-origin"
        />
      ) : (
        <button className="embed-video-thumb" onClick={() => setPlaying(true)} aria-label="Play video">
          <img src={e.thumbnail.url} alt="" loading="lazy" />
          <span className="embed-play">
            <Icon path={mdiPlay} size={28} />
          </span>
        </button>
      )}
    </div>
  );
}

function EmbedView({ e, onRemove }: { e: Embed; onRemove?: () => void }) {
  if (e.type === 'image' && e.thumbnail) {
    const size = fitSize(e.thumbnail.width, e.thumbnail.height, 400, 300);
    return (
      <a
        className="attachment-media embed-image-only"
        href={e.url}
        onClick={(ev) => {
          ev.preventDefault();
          openImageViewer(e.thumbnail!.url, '', e.url);
        }}
      >
        <img src={e.thumbnail.url} alt="" loading="lazy" style={size.width ? size : { maxWidth: 400, maxHeight: 300 }} referrerPolicy="no-referrer" />
      </a>
    );
  }
  if (e.type === 'gifv' && e.video) {
    const size = fitSize(e.video.width, e.video.height, 400, 300);
    return <video className="embed-gifv" src={e.video.url} autoPlay loop muted playsInline style={size.width ? size : { maxWidth: 400 }} />;
  }
  if (e.type === 'video' && !e.provider && e.video) {
    return <VideoPlayer src={e.video.url} width={e.video.width} height={e.video.height} maxW={400} maxH={300} />;
  }
  const color = e.color !== null && e.color !== undefined ? `#${e.color.toString(16).padStart(6, '0')}` : undefined;
  const youtube = e.provider === 'youtube';
  return (
    <article className={`embed ${youtube ? 'embed-youtube' : ''}`} style={{ borderLeftColor: color }}>
      <div className="embed-body">
        {e.site_name && <div className="embed-provider">{e.site_name}</div>}
        {e.title && (
          <a className="embed-title" href={e.url} target="_blank" rel="noreferrer noopener">
            {e.title}
          </a>
        )}
        {e.description && !youtube && <div className="embed-description">{e.description}</div>}
        {youtube && <YouTube e={e} />}
        {!youtube && e.image && (
          <a
            className="embed-image"
            href={e.image.url}
            onClick={(ev) => {
              ev.preventDefault();
              openImageViewer(e.image!.url, '', e.url);
            }}
          >
            <img src={e.image.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </a>
        )}
      </div>
      {!youtube && e.thumbnail && (
        <img className="embed-thumbnail" src={e.thumbnail.url} alt="" loading="lazy" referrerPolicy="no-referrer" />
      )}
      {onRemove && (
        <button className="embed-remove" onClick={onRemove} aria-label="Remove embed" {...tip('Remove all embeds')}>
          <Icon path={mdiClose} size={16} />
        </button>
      )}
    </article>
  );
}

function reactionTooltip(r: ReactionGroup): ReactNode {
  const s = getState();
  const names = r.user_ids.slice(0, 3).map((id) => (id === s.me?.id ? 'You' : displayName(s.users[id])));
  const more = r.count - names.length;
  const who = more > 0 ? `${names.join(', ')} and ${more} ${more === 1 ? 'other' : 'others'}` : names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}` : names[0];
  const label = r.emoji.id ? `:${r.emoji.name}:` : emojiShortcode(r.emoji.name);
  return (
    <div className="reaction-tooltip">
      {r.emoji.id ? <img className="emoji" src={emojiUrl(r.emoji.id)} alt="" /> : <EmojiImg emoji={r.emoji.name} />}
      <span>
        <strong>{who}</strong> reacted with {label}
      </span>
    </div>
  );
}

function ReactionEmojiImg({ e }: { e: ReactionEmoji }) {
  return e.id ? <img className="emoji" src={emojiUrl(e.id)} alt={`:${e.name}:`} draggable={false} /> : <EmojiImg emoji={e.name} />;
}

function Reactions({ m, canReact, onAdd }: { m: Message; canReact: boolean; onAdd: (rect: DOMRect) => void }) {
  const me = useStore((s) => s.me!.id);
  return (
    <div className="reactions">
      {m.reactions.map((r) => (
        <button
          key={reactionKey(r.emoji)}
          className={`reaction ${r.user_ids.includes(me) ? 'me' : ''}`}
          onClick={() => toggleReaction(m, r.emoji)}
          {...tip(reactionTooltip(r))}
        >
          <ReactionEmojiImg e={r.emoji} />
          <span className="reaction-count">{r.count}</span>
        </button>
      ))}
      {canReact && (
        <button className="reaction reaction-add" aria-label="Add Reaction" {...tip('Add Reaction')} onClick={(e) => onAdd(e.currentTarget.getBoundingClientRect())}>
          <Icon path={mdiEmoticonPlus} size={18} />
        </button>
      )}
    </div>
  );
}

function EditBox({ m }: { m: Message }) {
  const users = useStore((s) => s.users);
  const characters = useStore((s) => s.characters);
  const channels = useStore((s) => s.channels);
  const emojis = useStore((s) => s.emojis);
  const members = useStore((s) => s.members);
  const initial = useMemo(() => decodeForEdit(m.content, { users, characters, channels }), []); // eslint-disable-line react-hooks/exhaustive-deps
  const [text, setText] = useState(initial.text);
  const mentions = useRef<InsertedMention[]>(initial.mentions);
  const area = useRef<HTMLTextAreaElement>(null);

  const cancel = () => setState({ editing: null });
  const save = () => {
    const serverId = channels[m.channel_id]?.server_id;
    const memberUsers = serverId ? Object.keys(members[serverId] ?? {}).map((id) => users[Number(id)]).filter(Boolean) : Object.values(users);
    const content = encodeMessage(text.trim(), {
      mentions: mentions.current,
      members: memberUsers,
      channels: Object.values(channels).filter((c) => c.server_id === serverId),
      emojis: Object.values(emojis).sort((a, b) => Number(b.server_id === serverId) - Number(a.server_id === serverId)),
    });
    setState({ editing: null });
    if (!content && !m.attachments.length) {
      confirmDelete(m);
      return;
    }
    if (content !== m.content) void editMessage(m, content);
  };
  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    } else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      save();
    }
  };
  return (
    <div className="edit-box">
      <div className="edit-input">
        <textarea
          ref={(el) => {
            area.current = el;
            if (el && !el.dataset.init) {
              el.dataset.init = '1';
              el.focus();
              el.setSelectionRange(el.value.length, el.value.length);
            }
          }}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          rows={Math.min(12, text.split('\n').length)}
        />
      </div>
      <div className="edit-hint">
        escape to{' '}
        <button className="link-button" onClick={cancel}>
          cancel
        </button>{' '}
        • enter to{' '}
        <button className="link-button" onClick={save}>
          save
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Puppeteer tag: who's playing this character
// ---------------------------------------------------------------------------

function PlayerTag({ userId, serverId }: { userId: number; serverId: number | null }) {
  const user = useStore((s) => s.users[userId]);
  const color = useStore((s) => roleColor(s, serverId, userId));
  if (!user) return null;
  return (
    <span
      className="player-tag"
      role="button"
      {...tip(`Played by ${displayName(user)}`)}
      onClick={(e) => openUserProfile(e.currentTarget.getBoundingClientRect(), userId, serverId)}
    >
      <img src={userAvatar(user)} alt="" />
      <span style={{ color }}>{displayName(user)}</span>
    </span>
  );
}

// ---------------------------------------------------------------------------
// System messages
// ---------------------------------------------------------------------------

function NameLink({ userId, serverId }: { userId: number; serverId: number | null }) {
  const user = useStore((s) => s.users[userId]);
  const color = useStore((s) => roleColor(s, serverId, userId));
  return (
    <span className="system-name" style={{ color }} onClick={(e) => openUserProfile(e.currentTarget.getBoundingClientRect(), userId, serverId)} role="button">
      {displayName(user)}
    </span>
  );
}

function SystemMessage({ m, serverId }: { m: Message; serverId: number | null }) {
  const actor = <NameLink userId={m.author_id} serverId={serverId} />;
  let icon = mdiArrowRight;
  let iconClass = 'join';
  let body: ReactNode = null;
  switch (m.type) {
    case MessageType.MEMBER_JOIN: {
      const [before, after] = (m.content || '{} joined.').split('{}');
      body = (
        <>
          {before}
          {actor}
          {after}
        </>
      );
      break;
    }
    case MessageType.CHANNEL_PINNED_MESSAGE: {
      icon = mdiPin;
      iconClass = 'pin';
      const target = Number((m.meta as { message_id?: number } | null)?.message_id);
      body = (
        <>
          {actor} pinned{' '}
          <button className="system-link" onClick={() => target && jumpToMessage(m.channel_id, target)}>
            a message
          </button>{' '}
          to this channel. See all{' '}
          <button className="system-link" onClick={() => window.dispatchEvent(new CustomEvent('tavern:open-pins'))}>
            pinned messages
          </button>
          .
        </>
      );
      break;
    }
    case MessageType.RECIPIENT_ADD: {
      const target = Number((m.meta as { user_id?: number } | null)?.user_id);
      body = (
        <>
          {actor} added <NameLink userId={target} serverId={null} /> to the group.
        </>
      );
      break;
    }
    case MessageType.RECIPIENT_REMOVE: {
      icon = mdiArrowLeft;
      iconClass = 'leave';
      const target = Number((m.meta as { user_id?: number } | null)?.user_id);
      body =
        target === m.author_id ? (
          <>{actor} left the group.</>
        ) : (
          <>
            {actor} removed <NameLink userId={target} serverId={null} /> from the group.
          </>
        );
      break;
    }
    case MessageType.CHANNEL_NAME_CHANGE:
      icon = mdiPencil;
      iconClass = 'edit';
      body = (
        <>
          {actor} changed the channel name: <strong className="system-strong">{m.content || '(no name)'}</strong>
        </>
      );
      break;
    default:
      body = <>{actor} did something.</>;
  }
  return (
    <div className="message system group-start" id={`msg-${m.id}`}>
      <div className="message-contents">
        <span className={`system-icon ${iconClass}`}>
          <Icon path={icon} size={16} />
        </span>
        <div className="system-body">
          {body}
          <time className="message-timestamp" title={formatFull(m.created_at)}>
            {formatTimestamp(m.created_at)}
          </time>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// In-character colours
// ---------------------------------------------------------------------------

const MESSAGE_BG = '#101828';

/**
 * CSS variables for the book look in someone's colour: the name in the colour,
 * actions in a darker shade of it (still readable), a faint tint and an edge
 * for the text box. Colours are calmed a little so nothing looks neon.
 */
export function bookVars(color: string | null | undefined): CSSProperties | undefined {
  if (!color) return undefined;
  const calm = soften(color, 0.2);
  const name = readableOn(calm, MESSAGE_BG, 5.5);
  const action = readableOn(mixHex(name, MESSAGE_BG, 0.24), MESSAGE_BG, 4.2);
  return {
    '--ic-color': calm,
    '--ic-name': name,
    '--ic-action': action,
    '--ic-edge': hexAlpha(calm, 0.7),
    '--ic-tint': hexAlpha(calm, 0.065),
    '--ic-tint-hover': hexAlpha(calm, 0.095),
  } as CSSProperties;
}

function NarratorAvatar({ small }: { small?: boolean }) {
  return (
    <span className={`message-avatar narrator-avatar ${small ? 'small' : ''}`} aria-hidden>
      <Icon path={mdiStarFourPoints} size={small ? 14 : 22} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// The message itself
// ---------------------------------------------------------------------------

export interface MessageItemProps {
  message: Message;
  groupStart: boolean;
  highlight?: boolean;
  preview?: boolean;
}

export const MessageItem = memo(function MessageItem({ message: m, groupStart, highlight, preview }: MessageItemProps) {
  // Only the bits of you a message shows: other settings changing leaves it alone.
  const meId = useStore((s) => s.me!.id);
  const immersive = useStore((s) => s.me!.settings.immersive);
  const serif = useStore((s) => !!s.me!.settings.ic_serif);
  const author = useStore(useShallow((s) => shownUser(s.users[m.author_id]))) ?? m.author;
  const character = useStore((s) => (m.character_id ? s.characters[m.character_id] : undefined)) ?? m.character;
  const serverId = useStore((s) => s.channels[m.channel_id]?.server_id ?? null);
  const myRole = useStore((s) => (character || m.meta?.narrator ? undefined : roleColor(s, serverId, m.author_id)));
  const editing = useStore((s) => !preview && s.editing?.messageId === m.id);
  const perms = useStore((s) => myChannelPerms(s, s.channels[m.channel_id]));
  const ctx = useMarkdownCtx(serverId);
  const picker = usePopout();
  const [toolbarPinned, setToolbarPinned] = useState(false);

  const narrator = !!m.meta?.narrator;
  const narratorLabel = useStore((s) => (narrator ? narratorName(s, serverId) : ''));
  const jumbo = useMemo(() => isEmojiOnly(m.content), [m.content]);
  const nodes = useMemo(() => parseMarkdown(m.content), [m.content]);
  const ic = !!character || narrator;
  // Book look: the sender's choice (narration always has it).
  const book = narrator || !!m.book;
  const nameColor = book ? undefined : myRole;

  if (m.type !== MessageType.DEFAULT && m.type !== MessageType.ROLL) return <SystemMessage m={m} serverId={serverId} />;

  const isRoll = m.type === MessageType.ROLL;
  const mine = m.author_id === meId;
  const mentioned = !mine && (m.mention_everyone || m.mentions.includes(meId));
  const name = narrator ? narratorLabel : character ? character.name : displayName(author);
  const avatar = character ? characterAvatar(character) : userAvatar(author ?? { id: m.author_id, avatar: null });
  const canReact = (perms & P.ADD_REACTIONS) !== 0;
  const canReply = (perms & P.SEND_MESSAGES) !== 0;
  const canDelete = mine || (serverId !== null && (perms & P.MANAGE_MESSAGES) !== 0);

  const openProfile = (e: MouseEvent) => {
    if (narrator) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    if (character) openCharacterProfile(rect, character.id, serverId);
    else openUserProfile(rect, m.author_id, serverId);
  };
  const onNameContext = (e: MouseEvent) => {
    if (character || narrator) return;
    e.stopPropagation();
    openContextMenu(e, () => userMenu(m.author_id, serverId));
  };

  const pickReaction = (p: PickedEmoji) => {
    picker.close();
    setToolbarPinned(false);
    if (p.kind === 'custom') addReaction(m, { id: p.emoji.id, name: p.emoji.name, animated: p.emoji.animated });
    else addReaction(m, { id: null, name: p.emoji, animated: false });
  };
  const openPicker = (rect: DOMRect) => {
    setToolbarPinned(true);
    picker.open(rect);
  };

  const quick = frequentEmoji(3).filter((q) => !q.startsWith('c:'));

  return (
    <div
      id={preview ? undefined : `msg-${m.id}`}
      className={`message ${groupStart ? 'group-start' : ''} ${mentioned ? 'mentioned' : ''} ${highlight ? 'highlight' : ''} ${editing ? 'editing' : ''} ${
        toolbarPinned ? 'toolbar-open' : ''
      } ${m.reply_to ? 'has-reply' : ''} ${ic ? 'ic' : ''} ${book ? 'book' : ''} ${narrator ? 'narration' : ''} ${book && serif ? 'serif' : ''} ${
        isRoll ? 'roll-message' : ''
      } ${m.dm_only ? 'dm-only' : ''}`}
      style={book && !narrator ? bookVars(character ? character.color : myRole) : undefined}
      onContextMenu={preview ? undefined : (e) => openContextMenu(e, () => messageMenu(m))}
    >
      {m.reply_to && groupStart && <ReplyPreview reply={m.reply_to} channelId={m.channel_id} serverId={serverId} />}
      <div className="message-contents">
        {groupStart ? (
          narrator ? (
            <NarratorAvatar />
          ) : (
            <img className="message-avatar" src={avatar} alt="" onClick={openProfile} onContextMenu={onNameContext} draggable={false} />
          )
        ) : (
          <time className="message-gutter-time" title={formatFull(m.created_at)}>
            {formatTime(m.created_at)}
          </time>
        )}
        {groupStart && (
          <h3 className="message-header">
            <span className="message-name" style={{ color: nameColor }} onClick={openProfile} onContextMenu={onNameContext} role={narrator ? undefined : 'button'}>
              {name}
            </span>
            {ic && !immersive && <PlayerTag userId={m.author_id} serverId={serverId} />}
            <time className="message-timestamp" title={formatFull(m.created_at)}>
              {formatTimestamp(m.created_at)}
            </time>
          </h3>
        )}
        {editing ? (
          <EditBox m={m} />
        ) : isRoll ? (
          <RollView message={m} />
        ) : (
          m.content && (
            <div className={`message-body markup ${jumbo ? 'jumbo' : ''}`}>
              {renderNodes(nodes, { ...ctx, jumbo, messageId: m.id, rp: book && !jumbo ? { inQuote: false } : undefined })}
              {m.edited_at && (
                <span className="edited" title={formatFull(m.edited_at)}>
                  {' '}
                  (edited)
                </span>
              )}
            </div>
          )
        )}
        {m.dm_only && (
          <div className="dm-only-note">
            <Icon path={mdiEyeOff} size={14} />
            Only you and the Dungeon Masters can see this.
          </div>
        )}
      </div>
      {(m.attachments.length > 0 || m.embeds.length > 0 || m.reactions.length > 0) && (
        <div className="message-accessories">
          {m.attachments.length > 0 && <Attachments list={m.attachments} />}
          {m.embeds.map((e, i) => (
            <EmbedView key={i} e={e} onRemove={!preview && (mine || (perms & P.MANAGE_MESSAGES) !== 0) ? () => suppressEmbeds(m) : undefined} />
          ))}
          {m.reactions.length > 0 && !preview && <Reactions m={m} canReact={canReact} onAdd={openPicker} />}
        </div>
      )}
      {!preview && !editing && (
        <div className="message-toolbar" role="toolbar">
          {canReact &&
            quick.map((q) => (
              <button
                key={q}
                className="toolbar-button"
                onClick={() => {
                  recordEmojiUse(q);
                  addReaction(m, { id: null, name: q, animated: false });
                }}
                aria-label={`React with ${emojiShortcode(q)}`}
                {...tip(emojiByChar(q) ? emojiShortcode(q) : q)}
              >
                <EmojiImg emoji={q} />
              </button>
            ))}
          {canReact && <span className="toolbar-sep" />}
          {canReact && (
            <button className="toolbar-button" aria-label="Add Reaction" {...tip('Add Reaction')} onClick={(e) => openPicker(e.currentTarget.getBoundingClientRect())}>
              <Icon path={mdiEmoticonPlus} size={20} />
            </button>
          )}
          {canReply && (
            <button className="toolbar-button" aria-label="Reply" {...tip('Reply')} onClick={() => startReply(m)}>
              <Icon path={mdiReply} size={20} />
            </button>
          )}
          {mine && !isRoll && (
            <button className="toolbar-button" aria-label="Edit" {...tip('Edit')} onClick={() => startEdit(m)}>
              <Icon path={mdiPencil} size={20} />
            </button>
          )}
          {/* Only shows while Shift is held (see lib/shiftKey): one click deletes, no questions. */}
          {canDelete && (
            <button
              className="toolbar-button danger shift-only"
              aria-label="Delete"
              {...tip('Delete')}
              onClick={(e) => (e.shiftKey ? void deleteMessage(m) : confirmDelete(m))}
            >
              <Icon path={mdiDelete} size={20} />
            </button>
          )}
          <button
            className="toolbar-button"
            aria-label="More"
            {...tip('More')}
            onClick={(e) => {
              const r = e.currentTarget.getBoundingClientRect();
              openContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, () => messageMenu(m));
            }}
          >
            <Icon path={mdiDotsHorizontal} size={20} />
          </button>
        </div>
      )}
      {picker.anchor && (
        <Popout
          anchor={picker.anchor}
          side="left"
          onClose={() => {
            picker.close();
            setToolbarPinned(false);
          }}
          className="emoji-popout"
        >
          <EmojiPicker serverId={serverId} onPick={pickReaction} />
        </Popout>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// Messages still being sent
// ---------------------------------------------------------------------------

export function PendingItem({ p, groupStart }: { p: PendingMessage; groupStart: boolean }) {
  const me = useStore((s) => s.me!);
  const character = useStore((s) => (p.character_id ? s.characters[p.character_id] : undefined));
  const serverId = useStore((s) => s.channels[p.channel_id]?.server_id ?? null);
  const myRole = useStore((s) => (character || p.narrator ? undefined : roleColor(s, serverId, me.id)));
  const ctx = useMarkdownCtx(serverId);
  const nodes = useMemo(() => parseMarkdown(p.content), [p.content]);
  const narrator = !!p.narrator;
  const narratorLabel = useStore((s) => narratorName(s, serverId));
  const ic = !!character || narrator;
  const book = narrator || !!p.book;
  const nameColor = book ? undefined : myRole;
  const name = narrator ? narratorLabel : character ? character.name : displayName(me);
  const avatar = character ? characterAvatar(character) : userAvatar(me);
  const uploading = p.files.length > 0 && !p.error;
  const settings = me.settings;
  return (
    <div
      className={`message pending ${groupStart ? 'group-start' : ''} ${p.error ? 'failed' : ''} ${ic ? 'ic' : ''} ${book ? 'book' : ''} ${
        narrator ? 'narration' : ''
      } ${book && settings.ic_serif ? 'serif' : ''}`}
      style={book && !narrator ? bookVars(character ? character.color : myRole) : undefined}
    >
      {p.reply_to && groupStart && <ReplyPreview reply={p.reply_to} channelId={p.channel_id} serverId={serverId} />}
      <div className="message-contents">
        {groupStart ? narrator ? <NarratorAvatar /> : <img className="message-avatar" src={avatar} alt="" /> : <span className="message-gutter-time" />}
        {groupStart && (
          <h3 className="message-header">
            <span className="message-name" style={{ color: nameColor }}>
              {name}
            </span>
            {ic && !settings.immersive && <PlayerTag userId={me.id} serverId={serverId} />}
            <time className="message-timestamp">{formatTimestamp(p.created_at)}</time>
          </h3>
        )}
        {p.content && (
          <div className="message-body markup">{renderNodes(nodes, { ...ctx, rp: book ? { inQuote: false } : undefined })}</div>
        )}
      </div>
      {uploading && (
        <div className="message-accessories">
          <div className="upload-progress-card">
            <Icon path={mdiFileDocumentOutline} size={30} className="file-card-icon" />
            <div className="upload-progress-info">
              <div className="upload-progress-name">
                {p.files.length === 1 ? p.files[0].name : `${p.files.length} files`}
                <span className="upload-progress-size"> — {formatBytes(p.files.reduce((n, f) => n + f.size, 0))}</span>
              </div>
              <div className="upload-progress-bar">
                <span style={{ width: `${Math.round(p.progress * 100)}%` }} />
              </div>
            </div>
          </div>
        </div>
      )}
      {p.error && (
        <div className="message-failed">
          <span>{p.error}</span>
          <button className="link-button" onClick={() => p.retry?.()}>
            Retry
          </button>
          <span className="dot-sep">•</span>
          <button className="link-button danger" onClick={() => discardPending(p.channel_id, p.nonce)}>
            Delete
          </button>
        </div>
      )}
    </div>
  );
}

export function channelLink(channelId: number): string {
  const c = getState().channels[channelId];
  return c ? channelPath(c) : '/channels/@me';
}
