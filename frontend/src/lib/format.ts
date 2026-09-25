const time = new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit' });
const date = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit', year: 'numeric' });
const longDate = new Intl.DateTimeFormat(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
const shortDate = new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const full = new Intl.DateTimeFormat(undefined, {
  weekday: 'long',
  month: 'long',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

function startOfDay(d: Date): number {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** "Today at 3:14 PM", "Yesterday at 9:02 AM", "09/20/2026 4:56 PM" */
export function formatTimestamp(iso: string): string {
  const d = new Date(iso);
  const today = startOfDay(new Date());
  const day = startOfDay(d);
  if (day === today) return `Today at ${time.format(d)}`;
  if (day === today - 86400000) return `Yesterday at ${time.format(d)}`;
  return `${date.format(d)} ${time.format(d)}`;
}

export const formatTime = (iso: string) => time.format(new Date(iso));
export const formatFull = (iso: string | Date) => full.format(typeof iso === 'string' ? new Date(iso) : iso);
export const formatLongDate = (iso: string) => longDate.format(new Date(iso));
export const formatShortDate = (iso: string) => shortDate.format(new Date(iso));
export const dayKey = (iso: string) => startOfDay(new Date(iso));

export function formatRelative(target: Date): string {
  const diff = target.getTime() - Date.now();
  const abs = Math.abs(diff);
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  const units: [Intl.RelativeTimeFormatUnit, number][] = [
    ['year', 31536000000],
    ['month', 2592000000],
    ['day', 86400000],
    ['hour', 3600000],
    ['minute', 60000],
    ['second', 1000],
  ];
  for (const [unit, ms] of units) {
    if (abs >= ms || unit === 'second') return rtf.format(Math.round(diff / ms), unit);
  }
  return '';
}

/** Discord-style <t:unix:style> timestamps. */
export function formatDiscordTimestamp(seconds: number, style: string): string {
  const d = new Date(seconds * 1000);
  switch (style) {
    case 't':
      return time.format(d);
    case 'T':
      return new Intl.DateTimeFormat(undefined, { hour: 'numeric', minute: '2-digit', second: '2-digit' }).format(d);
    case 'd':
      return date.format(d);
    case 'D':
      return longDate.format(d);
    case 'F':
      return full.format(d);
    case 'R':
      return formatRelative(d);
    default:
      return `${longDate.format(d)} ${time.format(d)}`;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} bytes`;
  const units = ['KB', 'MB', 'GB'];
  let v = bytes / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 2 : 1)} ${units[i]}`;
}

export const colorHex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;

export function colorWithAlpha(n: number, alpha: number): string {
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

export function acronym(name: string): string {
  return (
    name
      .replace(/'s /g, ' ')
      .split(/\s+/)
      .filter(Boolean)
      .map((w) => [...w][0])
      .join('')
      .slice(0, 5) || '?'
  );
}

/** 83 000 ms -> "1:23"; 3 723 000 -> "1:02:03". */
export function formatDuration(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}` : `${m}:${String(s).padStart(2, '0')}`;
}

/** "#a78bfa" + alpha -> "rgba(167, 139, 250, 0.12)" */
export function hexAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** Mix a "#rrggbb" colour toward white (amount 0..1): light, readable tints on navy. */
export function lighten(hex: string, amount: number): string {
  const n = parseInt(hex.replace('#', ''), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amount);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}

/** Perceived brightness of "#rrggbb", 0..1. */
export function luminance(hex: string): number {
  const n = parseInt(hex.replace('#', ''), 16);
  return (0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
}

const toRgb = (hex: string): [number, number, number] => {
  const n = parseInt(hex.replace('#', ''), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};
const toHex = (rgb: number[]) => `#${rgb.map((c) => Math.max(0, Math.min(255, Math.round(c))).toString(16).padStart(2, '0')).join('')}`;

/** Blend two "#rrggbb" colours: t = 0 gives `a`, 1 gives `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const x = toRgb(a);
  const y = toRgb(b);
  return toHex(x.map((c, i) => c + (y[i] - c) * t));
}

/** Pull a colour toward grey (amount 0..1): calmer, less neon. */
export function soften(hex: string, amount: number): string {
  const grey = Math.round(luminance(hex) * 255);
  return mixHex(hex, toHex([grey, grey, grey]), amount);
}

/** WCAG contrast ratio between two colours (1..21). */
export function contrastRatio(a: string, b: string): number {
  const rel = (hex: string) => {
    const [r, g, bl] = toRgb(hex).map((c) => {
      const v = c / 255;
      return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [hi, lo] = [rel(a), rel(b)].sort((p, q) => q - p);
  return (hi + 0.05) / (lo + 0.05);
}

/** Lighten `hex` just enough to be readable (contrast `ratio`) on `bg`. */
export function readableOn(hex: string, bg: string, ratio: number): string {
  let out = hex;
  for (let i = 1; i <= 20 && contrastRatio(out, bg) < ratio; i++) out = lighten(hex, i * 0.05);
  return out;
}

/** A character's colour as Tavern shows it: a little calmer, and readable on the dark background. */
export function calmColor(hex: string): string {
  return readableOn(soften(hex, 0.2), '#101828', 4.5);
}
