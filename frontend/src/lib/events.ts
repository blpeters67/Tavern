/** A tiny typed event bus for things that live outside React (voice engine,
 * jukebox player) to hear about gateway events without import cycles. */

type Listener = (data: any) => void; // eslint-disable-line @typescript-eslint/no-explicit-any

const listeners = new Map<string, Set<Listener>>();

export function on(event: string, fn: Listener): () => void {
  let set = listeners.get(event);
  if (!set) listeners.set(event, (set = new Set()));
  set.add(fn);
  return () => set!.delete(fn);
}

export function emit(event: string, data?: unknown): void {
  for (const fn of listeners.get(event) ?? []) {
    try {
      fn(data);
    } catch (err) {
      console.error(`listener for ${event} failed`, err);
    }
  }
}
