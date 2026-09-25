/**
 * Estimate the server's clock so every jukebox listener computes the same
 * song position. Classic NTP-style: send our time, the server echoes it with
 * its own; offset = server - (sent + received) / 2. Keep the sample with the
 * smallest round trip, since it has the least uncertainty.
 */

let offset = 0;
let bestRtt = Infinity;
let samples: { rtt: number; offset: number; at: number }[] = [];
let timer: number | null = null;
let sender: ((clientTime: number) => boolean) | null = null;

export function serverNow(): number {
  return Date.now() + offset;
}

export function clockOffset(): number {
  return offset;
}

export function clockSample(sentAt: number, serverTime: number): void {
  const now = Date.now();
  const rtt = now - sentAt;
  if (!(rtt >= 0) || rtt > 10000) return;
  samples.push({ rtt, offset: serverTime - (sentAt + now) / 2, at: now });
  // Only trust recent samples (clocks drift, networks change).
  samples = samples.filter((s) => now - s.at < 10 * 60 * 1000).slice(-20);
  const best = samples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
  bestRtt = best.rtt;
  offset = best.offset;
}

export function startClockSync(send: (clientTime: number) => boolean): void {
  sender = send;
  if (timer !== null) window.clearInterval(timer);
  samples = [];
  bestRtt = Infinity;
  const burst = () => {
    for (let i = 0; i < 5; i++) window.setTimeout(() => send(Date.now()), i * 250);
  };
  burst();
  timer = window.setInterval(burst, 60_000);
}

export function clockQuality(): number {
  return bestRtt;
}

/** Ask the server for a fresh round trip now (the answer lands in `latestRtt`). */
export function pingServer(): void {
  sender?.(Date.now());
}

/** The most recent round trip to the server (ms), or null before the first. */
export function latestRtt(): number | null {
  return samples.length ? samples[samples.length - 1].rtt : null;
}
