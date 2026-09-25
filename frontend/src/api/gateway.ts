import { clockSample, startClockSync } from '../lib/clock';
import { applyReady, dispatch, getState, setState } from '../store/store';
import type { ReadyPayload } from '../store/types';

type Listener = (t: string, d: unknown) => void;

/** WebSocket connection to /api/gateway with heartbeats and reconnects. */
class Gateway {
  private ws: WebSocket | null = null;
  private heartbeat: number | null = null;
  private acked = true;
  private attempts = 0;
  private reconnectTimer: number | null = null;
  private stopped = true;
  private ready = false;
  private buffer: [string, unknown][] = [];
  private listeners = new Set<Listener>();
  onLoggedOut: (() => void) | null = null;
  onReady: ((reconnect: boolean) => void) | null = null;
  private hadReady = false;

  start() {
    this.stopped = false;
    this.connect();
  }

  stop() {
    this.stopped = true;
    this.clearTimers();
    this.ws?.close(1000);
    this.ws = null;
    this.hadReady = false;
  }

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private clearTimers() {
    if (this.heartbeat !== null) window.clearInterval(this.heartbeat);
    if (this.reconnectTimer !== null) window.clearTimeout(this.reconnectTimer);
    this.heartbeat = null;
    this.reconnectTimer = null;
  }

  private connect() {
    this.clearTimers();
    this.ready = false;
    this.buffer = [];
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${location.host}/api/gateway`);
    this.ws = ws;

    ws.onmessage = (ev) => {
      let msg: { op: number; t?: string; d?: unknown };
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.op === 10) {
        const interval = (msg.d as { heartbeat_interval: number }).heartbeat_interval;
        this.acked = true;
        this.heartbeat = window.setInterval(() => this.beat(), interval);
      } else if (msg.op === 11) {
        this.acked = true;
      } else if (msg.op === 7) {
        const d = msg.d as { c: number; s: number };
        clockSample(d.c, d.s);
      } else if (msg.op === 0 && msg.t) {
        this.handleDispatch(msg.t, msg.d);
      }
    };

    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.clearTimers();
      this.ws = null;
      if (ev.code === 4001 || ev.code === 4004) {
        this.stopped = true;
        this.onLoggedOut?.();
        return;
      }
      if (this.stopped) return;
      setState({ connected: false });
      const delay = Math.min(30000, 1000 * 2 ** this.attempts) * (0.75 + Math.random() * 0.5);
      this.attempts++;
      this.reconnectTimer = window.setTimeout(() => this.connect(), delay);
    };
  }

  private beat() {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (!this.acked) {
      // Missed an ack: the connection is probably dead. Reconnect.
      this.ws.close(4000);
      return;
    }
    this.acked = false;
    this.ws.send('{"op":1}');
  }

  private handleDispatch(t: string, d: unknown) {
    if (t === 'READY') {
      const reconnect = this.hadReady;
      applyReady(d as ReadyPayload);
      this.ready = true;
      this.hadReady = true;
      this.attempts = 0;
      // Replay anything that arrived while READY was being built. READY may
      // already include some of it, so every handler must be safe to apply to
      // state that already has its change (see MESSAGE_CREATE's mention count).
      for (const [bt, bd] of this.buffer) this.emit(bt, bd);
      this.buffer = [];
      startClockSync((c) => this.send(7, { c }));
      this.onReady?.(reconnect);
      return;
    }
    if (!this.ready) {
      this.buffer.push([t, d]);
      return;
    }
    this.emit(t, d);
  }

  private emit(t: string, d: unknown) {
    dispatch(t, d);
    for (const fn of this.listeners) fn(t, d);
  }

  /** Send a client op (voice, clock sync, jukebox listening). */
  send(op: number, d: unknown): boolean {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN || !this.ready) return false;
    this.ws.send(JSON.stringify({ op, d }));
    return true;
  }

  get isReady(): boolean {
    return this.ready && !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Reconnect right away (e.g. after the tab wakes up). */
  poke() {
    if (!this.stopped && !this.ws && getState().status === 'ready') {
      this.attempts = 0;
      this.connect();
    }
  }
}

export const gateway = new Gateway();

window.addEventListener('online', () => gateway.poke());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') gateway.poke();
});
