/**
 * Is a mouse button (or a finger) down right now? A click is only a click if
 * the press and the release land on the same thing, so layout that would move
 * under a click in progress (the message box's toolbar folding away when it
 * loses focus) waits until the release has been handled.
 */

let down = false;
let waiting: (() => void)[] = [];
let fallback: number | null = null;

function flush(): void {
  if (fallback !== null) window.clearTimeout(fallback);
  fallback = null;
  down = false;
  const fns = waiting;
  waiting = [];
  for (const fn of fns) fn();
}

if (typeof window !== 'undefined') {
  window.addEventListener('pointerdown', () => (down = true), true);
  const release = () => {
    down = false;
    // After the click that follows this release has been dispatched.
    if (waiting.length) window.setTimeout(flush, 0);
  };
  window.addEventListener('pointerup', release, true);
  window.addEventListener('pointercancel', release, true);
  window.addEventListener('blur', release);
}

/** Run `fn` now, or once the press in progress is released (never later than a couple of seconds). */
export function afterPointerRelease(fn: () => void): void {
  if (!down) {
    fn();
    return;
  }
  waiting.push(fn);
  if (fallback === null) fallback = window.setTimeout(flush, 2000);
}
