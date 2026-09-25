import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, errorMessage, upload } from '../api/http';
import { userAvatar } from '../lib/avatars';
import { formatDuration } from '../lib/format';
import { currentTrack, jukeboxPosition, player, setMyVolume, usePlayer } from '../lib/jukebox';
import { setCollapsed, useCollapsed } from '../lib/panelPrefs';
import { closeJukebox, openJukebox, openModal } from '../store/actions';
import { canControlJukebox, displayName, isDm } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { JukeboxTab } from '../store/store';
import type { JukeboxState, QueueEntry, Track } from '../store/types';
import {
  Icon,
  mdiClose,
  mdiCloudUpload,
  mdiDelete,
  mdiDotsHorizontal,
  mdiDragVertical,
  mdiHeadphones,
  mdiHeadphonesOff,
  mdiLink,
  mdiMagnify,
  mdiMusicNote,
  mdiPause,
  mdiPencil,
  mdiPlay,
  mdiPlaylistMusic,
  mdiPlaylistPlus,
  mdiRefresh,
  mdiRepeat,
  mdiRepeatOff,
  mdiRepeatOnce,
  mdiShuffleVariant,
  mdiSkipNext,
  mdiSkipPrevious,
  mdiTagOutline,
  mdiVolumeHigh,
  mdiVolumeOff,
  mdiWeatherNight,
  mdiLock,
  mdiLockOpenVariantOutline,
  mdiCheck,
  mdiEyeOutline,
  mdiEyeOffOutline,
} from './icons';
import { MenuItem, Modal, tip } from './layers';
import { toast } from './Toasts';
import { Button, Field, Slider, Spinner, Switch, TextInput } from './ui';
import { cropImage } from './ImageCropper';

async function control(serverId: number, action: string, value?: unknown) {
  try {
    await api.post(`/api/servers/${serverId}/jukebox/control`, { action, value });
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function enqueue(serverId: number, trackIds: number[], where: 'end' | 'next' | 'now') {
  try {
    await api.post(`/api/servers/${serverId}/jukebox/queue`, { track_ids: trackIds, where });
  } catch (err) {
    toast(errorMessage(err));
  }
}

function lockReason(serverId: number): string {
  const s = getState();
  return s.servers[serverId]?.roleplay_mode ? 'DM Lock is on: only Dungeon Masters can change the music' : 'Only DJs can change the music';
}

function Cover({ track, size = 64 }: { track?: Track; size?: number }) {
  return (
    <div className="jb-cover" style={{ width: size, height: size }}>
      {track?.cover_url ? <img src={track.cover_url} alt="" /> : <Icon path={mdiMusicNote} size={Math.round(size * 0.42)} />}
    </div>
  );
}

function Progress({ serverId, st, canControl }: { serverId: number; st: JukeboxState; canControl: boolean }) {
  const track = currentTrack(st);
  const listening = useStore((s) => !!s.listening[serverId]);
  // The player tick updates this while listening; otherwise run our own clock.
  const tickPos = usePlayer((p) => p.position);
  const [, force] = useState(0);
  useEffect(() => {
    if (listening) return;
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [listening]);
  const [drag, setDrag] = useState<number | null>(null);
  const duration = track?.duration_ms ?? 0;
  const pos = drag ?? (listening ? tickPos : jukeboxPosition(st));
  const clamped = Math.min(pos, duration || pos);
  return (
    <div className="jb-progress">
      <Slider
        className="jb-seek"
        value={duration ? clamped : 0}
        min={0}
        max={Math.max(1, duration)}
        step={250}
        disabled={!canControl || !track}
        label="Seek"
        onChange={(v) => setDrag(v)}
        onCommit={(v) => {
          setDrag(null);
          void control(serverId, 'seek', v);
        }}
      />
      <div className="jb-times">
        <span>{formatDuration(clamped)}</span>
        <span>{formatDuration(duration)}</span>
      </div>
    </div>
  );
}

/** The eye at the top of a card: open shows everything, closed folds it down to one line. */
export function CardEye({ name, label }: { name: 'jukebox' | 'theater'; label: string }) {
  const collapsed = useCollapsed(name);
  return (
    <button
      className={`card-eye ${collapsed ? 'closed' : ''}`}
      aria-label={collapsed ? `Show the ${label}` : `Hide the ${label}`}
      aria-pressed={!collapsed}
      onClick={() => setCollapsed(name, !collapsed)}
      {...tip(collapsed ? `Show the ${label}` : `Hide the ${label}`)}
    >
      <Icon path={collapsed ? mdiEyeOffOutline : mdiEyeOutline} size={18} />
    </button>
  );
}

/** A thin, read-only progress line for folded cards. */
export function MiniProgress({ position, duration, live }: { position: () => number; duration: number; live?: boolean }) {
  const [, force] = useState(0);
  useEffect(() => {
    const t = window.setInterval(() => force((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, []);
  const pct = duration > 0 ? Math.min(100, (position() / duration) * 100) : 0;
  return (
    <div className="card-mini-progress" aria-hidden>
      <div style={{ width: live ? '100%' : `${pct}%` }} />
    </div>
  );
}

function CollapsedJukebox({ serverId, st }: { serverId: number; st: JukeboxState }) {
  const canControl = useStore((s) => canControlJukebox(s, serverId));
  const listening = useStore((s) => !!s.listening[serverId]);
  const roleplay = useStore((s) => !!s.servers[serverId]?.roleplay_mode);
  const track = currentTrack(st);
  return (
    <section className={`jukebox-card collapsed ${roleplay ? 'roleplay' : ''}`} aria-label="Jukebox">
      <header className="jb-header">
        <Icon path={mdiMusicNote} size={18} className="jb-header-icon" />
        <span className="jb-title">Now Playing</span>
        <button className="jb-queue-link" onClick={() => openJukebox(serverId, 'queue')}>
          Queue{st.queue.length ? ` (${st.queue.length})` : ''}
        </button>
        <CardEye name="jukebox" label="jukebox" />
      </header>
      <div className="card-mini">
        {track ? (
          <>
            <Cover track={track} size={34} />
            <div className="card-mini-text">
              <div className="card-mini-title" title={track.title}>
                {track.title}
              </div>
              {track.artist && <div className="card-mini-sub">{track.artist}</div>}
            </div>
            {canControl && (
              <button className="jb-btn card-mini-btn" aria-label={st.playing ? 'Pause' : 'Play'} onClick={() => control(serverId, st.playing ? 'pause' : 'play')}>
                <Icon path={st.playing ? mdiPause : mdiPlay} size={20} />
              </button>
            )}
          </>
        ) : (
          <span className="card-mini-quiet">The jukebox is quiet.</span>
        )}
        <button
          className={`jb-btn card-mini-btn ${listening ? 'on' : ''}`}
          aria-label={listening ? 'Stop listening' : 'Listen in'}
          aria-pressed={listening}
          onClick={() => player.setListening(serverId, !listening)}
          {...tip(listening ? 'Listening. Click to stop.' : 'Listen in')}
        >
          <Icon path={listening ? mdiHeadphones : mdiHeadphonesOff} size={18} />
        </button>
      </div>
      {track && <MiniProgress position={() => jukeboxPosition(st)} duration={track.duration_ms} />}
    </section>
  );
}

/** "Now Playing Together" card at the top of the right-hand panel. */
export function JukeboxCard({ serverId }: { serverId: number }) {
  const collapsed = useCollapsed('jukebox');
  const st = useStore((s) => s.jukebox[serverId]);
  if (!st) return null;
  if (collapsed) return <CollapsedJukebox serverId={serverId} st={st} />;
  return <FullJukebox serverId={serverId} />;
}

function FullJukebox({ serverId }: { serverId: number }) {
  const st = useStore((s) => s.jukebox[serverId]);
  const canControl = useStore((s) => canControlJukebox(s, serverId));
  const roleplay = useStore((s) => !!s.servers[serverId]?.roleplay_mode);
  const listening = useStore((s) => !!s.listening[serverId]);
  const listeners = useStore(useShallow((s) => (s.jukebox[serverId]?.listeners ?? []).map((id) => s.users[id]).filter(Boolean)));
  const myVolume = usePlayer((p) => p.myVolume);
  const needsGesture = usePlayer((p) => p.needsGesture && listening);
  const buffering = usePlayer((p) => p.buffering && listening);
  const [showMaster, setShowMaster] = useState(false);

  if (!st) return null;
  const track = currentTrack(st);
  const locked = !canControl;
  const lockTip = locked ? lockReason(serverId) : undefined;
  const nextRepeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off';

  return (
    <section className={`jukebox-card ${roleplay ? 'roleplay' : ''}`} aria-label="Jukebox">
      <header className="jb-header">
        <Icon path={mdiMusicNote} size={20} className="jb-header-icon" />
        <span className="jb-title" {...tip('Everyone who listens in hears the same moment of the same song')}>
          Now Playing
        </span>
        <button className="jb-queue-link" onClick={() => openJukebox(serverId, 'queue')}>
          Queue{st.queue.length ? ` (${st.queue.length})` : ''}
        </button>
        <CardEye name="jukebox" label="jukebox" />
      </header>

      {track ? (
        <div className="jb-now">
          <Cover track={track} size={76} />
          <div className="jb-now-text">
            <div className="jb-track-title" title={track.title}>
              {track.title}
            </div>
            {track.artist && <div className="jb-track-artist">{track.artist}</div>}
            {track.tags.length > 0 && <div className="jb-track-tags">{track.tags.join(' • ')}</div>}
          </div>
        </div>
      ) : (
        <div className="jb-empty">
          <Icon path={mdiWeatherNight} size={28} />
          <p>The jukebox is quiet.</p>
          {canControl && (
            <Button size="small" look="outline" onClick={() => openJukebox(serverId, 'library')}>
              Open the Library
            </Button>
          )}
        </div>
      )}

      {track && <Progress serverId={serverId} st={st} canControl={canControl} />}

      {track && (
        <div className={`jb-controls ${locked ? 'locked' : ''}`} {...(lockTip ? tip(lockTip) : {})}>
          <button
            className={`jb-btn ${st.shuffle ? 'on' : ''}`}
            aria-label="Shuffle"
            disabled={locked}
            onClick={() => control(serverId, 'shuffle', !st.shuffle)}
            {...(!locked ? tip(st.shuffle ? 'Shuffle: on' : 'Shuffle: off') : {})}
          >
            <Icon path={mdiShuffleVariant} size={20} />
          </button>
          <button className="jb-btn" aria-label="Previous" disabled={locked} onClick={() => control(serverId, 'previous')}>
            <Icon path={mdiSkipPrevious} size={26} />
          </button>
          <button
            className="jb-btn jb-play"
            aria-label={st.playing ? 'Pause' : 'Play'}
            disabled={locked}
            onClick={() => control(serverId, st.playing ? 'pause' : 'play')}
          >
            {buffering && st.playing ? <Spinner size={18} /> : <Icon path={st.playing ? mdiPause : mdiPlay} size={28} />}
          </button>
          <button className="jb-btn" aria-label="Next" disabled={locked} onClick={() => control(serverId, 'skip')}>
            <Icon path={mdiSkipNext} size={26} />
          </button>
          <button
            className={`jb-btn ${st.repeat !== 'off' ? 'on' : ''}`}
            aria-label="Repeat"
            disabled={locked}
            onClick={() => control(serverId, 'repeat', nextRepeat)}
            {...(!locked ? tip(st.repeat === 'off' ? 'Repeat: off' : st.repeat === 'all' ? 'Repeat: queue' : 'Repeat: this song') : {})}
          >
            <Icon path={st.repeat === 'one' ? mdiRepeatOnce : st.repeat === 'all' ? mdiRepeat : mdiRepeatOff} size={20} />
          </button>
        </div>
      )}

      {needsGesture && (
        <button className="jb-gesture" onClick={() => player.sync(true)}>
          Click to start listening
        </button>
      )}

      <div className="jb-settings">
        <div className="jb-row">
          <Icon path={myVolume === 0 ? mdiVolumeOff : mdiVolumeHigh} size={18} className="jb-row-icon" />
          <span className="jb-row-label">My Volume</span>
          <Slider value={myVolume} onChange={setMyVolume} label="My volume" className="jb-slider" />
          <span className="jb-row-value">{myVolume}%</span>
        </div>
        {(canControl || showMaster) && (
          <div className={`jb-row ${!canControl ? 'locked' : ''}`}>
            <Icon path={mdiPlaylistMusic} size={18} className="jb-row-icon" />
            <span className="jb-row-label">Jukebox Volume</span>
            <MasterVolume serverId={serverId} value={st.volume} disabled={!canControl} />
            <span className="jb-row-value">{st.volume}%</span>
          </div>
        )}
        {canControl && (
          <div className="jb-row">
            <Icon path={mdiRefresh} size={18} className="jb-row-icon flip" />
            <span className="jb-row-label">Fade In/Out</span>
            <span className="jb-row-spacer" />
            <Switch checked={st.fade} onChange={(v) => control(serverId, 'fade', v)} label="Fade in and out" />
          </div>
        )}
        {!canControl && (
          <button className="jb-master-toggle" onClick={() => setShowMaster((v) => !v)}>
            {showMaster ? 'Hide jukebox volume' : `Jukebox volume: ${st.volume}%`}
          </button>
        )}
      </div>

      <footer className="jb-footer">
        <button
          className={`jb-listen ${listening ? 'on' : ''}`}
          onClick={() => player.setListening(serverId, !listening)}
          {...tip(listening ? 'Stop listening on this device' : 'Hear the jukebox in sync with everyone')}
        >
          <Icon path={listening ? mdiHeadphones : mdiHeadphonesOff} size={18} />
          {listening ? 'Listening' : 'Listen in'}
        </button>
        <div className="jb-listeners" {...tip(listeners.length ? listeners.map((u) => displayName(u)).join(', ') : 'Nobody is listening')}>
          {listeners.slice(0, 5).map((u) => (
            <img key={u.id} src={userAvatar(u)} alt="" />
          ))}
          {listeners.length > 5 && <span className="jb-more">+{listeners.length - 5}</span>}
        </div>
        {canControl && track && st.playing && (
          <button className="jb-fadeout" onClick={() => control(serverId, 'fade_out')} {...tip('Fade out and pause')}>
            Fade out
          </button>
        )}
      </footer>
    </section>
  );
}

function MasterVolume({ serverId, value, disabled }: { serverId: number; value: number; disabled: boolean }) {
  const [draft, setDraft] = useState<number | null>(null);
  return (
    <Slider
      value={draft ?? value}
      onChange={(v) => setDraft(v)}
      onCommit={(v) => {
        setDraft(null);
        if (v !== value) void control(serverId, 'volume', v);
      }}
      disabled={disabled}
      label="Jukebox volume"
      className="jb-slider"
    />
  );
}

// ---------------------------------------------------------------------------
// Queue & library window
// ---------------------------------------------------------------------------

async function loadLibrary(serverId: number) {
  try {
    const res = await api.get<{ tracks: Track[]; imports_enabled: boolean; spotify?: boolean; max_track_mb: number }>(`/api/servers/${serverId}/jukebox/tracks`);
    setState((s) => ({
      libraries: {
        ...s.libraries,
        [serverId]: {
          tracks: Object.fromEntries(res.tracks.map((t) => [t.id, t])),
          loaded: true,
          importsEnabled: res.imports_enabled,
          spotify: !!res.spotify,
          maxTrackMb: res.max_track_mb,
        },
      },
    }));
  } catch (err) {
    toast(errorMessage(err));
  }
}

export function JukeboxWindowHost() {
  const view = useStore((s) => s.jukeboxView);
  if (!view) return null;
  return <JukeboxWindow serverId={view.serverId} tab={view.tab} />;
}

function JukeboxWindow({ serverId, tab }: { serverId: number; tab: JukeboxTab }) {
  const server = useStore((s) => s.servers[serverId]);
  const canControl = useStore((s) => canControlJukebox(s, serverId));
  const importsOn = useStore((s) => s.libraries[serverId]?.importsEnabled ?? false);
  useEffect(() => {
    void loadLibrary(serverId);
  }, [serverId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !getState().modals.length && closeJukebox();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!server) return null;
  return (
    <div className="modal-root jukebox-root" onMouseDown={(e) => e.target === e.currentTarget && closeJukebox()}>
      <div className="jukebox-window" role="dialog" aria-modal aria-label="Jukebox">
        <header className="jw-header">
          <Icon path={mdiMusicNote} size={22} />
          <h2>Jukebox</h2>
          <nav className="jw-tabs">
            <button className={tab === 'queue' ? 'active' : ''} onClick={() => openJukebox(serverId, 'queue')}>
              Queue
            </button>
            <button className={tab === 'library' ? 'active' : ''} onClick={() => openJukebox(serverId, 'library')}>
              Library
            </button>
            {canControl && importsOn && (
              <button className={tab === 'search' ? 'active' : ''} onClick={() => openJukebox(serverId, 'search')}>
                <Icon path={mdiMagnify} size={16} />
                Find Music
              </button>
            )}
          </nav>
          {!canControl && <span className="jw-locked">{lockReason(serverId)}</span>}
          <button className="jw-close" aria-label="Close" onClick={closeJukebox}>
            <Icon path={mdiClose} size={22} />
          </button>
        </header>
        <div className="jw-body scroller-thin">
          {tab === 'queue' ? <QueueTab serverId={serverId} /> : tab === 'search' && canControl ? <SearchTab serverId={serverId} /> : <LibraryTab serverId={serverId} />}
        </div>
      </div>
    </div>
  );
}

function TrackRow({
  track,
  entry,
  serverId,
  current,
  actions,
  dragProps,
  className,
}: {
  track?: Track;
  entry?: QueueEntry;
  serverId: number;
  current?: boolean;
  actions?: React.ReactNode;
  dragProps?: Record<string, unknown>;
  className?: string;
}) {
  const adder = useStore((s) => (entry?.added_by ? s.users[entry.added_by] : undefined));
  if (!track) return null;
  void serverId;
  return (
    <div className={`jw-track ${current ? 'current' : ''} ${track.status !== 'ready' ? track.status : ''} ${className ?? ''}`} {...dragProps}>
      {dragProps && <Icon path={mdiDragVertical} size={18} className="jw-drag" />}
      <Cover track={track} size={40} />
      <div className="jw-track-text">
        <div className="jw-track-title">
          {current && <span className="jw-now-badge">Now</span>}
          {track.title}
        </div>
        <div className="jw-track-sub">
          {track.artist && <span>{track.artist}</span>}
          {track.tags.map((t) => (
            <span key={t} className="jw-tag">
              {t}
            </span>
          ))}
          {adder && <span className="jw-added">added by {displayName(adder)}</span>}
        </div>
        {track.status === 'processing' && (
          <div className="jw-processing">
            <div className="jw-processing-bar" style={{ width: `${Math.round((track.progress ?? 0) * 100)}%` }} />
            <span>{track.progress ? `Downloading ${Math.round(track.progress * 100)}%` : 'Processing…'}</span>
          </div>
        )}
        {track.status === 'failed' && <div className="jw-error">{track.error ?? 'Failed'}</div>}
      </div>
      <span className="jw-duration">{track.duration_ms ? formatDuration(track.duration_ms) : ''}</span>
      <div className="jw-actions">{actions}</div>
    </div>
  );
}

function QueueTab({ serverId }: { serverId: number }) {
  const st = useStore((s) => s.jukebox[serverId]);
  const library = useStore((s) => s.libraries[serverId]);
  const canControl = useStore((s) => canControlJukebox(s, serverId));
  const [dragQid, setDragQid] = useState<string | null>(null);
  const [overQid, setOverQid] = useState<string | null>(null);
  if (!st) return null;
  const trackOf = (e: QueueEntry) => library?.tracks[e.track_id] ?? st.tracks[String(e.track_id)];
  const current = st.current ? trackOf(st.current) : undefined;

  const drop = async () => {
    const from = dragQid;
    const to = overQid;
    setDragQid(null);
    setOverQid(null);
    if (!from || !to || from === to) return;
    // Dropped on a row further down: it goes after that row (so the last place can be reached).
    const all = st.queue.map((e) => e.qid);
    const down = all.indexOf(from) < all.indexOf(to);
    const qids = all.filter((q) => q !== from);
    qids.splice(qids.indexOf(to) + (down ? 1 : 0), 0, from);
    try {
      await api.put(`/api/servers/${serverId}/jukebox/queue`, { qids });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <div className="jw-queue">
      <h3 className="jw-section">Now Playing</h3>
      {current ? (
        <TrackRow track={current} entry={st.current!} serverId={serverId} current />
      ) : (
        <p className="jw-muted">Nothing is playing. {canControl ? 'Add something from the Library.' : ''}</p>
      )}
      <div className="jw-section-row">
        <h3 className="jw-section">Up Next{st.queue.length ? ` — ${st.queue.length}` : ''}</h3>
        {canControl && st.queue.length > 0 && (
          <Button
            size="small"
            look="outline"
            onClick={() =>
              openModal((close) => (
                <ClearQueueModal
                  onClose={close}
                  onConfirm={async () => {
                    await api.del(`/api/servers/${serverId}/jukebox/queue`);
                  }}
                />
              ))
            }
          >
            Clear Queue
          </Button>
        )}
      </div>
      {st.queue.length === 0 && <p className="jw-muted">The queue is empty.</p>}
      <div className="jw-list">
        {st.queue.map((e) => (
          <TrackRow
            key={e.qid}
            track={trackOf(e)}
            entry={e}
            serverId={serverId}
            className={overQid === e.qid && dragQid !== e.qid ? 'drop-target' : ''}
            dragProps={
              canControl
                ? {
                    draggable: true,
                    onDragStart: (ev: DragEvent) => {
                      ev.dataTransfer.effectAllowed = 'move';
                      setDragQid(e.qid);
                    },
                    onDragOver: (ev: DragEvent) => {
                      ev.preventDefault();
                      if (overQid !== e.qid) setOverQid(e.qid);
                    },
                    onDrop: (ev: DragEvent) => {
                      ev.preventDefault();
                      void drop();
                    },
                    onDragEnd: () => {
                      setDragQid(null);
                      setOverQid(null);
                    },
                  }
                : undefined
            }
            actions={
              canControl && (
                <>
                  <button className="jw-action" aria-label="Play now" {...tip('Play now')} onClick={() => playQueued(serverId, e)}>
                    <Icon path={mdiPlay} size={18} />
                  </button>
                  <button
                    className="jw-action danger"
                    aria-label="Remove from queue"
                    {...tip('Remove')}
                    onClick={() => api.del(`/api/servers/${serverId}/jukebox/queue/${e.qid}`).catch((err) => toast(errorMessage(err)))}
                  >
                    <Icon path={mdiClose} size={18} />
                  </button>
                </>
              )
            }
          />
        ))}
      </div>
      {st.history.length > 0 && (
        <>
          <h3 className="jw-section">Recently Played</h3>
          <div className="jw-list faded">
            {[...st.history]
              .reverse()
              .slice(0, 8)
              .map((e) => (
                <TrackRow
                  key={`h${e.qid}`}
                  track={trackOf(e)}
                  entry={e}
                  serverId={serverId}
                  actions={
                    canControl && (
                      <button className="jw-action" aria-label="Queue again" {...tip('Queue again')} onClick={() => enqueue(serverId, [e.track_id], 'end')}>
                        <Icon path={mdiPlaylistPlus} size={18} />
                      </button>
                    )
                  }
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

async function playQueued(serverId: number, e: QueueEntry) {
  // Straight to that entry (a reorder-then-skip would be a random pick with shuffle on).
  try {
    await api.post(`/api/servers/${serverId}/jukebox/control`, { action: 'jump', value: e.qid });
  } catch (err) {
    toast(errorMessage(err));
  }
}

export function ClearQueueModal({ onClose, onConfirm, text }: { onClose: () => void; onConfirm: () => Promise<void>; text?: string }) {
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title="Clear the queue?"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button
            look="danger"
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                toast(errorMessage(err));
                setLoading(false);
              }
            }}
          >
            Clear Queue
          </Button>
        </>
      }
    >
      <p className="modal-text">{text ?? 'Everything after the current song will be removed from the queue. The library keeps every track.'}</p>
    </Modal>
  );
}

function LibraryTab({ serverId }: { serverId: number }) {
  const library = useStore((s) => s.libraries[serverId]);
  const canControl = useStore((s) => canControlJukebox(s, serverId));
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [importing, setImporting] = useState(false);
  const [uploading, setUploading] = useState<{ index: number; count: number; progress: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const tracks = useMemo(() => Object.values(library?.tracks ?? {}).sort((a, b) => b.id - a.id), [library]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of tracks) for (const g of t.tags) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  }, [tracks]);
  const q = query.trim().toLowerCase();
  const shown = tracks.filter(
    (t) =>
      (!tag || t.tags.includes(tag)) &&
      (!q || t.title.toLowerCase().includes(q) || (t.artist ?? '').toLowerCase().includes(q) || t.tags.some((g) => g.toLowerCase().includes(q))),
  );

  if (!library?.loaded) {
    return (
      <div className="jw-loading">
        <Spinner />
      </div>
    );
  }

  const doImport = async (e: FormEvent) => {
    e.preventDefault();
    if (!url.trim()) return;
    setImporting(true);
    try {
      await api.post(`/api/servers/${serverId}/jukebox/import`, { url: url.trim(), tags: tag ? [tag] : [] });
      setUrl('');
      toast('Importing… it will show up below when it’s ready.', 'info');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setImporting(false);
    }
  };

  // One song per request: tunnels and proxies cap each request (Cloudflare's free plan at 100 MB).
  const doUpload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (fileInput.current) fileInput.current.value = '';
    if (!list.length) return;
    for (let i = 0; i < list.length; i++) {
      const form = new FormData();
      form.append('files', list[i]);
      form.append('tags', JSON.stringify(tag ? [tag] : []));
      setUploading({ index: i, count: list.length, progress: 0 });
      try {
        await upload('POST', `/api/servers/${serverId}/jukebox/tracks`, form, (p) => setUploading({ index: i, count: list.length, progress: p })).promise;
      } catch (err) {
        toast(`${list[i].name}: ${errorMessage(err)}`);
      }
    }
    setUploading(null);
  };

  const readyShown = shown.filter((t) => t.status === 'ready');

  return (
    <div className="jw-library">
      {canControl && (
        <div className="jw-add">
          <button className="jw-upload" onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
            <Icon path={mdiCloudUpload} size={20} />
            {uploading !== null
              ? `Uploading${uploading.count > 1 ? ` ${uploading.index + 1} of ${uploading.count}` : ''} · ${Math.round(uploading.progress * 100)}%`
              : 'Upload Songs'}
          </button>
          <input ref={fileInput} type="file" accept="audio/*,.mp3,.m4a,.flac,.wav,.ogg,.opus,.aac,.webm" multiple hidden onChange={(e) => doUpload(e.target.files)} />
          {library.importsEnabled ? (
            <form className="jw-import" onSubmit={doImport}>
              <Icon path={mdiLink} size={18} />
              <input
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder={`Paste a YouTube, SoundCloud, Bandcamp${library.spotify ? ' or Spotify' : ''} link (playlists work too)`}
              />
              <Button size="small" type="submit" loading={importing} disabled={!url.trim()}>
                Import
              </Button>
            </form>
          ) : (
            <span className="jw-muted">Link imports are off on this server.</span>
          )}
          {library.importsEnabled && library.spotify && <SpotifyConnect />}
        </div>
      )}
      <div className="jw-filter">
        <div className="search-input">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the library" />
          <Icon path={mdiMagnify} size={18} />
        </div>
        <div className="jw-tags">
          <button className={`jw-tag-chip ${tag === null ? 'on' : ''}`} onClick={() => setTag(null)}>
            All
          </button>
          {tags.map((g) => (
            <button key={g} className={`jw-tag-chip ${tag === g ? 'on' : ''}`} onClick={() => setTag(tag === g ? null : g)}>
              <Icon path={mdiTagOutline} size={13} />
              {g}
            </button>
          ))}
        </div>
        {canControl && readyShown.length > 1 && (
          <Button size="small" look="secondary" onClick={() => enqueue(serverId, readyShown.map((t) => t.id).reverse().slice(0, 500), 'end')}>
            Queue all {Math.min(readyShown.length, 500)}
          </Button>
        )}
      </div>
      {tracks.length === 0 && (
        <div className="jw-empty">
          <Icon path={mdiMusicNote} size={36} />
          <p>The library is empty.{canControl ? ' Upload some songs or import a link to get started.' : ''}</p>
        </div>
      )}
      <div className="jw-list">
        {shown.map((t) => (
          <TrackRow
            key={t.id}
            track={t}
            serverId={serverId}
            actions={
              canControl && (
                <>
                  {t.status === 'ready' && (
                    <>
                      <button className="jw-action" aria-label="Play now" {...tip('Play now')} onClick={() => enqueue(serverId, [t.id], 'now')}>
                        <Icon path={mdiPlay} size={18} />
                      </button>
                      <button className="jw-action" aria-label="Add to queue" {...tip('Add to queue')} onClick={() => enqueue(serverId, [t.id], 'end')}>
                        <Icon path={mdiPlaylistPlus} size={18} />
                      </button>
                    </>
                  )}
                  <TrackMenuButton serverId={serverId} track={t} />
                </>
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Find Music: search YouTube, add to the queue or the library in one click
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  title: string;
  channel: string | null;
  duration_ms: number | null;
  url: string;
  thumbnail: string;
  track_id: number | null;
  track_status: string | null;
}

/** The last search per server, so switching tabs doesn't lose it. */
const lastSearch: Record<number, { q: string; results: SearchResult[] }> = {};

function SearchTab({ serverId }: { serverId: number }) {
  const library = useStore((s) => s.libraries[serverId]);
  const [q, setQ] = useState(() => lastSearch[serverId]?.q ?? '');
  const [results, setResults] = useState<SearchResult[] | null>(() => lastSearch[serverId]?.results ?? null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'queue' | 'library'>>({});
  const input = useRef<HTMLInputElement>(null);
  // YouTube videos already in the library (including ones still downloading).
  const haveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const t of Object.values(library?.tracks ?? {})) {
      const m = t.status !== 'failed' && t.source_url?.match(/(?:[?&]v=|youtu\.be\/|\/shorts\/)([\w-]{11})/);
      if (m) ids.add(m[1]);
    }
    return ids;
  }, [library]);

  useEffect(() => input.current?.focus(), []);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    try {
      const res = await api.get<{ results: SearchResult[] }>(`/api/servers/${serverId}/jukebox/search?q=${encodeURIComponent(query)}`);
      setResults(res.results);
      lastSearch[serverId] = { q: query, results: res.results };
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const add = async (r: SearchResult, queue: boolean) => {
    setBusy(`${r.id}:${queue ? 'queue' : 'library'}`);
    try {
      const res = await api.post<{ track: Track; existing?: boolean }>(`/api/servers/${serverId}/jukebox/import`, {
        url: r.url,
        title: r.title,
        queue: queue ? 'end' : null,
      });
      setDone((d) => ({ ...d, [r.id]: queue ? 'queue' : 'library' }));
      if (queue) {
        toast(
          res.existing && res.track.status === 'ready' ? `Queued “${res.track.title}”.` : `Downloading “${r.title}”. It joins the queue when it’s ready.`,
          'success',
        );
      } else {
        toast(res.existing ? 'That one is already in the library.' : `Adding “${r.title}” to the library…`, 'info');
      }
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="jw-search">
      <form className="jw-search-form" onSubmit={search}>
        <div className="search-input">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search YouTube for songs, ambience, soundtracks…" maxLength={200} />
          <Icon path={mdiMagnify} size={18} />
        </div>
        <Button type="submit" loading={loading} disabled={!q.trim()}>
          Search
        </Button>
      </form>
      {results === null && !loading && (
        <div className="jw-empty">
          <Icon path={mdiMagnify} size={36} />
          <p>Find a song on YouTube, then add it to the queue or keep it in the library.</p>
          {library?.spotify && <p className="jw-muted">Spotify links go in the box on the Library tab.</p>}
        </div>
      )}
      {loading && !results && (
        <div className="jw-loading">
          <Spinner />
        </div>
      )}
      {results && results.length === 0 && !loading && (
        <div className="jw-empty">
          <p>Nothing found. Try other words.</p>
        </div>
      )}
      {results && results.length > 0 && (
        <div className={`jw-results ${loading ? 'stale' : ''}`}>
          {results.map((r) => {
            const inLibrary = haveIds.has(r.id) || r.track_id !== null || done[r.id] !== undefined;
            const queued = done[r.id] === 'queue';
            return (
              <div key={r.id} className="jw-result">
                <a className="jw-result-thumb" href={r.url} target="_blank" rel="noreferrer noopener" {...tip('Open on YouTube')}>
                  <img src={r.thumbnail} alt="" loading="lazy" />
                  {r.duration_ms ? <span className="jw-result-time">{formatDuration(r.duration_ms)}</span> : null}
                </a>
                <div className="jw-result-text">
                  <div className="jw-result-title" title={r.title}>
                    {r.title}
                  </div>
                  <div className="jw-result-sub">
                    {r.channel}
                    {inLibrary && <span className="jw-result-have">In library</span>}
                  </div>
                </div>
                <div className="jw-result-actions">
                  <Button size="small" onClick={() => add(r, true)} loading={busy === `${r.id}:queue`} className={queued ? 'done' : ''}>
                    <Icon path={queued ? mdiCheck : mdiPlaylistPlus} size={16} />
                    {queued ? 'Queued' : 'Add to Queue'}
                  </Button>
                  <Button size="small" look="secondary" onClick={() => add(r, false)} loading={busy === `${r.id}:library`} disabled={inLibrary}>
                    {inLibrary ? 'In Library' : 'Add to Library'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Songs and albums from Spotify just work; playlists need the owner's Spotify sign-in. */
function SpotifyConnect() {
  const [st, setSt] = useState<{ configured: boolean; connected: boolean; name: string | null } | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      void api
        .get<{ configured: boolean; connected: boolean; name: string | null }>('/api/spotify/status')
        .then((res) => alive && setSt(res))
        .catch(() => undefined);
    load();
    // Coming back from the Spotify sign-in window.
    window.addEventListener('focus', load);
    return () => {
      alive = false;
      window.removeEventListener('focus', load);
    };
  }, []);
  if (!st?.configured) return null;
  const connect = async () => {
    // Open the window right away (inside the click) so it isn't blocked as a popup.
    const w = window.open('', 'tavern-spotify', 'width=520,height=760');
    try {
      const { url } = await api.get<{ url: string }>('/api/spotify/connect');
      if (w) w.location.href = url;
      else window.location.href = url;
    } catch (err) {
      w?.close();
      toast(errorMessage(err));
    }
  };
  const disconnect = async () => {
    try {
      await api.del('/api/spotify/connection');
      setSt((s) => (s ? { ...s, connected: false, name: null } : s));
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  return (
    <div className="jw-spotify">
      {st.connected ? (
        <>
          Spotify connected{st.name ? ` as ${st.name}` : ''}: your own playlists can be imported.{' '}
          <button className="link-button" onClick={disconnect}>
            Disconnect
          </button>
        </>
      ) : (
        <>
          Spotify songs and albums import as they are. For your playlists,{' '}
          <button className="link-button" onClick={connect}>
            connect your Spotify account
          </button>
          .
        </>
      )}
    </div>
  );
}

function TrackMenuButton({ serverId, track }: { serverId: number; track: Track }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="jw-menu-wrap">
      <button className="jw-action" aria-label="More" onClick={() => setOpen((v) => !v)}>
        <Icon path={mdiDotsHorizontal} size={18} />
      </button>
      {open && (
        <div className="menu jw-menu" onMouseLeave={() => setOpen(false)}>
          {track.status === 'ready' && <MenuItem label="Play Next" onClick={() => (setOpen(false), void enqueue(serverId, [track.id], 'next'))} />}
          <MenuItem
            label="Edit Details"
            icon={mdiPencil}
            onClick={() => {
              setOpen(false);
              openModal((close) => <TrackEditModal serverId={serverId} track={track} onClose={close} />);
            }}
          />
          {track.status === 'failed' && track.source_url && (
            <MenuItem
              label="Try Again"
              icon={mdiRefresh}
              onClick={() => {
                setOpen(false);
                api.post(`/api/servers/${serverId}/jukebox/tracks/${track.id}/retry`).catch((err) => toast(errorMessage(err)));
              }}
            />
          )}
          {track.source_url && (
            <MenuItem label="Open Source Link" icon={mdiLink} onClick={() => (setOpen(false), window.open(track.source_url!, '_blank', 'noopener'))} />
          )}
          <MenuItem
            label="Delete from Library"
            danger
            icon={mdiDelete}
            onClick={() => {
              setOpen(false);
              api.del(`/api/servers/${serverId}/jukebox/tracks/${track.id}`).catch((err) => toast(errorMessage(err)));
            }}
          />
        </div>
      )}
    </div>
  );
}

function TrackEditModal({ serverId, track, onClose }: { serverId: number; track: Track; onClose: () => void }) {
  const [title, setTitle] = useState(track.title);
  const [artist, setArtist] = useState(track.artist ?? '');
  const [tags, setTags] = useState(track.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const cover = useRef<HTMLInputElement>(null);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/servers/${serverId}/jukebox/tracks/${track.id}`, {
        title,
        artist,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  const setCover = async (files: FileList | null) => {
    if (!files?.[0]) return;
    const cropped = await cropImage(files[0], { shape: 'square', title: 'Edit Cover' });
    if (!cropped) return;
    const form = new FormData();
    form.append('file', cropped);
    try {
      await upload('PUT', `/api/servers/${serverId}/jukebox/tracks/${track.id}/cover`, form).promise;
      toast('Cover updated.', 'success');
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  return (
    <Modal
      title="Edit Track"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!title.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="track-edit">
        <button className="track-edit-cover" onClick={() => cover.current?.click()} {...tip('Change cover')}>
          <Cover track={track} size={96} />
          <span>Change</span>
        </button>
        <input
          ref={cover}
          type="file"
          accept="image/*"
          hidden
          onChange={(e) => {
            void setCover(e.target.files);
            e.target.value = '';
          }}
        />
        <div className="track-edit-fields">
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Artist">
            <TextInput value={artist} onChange={(e) => setArtist(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Tags" hint="Comma separated, like Ambient, Tavern, Combat">
            <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}

/** The "DM Lock" switch at the top of the right-hand panel: while it's on, only
 *  Dungeon Masters run the jukebox and the theater, and the member list shows
 *  who's in session. */
export function RoleplayToggle({ serverId }: { serverId: number }) {
  const on = useStore((s) => !!s.servers[serverId]?.roleplay_mode);
  const dm = useStore((s) => isDm(s, serverId));
  if (!dm && !on) return null;
  const toggle = async () => {
    try {
      await api.put(`/api/servers/${serverId}/roleplay`, { enabled: !on });
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  return (
    <button
      className={`roleplay-toggle ${on ? 'on' : ''}`}
      disabled={!dm}
      onClick={toggle}
      aria-pressed={on}
      {...tip(
        dm
          ? on
            ? 'Unlock the jukebox and theater so DJs can run them again'
            : 'Lock the jukebox and theater so only Dungeon Masters can run them (and show who is in session)'
          : 'DM Lock is on: only Dungeon Masters can run the jukebox and theater',
      )}
    >
      <Icon path={on ? mdiLock : mdiLockOpenVariantOutline} size={14} className="roleplay-lock" />
      {on ? 'DM Lock On' : 'DM Lock Off'}
    </button>
  );
}
