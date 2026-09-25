import { useMemo, useState, type FormEvent, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { characterAvatar, userAvatar } from '../lib/avatars';
import { canRollForOthers, canRollPrivately, roll, type RollRequest } from '../lib/rolls';
import {
  ABILITIES,
  ABILITY_NAMES,
  ABILITY_SHORT,
  attackNumbers,
  checkMod,
  initiativeMod,
  saveMod,
  signed,
  skillMod,
  SKILLS,
  sorted,
  spellNumbers,
  type Ability,
} from '../lib/sheet';
import { useSheet } from '../lib/sheetStore';
import { load, save } from '../lib/storage';
import { displayName, narratorName, personaFor } from '../store/selectors';
import { getState, useStore } from '../store/store';
import { NARRATOR } from '../store/types';
import { Icon, mdiClose, mdiMagnify, mdiStarFourPoints } from './icons';
import { tip } from './layers';
import { DieShape } from './RollView';
import { Spinner, Switch } from './ui';

const DICE = [4, 6, 8, 10, 12, 20, 100];

interface TrayOptions {
  adv: 'adv' | 'dis' | null;
  dc: string;
  private: boolean;
  tab: 'dice' | 'checks';
}

function buildExpression(pool: Record<number, number>, mod: number): string {
  const parts = DICE.filter((d) => pool[d]).map((d) => `${pool[d]}d${d === 100 ? '%' : d}`);
  let out = parts.join('+');
  if (mod) out += `${mod > 0 ? '+' : ''}${mod}`;
  return out;
}

/** "who is this roll for": yourself, the narrator, or a character (DMs can pick anyone's). */
type Target = { kind: 'self' } | { kind: 'narrator' } | { kind: 'character'; id: number };

function useDefaultTarget(channelId: number): Target {
  return useStore(
    useShallow((s): Target => {
      const p = personaFor(s, channelId);
      if (p === NARRATOR) return { kind: 'narrator' };
      if (p > 0) return { kind: 'character', id: p };
      return { kind: 'self' };
    }),
  );
}

function targetKey(t: Target): string {
  return t.kind === 'character' ? `c${t.id}` : t.kind;
}

function RollFor({ channelId, target, onChange }: { channelId: number; target: Target; onChange: (t: Target) => void }) {
  const serverId = useStore((s) => s.channels[channelId]?.server_id ?? null);
  const me = useStore((s) => s.me!);
  const dm = canRollForOthers(channelId);
  const narrator = useStore((s) => narratorName(s, serverId));
  // Every member's characters, grouped by player (DMs only).
  const groups = useStore(
    useShallow((s) => {
      if (!dm || serverId === null) return [] as string[];
      const members = s.members[serverId] ?? {};
      return Object.values(s.characters)
        .filter((c) => !c.deleted && members[c.owner_id])
        .sort((a, b) => Number(b.owner_id === me.id) - Number(a.owner_id === me.id) || a.owner_id - b.owner_id || a.position - b.position)
        .map((c) => `${c.owner_id}:${c.id}`);
    }),
  );
  const character = useStore((s) => (target.kind === 'character' ? s.characters[target.id] : undefined));

  const avatar = target.kind === 'character' && character ? characterAvatar(character) : target.kind === 'self' ? userAvatar(me) : null;
  const label = target.kind === 'character' ? (character?.name ?? 'Character') : target.kind === 'narrator' ? narrator : displayName(me);

  if (!dm) {
    return (
      <div className="dice-for">
        <span className="dice-for-label">Rolling as</span>
        {avatar ? <img src={avatar} alt="" /> : <Icon path={mdiStarFourPoints} size={18} className="dice-for-narrator" />}
        <span className="dice-for-name">{label}</span>
      </div>
    );
  }
  const s = getState();
  const byOwner = new Map<number, number[]>();
  for (const g of groups) {
    const [owner, id] = g.split(':').map(Number);
    byOwner.set(owner, [...(byOwner.get(owner) ?? []), id]);
  }
  return (
    <label className="dice-for">
      <span className="dice-for-label">Roll for</span>
      {avatar ? <img src={avatar} alt="" /> : <Icon path={mdiStarFourPoints} size={18} className="dice-for-narrator" />}
      <select
        className="dice-for-select"
        value={targetKey(target)}
        onChange={(e) => {
          const v = e.target.value;
          onChange(v === 'self' ? { kind: 'self' } : v === 'narrator' ? { kind: 'narrator' } : { kind: 'character', id: Number(v.slice(1)) });
        }}
      >
        <option value="self">{displayName(me)} (yourself)</option>
        <option value="narrator">{narrator} (narrator)</option>
        {[...byOwner.entries()].map(([owner, ids]) => (
          <optgroup key={owner} label={owner === me.id ? 'Your characters' : `${displayName(s.users[owner])}'s characters`}>
            {ids.map((id) => (
              <option key={id} value={`c${id}`}>
                {s.characters[id]?.name}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    </label>
  );
}

function CheckButton({ label, mod, sub, onRoll, prof }: { label: string; mod: string; sub?: string; prof?: number; onRoll: (e: MouseEvent) => void }) {
  return (
    <button className="dice-check" onClick={onRoll}>
      {prof !== undefined && <span className={`dice-prof p${String(prof).replace('.', '')}`} aria-hidden />}
      <span className="dice-check-label">{label}</span>
      {sub && <span className="dice-check-sub">{sub}</span>}
      <span className="dice-check-mod">{mod}</span>
    </button>
  );
}

function Checks({ characterId, fire }: { characterId: number; fire: (req: RollRequest, e: MouseEvent) => void }) {
  const { entry, error } = useSheet(characterId);
  const [query, setQuery] = useState('');
  if (error) return <p className="dice-empty">{error}</p>;
  if (!entry) {
    return (
      <div className="dice-empty">
        <Spinner size={24} />
      </div>
    );
  }
  const sheet = entry.sheet;
  const q = query.trim().toLowerCase();
  const match = (text: string) => !q || text.toLowerCase().includes(q);
  const skills = Object.entries(SKILLS)
    .map(([key, [ab, name]]) => ({ key, ab, name }))
    .filter((k) => match(k.name) || match(ABILITY_NAMES[k.ab]))
    .sort((a, b) => a.name.localeCompare(b.name));
  const abilities = ABILITIES.filter((a) => match(ABILITY_NAMES[a]) || match('save') || match('check'));
  const attacks = sorted(sheet.attacks).filter(([, a]) => match(a.name) || match('attack'));
  const spell = spellNumbers(sheet);
  const attackSpells = sorted(sheet.spells).filter(([, sp]) => (sp.attack || sp.damage) && (match(sp.name) || match('spell')));

  return (
    <div className="dice-checks">
      <div className="dice-search">
        <Icon path={mdiMagnify} size={16} />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a check" aria-label="Find a check" autoFocus />
        {query && (
          <button aria-label="Clear" onClick={() => setQuery('')}>
            <Icon path={mdiClose} size={14} />
          </button>
        )}
      </div>
      <div className="dice-checks-scroll scroller-thin">
        {(match('initiative') || match('death') || match('hit die')) && (
          <div className="dice-row-group">
            {match('initiative') && <CheckButton label="Initiative" mod={signed(initiativeMod(sheet))} onRoll={(e) => fire({ kind: 'initiative' }, e)} />}
            {match('death') && <CheckButton label="Death Save" mod="d20" onRoll={(e) => fire({ kind: 'death_save' }, e)} />}
            {match('hit die') && <CheckButton label="Hit Die" mod="HD" onRoll={(e) => fire({ kind: 'hit_die' }, e)} />}
          </div>
        )}
        {abilities.length > 0 && (
          <>
            <h4 className="dice-section">Abilities</h4>
            <div className="dice-abilities">
              {abilities.map((a: Ability) => (
                <div key={a} className="dice-ability">
                  <span className="dice-ability-name" {...tip(ABILITY_NAMES[a])}>
                    {ABILITY_SHORT[a]}
                  </span>
                  <button className="dice-mini" onClick={(e) => fire({ kind: 'ability', key: a }, e)} {...tip(`${ABILITY_NAMES[a]} check`)}>
                    Check <b>{signed(checkMod(sheet, a))}</b>
                  </button>
                  <button
                    className={`dice-mini ${sheet.saves?.[a]?.prof ? 'prof' : ''}`}
                    onClick={(e) => fire({ kind: 'save', key: a }, e)}
                    {...tip(`${ABILITY_NAMES[a]} saving throw`)}
                  >
                    Save <b>{signed(saveMod(sheet, a))}</b>
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        {skills.length > 0 && (
          <>
            <h4 className="dice-section">Skills</h4>
            <div className="dice-skills">
              {skills.map((k) => (
                <CheckButton
                  key={k.key}
                  label={k.name}
                  sub={ABILITY_SHORT[k.ab]}
                  prof={sheet.skills?.[k.key]?.prof ?? 0}
                  mod={signed(skillMod(sheet, k.key))}
                  onRoll={(e) => fire({ kind: 'skill', key: k.key }, e)}
                />
              ))}
            </div>
          </>
        )}
        {attacks.length > 0 && (
          <>
            <h4 className="dice-section">Attacks</h4>
            {attacks.map(([id, a]) => {
              const n = attackNumbers(sheet, a);
              return (
                <div key={id} className="dice-attack">
                  <span className="dice-attack-name">{a.name || 'Attack'}</span>
                  <button className="dice-mini" onClick={(e) => fire({ kind: 'attack', key: id }, e)} {...tip('Roll to hit (and damage)')}>
                    Hit <b>{signed(n.toHit)}</b>
                  </button>
                  {n.damage && (
                    <button className="dice-mini" onClick={(e) => fire({ kind: 'damage', key: id }, e)} {...tip('Roll damage only')}>
                      <b>{n.damage}</b>
                    </button>
                  )}
                </div>
              );
            })}
          </>
        )}
        {spell && attackSpells.length > 0 && (
          <>
            <h4 className="dice-section">Spells</h4>
            {attackSpells.map(([id, sp]) => (
              <div key={id} className="dice-attack">
                <span className="dice-attack-name">{sp.name || 'Spell'}</span>
                {sp.attack && (
                  <button className="dice-mini" onClick={(e) => fire({ kind: 'spell_attack', key: id }, e)}>
                    Hit <b>{signed(spell.attack)}</b>
                  </button>
                )}
                {sp.damage && (
                  <button className="dice-mini" onClick={(e) => fire({ kind: 'spell_damage', key: id }, e)}>
                    <b>{sp.damage}</b>
                  </button>
                )}
              </div>
            ))}
          </>
        )}
        {!abilities.length && !skills.length && !attacks.length && <p className="dice-empty">Nothing matches “{query}”.</p>}
      </div>
    </div>
  );
}

/** The dice popout from the message box: quick dice, sheet checks, and roll options. */
export default function DiceTray({ channelId, onClose }: { channelId: number; onClose: () => void }) {
  const defaultTarget = useDefaultTarget(channelId);
  const [target, setTarget] = useState<Target | null>(null);
  const who = target ?? defaultTarget;
  const [opts, setOpts] = useState<TrayOptions>(() => ({ adv: null, dc: '', private: false, tab: 'dice', ...load<Partial<TrayOptions>>('diceTray', {}) }));
  const [pool, setPool] = useState<Record<number, number>>({});
  const [mod, setMod] = useState(0);
  const [typed, setTyped] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const privateOk = canRollPrivately(channelId);
  const hasCharacter = who.kind === 'character';
  const tab = hasCharacter ? opts.tab : 'dice';

  const setOption = (patch: Partial<TrayOptions>) => {
    setOpts((o) => {
      const next = { ...o, ...patch };
      save('diceTray', { adv: next.adv, dc: next.dc, private: next.private, tab: next.tab });
      return next;
    });
  };

  const expression = typed ?? buildExpression(pool, mod);
  const poolCount = useMemo(() => Object.values(pool).reduce((n, c) => n + c, 0), [pool]);

  const fire = async (req: RollRequest, e?: { shiftKey: boolean }) => {
    if (busy) return;
    const dc = opts.dc.trim() ? Number(opts.dc) : null;
    const full: RollRequest = {
      ...req,
      characterId: who.kind === 'character' ? who.id : null,
      narrator: who.kind === 'narrator',
      adv: req.kind === 'custom' || req.kind === 'damage' || req.kind === 'spell_damage' || req.kind === 'hit_die' ? (req.kind === 'custom' ? opts.adv : null) : opts.adv,
      dc: dc && dc >= 1 && dc <= 60 ? dc : null,
      private: privateOk && opts.private,
    };
    setBusy(true);
    const res = await roll(channelId, full);
    setBusy(false);
    if (res && !e?.shiftKey) onClose();
  };

  const add = (d: number, delta: number) => {
    setTyped(null);
    setPool((p) => {
      const n = Math.max(0, Math.min(99, (p[d] ?? 0) + delta));
      const next = { ...p, [d]: n };
      if (!n) delete next[d];
      return next;
    });
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (expression.trim()) void fire({ kind: 'custom', expression });
  };

  return (
    <div className="dice-tray" onKeyDown={(e) => e.key === 'Escape' && onClose()}>
      <header className="dice-tray-header">
        <RollFor channelId={channelId} target={who} onChange={setTarget} />
      </header>
      {hasCharacter && (
        <nav className="dice-tabs">
          <button className={tab === 'dice' ? 'active' : ''} onClick={() => setOption({ tab: 'dice' })}>
            Dice
          </button>
          <button className={tab === 'checks' ? 'active' : ''} onClick={() => setOption({ tab: 'checks' })}>
            Checks &amp; Attacks
          </button>
        </nav>
      )}

      {tab === 'dice' ? (
        <form className="dice-quick" onSubmit={submit}>
          <div className="dice-pool">
            {DICE.map((d) => (
              <button
                type="button"
                key={d}
                className={`dice-pick ${pool[d] ? 'on' : ''}`}
                onClick={() => add(d, 1)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  add(d, -1);
                }}
                aria-label={`Add a d${d}`}
                {...tip(pool[d] ? `${pool[d]}d${d} (right-click to remove one)` : `d${d}`)}
              >
                <DieShape sides={d} />
                {pool[d] ? <span className="dice-pick-count">{pool[d]}</span> : null}
              </button>
            ))}
          </div>
          <div className="dice-expr-row">
            <div className="dice-mod">
              <button type="button" aria-label="Minus one" onClick={() => (setTyped(null), setMod((m) => m - 1))}>
                −
              </button>
              <span {...tip('Modifier')}>{signed(mod)}</span>
              <button type="button" aria-label="Plus one" onClick={() => (setTyped(null), setMod((m) => m + 1))}>
                +
              </button>
            </div>
            <input
              className="dice-expr"
              value={expression}
              onChange={(e) => setTyped(e.target.value)}
              placeholder="1d20+5, 4d6kh3, 2d6!"
              aria-label="Dice to roll"
              maxLength={120}
              spellCheck={false}
            />
            {(poolCount > 0 || mod !== 0 || typed) && (
              <button
                type="button"
                className="dice-clear"
                aria-label="Clear"
                {...tip('Clear')}
                onClick={() => {
                  setPool({});
                  setMod(0);
                  setTyped(null);
                }}
              >
                <Icon path={mdiClose} size={14} />
              </button>
            )}
          </div>
          <button
            type="button"
            className="dice-roll"
            disabled={!expression.trim() || busy}
            onClick={(e) => void fire({ kind: 'custom', expression }, e)}
            {...tip('Shift+click to keep the tray open')}
          >
            {busy ? 'Rolling…' : `Roll ${expression || ''}`}
          </button>
        </form>
      ) : (
        who.kind === 'character' && <Checks characterId={who.id} fire={(req, e) => void fire(req, e)} />
      )}

      <footer className="dice-options">
        <div className="dice-adv" role="radiogroup" aria-label="Advantage">
          {(
            [
              [null, 'Normal'],
              ['adv', 'Adv'],
              ['dis', 'Dis'],
            ] as const
          ).map(([v, label]) => (
            <button
              key={label}
              role="radio"
              aria-checked={opts.adv === v}
              className={opts.adv === v ? 'on' : ''}
              onClick={() => setOption({ adv: v })}
              {...tip(v === 'adv' ? 'Advantage: roll two d20s, keep the higher' : v === 'dis' ? 'Disadvantage: roll two d20s, keep the lower' : 'Roll normally')}
            >
              {label}
            </button>
          ))}
        </div>
        <label className="dice-dc" {...tip('Difficulty Class: shows success or failure')}>
          DC
          <input value={opts.dc} onChange={(e) => setOption({ dc: e.target.value.replace(/\D/g, '').slice(0, 2) })} placeholder="—" inputMode="numeric" aria-label="Difficulty class" />
        </label>
        {privateOk && (
          <div className="dice-private" {...tip('Only you and the Dungeon Masters will see it')}>
            <span>Private</span>
            <Switch checked={opts.private} onChange={(v) => setOption({ private: v })} label="Private roll" />
          </div>
        )}
      </footer>
    </div>
  );
}
