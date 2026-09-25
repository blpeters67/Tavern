// Builds the emoji picker data and copies the Twemoji SVG set into public/.
// Runs automatically before `npm run dev` and `npm run build`.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const svgDir = join(dirname(require.resolve('@twemoji/svg/package.json')));
const outSvg = join(root, 'public', 'twemoji');
const outData = join(root, 'src', 'generated', 'emoji.json');

const compact = require('emojibase-data/en/compact.json');
const github = require('emojibase-data/en/shortcodes/github.json');
const iamcal = require('emojibase-data/en/shortcodes/iamcal.json');

// Twemoji file naming: lowercase codepoints joined by "-", dropping U+FE0F
// unless the sequence contains a zero-width joiner.
function twemojiFile(unicode) {
  const text = unicode.includes('‍') ? unicode : unicode.replace(/️/g, '');
  return [...text].map((c) => c.codePointAt(0).toString(16)).join('-');
}

const available = new Set(readdirSync(svgDir).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)));

function fileFor(unicode, hexcode) {
  const a = twemojiFile(unicode);
  if (available.has(a)) return a;
  const b = hexcode.toLowerCase();
  if (available.has(b)) return b;
  return null;
}

// emojibase groups -> Discord-style picker categories
const CATEGORY = { 0: 'people', 1: 'people', 3: 'nature', 4: 'food', 6: 'activity', 5: 'travel', 7: 'objects', 8: 'symbols', 9: 'flags' };
const CATEGORY_NAMES = {
  people: 'People',
  nature: 'Nature',
  food: 'Food',
  activity: 'Activities',
  travel: 'Travel',
  objects: 'Objects',
  symbols: 'Symbols',
  flags: 'Flags',
};

function names(entry) {
  const list = [];
  for (const src of [iamcal[entry.hexcode], github[entry.hexcode]]) {
    for (const raw of [].concat(src || [])) {
      const n = raw.replace(/-/g, '_');
      if (!list.includes(n)) list.push(n);
    }
  }
  if (!list.length) list.push(entry.label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, ''));
  // Prefer a name that starts with a letter as the display name (thumbsup over +1).
  list.sort((x, y) => Number(!/^[a-z]/.test(x)) - Number(!/^[a-z]/.test(y)));
  return list;
}

const categories = Object.fromEntries(Object.keys(CATEGORY_NAMES).map((k) => [k, []]));
const emojis = [];
for (const e of [...compact].sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))) {
  const cat = CATEGORY[e.group];
  if (!cat || e.order === undefined) continue;
  const file = fileFor(e.unicode, e.hexcode);
  if (!file) continue;
  const item = { u: e.unicode, f: file, n: names(e), k: (e.tags || []).join(' ') };
  const skins = (e.skins || [])
    .filter((s) => /-1F3F[B-F]$/i.test(s.hexcode) || s.hexcode.split('-').filter((p) => /^1F3F[B-F]$/i.test(p)).length === 1)
    .map((s) => [s.unicode, fileFor(s.unicode, s.hexcode)])
    .filter(([, f]) => f);
  if (skins.length === 5) item.s = skins;
  categories[cat].push(emojis.length);
  emojis.push(item);
}

mkdirSync(dirname(outData), { recursive: true });
writeFileSync(
  outData,
  JSON.stringify({
    categories: Object.entries(CATEGORY_NAMES).map(([id, name]) => ({ id, name, emojis: categories[id] })),
    emojis,
  }),
);

mkdirSync(outSvg, { recursive: true });
const existing = new Set(existsSync(outSvg) ? readdirSync(outSvg) : []);
let copied = 0;
for (const f of available) {
  const name = `${f}.svg`;
  if (!existing.has(name)) {
    copyFileSync(join(svgDir, name), join(outSvg, name));
    copied++;
  }
}
const size = readFileSync(outData).length;
console.log(`emoji: ${emojis.length} emojis (${(size / 1024).toFixed(0)} KB data), copied ${copied} SVGs`);
