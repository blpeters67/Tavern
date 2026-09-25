/**
 * Jukebox playback: follows the server's shared clock so every listener hears
 * the same moment of the same song.
 *
 *   position = serverNow() - started_at
 *
 * Nothing here may click or pop:
 *  - every cut (new song, seek, pause, stop) fades out over a few dozen
 *    milliseconds first, and the sound fades back in once it's really playing;
 *  - a stall (slow connection) is held silent until the music flows again;
 *  - small drifts are ignored, bigger ones are caught up gently at ±2% speed
 *    (switching speed rarely), and only big jumps seek.
 * Volume = jukebox volume (DJ) × my volume (me) × fades × the track's loudness
 * correction × ducking (a theater video's sound is playing), applied through
 * WebAudio so it works on iOS too.
 */

import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { getState, persistUi, setState, useStore } from '../store/store';
import type { JukeboxState, Track } from '../store/types';
import { serverNow } from './clock';
import { duckLevel, onDuckChange } from './duck';
import { on } from './events';
import { audioContext, existingAudioContext } from './sounds';
import { load, save } from './storage';

const FADE_IN_MS = 1500;
const FADE_OUT_MS = 3000;
/** Further off than this and we jump (with a fade) instead of catching up. */
const SEEK_DRIFT_S = 2.5;
/** Start catching up past this much drift, and stop once back within NUDGE_STOP_S. */
const NUDGE_START_S = 0.3;
const NUDGE_STOP_S = 0.05;
/** How much faster/slower we play while catching up (2%). */
const NUDGE_RATE = 0.02;

interface PlayerUi {
  myVolume: number; // 0..100
  needsGesture: boolean;
  buffering: boolean;
  position: number; // ms, for the progress bar (updated by the tick)
}

export const usePlayer = create<PlayerUi>(() => ({
  myVolume: load<number>('jukeboxMyVolume', 80),
  needsGesture: false,
  buffering: false,
  position: 0,
}));

export function setMyVolume(v: number): void {
  const vol = Math.max(0, Math.min(100, Math.round(v)));
  usePlayer.setState({ myVolume: vol });
  save('jukeboxMyVolume', vol);
  player.applyGain();
}

/** Where the song is right now, per the server clock (ms). */
export function jukeboxPosition(st: JukeboxState | undefined): number {
  if (!st || !st.current) return 0;
  if (st.playing && st.started_at) return Math.max(0, serverNow() - st.started_at);
  return st.position || 0;
}

export function currentTrack(st: JukeboxState | undefined): Track | undefined {
  if (!st?.current) return undefined;
  return st.tracks[String(st.current.track_id)];
}

class JukeboxPlayer {
  private audio: HTMLAudioElement | null = null;
  private gain: GainNode | null = null;
  private serverId: number | null = null;
  private trackUrl: string | null = null;
  private timer: number | null = null;
  private transitionStart: { until: number; start: number } | null = null;
  private preload: HTMLAudioElement | null = null;
  /** Held silent: a cut is coming, or the music stalled and hasn't resumed. */
  private hold = false;
  private fadeTimer: number | null = null;
  private lastTarget = -1;
  /** Recent drift readings (seconds, + = we're ahead) and catch-up state. */
  private drift: number[] = [];
  private settleUntil = 0;
  private nudging = false;
  /** The server timeline we last followed (started_at, or -position when paused). */
  private timeline: number | null = null;

  constructor() {
    on('jukebox-state', () => this.sync());
    on('ready', () => {
      this.announceAll();
      this.sync();
    });
    on('server-gone', (id: number) => {
      if (this.serverId === id) this.sync();
    });
    on('session-reset', () => this.sync());
    const retry = () => {
      if (usePlayer.getState().needsGesture) {
        audioContext('music');
        this.sync(true);
      }
    };
    window.addEventListener('pointerdown', retry, true);
    window.addEventListener('keydown', retry, true);
    // Duck gently under a theater video (and come back up just as gently).
    onDuckChange(() => this.applyGain(true, 0.35));
  }

  /** The server we're listening to (one at a time), if any. */
  activeServer(): number | null {
    const listening = getState().listening;
    const ids = Object.keys(listening)
      .filter((k) => listening[Number(k)])
      .map(Number)
      .filter((id) => getState().servers[id]);
    return ids[0] ?? null;
  }

  setListening(serverId: number, listening: boolean): void {
    const prev = this.activeServer();
    setState((s) => {
      const next: Record<number, boolean> = {};
      if (listening) next[serverId] = true;
      else for (const [k, v] of Object.entries(s.listening)) if (Number(k) !== serverId && v) next[Number(k)] = true;
      return { listening: next };
    });
    persistUi();
    if (prev !== null && prev !== serverId && listening) gateway.send(9, { server_id: prev, listening: false });
    gateway.send(9, { server_id: serverId, listening });
    // Clicking "Listen in" is the gesture that lets the sound start.
    if (listening && getState().jukebox[serverId]?.playing) audioContext('music');
    this.sync(true);
  }

  private announceAll(): void {
    const id = this.activeServer();
    if (id !== null) gateway.send(9, { server_id: id, listening: true });
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const el = new Audio();
      el.preload = 'auto';
      (el as HTMLAudioElement & { preservesPitch?: boolean }).preservesPitch = true;
      el.addEventListener('waiting', () => {
        usePlayer.setState({ buffering: true });
        // The sound already stopped; keep it silent so it doesn't snap back in.
        this.setHold(true);
      });
      el.addEventListener('playing', () => {
        usePlayer.setState({ buffering: false });
        this.settle();
        this.setHold(false);
      });
      el.addEventListener('seeked', () => {
        this.settle();
        if (!el.paused && el.readyState >= 3) this.setHold(false);
      });
      el.addEventListener('canplay', () => usePlayer.setState({ buffering: false }));
      const ac = audioContext('music');
      const source = ac.createMediaElementSource(el);
      this.gain = ac.createGain();
      this.gain.gain.value = 0;
      source.connect(this.gain).connect(ac.destination);
      this.audio = el;
    }
    return this.audio;
  }

  private ensureTimer(): void {
    if (this.timer === null) this.timer = window.setInterval(() => this.tick(), 250);
  }

  /** Is sound coming out right now (so a cut would click)? */
  private audible(): boolean {
    return !!this.audio && !this.audio.paused && !!this.gain && this.gain.context.state === 'running' && this.gain.gain.value > 0.003;
  }

  /** Fade to silence, then run `then` (the cut). A newer request replaces an older one. */
  private fadeThen(then: () => void): void {
    this.setHold(true);
    if (this.fadeTimer !== null) window.clearTimeout(this.fadeTimer);
    this.fadeTimer = window.setTimeout(() => {
      this.fadeTimer = null;
      then();
    }, 80);
  }

  private setHold(hold: boolean): void {
    if (this.hold === hold) return;
    this.hold = hold;
    this.applyGain(true);
  }

  /** Forget drift readings for a moment (after a seek or a new song). */
  private settle(): void {
    this.drift = [];
    this.settleUntil = performance.now() + 1500;
    this.nudging = false;
    if (this.audio && this.audio.playbackRate !== 1) this.audio.playbackRate = 1;
  }

  private stop(): void {
    if (this.audible()) {
      this.fadeThen(() => this.sync());
      return;
    }
    if (this.audio) {
      this.audio.pause();
      this.audio.removeAttribute('src');
      this.audio.load();
    }
    this.trackUrl = null;
    this.serverId = null;
    this.timeline = null;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    usePlayer.setState({ buffering: false });
  }

  /** Bring the <audio> in line with the server state. */
  sync(fromGesture = false): void {
    const serverId = this.activeServer();
    const st = serverId !== null ? getState().jukebox[serverId] : undefined;
    const track = currentTrack(st);
    if (serverId === null || !st || !track || !track.url) {
      this.stop();
      return;
    }
    if (serverId !== this.serverId) this.timeline = null;
    this.serverId = serverId;
    this.ensureTimer();
    this.preloadNext(st);

    if (st.transition) {
      if (!this.transitionStart || this.transitionStart.until !== st.transition.until) {
        this.transitionStart = { until: st.transition.until, start: serverNow() };
      }
    } else {
      this.transitionStart = null;
    }

    // Paused and never played here: don't open the sound device for nothing.
    if (!st.playing && !this.audio) {
      if (fromGesture) usePlayer.setState({ needsGesture: false });
      return;
    }

    const audio = this.ensureAudio();
    const want = jukeboxPosition(st) / 1000;
    const timeline = st.playing ? st.started_at ?? 0 : -(st.position || 0);
    // The DJ seeked (or the song restarted): the timeline jumped.
    const jumped = this.timeline !== null && Math.abs(timeline - this.timeline) > 1000;
    const newTrack = this.trackUrl !== track.url;
    const offBy = Math.abs(audio.currentTime - want);
    const needsCut = newTrack || (st.playing ? jumped || offBy > SEEK_DRIFT_S : !audio.paused);
    if (needsCut && this.audible()) {
      this.fadeThen(() => this.sync());
      return;
    }
    this.timeline = timeline;

    if (newTrack) {
      this.trackUrl = track.url;
      this.setHold(true); // silent until it's actually playing
      audio.src = track.url;
      audio.currentTime = want;
      this.settle();
    } else if (st.playing && (jumped || offBy > SEEK_DRIFT_S)) {
      this.setHold(true);
      audio.currentTime = want;
      this.settle();
    }

    if (st.playing) {
      if (audio.paused) {
        this.setHold(true);
        audio.play().then(
          () => {
            usePlayer.setState({ needsGesture: false });
            this.checkRunning();
          },
          (err: DOMException) => {
            if (err.name === 'NotAllowedError') usePlayer.setState({ needsGesture: true });
          },
        );
      } else if (this.hold && this.fadeTimer === null && !audio.seeking && audio.readyState >= 3) {
        // A cut we faded out for turned out not to be needed.
        this.setHold(false);
      }
    } else {
      audio.pause();
      audio.currentTime = (st.position || 0) / 1000;
    }
    if (fromGesture) usePlayer.setState({ needsGesture: false });
    this.applyGain();
  }

  /** Browsers can keep sound blocked until a click; show the button if so. */
  private checkRunning(): void {
    window.setTimeout(() => {
      const ac = existingAudioContext('music');
      if (ac && ac.state !== 'running' && this.audio && !this.audio.paused) usePlayer.setState({ needsGesture: true });
    }, 800);
  }

  private preloadNext(st: JukeboxState): void {
    const next = st.queue[0];
    const url = next ? st.tracks[String(next.track_id)]?.url : null;
    if (!url) return;
    if (this.preload?.src.endsWith(url)) return;
    this.preload = new Audio();
    this.preload.preload = 'auto';
    this.preload.src = url;
  }

  private tick(): void {
    const serverId = this.serverId;
    const st = serverId !== null ? getState().jukebox[serverId] : undefined;
    if (!st || !st.current) return;
    const pos = jukeboxPosition(st);
    usePlayer.setState({ position: pos });
    const audio = this.audio;
    if (audio && st.playing && !audio.paused && !audio.seeking && audio.readyState >= 3 && !this.hold && performance.now() > this.settleUntil) {
      this.drift.push(audio.currentTime - pos / 1000);
      if (this.drift.length > 7) this.drift.shift();
      if (this.drift.length >= 5) {
        const d = median(this.drift);
        if (Math.abs(d) > SEEK_DRIFT_S) {
          this.sync(); // far off: faded jump
          return;
        }
        // Catch up gently, and only switch speed when a correction starts or ends.
        if (!this.nudging && Math.abs(d) > NUDGE_START_S) this.nudging = true;
        else if (this.nudging && Math.abs(d) < NUDGE_STOP_S) this.nudging = false;
        const rate = this.nudging ? (d > 0 ? 1 - NUDGE_RATE : 1 + NUDGE_RATE) : 1;
        if (audio.playbackRate !== rate) audio.playbackRate = rate;
      }
    }
    this.applyGain();
  }

  applyGain(force = false, glide?: number): void {
    const serverId = this.serverId;
    const st = serverId !== null ? getState().jukebox[serverId] : undefined;
    if (!this.gain || !st) return;
    const track = currentTrack(st);
    let fade = 1;
    const pos = jukeboxPosition(st);
    if (st.fade && track) {
      if (pos < FADE_IN_MS) fade = Math.min(fade, pos / FADE_IN_MS);
      const left = track.duration_ms - pos;
      if (track.duration_ms > 0 && left < FADE_OUT_MS) fade = Math.min(fade, Math.max(0, left / FADE_OUT_MS));
    }
    if (st.transition && this.transitionStart) {
      const total = Math.max(1, this.transitionStart.until - this.transitionStart.start);
      const left = st.transition.until - serverNow();
      fade = Math.min(fade, Math.max(0, left / total));
    }
    const loudness = Math.pow(10, (track?.gain_db ?? 0) / 20);
    // Loudness is perceived roughly logarithmically, so ease the sliders.
    const volume = Math.pow(st.volume / 100, 1.5) * Math.pow(usePlayer.getState().myVolume / 100, 1.5);
    const target = this.hold ? 0 : Math.max(0, Math.min(2, volume * fade * loudness * duckLevel()));
    if (!force && Math.abs(target - this.lastTarget) < 0.001) return;
    this.lastTarget = target;
    const g = this.gain.gain;
    const t = this.gain.context.currentTime;
    // Hold the current value, then glide: quick (~50ms) into silence, softer back up.
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(target, t, this.hold ? 0.012 : glide ?? 0.06);
  }
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

export const player = new JukeboxPlayer();
// A handle for troubleshooting playback from the browser console (tavernJukebox.player).
if (typeof window !== 'undefined') (window as unknown as { tavernJukebox: unknown }).tavernJukebox = { player, usePlayer };

export function useListening(serverId: number): boolean {
  return useStore((s) => !!s.listening[serverId]);
}
