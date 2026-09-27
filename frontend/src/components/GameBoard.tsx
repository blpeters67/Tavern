/** The game board: a shared battle map everyone looks at together, like the
 * theater but for the table. A saved board per server with a background
 * picture, a grid, character tokens (green allies, grey neutrals, red
 * enemies), and a chat column beside it. */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, errorMessage, upload } from '../api/http';
import { gateway } from '../api/gateway';
import { characterAvatar, userAvatar } from '../lib/avatars';
import { on } from '../lib/events';
import { useCollapsed } from '../lib/panelPrefs';
import { closeBoard, openBoard, openContextMenu, openModal, openSheet } from '../store/actions';
import { canControlBoard, displayName, myCharacters } from '../store/selectors';
import { getState, useStore } from '../store/store';
import { claimRollAnimation, roll as requestRoll } from '../lib/rolls';
import type { Board, BoardDrawing, BoardToken, Channel, Character, Disposition, ServerBoard } from '../store/types';
import { MessageType, ChannelType } from '../store/types';
import {
  Icon,
  mdiAccountPlus,
  mdiArrowExpand,
  mdiArrowTopRight,
  mdiChevronDown,
  mdiClose,
  mdiCursorDefault,
  mdiDeleteSweepOutline,
  mdiDiceD10,
  mdiDiceD12,
  mdiDiceD20,
  mdiDiceD4,
  mdiDiceD6,
  mdiDiceD8,
  mdiDiceMultiple,
  mdiDraw,
  mdiCircleOutline,
  mdiFormatText,
  mdiImage,
  mdiMagnet,
  mdiMinus,
  mdiPencil,
  mdiPlus,
  mdiPound,
  mdiRectangleOutline,
  mdiRedo,
  mdiRuler,
  mdiTrashCanOutline,
  mdiUndo,
  mdiVectorLine,
  mdiViewGrid,
} from './icons';
import { CardEye } from './Jukebox';
import { MenuItem, Modal, tip } from './layers';
import { toast } from './Toasts';
import { Avatar, Button, Field, TextInput } from './ui';
import { BoardDiceOverlay, type BoardRoll } from './BoardDice';

const DEFAULT_W = 1600;
const DEFAULT_H = 1200;

const dispositionLabel: Record<Disposition, string> = { ally: 'Ally', neutral: 'Neutral', enemy: 'Enemy' };

function worldSize(board: Board | null): { w: number; h: number } {
  return { w: board?.bg_width || DEFAULT_W, h: board?.bg_height || DEFAULT_H };
}

/** Where a token's middle lands with snapping on (the middle of a square). */
function snapPoint(board: Board | null, x: number, y: number): { x: number; y: number } {
  if (!board?.snap) return { x, y };
  const g = board.grid_size;
  return { x: (Math.floor(x / g) + 0.5) * g, y: (Math.floor(y / g) + 0.5) * g };
}

function tokenImage(t: BoardToken, characters: Record<number, Character | undefined>): string | null {
  if (t.character_id !== null) {
    const ch = characters[t.character_id];
    return ch ? characterAvatar(ch) : null;
  }
  return t.avatar ? `/cdn/boards/${t.board_id}/${t.avatar}` : null;
}

const r1 = (n: number) => Math.round(n * 10) / 10;

/** What the drawing tools paint with; the first one is the default. */
const DRAW_COLORS = ['#e5484d', '#f2f4f8', '#e0b252', '#83c5ff', '#3dd68c'];

/** The dice the board can roll, with the matching icons. */
const DICE_SIDES = [4, 6, 8, 10, 12, 20] as const;
const DICE_ICONS: Record<number, string> = { 4: mdiDiceD4, 6: mdiDiceD6, 8: mdiDiceD8, 10: mdiDiceD10, 12: mdiDiceD12, 20: mdiDiceD20 };

// ---------------------------------------------------------------------------
// The card in the right-hand panel
// ---------------------------------------------------------------------------

export function BoardCard({ serverId }: { serverId: number }) {
  const collapsed = useCollapsed('board');
  const sb = useStore((s) => s.board[serverId]);
  if (!sb) return null;
  return collapsed ? <CollapsedBoard serverId={serverId} sb={sb} /> : <FullBoardCard serverId={serverId} sb={sb} />;
}

function MiniPreview({ board, className }: { board: Board; className?: string }) {
  const { w, h } = worldSize(board);
  return (
    <div className={`board-mini ${className ?? ''}`} style={{ aspectRatio: `${w} / ${h}` }}>
      {board.background_url ? <img src={board.background_url} alt="" loading="lazy" draggable={false} /> : <div className="board-mini-plain" />}
      <div className="board-mini-grid" style={{ backgroundSize: `${(board.grid_size / w) * 100}% ${(board.grid_size / h) * 100}%` }} />
      {board.tokens.map((t) => (
        <span
          key={t.id}
          className={`board-mini-token ${t.disposition}`}
          style={{ left: `${(t.x / w) * 100}%`, top: `${(t.y / h) * 100}%`, width: `${Math.max(2.5, (t.size * board.grid_size * 100) / w)}%` }}
        />
      ))}
    </div>
  );
}

function CollapsedBoard({ serverId, sb }: { serverId: number; sb: ServerBoard }) {
  return (
    <section className="jukebox-card board-card collapsed" aria-label="Game Board">
      <header className="jb-header">
        <Icon path={mdiViewGrid} size={18} className="jb-header-icon" />
        <span className="jb-title">Game Board</span>
        <button className="jb-queue-link" onClick={() => openBoard(serverId)}>
          Open
        </button>
        <CardEye name="board" label="game board" />
      </header>
      <div className="card-mini">
        {sb.board ? (
          <>
            <MiniPreview board={sb.board} className="board-mini-thumb" />
            <div className="card-mini-text">
              <div className="card-mini-title" title={sb.board.name}>
                {sb.board.name}
              </div>
              <div className="card-mini-sub">
                {sb.board.tokens.length} token{sb.board.tokens.length === 1 ? '' : 's'}
              </div>
            </div>
          </>
        ) : (
          <span className="card-mini-quiet">No board yet.</span>
        )}
        <button className="jb-btn card-mini-btn" aria-label="Open the game board" onClick={() => openBoard(serverId)} {...tip('Open the game board')}>
          <Icon path={mdiArrowExpand} size={18} />
        </button>
      </div>
    </section>
  );
}

function FullBoardCard({ serverId, sb }: { serverId: number; sb: ServerBoard }) {
  const canControl = useStore((s) => canControlBoard(s, serverId));
  const viewers = sb.viewers;
  const users = useStore((s) => s.users);
  return (
    <section className="jukebox-card board-card" aria-label="Game Board">
      <header className="jb-header">
        <Icon path={mdiViewGrid} size={20} className="jb-header-icon" />
        <span className="jb-title" {...tip('Everyone sees the same board at the same time')}>
          Game Board
        </span>
        <CardEye name="board" label="game board" />
      </header>
      {sb.board ? (
        <>
          <MiniPreview board={sb.board} />
          <div className="board-card-row">
            <span className="board-card-name" title={sb.board.name}>
              {sb.board.name}
            </span>
            <span className="board-card-sub">
              {sb.board.tokens.length} token{sb.board.tokens.length === 1 ? '' : 's'}
            </span>
          </div>
          {viewers.length > 0 && (
            <div className="board-card-viewers">
              {viewers.map((id) => (users[id] ? <Avatar key={id} src={userAvatar(users[id])} size={20} {...tip(`${displayName(users[id])} has the board open`)} /> : null))}
              <span className="board-card-sub">{viewers.length === 1 ? '1 has it open' : `${viewers.length} have it open`}</span>
            </div>
          )}
          <div className="board-card-actions">
            <Button size="small" onClick={() => openBoard(serverId)}>
              Open Board
            </Button>
            {canControl && (
              <Button size="small" look="secondary" onClick={() => openModal((close) => <NameBoardModal serverId={serverId} onClose={close} />)}>
                <Icon path={mdiPlus} size={15} /> New Board
              </Button>
            )}
          </div>
        </>
      ) : (
        <div className="jb-empty">
          <Icon path={mdiViewGrid} size={28} />
          <p>No game board yet.{canControl ? ' Make the first one — a picture and a grid are all it needs.' : ''}</p>
          {canControl && (
            <Button size="small" look="outline" onClick={() => openModal((close) => <NameBoardModal serverId={serverId} onClose={close} />)}>
              Create Board
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Small modals
// ---------------------------------------------------------------------------

function NameBoardModal({ serverId, board, onClose }: { serverId: number; board?: Board; onClose: () => void }) {
  const [name, setName] = useState(board?.name ?? '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!name.trim() || saving) return;
    setSaving(true);
    try {
      if (board) await api.patch(`/api/servers/${serverId}/board/boards/${board.id}`, { name });
      else await api.post(`/api/servers/${serverId}/board/boards`, { name });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title={board ? 'Rename Board' : 'New Board'}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!name.trim()}>
            {board ? 'Save' : 'Create'}
          </Button>
        </>
      }
    >
      <Field label="Name" hint="Like Goblin Ambush or The Sunken Temple">
        <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} autoFocus />
      </Field>
    </Modal>
  );
}

function GridModal({ serverId, board, onClose }: { serverId: number; board: Board; onClose: () => void }) {
  const [size, setSize] = useState(String(board.grid_size));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const n = Math.round(Number(size));
    if (!Number.isFinite(n) || n < 20 || n > 400) {
      toast('Grid size runs from 20 to 400.');
      return;
    }
    setSaving(true);
    try {
      await api.patch(`/api/servers/${serverId}/board/boards/${board.id}`, { grid_size: n });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Grid Size"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <Field label="One square is this many pixels" hint="20–400. Tokens snap to square middles.">
        <TextInput value={size} onChange={(e) => setSize(e.target.value)} inputMode="numeric" autoFocus />
      </Field>
    </Modal>
  );
}

function HpModal({ serverId, board, token, onClose }: { serverId: number; board: Board; token: BoardToken; onClose: () => void }) {
  const [hp, setHp] = useState(token.hp ? String(token.hp.current) : '');
  const [hpMax, setHpMax] = useState(token.hp ? String(token.hp.max) : '');
  const [saving, setSaving] = useState(false);
  const save = async () => {
    const cur = hp.trim() === '' ? null : Math.max(0, Math.round(Number(hp)));
    const max = hpMax.trim() === '' ? null : Math.max(0, Math.round(Number(hpMax)));
    setSaving(true);
    try {
      await api.patch(`/api/servers/${serverId}/board/boards/${board.id}/tokens/${token.id}`, { hp: cur, hp_max: max });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title={`Hit Points — ${token.name}`}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving}>
            Save
          </Button>
        </>
      }
    >
      <div className="board-hp-fields">
        <Field label="Current">
          <TextInput value={hp} onChange={(e) => setHp(e.target.value)} inputMode="numeric" autoFocus />
        </Field>
        <Field label="Max" hint="Leave both empty for no bar">
          <TextInput value={hpMax} onChange={(e) => setHpMax(e.target.value)} inputMode="numeric" />
        </Field>
      </div>
    </Modal>
  );
}

function TextLabelModal({ serverId, board, at, color, onClose }: { serverId: number; board: Board; at: { x: number; y: number }; color: string; onClose: () => void }) {
  const [text, setText] = useState('');
  const [tone, setTone] = useState(color);
  const [size, setSize] = useState(24);
  const [saving, setSaving] = useState(false);
  const save = async () => {
    if (!text.trim() || saving) return;
    setSaving(true);
    try {
      await api.post(`/api/servers/${serverId}/board/boards/${board.id}/drawings`, {
        kind: 'text',
        color: tone,
        width: 1,
        data: { at: [r1(at.x), r1(at.y)], text: text.trim(), size },
      });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Write on the map"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!text.trim()}>
            Place it
          </Button>
        </>
      }
    >
      <Field label="Text" hint="A label, a battle cry, a name for that suspicious door">
        <TextInput
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={500}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === 'Enter') void save();
          }}
        />
      </Field>
      <Field label="Size">
        <div className="board-text-sizes">
          {([[16, 'Small'], [24, 'Medium'], [40, 'Large']] as const).map(([n, label]) => (
            <button key={n} type="button" className={`board-size-chip ${size === n ? 'on' : ''}`} onClick={() => setSize(n)}>
              {label}
            </button>
          ))}
        </div>
      </Field>
      <Field label="Color">
        <div className="board-color-row">
          {DRAW_COLORS.map((c) => (
            <button key={c} type="button" className={`board-palette-dot ${tone === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => setTone(c)} />
          ))}
        </div>
      </Field>
    </Modal>
  );
}

function DispositionPick({ value, onChange }: { value: Disposition; onChange: (d: Disposition) => void }) {
  return (
    <div className="board-disp-pick">
      {(['ally', 'neutral', 'enemy'] as Disposition[]).map((d) => (
        <button key={d} type="button" className={`board-disp ${d} ${value === d ? 'on' : ''}`} onClick={() => onChange(d)}>
          <span className="board-disp-dot" />
          {dispositionLabel[d]}
        </button>
      ))}
    </div>
  );
}

/** The DM's palette: a fresh token (NPC, monster, marker), or any character in the server. */
function NewTokenModal({ serverId, board, at, onClose }: { serverId: number; board: Board; at: () => { x: number; y: number }; onClose: () => void }) {
  const characters = useStore((s) => s.characters);
  const users = useStore((s) => s.users);
  const [name, setName] = useState('');
  const [disposition, setDisposition] = useState<Disposition>('neutral');
  const [hp, setHp] = useState('');
  const [hpMax, setHpMax] = useState('');
  const [busy, setBusy] = useState(false);
  const onBoard = useMemo(() => new Set(board.tokens.map((t) => t.character_id).filter((x): x is number => x !== null)), [board.tokens]);
  const placeable = useMemo(
    () => Object.values(characters).filter((c) => !c.deleted && !onBoard.has(c.id)).sort((a, b) => a.name.localeCompare(b.name)),
    [characters, onBoard],
  );

  const placeFree = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const c = at();
      const created = await api.post<BoardToken>(`/api/servers/${serverId}/board/boards/${board.id}/tokens`, {
        name: name.trim(),
        x: c.x,
        y: c.y,
        disposition,
      });
      const cur = hp.trim() === '' ? null : Math.max(0, Math.round(Number(hp)));
      const max = hpMax.trim() === '' ? null : Math.max(0, Math.round(Number(hpMax)));
      if (max !== null) await api.patch(`/api/servers/${serverId}/board/boards/${board.id}/tokens/${created.id}`, { hp: cur, hp_max: max });
      setName('');
      setHp('');
      setHpMax('');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(false);
    }
  };

  const placeCharacter = async (characterId: number) => {
    try {
      const c = at();
      await api.post(`/api/servers/${serverId}/board/boards/${board.id}/tokens`, { character_id: characterId, x: c.x, y: c.y, disposition: 'ally' });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <Modal title="Place a Token" onClose={onClose} centered size="medium">
      <div className="board-newtoken">
        <div className="board-newtoken-section">
          <h4>A new token</h4>
          <Field label="Name" hint="An NPC, a monster, a marker — anything that isn't a character">
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoFocus />
          </Field>
          <Field label="Ring">
            <DispositionPick value={disposition} onChange={setDisposition} />
          </Field>
          <div className="board-hp-fields">
            <Field label="HP (optional)">
              <TextInput value={hp} onChange={(e) => setHp(e.target.value)} inputMode="numeric" />
            </Field>
            <Field label="Max">
              <TextInput value={hpMax} onChange={(e) => setHpMax(e.target.value)} inputMode="numeric" />
            </Field>
          </div>
          <Button size="small" onClick={placeFree} loading={busy} disabled={!name.trim()}>
            Place it — middle of the view
          </Button>
        </div>
        <div className="board-newtoken-section">
          <h4>Or a character</h4>
          {placeable.length === 0 && <p className="board-muted">Every character in this server is already on the board.</p>}
          <div className="board-char-list scroller-thin">
            {placeable.map((c) => (
              <button key={c.id} className="board-char-row" onClick={() => void placeCharacter(c.id)}>
                <img src={characterAvatar(c)} alt="" />
                <span className="board-char-name">{c.name}</span>
                <span className="board-char-owner">{displayName(users[c.owner_id])}</span>
                <Icon path={mdiAccountPlus} size={16} />
              </button>
            ))}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

const TokenView = memo(function TokenView({
  t,
  g,
  x,
  y,
  dragging,
  canEdit,
  image,
  onDown,
  onMove,
  onUp,
  onMenu,
}: {
  t: BoardToken;
  g: number;
  x: number;
  y: number;
  dragging: boolean;
  canEdit: boolean;
  image: string | null;
  onDown: (e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => void;
  onMove: (e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => void;
  onUp: (e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => void;
  onMenu: (e: React.MouseEvent<HTMLDivElement>, t: BoardToken) => void;
}) {
  const d = t.size * g;
  const hpPct = t.hp && t.hp.max > 0 ? Math.max(0, Math.min(1, t.hp.current / t.hp.max)) : null;
  const hpTone = hpPct === null ? '' : hpPct > 0.5 ? 'good' : hpPct > 0.25 ? 'mid' : 'low';
  return (
    <div
      className={`board-token ${t.disposition} ${dragging ? 'dragging' : ''} ${canEdit ? 'editable' : ''}`}
      style={{ width: d, height: d, transform: `translate(${x - d / 2}px, ${y - d / 2}px)` }}
      onPointerDown={(e) => onDown(e, t)}
      onPointerMove={(e) => onMove(e, t)}
      onPointerUp={(e) => onUp(e, t)}
      onPointerCancel={(e) => onUp(e, t)}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={(e) => onMenu(e, t)}
      role="img"
      aria-label={`${t.name} (${dispositionLabel[t.disposition]})`}
      title={t.hp ? `${t.name} — ${t.hp.current}/${t.hp.max}` : t.name}
    >
      <div className="board-token-ring">
        {image ? (
          <img src={image} alt="" draggable={false} />
        ) : (
          <span className="board-token-letter" style={{ fontSize: Math.max(14, d * 0.45) }}>
            {t.name.slice(0, 1).toUpperCase()}
          </span>
        )}
      </div>
      {hpPct !== null && (
        <div className={`board-token-hp ${hpTone}`} style={{ width: d }}>
          <span style={{ width: `${hpPct * 100}%` }} />
        </div>
      )}
      <div className="board-token-name" style={{ fontSize: Math.max(10, Math.min(15, d * 0.17)) }}>
        {t.name}
      </div>
    </div>
  );
});

// ---------------------------------------------------------------------------
// Drawings: pen strokes, arrows, shapes and text (the ruler stays local)
// ---------------------------------------------------------------------------

/** What the drawing tools paint. The server keeps the same shape. */
type DrawKind = 'pen' | 'arrow' | 'line' | 'rect' | 'ellipse';

/** Board keyboard shortcuts: the tool each letter picks (Space pans, see below). */
const TOOL_KEYS: Record<string, 'select' | DrawKind | 'text' | 'ruler'> = {
  a: 'arrow',
  c: 'ellipse',
  l: 'line',
  p: 'pen',
  r: 'ruler',
  s: 'rect',
  t: 'text',
};
type Shape = { kind: BoardDrawing['kind']; color: string; width: number; data: BoardDrawing['data'] };
type Pt = { x: number; y: number };
type Draft = { kind: DrawKind; from: Pt; to: Pt; points: [number, number][] };

const nf1 = (n: number) => String(Math.round(n * 10) / 10);

/** A draft (still under the pointer) in the shape the renderer wants. */
function draftShape(d: Draft, color: string): Shape {
  if (d.kind === 'pen') return { kind: 'pen', color, width: 3, data: { points: d.points.map((p) => [r1(p[0]), r1(p[1])] as [number, number]) } };
  return { kind: d.kind, color, width: 3, data: { from: [r1(d.from.x), r1(d.from.y)], to: [r1(d.to.x), r1(d.to.y)] } };
}

const DrawingShape = memo(function DrawingShape({ d }: { d: Shape }) {
  const common = { stroke: d.color, strokeWidth: d.width, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  if (d.kind === 'pen') {
    const data = d.data as { points: [number, number][] };
    return <polyline points={data.points.map((p) => p.join(',')).join(' ')} fill="none" {...common} />;
  }
  if (d.kind === 'text') {
    const data = d.data as { at: [number, number]; text: string; size: number };
    return (
      <text x={data.at[0]} y={data.at[1]} fill={d.color} fontSize={data.size} style={{ paintOrder: 'stroke', stroke: 'rgba(10, 12, 16, 0.7)', strokeWidth: Math.max(2, data.size / 8) }}>
        {data.text}
      </text>
    );
  }
  const data = d.data as { from: [number, number]; to: [number, number] };
  const [fx, fy] = data.from;
  const [tx, ty] = data.to;
  if (d.kind === 'rect') {
    return <rect x={Math.min(fx, tx)} y={Math.min(fy, ty)} width={Math.abs(tx - fx)} height={Math.abs(ty - fy)} rx={2} fill="none" {...common} />;
  }
  if (d.kind === 'ellipse') {
    return <ellipse cx={(fx + tx) / 2} cy={(fy + ty) / 2} rx={Math.abs(tx - fx) / 2} ry={Math.abs(ty - fy) / 2} fill="none" {...common} />;
  }
  // A plain straight line: a shaft with no head.
  if (d.kind === 'line') {
    return <line x1={fx} y1={fy} x2={tx} y2={ty} fill="none" {...common} />;
  }
  // The arrow: a shaft plus a head that stops short of the tip.
  const len = Math.hypot(tx - fx, ty - fy) || 1;
  const ux = (tx - fx) / len;
  const uy = (ty - fy) / len;
  const head = Math.min(30, Math.max(12, len * 0.32));
  const spread = 6 + d.width * 1.9;
  const bx = tx - ux * head;
  const by = ty - uy * head;
  const nx = -uy;
  const ny = ux;
  return (
    <g>
      <line x1={fx} y1={fy} x2={tx - ux * head * 0.7} y2={ty - uy * head * 0.7} stroke={d.color} strokeWidth={d.width} strokeLinecap="round" />
      <polygon points={`${tx},${ty} ${bx + nx * spread},${by + ny * spread} ${bx - nx * spread},${by - ny * spread}`} fill={d.color} />
    </g>
  );
});

/** The ruler: a dashed line with the distance on it. Local to whoever drags it. */
function RulerMark({ a, b, g }: { a: Pt; b: Pt; g: number }) {
  const sq = Math.hypot(b.x - a.x, b.y - a.y) / g;
  const label = `${nf1(sq)} sq · ${nf1(sq * 5)} ft`;
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  return (
    <g className="board-ruler">
      <line x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke="#f2f4f8" strokeWidth={2} strokeDasharray="7 5" vectorEffect="non-scaling-stroke" />
      <circle cx={a.x} cy={a.y} r={4} fill="#f2f4f8" />
      <circle cx={b.x} cy={b.y} r={4} fill="#f2f4f8" />
      <text x={mx} y={my - 12} textAnchor="middle" fill="#f2f4f8" fontSize={22} style={{ paintOrder: 'stroke', stroke: 'rgba(10, 12, 16, 0.75)', strokeWidth: 5 }}>
        {label}
      </text>
    </g>
  );
}

// ---------------------------------------------------------------------------
// The bars around the board
// ---------------------------------------------------------------------------

function BoardTopBar({
  serverId,
  sb,
  view,
  onZoom,
  onFit,
  gridOn,
  onGridToggle,
  uploadPct,
  onPickBackground,
  canControl,
  tools,
}: {
  serverId: number;
  sb: ServerBoard;
  view: { x: number; y: number; z: number };
  onZoom: (z: number) => void;
  onFit: () => void;
  gridOn: boolean;
  onGridToggle: () => void;
  uploadPct: number | null;
  onPickBackground: () => void;
  canControl: boolean;
  tools: ReactNode;
}) {
  const users = useStore((s) => s.users);
  const [menuOpen, setMenuOpen] = useState(false);
  const board = sb.board;
  // The board's own text channel: its rolls land there. The chip below the
  // title shows it (falling back to "No channel") and opens this picker.
  const boardChannelName = useStore((s) => (board?.channel_id != null ? (s.channels[board.channel_id]?.name ?? null) : null));
  const pickerChannels = useStore(
    useShallow((s) =>
      Object.values(s.channels)
        .filter((c) => c.server_id === serverId && c.type === ChannelType.TEXT)
        .sort((a, b) => a.position - b.position || a.id - b.id),
    ),
  );
  const setBoardChannel = (channelId: number | null) => {
    if (!board) return;
    api.patch(`/api/servers/${serverId}/board/boards/${board.id}`, { channel_id: channelId }).catch((err) => toast(errorMessage(err)));
  };
  const channelPicker = (close: () => void) => (
    <>
      <MenuItem label="No Channel" checked={board?.channel_id == null} onClick={() => { close(); setBoardChannel(null); }} />
      {pickerChannels.map((c) => (
        <MenuItem key={c.id} label={`# ${c.name ?? ''}`} checked={c.id === board?.channel_id} onClick={() => { close(); setBoardChannel(c.id); }} />
      ))}
    </>
  );
  const openChannelPicker = (e: ReactMouseEvent) => openContextMenu(e, channelPicker);
  const toggleSnap = () => {
    if (!board) return;
    api.patch(`/api/servers/${serverId}/board/boards/${board.id}`, { snap: !board.snap }).catch((err) => toast(errorMessage(err)));
  };
  return (
    <div className="board-top">
      <div className="board-title-wrap">
        {canControl && board ? (
          <button className="board-title-button" onClick={() => setMenuOpen((v) => !v)} {...tip('Boards: switch, rename, background, grid', 'bottom')}>
            <Icon path={mdiViewGrid} size={17} />
            <span>{board.name}</span>
            <Icon path={mdiChevronDown} size={16} />
          </button>
        ) : (
          <span className="board-title-plain">
            <Icon path={mdiViewGrid} size={17} />
            <span>{board?.name ?? 'Game Board'}</span>
          </span>
        )}
        {menuOpen && board && (
          <div className="menu board-menu" onMouseLeave={() => setMenuOpen(false)}>
            {sb.boards.map((b) => (
              <MenuItem
                key={b.id}
                label={b.name}
                checked={b.id === sb.active_id}
                onClick={() => {
                  setMenuOpen(false);
                  if (b.id !== sb.active_id) api.post(`/api/servers/${serverId}/board/boards/${b.id}/activate`).catch((err) => toast(errorMessage(err)));
                }}
              />
            ))}
            <MenuItem
              label="New Board…"
              icon={mdiPlus}
              onClick={() => {
                setMenuOpen(false);
                openModal((close) => <NameBoardModal serverId={serverId} onClose={close} />);
              }}
            />
            <MenuItem
              label="Rename Board…"
              icon={mdiPencil}
              onClick={() => {
                setMenuOpen(false);
                openModal((close) => <NameBoardModal serverId={serverId} board={board} onClose={close} />);
              }}
            />
            <MenuItem
              label="Change Background…"
              icon={mdiImage}
              onClick={() => {
                setMenuOpen(false);
                onPickBackground();
              }}
            />
            {board.background_url && (
              <MenuItem
                label="Remove Background"
                icon={mdiClose}
                onClick={() => {
                  setMenuOpen(false);
                  api.del(`/api/servers/${serverId}/board/boards/${board.id}/background`).catch((err) => toast(errorMessage(err)));
                }}
              />
            )}
            <MenuItem
              label="Grid Size…"
              icon={mdiViewGrid}
              onClick={() => {
                setMenuOpen(false);
                openModal((close) => <GridModal serverId={serverId} board={board} onClose={close} />);
              }}
            />
            <MenuItem
              label="Snap to Grid"
              checked={board.snap}
              onClick={() => {
                setMenuOpen(false);
                api.patch(`/api/servers/${serverId}/board/boards/${board.id}`, { snap: !board.snap }).catch((err) => toast(errorMessage(err)));
              }}
            />
            <MenuItem
              label="Text Channel…"
              icon={mdiPound}
              onClick={(e) => {
                setMenuOpen(false);
                // MenuItem closes context menus right after onClick (layers.tsx),
                // so ours has to open on the next tick.
                const { clientX, clientY } = e;
                window.setTimeout(() => openContextMenu({ clientX, clientY }, channelPicker), 0);
              }}
            />
            <MenuItem
              label="Delete Board"
              danger
              icon={mdiTrashCanOutline}
              onClick={() => {
                setMenuOpen(false);
                const target = board;
                openModal((close) => (
                  <Modal
                    title="Delete this board?"
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
                            api.del(`/api/servers/${serverId}/board/boards/${target.id}`).catch((err) => toast(errorMessage(err)));
                          }}
                        >
                          Delete
                        </Button>
                      </>
                    }
                  >
                    <p>“{target.name}” goes away for everyone: its background, tokens and drawings all go with it.</p>
                  </Modal>
                ));
              }}
            />
          </div>
        )}
      </div>
      {board && (
        <button
          className={`board-channel-chip${boardChannelName ? '' : ' unset'}`}
          aria-label="Board text channel"
          onClick={openChannelPicker}
          {...tip(boardChannelName ? `Board rolls post to #${boardChannelName} — click to change` : "Pick the text channel this board's rolls post to", 'bottom')}
        >
          <Icon path={mdiPound} size={14} />
          <span>{boardChannelName ?? 'No channel'}</span>
        </button>
      )}
      <div className="board-top-tools">{tools}</div>
      <div className="board-top-spacer" />
      {uploadPct !== null && <span className="board-uploading">Uploading… {Math.round(uploadPct * 100)}%</span>}
      <div className="board-zoom">
        <button className="board-icon-btn" aria-label="Zoom out" onClick={() => onZoom(Math.max(0.15, view.z * 0.85))}>
          <Icon path={mdiMinus} size={17} />
        </button>
        <input
          className="board-zoom-slider"
          type="range"
          min={15}
          max={300}
          value={Math.round(view.z * 100)}
          onChange={(e) => onZoom(Number(e.target.value) / 100)}
          aria-label="Zoom"
        />
        <button className="board-icon-btn" aria-label="Zoom in" onClick={() => onZoom(Math.min(3, view.z * 1.18))}>
          <Icon path={mdiPlus} size={17} />
        </button>
        <span className="board-zoom-pct">{Math.round(view.z * 100)}%</span>
        <button className="board-icon-btn" aria-label="Fit to screen" onClick={onFit} {...tip('Fit the board to the screen', 'bottom')}>
          <Icon path={mdiArrowExpand} size={17} />
        </button>
        <button className={`board-icon-btn ${gridOn ? 'on' : ''}`} aria-label="Toggle the grid" onClick={onGridToggle} {...tip(gridOn ? 'Hide the grid' : 'Show the grid', 'bottom')}>
          <Icon path={mdiViewGrid} size={17} />
        </button>
        {canControl && board && (
          <button
            className={`board-icon-btn ${board.snap ? 'on' : ''}`}
            aria-label="Toggle token snapping"
            aria-pressed={board.snap}
            onClick={toggleSnap}
            {...tip(board.snap ? 'Tokens snap to the grid' : 'Tokens move freely', 'bottom')}
          >
            <Icon path={mdiMagnet} size={17} />
          </button>
        )}
      </div>
      <div className="board-viewers">
        {sb.viewers.map((id) => (users[id] ? <Avatar key={id} src={userAvatar(users[id])} size={22} {...tip(`${displayName(users[id])} has the board open`, 'bottom')} /> : null))}
      </div>
      <Button size="small" look="secondary" onClick={closeBoard}>
        <Icon path={mdiClose} size={15} /> Leave Board
      </Button>
    </div>
  );
}

function TokenTray({ serverId, board, at }: { serverId: number; board: Board; at: () => { x: number; y: number } }) {
  const canControl = useStore((s) => canControlBoard(s, serverId));
  const mine = useStore(useShallow((s) => myCharacters(s)));
  const onBoard = useMemo(() => new Set(board.tokens.map((t) => t.character_id).filter((x): x is number => x !== null)), [board.tokens]);
  const placeable = canControl ? [] : mine.filter((c) => !onBoard.has(c.id));

  const place = async (characterId: number) => {
    try {
      const c = at();
      await api.post(`/api/servers/${serverId}/board/boards/${board.id}/tokens`, { character_id: characterId, x: c.x, y: c.y, disposition: 'ally' });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <div className="board-tray">
      {placeable.map((c) => (
        <button key={c.id} className="board-chip" onClick={() => void place(c.id)} {...tip(`Place ${c.name} on the board`)}>
          <img src={characterAvatar(c)} alt="" />
          <span>{c.name}</span>
        </button>
      ))}
      {canControl && (
        <button className="board-chip board-chip-add" onClick={() => openModal((close) => <NewTokenModal serverId={serverId} board={board} at={at} onClose={close} />)}>
          <Icon path={mdiAccountPlus} size={16} />
          <span>Place Token</span>
        </button>
      )}
      {!canControl && mine.length === 0 && <span className="board-tray-quiet">Make a character to bring to the table.</span>}
      {!canControl && mine.length > 0 && placeable.length === 0 && <span className="board-tray-quiet">Your token is on the board — drag it where you like.</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The board room: the board (middle) + the channel chat (right)
// ---------------------------------------------------------------------------

export function BoardRoom({ serverId, channel }: { serverId: number; channel: Channel | undefined }) {
  const sb = useStore((s) => s.board[serverId]);
  const connected = useStore((s) => s.connected);
  const canControl = useStore((s) => canControlBoard(s, serverId));
  const characters = useStore((s) => s.characters);
  const stageRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef({ x: 0, y: 0, z: 1 });
  const boardRef = useRef<Board | null>(null);
  const dragPosRef = useRef<{ id: number; x: number; y: number; hold?: boolean; seq?: number } | null>(null);
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [gridOn, setGridOn] = useState(true);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const dragRef = useRef<{ id: number; dx: number; dy: number; sx: number; sy: number; px: number; py: number; moved: boolean; last: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number; hold?: boolean; seq?: number } | null>(null);
  const [tool, setTool] = useState<'select' | DrawKind | 'text' | 'ruler'>('select');
  const [color, setColor] = useState(DRAW_COLORS[0]);
  const [diceOpen, setDiceOpen] = useState(false);
  const [diceCount, setDiceCount] = useState(1);
  const [diceMod, setDiceMod] = useState(0);
  const [diceRoll, setDiceRoll] = useState<BoardRoll | null>(null);
  const diceSeq = useRef(0);
  const drawRef = useRef<Draft | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const rulerRef = useRef<{ a: Pt; b: Pt } | null>(null);
  const [ruler, setRuler] = useState<{ a: Pt; b: Pt } | null>(null);
  const redoRef = useRef<Shape[]>([]);
  const [redoCount, setRedoCount] = useState(0);
  // A finished stroke shows right away; the server copy replaces it by id.
  // Both carry the board they were drawn on: a slow save must never land on
  // another map's display.
  const [pending, setPending] = useState<Map<string, { boardId: number; shape: Shape }>>(new Map());
  const [localDraws, setLocalDraws] = useState<Map<number, { boardId: number; shape: Shape }>>(new Map());
  const shapeSeq = useRef(0);
  const holdSeq = useRef(0);
  // Undo and redo run one at a time, in press order, so a quick second press
  // acts on the next entry instead of re-submitting the same one.
  const histRef = useRef<Promise<void>>(Promise.resolve());
  // A press belongs to the board (and history generation) it was made on: a
  // reset or a map switch voids queued/in-flight actions instead of letting
  // them touch whatever is open later. Gone ids are marked locally the moment
  // a delete succeeds, so the next press moves on before the live event lands.
  const histGen = useRef(0);
  const goneRef = useRef<Set<number>>(new Set());
  const resetHistory = useCallback((clearGone: boolean) => {
    histGen.current += 1;
    redoRef.current = [];
    if (clearGone) goneRef.current = new Set();
    setRedoCount(0);
  }, []);
  const patchQueues = useRef<Map<number, { running: boolean; queue: { body: Record<string, unknown>; done?: (ok: boolean) => void }[] }>>(new Map());
  const board = sb?.board ?? null;
  boardRef.current = board;
  dragPosRef.current = dragPos;
  const meId = useStore((s) => s.me?.id ?? null);
  const myDrawings = useMemo(() => (board ? board.drawings.filter((d) => d.author_id === meId) : []), [board, meId]);
  const world = worldSize(board);

  viewRef.current = view;

  // Tell the server we have the board open (the avatars in the bar), and again after a reconnect.
  useEffect(() => {
    gateway.send(12, { server_id: serverId, viewing: true });
    const off = on('ready', () => gateway.send(12, { server_id: serverId, viewing: true }));
    return () => {
      off();
      gateway.send(12, { server_id: serverId, viewing: false });
    };
  }, [serverId]);

  // Every live roll in the board's channel drops 3D dice on the board — rolls
  // from the tray, from chat, and for everyone watching, since everyone plays
  // the same message. The board's own channel (top bar) wins over the open
  // chat, so rolls keep landing there while you browse elsewhere. The board
  // claims the animation first, so the chat card lands straight onto its
  // numbers instead of tumbling a second time.
  const diceChannel = board?.channel_id ?? channel?.id ?? null;
  useEffect(() => {
    if (diceChannel === null) return;
    return on('message-create', (m) => {
      if (m.type !== MessageType.ROLL || m.channel_id !== diceChannel) return;
      const roll = m.meta?.roll;
      if (!roll || !claimRollAnimation(m.id)) return;
      const dice: BoardRoll['dice'] = [];
      for (const part of roll.parts) {
        for (const term of part.terms) {
          if (term.kind !== 'dice') continue;
          for (const r of term.rolls) dice.push({ sides: term.sides, value: r.v, drop: !!r.drop });
        }
      }
      if (dice.length) setDiceRoll({ id: ++diceSeq.current, dice, who: m.author ? displayName(m.author) : undefined });
    });
  }, [diceChannel]);

  /** Roll from the tray: a plain NdX±M that lands in the board's channel. */
  const rollDice = useCallback(
    (sides: number) => {
      if (diceChannel === null) return;
      const expression = `${diceCount}d${sides}${diceMod ? (diceMod > 0 ? `+${diceMod}` : `${diceMod}`) : ''}`;
      void requestRoll(diceChannel, { kind: 'custom', expression });
    },
    [diceChannel, diceCount, diceMod],
  );

  const fit = useCallback(() => {
    const el = stageRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const z = Math.max(0.15, Math.min(2, Math.min((rect.width - 24) / world.w, (rect.height - 24) / world.h)));
    setView({ z, x: (rect.width - world.w * z) / 2, y: (rect.height - world.h * z) / 2 });
  }, [world.w, world.h]);

  useEffect(() => {
    fit();
  }, [board?.id, board?.background_url, fit]);

  /** Zoom to a scale, keeping the middle of the view put. */
  const zoomAt = useCallback((z: number) => {
    setView((v) => {
      const el = stageRef.current;
      const rect = el ? el.getBoundingClientRect() : { width: 0, height: 0 };
      const mx = rect.width / 2;
      const my = rect.height / 2;
      const k = z / v.z;
      return { z, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
    });
  }, []);

  // Wheel zoom (nothing scrolls behind the board).
  useEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      setView((v) => {
        const z = Math.max(0.1, Math.min(3, v.z * Math.exp(-e.deltaY * 0.0016)));
        const k = z / v.z;
        return { z, x: mx - (mx - v.x) * k, y: my - (my - v.y) * k };
      });
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Redo belongs to one board: switching maps starts a clean history.
  useEffect(() => {
    resetHistory(true);
  }, [board?.id, resetHistory]);

  // A dropped token keeps its snapped spot on screen until the server agrees
  // (and stops waiting when the token is gone).
  useEffect(() => {
    const dp = dragPos;
    if (!dp || !dp.hold) return;
    const t = board?.tokens.find((x) => x.id === dp.id);
    if (!t || (Math.abs(t.x - dp.x) < 0.2 && Math.abs(t.y - dp.y) < 0.2)) setDragPos(null);
  }, [board, dragPos]);

  // Once the live event brings a saved drawing, its local stand-in goes.
  useEffect(() => {
    if (!board || localDraws.size === 0) return;
    const have = new Set(board.drawings.map((x) => x.id));
    let gone = false;
    for (const [id, e] of localDraws) if (e.boardId === board.id && have.has(id)) gone = true;
    if (!gone) return;
    setLocalDraws((m) => {
      const next = new Map(m);
      for (const [id, e] of next) if (e.boardId === board.id && have.has(id)) next.delete(id);
      return next;
    });
  }, [board, localDraws]);

  const toWorld = useCallback((cx: number, cy: number) => {
    const el = stageRef.current;
    const v = viewRef.current;
    if (!el) return { x: 0, y: 0 };
    const rect = el.getBoundingClientRect();
    return { x: (cx - rect.left - v.x) / v.z, y: (cy - rect.top - v.y) / v.z };
  }, []);

  /** The middle of what's on screen, in board units (snapped) — where new tokens go. */
  const centerPoint = useCallback((): { x: number; y: number } => {
    const el = stageRef.current;
    const v = viewRef.current;
    if (!el) return snapPoint(board, world.w / 2, world.h / 2);
    const rect = el.getBoundingClientRect();
    return snapPoint(board, (rect.width / 2 - v.x) / v.z, (rect.height / 2 - v.y) / v.z);
  }, [board, world.w, world.h]);

  /** A finished stroke shows instantly; once the server answers it is kept by id
   *  until the live event lands, so it never blinks out or doubles up. */
  const postShape = useCallback(async (shape: Shape): Promise<boolean> => {
    const b = boardRef.current;
    if (!b) return false;
    const boardId = b.id; // the shape belongs to the board it was drawn on
    const key = 'p' + ++shapeSeq.current;
    setPending((m) => new Map(m).set(key, { boardId, shape }));
    try {
      const saved = await api.post<BoardDrawing>(`/api/servers/${serverId}/board/boards/${boardId}/drawings`, shape);
      setPending((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
      setLocalDraws((m) => new Map(m).set(saved.id, { boardId, shape: { kind: saved.kind, color: saved.color, width: saved.width, data: saved.data } }));
      return true;
    } catch (err) {
      setPending((m) => {
        const next = new Map(m);
        next.delete(key);
        return next;
      });
      toast(errorMessage(err));
      return false;
    }
  }, [serverId]);

  const saveDrawing = async (d: Draft) => {
    const tooSmall = d.kind === 'pen' ? d.points.length < 2 : Math.hypot(d.to.x - d.from.x, d.to.y - d.from.y) < 2;
    if (tooSmall) return;
    const payload: Shape =
      d.kind === 'pen'
        ? { kind: 'pen', color, width: 3, data: { points: d.points.map((p) => [r1(p[0]), r1(p[1])] as [number, number]) } }
        : { kind: d.kind, color, width: 3, data: { from: [r1(d.from.x), r1(d.from.y)], to: [r1(d.to.x), r1(d.to.y)] } };
    // The stroke belongs to the board (and history) it was drawn on: a save
    // that lands after a map switch must not clear the new board's redo pile.
    const gen = histGen.current;
    const boardId = boardRef.current?.id ?? null;
    if (await postShape(payload)) {
      if (boardId === (boardRef.current?.id ?? null) && histGen.current === gen) {
        resetHistory(false); // a fresh stroke starts a new undo line
      }
    }
  };

  const undo = useCallback(() => {
    const gen = histGen.current;
    const boardId = boardRef.current?.id ?? null;
    histRef.current = histRef.current
      .then(async () => {
        const b = boardRef.current;
        const me = getState().me;
        // The map (or the history) may have moved on since the press: an
        // obsolete action cancels instead of touching another board.
        if (!b || !me || b.id !== boardId || histGen.current !== gen) return;
        const mine = b.drawings.filter((d) => d.author_id === me.id && !goneRef.current.has(d.id));
        const last = mine[mine.length - 1];
        if (!last) return;
        try {
          await api.del(`/api/servers/${serverId}/board/boards/${b.id}/drawings/${last.id}`);
          // Marked gone now: the next press must move on even if the live
          // event that removes it from the store hasn't arrived yet.
          goneRef.current.add(last.id);
          if (histGen.current !== gen) return; // reset while this ran: the redo pile stays clean
          redoRef.current.push({ kind: last.kind, color: last.color, width: last.width, data: last.data });
          setRedoCount(redoRef.current.length);
        } catch (err) {
          toast(errorMessage(err));
        }
      })
      .catch(() => {});
  }, [serverId]);

  const redo = useCallback(() => {
    const gen = histGen.current;
    const boardId = boardRef.current?.id ?? null;
    histRef.current = histRef.current
      .then(async () => {
        const b = boardRef.current;
        if (!b || b.id !== boardId || histGen.current !== gen) return;
        const p = redoRef.current[redoRef.current.length - 1];
        if (!p) return;
        if (await postShape(p)) {
          if (histGen.current !== gen) return; // board switched mid-flight; the pile was reset
          redoRef.current.pop(); // a failed redo stays put for another try
          setRedoCount(redoRef.current.length);
        }
      })
      .catch(() => {});
  }, [postShape]);

  const pickTool = (t: 'select' | DrawKind | 'text' | 'ruler') => {
    setTool(t);
    if (t !== 'ruler') setRuler(null);
  };

  const clearDrawings = () => {
    const b = board;
    if (!b) return;
    openModal((close) => (
      <Modal
        title="Clear every drawing?"
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
                resetHistory(true);
                api.del(`/api/servers/${serverId}/board/boards/${b.id}/drawings`).catch((err) => toast(errorMessage(err)));
              }}
            >
              Clear
            </Button>
          </>
        }
      >
        <p>Every stroke, arrow, shape and label comes off “{b.name}” for everyone.</p>
      </Modal>
    ));
  };

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    const el = stageRef.current;
    if (!el) return;
    if (e.button === 1 || (e.button === 0 && tool === 'select')) {
      el.setPointerCapture(e.pointerId);
      panRef.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
      return;
    }
    if (e.button !== 0) return;
    if (!board) return;
    e.preventDefault();
    el.setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    if (tool === 'text') {
      openModal((close) => <TextLabelModal serverId={serverId} board={board} at={w} color={color} onClose={close} />);
      return;
    }
    if (tool === 'ruler') {
      rulerRef.current = { a: w, b: w };
      setRuler({ a: w, b: w });
      return;
    }
    drawRef.current = { kind: tool as DrawKind, from: w, to: w, points: tool === 'pen' ? [[w.x, w.y] as [number, number]] : [] };
    setDraft({ ...drawRef.current, points: [...drawRef.current.points] });
  };
  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drawRef.current;
    if (d) {
      const w = toWorld(e.clientX, e.clientY);
      if (d.kind === 'pen') {
        const last = d.points[d.points.length - 1];
        if (d.points.length < 3000 && Math.hypot(w.x - last[0], w.y - last[1]) > 2.5 / viewRef.current.z) {
          d.points = [...d.points, [w.x, w.y] as [number, number]];
          setDraft({ ...d });
        }
      } else {
        d.to = w;
        setDraft({ ...d });
      }
      return;
    }
    const r = rulerRef.current;
    if (r) {
      rulerRef.current = { a: r.a, b: toWorld(e.clientX, e.clientY) };
      setRuler(rulerRef.current);
      return;
    }
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };
  const onStagePointerUp = () => {
    panRef.current = null;
    rulerRef.current = null;
    const d = drawRef.current;
    drawRef.current = null;
    if (!d) return;
    setDraft(null);
    void saveDrawing(d);
  };

  /** Token changes go out one at a time, in order. While a request is in flight
   *  another one only queues; a throttled drag move may replace a queued move
   *  (coalesce), but the released position is never dropped, so on a slow link
   *  the drop still wins instead of an older move overtaking it. */
  const queuePatch = useCallback((tokenId: number, body: Record<string, unknown>, opts?: { coalesce?: boolean; onDone?: (ok: boolean) => void }) => {
    const b = boardRef.current;
    if (!b) return;
    const q = patchQueues.current.get(tokenId) ?? { running: false, queue: [] };
    patchQueues.current.set(tokenId, q);
    if (opts?.coalesce && (q.running || q.queue.length > 0)) return;
    q.queue.push({ body, done: opts?.onDone });
    if (q.running) return;
    q.running = true;
    const url = `/api/servers/${serverId}/board/boards/${b.id}/tokens/${tokenId}`;
    void (async () => {
      while (q.queue.length > 0) {
        const item = q.queue.shift()!;
        try {
          await api.patch(url, item.body);
          item.done?.(true);
        } catch (err) {
          toast(errorMessage(err));
          item.done?.(false);
        }
      }
      q.running = false;
    })();
  }, [serverId]);

  const canMoveToken = useCallback((t: BoardToken): boolean => {
    const s = getState();
    if (canControlBoard(s, serverId)) return true;
    const me = s.me;
    if (!me || t.character_id === null) return false;
    const ch = s.characters[t.character_id];
    return !!ch && ch.owner_id === me.id;
  }, [serverId]);

  const onTokenDown = useCallback((e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => {
    if (e.button !== 0) return;
    if (!canMoveToken(t)) return; // let the board pan from over a token you can't move
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    // Start from what is on screen: while a drop still waits for the server,
    // the displayed spot is the truth, not the older confirmed coordinates.
    const shown = dragPosRef.current && dragPosRef.current.id === t.id ? dragPosRef.current : { x: t.x, y: t.y };
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { id: t.id, dx: shown.x - w.x, dy: shown.y - w.y, sx: w.x, sy: w.y, px: shown.x, py: shown.y, moved: false, last: 0 };
    setDragPos({ id: t.id, x: shown.x, y: shown.y });
  }, [canMoveToken, toWorld]);

  const onTokenMove = useCallback((e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => {
    const d = dragRef.current;
    if (!d || d.id !== t.id) return;
    const w = toWorld(e.clientX, e.clientY);
    const x = Math.max(-50000, Math.min(50000, w.x + d.dx));
    const y = Math.max(-50000, Math.min(50000, w.y + d.dy));
    d.px = x;
    d.py = y;
    if (!d.moved && Math.hypot(w.x - d.sx, w.y - d.sy) > 4 / viewRef.current.z) d.moved = true;
    setDragPos({ id: t.id, x, y });
    const now = performance.now();
    if (d.moved && now - d.last > 140) {
      d.last = now;
      queuePatch(t.id, { x: r1(x), y: r1(y) }, { coalesce: true });
    }
  }, [queuePatch, toWorld]);

  const onTokenUp = useCallback((_e: ReactPointerEvent<HTMLDivElement>, t: BoardToken) => {
    const d = dragRef.current;
    dragRef.current = null;
    if (!d || d.id !== t.id) {
      setDragPos(null);
      return;
    }
    if (!d.moved) {
      setDragPos(null);
      // A click, not a drag: a character's sheet opens.
      if (t.character_id !== null) openSheet(t.character_id, serverId);
      return;
    }
    const s = snapPoint(boardRef.current, d.px, d.py);
    const seq = ++holdSeq.current;
    setDragPos({ id: t.id, x: s.x, y: s.y, hold: true, seq });
    queuePatch(t.id, { x: s.x, y: s.y }, { onDone: (ok) => { if (!ok) setDragPos((p) => (p && p.hold && p.id === t.id && p.seq === seq ? null : p)); } });
    window.setTimeout(() => setDragPos((p) => (p && p.hold && p.id === t.id && p.seq === seq ? null : p)), 4000);
  }, [queuePatch, serverId]);

  const onTokenMenu = useCallback((e: React.MouseEvent<HTMLDivElement>, t: BoardToken) => {
    const s = getState();
    const control = canControlBoard(s, serverId);
    const me = s.me;
    const own = t.character_id !== null && !!me && s.characters[t.character_id]?.owner_id === me.id;
    if (!control && !own) return;
    e.preventDefault();
    const b = boardRef.current;
    if (!b) return;
    openContextMenu(e, (close) => (
      <>
        {(Object.keys(dispositionLabel) as Disposition[]).map((d) => (
          <MenuItem
            key={d}
            label={dispositionLabel[d]}
            checked={t.disposition === d}
            onClick={() => {
              close();
              queuePatch(t.id, { disposition: d });
            }}
          />
        ))}
        {control && t.character_id === null && (
          <MenuItem
            label="Hit Points…"
            onClick={() => {
              close();
              openModal((c) => <HpModal serverId={serverId} board={b} token={t} onClose={c} />);
            }}
          />
        )}
        <MenuItem
          label="Remove Token"
          danger
          icon={mdiTrashCanOutline}
          onClick={() => {
            close();
            api.del(`/api/servers/${serverId}/board/boards/${b.id}/tokens/${t.id}`).catch((err) => toast(errorMessage(err)));
          }}
        />
      </>
    ));
  }, [serverId, queuePatch]);

  const onPickFile = (files: FileList | null) => {
    const f = files?.[0];
    if (fileInput.current) fileInput.current.value = '';
    if (!f || !board) return;
    setUploadPct(0);
    const form = new FormData();
    form.append('file', f);
    upload('POST', `/api/servers/${serverId}/board/boards/${board.id}/background`, form, (p) => setUploadPct(p))
      .promise.then(() => setUploadPct(null))
      .catch((err) => {
        setUploadPct(null);
        toast(errorMessage(err));
      });
  };

  // Ctrl+Z / Ctrl+Shift+Z: undo and redo my own drawings; Escape clears the
  // ruler first. Single letters pick tools (P pen, L line, S rectangle, C
  // ellipse, T text, R ruler, A arrow) and holding Space pans with Select,
  // putting the previous tool back on release — all asleep while a field has
  // the caret or a menu or dialog is up.
  const prevToolRef = useRef<'select' | DrawKind | 'text' | 'ruler' | null>(null);
  useEffect(() => {
    const restoreTool = () => {
      const back = prevToolRef.current;
      prevToolRef.current = null;
      if (back !== null) setTool(back);
    };
    const onKey = (e: KeyboardEvent) => {
      const s = getState();
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
      if (e.key === 'Escape' && !s.modals.length && !s.sheetView && !s.contextMenu) {
        if (ruler) {
          setRuler(null);
          return;
        }
        closeBoard();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && !typing && !s.modals.length) {
        const k = e.key.toLowerCase();
        if (k === 'z' && !e.shiftKey) {
          e.preventDefault();
          void undo();
        } else if (k === 'y' || (k === 'z' && e.shiftKey)) {
          e.preventDefault();
          void redo();
        }
      }
      if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
      if (s.modals.length || s.sheetView || s.contextMenu) return;
      if (e.key === ' ') {
        // Held Space: pan with Select but keep the ruler drawing on screen.
        e.preventDefault();
        if (e.repeat || prevToolRef.current !== null) return;
        prevToolRef.current = tool;
        setTool('select');
        return;
      }
      const next = TOOL_KEYS[e.key.toLowerCase()];
      if (next) {
        e.preventDefault();
        pickTool(next);
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.key === ' ') restoreTool();
    };
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', restoreTool);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', restoreTool);
    };
  }, [ruler, undo, redo, tool, pickTool]);

  if (!sb) return <div className="board-room" />;
  if (!board) {
    return (
      <div className="board-room">
        <div className="board-empty-state">
          <Icon path={mdiViewGrid} size={44} />
          <h3>No board yet</h3>
          <p>{canControl ? 'Upload a map, add a grid, and your table has a battlefield.' : 'Whoever runs the game hasn’t set up a board yet.'}</p>
          {canControl && (
            <Button onClick={() => openModal((close) => <NameBoardModal serverId={serverId} onClose={close} />)}>
              <Icon path={mdiPlus} size={16} /> Create Board
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="board-room">
      <div className="board-shell">
        {!connected && <div className="connection-bar">Reconnecting…</div>}
        <BoardTopBar
          serverId={serverId}
          sb={sb}
          view={view}
          onZoom={zoomAt}
          onFit={fit}
          gridOn={gridOn}
          onGridToggle={() => setGridOn((v) => !v)}
          uploadPct={uploadPct}
          onPickBackground={() => fileInput.current?.click()}
          canControl={canControl}
          tools={
            <>
              <button className={`board-tool ${tool === 'select' ? 'active' : ''}`} aria-label="Select" onClick={() => pickTool('select')} {...tip('Select — drag the board to pan, drag a token to move it (middle-drag always pans)', 'bottom')}>
                <Icon path={mdiCursorDefault} size={20} />
              </button>
              {canControl && (
                <button
                  className="board-tool board-tool-secondary"
                  aria-label="Place a token"
                  onClick={() => openModal((close) => <NewTokenModal serverId={serverId} board={board} at={centerPoint} onClose={close} />)}
                  {...tip('Place a token', 'bottom')}
                >
                  <Icon path={mdiAccountPlus} size={20} />
                </button>
              )}
              {canControl && (
                <button className="board-tool board-tool-secondary" aria-label="Change the background" onClick={() => fileInput.current?.click()} {...tip('Change the background picture', 'bottom')}>
                  <Icon path={mdiImage} size={20} />
                </button>
              )}
              <span className="board-tool-sep" />
              <button className={`board-tool ${tool === 'pen' ? 'active' : ''}`} aria-label="Draw freehand" onClick={() => pickTool('pen')} {...tip('Draw — drag to sketch on the map', 'bottom')}>
                <Icon path={mdiDraw} size={20} />
              </button>
              <button className={`board-tool ${tool === 'arrow' ? 'active' : ''}`} aria-label="Arrow" onClick={() => pickTool('arrow')} {...tip('Arrow — drag from where it starts to where it points', 'bottom')}>
                <Icon path={mdiArrowTopRight} size={20} />
              </button>
              <button className={`board-tool ${tool === 'line' ? 'active' : ''}`} aria-label="Line" onClick={() => pickTool('line')} {...tip('Line — drag to draw a straight line', 'bottom')}>
                <Icon path={mdiVectorLine} size={20} />
              </button>
              <button className={`board-tool ${tool === 'rect' ? 'active' : ''}`} aria-label="Rectangle" onClick={() => pickTool('rect')} {...tip('Rectangle — drag out a box (a wall, a zone, a room)', 'bottom')}>
                <Icon path={mdiRectangleOutline} size={20} />
              </button>
              <button className={`board-tool ${tool === 'ellipse' ? 'active' : ''}`} aria-label="Circle or oval" onClick={() => pickTool('ellipse')} {...tip('Circle — drag out a circle (a spell area, a campfire)', 'bottom')}>
                <Icon path={mdiCircleOutline} size={20} />
              </button>
              <button className={`board-tool ${tool === 'text' ? 'active' : ''}`} aria-label="Text" onClick={() => pickTool('text')} {...tip('Text — click the map to write a label', 'bottom')}>
                <Icon path={mdiFormatText} size={20} />
              </button>
              <button className={`board-tool ${tool === 'ruler' ? 'active' : ''}`} aria-label="Ruler" onClick={() => pickTool('ruler')} {...tip('Ruler — drag to measure; the distance shows on the line', 'bottom')}>
                <Icon path={mdiRuler} size={20} />
              </button>
              <span className="board-tool-sep" />
              <button className="board-tool" aria-label="Undo" disabled={myDrawings.length === 0} onClick={() => void undo()} {...tip('Undo my last drawing (Ctrl+Z)', 'bottom')}>
                <Icon path={mdiUndo} size={20} />
              </button>
              <button className="board-tool" aria-label="Redo" disabled={redoCount === 0} onClick={() => void redo()} {...tip('Redo (Ctrl+Shift+Z)', 'bottom')}>
                <Icon path={mdiRedo} size={20} />
              </button>
              {canControl && board.drawings.length > 0 && (
                <button className="board-tool" aria-label="Clear drawings" onClick={clearDrawings} {...tip('Clear every drawing', 'bottom')}>
                  <Icon path={mdiDeleteSweepOutline} size={20} />
                </button>
              )}
              <span className="board-tool-sep" />
              <div className="board-dice-wrap">
                <button className={`board-tool ${diceOpen ? 'active' : ''}`} aria-label="Dice" onClick={() => setDiceOpen((v) => !v)} {...tip('Roll dice on the board', 'bottom')}>
                  <Icon path={mdiDiceMultiple} size={20} />
                </button>
                {diceOpen && (
                  <div className="board-dice-tray">
                    <div className="board-dice-row">
                      {DICE_SIDES.map((s) => (
                        <button
                          key={s}
                          className="board-dice-btn"
                          aria-label={`Roll a d${s}`}
                          disabled={!channel}
                          onClick={() => rollDice(s)}
                          {...tip(`Roll ${diceCount}d${s}${diceMod ? (diceMod > 0 ? `+${diceMod}` : diceMod) : ''}`, 'bottom')}
                        >
                          <Icon path={DICE_ICONS[s]} size={22} />
                        </button>
                      ))}
                    </div>
                    <div className="board-dice-opts">
                      <span className="board-dice-label">Dice</span>
                      <button className="board-dice-step" aria-label="Fewer dice" disabled={diceCount <= 1} onClick={() => setDiceCount((c) => Math.max(1, c - 1))}>
                        −
                      </button>
                      <span className="board-dice-num">{diceCount}</span>
                      <button className="board-dice-step" aria-label="More dice" disabled={diceCount >= 10} onClick={() => setDiceCount((c) => Math.min(10, c + 1))}>
                        +
                      </button>
                      <span className="board-dice-label">Mod</span>
                      <button className="board-dice-step" aria-label="Lower the modifier" disabled={diceMod <= -10} onClick={() => setDiceMod((m) => Math.max(-10, m - 1))}>
                        −
                      </button>
                      <span className="board-dice-num">{diceMod > 0 ? `+${diceMod}` : diceMod}</span>
                      <button className="board-dice-step" aria-label="Raise the modifier" disabled={diceMod >= 10} onClick={() => setDiceMod((m) => Math.min(10, m + 1))}>
                        +
                      </button>
                    </div>
                    {!channel && <span className="board-dice-quiet">Open a text channel to roll.</span>}
                  </div>
                )}
              </div>
              {tool !== 'select' && tool !== 'ruler' && (
                <div className="board-palette">
                  {DRAW_COLORS.map((c) => (
                    <button key={c} type="button" className={`board-palette-dot ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={`Color ${c}`} onClick={() => setColor(c)} />
                  ))}
                </div>
              )}
            </>
          }
        />
        <div className="board-stage-wrap">
          <div
            ref={stageRef}
            className={`board-stage tool-${tool}`}
            onPointerDown={onStagePointerDown}
            onPointerMove={onStagePointerMove}
            onPointerUp={onStagePointerUp}
            onPointerCancel={onStagePointerUp}
            onDragStart={(e) => e.preventDefault()}
          >
            <div
              className="board-world"
              style={{
                width: world.w,
                height: world.h,
                transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})`,
              }}
            >
              {board.background_url ? <img className="board-bg" src={board.background_url} alt="" draggable={false} /> : <div className="board-bg board-bg-plain" />}
              {gridOn && <div className="board-grid" style={{ backgroundSize: `${board.grid_size}px ${board.grid_size}px` }} />}
              <svg className="board-draw-layer" viewBox={`0 0 ${world.w} ${world.h}`} width={world.w} height={world.h} aria-hidden="true">
                {board.drawings.map((d) => (
                  <DrawingShape key={d.id} d={d} />
                ))}
                {[...pending.entries()]
                  .filter(([, e]) => e.boardId === board.id)
                  .map(([k, e]) => (
                    <DrawingShape key={k} d={e.shape} />
                  ))}
                {[...localDraws.entries()]
                  .filter(([id, e]) => e.boardId === board.id && !board.drawings.some((d) => d.id === id))
                  .map(([id, e]) => (
                    <DrawingShape key={`l${id}`} d={e.shape} />
                  ))}
              </svg>
              {board.tokens.map((t) => {
                const pos = dragPos && dragPos.id === t.id ? dragPos : { x: t.x, y: t.y };
                return (
                  <TokenView
                    key={t.id}
                    t={t}
                    g={board.grid_size}
                    x={pos.x}
                    y={pos.y}
                    dragging={!!dragPos && dragPos.id === t.id && !dragPos.hold}
                    canEdit={canMoveToken(t)}
                    image={tokenImage(t, characters)}
                    onDown={onTokenDown}
                    onMove={onTokenMove}
                    onUp={onTokenUp}
                    onMenu={onTokenMenu}
                  />
                );
              })}
              <svg className="board-draw-layer board-draw-top" viewBox={`0 0 ${world.w} ${world.h}`} width={world.w} height={world.h} aria-hidden="true">
                {draft && <DrawingShape d={draftShape(draft, color)} />}
                {ruler && <RulerMark a={ruler.a} b={ruler.b} g={board.grid_size} />}
              </svg>
            </div>
          </div>
          <BoardDiceOverlay roll={diceRoll} />
          <TokenTray serverId={serverId} board={board} at={centerPoint} />
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onPickFile(e.target.files)} />
        </div>
      </div>
    </div>
  );
}
