/**
 * Holding Shift reveals quick actions on the message you're hovering (like a
 * one-click delete), the way Discord does. A class on <body> drives it, so
 * pressing Shift doesn't re-render every message.
 */

let held = false;

function set(on: boolean): void {
  if (on === held) return;
  held = on;
  document.body.classList.toggle('shift-held', on);
}

if (typeof window !== 'undefined') {
  window.addEventListener('keydown', (e) => e.key === 'Shift' && set(true));
  window.addEventListener('keyup', (e) => e.key === 'Shift' && set(false));
  // Shift may have been pressed or let go while another window had focus.
  window.addEventListener('mousemove', (e) => set(e.shiftKey), { passive: true });
  window.addEventListener('blur', () => set(false));
  document.addEventListener('visibilitychange', () => document.hidden && set(false));
}

export function shiftHeld(): boolean {
  return held;
}
