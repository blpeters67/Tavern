/**
 * Ducking: while a video's sound plays in the theater, the jukebox steps back
 * so people can hear it (the way a TV lowers its music under speech). Any
 * part of the app can ask for the music to duck; the quietest request wins.
 */

type Listener = () => void;

const requests = new Map<string, number>();
const listeners = new Set<Listener>();

/** How loud the music may be right now: 1 = untouched, lower = ducked. */
export function duckLevel(): number {
  let level = 1;
  for (const v of requests.values()) level = Math.min(level, v);
  return level;
}

/** Ask for the music at `level` (0..1) for `source`; 1 (or null) drops the request. */
export function setDuck(source: string, level: number | null): void {
  const before = duckLevel();
  if (level === null || level >= 1) requests.delete(source);
  else requests.set(source, Math.max(0, level));
  if (duckLevel() !== before) for (const fn of listeners) fn();
}

export function onDuckChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
