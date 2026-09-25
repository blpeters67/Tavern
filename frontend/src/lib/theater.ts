/**
 * The theater: videos everyone watches together, following the server's
 * shared clock the same way the jukebox does (lib/jukebox.ts):
 *
 *   position = serverNow() - started_at
 *
 * Two kinds of video:
 *  - YouTube videos play in YouTube's own player. It lives in a small page of
 *    ours (/theater-frame.html) instead of straight in the app, because YouTube
 *    won't play for a page it can't identify and a picture-in-picture window
 *    has no web address of its own.
 *  - Uploaded videos play in a plain <video>.
 *
 * YouTube's rules for embedded players shape the rest: the player must be
 * visible while it plays (at least 200 × 200 pixels, nothing drawn over it),
 * so the screen sits in the theater card, floats in a corner when the card is
 * out of sight, and never plays hidden. Taking a seat is what starts it.
 *
 * Staying together: YouTube's player can't play a little faster or slower, so
 * it's corrected by seeking once it's more than 1.5 s off (and it backs off if
 * a seek didn't stick, which usually means an ad is playing). Uploaded videos
 * catch up smoothly at ±3% speed, like the jukebox.
 */

import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { api, errorMessage } from '../api/http';
import { toast } from '../components/Toasts';
import { canControlTheater } from '../store/selectors';
import { getState, persistUi, setState, useStore, type State } from '../store/store';
import type { TheaterState, Video } from '../store/types';
import { serverNow } from './clock';
import { setDuck } from './duck';
import { on } from './events';
import { outputDeviceId } from './sounds';
import { load, save } from './storage';

/** Where the person wants the screen: in its card (floating when the card is out of sight), popped out, big, or picture-in-picture. */
export type Placement = 'panel' | 'float' | 'expanded' | 'pip';
/** Where the screen actually is right now. */
export type ScreenMode = 'hidden' | 'docked' | 'floating' | 'expanded' | 'pip';
export type PlayerStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'buffering' | 'ended';

const YT_API = 'https://www.youtube.com/iframe_api';
const FRAME_PAGE = '/theater-frame.html';
/** YouTube is corrected (by seeking) once it's this far off for 3 readings in a row. */
const YT_DRIFT_MS = 1500;
/** Uploaded videos: seek beyond this, catch up gently between the two below. */
const FILE_SEEK_MS = 2500;
const NUDGE_START_MS = 300;
const NUDGE_STOP_MS = 60;
const NUDGE_RATE = 0.03;
/** How loud the jukebox may be while a video's sound plays. */
const DUCK_LEVEL = 0.3;
const TICK_MS = 500;

interface TheaterUi {
  /** My volume, 0..100 (this browser). */
  myVolume: number;
  muted: boolean;
  /** The browser blocked sound until a click: playing muted for now. */
  needsGesture: boolean;
  status: PlayerStatus;
  buffering: boolean;
  /** Where everyone is (ms), refreshed while a seat is taken. */
  position: number;
  /** Length the player found, for videos the library doesn't know the length of. */
  playerDuration: number;
  /** I paused my own screen (clicked the video): everyone else carries on. */
  localPause: boolean;
  error: { videoId: number | null; message: string } | null;
  placement: Placement;
  mode: ScreenMode;
  /** Width / height of the picture. */
  aspect: number;
  /** The video on my screen. */
  onScreen: number | null;
  /** An uploaded video is in the browser's own picture-in-picture. */
  nativePip: boolean;
}

export const useTheater = create<TheaterUi>(() => ({
  myVolume: load<number>('theaterVolume', 80),
  muted: load<boolean>('theaterMuted', false),
  needsGesture: false,
  status: 'idle',
  buffering: false,
  position: 0,
  playerDuration: 0,
  localPause: false,
  error: null,
  placement: 'panel',
  mode: 'hidden',
  aspect: 16 / 9,
  onScreen: null,
  nativePip: false,
}));

export function theaterPosition(st: TheaterState | undefined): number {
  if (!st?.current) return 0;
  if (st.playing && st.started_at) return Math.max(0, serverNow() - st.started_at);
  return st.position || 0;
}

export function currentVideo(st: TheaterState | undefined): Video | undefined {
  if (!st?.current) return undefined;
  return st.videos[String(st.current.video_id)];
}

/** The video's length: the library's, or what the player found. */
export function videoDuration(video: Video | undefined): number {
  if (!video) return 0;
  if (video.duration_ms) return video.duration_ms;
  const ui = useTheater.getState();
  return ui.onScreen === video.id ? ui.playerDuration : 0;
}

export function aspectOf(video: Video | undefined): number {
  if (video?.width && video.height) return Math.min(3, Math.max(0.4, video.width / video.height));
  return 16 / 9;
}

export function useSeated(serverId: number): boolean {
  return useStore((s) => !!s.seated[serverId]);
}

/** The server whose theater this browser is watching (one at a time), if any. */
export function seatedServer(s: State): number | null {
  for (const [k, v] of Object.entries(s.seated)) if (v && s.servers[Number(k)]) return Number(k);
  return null;
}

export async function theaterControl(serverId: number, action: string, value?: unknown): Promise<void> {
  try {
    await api.post(`/api/servers/${serverId}/theater/control`, { action, value });
  } catch (err) {
    toast(errorMessage(err));
  }
}

// ---------------------------------------------------------------------------
// Players
// ---------------------------------------------------------------------------

interface Hooks {
  status(b: Backend, status: PlayerStatus): void;
  /** Someone clicked the video itself (YouTube), or the system paused it. */
  userToggle(b: Backend, playing: boolean): void;
  error(b: Backend, message: string, reportCode?: number): void;
  autoplayBlocked(b: Backend): void;
  /** The player is ready for a video (again, after a move to picture-in-picture). */
  ready(b: Backend): void;
  /** Size or length became known. */
  meta(b: Backend): void;
}

interface Backend {
  readonly kind: 'youtube' | 'file';
  readonly el: HTMLElement;
  /** Seeking takes this long to take effect, so aim this far ahead. */
  readonly seekLead: number;
  videoId: number | null;
  isReady(): boolean;
  load(video: Video, atMs: number, play: boolean): void;
  play(): void;
  pause(): void;
  seek(ms: number): void;
  /** Is this video the one really loaded in the player right now (not the one before it)? */
  showing(video: Video): boolean;
  /** Where the player is (ms), or null when it can't say. */
  time(): number | null;
  duration(): number;
  status(): PlayerStatus;
  setVolume(volume: number, muted: boolean): void;
  setRate(rate: number): void;
  /** About to be moved to another window (the page inside reloads). */
  detach(): void;
  applySink(): void;
  destroy(): void;
}

interface YTPlayer {
  loadVideoById(o: { videoId: string; startSeconds?: number }): void;
  cueVideoById(o: { videoId: string; startSeconds?: number }): void;
  playVideo(): void;
  pauseVideo(): void;
  seekTo(seconds: number, allowSeekAhead: boolean): void;
  mute(): void;
  unMute(): void;
  setVolume(volume: number): void;
  getCurrentTime(): number;
  getDuration(): number;
  getPlayerState(): number;
  getVideoUrl(): string;
  destroy(): void;
}

type FrameWindow = Window & {
  YT?: { Player: new (el: HTMLElement, opts: unknown) => YTPlayer; loaded?: number };
  onYouTubeIframeAPIReady?: () => void;
};

const YT_PLAYING = 1;
const YT_PAUSED = 2;
const YT_ERRORS: Record<number, string> = {
  2: "YouTube didn't accept this video's address.",
  5: "YouTube's player hit a problem with this video.",
  100: 'This video is gone or private.',
  101: "The owner doesn't allow this video to play outside YouTube.",
  150: "The owner doesn't allow this video to play outside YouTube.",
  153: "YouTube couldn't tell which site is showing the video (error 153).",
};

function ytStatus(state: number): PlayerStatus {
  switch (state) {
    case 0:
      return 'ended';
    case 1:
      return 'playing';
    case 2:
    case 5:
      return 'paused';
    case 3:
      return 'buffering';
    default:
      return 'loading';
  }
}

/** Something we asked the player to do takes a moment to show; don't mistake the in-between for a click. */
const GRACE_MS = 3000;

class YouTubeBackend implements Backend {
  readonly kind = 'youtube' as const;
  readonly el: HTMLIFrameElement;
  readonly seekLead = 400;
  videoId: number | null = null;
  private player: YTPlayer | null = null;
  private ready = false;
  private live = false;
  private ytId: string | null = null;
  private want: { id: string; at: number; play: boolean } | null = null;
  private requested: 'playing' | 'paused' = 'paused';
  private graceUntil = 0;
  private state = -1;
  private volume = 80;
  private muted = false;
  private dead = false;
  private slowTimer: number | null = null;

  constructor(private hooks: Hooks) {
    const f = document.createElement('iframe');
    f.className = 'th-frame';
    f.title = 'Theater screen';
    f.allow = 'autoplay; encrypted-media; picture-in-picture; fullscreen';
    f.setAttribute('allowfullscreen', '');
    f.referrerPolicy = 'strict-origin-when-cross-origin';
    f.addEventListener('load', () => this.boot());
    f.src = FRAME_PAGE;
    this.el = f;
  }

  isReady(): boolean {
    return this.ready && !!this.player;
  }

  /** The frame page (re)loaded: the first time, or after moving between windows. */
  private boot(): void {
    if (this.dead) return;
    this.player = null;
    this.ready = false;
    this.state = -1;
    this.videoId = null;
    let win: FrameWindow | null = null;
    let doc: Document | null = null;
    try {
      win = this.el.contentWindow as FrameWindow | null;
      doc = this.el.contentDocument;
    } catch {
      /* not ours (shouldn't happen) */
    }
    if (!win || !doc?.getElementById('screen')) {
      this.hooks.error(this, "The theater's screen didn't load. Try reloading Tavern.");
      return;
    }
    this.hooks.status(this, 'loading');
    const start = () => this.create(win!, doc!);
    if (win.YT?.loaded) {
      start();
      return;
    }
    win.onYouTubeIframeAPIReady = start;
    const script = doc.createElement('script');
    script.src = YT_API;
    script.async = true;
    script.onerror = () => this.hooks.error(this, "YouTube's player didn't load. Check the connection, or anything that blocks YouTube.");
    doc.head.appendChild(script);
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.slowTimer = window.setTimeout(() => {
      if (!this.ready && !this.dead) this.hooks.error(this, "YouTube's player is taking a long time to load. Check the connection, or anything that blocks YouTube.");
    }, 20000);
  }

  private create(win: FrameWindow, doc: Document): void {
    const mount = doc.getElementById('screen');
    if (this.dead || !win.YT?.Player || !mount) return;
    try {
      this.player = new win.YT.Player(mount, {
        width: '100%',
        height: '100%',
        playerVars: {
          autoplay: 0,
          controls: 0,
          disablekb: 1,
          fs: 0,
          iv_load_policy: 3,
          playsinline: 1,
          rel: 0,
          enablejsapi: 1,
          origin: window.location.origin,
        },
        events: {
          onReady: () => this.onReady(),
          onStateChange: (e: { data: number }) => this.onState(e.data),
          onError: (e: { data: number }) => this.onError(e.data),
          onAutoplayBlocked: () => this.hooks.autoplayBlocked(this),
        },
      });
    } catch {
      this.hooks.error(this, "YouTube's player didn't start. Try reloading Tavern.");
    }
  }

  private onReady(): void {
    if (this.dead) return;
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.slowTimer = null;
    this.ready = true;
    this.applyVolume();
    const w = this.want;
    if (w) this.cue(w.id, w.at, w.play);
    this.hooks.ready(this);
  }

  private onState(state: number): void {
    if (this.dead) return;
    this.state = state;
    if (state === YT_PLAYING || state === YT_PAUSED) {
      const now = performance.now();
      const shown = state === YT_PLAYING ? 'playing' : 'paused';
      if (shown === this.requested) this.graceUntil = 0;
      else if (now > this.graceUntil) {
        // Not something we asked for: the person clicked the video (or the system paused it).
        this.requested = shown;
        this.hooks.userToggle(this, shown === 'playing');
      } else if (shown === 'playing' && this.requested === 'paused') {
        // It started on its own while it should be still (seeking a cued video does that).
        this.safe((p) => p.pauseVideo(), undefined);
      }
    }
    this.hooks.status(this, ytStatus(state));
  }

  private onError(code: number): void {
    if (this.dead) return;
    const reportable = code === 100 || code === 101 || code === 150;
    this.hooks.error(this, YT_ERRORS[code] ?? `YouTube's player couldn't play this video (error ${code}).`, reportable ? code : undefined);
  }

  private expect(what: 'playing' | 'paused'): void {
    this.requested = what;
    this.graceUntil = performance.now() + GRACE_MS;
  }

  private safe<T>(fn: (p: YTPlayer) => T, fallback: T): T {
    if (!this.player || !this.ready) return fallback;
    try {
      return fn(this.player);
    } catch {
      return fallback;
    }
  }

  private cue(id: string, atMs: number, play: boolean): void {
    this.want = null;
    const startSeconds = this.live ? undefined : Math.max(0, atMs / 1000);
    this.expect(play ? 'playing' : 'paused');
    this.safe((p) => (play ? p.loadVideoById({ videoId: id, startSeconds }) : p.cueVideoById({ videoId: id, startSeconds })), undefined);
  }

  load(video: Video, atMs: number, play: boolean): void {
    this.videoId = video.id;
    this.live = video.live;
    this.ytId = video.youtube_id;
    if (!video.youtube_id) return;
    if (this.isReady()) this.cue(video.youtube_id, atMs, play);
    else this.want = { id: video.youtube_id, at: atMs, play };
  }

  play(): void {
    this.expect('playing');
    this.safe((p) => p.playVideo(), undefined);
  }

  pause(): void {
    this.expect('paused');
    this.safe((p) => p.pauseVideo(), undefined);
  }

  seek(ms: number): void {
    if (this.live) return;
    // Seeking a video that hasn't started would start it (YouTube does that): cue it there instead.
    const state = this.safe((p) => p.getPlayerState(), this.state);
    if ((state === 5 || state === -1) && this.requested === 'paused' && this.ytId) {
      this.cue(this.ytId, ms, false);
      return;
    }
    // Seeking briefly buffers; that's us, not a click.
    this.graceUntil = performance.now() + GRACE_MS;
    this.safe((p) => p.seekTo(Math.max(0, ms / 1000), true), undefined);
  }

  showing(video: Video): boolean {
    if (!video.youtube_id || this.videoId !== video.id) return false;
    const url = this.safe((p) => p.getVideoUrl(), '');
    const m = /[?&]v=([\w-]{11})/.exec(url);
    return !!m && m[1] === video.youtube_id;
  }

  time(): number | null {
    const t = this.safe((p) => p.getCurrentTime(), NaN);
    return Number.isFinite(t) ? t * 1000 : null;
  }

  duration(): number {
    const d = this.safe((p) => p.getDuration(), 0);
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
  }

  status(): PlayerStatus {
    if (!this.isReady()) return 'loading';
    return ytStatus(this.safe((p) => p.getPlayerState(), this.state));
  }

  setVolume(volume: number, muted: boolean): void {
    this.volume = volume;
    this.muted = muted;
    this.applyVolume();
  }

  private applyVolume(): void {
    this.safe((p) => {
      p.setVolume(Math.round(this.volume));
      if (this.muted || this.volume === 0) p.mute();
      else p.unMute();
    }, undefined);
  }

  setRate(): void {
    /* YouTube only has coarse speeds; it's kept in step by seeking */
  }

  detach(): void {
    // The page inside reloads when the frame moves; start over there.
    this.player = null;
    this.ready = false;
    this.videoId = null;
  }

  applySink(): void {
    /* YouTube's sound goes to the system's output; a page can't redirect another site's audio */
  }

  destroy(): void {
    this.dead = true;
    if (this.slowTimer !== null) window.clearTimeout(this.slowTimer);
    this.safe((p) => p.destroy(), undefined);
    this.player = null;
    this.el.remove();
    this.el.src = 'about:blank';
  }
}

class FileBackend implements Backend {
  readonly kind = 'file' as const;
  readonly el: HTMLVideoElement;
  readonly seekLead = 60;
  videoId: number | null = null;
  private requested: 'playing' | 'paused' = 'paused';
  private graceUntil = 0;
  private dead = false;
  private stopSink: () => void;

  constructor(private hooks: Hooks) {
    const v = document.createElement('video');
    v.className = 'th-video';
    v.playsInline = true;
    v.preload = 'auto';
    v.setAttribute('playsinline', '');
    (v as HTMLVideoElement & { preservesPitch?: boolean }).preservesPitch = true;
    v.addEventListener('playing', () => this.hooks.status(this, 'playing'));
    v.addEventListener('waiting', () => this.hooks.status(this, 'buffering'));
    v.addEventListener('seeked', () => this.hooks.status(this, v.paused ? 'paused' : v.readyState >= 3 ? 'playing' : 'buffering'));
    v.addEventListener('ended', () => this.hooks.status(this, 'ended'));
    v.addEventListener('loadedmetadata', () => this.hooks.meta(this));
    v.addEventListener('play', () => this.onToggle(true));
    v.addEventListener('pause', () => this.onToggle(false));
    v.addEventListener('error', () => {
      if (v.error && v.getAttribute('src')) this.hooks.error(this, "This video couldn't play in this browser.");
    });
    v.addEventListener('enterpictureinpicture', () => useTheater.setState({ nativePip: true }));
    v.addEventListener('leavepictureinpicture', () => useTheater.setState({ nativePip: false }));
    this.el = v;
    this.stopSink = on('output-device', () => this.applySink());
    this.applySink();
  }

  private onToggle(playing: boolean): void {
    if (this.dead || this.el.ended) return;
    const shown = playing ? 'playing' : 'paused';
    if (!playing) this.hooks.status(this, 'paused');
    if (shown === this.requested) {
      this.graceUntil = 0;
      return;
    }
    if (performance.now() > this.graceUntil) {
      // The system paused or played it (media keys, the phone going to sleep, the PiP window's buttons).
      this.requested = shown;
      this.hooks.userToggle(this, playing);
    }
  }

  private expect(what: 'playing' | 'paused'): void {
    this.requested = what;
    this.graceUntil = performance.now() + GRACE_MS;
  }

  isReady(): boolean {
    return true;
  }

  load(video: Video, atMs: number, play: boolean): void {
    this.videoId = video.id;
    if (!video.url) return;
    this.expect(play ? 'playing' : 'paused');
    this.el.src = video.url;
    this.el.currentTime = Math.max(0, atMs / 1000);
    if (play) this.play();
    else this.hooks.status(this, 'loading');
  }

  play(): void {
    this.expect('playing');
    this.el.play().catch((err: DOMException) => {
      if (this.dead) return;
      if (err.name === 'NotAllowedError') this.hooks.autoplayBlocked(this);
    });
  }

  pause(): void {
    this.expect('paused');
    this.el.pause();
  }

  seek(ms: number): void {
    this.graceUntil = performance.now() + GRACE_MS;
    this.el.currentTime = Math.max(0, ms / 1000);
  }

  time(): number | null {
    return this.el.readyState >= 1 ? this.el.currentTime * 1000 : null;
  }

  showing(video: Video): boolean {
    return this.videoId === video.id && !!video.url && this.el.getAttribute('src') === video.url;
  }

  duration(): number {
    const d = this.el.duration;
    return Number.isFinite(d) && d > 0 ? Math.round(d * 1000) : 0;
  }

  status(): PlayerStatus {
    const v = this.el;
    if (!v.getAttribute('src')) return 'idle';
    if (v.ended) return 'ended';
    if (v.paused) return 'paused';
    if (v.seeking || v.readyState < 3) return 'buffering';
    return 'playing';
  }

  setVolume(volume: number, muted: boolean): void {
    // Loudness is heard roughly logarithmically, so ease the slider (as the jukebox does).
    this.el.volume = Math.max(0, Math.min(1, Math.pow(volume / 100, 1.5)));
    this.el.muted = muted || volume === 0;
  }

  setRate(rate: number): void {
    if (this.el.playbackRate !== rate) this.el.playbackRate = rate;
  }

  detach(): void {
    /* a video keeps playing when it moves */
  }

  applySink(): void {
    const v = this.el as HTMLVideoElement & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };
    const id = outputDeviceId();
    if (typeof v.setSinkId === 'function' && (v.sinkId ?? '') !== id) v.setSinkId(id).catch(() => undefined);
  }

  destroy(): void {
    this.dead = true;
    this.stopSink();
    if (document.pictureInPictureElement === this.el) void document.exitPictureInPicture().catch(() => undefined);
    this.el.pause();
    this.el.removeAttribute('src');
    this.el.load();
    this.el.remove();
  }
}

// ---------------------------------------------------------------------------
// The engine: one screen, following the server you've taken a seat in
// ---------------------------------------------------------------------------

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

function timelineOf(st: TheaterState): number {
  return st.playing ? st.started_at ?? 0 : -(st.position || 0);
}

class TheaterEngine {
  /** Holds the player; it moves between the app and a picture-in-picture window. */
  readonly media: HTMLDivElement;
  private backend: Backend | null = null;
  private serverId: number | null = null;
  private entry: string | null = null;
  private timeline: number | null = null;
  private home: HTMLElement | null = null;
  private pipWindow: Window | null = null;
  private slotEl: HTMLElement | null = null;
  private timer: number | null = null;
  private drift: number[] = [];
  private settleUntil = 0;
  private nudging = false;
  private seekFails = 0;
  private lastSeekAt = 0;
  private nextSeekAt = 0;
  private checkAfterLoad = false;
  /** Muted because the browser wouldn't allow sound yet (not the person's choice). */
  private forcedMute = false;
  /** Even muted, the browser won't start it: wait for a click instead of retrying. */
  private waitForClick = false;
  /** Reports sent (or when to try again after one failed). */
  private reported = new Map<string, { at: number; tries: number }>();

  constructor() {
    this.media = document.createElement('div');
    this.media.className = 'th-media';
    on('theater-state', () => this.sync());
    on('theater-video', (v: Video) => {
      if (this.serverId === v.server_id) this.sync();
    });
    on('ready', () => {
      this.announce();
      this.sync();
    });
    on('server-gone', (id: number) => {
      if (this.serverId === id) this.sync();
    });
    on('session-reset', () => {
      this.closePip();
      this.teardown();
      this.serverId = null;
    });
    const unlock = () => this.unlockSound();
    window.addEventListener('pointerdown', unlock, true);
    window.addEventListener('keydown', unlock, true);
  }

  // -- seats ----------------------------------------------------------------------------

  /** The server whose theater I'm watching (one at a time), if any. */
  activeServer(): number | null {
    return seatedServer(getState());
  }

  setSeated(serverId: number, seated: boolean): void {
    const prev = this.activeServer();
    setState((s) => {
      const next: Record<number, boolean> = {};
      if (seated) next[serverId] = true;
      else for (const [k, v] of Object.entries(s.seated)) if (Number(k) !== serverId && v) next[Number(k)] = true;
      return { seated: next };
    });
    persistUi();
    if (prev !== null && prev !== serverId && seated) gateway.send(10, { server_id: prev, seated: false });
    gateway.send(10, { server_id: serverId, seated });
    if (!seated) {
      this.closePip();
      useTheater.setState({ placement: 'panel' });
    }
    // Taking a seat is a click, which lets the sound start right away.
    this.sync();
  }

  private announce(): void {
    const id = this.activeServer();
    if (id !== null) gateway.send(10, { server_id: id, seated: true });
  }

  // -- where the screen lives ----------------------------------------------------------------

  /** The screen host in the app: the player lives here unless it's in picture-in-picture. */
  attachHome(el: HTMLElement | null): void {
    this.home = el;
    if (el && !this.pipWindow && this.media.parentElement !== el) this.move(el);
  }

  /** The theater card's screen spot, where the player docks. */
  setSlot(el: HTMLElement | null): void {
    this.slotEl = el;
  }

  slot(): HTMLElement | null {
    return this.slotEl?.isConnected ? this.slotEl : null;
  }

  private move(parent: HTMLElement): void {
    this.backend?.detach();
    parent.appendChild(this.media);
    // A <video> can pause while it moves; bring it back in line.
    window.setTimeout(() => this.sync(), 0);
  }

  enterPip(win: Window, parent: HTMLElement): void {
    if (this.pipWindow && this.pipWindow !== win) this.pipWindow.close();
    this.pipWindow = win;
    this.move(parent);
    useTheater.setState({ placement: 'pip' });
    const unlock = () => this.unlockSound();
    win.addEventListener('pointerdown', unlock, true);
    win.addEventListener('keydown', unlock, true);
  }

  /** A picture-in-picture window closed: if it held the player, bring it home. */
  leavePip(win: Window): void {
    if (!this.pipWindow || this.pipWindow !== win) return;
    this.pipWindow = null;
    if (this.home) this.move(this.home);
    if (useTheater.getState().placement === 'pip') useTheater.setState({ placement: 'panel' });
  }

  /** Close the theater's own picture-in-picture (never a chat video's). */
  closePip(): void {
    this.pipWindow?.close();
    const own = this.videoElement();
    if (own && document.pictureInPictureElement === own) void document.exitPictureInPicture().catch(() => undefined);
  }

  pipOpen(): boolean {
    return !!this.pipWindow;
  }

  /** The <video> of an uploaded video (for the browser's own picture-in-picture). */
  videoElement(): HTMLVideoElement | null {
    return this.backend?.kind === 'file' ? (this.backend.el as HTMLVideoElement) : null;
  }

  // -- sound ----------------------------------------------------------------------------------

  setVolume(v: number): void {
    const volume = Math.max(0, Math.min(100, Math.round(v)));
    useTheater.setState({ myVolume: volume, ...(volume > 0 ? { muted: false } : {}) });
    save('theaterVolume', volume);
    save('theaterMuted', useTheater.getState().muted);
    this.applyVolume();
  }

  setMuted(muted: boolean): void {
    useTheater.setState({ muted });
    save('theaterMuted', muted);
    if (!muted && useTheater.getState().myVolume === 0) this.setVolume(50);
    this.applyVolume();
  }

  /** A click or key press: sound is allowed now, if the browser was holding it back. */
  unlockSound(): void {
    if (!useTheater.getState().needsGesture) return;
    this.forcedMute = false;
    this.waitForClick = false;
    useTheater.setState({ needsGesture: false });
    this.applyVolume();
    const b = this.backend;
    const st = this.serverId !== null ? getState().theater[this.serverId] : undefined;
    if (b && st?.playing && !useTheater.getState().localPause) b.play();
  }

  private applyVolume(): void {
    const ui = useTheater.getState();
    this.backend?.setVolume(ui.myVolume, ui.muted || this.forcedMute);
    this.applyDuck();
  }

  private applyDuck(): void {
    const ui = useTheater.getState();
    const audible = !!this.backend && ui.status === 'playing' && !ui.muted && !this.forcedMute && ui.myVolume > 0 && !ui.localPause;
    setDuck('theater', audible ? DUCK_LEVEL : null);
  }

  // -- following the shared clock -------------------------------------------------------------

  /** I paused my own screen: jump back to where everyone is. */
  catchUp(): void {
    useTheater.setState({ localPause: false });
    const b = this.backend;
    const st = this.serverId !== null ? getState().theater[this.serverId] : undefined;
    if (b && st?.playing && b.isReady()) {
      b.seek(theaterPosition(st) + b.seekLead);
      this.settle();
      b.play();
    }
    this.sync();
  }

  /** Try a video that failed on my screen again. */
  retry(): void {
    useTheater.setState({ error: null });
    const b = this.backend;
    if (b && !b.isReady()) {
      // YouTube's player never started: build it again from scratch.
      b.destroy();
      this.backend = null;
      this.media.replaceChildren();
    } else if (b) b.videoId = null;
    this.sync();
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), TICK_MS);
  }

  private settle(): void {
    this.drift = [];
    this.settleUntil = performance.now() + 1500;
    this.nudging = false;
    this.backend?.setRate(1);
  }

  private teardown(): void {
    if (this.backend) {
      this.backend.destroy();
      this.backend = null;
    }
    this.media.replaceChildren();
    this.entry = null;
    this.timeline = null;
    this.forcedMute = false;
    this.waitForClick = false;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    setDuck('theater', null);
    const ui = useTheater.getState();
    if (ui.onScreen !== null || ui.status !== 'idle' || ui.needsGesture || ui.error || ui.localPause) {
      useTheater.setState({ onScreen: null, status: 'idle', buffering: false, needsGesture: false, localPause: false, error: null, playerDuration: 0, nativePip: false });
    }
  }

  /** Bring the screen in line with the server's state. */
  sync(): void {
    const sid = this.activeServer();
    const st = sid !== null ? getState().theater[sid] : undefined;
    const video = currentVideo(st);
    const playable = !!video && video.status === 'ready' && (video.kind === 'file' ? !!video.url : !!video.youtube_id);
    if (sid === null || !st?.current || !video || !playable) {
      this.serverId = sid;
      this.teardown();
      // No seat, or nothing on at all: a picture-in-picture window would only
      // show black. (A video that just failed is replaced in a moment; keep it.)
      if (sid === null || !st?.current) this.closePip();
      return;
    }
    this.serverId = sid;
    const kind = video.kind === 'file' ? 'file' : 'youtube';
    if (this.backend && this.backend.kind !== kind) this.teardown();
    if (!this.backend) {
      this.backend = kind === 'file' ? new FileBackend(this.hooks) : new YouTubeBackend(this.hooks);
      this.media.replaceChildren(this.backend.el);
      this.applyVolume();
    }
    this.ensureTimer();
    const b = this.backend;

    if (this.entry !== st.current.qid) {
      // Something new is on (or the same video again): start fresh.
      this.entry = st.current.qid;
      b.videoId = null;
      this.timeline = null;
      this.seekFails = 0;
      this.nextSeekAt = 0;
      this.settle();
      useTheater.setState({ localPause: false, error: null, playerDuration: 0, onScreen: video.id, aspect: aspectOf(video) });
    }
    // Paused for everyone supersedes paused just for me.
    if (!st.playing && useTheater.getState().localPause) useTheater.setState({ localPause: false });
    const ui = useTheater.getState();
    const failed = ui.error !== null && ui.error.videoId === video.id;
    const target = theaterPosition(st);
    const want = st.playing && !ui.localPause && !failed;
    const timeline = timelineOf(st);
    const jumped = this.timeline !== null && Math.abs(timeline - this.timeline) > 1000;
    this.timeline = timeline;

    if (b.videoId !== video.id) {
      if (failed) return;
      b.load(video, target + (want ? b.seekLead : 0), want);
      this.checkAfterLoad = true;
      this.settle();
      return;
    }
    if (!b.isReady()) return;
    const status = b.status();
    if (want) {
      if (jumped && !video.live) {
        b.seek(target + b.seekLead);
        this.settle();
      }
      // A video that ended here waits for the server to move on (unless the DJ jumped back).
      if ((status === 'paused' || status === 'idle' || (status === 'ended' && jumped)) && !this.waitForClick) b.play();
    } else {
      if (status === 'playing' || status === 'buffering') b.pause();
      // Paused for everyone: everyone sees the same frame.
      if (!st.playing && !video.live) {
        const t = b.time();
        if (t !== null && (jumped || Math.abs(t - target) > 750)) b.seek(target);
      }
    }
  }

  private tick(): void {
    const b = this.backend;
    const sid = this.serverId;
    const st = sid !== null ? getState().theater[sid] : undefined;
    if (!b || !st?.current) return;
    const video = currentVideo(st);
    if (!video) return;
    const target = theaterPosition(st);
    const ui = useTheater.getState();
    if (Math.abs(ui.position - target) > 200) useTheater.setState({ position: target });

    // Tell the library how long a video is, when it didn't know.
    if (!video.duration_ms && !video.live && b.showing(video)) {
      const d = b.duration();
      if (d > 0) {
        if (ui.playerDuration !== d) useTheater.setState({ playerDuration: d });
        this.report(video, 'duration', { duration_ms: d });
      }
    }

    if (!st.playing || ui.localPause || video.live || b.videoId !== video.id || !b.isReady()) {
      this.drift = [];
      return;
    }
    if (b.status() !== 'playing' || performance.now() < this.settleUntil) return;
    const t = b.time();
    if (t === null) return;
    const d = t - target; // + = ahead of everyone
    if (this.checkAfterLoad) {
      // Loading took a moment; jump straight to where everyone is.
      this.checkAfterLoad = false;
      if (Math.abs(d) > 1000) {
        b.seek(target + b.seekLead);
        this.settle();
        return;
      }
    }
    if (b.kind === 'youtube') this.correctBySeeking(b, d, target);
    else this.correctByRate(b, d, target);
  }

  private correctBySeeking(b: Backend, d: number, target: number): void {
    this.drift.push(d);
    if (this.drift.length > 3) this.drift.shift();
    if (this.drift.length < 3 || this.drift.some((x) => Math.abs(x) < YT_DRIFT_MS)) return;
    const now = performance.now();
    if (now < this.nextSeekAt) return;
    // A seek that didn't stick (an ad is playing, or the connection is slow): wait longer each time.
    this.seekFails = now - this.lastSeekAt < 20000 ? this.seekFails + 1 : 0;
    this.lastSeekAt = now;
    this.nextSeekAt = now + Math.min(30000, 2000 * 2 ** this.seekFails);
    b.seek(target + b.seekLead);
    this.settle();
  }

  private correctByRate(b: Backend, d: number, target: number): void {
    this.drift.push(d);
    if (this.drift.length > 5) this.drift.shift();
    if (this.drift.length < 3) return;
    const m = median(this.drift);
    if (Math.abs(m) > FILE_SEEK_MS) {
      b.seek(target + b.seekLead);
      this.settle();
      return;
    }
    if (!this.nudging && Math.abs(m) > NUDGE_START_MS) this.nudging = true;
    else if (this.nudging && Math.abs(m) < NUDGE_STOP_MS) this.nudging = false;
    b.setRate(this.nudging ? (m > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE) : 1);
  }

  private report(video: Video, what: string, body: Record<string, unknown>): void {
    const key = `${video.id}:${what}`;
    const prev = this.reported.get(key);
    if (prev && (prev.at === Infinity || performance.now() < prev.at || prev.tries >= 3)) return;
    this.reported.set(key, { at: Infinity, tries: (prev?.tries ?? 0) + 1 });
    api.post(`/api/servers/${video.server_id}/theater/videos/${video.id}/report`, body).catch(() => {
      // Try again in a while (a few times at most), not on every tick.
      const cur = this.reported.get(key);
      if (cur) this.reported.set(key, { at: performance.now() + 30_000, tries: cur.tries });
    });
  }

  private hooks: Hooks = {
    status: (b, status) => {
      if (b !== this.backend) return;
      const ui = useTheater.getState();
      const buffering = status === 'buffering' || status === 'loading';
      if (ui.status !== status || ui.buffering !== buffering) useTheater.setState({ status, buffering });
      if (status === 'playing') this.waitForClick = false;
      this.applyDuck();
    },
    userToggle: (b, playing) => {
      if (b !== this.backend) return;
      const sid = this.serverId;
      const st = sid !== null ? getState().theater[sid] : undefined;
      if (!st) return;
      if (!playing) {
        // Paused on my screen only; "Catch up" brings me back.
        if (st.playing) useTheater.setState({ localPause: true });
        this.applyDuck();
        return;
      }
      if (useTheater.getState().localPause) {
        this.catchUp();
        return;
      }
      if (!st.playing) {
        b.pause();
        const dj = sid !== null && canControlTheater(getState(), sid);
        toast(dj ? 'The theater is paused for everyone. Press play in the theater card to start it.' : 'The theater is paused for everyone.', 'info');
      }
    },
    error: (b, message, code) => {
      if (b !== this.backend) return;
      const ui = useTheater.getState();
      const videoId = b.videoId ?? ui.onScreen;
      useTheater.setState({ error: { videoId, message } });
      if (code && videoId !== null && this.serverId !== null) {
        const video = currentVideo(getState().theater[this.serverId]);
        if (video && video.id === videoId && b.showing(video)) {
          // The server checks for itself and, if it agrees, moves everyone on.
          this.report(video, 'error', { error_code: code });
          toast(`“${video.title}” can't play here. ${message}`);
        }
      }
    },
    autoplayBlocked: (b) => {
      if (b !== this.backend) return;
      if (this.forcedMute) {
        // Even muted it won't start: wait for a click.
        this.waitForClick = true;
        useTheater.setState({ needsGesture: true });
        return;
      }
      this.forcedMute = true;
      useTheater.setState({ needsGesture: true });
      this.applyVolume();
      const st = this.serverId !== null ? getState().theater[this.serverId] : undefined;
      if (st?.playing && !useTheater.getState().localPause) b.play();
    },
    ready: (b) => {
      if (b !== this.backend) return;
      const ui = useTheater.getState();
      if (ui.error && ui.error.message.startsWith("YouTube's player")) useTheater.setState({ error: null });
      this.applyVolume();
      this.sync();
    },
    meta: (b) => {
      if (b !== this.backend || b.kind !== 'file') return;
      const v = b.el as HTMLVideoElement;
      if (v.videoWidth && v.videoHeight) {
        const aspect = Math.min(3, Math.max(0.4, v.videoWidth / v.videoHeight));
        if (Math.abs(aspect - useTheater.getState().aspect) > 0.01) useTheater.setState({ aspect });
      }
    },
  };
}

export const theater = new TheaterEngine();
// A handle for troubleshooting from the browser console (tavernTheater.theater).
if (typeof window !== 'undefined') (window as unknown as { tavernTheater: unknown }).tavernTheater = { theater, useTheater };
