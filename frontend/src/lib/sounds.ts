/**
 * Little UI sounds, synthesised with WebAudio so there are no audio files to
 * ship (and nothing borrowed): voice join/leave, mute toggles, dice.
 */

/**
 * Audio contexts, each made on first real use and never just because the
 * page opened: opening the sound device can pop in some headphones.
 *   'ui'    what others say in voice chat, and these little sounds
 *   'music' the jukebox (big buffers, so a busy computer can't make it crackle)
 *   'voice' your microphone on its way out (48 kHz, lowest delay; voice
 *           isolation needs that rate)
 */
import { emit } from './events';

export type AudioKind = 'ui' | 'music' | 'voice';

const contexts: Partial<Record<AudioKind, AudioContext>> = {};
let outputDevice = ''; // '' = the system default

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void>; sinkId?: string };

function createContext(kind: AudioKind): AudioContext {
  const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
  const opts: AudioContextOptions & { sinkId?: string } = {
    latencyHint: kind === 'music' ? 'playback' : kind === 'voice' ? 'interactive' : 'balanced',
  };
  if (kind === 'voice') opts.sampleRate = 48000;
  if (outputDevice && 'setSinkId' in AudioContext.prototype) opts.sinkId = outputDevice;
  try {
    return new Ctor(opts);
  } catch {
    // The saved output device is gone (unplugged), or this browser won't
    // pick a sample rate: fall back to the defaults.
    delete opts.sinkId;
    try {
      return new Ctor(opts);
    } catch {
      delete opts.sampleRate;
      return new Ctor(opts);
    }
  }
}

export function audioContext(kind: AudioKind = 'ui'): AudioContext {
  let ctx = contexts[kind];
  if (!ctx) ctx = contexts[kind] = createContext(kind);
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  return ctx;
}

/** The context if it exists already (doesn't create one). */
export function existingAudioContext(kind: AudioKind = 'ui'): AudioContext | null {
  return contexts[kind] ?? null;
}

/** Where all Tavern sound goes (Settings → Voice & Video → Output Device). */
export async function setOutputDevice(id: string): Promise<void> {
  outputDevice = !id || id === 'default' ? '' : id;
  for (const ctx of Object.values(contexts) as SinkContext[]) {
    if (typeof ctx.setSinkId === 'function' && (ctx.sinkId ?? '') !== outputDevice) await ctx.setSinkId(outputDevice).catch(() => {});
  }
  emit('output-device', outputDevice);
}

/** The chosen output device ('' = the system default), for media elements that play on their own. */
export function outputDeviceId(): string {
  return outputDevice;
}

const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

/**
 * iPhones and iPads only let a page start sound inside a tap, so unlock there on
 * the first one. Elsewhere any earlier click counts, so we wait for real sound.
 */
export function unlockAudioOnGesture(): void {
  if (!isIOS) return;
  const unlock = () => {
    try {
      audioContext();
    } catch {
      /* no audio */
    }
    window.removeEventListener('touchend', unlock, true);
  };
  window.addEventListener('touchend', unlock, true);
}

function tone(freq: number, start: number, duration: number, volume: number, type: OscillatorType = 'sine', endFreq?: number) {
  const ac = audioContext();
  const t0 = ac.currentTime + start;
  const osc = ac.createOscillator();
  const gain = ac.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t0);
  if (endFreq) osc.frequency.exponentialRampToValueAtTime(endFreq, t0 + duration);
  gain.gain.setValueAtTime(0.0001, t0);
  gain.gain.exponentialRampToValueAtTime(volume, t0 + 0.012);
  gain.gain.exponentialRampToValueAtTime(0.0001, t0 + duration);
  osc.connect(gain).connect(ac.destination);
  osc.start(t0);
  osc.stop(t0 + duration + 0.05);
}

function click(start: number, volume: number, cutoff: number) {
  const ac = audioContext();
  const t0 = ac.currentTime + start;
  const len = Math.floor(ac.sampleRate * 0.03);
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, 3);
  const src = ac.createBufferSource();
  src.buffer = buf;
  const filter = ac.createBiquadFilter();
  filter.type = 'bandpass';
  filter.frequency.value = cutoff;
  filter.Q.value = 1.2;
  const gain = ac.createGain();
  gain.gain.value = volume;
  src.connect(filter).connect(gain).connect(ac.destination);
  src.start(t0);
}

export type SoundName = 'join' | 'leave' | 'other-join' | 'other-leave' | 'mute' | 'unmute' | 'deafen' | 'undeafen' | 'dice' | 'stream';

export function playSound(name: SoundName): void {
  try {
    switch (name) {
      case 'join':
        tone(523, 0, 0.12, 0.12, 'triangle');
        tone(784, 0.09, 0.2, 0.12, 'triangle');
        break;
      case 'leave':
        tone(659, 0, 0.12, 0.1, 'triangle');
        tone(392, 0.09, 0.22, 0.1, 'triangle');
        break;
      case 'other-join':
        tone(698, 0, 0.14, 0.07, 'sine');
        tone(880, 0.07, 0.16, 0.06, 'sine');
        break;
      case 'other-leave':
        tone(587, 0, 0.14, 0.06, 'sine');
        tone(440, 0.07, 0.18, 0.05, 'sine');
        break;
      case 'mute':
        tone(440, 0, 0.08, 0.08, 'square', 330);
        break;
      case 'unmute':
        tone(330, 0, 0.08, 0.08, 'square', 440);
        break;
      case 'deafen':
        tone(392, 0, 0.1, 0.08, 'triangle', 262);
        break;
      case 'undeafen':
        tone(262, 0, 0.1, 0.08, 'triangle', 392);
        break;
      case 'stream':
        tone(784, 0, 0.1, 0.07, 'sine');
        tone(988, 0.08, 0.1, 0.07, 'sine');
        tone(1175, 0.16, 0.14, 0.06, 'sine');
        break;
      case 'dice': {
        // A handful of irregular clacks, like dice tumbling on a table.
        let t = 0;
        for (let i = 0; i < 7; i++) {
          click(t, 0.5 - i * 0.05, 1800 + Math.random() * 2200);
          t += 0.045 + Math.random() * 0.09 * (1 + i * 0.25);
        }
        break;
      }
    }
  } catch {
    /* audio unavailable */
  }
}
