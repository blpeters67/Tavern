export type Presence = 'online' | 'idle' | 'dnd' | 'offline';
export type StatusChoice = 'online' | 'idle' | 'dnd' | 'invisible';

export const ChannelType = { TEXT: 0, DM: 1, VOICE: 2, GROUP_DM: 3, CATEGORY: 4 } as const;
export const MessageType = {
  DEFAULT: 0,
  RECIPIENT_ADD: 1,
  RECIPIENT_REMOVE: 2,
  CHANNEL_NAME_CHANGE: 4,
  CHANNEL_PINNED_MESSAGE: 6,
  MEMBER_JOIN: 7,
  ROLL: 20,
} as const;

/** Persona ids: 0 = yourself, -1 = the narrator (Dungeon Masters), >0 = a character. */
export const NARRATOR = -1;

export interface User {
  id: number;
  username: string;
  display_name: string | null;
  avatar: string | null;
  banner_color: number | null;
  about: string | null;
  created_at: string;
  status: Presence;
  custom_status?: string | null;
}

export interface Settings {
  switch_picker: boolean;
  switch_proxy: boolean;
  switch_hotkey: boolean;
  switch_remember: boolean;
  immersive: boolean;
  format_toolbar: boolean;
  ic_cards: boolean;
  ic_serif: boolean;
  dice_animations: boolean;
  /** Animate text effects (off: they stay still but keep their colours). */
  fx_motion: boolean;
  dice_sounds: boolean;
  voice_sounds: boolean;
}

export interface Me extends Omit<User, 'status'> {
  email: string;
  status: StatusChoice;
  settings: Settings;
  is_admin: boolean;
}

export interface CharacterSummary {
  level: number;
  classes: string;
  species: string;
  alignment: string;
  ac: number;
  hp: { current: number; max: number; temp: number };
  gold: number;
}

export interface Character {
  id: number;
  owner_id: number;
  name: string;
  avatar: string | null;
  color: string | null;
  position: number;
  deleted: boolean;
  sheet_visibility: 'public' | 'private';
  has_sheet: boolean;
  sheet_rev: number;
  summary?: CharacterSummary | null;
  proxy_prefix?: string | null;
  proxy_suffix?: string | null;
}

export interface Role {
  id: number;
  server_id: number;
  name: string;
  color: number;
  permissions: number;
  position: number;
  hoist: boolean;
  mentionable: boolean;
  is_default: boolean;
}

export interface Overwrite {
  type: 0 | 1; // 0 = role, 1 = member
  id: number;
  allow: number;
  deny: number;
}

export interface Channel {
  id: number;
  type: number;
  server_id: number | null;
  name: string | null;
  topic: string | null;
  parent_id: number | null;
  position: number;
  last_message_id: number | null;
  overwrites?: Overwrite[];
  recipient_ids?: number[];
  owner_id?: number | null;
  icon?: string | null;
  /** Sidebar icon: a unicode emoji or "c:<custom emoji id>". */
  emoji?: string | null;
  user_limit?: number;
  /** Voice spaces: everyone's microphone bitrate here, in kbps. */
  bitrate?: number;
}

export interface Member {
  user_id: number;
  server_id: number;
  role_ids: number[];
  joined_at: string;
}

export interface Emoji {
  id: number;
  server_id: number;
  name: string;
  animated: boolean;
  creator_id: number | null;
}

export interface Server {
  id: number;
  name: string;
  icon: string | null;
  owner_id: number;
  system_channel_id: number | null;
  tagline: string | null;
  narrator_name: string;
  roleplay_mode: boolean;
  created_at?: string;
}

export interface ServerPayload extends Server {
  roles: Role[];
  channels: Channel[];
  members: Member[];
  emojis: Emoji[];
  voice_states?: VoiceState[];
  jukebox?: JukeboxState;
  theater?: TheaterState;
  board?: ServerBoard;
  users?: User[];
  characters?: Character[];
}

// ---------------------------------------------------------------------------
// Voice
// ---------------------------------------------------------------------------

export interface VoiceState {
  user_id: number;
  server_id: number;
  channel_id: number | null;
  self_mute: boolean;
  self_deaf: boolean;
  mute: boolean;
  deaf: boolean;
  self_video: boolean;
  self_stream: boolean;
  speaking: boolean;
  joined_at: number;
}

// ---------------------------------------------------------------------------
// Jukebox
// ---------------------------------------------------------------------------

export interface Track {
  id: number;
  server_id: number;
  title: string;
  artist: string | null;
  album: string | null;
  tags: string[];
  duration_ms: number;
  url: string | null;
  cover_url: string | null;
  gain_db: number;
  source_url: string | null;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  uploader_id: number | null;
  created_at: string;
  progress?: number;
}

export interface QueueEntry {
  qid: string;
  track_id: number;
  added_by: number | null;
}

export interface JukeboxState {
  server_id: number;
  queue: QueueEntry[];
  current: QueueEntry | null;
  history: QueueEntry[];
  playing: boolean;
  started_at: number | null;
  position: number;
  volume: number;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  fade: boolean;
  transition: { kind: 'fade_out'; until: number; then: 'pause' | 'skip' } | null;
  rev: number;
  updated_by: number | null;
  tracks: Record<string, Track>;
  server_now: number;
  listeners: number[];
}

// ---------------------------------------------------------------------------
// Theater
// ---------------------------------------------------------------------------

export interface Video {
  id: number;
  server_id: number;
  /** A YouTube video (plays in YouTube's player) or an uploaded file. */
  kind: 'youtube' | 'file';
  youtube_id: string | null;
  title: string;
  channel: string | null;
  tags: string[];
  /** 0 when unknown (a viewer's player reports it) or for live streams. */
  duration_ms: number;
  live: boolean;
  /** Uploaded files only, once they're ready. */
  url: string | null;
  mime: string | null;
  width: number | null;
  height: number | null;
  thumbnail_url: string | null;
  source_url: string | null;
  status: 'processing' | 'ready' | 'failed';
  error: string | null;
  uploader_id: number | null;
  created_at: string;
  progress?: number;
}

export interface VideoQueueEntry {
  qid: string;
  video_id: number;
  added_by: number | null;
}

export interface TheaterState {
  server_id: number;
  queue: VideoQueueEntry[];
  current: VideoQueueEntry | null;
  history: VideoQueueEntry[];
  playing: boolean;
  started_at: number | null;
  position: number;
  repeat: 'off' | 'all' | 'one';
  shuffle: boolean;
  rev: number;
  updated_by: number | null;
  videos: Record<string, Video>;
  server_now: number;
  /** Who has taken a seat. */
  listeners: number[];
}

// ---------------------------------------------------------------------------
// Game board
// ---------------------------------------------------------------------------

/** The ring colours: ally is green, enemy is red, everything else is grey. */
export type Disposition = 'ally' | 'neutral' | 'enemy';

export interface BoardToken {
  id: number;
  board_id: number;
  /** A player character's token (wears the character's picture and hit points)… */
  character_id: number | null;
  name: string;
  avatar: string | null;
  /** The middle of the token, in board units. */
  x: number;
  y: number;
  disposition: Disposition;
  /** How many grid squares wide the token is. */
  size: number;
  owner_id: number | null;
  /** Free tokens carry their own hit points; character tokens show the sheet's. */
  hp: { current: number; max: number } | null;
}

export interface BoardDrawing {
  id: number;
  board_id: number;
  kind: 'pen' | 'arrow' | 'line' | 'rect' | 'ellipse' | 'text';
  color: string;
  width: number;
  data:
    | { points: [number, number][] }
    | { from: [number, number]; to: [number, number] }
    | { at: [number, number]; text: string; size: number };
  author_id: number | null;
}

export interface TrackerEntry {
  id: string;
  name: string;
  token_id?: number | null;
  current?: boolean;
  initiative?: number | string;
}

export interface Board {
  id: number;
  name: string;
  background_url: string | null;
  bg_width: number | null;
  bg_height: number | null;
  grid_size: number;
  snap: boolean;
  /** The text channel this board's rolls post to (top-bar chip picks it). */
  channel_id: number | null;
  tokens: BoardToken[];
  drawings: BoardDrawing[];
  tracker: TrackerEntry[];
  rev: number;
}

/** Everything about a server's boards: the list, the active one, who has it open. */
export interface ServerBoard {
  server_id: number;
  boards: { id: number; name: string }[];
  active_id: number | null;
  board: Board | null;
  viewers: number[];
}

// ---------------------------------------------------------------------------
// Dice
// ---------------------------------------------------------------------------

export interface DieRoll {
  v: number;
  drop?: boolean;
  exp?: boolean;
}

export type RollTerm =
  | { kind: 'dice'; sign: number; count: number; sides: number; rolls: DieRoll[]; value: number }
  | { kind: 'num'; sign: number; value: number };

export interface RollPart {
  label: string;
  expression: string;
  total: number;
  terms: RollTerm[];
  d20?: number | null;
  crit?: boolean;
  fumble?: boolean;
  crit_damage?: boolean;
  note?: string;
}

export interface RollData {
  v: 1;
  title: string;
  parts: RollPart[];
  kind: string;
  key: string | null;
  adv?: 'adv' | 'dis';
  dc?: number;
  outcome?: 'success' | 'failure';
  flavor?: string;
  rolled_by: number;
  character_id: number | null;
  for_user_id: number;
  private: boolean;
  narrator: boolean;
}

export interface Attachment {
  id: number;
  filename: string;
  content_type: string;
  size: number;
  width: number | null;
  height: number | null;
  url: string;
  /** A smaller WebP of a big image, for showing in chat (the original opens on click). */
  preview_url?: string;
}

export interface EmbedMedia {
  url: string;
  width: number | null;
  height: number | null;
}

export interface Embed {
  type: 'link' | 'image' | 'video' | 'gifv';
  url: string;
  title?: string | null;
  description?: string | null;
  site_name?: string | null;
  color?: number | null;
  provider?: string;
  thumbnail?: EmbedMedia;
  image?: EmbedMedia;
  video?: EmbedMedia;
}

export interface ReactionEmoji {
  id: number | null;
  name: string;
  animated: boolean;
}

export interface ReactionGroup {
  emoji: ReactionEmoji;
  count: number;
  user_ids: number[];
}

export interface ReplyRef {
  id: number;
  deleted: boolean;
  author_id?: number;
  character_id?: number | null;
  content?: string;
  has_attachments?: boolean;
  author?: User | null;
  character?: Character | null;
}

export interface Message {
  id: number;
  channel_id: number;
  type: number;
  author_id: number;
  character_id: number | null;
  author: User | null;
  character: Character | null;
  content: string;
  created_at: string;
  edited_at: string | null;
  pinned: boolean;
  mention_everyone: boolean;
  mentions: number[];
  mention_reply: boolean;
  attachments: Attachment[];
  embeds: Embed[];
  reactions: ReactionGroup[];
  reply_to: ReplyRef | null;
  meta: ({ roll?: RollData; narrator?: boolean; message_id?: number } & Record<string, unknown>) | null;
  dm_only?: boolean;
  /** Sent with the book look on: roleplay prose styling. */
  book?: boolean;
  nonce?: string;
  pinned_at?: string | null;
}

/** A message we're still sending (or that failed). */
export interface PendingMessage {
  nonce: string;
  channel_id: number;
  character_id: number | null;
  narrator?: boolean;
  book?: boolean;
  content: string;
  created_at: string;
  reply_to: ReplyRef | null;
  files: { name: string; size: number; type: string }[];
  progress: number; // 0..1 upload progress
  error: string | null;
  retry?: () => void;
}

export interface ReadState {
  channel_id: number;
  last_read_id: number;
  last_character_id: number | null;
  mention_count: number;
  /** From READY: the newest mention that mention_count already includes. */
  last_mention_id?: number;
}

export interface ChannelMessages {
  list: Message[];
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  loaded: boolean;
  loadingBefore: boolean;
  loadingAfter: boolean;
  /** Which window this is: new whenever the list is replaced wholesale, so
   * requests made for an earlier window can tell they no longer fit. */
  gen: number;
  /** Fetching messages that arrived while the window loaded. Live messages
   * wait meanwhile (the catch-up fetches them), so none lands after a gap. */
  catchingUp: boolean;
}

export interface TypingEntry {
  characterId: number | null;
  narrator?: boolean;
  until: number;
}

export interface ReadyPayload {
  user: Me;
  session_id: number;
  servers: ServerPayload[];
  private_channels: Channel[];
  users: User[];
  characters: Character[];
  read_states: ReadState[];
  personas?: { channel_id: number; user_id: number; character_id: number }[];
  limits?: { max_upload_mb: number; board_max_mb?: number };
}

export interface InviteInfo {
  code: string;
  url: string;
  server: { id: number; name: string; icon: string | null };
  channel_id: number | null;
  inviter: User | null;
  member_count: number;
  online_count: number;
  expires_at: string | null;
  uses?: number;
  max_uses?: number;
  created_at?: string;
}
