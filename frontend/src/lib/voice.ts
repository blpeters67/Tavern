/**
 * Voice spaces: a WebRTC mesh. Every participant connects directly to every
 * other participant; the server only relays offers/answers/ICE candidates
 * (gateway op 5) and tracks who is where (op 4). Uses the "perfect
 * negotiation" pattern so either side can (re)negotiate at any time, which
 * is what makes adding a camera or screen share mid-call painless.
 */

import { create } from 'zustand';
import { gateway } from '../api/gateway';
import { api } from '../api/http';
import { toast } from '../components/Toasts';
import { go } from '../store/actions';
import { getState, persistUi, setState, useStore } from '../store/store';
import type { VoiceState } from '../store/types';
import { on } from './events';
import { levelFraction, MicChain, TICK_MS, VoiceActivity } from './micChain';
import { audioContext, playSound, setOutputDevice } from './sounds';
import { load, save } from './storage';

/** Browsers hide the mic and camera on plain http pages (other than localhost). */
const INSECURE = 'Browsers only allow the microphone and camera on secure pages. Open Tavern at its https:// address to talk; you can still listen here.';

// ---------------------------------------------------------------------------
// Preferences (per browser)
// ---------------------------------------------------------------------------

export interface VoicePrefs {
  inputDeviceId: string;
  outputDeviceId: string;
  cameraDeviceId: string;
  inputMode: 'vad' | 'ptt';
  autoSensitivity: boolean;
  threshold: number; // dB, used when autoSensitivity is off
  pttKey: string; // KeyboardEvent.code
  pttKeyLabel: string;
  echoCancellation: boolean;
  /** 'standard' = the browser's own noise suppression; 'isolation' = GTCRN (see micChain.ts). */
  noiseMode: NoiseMode;
  autoGainControl: boolean;
  inputVolume: number; // 0..2
  outputVolume: number; // 0..2
  /** Screen sharing: how big and how smooth (see streamBitrate). */
  streamQuality: StreamQuality;
}

export type NoiseMode = 'off' | 'standard' | 'isolation';

// ---------------------------------------------------------------------------
// Screen share quality
// ---------------------------------------------------------------------------

/** Height of the shared picture (0 = the screen's own size). */
export type StreamResolution = 720 | 1080 | 1440 | 0;
export type StreamFps = 15 | 30 | 60;
/**
 * What to keep when the connection or the computer can't keep up:
 * 'motion' keeps it smooth (lowers the sharpness), for games and videos;
 * 'detail' keeps it sharp (lowers the frame rate), for text and code.
 */
export type StreamOptimize = 'motion' | 'detail';

export interface StreamQuality {
  resolution: StreamResolution;
  fps: StreamFps;
  optimize: StreamOptimize;
}

export const STREAM_RESOLUTIONS: StreamResolution[] = [720, 1080, 1440, 0];
export const STREAM_FPS: StreamFps[] = [15, 30, 60];
export const DEFAULT_STREAM_QUALITY: StreamQuality = { resolution: 1080, fps: 30, optimize: 'motion' };

const RES_SIZE: Record<Exclude<StreamResolution, 0>, [number, number]> = { 720: [1280, 720], 1080: [1920, 1080], 1440: [2560, 1440] };

/**
 * The most a stream sends to each viewer (bits per second). Every viewer gets
 * their own copy (calls connect people directly), and each connection's own
 * congestion control keeps it lower whenever the upload can't take it.
 */
const STREAM_BITRATE: Record<StreamResolution, Record<StreamFps, number>> = {
  720: { 15: 1_200_000, 30: 2_000_000, 60: 3_200_000 },
  1080: { 15: 2_000_000, 30: 3_500_000, 60: 5_500_000 },
  1440: { 15: 3_000_000, 30: 5_000_000, 60: 8_000_000 },
  0: { 15: 4_000_000, 30: 6_500_000, 60: 10_000_000 },
};

export function streamBitrate(q: StreamQuality): number {
  return STREAM_BITRATE[q.resolution]?.[q.fps] ?? STREAM_BITRATE[1080][30];
}

export function normalizeStreamQuality(q: Partial<StreamQuality> | null | undefined): StreamQuality {
  const resolution = STREAM_RESOLUTIONS.includes(q?.resolution as StreamResolution) ? (q!.resolution as StreamResolution) : DEFAULT_STREAM_QUALITY.resolution;
  const fps = STREAM_FPS.includes(q?.fps as StreamFps) ? (q!.fps as StreamFps) : DEFAULT_STREAM_QUALITY.fps;
  const optimize = q?.optimize === 'detail' ? 'detail' : 'motion';
  return { resolution, fps, optimize };
}

/** Capture constraints: the browser scales the screen down to fit (keeping its shape). */
function displayConstraints(q: StreamQuality): MediaTrackConstraints {
  const c: MediaTrackConstraints = { frameRate: { ideal: q.fps, max: q.fps } };
  if (q.resolution) {
    const [w, h] = RES_SIZE[q.resolution];
    c.width = { max: w };
    c.height = { max: h };
  }
  return c;
}

/** What a stream is really sending right now, across every viewer. */
export interface StreamStats {
  viewers: number;
  width: number;
  height: number;
  fps: number;
  /** Total upload for the stream (bits per second). */
  bitrate: number;
  /** Why it's below what was asked for, if it is. */
  limit: 'bandwidth' | 'cpu' | null;
}

/** Isolation by default on computers that have the power for it (like Discord's Krisp); phones start on standard. */
function defaultNoiseMode(): NoiseMode {
  const phone = typeof window !== 'undefined' && window.matchMedia?.('(pointer: coarse)').matches;
  const cores = typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2;
  return !phone && cores >= 4 ? 'isolation' : 'standard';
}

const DEFAULT_PREFS: VoicePrefs = {
  inputDeviceId: 'default',
  outputDeviceId: 'default',
  cameraDeviceId: 'default',
  inputMode: 'vad',
  autoSensitivity: true,
  threshold: -50,
  pttKey: 'Backquote',
  pttKeyLabel: '`',
  echoCancellation: true,
  noiseMode: 'standard',
  autoGainControl: true,
  inputVolume: 1,
  outputVolume: 1,
  streamQuality: DEFAULT_STREAM_QUALITY,
};

export function voicePrefs(): VoicePrefs {
  const saved = load<Partial<VoicePrefs> & { noiseSuppression?: boolean }>('voicePrefs', {});
  const prefs = { ...DEFAULT_PREFS, noiseMode: defaultNoiseMode(), ...saved };
  prefs.streamQuality = normalizeStreamQuality(saved.streamQuality);
  // Older versions had a simple on/off switch.
  if (!saved.noiseMode && saved.noiseSuppression === false) prefs.noiseMode = 'off';
  delete (prefs as { noiseSuppression?: boolean }).noiseSuppression;
  return prefs;
}

/** getUserMedia constraints for the microphone. Isolation replaces the browser's own suppression (never both). */
export function micConstraints(prefs: VoicePrefs = voicePrefs()): MediaTrackConstraints {
  return {
    deviceId: prefs.inputDeviceId && prefs.inputDeviceId !== 'default' ? { ideal: prefs.inputDeviceId } : undefined,
    echoCancellation: prefs.echoCancellation,
    noiseSuppression: prefs.noiseMode === 'standard',
    autoGainControl: prefs.autoGainControl,
    channelCount: { ideal: 1 },
  };
}

export function setVoicePrefs(patch: Partial<VoicePrefs>): void {
  savePrefs(patch);
  engine.applyPrefs(patch);
}

/** Remember a change without applying it to a call. */
function savePrefs(patch: Partial<VoicePrefs>): void {
  const next = { ...voicePrefs(), ...patch };
  save('voicePrefs', next);
  useVoiceUi.setState({ prefs: next });
}

/** Per-user playback volume (0..2) and local mutes, remembered across sessions. */
export function userVolume(userId: number): number {
  return load<Record<number, number>>('userVolumes', {})[userId] ?? 1;
}
export function setUserVolume(userId: number, volume: number): void {
  const all = load<Record<number, number>>('userVolumes', {});
  all[userId] = volume;
  save('userVolumes', all);
  useVoiceUi.setState((s) => ({ volumes: { ...s.volumes, [userId]: volume } }));
  engine.refreshGains();
}
export function isLocallyMuted(userId: number): boolean {
  return !!load<Record<number, boolean>>('localMutes', {})[userId];
}
export function setLocallyMuted(userId: number, muted: boolean): void {
  const all = load<Record<number, boolean>>('localMutes', {});
  if (muted) all[userId] = true;
  else delete all[userId];
  save('localMutes', all);
  useVoiceUi.setState((s) => ({ localMutes: { ...s.localMutes, [userId]: muted } }));
  engine.refreshGains();
}

// ---------------------------------------------------------------------------
// UI-facing state (video tiles, levels) kept outside the main store because
// MediaStreams aren't plain data.
// ---------------------------------------------------------------------------

export interface VideoTile {
  key: string;
  userId: number;
  kind: 'camera' | 'screen';
  stream: MediaStream;
  local: boolean;
}

interface VoiceUi {
  tiles: VideoTile[];
  level: number; // local mic level 0..1 (for settings meters)
  /** The voice-activity threshold in use right now (dB): the slider, or the automatic one. */
  threshold: number;
  selfSpeaking: boolean;
  /** Voice isolation: is it really running, and why not if it failed. */
  isolating: boolean;
  isolationError: string | null;
  prefs: VoicePrefs;
  volumes: Record<number, number>;
  localMutes: Record<number, boolean>;
  connection: 'new' | 'connecting' | 'connected' | 'failed';
  peerStates: Record<number, RTCPeerConnectionState>;
}

export const useVoiceUi = create<VoiceUi>(() => ({
  tiles: [],
  level: 0,
  threshold: -50,
  selfSpeaking: false,
  isolating: false,
  isolationError: null,
  prefs: voicePrefs(),
  volumes: load<Record<number, number>>('userVolumes', {}),
  localMutes: load<Record<number, boolean>>('localMutes', {}),
  connection: 'new',
  peerStates: {},
}));

// ---------------------------------------------------------------------------
// Peers
// ---------------------------------------------------------------------------

interface MediaMap {
  mic?: string | null;
  camera?: string | null;
  screen?: string | null;
}

interface Peer {
  userId: number;
  pc: RTCPeerConnection;
  polite: boolean;
  makingOffer: boolean;
  ignoreOffer: boolean;
  media: MediaMap;
  remoteStreams: Map<string, MediaStream>;
  audioNodes: Map<string, { el: HTMLAudioElement; src: MediaStreamAudioSourceNode; gain: GainNode }>;
  senders: { mic?: RTCRtpSender; camera?: RTCRtpSender; screen?: RTCRtpSender; screenAudio?: RTCRtpSender };
  pendingCandidates: RTCIceCandidateInit[];
  restartTimer: number | null;
  /** Set once a first offer/answer has gone through. */
  negotiated: boolean;
  watchdog: number | null;
  /** Signalling counters, for troubleshooting from the console. */
  stats: { offersSent: number; offersIgnored: number; candSent: number; candRecv: number; candFailed: number };
}

/** Cameras: 720p at up to 30 fps is plenty for a face. */
const CAMERA_BITRATE = 900_000;
/** A voice space's microphone bitrate (kbps) until someone sets one: Discord's default (browsers pick 32). */
const DEFAULT_VOICE_KBPS = 64;

/** How long a round trip to one person in the call takes, for the Voice Connected tooltip. */
export interface PeerLatency {
  userId: number;
  /** Milliseconds, or null while it's still connecting. */
  rtt: number | null;
  /** Going through a TURN relay instead of straight between the two browsers. */
  relay: boolean;
  state: RTCPeerConnectionState;
}

let iceCache: { servers: RTCIceServer[]; at: number } | null = null;

async function iceServers(): Promise<RTCIceServer[]> {
  if (iceCache && Date.now() - iceCache.at < 30 * 60 * 1000) return iceCache.servers;
  try {
    const res = await api.get<{ ice_servers: RTCIceServer[] }>('/api/voice/ice-servers');
    iceCache = { servers: res.ice_servers, at: Date.now() };
    return res.ice_servers;
  } catch {
    return iceCache?.servers ?? [{ urls: ['stun:stun.cloudflare.com:3478'] }];
  }
}

function signal(to: number, data: unknown) {
  gateway.send(5, { to, data });
}

class VoiceEngine {
  channelId: number | null = null;
  serverId: number | null = null;
  private confirmed = false;
  private peers = new Map<number, Peer>();
  private ice: RTCIceServer[] = [];
  private mic: MediaStream | null = null;
  private micTrack: MediaStreamTrack | null = null;
  private camera: MediaStream | null = null;
  private screen: MediaStream | null = null;
  private screenQuality: StreamQuality = DEFAULT_STREAM_QUALITY;
  /** Last byte counts per outbound stream, to work out bitrates. */
  private statPrev = new Map<string, { bytes: number; at: number }>();
  /** The latest limits asked of each sender (a newer request replaces an older one). */
  private tuning = new WeakMap<RTCRtpSender, object>();
  /** mic → processing (micChain.ts) → gate → sendDest: what peers hear. The
   *  gate is a gain we can ramp, so voice activity fades instead of clicking. */
  private chain: MicChain | null = null;
  private gate: GainNode | null = null;
  private sendDest: MediaStreamAudioDestinationNode | null = null;
  private levelTimer: number | null = null;
  private speaking = false;
  /** Gain the gate is heading to (null = unknown, re-apply). */
  private gateOpen: number | null = null;
  private vad = new VoiceActivity();
  private pttHeld = false;
  private joinToken = 0;
  /** Signals that arrived when we weren't in a call (troubleshooting). */
  droppedSignals = 0;
  private early: { from: number; data: Record<string, unknown> }[] = [];

  constructor() {
    on('voice-state', (d: VoiceState) => this.onVoiceState(d));
    on('voice-signal', (d: { from: number; data: Record<string, unknown> }) => void this.onSignal(d.from, d.data));
    on('voice-join-error', (d: { message: string }) => {
      toast(d.message);
      this.cleanup(false);
    });
    on('voice-force-disconnect', () => {
      this.cleanup(true);
    });
    on('voice-replaced', () => {
      toast('You joined voice somewhere else, so this tab disconnected.', 'info');
      this.cleanup(false);
    });
    on('voice-moved', (d: { channel_id: number }) => this.onMoved(d.channel_id));
    on('ready', () => this.onReady());
    on('server-gone', (id: number) => {
      if (this.serverId === id) this.cleanup(true);
    });
    window.addEventListener('keydown', (e) => this.onKey(e, true));
    window.addEventListener('keyup', (e) => this.onKey(e, false));
    window.addEventListener('blur', () => {
      if (this.pttHeld) {
        this.pttHeld = false;
        this.updateGate();
      }
    });
    window.addEventListener('beforeunload', () => {
      if (this.channelId) gateway.send(4, { channel_id: null });
    });
  }

  // -- joining & leaving -------------------------------------------------------------
  async join(channelId: number): Promise<void> {
    const s = getState();
    const channel = s.channels[channelId];
    if (!channel || !channel.server_id) return;
    if (this.channelId === channelId && this.confirmed) return;
    if (this.channelId) this.closeAllPeers();
    this.early = [];
    const token = ++this.joinToken;
    this.channelId = channelId;
    this.serverId = channel.server_id;
    this.confirmed = false;
    setState((st) => ({ voice: { ...st.voice, channelId, serverId: channel.server_id, status: 'connecting', video: false, stream: false } }));
    useVoiceUi.setState({ connection: 'connecting' });
    audioContext();
    const [ice] = await Promise.all([iceServers(), this.mic ? Promise.resolve() : this.startMic()]);
    if (token !== this.joinToken) return;
    this.ice = ice;
    this.sendState();
  }

  leave(): void {
    if (!this.channelId) return;
    gateway.send(4, { channel_id: null });
    this.cleanup(true);
  }

  private cleanup(sound: boolean): void {
    const was = this.channelId;
    this.joinToken++;
    this.closeAllPeers();
    this.stopCamera(false);
    this.stopScreen(false);
    this.stopMic();
    this.channelId = null;
    this.serverId = null;
    this.confirmed = false;
    this.early = [];
    setState((st) => ({ voice: { ...st.voice, channelId: null, serverId: null, status: 'idle', video: false, stream: false } }));
    useVoiceUi.setState({ tiles: [], connection: 'new', peerStates: {}, selfSpeaking: false });
    if (was && sound && getState().me?.settings.voice_sounds) playSound('leave');
  }

  private sendState(): void {
    if (!this.channelId) return;
    const v = getState().voice;
    gateway.send(4, {
      channel_id: this.channelId,
      self_mute: v.selfMute || v.selfDeaf || !this.micTrack,
      self_deaf: v.selfDeaf,
      self_video: !!this.camera,
      self_stream: !!this.screen,
    });
  }

  private onReady(): void {
    // Gateway reconnected: resume our seat (the server holds it briefly).
    if (this.channelId) {
      this.confirmed = false;
      this.sendState();
    }
  }

  /** A moderator moved us: drop the old space's connections and take our seat in the new one. */
  private onMoved(channelId: number): void {
    if (!this.channelId || this.channelId === channelId) return;
    const s = getState();
    const from = this.channelId;
    this.closeAllPeers();
    this.early = [];
    this.channelId = channelId;
    this.confirmed = false;
    setState((st) => ({ voice: { ...st.voice, channelId } }));
    // If we were looking at the old space, follow along to the new one.
    const serverId = s.channels[channelId]?.server_id;
    if (serverId && window.location.pathname === `/channels/${serverId}/${from}`) go(`/channels/${serverId}/${channelId}`);
    // Our new seat may already be in the store (older servers announce it first).
    const mine = s.me ? getState().voiceStates[s.me.id] : undefined;
    if (mine?.channel_id === channelId) this.confirmSeat();
  }

  /** The server has us in `this.channelId`: connect to everyone there. */
  private confirmSeat(): void {
    const me = getState().me;
    if (!me || this.confirmed) return;
    this.confirmed = true;
    setState((st) => ({ voice: { ...st.voice, status: 'connected' } }));
    useVoiceUi.setState({ connection: 'connected' });
    if (me.settings.voice_sounds) playSound('join');
    this.syncPeers();
    const early = this.early.splice(0);
    void (async () => {
      for (const e of early) await this.onSignal(e.from, e.data);
    })();
  }

  private onVoiceState(d: VoiceState): void {
    const me = getState().me;
    if (!me || !this.channelId) return;
    if (d.user_id === me.id) {
      if (d.channel_id === this.channelId && !this.confirmed) this.confirmSeat();
      return;
    }
    if (!this.confirmed) return;
    const inMyChannel = d.channel_id === this.channelId;
    const hasPeer = this.peers.has(d.user_id);
    if (inMyChannel && !hasPeer) {
      this.createPeer(d.user_id);
      if (me.settings.voice_sounds) playSound('other-join');
    } else if (!inMyChannel && hasPeer) {
      this.closePeer(d.user_id);
      if (me.settings.voice_sounds) playSound('other-leave');
    }
    this.refreshGains();
  }

  /** Make our peer list match who is in the channel right now. */
  private syncPeers(): void {
    const s = getState();
    const me = s.me;
    if (!me || !this.channelId) return;
    const present = new Set(
      Object.values(s.voiceStates)
        .filter((v) => v.channel_id === this.channelId && v.user_id !== me.id)
        .map((v) => v.user_id),
    );
    for (const uid of [...this.peers.keys()]) if (!present.has(uid)) this.closePeer(uid);
    for (const uid of present) if (!this.peers.has(uid)) this.createPeer(uid);
  }

  // -- peers ---------------------------------------------------------------------------
  private createPeer(userId: number): Peer {
    const me = getState().me!;
    const pc = new RTCPeerConnection({ iceServers: this.ice, bundlePolicy: 'max-bundle' });
    const peer: Peer = {
      userId,
      pc,
      polite: me.id > userId,
      makingOffer: false,
      ignoreOffer: false,
      media: {},
      remoteStreams: new Map(),
      audioNodes: new Map(),
      senders: {},
      pendingCandidates: [],
      restartTimer: null,
      negotiated: false,
      watchdog: null,
      stats: { offersSent: 0, offersIgnored: 0, candSent: 0, candRecv: 0, candFailed: 0 },
    };
    this.peers.set(userId, peer);

    pc.onnegotiationneeded = async () => {
      // On a fresh connection only the impolite side offers; the polite side's
      // tracks ride along in its answer. Two simultaneous first offers ("glare")
      // can leave Chrome without ICE candidates after the implicit rollback.
      if (peer.polite && !peer.negotiated) return;
      try {
        peer.makingOffer = true;
        await pc.setLocalDescription();
        peer.stats.offersSent++;
        signal(userId, { description: pc.localDescription });
      } catch (err) {
        console.warn('negotiation failed', err);
      } finally {
        peer.makingOffer = false;
      }
    };
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate) return;
      peer.stats.candSent++;
      signal(userId, { candidate });
    };
    pc.ontrack = (ev) => this.onRemoteTrack(peer, ev);
    pc.onconnectionstatechange = () => {
      useVoiceUi.setState((st) => ({ peerStates: { ...st.peerStates, [userId]: pc.connectionState } }));
      if (pc.connectionState === 'failed') {
        pc.restartIce();
      } else if (pc.connectionState === 'disconnected') {
        if (peer.restartTimer === null) {
          peer.restartTimer = window.setTimeout(() => {
            peer.restartTimer = null;
            if (pc.connectionState === 'disconnected') pc.restartIce();
          }, 4000);
        }
      }
    };

    // Our media: always the mic (even if muted), plus camera/screen if on.
    if (this.micTrack && this.sendDest) {
      peer.senders.mic = pc.addTrack(this.micTrack, this.sendDest.stream);
      this.tuneSender(peer.senders.mic, { maxBitrate: this.micBitrate() });
    } else pc.addTransceiver('audio', { direction: 'recvonly' });
    if (this.camera) {
      peer.senders.camera = pc.addTrack(this.camera.getVideoTracks()[0], this.camera);
      this.tuneSender(peer.senders.camera, { maxBitrate: CAMERA_BITRATE });
    }
    if (this.screen) {
      peer.senders.screen = pc.addTrack(this.screen.getVideoTracks()[0], this.screen);
      this.tuneScreenSender(peer.senders.screen);
      const a = this.screen.getAudioTracks()[0];
      if (a) peer.senders.screenAudio = pc.addTrack(a, this.screen);
    }
    this.sendMediaMap(userId);
    this.armWatchdog(peer, 0);
    return peer;
  }

  /** If a peer never gets connected, kick it with an ICE restart (a few times). */
  private armWatchdog(peer: Peer, attempt: number): void {
    if (peer.watchdog !== null) window.clearTimeout(peer.watchdog);
    peer.watchdog = window.setTimeout(() => {
      peer.watchdog = null;
      if (this.peers.get(peer.userId) !== peer) return;
      const state = peer.pc.connectionState;
      if (state === 'connected' || state === 'closed') return;
      if (attempt >= 4) return;
      // Only one side restarts, so the restarts don't collide.
      if (!peer.polite || attempt >= 2) {
        peer.negotiated = true;
        peer.pc.restartIce();
      }
      this.armWatchdog(peer, attempt + 1);
    }, 8000 + attempt * 4000);
  }

  private closePeer(userId: number): void {
    const peer = this.peers.get(userId);
    if (!peer) return;
    this.peers.delete(userId);
    if (peer.restartTimer !== null) window.clearTimeout(peer.restartTimer);
    if (peer.watchdog !== null) window.clearTimeout(peer.watchdog);
    for (const node of peer.audioNodes.values()) {
      // Fade out before unplugging, so someone leaving mid-word doesn't click.
      const g = node.gain.gain;
      const t = node.gain.context.currentTime;
      g.cancelScheduledValues(t);
      g.setValueAtTime(g.value, t);
      g.setTargetAtTime(0, t, 0.01);
      window.setTimeout(() => {
        node.src.disconnect();
        node.gain.disconnect();
        node.el.srcObject = null;
      }, 80);
    }
    peer.pc.onnegotiationneeded = null;
    peer.pc.onicecandidate = null;
    peer.pc.ontrack = null;
    peer.pc.onconnectionstatechange = null;
    // Closing cuts their audio off, so let the fade above finish first.
    if (peer.audioNodes.size) window.setTimeout(() => peer.pc.close(), 80);
    else peer.pc.close();
    useVoiceUi.setState((st) => {
      const peerStates = { ...st.peerStates };
      delete peerStates[userId];
      return { tiles: st.tiles.filter((t) => t.local || t.userId !== userId), peerStates };
    });
  }

  private closeAllPeers(): void {
    for (const uid of [...this.peers.keys()]) this.closePeer(uid);
  }

  private async onSignal(from: number, data: Record<string, unknown>): Promise<void> {
    if (!this.channelId) {
      this.droppedSignals++;
      return;
    }
    if (!this.confirmed) {
      // Someone already in the space can reach us before the server's echo of
      // our own join does; hold their offer until we're in.
      this.early.push({ from, data });
      return;
    }
    let peer = this.peers.get(from);
    if (!peer) {
      const vs = getState().voiceStates[from];
      if (!vs || vs.channel_id !== this.channelId) return;
      peer = this.createPeer(from);
    }
    const pc = peer.pc;
    try {
      if (data.description) {
        const description = data.description as RTCSessionDescriptionInit;
        const collision = description.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable');
        peer.ignoreOffer = !peer.polite && collision;
        if (peer.ignoreOffer) {
          peer.stats.offersIgnored++;
          return;
        }
        await pc.setRemoteDescription(description);
        peer.negotiated = true;
        for (const c of peer.pendingCandidates.splice(0)) {
          await pc.addIceCandidate(c).catch(() => {
            peer.stats.candFailed++;
          });
        }
        if (description.type === 'offer') {
          await pc.setLocalDescription();
          signal(from, { description: pc.localDescription });
        }
      } else if (data.candidate) {
        const candidate = data.candidate as RTCIceCandidateInit;
        peer.stats.candRecv++;
        if (!pc.remoteDescription) {
          peer.pendingCandidates.push(candidate);
          return;
        }
        try {
          await pc.addIceCandidate(candidate);
        } catch (err) {
          peer.stats.candFailed++;
          if (!peer.ignoreOffer) console.warn('bad candidate', err);
        }
      } else if (data.media) {
        peer.media = data.media as MediaMap;
        this.refreshRemoteTiles(peer);
      }
    } catch (err) {
      console.warn('signal handling failed', err);
    }
  }

  private sendMediaMap(to?: number): void {
    const media: MediaMap = { mic: this.micTrack && this.sendDest ? this.sendDest.stream.id : null, camera: this.camera?.id ?? null, screen: this.screen?.id ?? null };
    const targets = to !== undefined ? [to] : [...this.peers.keys()];
    for (const uid of targets) signal(uid, { media });
  }

  private onRemoteTrack(peer: Peer, ev: RTCTrackEvent): void {
    const stream = ev.streams[0] ?? new MediaStream([ev.track]);
    peer.remoteStreams.set(stream.id, stream);
    if (ev.track.kind === 'audio') {
      this.attachAudio(peer, stream);
    } else {
      this.refreshRemoteTiles(peer);
    }
    ev.track.onunmute = () => this.refreshRemoteTiles(peer);
    ev.track.onmute = () => this.refreshRemoteTiles(peer);
    ev.track.onended = () => this.refreshRemoteTiles(peer);
    stream.onremovetrack = () => this.refreshRemoteTiles(peer);
  }

  private attachAudio(peer: Peer, stream: MediaStream): void {
    if (peer.audioNodes.has(stream.id)) return;
    const ac = audioContext();
    // Chrome only feeds remote WebRTC audio into WebAudio if a media element
    // is also consuming the stream, so keep a muted one around.
    const el = new Audio();
    el.muted = true;
    el.srcObject = stream;
    void el.play().catch(() => {});
    const src = ac.createMediaStreamSource(stream);
    const gain = ac.createGain();
    // Fold whatever arrives into mono; the output then plays it in both ears.
    // (Voice can arrive as stereo with only the left side filled, which
    // otherwise plays in one ear.)
    gain.channelCount = 1;
    gain.channelCountMode = 'explicit';
    gain.channelInterpretation = 'speakers';
    src.connect(gain).connect(ac.destination);
    peer.audioNodes.set(stream.id, { el, src, gain });
    this.refreshGains();
  }

  private refreshRemoteTiles(peer: Peer): void {
    const tiles: VideoTile[] = [];
    for (const [id, stream] of peer.remoteStreams) {
      const video = stream.getVideoTracks().filter((t) => t.readyState === 'live' && !t.muted);
      if (!video.length) continue;
      const kind: 'camera' | 'screen' = peer.media.screen === id ? 'screen' : peer.media.camera === id ? 'camera' : 'camera';
      if (peer.media.camera !== id && peer.media.screen !== id && Object.keys(peer.media).length) continue;
      tiles.push({ key: `${peer.userId}:${kind}`, userId: peer.userId, kind, stream, local: false });
    }
    useVoiceUi.setState((st) => ({ tiles: [...st.tiles.filter((t) => t.local || t.userId !== peer.userId), ...tiles] }));
  }

  /** Apply deafen, per-user volume, local mutes and output volume to everyone. */
  refreshGains(): void {
    const s = getState();
    const prefs = voicePrefs();
    const deaf = s.voice.selfDeaf;
    const volumes = load<Record<number, number>>('userVolumes', {});
    const mutes = load<Record<number, boolean>>('localMutes', {});
    for (const peer of this.peers.values()) {
      const vol = deaf || mutes[peer.userId] ? 0 : (volumes[peer.userId] ?? 1) * prefs.outputVolume;
      for (const node of peer.audioNodes.values()) {
        node.gain.gain.setTargetAtTime(vol, node.gain.context.currentTime, 0.02);
      }
    }
  }

  // -- local media -----------------------------------------------------------------------
  private async startMic(): Promise<void> {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
      await this.setMicStream(stream);
    } catch (err) {
      const name = (err as DOMException).name;
      toast(
        !window.isSecureContext
          ? INSECURE
          : name === 'NotAllowedError'
            ? 'Tavern needs microphone access to talk. You joined muted; allow the microphone in your browser to speak.'
            : "Couldn't open your microphone. You joined muted.",
      );
      this.mic = null;
      this.micTrack = null;
    }
  }

  private async setMicStream(stream: MediaStream): Promise<void> {
    this.mic = stream;
    // The chain and the send track outlive mic swaps, so changing microphones
    // (or turning isolation on) never touches the connections.
    if (!this.chain || !this.gate || !this.sendDest) {
      const chain = (this.chain = new MicChain());
      this.gate = chain.ctx.createGain();
      this.gate.gain.value = 0;
      this.gate.channelCount = 1;
      this.gate.channelCountMode = 'explicit';
      this.gate.channelInterpretation = 'speakers';
      this.sendDest = chain.ctx.createMediaStreamDestination();
      this.sendDest.channelCount = 1;
      chain.out.connect(this.gate).connect(this.sendDest);
    }
    this.chain.setStream(stream);
    await this.applyIsolation();
    this.micTrack = stream.getAudioTracks().length ? this.sendDest.stream.getAudioTracks()[0] : null;
    if (this.levelTimer === null) this.levelTimer = window.setInterval(() => this.tickLevel(), TICK_MS);
    this.gateOpen = null;
    this.updateGate();
  }

  /** Voice isolation on or off, per the settings. Falls back to the browser's own suppression if it can't run. */
  private async applyIsolation(): Promise<void> {
    if (!this.chain) return;
    const want = voicePrefs().noiseMode === 'isolation';
    try {
      await this.chain.setIsolation(want);
      useVoiceUi.setState({ isolating: this.chain.isolating, isolationError: null });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Voice isolation couldn't start.";
      useVoiceUi.setState({ isolating: false, isolationError: message });
      toast(`${message} Using standard noise suppression instead.`, 'info');
      // Switch to the browser's own suppression once this mic has finished starting.
      savePrefs({ noiseMode: 'standard' });
      if (this.channelId) window.setTimeout(() => void this.restartMic(), 0);
    }
  }

  private stopMic(): void {
    if (this.levelTimer !== null) window.clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.chain?.setStream(null);
    this.mic?.getTracks().forEach((t) => t.stop());
    this.mic = null;
    this.micTrack = null;
    if (this.gate) this.gate.gain.value = 0;
    this.gateOpen = null;
    this.setSpeaking(false);
    useVoiceUi.setState({ level: 0 });
  }

  /** Swap microphones mid-call without renegotiating. */
  async restartMic(): Promise<void> {
    if (!this.channelId) return;
    const old = this.mic;
    await this.startMic();
    if (this.micTrack && this.sendDest) {
      // Same send track as before, unless we started without a mic.
      for (const peer of this.peers.values()) {
        if (!peer.senders.mic) {
          peer.senders.mic = peer.pc.addTrack(this.micTrack, this.sendDest.stream);
          this.tuneSender(peer.senders.mic, { maxBitrate: this.micBitrate() });
        }
      }
      this.sendMediaMap();
    }
    if (old !== this.mic) old?.getTracks().forEach((t) => t.stop());
    this.sendState();
  }

  private tickLevel(): void {
    if (!this.chain || !this.mic) return;
    const prefs = voicePrefs();
    const db = this.chain.levelDb() + 20 * Math.log10(Math.max(prefs.inputVolume, 0.01));
    const now = performance.now();
    const loud = this.vad.update(db, now, prefs.autoSensitivity, prefs.threshold);
    useVoiceUi.setState({ level: levelFraction(db), threshold: this.vad.threshold });
    const v = getState().voice;
    const muted = v.selfMute || v.selfDeaf || this.serverMuted();
    const speaking = prefs.inputMode === 'ptt' ? this.pttHeld && !muted && db > -70 : !muted && loud;
    this.setSpeaking(speaking);
    this.updateGate(speaking);
  }

  private serverMuted(): boolean {
    const me = getState().me;
    const vs = me ? getState().voiceStates[me.id] : undefined;
    return !!vs?.mute;
  }

  /** The actual mic gate: peers only hear you while you're "speaking".
   *  It opens in a few milliseconds and closes over ~0.1s, so no clicks. */
  private updateGate(speaking = this.speaking): void {
    if (!this.micTrack || !this.gate) return;
    const v = getState().voice;
    const prefs = voicePrefs();
    const muted = v.selfMute || v.selfDeaf || this.serverMuted();
    const open = !muted && (prefs.inputMode === 'ptt' ? this.pttHeld : speaking || this.channelId === null);
    const level = open ? Math.max(0, Math.min(2, prefs.inputVolume)) : 0;
    if (this.gateOpen === level) return;
    this.gateOpen = level;
    const g = this.gate.gain;
    const t = this.gate.context.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.setTargetAtTime(level, t, open ? 0.004 : 0.03);
  }

  private setSpeaking(speaking: boolean): void {
    if (speaking === this.speaking) return;
    this.speaking = speaking;
    useVoiceUi.setState({ selfSpeaking: speaking });
    if (this.channelId && this.confirmed) gateway.send(6, { speaking });
  }

  private onKey(e: KeyboardEvent, down: boolean): void {
    const prefs = voicePrefs();
    if (prefs.inputMode !== 'ptt' || e.code !== prefs.pttKey || e.repeat) return;
    const t = e.target as HTMLElement | null;
    // Don't hijack typing the PTT key into a text box (unless it's a modifier-ish key).
    if (down && t && t.closest('input, textarea, [contenteditable="true"]') && e.key.length === 1) return;
    this.pttHeld = down;
    this.updateGate();
  }

  // -- toggles -----------------------------------------------------------------------------
  setSelfMute(mute: boolean): void {
    const v = getState().voice;
    if (!mute && v.selfDeaf) {
      // Unmuting also undeafens, like Discord.
      setState((st) => ({ voice: { ...st.voice, selfMute: false, selfDeaf: false } }));
      if (getState().me?.settings.voice_sounds) playSound('undeafen');
    } else {
      setState((st) => ({ voice: { ...st.voice, selfMute: mute } }));
      if (getState().me?.settings.voice_sounds) playSound(mute ? 'mute' : 'unmute');
    }
    persistUi();
    this.updateGate();
    this.refreshGains();
    this.sendState();
  }

  setSelfDeaf(deaf: boolean): void {
    setState((st) => ({ voice: { ...st.voice, selfDeaf: deaf } }));
    if (getState().me?.settings.voice_sounds) playSound(deaf ? 'deafen' : 'undeafen');
    persistUi();
    this.updateGate();
    this.refreshGains();
    this.sendState();
  }

  async toggleCamera(): Promise<void> {
    if (this.camera) {
      this.stopCamera(true);
      return;
    }
    if (!this.channelId) return;
    const prefs = voicePrefs();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          deviceId: prefs.cameraDeviceId && prefs.cameraDeviceId !== 'default' ? { ideal: prefs.cameraDeviceId } : undefined,
          width: { ideal: 1280 },
          height: { ideal: 720 },
          frameRate: { ideal: 24, max: 30 },
        },
      });
      this.camera = stream;
      const track = stream.getVideoTracks()[0];
      track.onended = () => this.stopCamera(true);
      for (const peer of this.peers.values()) {
        peer.senders.camera = peer.pc.addTrack(track, stream);
        this.tuneSender(peer.senders.camera, { maxBitrate: CAMERA_BITRATE });
      }
      this.addLocalTile('camera', stream);
      setState((st) => ({ voice: { ...st.voice, video: true } }));
      this.sendMediaMap();
      this.sendState();
    } catch (err) {
      toast(!window.isSecureContext ? INSECURE : (err as DOMException).name === 'NotAllowedError' ? 'Camera access was blocked.' : "Couldn't start your camera.");
    }
  }

  private stopCamera(announce: boolean): void {
    if (!this.camera) return;
    for (const peer of this.peers.values()) {
      if (peer.senders.camera) {
        try {
          peer.pc.removeTrack(peer.senders.camera);
        } catch {
          /* closed */
        }
        peer.senders.camera = undefined;
      }
    }
    this.camera.getTracks().forEach((t) => t.stop());
    this.camera = null;
    this.removeLocalTile('camera');
    setState((st) => ({ voice: { ...st.voice, video: false } }));
    if (announce) {
      this.sendMediaMap();
      this.sendState();
    }
  }

  /** Share or stop sharing (sharing uses the saved quality; the Go Live window picks it first). */
  async toggleScreen(): Promise<void> {
    if (this.screen) {
      this.stopScreen(true);
      return;
    }
    await this.startScreen(voicePrefs().streamQuality);
  }

  stopScreenShare(): void {
    this.stopScreen(true);
  }

  isSharingScreen(): boolean {
    return !!this.screen;
  }

  /** Must run straight from a click: browsers only open the screen picker for one. */
  async startScreen(quality: StreamQuality): Promise<boolean> {
    if (this.screen) return true;
    if (!this.channelId) return false;
    if (!navigator.mediaDevices?.getDisplayMedia) {
      toast(window.isSecureContext ? "This browser can't share its screen." : INSECURE);
      return false;
    }
    const q = normalizeStreamQuality(quality);
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: displayConstraints(q),
        // The screen's own sound, untouched (voice processing would mangle music and games).
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
        // Chrome/Edge: don't offer this tab (a picture of itself, forever), let the
        // shared tab be switched, and offer the computer's sound with a whole screen.
        selfBrowserSurface: 'exclude',
        surfaceSwitching: 'include',
        systemAudio: 'include',
      } as DisplayMediaStreamOptions);
      if (!this.channelId) {
        stream.getTracks().forEach((t) => t.stop());
        return false;
      }
      this.screen = stream;
      this.screenQuality = q;
      const video = stream.getVideoTracks()[0];
      if ('contentHint' in video) video.contentHint = q.optimize;
      video.onended = () => this.stopScreen(true);
      const audio = stream.getAudioTracks()[0];
      for (const peer of this.peers.values()) {
        peer.senders.screen = peer.pc.addTrack(video, stream);
        this.tuneScreenSender(peer.senders.screen);
        if (audio) peer.senders.screenAudio = peer.pc.addTrack(audio, stream);
      }
      this.addLocalTile('screen', stream);
      setState((st) => ({ voice: { ...st.voice, stream: true } }));
      if (getState().me?.settings.voice_sounds) playSound('stream');
      this.sendMediaMap();
      this.sendState();
      return true;
    } catch (err) {
      if ((err as DOMException).name !== 'NotAllowedError') toast("Couldn't share your screen.");
      return false;
    }
  }

  /** Change a running stream's size, smoothness or focus without picking the screen again. */
  async setStreamQuality(quality: StreamQuality): Promise<void> {
    const q = normalizeStreamQuality(quality);
    this.screenQuality = q;
    const video = this.screen?.getVideoTracks()[0];
    if (!video) return;
    if ('contentHint' in video) video.contentHint = q.optimize;
    try {
      await video.applyConstraints(displayConstraints(q));
    } catch {
      /* the browser keeps the old size; the encoder limits below still apply */
    }
    for (const peer of this.peers.values()) if (peer.senders.screen) this.tuneScreenSender(peer.senders.screen);
  }

  private tuneScreenSender(sender: RTCRtpSender): void {
    const q = this.screenQuality;
    this.tuneSender(sender, {
      maxBitrate: streamBitrate(q),
      maxFramerate: q.fps,
      degradation: q.optimize === 'motion' ? 'maintain-framerate' : 'maintain-resolution',
    });
  }

  /** What the stream is really sending (for the quality window). */
  async streamStats(): Promise<StreamStats | null> {
    if (!this.screen) return null;
    const out: StreamStats = { viewers: 0, width: 0, height: 0, fps: 0, bitrate: 0, limit: null };
    let fpsMin = Infinity;
    for (const peer of this.peers.values()) {
      const sender = peer.senders.screen;
      if (!sender) continue;
      let report: RTCStatsReport;
      try {
        report = await sender.getStats();
      } catch {
        continue;
      }
      report.forEach((st) => {
        if (st.type !== 'outbound-rtp' || (st.kind && st.kind !== 'video')) return;
        out.viewers++;
        if (st.frameWidth && st.frameHeight && (!out.width || st.frameWidth * st.frameHeight < out.width * out.height)) {
          out.width = st.frameWidth;
          out.height = st.frameHeight;
        }
        if (typeof st.framesPerSecond === 'number') fpsMin = Math.min(fpsMin, st.framesPerSecond);
        const prev = this.statPrev.get(st.id);
        if (prev && st.timestamp > prev.at) out.bitrate += ((st.bytesSent - prev.bytes) * 8 * 1000) / (st.timestamp - prev.at);
        this.statPrev.set(st.id, { bytes: st.bytesSent, at: st.timestamp });
        const reason = st.qualityLimitationReason;
        if (reason === 'bandwidth') out.limit = 'bandwidth';
        else if (reason === 'cpu' && out.limit !== 'bandwidth') out.limit = 'cpu';
      });
    }
    out.fps = Number.isFinite(fpsMin) ? Math.round(fpsMin) : 0;
    return out;
  }

  private stopScreen(announce: boolean): void {
    if (!this.screen) return;
    for (const peer of this.peers.values()) {
      for (const key of ['screen', 'screenAudio'] as const) {
        const sender = peer.senders[key];
        if (sender) {
          try {
            peer.pc.removeTrack(sender);
          } catch {
            /* closed */
          }
          peer.senders[key] = undefined;
        }
      }
    }
    this.screen.getTracks().forEach((t) => t.stop());
    this.screen = null;
    this.statPrev.clear();
    this.removeLocalTile('screen');
    setState((st) => ({ voice: { ...st.voice, stream: false } }));
    if (announce) {
      this.sendMediaMap();
      this.sendState();
    }
  }

  /** The bitrate everyone's microphone uses in this voice space (its settings, or 64 kbps). */
  private micBitrate(): number {
    const kbps = this.channelId ? getState().channels[this.channelId]?.bitrate : undefined;
    return (kbps || DEFAULT_VOICE_KBPS) * 1000;
  }

  /** The voice space's bitrate changed: send every copy of our voice at the new rate. */
  retuneMic(): void {
    for (const peer of this.peers.values()) {
      if (peer.senders.mic) this.tuneSender(peer.senders.mic, { maxBitrate: this.micBitrate() });
    }
  }

  /** Round trip to each person in the call, from the connection the two browsers picked. */
  async peerLatency(): Promise<PeerLatency[]> {
    const out: PeerLatency[] = [];
    for (const peer of this.peers.values()) {
      let rtt: number | null = null;
      let relay = false;
      try {
        const stats = await peer.pc.getStats();
        let pairId: string | undefined;
        stats.forEach((st) => {
          if (st.type === 'transport' && st.selectedCandidatePairId) pairId = st.selectedCandidatePairId;
        });
        let pair: { currentRoundTripTime?: number; localCandidateId?: string; remoteCandidateId?: string } | undefined;
        stats.forEach((st) => {
          // Chrome and Safari name the pair in use on the transport; Firefox marks it `selected`.
          if (st.type === 'candidate-pair' && (pairId ? st.id === pairId : st.selected || (st.nominated && st.state === 'succeeded'))) pair = st;
        });
        if (pair) {
          if (typeof pair.currentRoundTripTime === 'number') rtt = Math.round(pair.currentRoundTripTime * 1000);
          const local = pair.localCandidateId ? stats.get(pair.localCandidateId) : undefined;
          const remote = pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : undefined;
          relay = local?.candidateType === 'relay' || remote?.candidateType === 'relay';
        }
      } catch {
        /* the connection closed meanwhile */
      }
      out.push({ userId: peer.userId, rtt, relay, state: peer.pc.connectionState });
    }
    return out;
  }

  /**
   * Encoder limits for one viewer's copy of a video. The sender only takes some
   * of them once the connection has been negotiated (Chrome refuses a
   * degradation preference before that), so keep trying for a few seconds
   * until everything reads back as set.
   */
  private tuneSender(sender: RTCRtpSender, opts: { maxBitrate: number; maxFramerate?: number; degradation?: 'maintain-framerate' | 'maintain-resolution' | 'balanced' }): void {
    const token = {};
    this.tuning.set(sender, token);
    let tries = 0;
    const again = () => {
      if (tries++ < 24 && this.tuning.get(sender) === token) window.setTimeout(apply, tries < 6 ? 300 : 1000);
    };
    const apply = async () => {
      if (this.tuning.get(sender) !== token || !sender.track) return;
      const params = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      if (!params.encodings?.length) return again();
      params.encodings[0].maxBitrate = opts.maxBitrate;
      if (opts.maxFramerate) params.encodings[0].maxFramerate = opts.maxFramerate;
      // Some browsers never take a degradation preference: stop asking after a while.
      const degradation = tries < 10 ? opts.degradation : undefined;
      if (degradation) params.degradationPreference = degradation;
      try {
        await sender.setParameters(params);
      } catch {
        // Not yet (or never, in an older browser): set the rest without it, then try again.
        const retry = sender.getParameters();
        if (retry.encodings?.length) {
          retry.encodings[0].maxBitrate = opts.maxBitrate;
          if (opts.maxFramerate) retry.encodings[0].maxFramerate = opts.maxFramerate;
          await sender.setParameters(retry).catch(() => undefined);
        }
      }
      const got = sender.getParameters() as RTCRtpSendParameters & { degradationPreference?: string };
      const enc = got.encodings?.[0];
      const done = !!enc && enc.maxBitrate === opts.maxBitrate && (!degradation || got.degradationPreference === degradation);
      if (!done) again();
      else this.tuning.delete(sender);
    };
    void apply();
  }

  private addLocalTile(kind: 'camera' | 'screen', stream: MediaStream): void {
    const me = getState().me!;
    useVoiceUi.setState((st) => ({
      tiles: [...st.tiles.filter((t) => !(t.local && t.kind === kind)), { key: `me:${kind}`, userId: me.id, kind, stream, local: true }],
    }));
  }

  private removeLocalTile(kind: 'camera' | 'screen'): void {
    useVoiceUi.setState((st) => ({ tiles: st.tiles.filter((t) => !(t.local && t.kind === kind)) }));
  }

  // -- preferences ----------------------------------------------------------------------------
  applyPrefs(patch: Partial<VoicePrefs>): void {
    if ('outputVolume' in patch) this.refreshGains();
    if ('outputDeviceId' in patch) void this.applyOutputDevice();
    if (patch.streamQuality && this.screen) void this.setStreamQuality(patch.streamQuality);
    const micKeys: (keyof VoicePrefs)[] = ['inputDeviceId', 'echoCancellation', 'noiseMode', 'autoGainControl'];
    if (micKeys.some((k) => k in patch) && this.channelId) void this.restartMic();
    if ('inputMode' in patch || 'inputVolume' in patch) {
      this.gateOpen = null;
      this.updateGate();
    }
  }

  async applyOutputDevice(): Promise<void> {
    await setOutputDevice(voicePrefs().outputDeviceId);
  }

  get localCamera(): MediaStream | null {
    return this.camera;
  }
}

export const engine = new VoiceEngine();

// A voice space's bitrate can change mid-call (its settings): follow it.
useStore.subscribe((st, prev) => {
  const id = engine.channelId;
  if (id && st.channels[id]?.bitrate !== prev.channels[id]?.bitrate) engine.retuneMic();
});
// Contexts are made on first use; tell the sound module where they should play.
void setOutputDevice(voicePrefs().outputDeviceId);

export function joinVoice(channelId: number): void {
  void engine.join(channelId);
}

export function leaveVoice(): void {
  engine.leave();
}

export async function listDevices(): Promise<MediaDeviceInfo[]> {
  try {
    return await navigator.mediaDevices.enumerateDevices();
  } catch {
    return [];
  }
}

/**
 * The Settings mic check (outside calls): the same processing as a call, so
 * the meter and "hear myself" show exactly what others would hear.
 */
export class MicMonitor {
  private stream: MediaStream | null = null;
  private chain: MicChain | null = null;
  private loop: GainNode | null = null;
  private timer: number | null = null;
  private vad = new VoiceActivity();
  private loopback = false;
  private stopped = false;

  /** Resolves false if there's no microphone (or no permission). */
  async start(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: micConstraints() });
    } catch {
      return false;
    }
    if (this.stopped) {
      this.stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.chain = new MicChain();
    this.chain.setStream(this.stream);
    this.loop = this.chain.ctx.createGain();
    this.loop.gain.value = 0;
    this.chain.out.connect(this.loop).connect(this.chain.ctx.destination);
    await this.applyIsolation();
    this.timer = window.setInterval(() => this.tick(), TICK_MS);
    return true;
  }

  async applyIsolation(): Promise<void> {
    if (!this.chain) return;
    try {
      await this.chain.setIsolation(voicePrefs().noiseMode === 'isolation');
      useVoiceUi.setState({ isolating: this.chain.isolating, isolationError: null });
    } catch (err) {
      useVoiceUi.setState({ isolating: false, isolationError: err instanceof Error ? err.message : "Voice isolation couldn't start." });
    }
  }

  /** Hear yourself (with headphones!) the way others would. */
  setLoopback(on: boolean): void {
    this.loopback = on;
  }

  private tick(): void {
    if (!this.chain) return;
    const prefs = voicePrefs();
    const db = this.chain.levelDb() + 20 * Math.log10(Math.max(prefs.inputVolume, 0.01));
    const loud = this.vad.update(db, performance.now(), prefs.autoSensitivity, prefs.threshold);
    useVoiceUi.setState({ level: levelFraction(db), threshold: this.vad.threshold, selfSpeaking: loud });
    if (this.loop) {
      // Push to talk has no key to hold here, so the check lets everything through.
      const open = this.loopback && (prefs.inputMode === 'ptt' || loud);
      const target = open ? Math.min(2, prefs.inputVolume) : 0;
      this.loop.gain.setTargetAtTime(target, this.chain.ctx.currentTime, open ? 0.004 : 0.03);
    }
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = null;
    this.loop?.disconnect();
    this.chain?.destroy();
    this.chain = null;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    useVoiceUi.setState({ level: 0, selfSpeaking: false });
  }
}

// A handle for troubleshooting calls from the browser console (tavernVoice.engine).
if (typeof window !== 'undefined') (window as unknown as { tavernVoice: unknown }).tavernVoice = { engine, useVoiceUi };
