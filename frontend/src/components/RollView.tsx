import { memo, useEffect, useMemo, useState, type ReactElement } from 'react';
import { claimRollAnimation } from '../lib/rolls';
import { playSound } from '../lib/sounds';
import { displayName } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { DieRoll, Message, RollData, RollPart, RollTerm } from '../store/types';
import { Icon, mdiEyeOff } from './icons';
import { tip } from './layers';

// ---------------------------------------------------------------------------
// Die shapes: flat outlines you'd recognize at a glance.
// ---------------------------------------------------------------------------

function pentagon(cx: number, cy: number, r: number): string {
  return [0, 1, 2, 3, 4]
    .map((i) => {
      const a = ((-90 + i * 72) * Math.PI) / 180;
      return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`;
    })
    .join(' ');
}

const SHAPES: Record<number, { outline: ReactElement; facets?: ReactElement; textY: number; size?: number }> = {
  4: { outline: <polygon points="20,3 37.5,34.5 2.5,34.5" />, textY: 27.5, size: 12 },
  6: { outline: <rect x="5" y="5" width="30" height="30" rx="4" />, textY: 20.5 },
  8: {
    outline: <polygon points="20,1.5 37,20 20,38.5 3,20" />,
    facets: <polyline points="3,20 37,20" />,
    textY: 16.5,
    size: 12,
  },
  10: {
    outline: <polygon points="20,1.5 37.5,17 20,38.5 2.5,17" />,
    facets: <polyline points="2.5,17 20,24 37.5,17" />,
    textY: 17.5,
    size: 12,
  },
  12: {
    outline: <polygon points={pentagon(20, 21, 18.5)} />,
    facets: <polygon points={pentagon(20, 21.5, 9.5)} />,
    textY: 22,
    size: 12,
  },
  20: {
    outline: <polygon points="20,1.5 36.5,11 36.5,29 20,38.5 3.5,29 3.5,11" />,
    facets: <polygon points="20,9 30.5,27 9.5,27" />,
    textY: 22.5,
    size: 11.5,
  },
};

export function DieShape({ sides, value, className }: { sides: number; value?: number | string; className?: string }) {
  const key = sides === 100 ? 10 : sides;
  const shape = SHAPES[key];
  const label = value === undefined ? (sides === 100 ? '%' : `d${sides}`) : String(value);
  const long = label.length >= 3;
  return (
    <svg className={`die-shape d${sides} ${className ?? ''}`} viewBox="0 0 40 40" aria-hidden>
      <g className="die-body">{shape ? shape.outline : <circle cx="20" cy="20" r="17.5" />}</g>
      {shape?.facets && <g className="die-facets">{shape.facets}</g>}
      <text x="20" y={shape?.textY ?? 21} className="die-value" style={{ fontSize: long ? 10 : (shape?.size ?? 13) }}>
        {label}
      </text>
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Roll card
// ---------------------------------------------------------------------------

interface FlatDie {
  sides: number;
  roll: DieRoll;
  index: number;
}

function flatten(part: RollPart): FlatDie[] {
  const out: FlatDie[] = [];
  for (const t of part.terms) if (t.kind === 'dice') for (const r of t.rolls) out.push({ sides: t.sides, roll: r, index: out.length });
  return out;
}

/** Indexes of the lone counted die of a term (a kh1/kl1 roll): the one that was
 * kept when two dice were rolled and the other crossed out. */
function keptDice(part: RollPart): Set<number> {
  const kept = new Set<number>();
  let i = 0;
  for (const t of part.terms) {
    if (t.kind !== 'dice') continue;
    const winners = t.rolls.map((r, k) => ({ r, k })).filter((x) => !x.r.drop);
    if (t.rolls.length > 1 && winners.length === 1) kept.add(i + winners[0].k);
    i += t.rolls.length;
  }
  return kept;
}

function termText(t: RollTerm, first: boolean): string {
  const sign = t.sign < 0 ? '−' : '+';
  const body = t.kind === 'dice' ? `${t.count}d${t.sides === 100 ? '%' : t.sides}` : String(t.value);
  return first ? (t.sign < 0 ? `${sign}${body}` : body) : ` ${sign} ${body}`;
}

/** "2d20kh1+10" -> "2d20kh1 + 10" */
function prettyExpression(expr: string): string {
  return (expr || '').replace(/\s+/g, '').replace(/(?<=[\dA-Za-z%)!])([+\-])/g, ' $1 ').replace(/-/g, '−');
}

const isNotation = (title: string) => /^\d*d(\d+|%)/i.test(title.trim());

const MAX_SHOWN = 24;
const TICK_MS = 70;
const reduceMotion = () => typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function landAt(i: number): number {
  return Math.min(650 + i * 55, 1150);
}

function Part({ part, multi, elapsed, animating, expanded, onExpand, adv }: { part: RollPart; multi: boolean; elapsed: number; animating: boolean; expanded: boolean; onExpand: () => void; adv: 'adv' | 'dis' | null }) {
  const dice = useMemo(() => flatten(part), [part]);
  const kept = useMemo(() => keptDice(part), [part]);
  const shown = expanded ? dice : dice.slice(0, MAX_SHOWN);
  const hidden = dice.length - shown.length;
  const done = !animating || elapsed >= landAt(Math.min(dice.length, MAX_SHOWN) - 1);
  const math = prettyExpression(part.expression) || part.terms.map((t, i) => termText(t, i === 0)).join('');
  const d20 = part.d20 ?? null;
  return (
    <div className={`roll-part ${part.crit ? 'crit' : ''} ${part.fumble ? 'fumble' : ''}`}>
      {multi && (
        <div className="roll-part-label">
          {part.label}
          {part.crit_damage && <span className="roll-part-flag">Critical</span>}
        </div>
      )}
      <div className="roll-part-row">
        <div className="roll-dice">
          {shown.map((d) => {
            const landed = !animating || elapsed >= landAt(d.index);
            const face = landed ? d.roll.v : 1 + ((Math.floor(elapsed / TICK_MS) * 7919 + d.index * 104729 + d.sides * 31) % d.sides);
            const nat = landed && d.sides === 20 && d20 !== null && !d.roll.drop ? (d.roll.v === 20 ? 'nat20' : d.roll.v === 1 ? 'nat1' : '') : '';
            const counted = landed && !d.roll.drop && kept.has(d.index);
            const dieTip = !landed ? undefined
              : d.roll.drop ? (adv === 'adv' ? 'Dropped: the lower roll' : adv === 'dis' ? 'Dropped: the higher roll' : 'Dropped')
              : counted ? (adv === 'adv' ? 'Counted: the higher roll' : adv === 'dis' ? 'Counted: the lower roll' : 'Counted')
              : d.roll.exp ? 'Exploded: rolled again' : undefined;
            return (
              <span
                key={d.index}
                className={`roll-die ${landed ? 'landed' : 'tumbling'} ${d.roll.drop && landed ? 'dropped' : ''} ${counted ? 'kept' : ''} ${d.roll.exp && landed ? 'exploded' : ''} ${nat}`}
                style={animating ? { animationDelay: `${(d.index % 5) * -90}ms` } : undefined}
                {...(dieTip ? tip(dieTip) : {})}
              >
                <DieShape sides={d.sides} value={face} />
              </span>
            );
          })}
          {hidden > 0 && (
            <button className="roll-more" onClick={onExpand}>
              +{hidden} more
            </button>
          )}
        </div>
        <div className="roll-math" title={part.expression}>
          {math}
        </div>
        <div className={`roll-total ${done ? 'shown' : ''}`} aria-label={`Total ${part.total}`}>
          <span className="roll-total-final">{part.total}</span>
          {!done && <span className="roll-total-rolling">?</span>}
        </div>
      </div>
      {(part.crit || part.fumble || part.note) && (
        <div className={`roll-note reveal ${done ? 'shown' : ''}`}>
          {part.crit && <span className="roll-flag crit">Natural 20</span>}
          {part.fumble && <span className="roll-flag fumble">Natural 1</span>}
          {part.note && <span>{part.note}</span>}
        </div>
      )}
    </div>
  );
}

function titleDie(roll: RollData): number {
  const first = roll.parts[0]?.terms.find((t) => t.kind === 'dice');
  return first && first.kind === 'dice' ? first.sides : 20;
}

/** The body of a ROLL message: dice that tumble when the roll arrives live. */
const RollView = memo(function RollView({ message }: { message: Message }) {
  const roll = message.meta?.roll as RollData | undefined;
  const settings = useStore((s) => s.me!.settings);
  const [animating] = useState(() => !!roll && claimRollAnimation(message.id) && settings.dice_animations && !reduceMotion());
  const [elapsed, setElapsed] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const total = useMemo(() => (roll ? Math.max(...roll.parts.map((p) => landAt(Math.min(flatten(p).length, MAX_SHOWN) - 1))) : 0), [roll]);
  const running = animating && elapsed < total;

  useEffect(() => {
    if (!animating) return;
    if (getState().me?.settings.dice_sounds) playSound('dice');
    const start = performance.now();
    const t = window.setInterval(() => {
      const e = performance.now() - start;
      setElapsed(e);
      if (e >= total) window.clearInterval(t);
    }, TICK_MS);
    return () => window.clearInterval(t);
  }, [animating, total]);

  const roller = useStore((s) => (roll && roll.rolled_by !== roll.for_user_id ? s.users[roll.rolled_by] : undefined));
  const forUser = useStore((s) => (roll && roll.rolled_by !== roll.for_user_id ? s.users[roll.for_user_id] : undefined));

  if (!roll) return <div className="message-body markup">{message.content}</div>;
  const outcome = roll.outcome;
  const anyCrit = roll.parts.some((p) => p.crit);
  const anyFumble = roll.parts.some((p) => p.fumble);
  const landed = !running;

  return (
    <div
      className={`roll-card ${landed && outcome ? outcome : ''} ${landed && anyCrit ? 'crit' : ''} ${landed && anyFumble ? 'fumble' : ''} ${running ? 'rolling' : ''} ${
        animating ? 'live' : ''
      }`}
      role="group"
      aria-label={`${roll.title}: ${roll.parts.map((p) => `${p.label} ${p.total}`).join(', ')}${outcome ? `, ${outcome}` : ''}`}
    >
      <div className="roll-head">
        <DieShape sides={titleDie(roll)} className="roll-head-die" />
        <span className={`roll-title ${isNotation(roll.title) ? 'notation' : ''}`}>{isNotation(roll.title) ? prettyExpression(roll.title) : roll.title}</span>
        {roll.adv && <span className={`roll-tag ${roll.adv}`}>{roll.adv === 'adv' ? 'Advantage' : 'Disadvantage'}</span>}
        {roll.private && (
          <span className="roll-tag private" {...tip('Only the roller and the Dungeon Masters can see this roll')}>
            <Icon path={mdiEyeOff} size={12} /> Private
          </span>
        )}
      </div>
      {roll.parts.map((p, i) => (
        <Part key={i} part={p} multi={roll.parts.length > 1} elapsed={elapsed} animating={animating} expanded={expanded} onExpand={() => setExpanded(true)} adv={roll.adv ?? null} />
      ))}
      {roll.dc !== undefined && outcome && (
        <div className={`roll-outcome reveal ${landed ? 'shown' : ''}`}>
          <span className="roll-dc">DC {roll.dc}</span>
          <span className={`roll-result ${outcome}`}>{outcome === 'success' ? 'Success' : 'Failure'}</span>
          {roll.flavor && <span className="roll-flavor">{roll.flavor}</span>}
        </div>
      )}
      {roller && (
        <div className="roll-by">
          Rolled by {displayName(roller)}
          {forUser ? ` for ${displayName(forUser)}` : ''}
        </div>
      )}
    </div>
  );
});

export default RollView;
