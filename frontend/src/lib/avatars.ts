import type { Character, User } from '../store/types';

// Default avatar colors, picked by id.
const COLORS = ['#5865f2', '#757e8a', '#3ba55c', '#faa61a', '#ed4245', '#eb459f'];

const MUG = `<g transform="translate(20 20) scale(2.6)" fill="#fff">
<circle cx="7.2" cy="7.3" r="2.7"/><circle cx="10.6" cy="5.7" r="3.2"/><circle cx="14.1" cy="7.1" r="2.6"/>
<rect x="4.6" y="7.2" width="12.1" height="3.2" rx="1"/>
<path fill-rule="evenodd" d="M5 10h10.6v9a2.2 2.2 0 0 1-2.2 2.2H7.2A2.2 2.2 0 0 1 5 19zM7.6 12.3h1.3v6.7H7.6zm2.5 0h1.3v6.7h-1.3zm2.5 0h1.3v6.7h-1.3z"/>
<path d="M15.6 11.6h2.6a2.8 2.8 0 0 1 2.8 2.8v1.9a2.8 2.8 0 0 1-2.8 2.8h-2.6v-2h2.6a.8.8 0 0 0 .8-.8v-1.9a.8.8 0 0 0-.8-.8h-2.6z"/></g>`;

const cache = new Map<string, string>();

function svgUrl(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

export function defaultUserAvatar(id: number): string {
  const key = `u${id % COLORS.length}`;
  let url = cache.get(key);
  if (!url) {
    url = svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${COLORS[id % COLORS.length]}"/>${MUG}</svg>`);
    cache.set(key, url);
  }
  return url;
}

export function defaultCharacterAvatar(id: number, name: string): string {
  const letter = ([...name.trim()][0] ?? '?').toUpperCase();
  const key = `c${id % COLORS.length}${letter}`;
  let url = cache.get(key);
  if (!url) {
    const safe = letter.replace(/[<>&"']/g, '');
    url = svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect width="100" height="100" fill="${COLORS[(id + 3) % COLORS.length]}"/>` +
        `<text x="50" y="50" dy=".35em" text-anchor="middle" font-family="Noto Sans, Helvetica, Arial, sans-serif" font-size="46" font-weight="600" fill="#fff">${safe}</text></svg>`,
    );
    cache.set(key, url);
  }
  return url;
}

export function userAvatar(user: Pick<User, 'id' | 'avatar'> | null | undefined): string {
  if (!user) return defaultUserAvatar(0);
  return user.avatar ? `/cdn/avatars/${user.avatar}` : defaultUserAvatar(user.id);
}

export function characterAvatar(ch: Pick<Character, 'id' | 'avatar' | 'name'>): string {
  return ch.avatar ? `/cdn/avatars/${ch.avatar}` : defaultCharacterAvatar(ch.id, ch.name);
}

export function serverIcon(icon: string | null | undefined): string | null {
  return icon ? `/cdn/icons/${icon}` : null;
}

export function emojiUrl(id: number): string {
  return `/cdn/emojis/${id}`;
}
