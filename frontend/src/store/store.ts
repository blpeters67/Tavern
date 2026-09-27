import type { ReactNode } from 'react';
import { create } from 'zustand';
import { emit } from '../lib/events';
import { mergePatch, type Sheet } from '../lib/sheet';
import { load, save } from '../lib/storage';
import { MessageType } from './types';
import type {
  BoardDrawing,
  BoardToken,
  Channel,
  ChannelMessages,
  Character,
  Emoji,
  Me,
  Member,
  Message,
  PendingMessage,
  JukeboxState,
  ReadState,
  ReadyPayload,
  ReactionEmoji,
  Role,
  Server,
  ServerBoard,
  ServerPayload,
  TheaterState,
  Track,
  TypingEntry,
  User,
  Video,
  VoiceState,
} from './types';

export type SettingsTarget =
  | { kind: 'user'; section?: string }
  | { kind: 'server'; id: number; section?: string }
  | { kind: 'channel'; id: number; section?: string };

export interface LayerEntry {
  id: number;
  render: (close: () => void) => ReactNode;
}

export interface ContextMenuState {
  x: number;
  y: number;
  render: (close: () => void) => ReactNode;
}

export interface ReplyState {
  messageId: number;
  mention: boolean;
}

export type JukeboxTab = 'queue' | 'library' | 'search';

export interface Library {
  tracks: Record<number, Track>;
  loaded: boolean;
  importsEnabled: boolean;
  /** Spotify links work (the server has a Spotify API key). */
  spotify: boolean;
  maxTrackMb: number;
}

export type TheaterTab = 'queue' | 'library' | 'search';

export interface VideoLibrary {
  videos: Record<number, Video>;
  loaded: boolean;
  /** Finding videos on YouTube works (the server has yt-dlp). */
  searchEnabled: boolean;
  maxVideoMb: number;
}

export interface SheetEntry {
  sheet: Sheet;
  canEdit: boolean;
  stale?: boolean;
}

/** This browser's own voice connection. */
export interface LocalVoice {
  channelId: number | null;
  serverId: number | null;
  status: 'idle' | 'connecting' | 'connected';
  selfMute: boolean;
  selfDeaf: boolean;
  video: boolean;
  stream: boolean;
}

export type RightPanel = { kind: 'members' } | { kind: 'search'; query: string; serverId: number | null; channelId: number | null };

export interface State {
  status: 'loading' | 'anonymous' | 'connecting' | 'ready';
  connected: boolean;
  me: Me | null;
  users: Record<number, User>;
  characters: Record<number, Character>;
  servers: Record<number, Server>;
  roles: Record<number, Role>;
  channels: Record<number, Channel>;
  members: Record<number, Record<number, Member>>;
  emojis: Record<number, Emoji>;
  readStates: Record<number, ReadState>;
  messages: Record<number, ChannelMessages>;
  pending: Record<number, PendingMessage[]>;
  typing: Record<number, Record<number, TypingEntry>>;
  personaByChannel: Record<number, number>;
  globalPersona: number;
  pinsVersion: Record<number, number>;
  jump: { channelId: number; messageId: number; key: number } | null;
  /** Total size allowed per message, from the server's MAX_UPLOAD_MB. */
  maxUploadMb: number;
  /** Everyone's voice connections, by user id. */
  voiceStates: Record<number, VoiceState>;
  jukebox: Record<number, JukeboxState>;
  libraries: Record<number, Library>;
  theater: Record<number, TheaterState>;
  theaterLibraries: Record<number, VideoLibrary>;
  board: Record<number, ServerBoard>;
  sheets: Record<number, SheetEntry>;
  /** Who is speaking as whom, per channel: channel -> user -> persona id. */
  channelPersonas: Record<number, Record<number, number>>;
  voice: LocalVoice;
  /** Jukebox opt-in per server (this browser). */
  listening: Record<number, boolean>;
  /** Theater seat per server (this browser): watching along. */
  seated: Record<number, boolean>;
  rightPanel: RightPanel;
  /** The character sheet being viewed (full-screen layer). */
  sheetView: { characterId: number; serverId: number | null; tab?: string } | null;
  /** Jukebox queue/library window. */
  jukeboxView: { serverId: number; tab: JukeboxTab } | null;
  /** Theater queue/library window. */
  theaterView: { serverId: number; tab: TheaterTab } | null;
  /** The game board, open over the channel (board in the middle, chat beside it). */
  boardView: { serverId: number } | null;

  // UI
  activeChannelId: number | null;
  memberListOpen: boolean;
  mobileNavOpen: boolean;
  mobileMembersOpen: boolean;
  settings: SettingsTarget | null;
  modals: LayerEntry[];
  contextMenu: ContextMenuState | null;
  replyTo: Record<number, ReplyState | undefined>;
  editing: { channelId: number; messageId: number } | null;
  drafts: Record<number, string>;
  lastChannelByServer: Record<number, number>;
  collapsedCategories: Record<number, boolean>;
}

/**
 * The most messages kept for the open channel. Paging further drops the far
 * end (it loads again if you scroll back), so a long session stays as light
 * as a short one.
 */
export const MESSAGE_WINDOW = 250;
/** How far past the window a live channel grows before trimming (so it trims in batches). */
export const WINDOW_SLACK = 50;
/** A channel you're not looking at keeps just its newest messages. */
export const IDLE_MESSAGES = 50;

let windowGen = 0;
/** A new identity for a message window whose list was replaced wholesale. */
export const newWindowGen = () => ++windowGen;

/** Open channels you've scrolled up in, away from the newest messages (MessageList keeps this current). */
const readingBackIn = new Set<number>();

export function setReadingBack(channelId: number, reading: boolean) {
  if (reading) readingBackIn.add(channelId);
  else readingBackIn.delete(channelId);
}

export const isReadingBack = (channelId: number) => readingBackIn.has(channelId);

/**
 * Mentions counted from live events since the last READY. READY's counts
 * already include every mention up to each channel's last_mention_id, and a
 * message sent while READY was being built also arrives as an event, so this
 * is how one mention adds exactly one to the badge.
 */
const mentionsCounted = new Set<number>();

function isNewMention(rs: ReadState, messageId: number): boolean {
  if (messageId <= rs.last_read_id || messageId <= (rs.last_mention_id ?? 0) || mentionsCounted.has(messageId)) return false;
  mentionsCounted.add(messageId);
  if (mentionsCounted.size > 1000) mentionsCounted.delete(mentionsCounted.values().next().value!);
  return true;
}

const emptyMessages = (): ChannelMessages => ({
  list: [],
  hasMoreBefore: true,
  hasMoreAfter: false,
  loaded: false,
  loadingBefore: false,
  loadingAfter: false,
  gen: newWindowGen(),
  catchingUp: false,
});

const initialData = {
  me: null,
  users: {},
  characters: {},
  servers: {},
  roles: {},
  channels: {},
  members: {},
  emojis: {},
  readStates: {},
  messages: {},
  pending: {},
  typing: {},
  personaByChannel: {},
  pinsVersion: {},
  jump: null,
  replyTo: {},
  editing: null,
  drafts: {},
  voiceStates: {},
  jukebox: {},
  libraries: {},
  theater: {},
  theaterLibraries: {},
  board: {},
  sheets: {},
  channelPersonas: {},
};

export const useStore = create<State>(() => ({
  status: 'loading',
  connected: false,
  ...initialData,
  globalPersona: load<number>('persona', 0),
  maxUploadMb: 100,
  voice: { channelId: null, serverId: null, status: 'idle', selfMute: load('selfMute', false), selfDeaf: load('selfDeaf', false), video: false, stream: false },
  listening: load<Record<number, boolean>>('listening', {}),
  seated: load<Record<number, boolean>>('seated', {}),
  rightPanel: { kind: 'members' },
  sheetView: null,
  jukeboxView: null,
  theaterView: null,
  boardView: null,
  activeChannelId: null,
  memberListOpen: load<boolean>('memberList', true),
  mobileNavOpen: false,
  mobileMembersOpen: false,
  settings: null,
  modals: [],
  contextMenu: null,
  lastChannelByServer: load<Record<number, number>>('lastChannels', {}),
  collapsedCategories: load<Record<number, boolean>>('collapsed', {}),
}));

export const getState = useStore.getState;
export const setState = useStore.setState;

// ---------------------------------------------------------------------------
// Small immutable helpers
// ---------------------------------------------------------------------------

function byId<T extends { id: number }>(list: T[] | undefined): Record<number, T> {
  const out: Record<number, T> = {};
  for (const item of list ?? []) out[item.id] = item;
  return out;
}

function omit<T>(rec: Record<number, T>, ids: Iterable<number>): Record<number, T> {
  const out = { ...rec };
  for (const id of ids) delete out[id];
  return out;
}

/** Does `prev` already have every value in `patch`? (Nested values compare by content.) */
function hasAll(prev: object, patch: object): boolean {
  for (const [k, v] of Object.entries(patch)) {
    const old = (prev as Record<string, unknown>)[k];
    if (old === v) continue;
    if (v && old && typeof v === 'object' && typeof old === 'object' && JSON.stringify(v) === JSON.stringify(old)) continue;
    return false;
  }
  return true;
}

/**
 * Merge entities into a map by id. Unchanged entities keep their old object,
 * and if nothing changed the old map comes back as is, so components watching
 * them don't re-render (every message carries its author, for example).
 */
function mergeInto<T extends { id: number }>(map: Record<number, T>, items: (Partial<T> & { id: number } | null | undefined)[] | undefined): Record<number, T> {
  if (!items?.length) return map;
  let next: Record<number, T> | null = null;
  for (const item of items) {
    if (!item) continue;
    const prev = (next ?? map)[item.id];
    if (prev && hasAll(prev, item)) continue;
    next ??= { ...map };
    next[item.id] = { ...prev, ...item } as T;
  }
  return next ?? map;
}

function mergeUsers(s: State, users: (User | null | undefined)[] | undefined): Record<number, User> {
  return mergeInto(s.users, users);
}

function mergeCharacters(s: State, chars: (Character | null | undefined)[] | undefined): Record<number, Character> {
  return mergeInto(s.characters, chars);
}

function insertSorted(list: Message[], msg: Message): Message[] {
  const idx = list.findIndex((m) => m.id >= msg.id);
  if (idx === -1) return [...list, msg];
  if (list[idx].id === msg.id) {
    const copy = list.slice();
    copy[idx] = { ...list[idx], ...msg };
    return copy;
  }
  return [...list.slice(0, idx), msg, ...list.slice(idx)];
}

function updateMessage(s: State, channelId: number, messageId: number, fn: (m: Message) => Message): Partial<State> {
  const cache = s.messages[channelId];
  if (!cache) return {};
  const idx = cache.list.findIndex((m) => m.id === messageId);
  if (idx === -1) return {};
  const list = cache.list.slice();
  list[idx] = fn(list[idx]);
  return { messages: { ...s.messages, [channelId]: { ...cache, list } } };
}

function sameEmoji(a: ReactionEmoji, b: ReactionEmoji): boolean {
  return a.id != null || b.id != null ? a.id === b.id : a.name === b.name;
}

export function persistUi() {
  const s = getState();
  save('lastChannels', s.lastChannelByServer);
  save('collapsed', s.collapsedCategories);
  save('memberList', s.memberListOpen);
  save('persona', s.globalPersona);
  save('listening', s.listening);
  save('seated', s.seated);
  save('selfMute', s.voice.selfMute);
  save('selfDeaf', s.voice.selfDeaf);
}

// ---------------------------------------------------------------------------
// READY
// ---------------------------------------------------------------------------

function flattenServer(p: ServerPayload) {
  const { roles, channels, members, emojis, users: _u, characters: _c, voice_states, jukebox, theater, board: boardState, ...server } = p;
  return { server: server as Server, roles, channels, members, emojis, voiceStates: voice_states ?? [], jukebox, theater, board: boardState };
}

export function applyReady(d: ReadyPayload) {
  const servers: Record<number, Server> = {};
  let roles: Role[] = [];
  let channels: Channel[] = [...d.private_channels];
  const members: Record<number, Record<number, Member>> = {};
  let emojis: Emoji[] = [];
  const voiceStates: Record<number, VoiceState> = {};
  const jukebox: Record<number, JukeboxState> = {};
  const theater: Record<number, TheaterState> = {};
  const board: Record<number, ServerBoard> = {};
  for (const sp of d.servers) {
    const f = flattenServer(sp);
    servers[f.server.id] = f.server;
    roles = roles.concat(f.roles);
    channels = channels.concat(f.channels);
    emojis = emojis.concat(f.emojis);
    members[f.server.id] = Object.fromEntries(f.members.map((m) => [m.user_id, m]));
    for (const vs of f.voiceStates) voiceStates[vs.user_id] = vs;
    if (f.jukebox) jukebox[f.server.id] = f.jukebox;
    if (f.theater) theater[f.server.id] = f.theater;
    if (f.board) board[f.server.id] = f.board;
  }
  const channelPersonas: Record<number, Record<number, number>> = {};
  for (const p of d.personas ?? []) {
    channelPersonas[p.channel_id] = { ...channelPersonas[p.channel_id], [p.user_id]: p.character_id };
  }
  const readStates: Record<number, ReadState> = {};
  const personaByChannel: Record<number, number> = {};
  for (const rs of d.read_states) {
    readStates[rs.channel_id] = rs;
    if (rs.last_character_id !== null && rs.last_character_id !== undefined) personaByChannel[rs.channel_id] = rs.last_character_id;
  }
  const users = byId(d.users);
  users[d.user.id] = { ...users[d.user.id], ...toPublicUser(d.user, users[d.user.id]?.status) };
  mentionsCounted.clear();

  setState((s) => {
    // Keep the open channel's messages to show while it reloads, as a new
    // window: anything still loading for the old one is stale now.
    const keep: Record<number, ChannelMessages> = {};
    const channelMap = byId(channels);
    for (const [id, cache] of Object.entries(s.messages)) {
      if (channelMap[Number(id)] && Number(id) === s.activeChannelId) {
        keep[Number(id)] = { ...cache, loaded: false, loadingBefore: false, loadingAfter: false, catchingUp: false, gen: newWindowGen() };
      }
    }
    return {
      status: 'ready',
      connected: true,
      me: d.user,
      users,
      characters: byId(d.characters),
      servers,
      roles: byId(roles),
      channels: channelMap,
      members,
      emojis: byId(emojis),
      readStates,
      personaByChannel,
      messages: keep,
      typing: {},
      maxUploadMb: d.limits?.max_upload_mb ?? s.maxUploadMb,
      voiceStates,
      jukebox,
      theater,
      board,
      channelPersonas,
      // Sheets may have changed while we were away; refetch when opened.
      sheets: Object.fromEntries(Object.entries(s.sheets).map(([k, v]) => [k, { ...v, stale: true }])),
    };
  });
  emit('ready');
}

export function toPublicUser(me: Me, presence?: User['status']): User {
  return {
    id: me.id,
    username: me.username,
    display_name: me.display_name,
    avatar: me.avatar,
    banner_color: me.banner_color,
    about: me.about,
    created_at: me.created_at,
    status: presence ?? (me.status === 'invisible' ? 'offline' : me.status),
  };
}

export function resetSession() {
  setState({
    ...initialData,
    status: 'anonymous',
    connected: false,
    settings: null,
    modals: [],
    contextMenu: null,
    jukeboxView: null,
    theaterView: null,
    boardView: null,
    sheetView: null,
  });
  // Logged out: the jukebox and the theater stop.
  emit('session-reset');
}

// ---------------------------------------------------------------------------
// Gateway dispatch
// ---------------------------------------------------------------------------

/** Find the server whose board has this id (token and drawing events carry only the board's id). */
function boardSlice(s: State, boardId: number): { serverId: number; sb: ServerBoard } | null {
  for (const [key, sb] of Object.entries(s.board)) {
    if (sb.board?.id === boardId) return { serverId: Number(key), sb };
  }
  return null;
}

type Handler = (d: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const handlers: Record<string, Handler> = {
  MESSAGE_CREATE(m: Message) {
    setState((s) => {
      const next: Partial<State> = {
        users: mergeUsers(s, [m.author]),
        characters: mergeCharacters(s, [m.character]),
      };
      const channel = s.channels[m.channel_id];
      if (channel && m.id > (channel.last_message_id ?? 0)) next.channels = { ...s.channels, [channel.id]: { ...channel, last_message_id: m.id } };

      const cache = s.messages[m.channel_id];
      // Live: loaded, showing the present, and not in the middle of catching up.
      const live = !!cache && cache.loaded && !cache.hasMoreAfter && !cache.catchingUp;
      if (live && readingBackIn.has(m.channel_id) && cache.list.length >= MESSAGE_WINDOW + WINDOW_SLACK) {
        // You're reading further up and the window is full: it stays as it is,
        // and newer messages load when you scroll down (or Jump To Present).
        next.messages = { ...s.messages, [m.channel_id]: { ...cache, hasMoreAfter: true } };
      } else if (live) {
        let list = insertSorted(cache.list, m);
        let hasMoreBefore = cache.hasMoreBefore;
        // Out of sight, a channel only keeps its newest messages (the open one
        // trims itself while you're at the bottom: see MessageList).
        if (m.channel_id !== s.activeChannelId && list.length > IDLE_MESSAGES + 25) {
          list = list.slice(-IDLE_MESSAGES);
          hasMoreBefore = true;
        }
        next.messages = { ...s.messages, [m.channel_id]: { ...cache, list, hasMoreBefore } };
      }
      if (m.nonce && s.pending[m.channel_id]?.some((p) => p.nonce === m.nonce)) {
        next.pending = { ...s.pending, [m.channel_id]: s.pending[m.channel_id].filter((p) => p.nonce !== m.nonce) };
      }
      const typing = s.typing[m.channel_id];
      if (typing?.[m.author_id]) {
        const t = { ...typing };
        delete t[m.author_id];
        next.typing = { ...s.typing, [m.channel_id]: t };
      }
      const rs = s.readStates[m.channel_id] ?? { channel_id: m.channel_id, last_read_id: 0, last_character_id: null, mention_count: 0 };
      if (s.me && m.author_id === s.me.id) {
        next.readStates = { ...s.readStates, [m.channel_id]: { ...rs, last_read_id: Math.max(rs.last_read_id, m.id), mention_count: 0 } };
      } else if (s.me && messageMentionsMe(s, m) && isNewMention(rs, m.id)) {
        next.readStates = { ...s.readStates, [m.channel_id]: { ...rs, mention_count: rs.mention_count + 1 } };
      }
      return next;
    });
    emit('message-create', m);
  },

  MESSAGE_UPDATE(d: Partial<Message> & { id: number; channel_id: number }) {
    setState((s) => {
      const next: Partial<State> = { ...updateMessage(s, d.channel_id, d.id, (m) => ({ ...m, ...d })) };
      if (d.author) next.users = mergeUsers(s, [d.author]);
      // Keep reply previews that quote this message in sync.
      if (d.content !== undefined) {
        const cache = (next.messages ?? s.messages)[d.channel_id];
        if (cache?.list.some((m) => m.reply_to?.id === d.id)) {
          const list = cache.list.map((m) => (m.reply_to?.id === d.id ? { ...m, reply_to: { ...m.reply_to, content: d.content } } : m));
          next.messages = { ...(next.messages ?? s.messages), [d.channel_id]: { ...cache, list } };
        }
      }
      return next;
    });
  },

  MESSAGE_DELETE(d: { id: number; channel_id: number; last_message_id?: number | null }) {
    setState((s) => {
      const next: Partial<State> = {};
      const cache = s.messages[d.channel_id];
      if (cache) {
        const list = cache.list
          .filter((m) => m.id !== d.id)
          .map((m) => (m.reply_to?.id === d.id ? { ...m, reply_to: { id: d.id, deleted: true } } : m));
        next.messages = { ...s.messages, [d.channel_id]: { ...cache, list } };
      }
      const channel = s.channels[d.channel_id];
      if (channel && d.last_message_id !== undefined) {
        next.channels = { ...s.channels, [channel.id]: { ...channel, last_message_id: d.last_message_id } };
      }
      if (s.editing?.messageId === d.id) next.editing = null;
      if (s.replyTo[d.channel_id]?.messageId === d.id) next.replyTo = { ...s.replyTo, [d.channel_id]: undefined };
      return next;
    });
  },

  MESSAGE_REACTION_ADD(d: { channel_id: number; message_id: number; user_id: number; emoji: ReactionEmoji }) {
    setState((s) =>
      updateMessage(s, d.channel_id, d.message_id, (m) => {
        const reactions = m.reactions.slice();
        const idx = reactions.findIndex((r) => sameEmoji(r.emoji, d.emoji));
        if (idx === -1) reactions.push({ emoji: d.emoji, count: 1, user_ids: [d.user_id] });
        else if (!reactions[idx].user_ids.includes(d.user_id)) {
          reactions[idx] = { ...reactions[idx], count: reactions[idx].count + 1, user_ids: [...reactions[idx].user_ids, d.user_id] };
        }
        return { ...m, reactions };
      }),
    );
  },

  MESSAGE_REACTION_REMOVE(d: { channel_id: number; message_id: number; user_id: number; emoji: ReactionEmoji }) {
    setState((s) =>
      updateMessage(s, d.channel_id, d.message_id, (m) => {
        const reactions = m.reactions
          .map((r) =>
            sameEmoji(r.emoji, d.emoji) && r.user_ids.includes(d.user_id)
              ? { ...r, count: r.count - 1, user_ids: r.user_ids.filter((u) => u !== d.user_id) }
              : r,
          )
          .filter((r) => r.count > 0);
        return { ...m, reactions };
      }),
    );
  },

  CHANNEL_PINS_UPDATE(d: { channel_id: number }) {
    setState((s) => ({ pinsVersion: { ...s.pinsVersion, [d.channel_id]: (s.pinsVersion[d.channel_id] ?? 0) + 1 } }));
  },

  TYPING_START(d: { channel_id: number; user_id: number; character_id: number | null; narrator?: boolean }) {
    setState((s) => ({
      typing: {
        ...s.typing,
        [d.channel_id]: {
          ...s.typing[d.channel_id],
          [d.user_id]: { characterId: d.character_id, narrator: d.narrator, until: Date.now() + 9000 },
        },
      },
    }));
  },

  CHANNEL_CREATE(d: Channel & { users?: User[]; characters?: Character[] }) {
    const { users, characters, ...channel } = d;
    setState((s) => ({
      channels: { ...s.channels, [channel.id]: { ...s.channels[channel.id], ...channel } },
      users: mergeUsers(s, users),
      characters: mergeCharacters(s, characters),
    }));
  },

  CHANNEL_UPDATE(d: Channel & { users?: User[]; characters?: Character[] }) {
    handlers.CHANNEL_CREATE(d);
  },

  CHANNEL_DELETE(d: { id: number }) {
    setState((s) => ({
      channels: omit(s.channels, [d.id]),
      messages: omit(s.messages, [d.id]),
      pending: omit(s.pending, [d.id]),
    }));
  },

  SERVER_CREATE(d: ServerPayload) {
    const f = flattenServer(d);
    setState((s) => {
      const voiceStates = { ...s.voiceStates };
      for (const vs of f.voiceStates) voiceStates[vs.user_id] = vs;
      return {
        servers: { ...s.servers, [f.server.id]: f.server },
        roles: { ...s.roles, ...byId(f.roles) },
        channels: { ...s.channels, ...byId(f.channels) },
        members: { ...s.members, [f.server.id]: Object.fromEntries(f.members.map((m) => [m.user_id, m])) },
        emojis: { ...s.emojis, ...byId(f.emojis) },
        users: mergeUsers(s, d.users),
        characters: mergeCharacters(s, d.characters),
        voiceStates,
        jukebox: f.jukebox ? { ...s.jukebox, [f.server.id]: f.jukebox } : s.jukebox,
        theater: f.theater ? { ...s.theater, [f.server.id]: f.theater } : s.theater,
        board: f.board ? { ...s.board, [f.server.id]: f.board } : s.board,
      };
    });
  },

  SERVER_UPDATE(d: Server) {
    setState((s) => (s.servers[d.id] ? { servers: { ...s.servers, [d.id]: { ...s.servers[d.id], ...d } } } : {}));
  },

  SERVER_DELETE(d: { id: number }) {
    setState((s) => {
      const channelIds = Object.values(s.channels)
        .filter((c) => c.server_id === d.id)
        .map((c) => c.id);
      const roleIds = Object.values(s.roles)
        .filter((r) => r.server_id === d.id)
        .map((r) => r.id);
      const emojiIds = Object.values(s.emojis)
        .filter((e) => e.server_id === d.id)
        .map((e) => e.id);
      const members = { ...s.members };
      delete members[d.id];
      const voiceStates = Object.fromEntries(Object.entries(s.voiceStates).filter(([, v]) => v.server_id !== d.id));
      return {
        servers: omit(s.servers, [d.id]),
        channels: omit(s.channels, channelIds),
        messages: omit(s.messages, channelIds),
        roles: omit(s.roles, roleIds),
        emojis: omit(s.emojis, emojiIds),
        members,
        voiceStates,
        jukebox: omit(s.jukebox, [d.id]),
        libraries: omit(s.libraries, [d.id]),
        theater: omit(s.theater, [d.id]),
        theaterLibraries: omit(s.theaterLibraries, [d.id]),
        board: omit(s.board, [d.id]),
        jukeboxView: s.jukeboxView?.serverId === d.id ? null : s.jukeboxView,
        theaterView: s.theaterView?.serverId === d.id ? null : s.theaterView,
        boardView: s.boardView?.serverId === d.id ? null : s.boardView,
        settings: s.settings?.kind === 'server' && s.settings.id === d.id ? null : s.settings,
      };
    });
    emit('server-gone', d.id);
  },

  MEMBER_ADD(d: { server_id: number; member: Member; users?: User[]; characters?: Character[] }) {
    setState((s) => ({
      members: { ...s.members, [d.server_id]: { ...s.members[d.server_id], [d.member.user_id]: d.member } },
      users: mergeUsers(s, d.users),
      characters: mergeCharacters(s, d.characters),
    }));
  },

  MEMBER_UPDATE(d: Member) {
    setState((s) => ({ members: { ...s.members, [d.server_id]: { ...s.members[d.server_id], [d.user_id]: d } } }));
  },

  MEMBER_REMOVE(d: { server_id: number; user_id: number }) {
    setState((s) => {
      const list = { ...s.members[d.server_id] };
      delete list[d.user_id];
      return { members: { ...s.members, [d.server_id]: list } };
    });
  },

  ROLES_UPDATE(d: { server_id: number; roles: Role[] }) {
    setState((s) => {
      const others = Object.values(s.roles).filter((r) => r.server_id !== d.server_id);
      return { roles: byId([...others, ...d.roles]) };
    });
  },

  ROLE_DELETE(d: { server_id: number; role_id: number }) {
    setState((s) => {
      const list = s.members[d.server_id] ?? {};
      const members = Object.fromEntries(
        Object.entries(list).map(([uid, m]) => [uid, { ...m, role_ids: m.role_ids.filter((r) => r !== d.role_id) }]),
      );
      return { roles: omit(s.roles, [d.role_id]), members: { ...s.members, [d.server_id]: members } };
    });
  },

  EMOJIS_UPDATE(d: { server_id: number; emojis: Emoji[] }) {
    setState((s) => {
      const others = Object.values(s.emojis).filter((e) => e.server_id !== d.server_id);
      return { emojis: byId([...others, ...d.emojis]) };
    });
  },

  USER_UPDATE(d: User) {
    setState((s) => ({ users: mergeInto(s.users, [d]) }));
  },

  ME_UPDATE(d: Me) {
    setState((s) => ({
      me: d,
      users: mergeInto(s.users, [toPublicUser(d, d.status === 'invisible' ? 'offline' : d.status)]),
    }));
  },

  PRESENCE_UPDATE(d: { user_id: number; status: User['status'] }) {
    setState((s) => (s.users[d.user_id] ? { users: mergeInto(s.users, [{ id: d.user_id, status: d.status }]) } : {}));
  },

  CHARACTER_CREATE(d: Character) {
    setState((s) => ({ characters: mergeInto(s.characters, [d]) }));
  },

  CHARACTER_UPDATE(d: Character) {
    handlers.CHARACTER_CREATE(d);
  },

  READ_STATE_UPDATE(d: { channel_id: number; last_read_id: number; mention_count: number }) {
    setState((s) => {
      const rs = s.readStates[d.channel_id] ?? { channel_id: d.channel_id, last_read_id: 0, last_character_id: null, mention_count: 0 };
      return {
        readStates: { ...s.readStates, [d.channel_id]: { ...rs, last_read_id: Math.max(rs.last_read_id, d.last_read_id), mention_count: d.mention_count } },
      };
    });
  },

  PERSONA_UPDATE(d: { channel_id: number; character_id: number }) {
    setState((s) => ({ personaByChannel: { ...s.personaByChannel, [d.channel_id]: d.character_id } }));
  },

  CHANNEL_PERSONA(d: { channel_id: number; user_id: number; character_id: number }) {
    setState((s) => ({
      channelPersonas: { ...s.channelPersonas, [d.channel_id]: { ...s.channelPersonas[d.channel_id], [d.user_id]: d.character_id } },
    }));
  },

  CHARACTER_SHEET_UPDATE(d: { character_id: number; patch: Partial<Sheet>; rev: number; updated_by: number }) {
    setState((s) => {
      const entry = s.sheets[d.character_id];
      if (!entry) return {};
      if (entry.sheet.rev + 1 !== d.rev) {
        return entry.sheet.rev >= d.rev ? {} : { sheets: { ...s.sheets, [d.character_id]: { ...entry, stale: true } } };
      }
      const sheet = mergePatch(entry.sheet, d.patch);
      return { sheets: { ...s.sheets, [d.character_id]: { ...entry, sheet: { ...sheet, rev: d.rev } } } };
    });
    emit('sheet-update', d);
  },

  // -- voice -------------------------------------------------------------------------
  VOICE_STATE_UPDATE(d: VoiceState) {
    setState((s) => {
      if (d.channel_id === null) {
        if (!s.voiceStates[d.user_id] || s.voiceStates[d.user_id].joined_at !== d.joined_at) return {};
        return { voiceStates: omit(s.voiceStates, [d.user_id]) };
      }
      return { voiceStates: { ...s.voiceStates, [d.user_id]: d } };
    });
    emit('voice-state', d);
  },

  VOICE_SPEAKING(d: { user_id: number; channel_id: number; speaking: boolean }) {
    setState((s) => {
      const vs = s.voiceStates[d.user_id];
      if (!vs || vs.channel_id !== d.channel_id || vs.speaking === d.speaking) return {};
      return { voiceStates: { ...s.voiceStates, [d.user_id]: { ...vs, speaking: d.speaking } } };
    });
  },

  VOICE_SIGNAL(d: unknown) {
    emit('voice-signal', d);
  },
  VOICE_JOIN_ERROR(d: unknown) {
    emit('voice-join-error', d);
  },
  VOICE_FORCE_DISCONNECT(d: unknown) {
    emit('voice-force-disconnect', d);
  },
  VOICE_MOVED(d: unknown) {
    emit('voice-moved', d);
  },
  VOICE_SESSION_REPLACED(d: unknown) {
    emit('voice-replaced', d);
  },

  // -- jukebox -------------------------------------------------------------------------
  JUKEBOX_STATE(d: JukeboxState) {
    // Changes are numbered; an older one arriving late mustn't undo a newer one.
    if ((getState().jukebox[d.server_id]?.rev ?? -1) > d.rev) return;
    setState((s) => {
      const lib = s.libraries[d.server_id];
      const next: Partial<State> = { jukebox: { ...s.jukebox, [d.server_id]: d } };
      if (lib) {
        const tracks = { ...lib.tracks };
        for (const t of Object.values(d.tracks)) tracks[t.id] = { ...tracks[t.id], ...t };
        next.libraries = { ...s.libraries, [d.server_id]: { ...lib, tracks } };
      }
      return next;
    });
    emit('jukebox-state', d);
  },

  JUKEBOX_TRACK_UPDATE(d: Track) {
    setState((s) => {
      const next: Partial<State> = {};
      const lib = s.libraries[d.server_id];
      if (lib) next.libraries = { ...s.libraries, [d.server_id]: { ...lib, tracks: { ...lib.tracks, [d.id]: { ...lib.tracks[d.id], ...d } } } };
      const jb = s.jukebox[d.server_id];
      if (jb?.tracks[String(d.id)]) next.jukebox = { ...s.jukebox, [d.server_id]: { ...jb, tracks: { ...jb.tracks, [String(d.id)]: d } } };
      return next;
    });
  },

  JUKEBOX_TRACK_DELETE(d: { server_id: number; track_id: number }) {
    setState((s) => {
      const lib = s.libraries[d.server_id];
      if (!lib) return {};
      return { libraries: { ...s.libraries, [d.server_id]: { ...lib, tracks: omit(lib.tracks, [d.track_id]) } } };
    });
  },

  JUKEBOX_LISTENERS(d: { server_id: number; user_ids: number[] }) {
    setState((s) => {
      const jb = s.jukebox[d.server_id];
      return jb ? { jukebox: { ...s.jukebox, [d.server_id]: { ...jb, listeners: d.user_ids } } } : {};
    });
  },

  // -- theater -------------------------------------------------------------------------
  THEATER_STATE(d: TheaterState) {
    if ((getState().theater[d.server_id]?.rev ?? -1) > d.rev) return;
    setState((s) => {
      const lib = s.theaterLibraries[d.server_id];
      const next: Partial<State> = { theater: { ...s.theater, [d.server_id]: d } };
      if (lib) {
        const videos = { ...lib.videos };
        for (const v of Object.values(d.videos)) videos[v.id] = { ...videos[v.id], ...v };
        next.theaterLibraries = { ...s.theaterLibraries, [d.server_id]: { ...lib, videos } };
      }
      return next;
    });
    emit('theater-state', d);
  },

  THEATER_VIDEO_UPDATE(d: Video) {
    setState((s) => {
      const next: Partial<State> = {};
      const lib = s.theaterLibraries[d.server_id];
      if (lib) next.theaterLibraries = { ...s.theaterLibraries, [d.server_id]: { ...lib, videos: { ...lib.videos, [d.id]: { ...lib.videos[d.id], ...d } } } };
      const th = s.theater[d.server_id];
      if (th?.videos[String(d.id)]) next.theater = { ...s.theater, [d.server_id]: { ...th, videos: { ...th.videos, [String(d.id)]: d } } };
      return next;
    });
    emit('theater-video', d);
  },

  THEATER_VIDEO_DELETE(d: { server_id: number; video_id: number }) {
    setState((s) => {
      const lib = s.theaterLibraries[d.server_id];
      if (!lib) return {};
      return { theaterLibraries: { ...s.theaterLibraries, [d.server_id]: { ...lib, videos: omit(lib.videos, [d.video_id]) } } };
    });
  },

  THEATER_SEATS(d: { server_id: number; user_ids: number[] }) {
    setState((s) => {
      const th = s.theater[d.server_id];
      return th ? { theater: { ...s.theater, [d.server_id]: { ...th, listeners: d.user_ids } } } : {};
    });
  },

  // -- game board ---------------------------------------------------------------------
  BOARD_STATE(d: ServerBoard) {
    setState((s) => {
      const prev = s.board[d.server_id];
      // Changes are numbered: an older board arriving late mustn't undo a newer one.
      const keep = !!prev?.board && !!d.board && d.board.id === prev.board.id && d.board.rev < prev.board.rev;
      return { board: { ...s.board, [d.server_id]: keep && prev ? { ...d, board: prev.board! } : d } };
    });
  },

  BOARD_TOKEN_CREATE(t: BoardToken) {
    setState((s) => {
      const hit = boardSlice(s, t.board_id);
      if (!hit?.sb.board) return {};
      const cur = hit.sb.board;
      const tokens = cur.tokens.some((x) => x.id === t.id) ? cur.tokens.map((x) => (x.id === t.id ? t : x)) : [...cur.tokens, t];
      return { board: { ...s.board, [hit.serverId]: { ...hit.sb, board: { ...cur, tokens } } } };
    });
  },

  BOARD_TOKEN_UPDATE(t: BoardToken) {
    handlers.BOARD_TOKEN_CREATE(t);
  },

  BOARD_TOKEN_DELETE(d: { server_id: number; board_id: number; token_id: number }) {
    setState((s) => {
      const cur = s.board[d.server_id]?.board;
      if (!cur || cur.id !== d.board_id) return {};
      return {
        board: {
          ...s.board,
          [d.server_id]: { ...s.board[d.server_id], board: { ...cur, tokens: cur.tokens.filter((t) => t.id !== d.token_id) } },
        },
      };
    });
  },

  BOARD_DRAW_ADD(d: BoardDrawing) {
    setState((s) => {
      const hit = boardSlice(s, d.board_id);
      if (!hit?.sb.board) return {};
      const cur = hit.sb.board;
      const drawings = cur.drawings.some((x) => x.id === d.id) ? cur.drawings.map((x) => (x.id === d.id ? d : x)) : [...cur.drawings, d];
      return { board: { ...s.board, [hit.serverId]: { ...hit.sb, board: { ...cur, drawings } } } };
    });
  },

  BOARD_DRAW_DELETE(d: { server_id: number; board_id: number; drawing_id: number }) {
    setState((s) => {
      const cur = s.board[d.server_id]?.board;
      if (!cur || cur.id !== d.board_id) return {};
      return {
        board: {
          ...s.board,
          [d.server_id]: { ...s.board[d.server_id], board: { ...cur, drawings: cur.drawings.filter((x) => x.id !== d.drawing_id) } },
        },
      };
    });
  },

  BOARD_DRAWS_CLEAR(d: { server_id: number; board_id: number }) {
    setState((s) => {
      const cur = s.board[d.server_id]?.board;
      if (!cur || cur.id !== d.board_id || !cur.drawings.length) return {};
      return { board: { ...s.board, [d.server_id]: { ...s.board[d.server_id], board: { ...cur, drawings: [] } } } };
    });
  },

  BOARD_VIEWERS(d: { server_id: number; user_ids: number[] }) {
    setState((s) => {
      const sb = s.board[d.server_id];
      return sb ? { board: { ...s.board, [d.server_id]: { ...sb, viewers: d.user_ids } } } : {};
    });
  },

  // Live pointers: nothing to store — the board renders them straight from the
  // event (they move too often to live in React state).
  BOARD_CURSOR(d: { server_id: number; user_id: number; x: number; y: number; tool: string }) {
    emit('board-cursor', d);
  },

  BOARD_CURSORS(d: { server_id: number; cursors: { user_id: number; x: number; y: number; tool: string }[] }) {
    emit('board-cursors', d);
  },
};

export function dispatch(t: string, d: unknown) {
  const handler = handlers[t];
  if (handler) handler(d);
}

function messageMentionsMe(s: State, m: Message): boolean {
  if (!s.me) return false;
  // As on the server (services.create_message): only ordinary messages ping.
  // Rolls, private rolls and notices like "X joined" never do.
  if (m.type !== MessageType.DEFAULT || m.dm_only) return false;
  const channel = s.channels[m.channel_id];
  if (channel && channel.server_id === null) return true; // every DM message counts
  return m.mention_everyone || m.mentions.includes(s.me.id);
}

// Expire typing indicators.
setInterval(() => {
  const s = getState();
  const now = Date.now();
  let changed = false;
  const typing: State['typing'] = {};
  for (const [cid, entries] of Object.entries(s.typing)) {
    const kept: Record<number, TypingEntry> = {};
    for (const [uid, e] of Object.entries(entries)) {
      if (e.until > now) kept[Number(uid)] = e;
      else changed = true;
    }
    typing[Number(cid)] = kept;
  }
  if (changed) setState({ typing });
}, 1000);

export { emptyMessages };
