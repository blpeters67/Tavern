import { useEffect, useMemo, useRef, useState } from 'react';
import { emojiUrl, serverIcon } from '../lib/avatars';
import {
  frequentEmoji,
  getSkinTone,
  loadEmojiData,
  recordEmojiUse,
  searchEmoji,
  setSkinTone,
  withSkin,
  emojiByChar,
  type EmojiData,
  type EmojiEntry,
} from '../lib/emoji';
import { acronym } from '../lib/format';
import { useStore } from '../store/store';
import type { Emoji } from '../store/types';
import {
  Icon,
  mdiAirplane,
  mdiClockOutline,
  mdiEmoticonHappy,
  mdiFlag,
  mdiFood,
  mdiHeart,
  mdiLightbulbOn,
  mdiPaw,
  mdiSoccer,
} from './icons';
import { tip } from './layers';

export type PickedEmoji = { kind: 'unicode'; emoji: string; name: string } | { kind: 'custom'; emoji: Emoji };

const CATEGORY_ICONS: Record<string, string> = {
  people: mdiEmoticonHappy,
  nature: mdiPaw,
  food: mdiFood,
  activity: mdiSoccer,
  travel: mdiAirplane,
  objects: mdiLightbulbOn,
  symbols: mdiHeart,
  flags: mdiFlag,
};

const SKIN_SAMPLES = ['👏', '👏🏻', '👏🏼', '👏🏽', '👏🏾', '👏🏿'];

type Hover = { label: string; src: string } | null;

function twemoji(file: string) {
  return `/twemoji/${file}.svg`;
}

export default function EmojiPicker({ serverId, onPick, onClose }: { serverId: number | null; onPick: (e: PickedEmoji) => void; onClose?: () => void }) {
  const [data, setData] = useState<EmojiData | null>(null);
  const [query, setQuery] = useState('');
  const [hover, setHover] = useState<Hover>(null);
  const [tone, setTone] = useState(getSkinTone);
  const [toneOpen, setToneOpen] = useState(false);
  const [activeSection, setActiveSection] = useState('frequent');
  const scroller = useRef<HTMLDivElement>(null);
  const servers = useStore((s) => s.servers);
  const emojis = useStore((s) => s.emojis);

  useEffect(() => {
    void loadEmojiData().then(setData);
  }, []);

  // Custom emoji grouped by server, current server first.
  const customGroups = useMemo(() => {
    const byServer = new Map<number, Emoji[]>();
    for (const e of Object.values(emojis)) {
      if (!byServer.has(e.server_id)) byServer.set(e.server_id, []);
      byServer.get(e.server_id)!.push(e);
    }
    return [...byServer.entries()]
      .filter(([sid]) => servers[sid])
      .sort(([a], [b]) => (a === serverId ? -1 : b === serverId ? 1 : servers[a].name.localeCompare(servers[b].name)))
      .map(([sid, list]) => ({ server: servers[sid], list: list.sort((x, y) => x.name.localeCompare(y.name)) }));
  }, [emojis, servers, serverId]);

  const pickUnicode = (e: EmojiEntry) => {
    const { u } = withSkin(e, tone);
    recordEmojiUse(u);
    onPick({ kind: 'unicode', emoji: u, name: e.n[0] });
  };
  const pickCustom = (e: Emoji) => {
    recordEmojiUse(`c:${e.id}`);
    onPick({ kind: 'custom', emoji: e });
  };

  const frequent = useMemo(() => {
    if (!data) return [];
    return frequentEmoji(18)
      .map((key) => {
        if (key.startsWith('c:')) {
          const e = emojis[Number(key.slice(2))];
          return e ? { custom: e } : null;
        }
        const entry = emojiByChar(key);
        return entry ? { entry, char: key } : null;
      })
      .filter(Boolean) as ({ custom: Emoji } | { entry: EmojiEntry; char: string })[];
  }, [data, emojis]);

  const results = useMemo(() => {
    if (!query.trim() || !data) return null;
    const q = query.trim().toLowerCase().replace(/:/g, '');
    const custom = Object.values(emojis).filter((e) => e.name.toLowerCase().includes(q) && servers[e.server_id]);
    return { custom, unicode: searchEmoji(q, 80) };
  }, [query, data, emojis, servers]);

  const scrollTo = (id: string) => {
    const el = scroller.current?.querySelector<HTMLElement>(`[data-section="${id}"]`);
    if (el && scroller.current) scroller.current.scrollTop = el.offsetTop - 8;
    setActiveSection(id);
  };

  const onScroll = () => {
    const sc = scroller.current;
    if (!sc) return;
    const sections = sc.querySelectorAll<HTMLElement>('[data-section]');
    let current = 'frequent';
    for (const s of sections) if (s.offsetTop - sc.scrollTop <= 40) current = s.dataset.section!;
    if (current !== activeSection) setActiveSection(current);
  };

  // `exact` is used for "frequently used", which remembers the exact skin tone picked.
  const unicodeCell = (e: EmojiEntry, key: string | number, exact?: string) => {
    const file = exact ? fileForChar(exact, e) : withSkin(e, tone).f;
    return (
      <button
        key={key}
        className="emoji-cell"
        onClick={() => (exact ? pickExact(exact, e) : pickUnicode(e))}
        onMouseEnter={() => setHover({ label: `:${e.n[0]}:`, src: twemoji(file) })}
        aria-label={e.n[0]}
      >
        <img src={twemoji(file)} alt={e.u} loading="lazy" draggable={false} />
      </button>
    );
  };
  const pickExact = (char: string, e: EmojiEntry) => {
    recordEmojiUse(char);
    onPick({ kind: 'unicode', emoji: char, name: e.n[0] });
  };
  const customCell = (e: Emoji) => (
    <button
      key={`c${e.id}`}
      className="emoji-cell"
      onClick={() => pickCustom(e)}
      onMouseEnter={() => setHover({ label: `:${e.name}:`, src: emojiUrl(e.id) })}
      aria-label={e.name}
    >
      <img src={emojiUrl(e.id)} alt={e.name} loading="lazy" draggable={false} />
    </button>
  );

  return (
    <div className="emoji-picker" onKeyDown={(e) => e.key === 'Escape' && onClose?.()}>
      <div className="emoji-picker-header">
        <div className="emoji-search">
          <input autoFocus placeholder="Find the perfect emoji" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search emoji" />
        </div>
        <div className="skin-tone">
          <button className="skin-tone-button" aria-label="Skin tone" {...tip('Change skin tone')} onClick={() => setToneOpen((v) => !v)}>
            <img src={twemoji(skinFile(tone))} alt="" />
          </button>
          {toneOpen && (
            <div className="skin-tone-options">
              {SKIN_SAMPLES.map((_, i) => (
                <button
                  key={i}
                  className={`skin-tone-option ${i === tone ? 'current' : ''}`}
                  onClick={() => {
                    setTone(i);
                    setSkinTone(i);
                    setToneOpen(false);
                  }}
                >
                  <img src={twemoji(skinFile(i))} alt="" />
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
      <div className="emoji-picker-body">
        {!results && (
          <nav className="emoji-cats scroller-none">
            <button className={`emoji-cat ${activeSection === 'frequent' ? 'active' : ''}`} onClick={() => scrollTo('frequent')} {...tip('Frequently Used', 'right')}>
              <Icon path={mdiClockOutline} size={22} />
            </button>
            {customGroups.map((g) => (
              <button
                key={g.server.id}
                className={`emoji-cat server ${activeSection === `s${g.server.id}` ? 'active' : ''}`}
                onClick={() => scrollTo(`s${g.server.id}`)}
                {...tip(g.server.name, 'right')}
              >
                {g.server.icon ? <img src={serverIcon(g.server.icon)!} alt="" /> : <span>{acronym(g.server.name)}</span>}
              </button>
            ))}
            <div className="emoji-cat-sep" />
            {data?.categories.map((c) => (
              <button key={c.id} className={`emoji-cat ${activeSection === c.id ? 'active' : ''}`} onClick={() => scrollTo(c.id)} {...tip(c.name, 'right')}>
                <Icon path={CATEGORY_ICONS[c.id]} size={22} />
              </button>
            ))}
          </nav>
        )}
        <div className="emoji-scroll scroller-thin" ref={scroller} onScroll={onScroll} onMouseLeave={() => setHover(null)}>
          {!data && <div className="emoji-loading">Loading emoji…</div>}
          {results && (
            <section className="emoji-section">
              {results.custom.length + results.unicode.length === 0 ? (
                <div className="emoji-empty">No emoji match "{query}".</div>
              ) : (
                <div className="emoji-grid">
                  {results.custom.map(customCell)}
                  {results.unicode.map((e, i) => unicodeCell(e, i))}
                </div>
              )}
            </section>
          )}
          {data && !results && (
            <>
              <section className="emoji-section" data-section="frequent">
                <h4 className="emoji-section-title">Frequently Used</h4>
                <div className="emoji-grid">
                  {frequent.map((f, i) => ('custom' in f ? customCell(f.custom) : unicodeCell(f.entry, `f${i}`, f.char)))}
                </div>
              </section>
              {customGroups.map((g) => (
                <section key={g.server.id} className="emoji-section" data-section={`s${g.server.id}`}>
                  <h4 className="emoji-section-title">{g.server.name}</h4>
                  <div className="emoji-grid">{g.list.map(customCell)}</div>
                </section>
              ))}
              {data.categories.map((c) => (
                <section key={c.id} className="emoji-section lazy" data-section={c.id} style={{ containIntrinsicSize: `auto ${Math.ceil(c.emojis.length / 9) * 44 + 32}px` }}>
                  <h4 className="emoji-section-title">{c.name}</h4>
                  <div className="emoji-grid">{c.emojis.map((idx) => unicodeCell(data.emojis[idx], idx))}</div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>
      <div className="emoji-picker-footer">
        {hover ? (
          <>
            <img src={hover.src} alt="" />
            <span>{hover.label}</span>
          </>
        ) : (
          <span className="emoji-footer-hint">Pick an emoji</span>
        )}
      </div>
    </div>
  );
}

function skinFile(tone: number): string {
  return ['1f44f', '1f44f-1f3fb', '1f44f-1f3fc', '1f44f-1f3fd', '1f44f-1f3fe', '1f44f-1f3ff'][tone] ?? '1f44f';
}

function fileForChar(char: string, e: EmojiEntry): string {
  if (e.s) {
    const hit = e.s.find(([u]) => u === char);
    if (hit) return hit[1];
  }
  return e.f;
}
