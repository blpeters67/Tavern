import {
  createContext,
  memo,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react';
import { api, errorMessage } from '../api/http';
import { characterAvatar } from '../lib/avatars';
import { canRollPrivately, roll, rollTargetChannel, type RollRequest } from '../lib/rolls';
import {
  ABILITIES,
  ABILITY_NAMES,
  ABILITY_SHORT,
  ALIGNMENTS,
  alignmentName,
  attackNumbers,
  checkMod,
  classLine,
  CONDITIONS,
  CURRENCIES,
  CURRENCY_NAMES,
  goldValue,
  initiativeMod,
  inventoryWeight,
  newId,
  nextSort,
  passive,
  profBonus,
  saveMod,
  signed,
  skillMod,
  SKILLS,
  sorted,
  spellNumbers,
  totalLevel,
  XP_LEVELS,
  type Ability,
  type Attack,
  type Feature,
  type Item,
  type Resource,
  type Sheet,
  type Spell,
} from '../lib/sheet';
import { patchSheet, sheetSaving, useSheet } from '../lib/sheetStore';
import { closeSheet, openContextMenu, openModal } from '../store/actions';
import { displayName } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Character } from '../store/types';
import {
  Icon,
  mdiBagPersonalOutline,
  mdiBookOpenPageVariant,
  mdiCash,
  mdiChevronDown,
  mdiChevronRight,
  mdiClose,
  mdiDelete,
  mdiDragVertical,
  mdiEye,
  mdiFire,
  mdiHeart,
  mdiHeartPulse,
  mdiLock,
  mdiMagicStaff,
  mdiPlus,
  mdiScriptTextOutline,
  mdiShield,
  mdiShieldSword,
  mdiStar,
  mdiStarOutline,
  mdiSwordCross,
} from './icons';
import { MenuItem, MenuSeparator, Modal, tip } from './layers';
import { toast } from './Toasts';
import { Button, Spinner } from './ui';

type Patch = Record<string, unknown>;
type TabKey = 'main' | 'actions' | 'spells' | 'inventory' | 'features' | 'bio';

const TABS: { key: TabKey; label: string; icon: string }[] = [
  { key: 'main', label: 'Main', icon: mdiShieldSword },
  { key: 'actions', label: 'Actions', icon: mdiSwordCross },
  { key: 'spells', label: 'Spells', icon: mdiMagicStaff },
  { key: 'inventory', label: 'Inventory', icon: mdiBagPersonalOutline },
  { key: 'features', label: 'Features', icon: mdiStar },
  { key: 'bio', label: 'Bio & Notes', icon: mdiScriptTextOutline },
];

const D20_KINDS = new Set(['skill', 'save', 'ability', 'initiative', 'death_save', 'attack', 'spell_attack']);

// ---------------------------------------------------------------------------
// Context: the sheet being shown and what you can do with it
// ---------------------------------------------------------------------------

interface SheetCtx {
  characterId: number;
  sheet: Sheet;
  canEdit: boolean;
  patch: (p: Patch) => void;
  /** Roll using the sheet (adv/dis and private come from the header controls). */
  rollIt: (req: RollRequest, opts?: { adv?: 'adv' | 'dis' | null; private?: boolean }) => void;
  rollMenu: (e: MouseEvent, req: RollRequest) => void;
}

const Ctx = createContext<SheetCtx | null>(null);
const useSheetCtx = () => useContext(Ctx)!;

// ---------------------------------------------------------------------------
// Inline fields: look like text until you hover or focus them
// ---------------------------------------------------------------------------

function NumField({
  value,
  onCommit,
  min = -999,
  max = 99999,
  label,
  className,
  signedValue,
  placeholder,
}: {
  value: number;
  onCommit: (v: number) => void;
  min?: number;
  max?: number;
  label: string;
  className?: string;
  signedValue?: boolean;
  placeholder?: string;
}) {
  const { canEdit } = useSheetCtx();
  const [draft, setDraft] = useState<string | null>(null);
  const shown = signedValue ? signed(value) : String(value);
  if (!canEdit) return <span className={`sf-num readonly ${className ?? ''}`}>{shown}</span>;
  const commit = (raw: string) => {
    setDraft(null);
    const trimmed = raw.trim();
    if (!trimmed) return;
    // "+3" / "-2" as a relative change when the field isn't signed (handy for HP and gold).
    const rel = !signedValue && /^[+-]\d+$/.test(trimmed) && trimmed !== String(value);
    const n = Number(trimmed);
    if (!Number.isFinite(n)) return;
    const next = Math.max(min, Math.min(max, Math.round(rel ? value + n : n)));
    if (next !== value) onCommit(next);
  };
  return (
    <input
      className={`sf-num ${className ?? ''}`}
      aria-label={label}
      inputMode="numeric"
      value={draft ?? shown}
      placeholder={placeholder}
      onFocus={(e) => {
        setDraft(String(value));
        requestAnimationFrame(() => e.target.select());
      }}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => commit(e.target.value)}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          (e.target as HTMLInputElement).blur();
          e.stopPropagation();
        } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          const n = Math.max(min, Math.min(max, value + (e.key === 'ArrowUp' ? 1 : -1)));
          onCommit(n);
          setDraft(String(n));
        }
      }}
    />
  );
}

function TextField({
  value,
  onCommit,
  label,
  placeholder,
  className,
  maxLength = 120,
}: {
  value: string;
  onCommit: (v: string) => void;
  label: string;
  placeholder?: string;
  className?: string;
  maxLength?: number;
}) {
  const { canEdit } = useSheetCtx();
  const [draft, setDraft] = useState<string | null>(null);
  if (!canEdit) return <span className={`sf-text readonly ${className ?? ''} ${value ? '' : 'empty'}`}>{value || placeholder || '—'}</span>;
  return (
    <input
      className={`sf-text ${className ?? ''}`}
      aria-label={label}
      value={draft ?? value}
      placeholder={placeholder}
      maxLength={maxLength}
      onFocus={() => setDraft(value)}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={(e) => {
        setDraft(null);
        if (e.target.value !== value) onCommit(e.target.value);
      }}
      onKeyDown={(e) => {
        if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
        else if (e.key === 'Escape') {
          setDraft(null);
          e.stopPropagation();
          requestAnimationFrame(() => (e.target as HTMLInputElement).blur());
        }
      }}
    />
  );
}

/** Long text (lore, backstory): autosizing, saves as you type (debounced) and on blur. */
function LongText({ value, onCommit, label, placeholder, maxLength = 20000, serif = true }: { value: string; onCommit: (v: string) => void; label: string; placeholder?: string; maxLength?: number; serif?: boolean }) {
  const { canEdit } = useSheetCtx();
  const [draft, setDraft] = useState<string | null>(null);
  const ref = useRef<HTMLTextAreaElement>(null);
  const timer = useRef<number | null>(null);
  const shown = draft ?? value;
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight + 2}px`;
  }, [shown]);
  useEffect(() => () => void (timer.current && window.clearTimeout(timer.current)), []);
  if (!canEdit) {
    return <div className={`sf-long readonly ${serif ? 'serif' : ''} ${value ? '' : 'empty'}`}>{value || placeholder || 'Nothing written yet.'}</div>;
  }
  const flush = (v: string) => {
    if (timer.current) window.clearTimeout(timer.current);
    timer.current = null;
    if (v !== value) onCommit(v);
  };
  return (
    <textarea
      ref={ref}
      className={`sf-long ${serif ? 'serif' : ''}`}
      aria-label={label}
      value={shown}
      placeholder={placeholder}
      maxLength={maxLength}
      rows={2}
      onFocus={() => setDraft(value)}
      onChange={(e) => {
        const v = e.target.value;
        setDraft(v);
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => flush(v), 700);
      }}
      onBlur={(e) => {
        flush(e.target.value);
        setDraft(null);
      }}
      onKeyDown={(e) => e.key === 'Escape' && e.stopPropagation()}
    />
  );
}

function Check({ checked, onChange, label, className }: { checked: boolean; onChange: (v: boolean) => void; label: string; className?: string }) {
  const { canEdit } = useSheetCtx();
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`sf-check ${checked ? 'on' : ''} ${className ?? ''}`}
      disabled={!canEdit}
      onClick={() => onChange(!checked)}
      {...tip(label)}
    />
  );
}

function Select<T extends string>({ value, options, onChange, label, className }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string; className?: string }) {
  const { canEdit } = useSheetCtx();
  if (!canEdit) return <span className={`sf-text readonly ${className ?? ''}`}>{options.find((o) => o.value === value)?.label || '—'}</span>;
  return (
    <select className={`sf-select ${className ?? ''}`} aria-label={label} value={value} onChange={(e) => onChange(e.target.value as T)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

/** A number you can click to roll (right-click for advantage and friends). */
function Rollable({ req, children, className, label }: { req: RollRequest; children: ReactNode; className?: string; label: string }) {
  const { canEdit, rollIt, rollMenu } = useSheetCtx();
  if (!canEdit) return <span className={`sf-rollable readonly ${className ?? ''}`}>{children}</span>;
  return (
    <button
      type="button"
      className={`sf-rollable ${className ?? ''}`}
      onClick={() => rollIt(req)}
      onContextMenu={(e) => rollMenu(e, req)}
      aria-label={`Roll ${label}`}
      {...tip(`Roll ${label}`)}
    >
      {children}
    </button>
  );
}

function Section({ title, icon, children, actions, className }: { title: string; icon?: string; children: ReactNode; actions?: ReactNode; className?: string }) {
  return (
    <section className={`sf-section ${className ?? ''}`}>
      <header className="sf-section-head">
        {icon && <Icon path={icon} size={15} />}
        <h3>{title}</h3>
        {actions && <div className="sf-section-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

function AddButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { canEdit } = useSheetCtx();
  if (!canEdit) return null;
  return (
    <button type="button" className="sf-add" onClick={onClick}>
      <Icon path={mdiPlus} size={15} />
      {label}
    </button>
  );
}

function RemoveButton({ label, onClick }: { label: string; onClick: () => void }) {
  const { canEdit } = useSheetCtx();
  if (!canEdit) return null;
  return (
    <button type="button" className="sf-remove" aria-label={label} onClick={onClick} {...tip(label)}>
      <Icon path={mdiDelete} size={15} />
    </button>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function HitPoints() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const [amount, setAmount] = useState('');
  const hp = sheet.hp;
  const apply = (kind: 'damage' | 'heal') => {
    const n = Math.abs(Math.round(Number(amount)));
    if (!n) return;
    if (kind === 'heal') {
      patch({ hp: { current: Math.min(hp.max, Math.max(0, hp.current) + n) } });
    } else {
      const fromTemp = Math.min(hp.temp, n);
      patch({ hp: { temp: hp.temp - fromTemp, current: Math.max(-hp.max, hp.current - (n - fromTemp)) } });
    }
    setAmount('');
  };
  const pct = hp.max > 0 ? Math.max(0, Math.min(100, (hp.current / hp.max) * 100)) : 0;
  const state = hp.current <= 0 ? 'down' : pct <= 25 ? 'low' : pct <= 50 ? 'mid' : 'ok';
  return (
    <div className={`sf-hp ${state}`}>
      <div className="sf-stat-label">
        <Icon path={mdiHeart} size={13} /> Hit Points
      </div>
      <div className="sf-hp-values">
        <NumField value={hp.current} label="Current hit points" min={-9999} max={9999} className="sf-hp-current" onCommit={(v) => patch({ hp: { current: v } })} />
        <span className="sf-hp-slash">/</span>
        <NumField value={hp.max} label="Maximum hit points" min={0} max={9999} className="sf-hp-max" onCommit={(v) => patch({ hp: { max: v } })} />
        {(hp.temp > 0 || canEdit) && (
          <span className="sf-hp-temp" {...tip('Temporary hit points')}>
            +<NumField value={hp.temp} label="Temporary hit points" min={0} max={9999} onCommit={(v) => patch({ hp: { temp: v } })} />
          </span>
        )}
      </div>
      <div className="sf-hp-bar">
        <span style={{ width: `${pct}%` }} />
      </div>
      {canEdit && (
        <div className="sf-hp-adjust">
          <button type="button" className="sf-hp-btn damage" onClick={() => apply('damage')} disabled={!amount}>
            Damage
          </button>
          <input
            className="sf-hp-amount"
            inputMode="numeric"
            placeholder="0"
            aria-label="Amount"
            value={amount}
            onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, '').slice(0, 4))}
            onKeyDown={(e) => {
              if (e.key === 'Enter') apply(e.shiftKey ? 'heal' : 'damage');
            }}
            {...tip('Enter to take damage, Shift+Enter to heal')}
          />
          <button type="button" className="sf-hp-btn heal" onClick={() => apply('heal')} disabled={!amount}>
            Heal
          </button>
        </div>
      )}
    </div>
  );
}

function RollModeControl({ mode, setMode, privateOk }: { mode: RollMode; setMode: (m: RollMode) => void; privateOk: boolean }) {
  return (
    <div className="sf-rollmode">
      <div className="sf-seg" role="radiogroup" aria-label="Roll with">
        {(
          [
            [null, 'Normal'],
            ['adv', 'Advantage'],
            ['dis', 'Disadvantage'],
          ] as const
        ).map(([v, label]) => (
          <button key={label} role="radio" aria-checked={mode.adv === v} className={mode.adv === v ? 'on' : ''} onClick={() => setMode({ ...mode, adv: v })}>
            {label}
          </button>
        ))}
      </div>
      {privateOk && (
        <button
          className={`sf-private ${mode.private ? 'on' : ''}`}
          aria-pressed={mode.private}
          onClick={() => setMode({ ...mode, private: !mode.private })}
          {...tip('Private rolls are only seen by you and the Dungeon Masters')}
        >
          <Icon path={mode.private ? mdiLock : mdiEye} size={14} />
          {mode.private ? 'Private' : 'Public'}
        </button>
      )}
    </div>
  );
}

interface RollMode {
  adv: 'adv' | 'dis' | null;
  private: boolean;
}

function Header({ character, mode, setMode, serverId, saving }: { character: Character; mode: RollMode; setMode: (m: RollMode) => void; serverId: number | null; saving: boolean }) {
  const { sheet, patch, canEdit } = useSheetCtx();
  const owner = useStore((s) => s.users[character.owner_id]);
  const me = useStore((s) => s.me!);
  const immersive = me.settings.immersive;
  const mine = character.owner_id === me.id;
  const level = totalLevel(sheet);
  const cls = classLine(sheet);
  const line = [cls ? `Level ${level} ${cls.includes('/') ? '· ' + cls : cls.replace(/ \d+$/, '')}` : `Level ${level}`, sheet.species, alignmentName(sheet.alignment)]
    .filter(Boolean)
    .join(' · ');
  const setVisibility = async (v: 'public' | 'private') => {
    try {
      const form = new FormData();
      form.append('sheet_visibility', v);
      await api.patch(`/api/users/@me/characters/${character.id}`, form);
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  const channelId = rollTargetChannel(serverId);
  return (
    <header className="sf-header">
      <div className="sf-identity">
        <img className="sf-avatar" src={characterAvatar(character)} alt="" />
        <div className="sf-who">
          <h2 className="sf-name">{character.name}</h2>
          <div className="sf-line">{line}</div>
          <div className="sf-meta">
            {(!immersive || mine) && owner && <span>Played by {displayName(owner)}</span>}
            {character.sheet_visibility === 'private' && !mine && (
              <span className="sf-lock" {...tip('Only the player and the Dungeon Masters can see this sheet')}>
                <Icon path={mdiLock} size={12} /> Private
              </span>
            )}
            {mine && (
              <button
                className={`sf-visibility ${character.sheet_visibility}`}
                onClick={() => setVisibility(character.sheet_visibility === 'private' ? 'public' : 'private')}
                {...tip(character.sheet_visibility === 'private' ? 'Only you and the Dungeon Masters can see it. Click to share.' : 'Everyone in your servers can see it. Click to make it private.')}
              >
                <Icon path={character.sheet_visibility === 'private' ? mdiLock : mdiEye} size={12} />
                {character.sheet_visibility === 'private' ? 'Private sheet' : 'Public sheet'}
              </button>
            )}
            {saving && <span className="sf-saving">Saving…</span>}
          </div>
        </div>
        <button className="sf-close" aria-label="Close character sheet" onClick={closeSheet} {...tip('Close (Esc)', 'left')}>
          <Icon path={mdiClose} size={22} />
        </button>
      </div>
      <div className="sf-strip">
        <div className="sf-stat">
          <div className="sf-stat-label">
            <Icon path={mdiShield} size={13} /> Armor
          </div>
          <NumField value={sheet.ac} label="Armor class" min={0} max={50} className="sf-stat-value" onCommit={(v) => patch({ ac: v })} />
        </div>
        <div className="sf-stat">
          <div className="sf-stat-label">Initiative</div>
          <Rollable req={{ kind: 'initiative' }} label="initiative" className="sf-stat-value">
            {signed(initiativeMod(sheet))}
          </Rollable>
        </div>
        <div className="sf-stat">
          <div className="sf-stat-label">Speed</div>
          <TextField value={sheet.speed} label="Speed" className="sf-stat-text" maxLength={40} onCommit={(v) => patch({ speed: v })} />
        </div>
        <div className="sf-stat">
          <div className="sf-stat-label" {...tip('Proficiency bonus')}>
            Prof.
          </div>
          <span className="sf-stat-value static">{signed(profBonus(sheet))}</span>
        </div>
        <HitPoints />
        <div className="sf-stat">
          <div className="sf-stat-label">Inspiration</div>
          <button
            type="button"
            className={`sf-inspiration ${sheet.inspiration ? 'on' : ''}`}
            aria-pressed={sheet.inspiration}
            disabled={!canEdit}
            onClick={() => patch({ inspiration: !sheet.inspiration })}
            {...tip(sheet.inspiration ? 'Inspired! Click to spend it.' : 'No inspiration')}
          >
            <Icon path={sheet.inspiration ? mdiStar : mdiStarOutline} size={22} />
          </button>
        </div>
      </div>
      {canEdit && (
        <div className="sf-rollbar">
          <span className="sf-rollbar-hint">
            {channelId ? (
              <>
                Click a number to roll it in <b>{getState().channels[channelId]?.name ?? 'chat'}</b>
              </>
            ) : (
              'Open a text channel to roll from the sheet'
            )}
          </span>
          <RollModeControl mode={mode} setMode={setMode} privateOk={channelId !== null && canRollPrivately(channelId)} />
        </div>
      )}
    </header>
  );
}

// ---------------------------------------------------------------------------
// Main tab
// ---------------------------------------------------------------------------

const PROF_LABEL: Record<string, string> = { '0': 'Not proficient', '0.5': 'Half proficiency', '1': 'Proficient', '2': 'Expertise' };
const PROF_NEXT: Record<string, 0 | 0.5 | 1 | 2> = { '0': 1, '1': 2, '2': 0.5, '0.5': 0 };

function ProfDot({ value, onChange }: { value: number; onChange: (v: 0 | 0.5 | 1 | 2) => void }) {
  const { canEdit } = useSheetCtx();
  const key = String(value);
  return (
    <button
      type="button"
      className={`sf-prof p${key.replace('.', '')}`}
      disabled={!canEdit}
      onClick={() => onChange(PROF_NEXT[key] ?? 0)}
      aria-label={PROF_LABEL[key]}
      {...tip(canEdit ? `${PROF_LABEL[key]} (click to change)` : PROF_LABEL[key])}
    />
  );
}

const Abilities = memo(function Abilities() {
  const { sheet, patch } = useSheetCtx();
  return (
    <div className="sf-abilities">
      {ABILITIES.map((a) => {
        const score = sheet.abilities[a] ?? 10;
        const save = sheet.saves[a] ?? { prof: false, bonus: 0 };
        return (
          <div key={a} className="sf-ability">
            <div className="sf-ability-name" {...tip(ABILITY_NAMES[a])}>
              {ABILITY_SHORT[a]}
            </div>
            <Rollable req={{ kind: 'ability', key: a }} label={`${ABILITY_NAMES[a]} check`} className="sf-ability-mod">
              {signed(checkMod(sheet, a))}
            </Rollable>
            <NumField value={score} label={`${ABILITY_NAMES[a]} score`} min={1} max={30} className="sf-ability-score" onCommit={(v) => patch({ abilities: { [a]: v } })} />
            <div className="sf-save">
              <Check checked={save.prof} label={`Proficient in ${ABILITY_NAMES[a]} saves`} onChange={(v) => patch({ saves: { [a]: { prof: v } } })} />
              <Rollable req={{ kind: 'save', key: a }} label={`${ABILITY_NAMES[a]} save`} className="sf-save-roll">
                Save {signed(saveMod(sheet, a))}
              </Rollable>
            </div>
          </div>
        );
      })}
    </div>
  );
});

const Skills = memo(function Skills() {
  const { sheet, patch } = useSheetCtx();
  const list = useMemo(() => Object.entries(SKILLS).sort((a, b) => a[1][1].localeCompare(b[1][1])), []);
  return (
    <div className="sf-skills">
      {list.map(([key, [ab, name]]) => {
        const entry = sheet.skills[key] ?? { prof: 0, bonus: 0 };
        return (
          <div key={key} className="sf-skill">
            <ProfDot value={entry.prof} onChange={(v) => patch({ skills: { [key]: { prof: v } } })} />
            <span className="sf-skill-name">{name}</span>
            <span className="sf-skill-ab">{ABILITY_SHORT[ab as Ability]}</span>
            <Rollable req={{ kind: 'skill', key }} label={name} className="sf-skill-mod">
              {signed(skillMod(sheet, key))}
            </Rollable>
          </div>
        );
      })}
    </div>
  );
});

function DeathSaves() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const ds = sheet.death_saves;
  const pips = (kind: 'success' | 'failure') => (
    <div className={`sf-pips ${kind}`}>
      {[1, 2, 3].map((n) => (
        <button
          key={n}
          type="button"
          className={`sf-pip ${ds[kind] >= n ? 'on' : ''}`}
          disabled={!canEdit}
          aria-label={`${kind} ${n}`}
          onClick={() => patch({ death_saves: { [kind]: ds[kind] >= n ? n - 1 : n } })}
        />
      ))}
    </div>
  );
  return (
    <div className="sf-death">
      <div className="sf-death-row">
        <span>Successes</span>
        {pips('success')}
      </div>
      <div className="sf-death-row">
        <span>Failures</span>
        {pips('failure')}
      </div>
      {canEdit && (
        <div className="sf-death-actions">
          <Rollable req={{ kind: 'death_save' }} label="a death save" className="sf-small-btn">
            Roll Death Save
          </Rollable>
          {(ds.success > 0 || ds.failure > 0) && (
            <button type="button" className="sf-link" onClick={() => patch({ death_saves: { success: 0, failure: 0 } })}>
              Reset
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function MainTab() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const level = totalLevel(sheet);
  const hitDice = useMemo(() => {
    const out: Record<number, number> = {};
    for (const c of Object.values(sheet.classes)) out[c.hit_die] = (out[c.hit_die] ?? 0) + c.level;
    return out;
  }, [sheet.classes]);
  const totalDice = Object.values(hitDice).reduce((n, c) => n + c, 0) || level;
  const diceLabel = Object.entries(hitDice)
    .map(([die, n]) => `${n}d${die}`)
    .join(' + ');
  return (
    <div className="sf-main">
      <Abilities />
      <div className="sf-columns">
        <Section title="Skills" className="sf-skills-section">
          <Skills />
          <div className="sf-inline-opts">
            <label className="sf-inline-check">
              <Check checked={sheet.jack_of_all_trades} label="Jack of All Trades" onChange={(v) => patch({ jack_of_all_trades: v })} />
              Jack of All Trades
            </label>
          </div>
        </Section>
        <div className="sf-col">
          <Section title="Senses">
            <div className="sf-kv">
              <span>Passive Perception</span>
              <b>{passive(sheet, 'perception')}</b>
            </div>
            <div className="sf-kv">
              <span>Passive Insight</span>
              <b>{passive(sheet, 'insight')}</b>
            </div>
            <div className="sf-kv">
              <span>Passive Investigation</span>
              <b>{passive(sheet, 'investigation')}</b>
            </div>
          </Section>
          <Section title="Hit Dice" icon={mdiHeartPulse}>
            <div className="sf-kv">
              <span>{diceLabel || `${level}d8`}</span>
              <span className="sf-hitdice">
                <NumField value={Math.max(0, totalDice - sheet.hit_dice_used)} label="Hit dice left" min={0} max={totalDice} onCommit={(v) => patch({ hit_dice_used: Math.max(0, totalDice - v) })} />
                <span className="sf-muted sf-of">/ {totalDice} left</span>
              </span>
            </div>
            {canEdit && (
              <Rollable req={{ kind: 'hit_die' }} label="a hit die" className="sf-small-btn">
                Roll Hit Die
              </Rollable>
            )}
          </Section>
          <Section title="Death Saves" icon={mdiHeartPulse}>
            <DeathSaves />
          </Section>
          <Section title="Conditions">
            <div className="sf-conditions">
              {CONDITIONS.map((c) => (
                <button
                  key={c}
                  type="button"
                  className={`sf-chip ${sheet.conditions[c] ? 'on' : ''}`}
                  disabled={!canEdit && !sheet.conditions[c]}
                  onClick={() => canEdit && patch({ conditions: { [c]: !sheet.conditions[c] } })}
                >
                  {c[0].toUpperCase() + c.slice(1)}
                </button>
              ))}
            </div>
            <div className="sf-kv">
              <span>Exhaustion</span>
              <span className="sf-exhaustion">
                {[1, 2, 3, 4, 5, 6].map((n) => (
                  <button
                    key={n}
                    type="button"
                    className={`sf-pip ${sheet.exhaustion >= n ? 'on' : ''}`}
                    disabled={!canEdit}
                    aria-label={`Exhaustion level ${n}`}
                    onClick={() => patch({ exhaustion: sheet.exhaustion >= n ? n - 1 : n })}
                    {...tip(`Level ${n}`)}
                  />
                ))}
              </span>
            </div>
          </Section>
          <Section title="Combat">
            <div className="sf-kv">
              <span>Armor note</span>
              <TextField value={sheet.ac_note} label="Armor note" placeholder="Chain mail, shield" maxLength={80} onCommit={(v) => patch({ ac_note: v })} />
            </div>
            <div className="sf-kv">
              <span>Initiative bonus</span>
              <NumField value={sheet.initiative_bonus} label="Initiative bonus" min={-30} max={30} signedValue onCommit={(v) => patch({ initiative_bonus: v })} />
            </div>
            <div className="sf-kv">
              <span {...tip('Leave at 0 to work it out from your level')}>Proficiency override</span>
              <NumField value={sheet.prof_bonus_override} label="Proficiency bonus override" min={0} max={12} onCommit={(v) => patch({ prof_bonus_override: v })} />
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Keyed lists (attacks, spells, items, resources, features)
// ---------------------------------------------------------------------------

function confirmRemove(what: string, onYes: () => void) {
  openModal((close) => (
    <Modal
      title={`Remove ${what}?`}
      onClose={close}
      footer={
        <>
          <Button look="link" onClick={close}>
            Cancel
          </Button>
          <Button
            look="danger"
            onClick={() => {
              close();
              onYes();
            }}
          >
            Remove
          </Button>
        </>
      }
    >
      <p className="modal-text">This can't be undone.</p>
    </Modal>
  ));
}

function useExpanded(): [Set<string>, (id: string) => void] {
  const [open, setOpen] = useState<Set<string>>(new Set());
  return [
    open,
    (id: string) =>
      setOpen((s) => {
        const n = new Set(s);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
  ];
}

const AttackRow = memo(function AttackRow({ id, attack, expanded, onToggle }: { id: string; attack: Attack; expanded: boolean; onToggle: () => void }) {
  const { sheet, patch } = useSheetCtx();
  const nums = attackNumbers(sheet, attack);
  const set = (p: Partial<Attack>) => patch({ attacks: { [id]: p } });
  return (
    <div className={`sf-row sf-attack ${expanded ? 'expanded' : ''}`}>
      <div className="sf-row-main">
        <button type="button" className="sf-expand" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={onToggle}>
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={16} />
        </button>
        <TextField value={attack.name} label="Attack name" placeholder="Longsword" className="sf-row-name" maxLength={80} onCommit={(v) => set({ name: v })} />
        <Rollable req={{ kind: 'attack', key: id }} label={`${attack.name || 'attack'} (to hit and damage)`} className="sf-pill">
          {signed(nums.toHit)}
        </Rollable>
        {nums.damage ? (
          <Rollable req={{ kind: 'damage', key: id }} label={`${attack.name || 'attack'} damage`} className="sf-pill damage">
            {nums.damage}
            {attack.damage_type && <span className="sf-dmg-type">{attack.damage_type}</span>}
          </Rollable>
        ) : (
          <span className="sf-pill empty">No damage</span>
        )}
        <RemoveButton label="Remove attack" onClick={() => confirmRemove(attack.name || 'this attack', () => patch({ attacks: { [id]: null } }))} />
      </div>
      {expanded && (
        <div className="sf-row-details">
          <label>
            Ability
            <Select
              value={attack.ability}
              label="Attack ability"
              options={[{ value: '' as const, label: 'None' }, ...ABILITIES.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))]}
              onChange={(v) => set({ ability: v })}
            />
          </label>
          <label className="sf-inline-check">
            <Check checked={attack.proficient} label="Proficient" onChange={(v) => set({ proficient: v })} />
            Proficient
          </label>
          <label>
            Extra to hit
            <NumField value={attack.attack_bonus} label="Extra to hit" min={-30} max={30} signedValue onCommit={(v) => set({ attack_bonus: v })} />
          </label>
          <label>
            Damage dice
            <TextField value={attack.damage} label="Damage dice" placeholder="1d8" maxLength={60} onCommit={(v) => set({ damage: v })} />
          </label>
          <label className="sf-inline-check">
            <Check checked={attack.damage_ability} label="Add ability to damage" onChange={(v) => set({ damage_ability: v })} />
            Add ability to damage
          </label>
          <label>
            Extra damage
            <NumField value={attack.damage_bonus} label="Extra damage" min={-30} max={30} signedValue onCommit={(v) => set({ damage_bonus: v })} />
          </label>
          <label>
            Damage type
            <TextField value={attack.damage_type} label="Damage type" placeholder="slashing" maxLength={40} onCommit={(v) => set({ damage_type: v })} />
          </label>
          <label>
            Range
            <TextField value={attack.range} label="Range" placeholder="5 ft" maxLength={40} onCommit={(v) => set({ range: v })} />
          </label>
          <label className="wide">
            Notes
            <LongText value={attack.notes} label="Attack notes" placeholder="Finesse, versatile (1d10)…" maxLength={500} serif={false} onCommit={(v) => set({ notes: v })} />
          </label>
        </div>
      )}
    </div>
  );
});

const ResourceRow = memo(function ResourceRow({ id, res }: { id: string; res: Resource }) {
  const { patch, canEdit } = useSheetCtx();
  const set = (p: Partial<Resource>) => patch({ resources: { [id]: p } });
  return (
    <div className="sf-row sf-resource">
      <div className="sf-row-main">
        <TextField value={res.name} label="Resource name" placeholder="Ki Points" className="sf-row-name" maxLength={60} onCommit={(v) => set({ name: v })} />
        <div className="sf-counter">
          {canEdit && (
            <button type="button" aria-label="Use one" onClick={() => set({ current: Math.max(0, res.current - 1) })}>
              −
            </button>
          )}
          <NumField value={res.current} label="Current" min={0} max={9999} onCommit={(v) => set({ current: v })} />
          <span className="sf-muted">/</span>
          <NumField value={res.max} label="Maximum" min={0} max={9999} onCommit={(v) => set({ max: v })} />
          {canEdit && (
            <button type="button" aria-label="Regain one" onClick={() => set({ current: Math.min(res.max || 9999, res.current + 1) })}>
              +
            </button>
          )}
        </div>
        <Select
          value={res.reset}
          label="Recharges on"
          className="sf-reset"
          options={[
            { value: 'long', label: 'Long rest' },
            { value: 'short', label: 'Short rest' },
            { value: 'none', label: "Doesn't recharge" },
          ]}
          onChange={(v) => set({ reset: v })}
        />
        <RemoveButton label="Remove resource" onClick={() => confirmRemove(res.name || 'this resource', () => patch({ resources: { [id]: null } }))} />
      </div>
    </div>
  );
});

function rest(kind: 'short' | 'long', sheet: Sheet, patch: (p: Patch) => void) {
  const resources: Patch = {};
  for (const [id, r] of Object.entries(sheet.resources)) {
    if (r.reset === 'short' || (kind === 'long' && r.reset === 'long')) resources[id] = { current: r.max };
  }
  if (kind === 'short') {
    patch({ resources });
    return;
  }
  const level = totalLevel(sheet);
  const totalDice = Object.values(sheet.classes).reduce((n, c) => n + c.level, 0) || level;
  const slots: Patch = {};
  for (const [lvl, s] of Object.entries(sheet.spell_slots)) if (s.used) slots[lvl] = { used: 0 };
  patch({
    resources,
    spell_slots: slots,
    hp: { current: sheet.hp.max, temp: 0 },
    hit_dice_used: Math.max(0, sheet.hit_dice_used - Math.max(1, Math.floor(totalDice / 2))),
    death_saves: { success: 0, failure: 0 },
    exhaustion: Math.max(0, sheet.exhaustion - 1),
  });
}

function confirmRest(kind: 'short' | 'long', sheet: Sheet, patch: (p: Patch) => void) {
  openModal((close) => (
    <Modal
      title={kind === 'long' ? 'Take a long rest?' : 'Take a short rest?'}
      onClose={close}
      footer={
        <>
          <Button look="link" onClick={close}>
            Cancel
          </Button>
          <Button
            look="gold"
            onClick={() => {
              close();
              rest(kind, sheet, patch);
              toast(kind === 'long' ? 'Rested. Hit points, spell slots and resources are back.' : 'Short rest taken. Short-rest resources are back.', 'success');
            }}
          >
            Rest
          </Button>
        </>
      }
    >
      <p className="modal-text">
        {kind === 'long'
          ? 'Restores hit points and spell slots, recharges resources, recovers half your hit dice, clears death saves and removes one level of exhaustion.'
          : 'Recharges resources that come back on a short rest. Roll hit dice from the Main tab to heal.'}
      </p>
    </Modal>
  ));
}

function ActionsTab() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const [expanded, toggle] = useExpanded();
  const attacks = sorted(sheet.attacks);
  const resources = sorted(sheet.resources);
  const addAttack = () => {
    const id = newId();
    patch({
      attacks: {
        [id]: { name: '', ability: 'str', proficient: true, attack_bonus: 0, damage: '1d6', damage_ability: true, damage_bonus: 0, damage_type: '', range: '', notes: '', sort: nextSort(sheet.attacks) },
      },
    });
    toggle(id);
  };
  return (
    <div className="sf-tab">
      <Section title="Attacks" icon={mdiSwordCross} actions={<AddButton label="Add Attack" onClick={addAttack} />}>
        {attacks.length === 0 && <p className="sf-empty">No attacks yet.{canEdit ? ' Add your weapons and cantrips here to roll them in one click.' : ''}</p>}
        {attacks.map(([id, a]) => (
          <AttackRow key={id} id={id} attack={a} expanded={expanded.has(id)} onToggle={() => toggle(id)} />
        ))}
      </Section>
      <Section
        title="Resources"
        icon={mdiFire}
        actions={
          <AddButton
            label="Add Resource"
            onClick={() => patch({ resources: { [newId()]: { name: '', current: 1, max: 1, reset: 'long', sort: nextSort(sheet.resources) } } })}
          />
        }
      >
        {resources.length === 0 && <p className="sf-empty">Track things like Rage, Ki Points or Bardic Inspiration here.</p>}
        {resources.map(([id, r]) => (
          <ResourceRow key={id} id={id} res={r} />
        ))}
      </Section>
      {canEdit && (
        <div className="sf-rest">
          <Button look="secondary" onClick={() => confirmRest('short', sheet, patch)}>
            Short Rest
          </Button>
          <Button look="gold" onClick={() => confirmRest('long', sheet, patch)}>
            Long Rest
          </Button>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Spells
// ---------------------------------------------------------------------------

const SpellRow = memo(function SpellRow({ id, spell, expanded, onToggle }: { id: string; spell: Spell; expanded: boolean; onToggle: () => void }) {
  const { patch, canEdit } = useSheetCtx();
  const set = (p: Partial<Spell>) => patch({ spells: { [id]: p } });
  const tags = [spell.concentration && 'C', spell.ritual && 'R'].filter(Boolean) as string[];
  return (
    <div className={`sf-row sf-spell ${expanded ? 'expanded' : ''} ${spell.prepared || spell.level === 0 ? 'prepared' : ''}`}>
      <div className="sf-row-main">
        <button type="button" className="sf-expand" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={onToggle}>
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={16} />
        </button>
        {spell.level > 0 && <Check checked={spell.prepared} label="Prepared" onChange={(v) => set({ prepared: v })} className="sf-prepared" />}
        <TextField value={spell.name} label="Spell name" placeholder="Magic Missile" className="sf-row-name" maxLength={80} onCommit={(v) => set({ name: v })} />
        {tags.map((t) => (
          <span key={t} className="sf-spell-tag" {...tip(t === 'C' ? 'Concentration' : 'Ritual')}>
            {t}
          </span>
        ))}
        {spell.attack && (
          <Rollable req={{ kind: 'spell_attack', key: id }} label={`${spell.name || 'spell'} attack`} className="sf-pill">
            Hit
          </Rollable>
        )}
        {spell.damage && (
          <Rollable req={{ kind: 'spell_damage', key: id }} label={`${spell.name || 'spell'} damage`} className="sf-pill damage">
            {spell.damage}
          </Rollable>
        )}
        {spell.save && <span className="sf-pill empty">{ABILITY_SHORT[spell.save]} save</span>}
        <RemoveButton label="Remove spell" onClick={() => confirmRemove(spell.name || 'this spell', () => patch({ spells: { [id]: null } }))} />
      </div>
      {expanded && (
        <div className="sf-row-details">
          <label>
            Level
            <Select
              value={String(spell.level)}
              label="Spell level"
              options={Array.from({ length: 10 }, (_, i) => ({ value: String(i), label: i === 0 ? 'Cantrip' : `Level ${i}` }))}
              onChange={(v) => set({ level: Number(v) })}
            />
          </label>
          <label>
            School
            <TextField value={spell.school} label="School" placeholder="Evocation" maxLength={30} onCommit={(v) => set({ school: v })} />
          </label>
          <label>
            Casting time
            <TextField value={spell.casting_time} label="Casting time" placeholder="1 action" maxLength={40} onCommit={(v) => set({ casting_time: v })} />
          </label>
          <label>
            Range
            <TextField value={spell.range} label="Range" placeholder="120 ft" maxLength={40} onCommit={(v) => set({ range: v })} />
          </label>
          <label>
            Components
            <TextField value={spell.components} label="Components" placeholder="V, S, M (a bit of bat fur)" maxLength={120} onCommit={(v) => set({ components: v })} />
          </label>
          <label>
            Duration
            <TextField value={spell.duration} label="Duration" placeholder="Instantaneous" maxLength={60} onCommit={(v) => set({ duration: v })} />
          </label>
          <label>
            Damage / healing dice
            <TextField value={spell.damage} label="Damage dice" placeholder="3d4+3" maxLength={60} onCommit={(v) => set({ damage: v })} />
          </label>
          <label>
            Saving throw
            <Select
              value={spell.save}
              label="Saving throw"
              options={[{ value: '' as const, label: 'None' }, ...ABILITIES.map((a) => ({ value: a, label: ABILITY_NAMES[a] }))]}
              onChange={(v) => set({ save: v })}
            />
          </label>
          <div className="sf-checks-row">
            <label className="sf-inline-check">
              <Check checked={spell.attack} label="Spell attack" onChange={(v) => set({ attack: v })} />
              Spell attack
            </label>
            <label className="sf-inline-check">
              <Check checked={spell.concentration} label="Concentration" onChange={(v) => set({ concentration: v })} />
              Concentration
            </label>
            <label className="sf-inline-check">
              <Check checked={spell.ritual} label="Ritual" onChange={(v) => set({ ritual: v })} />
              Ritual
            </label>
          </div>
          <label className="wide">
            Description
            <LongText value={spell.description} label="Spell description" placeholder={canEdit ? 'What it does…' : ''} maxLength={6000} onCommit={(v) => set({ description: v })} />
          </label>
        </div>
      )}
    </div>
  );
});

function SpellsTab() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const [expanded, toggle] = useExpanded();
  const numbers = spellNumbers(sheet);
  const byLevel = useMemo(() => {
    const groups = new Map<number, [string, Spell][]>();
    for (const entry of sorted(sheet.spells)) {
      const lvl = entry[1].level;
      groups.set(lvl, [...(groups.get(lvl) ?? []), entry]);
    }
    return groups;
  }, [sheet.spells]);
  const addSpell = (level: number) => {
    const id = newId();
    patch({
      spells: {
        [id]: {
          name: '',
          level,
          prepared: level > 0,
          school: '',
          casting_time: '1 action',
          range: '',
          components: '',
          duration: '',
          concentration: false,
          ritual: false,
          attack: false,
          save: '',
          damage: '',
          description: '',
          sort: nextSort(sheet.spells),
        },
      },
    });
    toggle(id);
  };
  const levels = [...new Set([...byLevel.keys(), ...Object.entries(sheet.spell_slots).filter(([, s]) => s.max > 0).map(([l]) => Number(l))])].sort((a, b) => a - b);
  return (
    <div className="sf-tab">
      <Section title="Spellcasting" icon={mdiMagicStaff}>
        <div className="sf-casting">
          <label>
            Ability
            <Select
              value={sheet.spellcasting_ability}
              label="Spellcasting ability"
              options={[{ value: '' as const, label: 'None' }, ...(['int', 'wis', 'cha'] as Ability[]).map((a) => ({ value: a, label: ABILITY_NAMES[a] }))]}
              onChange={(v) => patch({ spellcasting_ability: v })}
            />
          </label>
          <div className="sf-casting-stat">
            <span>Save DC</span>
            <b>{numbers ? numbers.dc : '—'}</b>
          </div>
          <div className="sf-casting-stat">
            <span>Spell attack</span>
            {numbers ? (
              <Rollable req={{ kind: 'spell_attack' }} label="a spell attack" className="sf-pill">
                {signed(numbers.attack)}
              </Rollable>
            ) : (
              <b>—</b>
            )}
          </div>
        </div>
        <div className="sf-slots">
          {Array.from({ length: 9 }, (_, i) => String(i + 1)).map((lvl) => {
            const slot = sheet.spell_slots[lvl] ?? { max: 0, used: 0 };
            if (!slot.max && !canEdit) return null;
            return (
              <div key={lvl} className={`sf-slot ${slot.max ? '' : 'unused'}`}>
                <span className="sf-slot-level">{lvl}</span>
                <div className="sf-slot-pips">
                  {Array.from({ length: slot.max }, (_, n) => (
                    <button
                      key={n}
                      type="button"
                      className={`sf-pip ${n < slot.max - slot.used ? 'on' : ''}`}
                      disabled={!canEdit}
                      aria-label={`Level ${lvl} slot ${n + 1}`}
                      onClick={() => {
                        const left = slot.max - slot.used;
                        patch({ spell_slots: { [lvl]: { used: slot.max - (n < left ? n : n + 1) } } });
                      }}
                    />
                  ))}
                </div>
                <NumField value={slot.max} label={`Level ${lvl} slots`} min={0} max={20} className="sf-slot-max" onCommit={(v) => patch({ spell_slots: { [lvl]: { max: v, used: Math.min(slot.used, v) } } })} />
              </div>
            );
          })}
        </div>
      </Section>
      {(levels.length ? levels : [0, 1]).map((lvl) => (
        <Section key={lvl} title={lvl === 0 ? 'Cantrips' : `Level ${lvl}`} actions={<AddButton label={lvl === 0 ? 'Add Cantrip' : 'Add Spell'} onClick={() => addSpell(lvl)} />}>
          {(byLevel.get(lvl) ?? []).length === 0 && <p className="sf-empty">None yet.</p>}
          {(byLevel.get(lvl) ?? []).map(([id, sp]) => (
            <SpellRow key={id} id={id} spell={sp} expanded={expanded.has(id)} onToggle={() => toggle(id)} />
          ))}
        </Section>
      ))}
      {canEdit && (
        <div className="sf-add-level">
          <span>Add a spell at level</span>
          {Array.from({ length: 10 }, (_, i) => i)
            .filter((l) => !levels.includes(l))
            .map((l) => (
              <button key={l} type="button" className="sf-chip" onClick={() => addSpell(l)}>
                {l === 0 ? 'Cantrip' : l}
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Inventory
// ---------------------------------------------------------------------------

const ItemRow = memo(function ItemRow({
  id,
  item,
  expanded,
  onToggle,
  drag,
}: {
  id: string;
  item: Item;
  expanded: boolean;
  onToggle: () => void;
  drag?: Record<string, unknown>;
}) {
  const { patch } = useSheetCtx();
  const set = (p: Partial<Item>) => patch({ inventory: { [id]: p } });
  return (
    <div className={`sf-row sf-item ${expanded ? 'expanded' : ''} ${item.equipped ? 'equipped' : ''}`} {...drag}>
      <div className="sf-row-main">
        {drag && <Icon path={mdiDragVertical} size={16} className="sf-drag" />}
        <button type="button" className="sf-expand" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={onToggle}>
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={16} />
        </button>
        <NumField value={item.qty} label="Quantity" min={0} max={1000000} className="sf-qty" onCommit={(v) => set({ qty: v })} />
        <TextField value={item.name} label="Item name" placeholder="Rope, hempen (50 feet)" className="sf-row-name" maxLength={120} onCommit={(v) => set({ name: v })} />
        <Check checked={item.equipped} label="Equipped" onChange={(v) => set({ equipped: v })} className="sf-equip" />
        <Check checked={item.attuned} label="Attuned" onChange={(v) => set({ attuned: v })} className="sf-attune" />
        <span className="sf-weight">
          <NumField value={item.weight} label="Weight (lb)" min={0} max={100000} onCommit={(v) => set({ weight: v })} />
          <span className="sf-muted">lb</span>
        </span>
        <RemoveButton label="Remove item" onClick={() => confirmRemove(item.name || 'this item', () => patch({ inventory: { [id]: null } }))} />
      </div>
      {expanded && (
        <div className="sf-row-details">
          <label>
            Value
            <TextField value={item.value} label="Value" placeholder="25 gp" maxLength={40} onCommit={(v) => set({ value: v })} />
          </label>
          <label className="wide">
            Description
            <LongText value={item.description} label="Item description" placeholder="Where you got it, what it does…" maxLength={4000} onCommit={(v) => set({ description: v })} />
          </label>
        </div>
      )}
    </div>
  );
});

function InventoryTab() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const [expanded, toggle] = useExpanded();
  const [dragId, setDragId] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const items = sorted(sheet.inventory);
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter(([, i]) => i.name.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : items;
  const weight = inventoryWeight(sheet);
  const capacity = (sheet.abilities.str ?? 10) * 15;
  const gold = goldValue(sheet);
  const drop = (targetId: string) => {
    if (!dragId || dragId === targetId) return;
    const ids = items.map(([id]) => id).filter((id) => id !== dragId);
    ids.splice(ids.indexOf(targetId), 0, dragId);
    const p: Patch = {};
    ids.forEach((id, i) => {
      if (sheet.inventory[id].sort !== i + 1) p[id] = { sort: i + 1 };
    });
    setDragId(null);
    if (Object.keys(p).length) patch({ inventory: p });
  };
  const addItem = () => {
    const id = newId();
    patch({ inventory: { [id]: { name: '', qty: 1, weight: 0, value: '', equipped: false, attuned: false, description: '', sort: nextSort(sheet.inventory) } } });
  };
  return (
    <div className="sf-tab">
      <Section title="Coin Purse" icon={mdiCash}>
        <div className="sf-coins">
          {CURRENCIES.map((c) => (
            <label key={c} className={`sf-coin ${c}`} {...tip(CURRENCY_NAMES[c])}>
              <span className="sf-coin-name">{c.toUpperCase()}</span>
              <NumField value={sheet.currency[c]} label={CURRENCY_NAMES[c]} min={0} max={1000000000} onCommit={(v) => patch({ currency: { [c]: v } })} />
            </label>
          ))}
          <div className="sf-gold-total" {...tip('Everything converted to gold')}>
            <span>Total</span>
            <b>{gold.toLocaleString(undefined, { maximumFractionDigits: 2 })} gp</b>
          </div>
        </div>
        {canEdit && <p className="sf-hint">Tip: type +25 or -10 in a coin box to add or spend.</p>}
      </Section>
      <Section
        title="Items"
        icon={mdiBagPersonalOutline}
        actions={
          <>
            {items.length > 6 && <input className="sf-filter" placeholder="Find an item" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Find an item" />}
            <AddButton label="Add Item" onClick={addItem} />
          </>
        }
      >
        {items.length > 0 && (
          <div className="sf-item-head">
            <span className="qty">Qty</span>
            <span className="name">Name</span>
            <span className="flag" {...tip('Equipped')}>E</span>
            <span className="flag" {...tip('Attuned')}>A</span>
            <span className="weight">Weight</span>
          </div>
        )}
        {items.length === 0 && <p className="sf-empty">The pack is empty.</p>}
        {shown.map(([id, item]) => (
          <ItemRow
            key={id}
            id={id}
            item={item}
            expanded={expanded.has(id)}
            onToggle={() => toggle(id)}
            drag={
              canEdit && !q
                ? {
                    draggable: true,
                    onDragStart: (e: React.DragEvent) => {
                      e.dataTransfer.effectAllowed = 'move';
                      setDragId(id);
                    },
                    onDragOver: (e: React.DragEvent) => e.preventDefault(),
                    onDrop: (e: React.DragEvent) => {
                      e.preventDefault();
                      drop(id);
                    },
                    onDragEnd: () => setDragId(null),
                  }
                : undefined
            }
          />
        ))}
        <div className={`sf-carry ${weight > capacity ? 'over' : ''}`}>
          Carrying {weight} lb of {capacity} lb
        </div>
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Features & Bio
// ---------------------------------------------------------------------------

const FeatureRow = memo(function FeatureRow({ id, feature, expanded, onToggle }: { id: string; feature: Feature; expanded: boolean; onToggle: () => void }) {
  const { patch } = useSheetCtx();
  const set = (p: Partial<Feature>) => patch({ features: { [id]: p } });
  return (
    <div className={`sf-row sf-feature ${expanded ? 'expanded' : ''}`}>
      <div className="sf-row-main">
        <button type="button" className="sf-expand" aria-label={expanded ? 'Collapse' : 'Expand'} onClick={onToggle}>
          <Icon path={expanded ? mdiChevronDown : mdiChevronRight} size={16} />
        </button>
        <TextField value={feature.name} label="Feature name" placeholder="Sneak Attack" className="sf-row-name" maxLength={120} onCommit={(v) => set({ name: v })} />
        <TextField value={feature.source} label="Source" placeholder="Rogue 1" className="sf-source" maxLength={60} onCommit={(v) => set({ source: v })} />
        <RemoveButton label="Remove feature" onClick={() => confirmRemove(feature.name || 'this feature', () => patch({ features: { [id]: null } }))} />
      </div>
      {(expanded || feature.description) && (
        <div className={`sf-row-details single ${expanded ? '' : 'preview'}`} onClick={() => !expanded && onToggle()}>
          <LongText value={feature.description} label="Feature description" placeholder="What it does…" maxLength={8000} onCommit={(v) => set({ description: v })} />
        </div>
      )}
    </div>
  );
});

function FeaturesTab() {
  const { sheet, patch } = useSheetCtx();
  const [expanded, toggle] = useExpanded();
  const features = sorted(sheet.features);
  const prof = sheet.proficiencies;
  return (
    <div className="sf-tab">
      <Section
        title="Features & Traits"
        icon={mdiStar}
        actions={
          <AddButton
            label="Add Feature"
            onClick={() => {
              const id = newId();
              patch({ features: { [id]: { name: '', source: '', description: '', sort: nextSort(sheet.features) } } });
              toggle(id);
            }}
          />
        }
      >
        {features.length === 0 && <p className="sf-empty">Class features, racial traits and feats go here.</p>}
        {features.map(([id, f]) => (
          <FeatureRow key={id} id={id} feature={f} expanded={expanded.has(id)} onToggle={() => toggle(id)} />
        ))}
      </Section>
      <Section title="Proficiencies & Languages" icon={mdiBookOpenPageVariant}>
        <div className="sf-prof-grid">
          {(
            [
              ['armor', 'Armor', 'Light, medium, shields'],
              ['weapons', 'Weapons', 'Simple, martial'],
              ['tools', 'Tools', "Thieves' tools, lute"],
              ['languages', 'Languages', 'Common, Elvish'],
            ] as const
          ).map(([key, label, ph]) => (
            <label key={key}>
              {label}
              <LongText value={prof[key]} label={label} placeholder={ph} maxLength={400} serif={false} onCommit={(v) => patch({ proficiencies: { [key]: v } })} />
            </label>
          ))}
        </div>
      </Section>
    </div>
  );
}

function ClassesEditor() {
  const { sheet, patch, canEdit } = useSheetCtx();
  const classes = sorted(sheet.classes);
  return (
    <div className="sf-classes">
      {classes.map(([id, c]) => (
        <div key={id} className="sf-class">
          <TextField value={c.name} label="Class" placeholder="Wizard" className="sf-class-name" maxLength={40} onCommit={(v) => patch({ classes: { [id]: { name: v } } })} />
          <TextField value={c.subclass} label="Subclass" placeholder="Subclass" className="sf-class-sub" maxLength={60} onCommit={(v) => patch({ classes: { [id]: { subclass: v } } })} />
          <label className="sf-class-level">
            Lv
            <NumField value={c.level} label="Class level" min={1} max={20} onCommit={(v) => patch({ classes: { [id]: { level: v } } })} />
          </label>
          <Select
            value={String(c.hit_die)}
            label="Hit die"
            className="sf-class-die"
            options={['6', '8', '10', '12'].map((d) => ({ value: d, label: `d${d}` }))}
            onChange={(v) => patch({ classes: { [id]: { hit_die: Number(v) } } })}
          />
          <RemoveButton label="Remove class" onClick={() => patch({ classes: { [id]: null } })} />
        </div>
      ))}
      {canEdit && (
        <AddButton
          label={classes.length ? 'Add Multiclass' : 'Add Class'}
          onClick={() => patch({ classes: { [newId()]: { name: '', subclass: '', level: 1, hit_die: 8, sort: nextSort(sheet.classes) } } })}
        />
      )}
      {!classes.length && !canEdit && <span className="sf-muted">No class set.</span>}
    </div>
  );
}

function BioTab() {
  const { sheet, patch } = useSheetCtx();
  const level = totalLevel(sheet);
  const next = XP_LEVELS[Math.min(level, XP_LEVELS.length - 1)];
  const prev = XP_LEVELS[level - 1] ?? 0;
  const pct = level >= 20 ? 100 : Math.max(0, Math.min(100, ((sheet.xp - prev) / Math.max(1, next - prev)) * 100));
  const d = sheet.details;
  return (
    <div className="sf-tab">
      <Section title="Identity">
        <div className="sf-identity-grid">
          <label>
            Species
            <TextField value={sheet.species} label="Species" placeholder="Half-Elf" maxLength={60} onCommit={(v) => patch({ species: v })} />
          </label>
          <label>
            Background
            <TextField value={sheet.background} label="Background" placeholder="Criminal" maxLength={60} onCommit={(v) => patch({ background: v })} />
          </label>
          <label>
            Alignment
            <Select
              value={sheet.alignment}
              label="Alignment"
              options={[{ value: '', label: 'Unknown' }, ...ALIGNMENTS.map((a) => ({ value: a.key, label: a.name })), { value: 'U', label: 'Unaligned' }]}
              onChange={(v) => patch({ alignment: v })}
            />
          </label>
          <label>
            Experience
            <span className="sf-xp">
              <NumField value={sheet.xp} label="Experience points" min={0} max={10000000} onCommit={(v) => patch({ xp: v })} />
              <span className="sf-muted">{level >= 20 ? 'max level' : `/ ${next.toLocaleString()} XP`}</span>
            </span>
            <span className="sf-xp-bar">
              <span style={{ width: `${pct}%` }} />
            </span>
          </label>
        </div>
        <div className="sf-subhead">Classes</div>
        <ClassesEditor />
      </Section>
      <Section title="Details">
        <div className="sf-details-grid">
          {(
            [
              ['pronouns', 'Pronouns'],
              ['age', 'Age'],
              ['height', 'Height'],
              ['weight', 'Weight'],
              ['eyes', 'Eyes'],
              ['hair', 'Hair'],
              ['skin', 'Skin'],
              ['faith', 'Faith'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <TextField value={d[key]} label={label} maxLength={60} onCommit={(v) => patch({ details: { [key]: v } })} />
            </label>
          ))}
        </div>
      </Section>
      <Section title="Personality">
        <div className="sf-personality">
          {(
            [
              ['traits', 'Personality Traits'],
              ['ideals', 'Ideals'],
              ['bonds', 'Bonds'],
              ['flaws', 'Flaws'],
            ] as const
          ).map(([key, label]) => (
            <label key={key}>
              {label}
              <LongText value={sheet.personality[key]} label={label} maxLength={2000} onCommit={(v) => patch({ personality: { [key]: v } })} />
            </label>
          ))}
        </div>
      </Section>
      <Section title="Appearance">
        <LongText value={sheet.appearance} label="Appearance" placeholder="Tall, scarred, always wearing the same green cloak…" maxLength={8000} onCommit={(v) => patch({ appearance: v })} />
      </Section>
      <Section title="Backstory">
        <LongText value={sheet.backstory} label="Backstory" placeholder="Where they came from, and why they're here." maxLength={20000} onCommit={(v) => patch({ backstory: v })} />
      </Section>
      <Section title="Notes & Lore">
        <LongText value={sheet.notes} label="Notes and lore" placeholder="Names, places, secrets, debts owed…" maxLength={20000} onCommit={(v) => patch({ notes: v })} />
      </Section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// The drawer
// ---------------------------------------------------------------------------

function SheetDrawer({ characterId, serverId, initialTab }: { characterId: number; serverId: number | null; initialTab?: string }) {
  const character = useStore((s) => s.characters[characterId]);
  const { entry, error } = useSheet(characterId);
  const [tab, setTab] = useState<TabKey>(() => (TABS.some((t) => t.key === initialTab) ? (initialTab as TabKey) : 'main'));
  const [mode, setMode] = useState<RollMode>({ adv: null, private: false });
  const saving = useStore(() => sheetSaving(characterId));
  const drawer = useRef<HTMLElement>(null);

  useEffect(() => {
    drawer.current?.focus();
  }, [characterId]);

  const ctx = useMemo<SheetCtx | null>(() => {
    if (!entry) return null;
    const rollIt: SheetCtx['rollIt'] = (req, opts) => {
      const channelId = rollTargetChannel(serverId);
      if (channelId === null) {
        toast('Open a text channel to roll in.');
        return;
      }
      const adv = opts?.adv !== undefined ? opts.adv : mode.adv;
      void roll(channelId, {
        ...req,
        characterId,
        adv: D20_KINDS.has(req.kind) ? adv : null,
        private: (opts?.private ?? mode.private) && canRollPrivately(channelId),
      });
    };
    return {
      characterId,
      sheet: entry.sheet,
      canEdit: entry.canEdit,
      patch: (p) => patchSheet(characterId, p),
      rollIt,
      rollMenu: (e, req) =>
        openContextMenu(e, () => (
          <>
            <MenuItem label="Roll" onClick={() => rollIt(req, { adv: null })} />
            {D20_KINDS.has(req.kind) && (
              <>
                <MenuItem label="Roll with Advantage" onClick={() => rollIt(req, { adv: 'adv' })} />
                <MenuItem label="Roll with Disadvantage" onClick={() => rollIt(req, { adv: 'dis' })} />
              </>
            )}
            {serverId !== null && (
              <>
                <MenuSeparator />
                <MenuItem label="Roll Privately" hint="DMs only" onClick={() => rollIt(req, { private: true })} />
              </>
            )}
          </>
        )),
    };
  }, [entry, characterId, serverId, mode]);

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'Escape') return;
    const s = getState();
    if (s.modals.length || s.contextMenu) return;
    const t = e.target as HTMLElement;
    if (t.matches('input, textarea, select') && t !== drawer.current) {
      t.blur();
      return;
    }
    closeSheet();
  };

  const accent = character?.color ?? 'var(--gold)';
  return (
    <aside ref={drawer} className="sheet-layer" role="dialog" aria-label={`${character?.name ?? 'Character'} character sheet`} tabIndex={-1} onKeyDown={onKeyDown} style={{ '--sheet-accent': accent } as CSSProperties}>
      {!character || character.deleted ? (
        <div className="sf-state">
          <h3>{character?.deleted ? 'This character was deleted' : 'Character not found'}</h3>
          <Button onClick={closeSheet}>Close</Button>
        </div>
      ) : error ? (
        <div className="sf-state">
          <Icon path={mdiLock} size={40} />
          <h3>You can't see this sheet</h3>
          <p>{error.includes('not found') || error.includes('find') ? 'It may be private. Only the player and the Dungeon Masters can open private sheets.' : error}</p>
          <Button onClick={closeSheet}>Close</Button>
        </div>
      ) : !ctx ? (
        <div className="sf-state">
          <Spinner />
        </div>
      ) : (
        <Ctx.Provider value={ctx}>
          <Header character={character} mode={mode} setMode={setMode} serverId={serverId} saving={saving} />
          <nav className="sf-tabs" role="tablist">
            {TABS.map((t) => (
              <button key={t.key} role="tab" aria-selected={tab === t.key} className={tab === t.key ? 'active' : ''} onClick={() => setTab(t.key)}>
                <Icon path={t.icon} size={15} />
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
          <div className="sf-body scroller-thin" role="tabpanel">
            {tab === 'main' && <MainTab />}
            {tab === 'actions' && <ActionsTab />}
            {tab === 'spells' && <SpellsTab />}
            {tab === 'inventory' && <InventoryTab />}
            {tab === 'features' && <FeaturesTab />}
            {tab === 'bio' && <BioTab />}
          </div>
          {!ctx.canEdit && <div className="sf-readonly-note">You're viewing this sheet. Only the player and the Dungeon Masters can change it.</div>}
        </Ctx.Provider>
      )}
    </aside>
  );
}

/** The character sheet drawer on the right; open it with openSheet(characterId, serverId). */
export default function SheetLayer() {
  const view = useStore((s) => s.sheetView);
  if (!view) return null;
  return <SheetDrawer key={view.characterId} characterId={view.characterId} serverId={view.serverId} initialTab={view.tab} />;
}
