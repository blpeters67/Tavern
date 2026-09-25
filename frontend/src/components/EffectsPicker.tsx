/**
 * The text effects library, opened from the sparkle "T" in the formatting
 * bar. Every tile shows its effect live; entrances replay every few seconds.
 */
import { useEffect, useMemo, useState } from 'react';
import { parseMarkdown, renderNodes, type MarkdownContext } from '../lib/markdown';
import { EFFECTS, FX_GROUPS, FX_BY_ID, type FxDef } from '../lib/textEffects';
import { TextFxIcon } from './icons';
import { Button } from './ui';

const PREVIEW_CTX: MarkdownContext = { fxPreview: true };

/** Sample text for a tile: the effect's own name, or something that shows it off better. */
const SAMPLES: Record<string, string> = {
  mock: 'Mocking',
  uwu: 'Hello there',
  leet: 'Leet speak',
  hearts: 'Lovestruck',
  censor: 'Censored',
  runes: 'Runes',
  redacted: 'Redacted',
};

function Sample({ fx, replay }: { fx: FxDef; replay: number }) {
  const text = SAMPLES[fx.id] ?? fx.label;
  const nodes = useMemo(() => parseMarkdown(`[${text}]{${fx.id}}`), [text, fx.id]);
  return <span key={replay}>{renderNodes(nodes, PREVIEW_CTX, `fxp-${fx.id}-`)}</span>;
}

export default function EffectsPicker({ active, onToggle, onClear }: { active: string[]; onToggle: (id: string) => void; onClear: () => void }) {
  const [hover, setHover] = useState<FxDef | null>(null);
  const [replay, setReplay] = useState(0);
  // Entrances only play once; replay them so the tiles keep showing what they do.
  useEffect(() => {
    const t = window.setInterval(() => setReplay((r) => r + 1), 3200);
    return () => window.clearInterval(t);
  }, []);
  const shown = hover ?? (active.length ? FX_BY_ID[active[active.length - 1]] : null);
  return (
    <div className="fxp" role="dialog" aria-label="Text effects">
      <div className="fxp-head">
        <TextFxIcon size={20} />
        <span className="fxp-title">Text Effects</span>
        <span className="fxp-hint">Select some text first, or pick one and start typing.</span>
      </div>
      <div className="fxp-body scroller-thin">
        {FX_GROUPS.map((g) => (
          <section key={g.id} className="fxp-group">
            <h4 className="fxp-group-title">{g.label}</h4>
            <div className="fxp-grid">
              {EFFECTS.filter((e) => e.group === g.id).map((e) => (
                <button
                  key={e.id}
                  type="button"
                  className={`fxp-tile ${active.includes(e.id) ? 'on' : ''}`}
                  aria-pressed={active.includes(e.id)}
                  aria-label={`${e.label}: ${e.desc}`}
                  onMouseDown={(ev) => ev.preventDefault()}
                  onMouseEnter={() => setHover(e)}
                  onMouseLeave={() => setHover(null)}
                  onFocus={() => setHover(e)}
                  onClick={() => onToggle(e.id)}
                >
                  <Sample fx={e} replay={e.group === 'entrance' ? replay : 0} />
                </button>
              ))}
            </div>
          </section>
        ))}
      </div>
      <div className="fxp-foot">
        <span className="fxp-desc">
          {shown ? (
            <>
              <strong>{shown.label}.</strong> {shown.desc}
            </>
          ) : (
            'Mix one effect from each group, like Wave + Fire.'
          )}
        </span>
        <Button size="small" look="secondary" onMouseDown={(ev) => ev.preventDefault()} onClick={onClear} disabled={!active.length}>
          Clear Effects
        </Button>
      </div>
    </div>
  );
}
