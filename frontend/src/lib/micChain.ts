/**
 * The microphone's path, shared by calls and the Settings mic check:
 *
 *   mic ─► mono ─► [voice isolation] ─► out ─► analyser (level + voice activity)
 *                                          └─► the gate (calls) / your ears (mic check)
 *
 * Voice isolation is GTCRN, a small open-source speech-enhancement network
 * (MIT licence, github.com/Xiaobin-Rong/gtcrn) that runs in an AudioWorklet
 * through @sapphi-red/web-noise-suppressor. Like Discord's Krisp it removes
 * keyboard clicks, fans and barking dogs, not just steady hum, and it adds
 * about 30 ms of delay. It needs a 48 kHz audio context ('voice').
 */
import { GtcrnWorkletNode, loadGtcrn } from '@sapphi-red/web-noise-suppressor';
import gtcrnWasmUrl from '@sapphi-red/web-noise-suppressor/gtcrn.wasm?url';
import gtcrnWorkletUrl from '@sapphi-red/web-noise-suppressor/gtcrnWorklet.js?url';
import { audioContext } from './sounds';

/** How long speech keeps the gate open after the last loud moment. */
export const HANGOVER_MS = 320;
/** How often the level is read (ms). */
export const TICK_MS = 20;

let wasm: Promise<ArrayBuffer> | null = null;
const workletLoaded = new WeakMap<BaseAudioContext, Promise<void>>();

async function isolationNode(ctx: AudioContext): Promise<GtcrnWorkletNode> {
  if (!ctx.audioWorklet) throw new Error("This browser can't run voice isolation.");
  if (ctx.sampleRate !== 48000 && ctx.sampleRate !== 16000) {
    throw new Error(`Voice isolation needs 48 kHz audio, and this device runs at ${ctx.sampleRate / 1000} kHz.`);
  }
  wasm ??= loadGtcrn({ url: gtcrnWasmUrl }).catch((err) => {
    wasm = null; // let a later try fetch it again
    throw err;
  });
  let loaded = workletLoaded.get(ctx);
  if (!loaded) {
    loaded = ctx.audioWorklet.addModule(gtcrnWorkletUrl);
    workletLoaded.set(ctx, loaded);
    loaded.catch(() => workletLoaded.delete(ctx));
  }
  const [binary] = await Promise.all([wasm, loaded]);
  return new GtcrnWorkletNode(ctx, { wasmBinary: binary, maxChannels: 1 });
}

export class MicChain {
  readonly ctx: AudioContext;
  /** The processed voice, before any gate. */
  readonly out: GainNode;
  private readonly mono: GainNode;
  private readonly analyser: AnalyserNode;
  private readonly buf: Float32Array<ArrayBuffer>;
  private source: MediaStreamAudioSourceNode | null = null;
  private iso: GtcrnWorkletNode | null = null;
  private isolation = false;

  constructor() {
    this.ctx = audioContext('voice');
    // Mono first: some mics fill only one side of a stereo input.
    this.mono = this.ctx.createGain();
    this.mono.channelCount = 1;
    this.mono.channelCountMode = 'explicit';
    this.mono.channelInterpretation = 'speakers';
    this.out = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 1024;
    this.buf = new Float32Array(this.analyser.fftSize);
    this.mono.connect(this.out);
    this.out.connect(this.analyser);
  }

  setStream(stream: MediaStream | null): void {
    this.source?.disconnect();
    this.source = stream && stream.getAudioTracks().length ? this.ctx.createMediaStreamSource(stream) : null;
    this.source?.connect(this.mono);
  }

  /** Is isolation actually running (not just asked for)? */
  get isolating(): boolean {
    return !!this.iso;
  }

  /** Turn voice isolation on or off. Rejects (and stays off) if it can't run here. */
  async setIsolation(on: boolean): Promise<void> {
    if (on === this.isolation && on === !!this.iso) return;
    this.isolation = on;
    let node: GtcrnWorkletNode | null = null;
    if (on) {
      try {
        node = await isolationNode(this.ctx);
      } catch (err) {
        this.isolation = false;
        throw err;
      }
      if (!this.isolation) {
        // Switched off again while it loaded.
        node.destroy();
        return;
      }
    }
    this.mono.disconnect();
    if (this.iso) {
      this.iso.disconnect();
      this.iso.destroy();
    }
    this.iso = node;
    if (node) this.mono.connect(node).connect(this.out);
    else this.mono.connect(this.out);
  }

  /** Loudness of the processed voice right now, in dBFS (about -100 to 0). */
  levelDb(): number {
    this.analyser.getFloatTimeDomainData(this.buf);
    let sum = 0;
    for (let i = 0; i < this.buf.length; i++) sum += this.buf[i] * this.buf[i];
    return 20 * Math.log10(Math.max(Math.sqrt(sum / this.buf.length), 1e-5));
  }

  destroy(): void {
    this.source?.disconnect();
    this.source = null;
    this.mono.disconnect();
    this.out.disconnect();
    if (this.iso) {
      this.iso.disconnect();
      this.iso.destroy();
      this.iso = null;
    }
  }
}

/**
 * Voice activity from loudness: open when the voice is louder than the
 * threshold, stay open for a moment after, so words don't get chopped.
 * "Automatic" follows the room's noise floor: it drops quickly toward quiet
 * stretches and rises only very slowly while someone talks.
 */
export class VoiceActivity {
  private floor = -60;
  private lastLoud = -Infinity;
  threshold = -50;

  update(db: number, now: number, auto: boolean, manual: number): boolean {
    // Digital silence (a muted mic, isolation between words) says nothing about the room.
    if (db > -95) {
      if (db < this.floor + 6) this.floor += (db - this.floor) * 0.012;
      else this.floor += (db - this.floor) * 0.0004;
    }
    this.threshold = auto ? Math.max(-62, Math.min(-28, this.floor + 12)) : manual;
    if (db > this.threshold) this.lastLoud = now;
    return now - this.lastLoud < HANGOVER_MS;
  }
}

/** dBFS -> 0..1 for meters (-80 dB and below is empty). */
export function levelFraction(db: number): number {
  return Math.max(0, Math.min(1, (db + 80) / 80));
}
