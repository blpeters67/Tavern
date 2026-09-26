/** The game board: a shared battle map everyone looks at together, like the
 * theater but for the table. A saved board per server with a background
 * picture, a grid, character tokens (green allies, grey neutrals, red
 * enemies), and a chat column beside it. */
import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, errorMessage, upload } from '../api/http';
import { gateway } from '../api/gateway';
import { characterAvatar, userAvatar } from '../lib/avatars';
import { on } from '../lib/events';
import { useCollapsed } from '../lib/panelPrefs';
import { closeBoard, openBoard, openContextMenu, openModal, openSheet } from '../store/actions';
import { canControlBoard, displayName, myCharacters } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Board, BoardToken, Channel, Character, Disposition, ServerBoard } from '../store/types';
import { ChannelType } from '../store/types';
import {
  Icon,
  mdiAccountPlus,
  mdiArrowExpand,
  mdiChevronDown,
  mdiClose,
  mdiCursorDefault,
  mdiImage,
  mdiMinus,
  mdiPencil,
  mdiPlus,
  mdiTrashCanOutline,
  mdiViewGrid,
} from './icons';
import { CardEye } from './Jukebox';
import { MenuItem, Modal, tip } from './layers';
import { toast } from './Toasts';
import { Avatar, Button, Field, TextInput } from './ui';
import ChatView from './ChatView';

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
  position,
  dragging,
  canEdit,
  image,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onContextMenu,
}: {
  t: BoardToken;
  g: number;
  position: { x: number; y: number };
  dragging: boolean;
  canEdit: boolean;
  image: string | null;
  onPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onPointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onContextMenu: (e: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const d = t.size * g;
  const hpPct = t.hp && t.hp.max > 0 ? Math.max(0, Math.min(1, t.hp.current / t.hp.max)) : null;
  const hpTone = hpPct === null ? '' : hpPct > 0.5 ? 'good' : hpPct > 0.25 ? 'mid' : 'low';
  return (
    <div
      className={`board-token ${t.disposition} ${dragging ? 'dragging' : ''} ${canEdit ? 'editable' : ''}`}
      style={{ width: d, height: d, transform: `translate(${position.x - d / 2}px, ${position.y - d / 2}px)` }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      onDragStart={(e) => e.preventDefault()}
      onContextMenu={onContextMenu}
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
}) {
  const users = useStore((s) => s.users);
  const [menuOpen, setMenuOpen] = useState(false);
  const board = sb.board;
  return (
    <div className="board-top">
      <div className="board-title-wrap">
        {canControl && board ? (
          <button className="board-title-button" onClick={() => setMenuOpen((v) => !v)} {...tip('Boards: switch, rename, background, grid')}>
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
        <button className="board-icon-btn" aria-label="Fit to screen" onClick={onFit} {...tip('Fit the board to the screen')}>
          <Icon path={mdiArrowExpand} size={17} />
        </button>
        <button className={`board-icon-btn ${gridOn ? 'on' : ''}`} aria-label="Toggle the grid" onClick={onGridToggle} {...tip(gridOn ? 'Hide the grid' : 'Show the grid')}>
          <Icon path={mdiViewGrid} size={17} />
        </button>
      </div>
      <div className="board-viewers">
        {sb.viewers.map((id) => (users[id] ? <Avatar key={id} src={userAvatar(users[id])} size={22} {...tip(`${displayName(users[id])} has the board open`)} /> : null))}
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
  const [view, setView] = useState({ x: 0, y: 0, z: 1 });
  const [gridOn, setGridOn] = useState(true);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const panRef = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null);
  const dragRef = useRef<{ id: number; dx: number; dy: number; sx: number; sy: number; px: number; py: number; moved: boolean; last: number } | null>(null);
  const [dragPos, setDragPos] = useState<{ id: number; x: number; y: number } | null>(null);
  const board = sb?.board ?? null;
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Escape closes the board only when nothing else (a modal, a sheet, a menu) is up.
      const s = getState();
      if (e.key === 'Escape' && !s.modals.length && !s.sheetView && !s.contextMenu) closeBoard();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

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

  const onStagePointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return;
    const el = stageRef.current;
    if (!el) return;
    el.setPointerCapture(e.pointerId);
    panRef.current = { sx: e.clientX, sy: e.clientY, ox: viewRef.current.x, oy: viewRef.current.y };
  };
  const onStagePointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const p = panRef.current;
    if (!p) return;
    setView((v) => ({ ...v, x: p.ox + (e.clientX - p.sx), y: p.oy + (e.clientY - p.sy) }));
  };
  const onStagePointerUp = () => {
    panRef.current = null;
  };

  const patchToken = async (tokenId: number, body: Record<string, unknown>) => {
    if (!board) return;
    try {
      await api.patch(`/api/servers/${serverId}/board/boards/${board.id}/tokens/${tokenId}`, body);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const canMoveToken = (t: BoardToken): boolean => {
    const s = getState();
    if (canControlBoard(s, serverId)) return true;
    const me = s.me;
    if (!me || t.character_id === null) return false;
    const ch = s.characters[t.character_id];
    return !!ch && ch.owner_id === me.id;
  };

  const tokenPointerDown = (t: BoardToken) => (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    if (!canMoveToken(t)) return; // let the board pan from over a token you can't move
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const w = toWorld(e.clientX, e.clientY);
    dragRef.current = { id: t.id, dx: t.x - w.x, dy: t.y - w.y, sx: w.x, sy: w.y, px: t.x, py: t.y, moved: false, last: 0 };
    setDragPos({ id: t.id, x: t.x, y: t.y });
  };

  const tokenPointerMove = (t: BoardToken) => (e: ReactPointerEvent<HTMLDivElement>) => {
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
      void patchToken(t.id, { x: r1(x), y: r1(y) });
    }
  };

  const tokenPointerUp = (t: BoardToken) => () => {
    const d = dragRef.current;
    dragRef.current = null;
    setDragPos(null);
    if (!d || d.id !== t.id) return;
    if (!d.moved) {
      // A click, not a drag: a character's sheet opens.
      if (t.character_id !== null) openSheet(t.character_id, serverId);
      return;
    }
    const s = snapPoint(board, d.px, d.py);
    void patchToken(t.id, { x: s.x, y: s.y });
  };

  const tokenContextMenu = (t: BoardToken) => (e: React.MouseEvent<HTMLDivElement>) => {
    const s = getState();
    const control = canControlBoard(s, serverId);
    const me = s.me;
    const own = t.character_id !== null && !!me && s.characters[t.character_id]?.owner_id === me.id;
    if (!control && !own) return;
    e.preventDefault();
    const b = board;
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
              void patchToken(t.id, { disposition: d });
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
  };

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
        <aside className="board-chat">
          {channel && channel.type !== ChannelType.VOICE ? <ChatColumn channel={channel} /> : <div className="board-chat-empty">Pick a text channel to chat here.</div>}
        </aside>
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
        />
        <div className="board-stage-wrap">
          <div
            ref={stageRef}
            className="board-stage"
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
              {board.tokens.map((t) => {
                const pos = dragPos && dragPos.id === t.id ? dragPos : { x: t.x, y: t.y };
                return (
                  <TokenView
                    key={t.id}
                    t={t}
                    g={board.grid_size}
                    position={pos}
                    dragging={!!dragPos && dragPos.id === t.id}
                    canEdit={canMoveToken(t)}
                    image={tokenImage(t, characters)}
                    onPointerDown={tokenPointerDown(t)}
                    onPointerMove={tokenPointerMove(t)}
                    onPointerUp={tokenPointerUp(t)}
                    onContextMenu={tokenContextMenu(t)}
                  />
                );
              })}
            </div>
          </div>
          <div className="board-tools">
            <button className="board-tool active" aria-label="Select and move" {...tip('Select — drag the board to move it, drag your token to move it')}>
              <Icon path={mdiCursorDefault} size={20} />
            </button>
            {canControl && (
              <button
                className="board-tool"
                aria-label="Place a token"
                onClick={() => openModal((close) => <NewTokenModal serverId={serverId} board={board} at={centerPoint} onClose={close} />)}
                {...tip('Place a token')}
              >
                <Icon path={mdiAccountPlus} size={20} />
              </button>
            )}
            {canControl && (
              <button className="board-tool" aria-label="Change the background" onClick={() => fileInput.current?.click()} {...tip('Change the background picture')}>
                <Icon path={mdiImage} size={20} />
              </button>
            )}
          </div>
          <TokenTray serverId={serverId} board={board} at={centerPoint} />
          <input ref={fileInput} type="file" accept="image/*" hidden onChange={(e) => onPickFile(e.target.files)} />
        </div>
      </div>
      <aside className="board-chat">
        {channel && channel.type !== ChannelType.VOICE ? <ChatColumn channel={channel} /> : <div className="board-chat-empty">Pick a text channel to chat here.</div>}
      </aside>
    </div>
  );
}

/** The chat beside the board is the real channel: the same messages, the same dice. */
function ChatColumn({ channel }: { channel: Channel }) {
  return (
    <div className="board-chat-inner">
      <ChatView key={channel.id} channel={channel} />
    </div>
  );
}
