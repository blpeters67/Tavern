import type { MouseEvent as ReactMouseEvent, ReactNode } from 'react';
import { api, ApiError, errorMessage, setUnauthorizedHandler, upload } from '../api/http';
import { gateway } from '../api/gateway';
import { on } from '../lib/events';
import { save } from '../lib/storage';
import { toast } from '../components/Toasts';
import { firstChannel, isDm, myCharacters, personaFor } from './selectors';
import {
  dispatch,
  emptyMessages,
  getState,
  IDLE_MESSAGES,
  isReadingBack,
  MESSAGE_WINDOW,
  newWindowGen,
  persistUi,
  resetSession,
  setState,
  WINDOW_SLACK,
  type JukeboxTab,
  type ReplyState,
  type SettingsTarget,
  type TheaterTab,
} from './store';
import type { Channel, ChannelMessages, Me, Message, PendingMessage, ReactionEmoji, ReplyRef, Settings } from './types';
import { ChannelType, NARRATOR } from './types';

// ---------------------------------------------------------------------------
// Navigation (the router registers its navigate function here)
// ---------------------------------------------------------------------------

let navigateFn: ((to: string, opts?: { replace?: boolean }) => void) | null = null;
export function setNavigate(fn: typeof navigateFn) {
  navigateFn = fn;
}
export function go(to: string, replace = false) {
  navigateFn?.(to, { replace });
}

export function channelPath(c: Pick<Channel, 'id' | 'server_id'>): string {
  return c.server_id ? `/channels/${c.server_id}/${c.id}` : `/channels/@me/${c.id}`;
}

// ---------------------------------------------------------------------------
// Session
// ---------------------------------------------------------------------------

export async function bootstrap() {
  try {
    const me = await api.get<Me>('/api/users/@me', { quiet401: true });
    startSession(me);
  } catch {
    setState({ status: 'anonymous' });
  }
}

export function startSession(me: Me) {
  setState({ me, status: 'connecting' });
  gateway.start();
}

export async function logout() {
  try {
    await api.post('/api/auth/logout');
  } catch {
    /* logging out anyway */
  }
  endSession();
}

export function endSession() {
  gateway.stop();
  resetSession();
  go('/login', true);
}

gateway.onLoggedOut = () => {
  if (getState().status !== 'anonymous') {
    endSession();
    toast('You were logged out. Please log in again.');
  }
};
setUnauthorizedHandler(() => {
  if (getState().status === 'ready' || getState().status === 'connecting') gateway.onLoggedOut?.();
});

export async function updateSettings(patch: Partial<Settings>) {
  const me = getState().me;
  if (!me) return;
  const before = me.settings;
  setState({ me: { ...me, settings: { ...before, ...patch } } });
  try {
    await api.patch('/api/users/@me/settings', patch);
  } catch (err) {
    const cur = getState().me;
    if (cur) setState({ me: { ...cur, settings: before } });
    toast(errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Layers: modals, context menus, settings
// ---------------------------------------------------------------------------

let layerSeq = 1;

export function openModal(render: (close: () => void) => ReactNode): number {
  const id = layerSeq++;
  setState((s) => ({ modals: [...s.modals, { id, render }], contextMenu: null }));
  return id;
}

export function closeModal(id?: number) {
  setState((s) => ({ modals: id === undefined ? s.modals.slice(0, -1) : s.modals.filter((m) => m.id !== id) }));
}

export function openContextMenu(e: ReactMouseEvent | MouseEvent | { clientX: number; clientY: number }, render: (close: () => void) => ReactNode) {
  if ('preventDefault' in e) e.preventDefault();
  setState({ contextMenu: { x: e.clientX, y: e.clientY, render } });
}

export function closeContextMenu() {
  if (getState().contextMenu) setState({ contextMenu: null });
}

export function openSettings(target: SettingsTarget) {
  setState({ settings: target, contextMenu: null, mobileNavOpen: false });
}

export function closeSettings() {
  setState({ settings: null });
}

export function openSheet(characterId: number, serverId: number | null, tab?: string) {
  setState({ sheetView: { characterId, serverId, tab }, contextMenu: null, mobileNavOpen: false });
}

export function closeSheet() {
  setState({ sheetView: null });
}

export function openJukebox(serverId: number, tab: JukeboxTab = 'queue') {
  setState({ jukeboxView: { serverId, tab }, contextMenu: null });
}

export function closeJukebox() {
  setState({ jukeboxView: null });
}

export function openTheater(serverId: number, tab: TheaterTab = 'queue') {
  setState({ theaterView: { serverId, tab }, contextMenu: null });
}

export function closeTheater() {
  setState({ theaterView: null });
}

/** Open the game board over the channel: board in the middle, chat beside it. */
export function openBoard(serverId: number) {
  const s = getState();
  const here = s.activeChannelId !== null ? s.channels[s.activeChannelId] : undefined;
  if (!here || here.server_id !== serverId || here.type !== ChannelType.TEXT) {
    // The chat column beside the board wants a text channel of this server.
    const last = s.lastChannelByServer[serverId];
    const target = (last && s.channels[last]?.server_id === serverId && s.channels[last]?.type === ChannelType.TEXT ? last : firstChannel(s, serverId)?.id) ?? null;
    if (target !== null) go(`/channels/${serverId}/${target}`);
  }
  setState({ boardView: { serverId }, contextMenu: null, mobileNavOpen: false, mobileMembersOpen: false });
}

export function closeBoard() {
  setState({ boardView: null });
}

export function toggleMemberList() {
  setState((s) => ({ memberListOpen: !s.memberListOpen }));
  persistUi();
}

/** Local display preference: hides every dice-roll message from chat. */
export function toggleHideRolls() {
  setState((s) => ({ hideRolls: !s.hideRolls }));
  persistUi();
}

export function toggleCategory(id: number) {
  setState((s) => ({ collapsedCategories: { ...s.collapsedCategories, [id]: !s.collapsedCategories[id] } }));
  persistUi();
}

export function rememberChannel(serverId: number, channelId: number) {
  const s = getState();
  if (s.lastChannelByServer[serverId] === channelId) return;
  setState({ lastChannelByServer: { ...s.lastChannelByServer, [serverId]: channelId } });
  persistUi();
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

const PAGE = 50;
/** Catching up fetches at most this many pages before leaving the rest to "newer messages below". */
const CATCH_UP_PAGES = 4;

function setCache(channelId: number, patch: Partial<ChannelMessages>) {
  setState((s) => ({ messages: { ...s.messages, [channelId]: { ...(s.messages[channelId] ?? emptyMessages()), ...patch } } }));
}

/**
 * Change a message window only if it's still the one a request started from
 * (`gen`). A window replaced meanwhile (Jump To Present, a jump to a message,
 * a reconnect) or dropped ignores answers meant for the old one. Returns
 * whether anything was applied.
 */
function patchWindow(channelId: number, gen: number, patch: Partial<ChannelMessages> | ((cur: ChannelMessages) => Partial<ChannelMessages> | null)): boolean {
  let applied = false;
  setState((s) => {
    const cur = s.messages[channelId];
    if (!cur || cur.gen !== gen) return {};
    const p = typeof patch === 'function' ? patch(cur) : patch;
    if (!p) return {};
    applied = true;
    return { messages: { ...s.messages, [channelId]: { ...cur, ...p } } };
  });
  return applied;
}

// Replacing a channel's whole window: its newest messages, or the ones around
// a message you jump to. When a newer replacement starts while one is out, the
// older one is dropped when it lands.
let replaceCounter = 0;
const replacing = new Map<number, number>();
on('session-reset', () => replacing.clear());

function startReplace(channelId: number): number {
  const n = ++replaceCounter;
  replacing.set(channelId, n);
  return n;
}

/** Is `n` still the newest replacement for the channel? (It's finished either way.) */
function endReplace(channelId: number, n: number): boolean {
  if (replacing.get(channelId) !== n) return false;
  replacing.delete(channelId);
  return true;
}

/** Worth trying again: no connection, the server struggling, or too many requests. */
function transient(err: unknown): boolean {
  return !(err instanceof ApiError) || err.status === 0 || err.status >= 500 || err.status === 429;
}

const RETRY_DELAYS = [2000, 5000, 15000, 30000];

/** Nothing on screen yet and the load failed: keep the spinner and try again. */
function retryLatest(channelId: number, attempt: number) {
  window.setTimeout(
    () => {
      const s = getState();
      if (s.activeChannelId === channelId && !s.messages[channelId]?.loaded) void loadLatest(channelId, true, attempt + 1);
    },
    RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)],
  );
}

/**
 * A load failed partway to the present, so the window stops at what joins up
 * and says newer messages are below. While you have it open at the bottom,
 * those load by themselves once the server answers again (a few tries, then
 * scrolling down or Jump To Present does it).
 */
function retryForward(channelId: number, gen: number, attempt = 0) {
  if (attempt >= RETRY_DELAYS.length) return;
  window.setTimeout(() => {
    void (async () => {
      for (let pages = 0; pages < CATCH_UP_PAGES; pages++) {
        const s = getState();
        const cur = s.messages[channelId];
        if (!cur || cur.gen !== gen || !cur.hasMoreAfter || cur.loadingAfter || s.activeChannelId !== channelId || isReadingBack(channelId)) return;
        if (!(await loadAfter(channelId, true))) {
          retryForward(channelId, gen, attempt + 1);
          return;
        }
      }
    })();
  }, RETRY_DELAYS[attempt]);
}

/**
 * Load a channel's newest messages as its window. `auto` (the channel opening,
 * or reloading after a reconnect) gives way to a replacement already on its
 * way, like a jump to a message.
 */
export async function loadLatest(channelId: number, auto = false, attempt = 0) {
  if (auto && replacing.has(channelId)) return;
  const n = startReplace(channelId);
  setCache(channelId, { loadingAfter: true });
  try {
    const list = await api.get<Message[]>(`/api/channels/${channelId}/messages?limit=${PAGE}`);
    if (!endReplace(channelId, n)) return;
    setCache(channelId, {
      list,
      gen: newWindowGen(),
      hasMoreBefore: list.length === PAGE,
      hasMoreAfter: false,
      loaded: true,
      loadingAfter: false,
      loadingBefore: false,
      catchingUp: false,
    });
    void catchUp(channelId);
  } catch (err) {
    if (!endReplace(channelId, n)) return;
    const cur = getState().messages[channelId];
    if (cur?.list.length) {
      // Keep what's on screen (after a reconnect it may be out of date), marked
      // as behind the present so nothing new lands after a gap.
      setCache(channelId, { loaded: true, loadingAfter: false, catchingUp: false, hasMoreAfter: true });
      retryForward(channelId, cur.gen);
    } else if (transient(err)) {
      setCache(channelId, { loadingAfter: false });
      retryLatest(channelId, attempt);
    } else {
      setCache(channelId, { loadingAfter: false, loaded: true, hasMoreBefore: false });
    }
    if (!attempt) toast(errorMessage(err));
  }
}

/**
 * Live messages aren't added to a window while it loads or while you're
 * viewing older ones. When a load brings a window up to the present, whatever
 * arrived meanwhile is fetched page by page until it has caught up (the
 * channel's last_message_id says whether it's behind). New live messages wait
 * until then (they're fetched too), so nothing ever lands after a gap. A gap
 * bigger than a few pages, or a request that fails, stops at what joins up
 * and becomes "newer messages below".
 */
async function catchUp(channelId: number) {
  const start = getState().messages[channelId];
  if (!start || !start.loaded || start.hasMoreAfter || start.catchingUp || !start.list.length) return;
  const { gen } = start;
  const behind = (id: number) => (getState().channels[channelId]?.last_message_id ?? 0) > id;
  let cursor = start.list[start.list.length - 1].id;
  if (!behind(cursor)) return;
  if (!patchWindow(channelId, gen, { catchingUp: true })) return;
  for (let pages = 1; ; pages++) {
    let newer: Message[];
    try {
      newer = await api.get<Message[]>(`/api/channels/${channelId}/messages?after=${cursor}&limit=${PAGE}`);
    } catch {
      // Everything up to `cursor` joins up; the rest loads once the server answers.
      if (patchWindow(channelId, gen, { catchingUp: false, hasMoreAfter: true })) retryForward(channelId, gen);
      return;
    }
    const full = newer.length === PAGE;
    const end = newer.length ? newer[newer.length - 1].id : cursor;
    let finished = false;
    const applied = patchWindow(channelId, gen, (cur) => {
      if (!cur.catchingUp) return null;
      let list = cur.list;
      for (const m of newer) list = insertSorted(list, m);
      if (isReadingBack(channelId) && list.length > MESSAGE_WINDOW + WINDOW_SLACK) {
        finished = true; // you're reading further up and the window is full
        return { list: list.slice(0, MESSAGE_WINDOW + WINDOW_SLACK), catchingUp: false, hasMoreAfter: true };
      }
      if (full && pages >= CATCH_UP_PAGES) {
        finished = true; // too far behind: the rest loads as you scroll down
        return { list, catchingUp: false, hasMoreAfter: true };
      }
      // Caught up: nothing newer than this page (anything that arrived during the
      // request waited, and shows as behind, so it's another round).
      if (!full && (!newer.length || !behind(end))) {
        finished = true;
        return { list, catchingUp: false };
      }
      return { list };
    });
    if (!applied || finished) return;
    cursor = end;
  }
}

function insertSorted(list: Message[], msg: Message): Message[] {
  const idx = list.findIndex((m) => m.id >= msg.id);
  if (idx === -1) return [...list, msg];
  if (list[idx].id === msg.id) return list;
  return [...list.slice(0, idx), msg, ...list.slice(idx)];
}

export async function loadBefore(channelId: number) {
  const cache = getState().messages[channelId];
  if (!cache || cache.loadingBefore || !cache.hasMoreBefore || !cache.list.length) return;
  const { gen } = cache;
  const first = cache.list[0].id;
  patchWindow(channelId, gen, { loadingBefore: true });
  try {
    const older = await api.get<Message[]>(`/api/channels/${channelId}/messages?before=${first}&limit=${PAGE}`);
    patchWindow(channelId, gen, (cur) => {
      // The top moved while this was out (trimmed, or its first message
      // deleted), so the page no longer joins on. Scrolling up asks again.
      if (cur.list[0]?.id !== first) return { loadingBefore: false };
      const ids = new Set(cur.list.map((m) => m.id));
      const list = [...older.filter((m) => !ids.has(m.id)), ...cur.list];
      // Reading back through a long history: the newest end goes (you're far
      // above it), and comes back from the server when you scroll down again.
      const trim = list.length > MESSAGE_WINDOW;
      return {
        list: trim ? list.slice(0, MESSAGE_WINDOW) : list,
        hasMoreBefore: older.length === PAGE,
        hasMoreAfter: cur.hasMoreAfter || trim,
        loadingBefore: false,
      };
    });
  } catch (err) {
    patchWindow(channelId, gen, { loadingBefore: false });
    toast(errorMessage(err));
  }
}

/** Load the next page below the window. `quiet`: no toast if it fails. False if the request failed. */
export async function loadAfter(channelId: number, quiet = false): Promise<boolean> {
  const cache = getState().messages[channelId];
  if (!cache || cache.loadingAfter || !cache.hasMoreAfter || !cache.list.length) return true;
  const { gen } = cache;
  const last = cache.list[cache.list.length - 1].id;
  patchWindow(channelId, gen, { loadingAfter: true });
  try {
    const newer = await api.get<Message[]>(`/api/channels/${channelId}/messages?after=${last}&limit=${PAGE}`);
    const applied = patchWindow(channelId, gen, (cur) => {
      if (cur.list[cur.list.length - 1]?.id !== last) return { loadingAfter: false };
      const ids = new Set(cur.list.map((m) => m.id));
      const list = [...cur.list, ...newer.filter((m) => !ids.has(m.id))];
      // Scrolling back down: the oldest end goes, so the window stays the same size.
      const trim = list.length > MESSAGE_WINDOW;
      return {
        list: trim ? list.slice(-MESSAGE_WINDOW) : list,
        hasMoreBefore: cur.hasMoreBefore || trim,
        hasMoreAfter: newer.length === PAGE,
        loadingAfter: false,
      };
    });
    if (applied && newer.length < PAGE) void catchUp(channelId);
    return true;
  } catch (err) {
    patchWindow(channelId, gen, { loadingAfter: false });
    if (!quiet) toast(errorMessage(err));
    return false;
  }
}

/** Following along at the bottom: drop the oldest messages past `keep`. */
export function trimToNewest(channelId: number, keep: number) {
  setState((s) => {
    const c = s.messages[channelId];
    if (!c || c.hasMoreAfter || c.list.length <= keep) return {};
    return { messages: { ...s.messages, [channelId]: { ...c, list: c.list.slice(-keep), hasMoreBefore: true } } };
  });
}

/** How many channels keep messages cached, for switching back instantly. */
const CACHED_CHANNELS = 15;
const recentChannels: number[] = [];

/**
 * The open channel changed. The others shrink to their newest messages (or
 * are dropped if you were reading far back in them), and only the channels
 * you visited most recently stay cached at all.
 */
export function channelOpened(channelId: number | null) {
  if (channelId !== null) {
    const at = recentChannels.indexOf(channelId);
    if (at !== -1) recentChannels.splice(at, 1);
    recentChannels.unshift(channelId);
    recentChannels.length = Math.min(recentChannels.length, CACHED_CHANNELS);
  }
  setState((s) => {
    let messages: typeof s.messages | null = null;
    for (const [key, cache] of Object.entries(s.messages)) {
      const id = Number(key);
      if (id === channelId || !cache.loaded) continue;
      if (!recentChannels.includes(id) || cache.hasMoreAfter) {
        messages ??= { ...s.messages };
        delete messages[id];
      } else if (cache.list.length > IDLE_MESSAGES) {
        messages ??= { ...s.messages };
        messages[id] = { ...cache, list: cache.list.slice(-IDLE_MESSAGES), hasMoreBefore: true };
      }
    }
    return messages ? { messages } : {};
  });
}

export async function jumpToMessage(channelId: number, messageId: number) {
  const s = getState();
  const channel = s.channels[channelId];
  if (!channel) return;
  const cached = !!s.messages[channelId]?.list.some((m) => m.id === messageId);
  // Claimed before opening the channel, so opening it doesn't load the newest messages over the jump.
  const n = cached ? 0 : startReplace(channelId);
  if (s.activeChannelId !== channelId) go(channelPath(channel));
  if (!cached) {
    try {
      const list = await api.get<Message[]>(`/api/channels/${channelId}/messages?around=${messageId}&limit=${PAGE}`);
      if (!endReplace(channelId, n)) return; // you went somewhere else meanwhile
      const older = list.filter((m) => m.id < messageId).length;
      const newer = list.filter((m) => m.id >= messageId).length;
      const hasMoreAfter = newer >= PAGE / 2;
      setCache(channelId, {
        list,
        gen: newWindowGen(),
        loaded: true,
        hasMoreBefore: older >= PAGE / 2,
        hasMoreAfter,
        loadingAfter: false,
        loadingBefore: false,
        catchingUp: false,
      });
      if (!hasMoreAfter) void catchUp(channelId);
    } catch (err) {
      // Nothing to show instead: load the newest messages after all.
      if (endReplace(channelId, n) && !getState().messages[channelId]?.loaded) void loadLatest(channelId);
      toast(errorMessage(err));
      return;
    }
  }
  setState({ jump: { channelId, messageId, key: Date.now() } });
}

export async function jumpToPresent(channelId: number) {
  await loadLatest(channelId);
  setState({ jump: null });
}

function replyRef(channelId: number, messageId: number): ReplyRef | null {
  const m = getState().messages[channelId]?.list.find((x) => x.id === messageId);
  if (!m) return { id: messageId, deleted: false };
  return {
    id: m.id,
    deleted: false,
    author_id: m.author_id,
    character_id: m.character_id,
    content: m.content,
    has_attachments: m.attachments.length > 0,
    author: m.author,
    character: m.character,
  };
}

function setPending(channelId: number, fn: (list: PendingMessage[]) => PendingMessage[]) {
  setState((s) => ({ pending: { ...s.pending, [channelId]: fn(s.pending[channelId] ?? []) } }));
}

export function sendMessage(
  channelId: number,
  content: string,
  files: File[],
  characterId: number | null,
  reply?: ReplyState,
  opts: { narrator?: boolean; book?: boolean } = {},
) {
  const nonce = `${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  const narrator = !!opts.narrator && !characterId;
  const book = narrator || !!opts.book;
  const pending: PendingMessage = {
    nonce,
    channel_id: channelId,
    character_id: characterId,
    narrator,
    book,
    content,
    created_at: new Date().toISOString(),
    reply_to: reply ? replyRef(channelId, reply.messageId) : null,
    files: files.map((f) => ({ name: f.name, size: f.size, type: f.type })),
    progress: 0,
    error: null,
  };

  const attempt = () => {
    const form = new FormData();
    form.append(
      'payload_json',
      JSON.stringify({
        content,
        character_id: characterId,
        narrator,
        book,
        reply_to_id: reply?.messageId ?? null,
        mention_reply: reply?.mention ?? true,
        nonce,
      }),
    );
    for (const f of files) form.append('files', f, f.name);
    const req = upload<Message>('POST', `/api/channels/${channelId}/messages`, form, (p) =>
      setPending(channelId, (list) => list.map((x) => (x.nonce === nonce ? { ...x, progress: p } : x))),
    );
    req.promise
      .then((msg) => dispatch('MESSAGE_CREATE', msg))
      .catch((err) => setPending(channelId, (list) => list.map((x) => (x.nonce === nonce ? { ...x, error: errorMessage(err) } : x))));
  };

  pending.retry = () => {
    setPending(channelId, (list) => list.map((x) => (x.nonce === nonce ? { ...x, error: null, progress: 0 } : x)));
    attempt();
  };
  setPending(channelId, (list) => [...list, pending]);
  attempt();
}

export function discardPending(channelId: number, nonce: string) {
  setPending(channelId, (list) => list.filter((p) => p.nonce !== nonce));
}

export async function editMessage(m: Message, content: string) {
  try {
    const updated = await api.patch<Message>(`/api/channels/${m.channel_id}/messages/${m.id}`, { content });
    dispatch('MESSAGE_UPDATE', updated);
  } catch (err) {
    toast(errorMessage(err));
  }
}

export async function deleteMessage(m: Message) {
  try {
    await api.del(`/api/channels/${m.channel_id}/messages/${m.id}`);
  } catch (err) {
    toast(errorMessage(err));
  }
}

export async function setPinned(m: Message, pinned: boolean) {
  try {
    if (pinned) await api.put(`/api/channels/${m.channel_id}/pins/${m.id}`);
    else await api.del(`/api/channels/${m.channel_id}/pins/${m.id}`);
  } catch (err) {
    toast(errorMessage(err));
  }
}

export async function suppressEmbeds(m: Message) {
  try {
    await api.patch(`/api/channels/${m.channel_id}/messages/${m.id}`, { suppress_embeds: true });
  } catch (err) {
    toast(errorMessage(err));
  }
}

function emojiKey(e: ReactionEmoji): string {
  return e.id ? `${e.name}:${e.id}` : e.name;
}

export async function toggleReaction(m: Message, emoji: ReactionEmoji) {
  const me = getState().me?.id;
  if (!me) return;
  const group = m.reactions.find((r) => (emoji.id ? r.emoji.id === emoji.id : !r.emoji.id && r.emoji.name === emoji.name));
  const mine = !!group?.user_ids.includes(me);
  const path = `/api/channels/${m.channel_id}/messages/${m.id}/reactions/${encodeURIComponent(emojiKey(emoji))}/@me`;
  const event = { channel_id: m.channel_id, message_id: m.id, user_id: me, emoji };
  dispatch(mine ? 'MESSAGE_REACTION_REMOVE' : 'MESSAGE_REACTION_ADD', event);
  try {
    if (mine) await api.del(path);
    else await api.put(path);
  } catch (err) {
    dispatch(mine ? 'MESSAGE_REACTION_ADD' : 'MESSAGE_REACTION_REMOVE', event);
    toast(errorMessage(err));
  }
}

export function addReaction(m: Message, emoji: ReactionEmoji) {
  const me = getState().me?.id;
  const group = m.reactions.find((r) => (emoji.id ? r.emoji.id === emoji.id : !r.emoji.id && r.emoji.name === emoji.name));
  if (me && group?.user_ids.includes(me)) return;
  void toggleReaction(m, emoji);
}

// ---------------------------------------------------------------------------
// Read state & typing
// ---------------------------------------------------------------------------

const ackTimers = new Map<number, number>();

export function ackChannel(channelId: number) {
  const s = getState();
  const c = s.channels[channelId];
  if (!c?.last_message_id) return;
  const rs = s.readStates[channelId];
  if (rs && rs.last_read_id >= c.last_message_id && !rs.mention_count) return;
  const target = c.last_message_id;
  setState((st) => ({
    readStates: {
      ...st.readStates,
      [channelId]: { ...(st.readStates[channelId] ?? { channel_id: channelId, last_character_id: null }), last_read_id: target, mention_count: 0 },
    },
  }));
  const prev = ackTimers.get(channelId);
  if (prev) window.clearTimeout(prev);
  ackTimers.set(
    channelId,
    window.setTimeout(() => {
      ackTimers.delete(channelId);
      api.post(`/api/channels/${channelId}/ack`, { message_id: target }).catch(() => undefined);
    }, 350),
  );
}

export function markServerRead(serverId: number) {
  for (const c of Object.values(getState().channels)) if (c.server_id === serverId) ackChannel(c.id);
}

const lastTyping = new Map<number, number>();
export function sendTyping(channelId: number, characterId: number | null, narrator = false) {
  const now = Date.now();
  if ((lastTyping.get(channelId) ?? 0) > now - 7000) return;
  lastTyping.set(channelId, now);
  api.post(`/api/channels/${channelId}/typing`, { character_id: characterId, narrator: narrator && !characterId }).catch(() => undefined);
}
export function resetTyping(channelId: number) {
  lastTyping.delete(channelId);
}

// ---------------------------------------------------------------------------
// Characters / personas
// ---------------------------------------------------------------------------

export function setPersona(channelId: number | null, characterId: number) {
  const s = getState();
  setState({ globalPersona: characterId });
  save('persona', characterId);
  if (!channelId) return;
  if (s.me?.settings.switch_remember) setState((st) => ({ personaByChannel: { ...st.personaByChannel, [channelId]: characterId } }));
  // Tell the channel who we're speaking as (the member list shows it).
  api.put(`/api/channels/${channelId}/persona`, { character_id: characterId }).catch(() => undefined);
}

export function cyclePersona(channelId: number, direction: 1 | -1) {
  const s = getState();
  const serverId = s.channels[channelId]?.server_id;
  const ids = [0, ...(serverId && isDm(s, serverId) ? [NARRATOR] : []), ...myCharacters(s).map((c) => c.id)];
  if (ids.length < 2) return;
  const current = personaFor(s, channelId);
  const idx = Math.max(0, ids.indexOf(current));
  setPersona(channelId, ids[(idx + direction + ids.length) % ids.length]);
}

// ---------------------------------------------------------------------------
// DMs & invites
// ---------------------------------------------------------------------------

export async function openDM(userIds: number[]) {
  try {
    const channel = await api.post<Channel>('/api/users/@me/channels', { recipient_ids: userIds });
    dispatch('CHANNEL_CREATE', channel);
    go(`/channels/@me/${channel.id}`);
    setState({ mobileNavOpen: false });
  } catch (err) {
    toast(errorMessage(err));
  }
}

export async function acceptInvite(code: string) {
  const res = await api.post<{ server_id: number; channel_id: number | null }>(`/api/invites/${encodeURIComponent(code)}`);
  // The SERVER_CREATE event may land a moment after the response.
  for (let i = 0; i < 40 && !getState().servers[res.server_id]; i++) await new Promise((r) => setTimeout(r, 50));
  const target = res.channel_id && getState().channels[res.channel_id] ? `/channels/${res.server_id}/${res.channel_id}` : `/channels/${res.server_id}`;
  go(target);
}
