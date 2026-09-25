import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { userAvatar } from '../lib/avatars';
import { dayKey, formatLongDate } from '../lib/format';
import { P } from '../lib/permissions';
import { ackChannel, jumpToPresent, loadAfter, loadBefore, loadLatest, trimToNewest } from '../store/actions';
import { channelTitle, dmPartner, myChannelPerms } from '../store/selectors';
import { getState, MESSAGE_WINDOW, setReadingBack, setState, useStore, WINDOW_SLACK } from '../store/store';
import type { Channel, Message, PendingMessage } from '../store/types';
import { ChannelType, MessageType } from '../store/types';
import ChannelIcon from './ChannelIcon';
import { GroupIcon } from './HomeSidebar';
import { MessageItem, PendingItem } from './Message';
import { Avatar, Spinner } from './ui';

const GROUP_WINDOW = 7 * 60 * 1000;

/** A message near the top of the view and how far it sits below the top edge. */
type Anchor = { id: string; offset: number };

function breaksGroup(prev: Message | null, m: Message): boolean {
  if (!prev) return true;
  if (m.type !== MessageType.DEFAULT || prev.type !== MessageType.DEFAULT) return true;
  if (prev.author_id !== m.author_id || prev.character_id !== m.character_id) return true;
  // Narration vs. speaking as yourself, and the book look on vs. off, each get their own header.
  if (!!prev.meta?.narrator !== !!m.meta?.narrator || !!prev.book !== !!m.book) return true;
  if (m.reply_to) return true;
  return new Date(m.created_at).getTime() - new Date(prev.created_at).getTime() > GROUP_WINDOW;
}

function Welcome({ channel }: { channel: Channel }) {
  const s = getState();
  if (channel.type === ChannelType.DM) {
    const partner = dmPartner(s, channel);
    return (
      <div className="chat-welcome">
        <Avatar src={userAvatar(partner ?? s.me!)} size={80} />
        <h1 className="chat-welcome-title">{channelTitle(s, channel)}</h1>
        {partner && <div className="chat-welcome-username">{partner.username}</div>}
        <p className="chat-welcome-text">
          This is the beginning of your direct message history with <strong>{channelTitle(s, channel)}</strong>.
        </p>
      </div>
    );
  }
  if (channel.type === ChannelType.GROUP_DM) {
    return (
      <div className="chat-welcome">
        <GroupIcon channel={channel} size={80} />
        <h1 className="chat-welcome-title">{channelTitle(s, channel)}</h1>
        <p className="chat-welcome-text">
          Welcome to the beginning of the <strong>{channelTitle(s, channel)}</strong> group.
        </p>
      </div>
    );
  }
  return (
    <div className="chat-welcome">
      <div className="chat-welcome-icon">
        <ChannelIcon channel={channel} size={44} />
      </div>
      <h1 className="chat-welcome-title titled">Welcome to {channel.name}</h1>
      <p className="chat-welcome-text">
        This is the start of <strong>{channel.name}</strong>.{channel.topic ? ` ${channel.topic}` : ''}
      </p>
    </div>
  );
}

export default function MessageList({ channel }: { channel: Channel }) {
  const cache = useStore((s) => s.messages[channel.id]);
  const pending = useStore((s) => s.pending[channel.id]);
  const meId = useStore((s) => s.me!.id);
  const jump = useStore((s) => (s.jump?.channelId === channel.id ? s.jump : null));
  const canRead = useStore((s) => (myChannelPerms(s, s.channels[channel.id]) & P.READ_MESSAGE_HISTORY) !== 0);
  const scroller = useRef<HTMLDivElement>(null);
  const content = useRef<HTMLDivElement>(null);
  const listBox = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const snapshot = useRef({ height: 0, firstId: 0 });
  const anchors = useRef<Anchor[]>([]);
  const [highlight, setHighlight] = useState<number | null>(null);
  const [newSince, setNewSince] = useState<number | null>(() => {
    const s = getState();
    const rs = s.readStates[channel.id];
    const last = s.channels[channel.id]?.last_message_id ?? 0;
    return rs && last > rs.last_read_id ? rs.last_read_id : null;
  });

  const list = cache?.list;
  const loaded = !!cache?.loaded;

  useEffect(() => {
    if (!loaded) void loadLatest(channel.id, true);
  }, [channel.id, loaded]);

  /**
   * `on`: at the bottom, following new messages. `atEnd`: at the bottom of
   * what's loaded (even when newer messages are still to load). The store
   * needs the second one too: see MESSAGE_CREATE and catching up.
   */
  const follow = (on: boolean, atEnd = on) => {
    atBottom.current = on;
    setReadingBack(channel.id, !atEnd);
  };
  useEffect(() => {
    setReadingBack(channel.id, false);
    return () => setReadingBack(channel.id, false);
  }, [channel.id]);

  // Clear the NEW divider once you send something.
  useEffect(() => {
    if (newSince !== null && list?.length && list[list.length - 1].author_id === meId && list[list.length - 1].id > newSince) setNewSince(null);
  }, [list, meId, newSince]);

  const tryAck = () => {
    if (atBottom.current && document.visibilityState === 'visible' && document.hasFocus()) ackChannel(channel.id);
  };

  /**
   * Remember the first few messages at the top of the view and where they sit.
   * Messages load in above, drop off either end and change size (images,
   * embeds) while you read; putting these back where they were keeps what you're
   * reading still, whatever happened around it.
   */
  const captureAnchor = () => {
    const el = scroller.current;
    const box = listBox.current;
    if (!el || !box) return;
    const top = el.getBoundingClientRect().top;
    const kids = box.children;
    let lo = 0;
    let hi = kids.length - 1;
    let first = kids.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (kids[mid].getBoundingClientRect().bottom > top) {
        first = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    const out: Anchor[] = [];
    for (let i = first; i < kids.length && out.length < 3; i++) {
      const k = kids[i] as HTMLElement;
      if (k.id.startsWith('msg-')) out.push({ id: k.id, offset: k.getBoundingClientRect().top - top });
    }
    anchors.current = out;
  };

  /** Scroll so the remembered messages are back in place. False if none are still here. */
  const restoreAnchor = (): boolean => {
    const el = scroller.current;
    const box = listBox.current;
    if (!el || !box) return false;
    const top = el.getBoundingClientRect().top;
    for (const a of anchors.current) {
      const node = box.querySelector<HTMLElement>(`#${a.id}`);
      if (!node) continue;
      const delta = node.getBoundingClientRect().top - top - a.offset;
      if (Math.abs(delta) >= 1) el.scrollTop += delta;
      return true;
    }
    return false;
  };

  // Keep the scroll position sensible as messages come and go.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const firstId = list?.[0]?.id ?? 0;
    if (!jump) {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      else if (!restoreAnchor() && snapshot.current.firstId && firstId < snapshot.current.firstId) {
        el.scrollTop += el.scrollHeight - snapshot.current.height;
      }
    }
    snapshot.current = { height: el.scrollHeight, firstId };
    captureAnchor();
    tryAck();
    // Following along at the bottom of a long session: the oldest messages go,
    // so the page stays light (scroll up and they load again).
    const c = getState().messages[channel.id];
    if (atBottom.current && !jump && c && !c.hasMoreAfter && c.list.length > MESSAGE_WINDOW + WINDOW_SLACK) trimToNewest(channel.id, MESSAGE_WINDOW);
  }, [list, pending]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to a specific message (reply previews, pins).
  useLayoutEffect(() => {
    if (!jump || !list) return;
    const target = listBox.current?.querySelector<HTMLElement>(`#msg-${jump.messageId}`);
    if (!target) return;
    follow(false);
    target.scrollIntoView({ block: 'center' });
    snapshot.current.height = scroller.current!.scrollHeight;
    captureAnchor();
    setHighlight(jump.messageId);
    setState({ jump: null });
    const t = window.setTimeout(() => setHighlight(null), 2000);
    return () => window.clearTimeout(t);
  }, [jump, list]);

  // Images and embeds change height after they load.
  useEffect(() => {
    const el = scroller.current;
    const inner = content.current;
    if (!el || !inner) return;
    const ro = new ResizeObserver(() => {
      if (atBottom.current) el.scrollTop = el.scrollHeight;
      else restoreAnchor(); // something above what you're reading grew or shrank
      snapshot.current.height = el.scrollHeight;
      captureAnchor();
    });
    ro.observe(inner);
    const onFocus = () => tryAck();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onFocus);
    return () => {
      ro.disconnect();
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onFocus);
    };
  }, [channel.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Jump to bottom when you send a message (back to the present first, if you were reading older ones).
  useEffect(() => {
    const onSent = () => {
      follow(true);
      if (getState().messages[channel.id]?.hasMoreAfter) void jumpToPresent(channel.id);
      const el = scroller.current;
      if (el) el.scrollTop = el.scrollHeight;
    };
    window.addEventListener('tavern:sent', onSent);
    return () => window.removeEventListener('tavern:sent', onSent);
  }, [channel.id]);

  const onScroll = () => {
    const el = scroller.current;
    const c = getState().messages[channel.id];
    if (!el || !c) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    follow(distance < 30 && !c.hasMoreAfter, distance < 30);
    snapshot.current.height = el.scrollHeight;
    if (el.scrollTop < 600 && c.hasMoreBefore && !c.loadingBefore && c.loaded) void loadBefore(channel.id);
    if (distance < 600 && c.hasMoreAfter && !c.loadingAfter) void loadAfter(channel.id);
    captureAnchor();
    tryAck();
  };

  const rows = useMemo(() => {
    const out: ReactNode[] = [];
    if (!list) return out;
    let prev: Message | null = null;
    let newShown = false;
    for (const m of list) {
      const newDay = !prev || dayKey(prev.created_at) !== dayKey(m.created_at);
      const isNew = !newShown && newSince !== null && m.id > newSince && m.author_id !== meId;
      if (isNew) newShown = true;
      if (newDay || isNew) {
        out.push(
          <div key={`d${m.id}`} className={`divider-row ${isNew ? 'is-new' : ''} ${newDay ? 'has-date' : ''}`} role="separator">
            {newDay && <span className="divider-date">{formatLongDate(m.created_at)}</span>}
            {isNew && <span className="divider-new">New</span>}
          </div>,
        );
      }
      out.push(<MessageItem key={m.id} message={m} groupStart={newDay || isNew || breaksGroup(prev, m)} highlight={highlight === m.id} />);
      prev = m;
    }
    return out;
  }, [list, newSince, meId, highlight]);

  const pendingRows = useMemo(() => {
    if (!pending?.length || cache?.hasMoreAfter) return null;
    type Prev = { author: number; character: number | null; narrator: boolean; book: boolean; at: number };
    let prev: Prev | null = null;
    const last = list?.[list.length - 1];
    if (last && last.type === MessageType.DEFAULT)
      prev = { author: last.author_id, character: last.character_id, narrator: !!last.meta?.narrator, book: !!last.book, at: new Date(last.created_at).getTime() };
    return pending.map((p: PendingMessage) => {
      const at = new Date(p.created_at).getTime();
      const narrator = !!p.narrator;
      const book = !!p.book;
      const start =
        !prev ||
        prev.author !== meId ||
        prev.character !== p.character_id ||
        prev.narrator !== narrator ||
        prev.book !== book ||
        !!p.reply_to ||
        at - prev.at > GROUP_WINDOW;
      prev = { author: meId, character: p.character_id, narrator, book, at };
      return <PendingItem key={p.nonce} p={p} groupStart={start} />;
    });
  }, [pending, list, meId, cache?.hasMoreAfter]);

  return (
    <div className="messages-wrapper">
      <div className="messages-scroller scroller-auto" ref={scroller} onScroll={onScroll}>
        <div className="messages-content" ref={content}>
          {!canRead ? (
            <div className="chat-no-history">You don't have permission to read the message history in this channel.</div>
          ) : !loaded ? (
            <div className="messages-loading">
              <Spinner />
            </div>
          ) : cache?.hasMoreBefore ? (
            <div className="messages-loading small">{cache.loadingBefore && <Spinner size={24} />}</div>
          ) : (
            <Welcome channel={channel} />
          )}
          <div className="messages" ref={listBox} role="log" aria-label={`Messages in ${channel.name ?? 'this conversation'}`}>
            {rows}
            {pendingRows}
          </div>
          {cache?.hasMoreAfter && <div className="messages-loading small">{cache.loadingAfter && <Spinner size={24} />}</div>}
          <div className="messages-spacer" />
        </div>
      </div>
      {cache?.hasMoreAfter && (
        <div className="jump-bar">
          <span>You're viewing older messages</span>
          <button
            className="jump-bar-button"
            onClick={() => {
              follow(true);
              void jumpToPresent(channel.id);
            }}
          >
            Jump To Present
          </button>
        </div>
      )}
    </div>
  );
}
