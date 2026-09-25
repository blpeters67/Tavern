/**
 * The theater card in the right-hand panel, and the screen itself.
 *
 * The screen (the player) lives in one fixed box at the top of the page that
 * is never moved around the page: moving an iframe reloads it. The box is laid
 * over the card's screen spot when that's in view ("docked"), floats in a
 * corner when it isn't (the card is folded, the panel is closed or scrolled,
 * a full-screen layer is open), or grows into a big screen. Picture-in-picture
 * is the one move that can't be avoided: the player goes into the new window
 * and starts again there, in step with everyone.
 */
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from 'react';
import { createRoot } from 'react-dom/client';
import { useShallow } from 'zustand/react/shallow';
import { userAvatar } from '../lib/avatars';
import { formatDuration } from '../lib/format';
import { setCollapsed, useCollapsed } from '../lib/panelPrefs';
import { load, save } from '../lib/storage';
import {
  aspectOf,
  currentVideo,
  seatedServer,
  theater,
  theaterControl,
  theaterPosition,
  useSeated,
  useTheater,
  type Placement,
  type ScreenMode,
} from '../lib/theater';
import { go, openTheater } from '../store/actions';
import { canControlTheater, displayName } from '../store/selectors';
import { getState, persistUi, setState, useStore } from '../store/store';
import type { TheaterState, Video } from '../store/types';
import {
  Icon,
  mdiAlertCircle,
  mdiArrowCollapse,
  mdiArrowExpand,
  mdiClose,
  mdiDockRight,
  mdiDockWindow,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiMovieOpen,
  mdiMovieOpenPlay,
  mdiPause,
  mdiPictureInPictureBottomRight,
  mdiPlay,
  mdiRepeat,
  mdiRepeatOff,
  mdiRepeatOnce,
  mdiResizeBottomRight,
  mdiShuffleVariant,
  mdiSkipNext,
  mdiSkipPrevious,
  mdiSofaSingle,
  mdiSofaSingleOutline,
  mdiSync,
  mdiVolumeHigh,
  mdiVolumeOff,
  mdiWeatherNight,
} from './icons';
import { CardEye, MiniProgress } from './Jukebox';
import { tip } from './layers';
import { toast } from './Toasts';
import { Button, Slider, Spinner } from './ui';

function lockReason(serverId: number): string {
  return getState().servers[serverId]?.roleplay_mode ? 'DM Lock is on: only Dungeon Masters can run the theater' : 'Only DJs can run the theater';
}

export function setPlacement(placement: Placement): void {
  if (placement !== 'pip') theater.closePip();
  useTheater.setState({ placement });
}

/** Put the screen back in its card: open the panel, unfold the card, and scroll to it. */
export function dockTheater(serverId: number | null): void {
  setPlacement('panel');
  if (serverId === null) return;
  setCollapsed('theater', false);
  const s = getState();
  const here = window.location.pathname.split('/')[2];
  if (here !== String(serverId)) {
    const last = s.lastChannelByServer[serverId];
    go(last ? `/channels/${serverId}/${last}` : `/channels/${serverId}`);
  }
  if (!s.memberListOpen) {
    setState({ memberListOpen: true });
    persistUi();
  }
  if (window.matchMedia('(max-width: 768px)').matches) setState({ mobileMembersOpen: true });
  window.setTimeout(() => theater.slot()?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }), 80);
}

type DocumentPip = { requestWindow(opts: { width: number; height: number }): Promise<Window>; window: Window | null };

function documentPip(): DocumentPip | null {
  return (window as unknown as { documentPictureInPicture?: DocumentPip }).documentPictureInPicture ?? null;
}

/** Can this video go into picture-in-picture here? YouTube needs Chrome or Edge (or new Firefox); uploads also work with the browser's own. */
export function pipAvailable(video: Video | undefined): boolean {
  if (!video) return false;
  if (documentPip()) return true;
  return video.kind === 'file' && typeof document !== 'undefined' && !!document.pictureInPictureEnabled;
}

// ---------------------------------------------------------------------------
// The card
// ---------------------------------------------------------------------------

/** "Now Showing": the theater card in the right-hand panel. */
export function TheaterCard({ serverId }: { serverId: number }) {
  const collapsed = useCollapsed('theater');
  const st = useStore((s) => s.theater[serverId]);
  if (!st) return null;
  return collapsed ? <CollapsedTheater serverId={serverId} st={st} /> : <FullTheater serverId={serverId} st={st} />;
}

function Thumb({ video, width, height }: { video?: Video; width: number; height: number }) {
  return (
    <div className="th-thumb" style={{ width, height }}>
      {video?.thumbnail_url ? <img src={video.thumbnail_url} alt="" loading="lazy" /> : <Icon path={mdiMovieOpen} size={Math.round(height * 0.5)} />}
    </div>
  );
}

/** Re-render every half second (for a moving progress bar). */
function useTicker(active: boolean): void {
  const [, force] = useState(0);
  useEffect(() => {
    if (!active) return;
    const t = window.setInterval(() => force((n) => n + 1), 500);
    return () => window.clearInterval(t);
  }, [active]);
}

/** The video's length: the library's, or what the player found out. */
function useDuration(video: Video | undefined): number {
  const found = useTheater((t) => (video && t.onScreen === video.id ? t.playerDuration : 0));
  return video?.duration_ms || found;
}

function CollapsedTheater({ serverId, st }: { serverId: number; st: TheaterState }) {
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const roleplay = useStore((s) => !!s.servers[serverId]?.roleplay_mode);
  const seated = useSeated(serverId);
  const video = currentVideo(st);
  const duration = useDuration(video);
  return (
    <section className={`jukebox-card theater-card collapsed ${roleplay ? 'roleplay' : ''}`} aria-label="Theater">
      <header className="jb-header">
        <Icon path={mdiMovieOpen} size={18} className="jb-header-icon" />
        <span className="jb-title">Now Showing</span>
        <button className="jb-queue-link" onClick={() => openTheater(serverId, 'queue')}>
          Queue{st.queue.length ? ` (${st.queue.length})` : ''}
        </button>
        <CardEye name="theater" label="theater" />
      </header>
      <div className="card-mini">
        {video ? (
          <>
            <Thumb video={video} width={60} height={34} />
            <div className="card-mini-text">
              <div className="card-mini-title" title={video.title}>
                {video.title}
              </div>
              {(video.channel || video.live) && <div className="card-mini-sub">{video.live ? 'Live' : video.channel}</div>}
            </div>
            {canControl && (
              <button
                className="jb-btn card-mini-btn"
                aria-label={st.playing ? 'Pause for everyone' : 'Play for everyone'}
                onClick={() => theaterControl(serverId, st.playing ? 'pause' : 'play')}
              >
                <Icon path={st.playing ? mdiPause : mdiPlay} size={20} />
              </button>
            )}
          </>
        ) : (
          <span className="card-mini-quiet">The screen is dark.</span>
        )}
        <button
          className={`jb-btn card-mini-btn ${seated ? 'on' : ''}`}
          aria-label={seated ? 'Leave your seat' : 'Take a seat'}
          aria-pressed={seated}
          onClick={() => theater.setSeated(serverId, !seated)}
          {...tip(seated ? 'Seated. Click to leave your seat.' : 'Take a seat to watch along')}
        >
          <Icon path={seated ? mdiSofaSingle : mdiSofaSingleOutline} size={18} />
        </button>
      </div>
      {video && <MiniProgress position={() => theaterPosition(st)} duration={duration} live={video.live} />}
    </section>
  );
}

function FullTheater({ serverId, st }: { serverId: number; st: TheaterState }) {
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const roleplay = useStore((s) => !!s.servers[serverId]?.roleplay_mode);
  const seated = useSeated(serverId);
  const video = currentVideo(st);
  return (
    <section className={`jukebox-card theater-card ${roleplay ? 'roleplay' : ''}`} aria-label="Theater">
      <header className="jb-header">
        <Icon path={mdiMovieOpen} size={20} className="jb-header-icon" />
        <span className="jb-title" {...tip('Everyone who takes a seat sees the same moment of the same video')}>
          Now Showing
        </span>
        <button className="jb-queue-link" onClick={() => openTheater(serverId, 'queue')}>
          Queue{st.queue.length ? ` (${st.queue.length})` : ''}
        </button>
        <CardEye name="theater" label="theater" />
      </header>

      {video ? (
        <>
          <TheaterScreen serverId={serverId} video={video} seated={seated} />
          <div className="th-now">
            <div className="th-now-title" title={video.title}>
              {video.live && <span className="th-live">Live</span>}
              {video.title}
            </div>
            {video.channel && <div className="th-now-sub">{video.channel}</div>}
          </div>
          {!video.live && <TheaterProgress serverId={serverId} st={st} video={video} canControl={canControl} />}
          <TheaterControls serverId={serverId} st={st} canControl={canControl} />
          {seated && <LocalStatus serverId={serverId} video={video} canControl={canControl} />}
          {seated && <VolumeRow />}
        </>
      ) : (
        <div className="jb-empty">
          <Icon path={mdiWeatherNight} size={28} />
          <p>The screen is dark.</p>
          {canControl && (
            <Button size="small" look="outline" onClick={() => openTheater(serverId, 'library')}>
              Open the Library
            </Button>
          )}
        </div>
      )}

      <footer className="jb-footer">
        <SeatButton serverId={serverId} seated={seated} />
        <Audience serverId={serverId} />
        {seated && video && <ViewButtons serverId={serverId} video={video} />}
      </footer>
    </section>
  );
}

/** The card's screen spot: a poster to sit down at, or the place the player docks. */
function TheaterScreen({ serverId, video, seated }: { serverId: number; video: Video; seated: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const placement = useTheater((t) => t.placement);
  const mode = useTheater((t) => t.mode);
  const onScreen = useTheater((t) => t.onScreen === video.id);
  const liveAspect = useTheater((t) => t.aspect);
  useLayoutEffect(() => {
    if (!seated) return;
    theater.setSlot(ref.current);
    return () => theater.setSlot(null);
  }, [seated]);

  const file = video.kind === 'file';
  // YouTube's player needs at least 200 pixels of height (see theater.css); uploads take their own shape.
  const aspect = file ? (onScreen ? liveAspect : aspectOf(video)) : 16 / 9;
  const cls = `th-screen ${file ? 'file' : 'youtube'}`;
  const style = { '--ar': aspect.toFixed(4) } as CSSProperties;

  if (!seated) {
    return (
      <div className="th-screen-wrap">
        <div className={`${cls} poster`} style={style}>
          {video.thumbnail_url ? <img src={video.thumbnail_url} alt="" /> : <Icon path={mdiMovieOpenPlay} size={44} />}
          <button className="th-take-seat" onClick={() => theater.setSeated(serverId, true)}>
            <Icon path={mdiSofaSingle} size={20} />
            Take a Seat
          </button>
        </div>
      </div>
    );
  }
  let away: string | null = null;
  if (placement === 'pip') away = 'Showing in picture-in-picture';
  else if (placement === 'expanded') away = 'Showing on the big screen';
  else if (placement === 'float' || (mode === 'floating' && onScreen)) away = 'Showing in the mini player';
  return (
    <div className="th-screen-wrap">
      <div ref={ref} className={`${cls} slot`} style={style}>
        {away ? (
          <div className="th-away">
            <span>{away}</span>
            <button className="link-button" onClick={() => dockTheater(serverId)}>
              Bring it back here
            </button>
          </div>
        ) : (
          !onScreen && <Spinner size={24} />
        )}
      </div>
    </div>
  );
}

function TheaterProgress({ serverId, st, video, canControl }: { serverId: number; st: TheaterState; video: Video; canControl: boolean }) {
  useTicker(st.playing);
  const duration = useDuration(video);
  const [drag, setDrag] = useState<number | null>(null);
  const pos = drag ?? theaterPosition(st);
  const clamped = duration ? Math.min(pos, duration) : pos;
  return (
    <div className="jb-progress th-progress">
      <Slider
        className="jb-seek"
        value={duration ? clamped : 0}
        min={0}
        max={Math.max(1, duration)}
        step={250}
        disabled={!canControl || !duration}
        label="Seek"
        onChange={(v) => setDrag(v)}
        onCommit={(v) => {
          setDrag(null);
          void theaterControl(serverId, 'seek', v);
        }}
      />
      <div className="jb-times">
        <span>{formatDuration(clamped)}</span>
        <span>{duration ? formatDuration(duration) : '--:--'}</span>
      </div>
    </div>
  );
}

function TheaterControls({ serverId, st, canControl }: { serverId: number; st: TheaterState; canControl: boolean }) {
  const seated = useSeated(serverId);
  const buffering = useTheater((t) => t.buffering && seated && t.onScreen !== null);
  const locked = !canControl;
  const lockTip = locked ? lockReason(serverId) : undefined;
  const nextRepeat = st.repeat === 'off' ? 'all' : st.repeat === 'all' ? 'one' : 'off';
  return (
    <div className={`jb-controls ${locked ? 'locked' : ''}`} {...(lockTip ? tip(lockTip) : {})}>
      <button
        className={`jb-btn ${st.shuffle ? 'on' : ''}`}
        aria-label="Shuffle"
        disabled={locked}
        onClick={() => theaterControl(serverId, 'shuffle', !st.shuffle)}
        {...(!locked ? tip(st.shuffle ? 'Shuffle: on' : 'Shuffle: off') : {})}
      >
        <Icon path={mdiShuffleVariant} size={20} />
      </button>
      <button className="jb-btn" aria-label="Previous" disabled={locked} onClick={() => theaterControl(serverId, 'previous')}>
        <Icon path={mdiSkipPrevious} size={26} />
      </button>
      <button
        className="jb-btn jb-play"
        aria-label={st.playing ? 'Pause for everyone' : 'Play for everyone'}
        disabled={locked}
        onClick={() => theaterControl(serverId, st.playing ? 'pause' : 'play')}
      >
        {buffering && st.playing ? <Spinner size={18} /> : <Icon path={st.playing ? mdiPause : mdiPlay} size={28} />}
      </button>
      <button className="jb-btn" aria-label="Next" disabled={locked} onClick={() => theaterControl(serverId, 'skip')}>
        <Icon path={mdiSkipNext} size={26} />
      </button>
      <button
        className={`jb-btn ${st.repeat !== 'off' ? 'on' : ''}`}
        aria-label="Repeat"
        disabled={locked}
        onClick={() => theaterControl(serverId, 'repeat', nextRepeat)}
        {...(!locked ? tip(st.repeat === 'off' ? 'Repeat: off' : st.repeat === 'all' ? 'Repeat: queue' : 'Repeat: this video') : {})}
      >
        <Icon path={st.repeat === 'one' ? mdiRepeatOnce : st.repeat === 'all' ? mdiRepeat : mdiRepeatOff} size={20} />
      </button>
    </div>
  );
}

/** Things only about my screen: sound held back, paused just for me, or it can't play here. */
function LocalStatus({ serverId, video, canControl, compact }: { serverId: number; video: Video; canControl: boolean; compact?: boolean }) {
  const needsGesture = useTheater((t) => t.needsGesture);
  const localPause = useTheater((t) => t.localPause);
  const error = useTheater((t) => (t.error && (t.error.videoId === null || t.error.videoId === video.id) ? t.error.message : null));
  if (error) {
    return (
      <div className={`th-status error ${compact ? 'compact' : ''}`}>
        <Icon path={mdiAlertCircle} size={16} />
        <span className="th-status-text">{error}</span>
        <button className="th-status-btn" onClick={() => theater.retry()}>
          Try again
        </button>
        {canControl && (
          <button className="th-status-btn" onClick={() => theaterControl(serverId, 'skip')}>
            Skip
          </button>
        )}
      </div>
    );
  }
  if (needsGesture) {
    return (
      <button className="jb-gesture th-gesture" onClick={() => theater.unlockSound()}>
        <Icon path={mdiVolumeHigh} size={16} />
        Click for sound
      </button>
    );
  }
  if (localPause) {
    return (
      <div className={`th-status ${compact ? 'compact' : ''}`}>
        <span className="th-status-text">Paused on your screen</span>
        <button className="th-status-btn gold" onClick={() => theater.catchUp()}>
          <Icon path={mdiSync} size={14} />
          Catch up
        </button>
        {canControl && (
          <button className="th-status-btn" onClick={() => theaterControl(serverId, 'pause')}>
            Pause for everyone
          </button>
        )}
      </div>
    );
  }
  return null;
}

function VolumeRow() {
  const volume = useTheater((t) => t.myVolume);
  const muted = useTheater((t) => t.muted);
  const shown = muted ? 0 : volume;
  return (
    <div className="jb-settings th-volume">
      <div className="jb-row">
        <button className="th-mute" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => theater.setMuted(!muted)} {...tip(muted ? 'Unmute' : 'Mute')}>
          <Icon path={shown === 0 ? mdiVolumeOff : mdiVolumeHigh} size={18} />
        </button>
        <span className="jb-row-label">My Volume</span>
        <Slider value={shown} onChange={(v) => theater.setVolume(v)} label="My volume" className="jb-slider" />
        <span className="jb-row-value">{shown}%</span>
      </div>
    </div>
  );
}

function SeatButton({ serverId, seated }: { serverId: number; seated: boolean }) {
  return (
    <button
      className={`jb-listen th-seat ${seated ? 'on' : ''}`}
      onClick={() => theater.setSeated(serverId, !seated)}
      aria-pressed={seated}
      {...tip(seated ? 'Leave your seat (stop watching on this device)' : 'Watch along, in step with everyone')}
    >
      <Icon path={seated ? mdiSofaSingle : mdiSofaSingleOutline} size={18} />
      {seated ? 'Seated' : 'Take a Seat'}
    </button>
  );
}

function Audience({ serverId }: { serverId: number }) {
  const audience = useStore(useShallow((s) => (s.theater[serverId]?.listeners ?? []).map((id) => s.users[id]).filter(Boolean)));
  return (
    <div
      className="jb-listeners th-audience"
      {...tip(audience.length ? `In the audience: ${audience.map((u) => displayName(u)).join(', ')}` : 'Nobody has taken a seat yet')}
    >
      {audience.slice(0, 4).map((u) => (
        <img key={u.id} src={userAvatar(u)} alt="" />
      ))}
      {audience.length > 4 && <span className="jb-more">+{audience.length - 4}</span>}
    </div>
  );
}

function ViewButtons({ serverId, video }: { serverId: number; video: Video }) {
  const placement = useTheater((t) => t.placement);
  return (
    <div className="th-views">
      <button
        className={`jb-btn th-view ${placement === 'float' ? 'on' : ''}`}
        aria-label="Mini player"
        onClick={() => (placement === 'float' ? dockTheater(serverId) : setPlacement('float'))}
        {...tip(placement === 'float' ? 'Put the screen back here' : 'Pop out into a mini player')}
      >
        <Icon path={mdiDockWindow} size={18} />
      </button>
      <button className="jb-btn th-view" aria-label="Big screen" onClick={() => setPlacement('expanded')} {...tip('Big screen')}>
        <Icon path={mdiArrowExpand} size={18} />
      </button>
      {pipAvailable(video) && (
        <button className="jb-btn th-view" aria-label="Picture-in-picture" onClick={() => void openTheaterPip()} {...tip('Picture-in-picture')}>
          <Icon path={mdiPictureInPictureBottomRight} size={18} />
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The screen: docked over the card, floating, or big
// ---------------------------------------------------------------------------

/** YouTube's player must be at least 200 × 200 pixels. */
const MIN_H = 200;
const FLOAT_BAR = 30;

interface FloatPrefs {
  right: number;
  bottom: number;
  /** Height of the picture (the bar is extra). */
  h: number;
}

let floatPrefs: FloatPrefs = load<FloatPrefs>('theaterFloat', { right: 16, bottom: 96, h: MIN_H });

interface Box {
  left: number;
  top: number;
  width: number;
  height: number;
  clip: string;
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), Math.max(lo, hi));
}

/** How much of the card's screen spot can be seen (the panel scrolls, closes, slides away on phones). */
function slotBox(slot: HTMLElement): { frac: number; box: Box } | null {
  const r = slot.getBoundingClientRect();
  if (r.width < 8 || r.height < 8) return null;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const panel = slot.closest('.right-panel');
  const p = panel?.getBoundingClientRect();
  const top = Math.max(r.top, p ? p.top : 0, 0);
  const bottom = Math.min(r.bottom, p ? p.bottom : vh, vh);
  const left = Math.max(r.left, p ? p.left : 0, 0);
  const right = Math.min(r.right, p ? p.right : vw, vw);
  const w = Math.max(0, right - left);
  const h = Math.max(0, bottom - top);
  const frac = (w * h) / (r.width * r.height);
  const inset = [top - r.top, r.right - right, r.bottom - bottom, left - r.left].map((n) => `${Math.max(0, Math.round(n))}px`).join(' ');
  return {
    frac,
    box: { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), clip: `inset(${inset})` },
  };
}

function floatSize(aspect: number): { w: number; h: number } {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let h = clamp(floatPrefs.h, MIN_H, vh * 0.75 - FLOAT_BAR);
  let w = Math.max(MIN_H, h * aspect);
  if (w > vw - 16) {
    w = Math.max(MIN_H, vw - 16);
    h = Math.max(MIN_H, Math.min(h, w / aspect));
  }
  return { w: Math.round(w), h: Math.round(h) };
}

function floatBox(aspect: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { w, h } = floatSize(aspect);
  const total = h + FLOAT_BAR;
  const right = clamp(floatPrefs.right, 8, vw - w - 8);
  const bottom = clamp(floatPrefs.bottom, 8, vh - total - 8);
  return { left: Math.round(vw - right - w), top: Math.round(vh - bottom - total), width: w, height: total, clip: 'none' };
}

function bigBarHeight(): number {
  return window.innerWidth < 600 ? 96 : 58;
}

function bigBox(aspect: number): Box {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = vw < 768 ? 0 : 32;
  const bar = bigBarHeight();
  const maxW = vw - pad * 2;
  const maxH = vh - pad * 2 - bar;
  const w = Math.min(maxW, maxH * aspect);
  const h = w / aspect;
  // Room for the controls even under a tall, narrow video.
  const width = Math.max(w, Math.min(maxW, 560));
  return { left: Math.round((vw - width) / 2), top: Math.round((vh - (h + bar)) / 2), width: Math.round(width), height: Math.round(h + bar), clip: 'none' };
}

/** Full-screen layers that cover the right-hand panel. */
function panelCovered(): boolean {
  const s = getState();
  return !!(s.settings || s.sheetView || s.jukeboxView || s.theaterView);
}

function placeHost(host: HTMLElement, applied: { key: string }): void {
  const ui = useTheater.getState();
  let mode: ScreenMode = ui.placement === 'expanded' ? 'expanded' : ui.placement === 'float' ? 'floating' : 'docked';
  let box: Box | null = null;
  if (mode === 'docked') {
    const slot = theater.slot();
    const seen = slot && !panelCovered() ? slotBox(slot) : null;
    // Float once a quarter of it is out of sight, dock again when nearly all of it
    // shows (the gap keeps it from flickering at the edge).
    if (seen && seen.frac >= (ui.mode === 'docked' ? 0.75 : 0.9)) box = seen.box;
    else mode = 'floating';
  }
  if (mode === 'floating') box = floatBox(ui.aspect);
  if (mode === 'expanded') box = bigBox(ui.aspect);
  if (ui.mode !== mode) useTheater.setState({ mode });
  if (!box || document.fullscreenElement === host) return;
  const key = `${mode}|${box.left}|${box.top}|${box.width}|${box.height}|${box.clip}`;
  if (key === applied.key) return;
  applied.key = key;
  const st = host.style;
  st.left = `${box.left}px`;
  st.top = `${box.top}px`;
  st.width = `${box.width}px`;
  st.height = `${box.height}px`;
  st.clipPath = box.clip;
}

/** Drag the mini player around (or resize it from its corner grip). */
function startFloatDrag(e: ReactPointerEvent<HTMLElement>, kind: 'move' | 'resize'): void {
  if (e.button !== 0 || (kind === 'move' && (e.target as HTMLElement).closest('button'))) return;
  e.preventDefault();
  const el = e.currentTarget;
  const host = el.closest('.th-host') as HTMLElement | null;
  el.setPointerCapture(e.pointerId);
  host?.classList.add('dragging');
  const start = { x: e.clientX, y: e.clientY, ...floatPrefs };
  const aspect = useTheater.getState().aspect;
  const { w: startW, h: startH } = floatSize(aspect);
  const move = (ev: PointerEvent) => {
    const dx = ev.clientX - start.x;
    const dy = ev.clientY - start.y;
    if (kind === 'move') {
      floatPrefs = { ...floatPrefs, right: start.right - dx, bottom: start.bottom - dy };
    } else {
      // The grip is the top-left corner (the player is anchored bottom-right): up and left grow it.
      const grow = Math.max(-dy, -dx / aspect);
      floatPrefs = { ...floatPrefs, h: clamp(startH + grow, MIN_H, window.innerHeight * 0.75 - FLOAT_BAR) };
      void startW;
    }
  };
  const done = () => {
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', done);
    el.removeEventListener('pointercancel', done);
    host?.classList.remove('dragging');
    // Remember where it was put, kept on screen.
    const { w, h } = floatSize(aspect);
    floatPrefs = {
      right: clamp(floatPrefs.right, 8, window.innerWidth - w - 8),
      bottom: clamp(floatPrefs.bottom, 8, window.innerHeight - h - FLOAT_BAR - 8),
      h: floatPrefs.h,
    };
    save('theaterFloat', floatPrefs);
  };
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', done);
  el.addEventListener('pointercancel', done);
}

/**
 * The one screen for the whole app (mounted once, in AppShell). Its player
 * element is never moved around the page; only the box's position changes.
 */
export function TheaterScreenHost() {
  const onScreen = useTheater((t) => t.onScreen);
  const placement = useTheater((t) => t.placement);
  const mode = useTheater((t) => t.mode);
  const serverId = useStore(seatedServer);
  const hostRef = useRef<HTMLDivElement>(null);
  const mediaRef = useRef<HTMLDivElement>(null);
  const [fullscreen, setFullscreen] = useState(false);

  useLayoutEffect(() => {
    theater.attachHome(mediaRef.current);
    return () => theater.attachHome(null);
  }, []);

  // Follow the card's screen spot every frame while something is showing.
  useEffect(() => {
    if (onScreen === null || placement === 'pip') {
      const next: ScreenMode = onScreen === null ? 'hidden' : 'pip';
      if (useTheater.getState().mode !== next) useTheater.setState({ mode: next });
      return;
    }
    let raf = 0;
    const applied = { key: '' };
    const frame = () => {
      raf = requestAnimationFrame(frame);
      if (hostRef.current) placeHost(hostRef.current, applied);
    };
    frame();
    return () => cancelAnimationFrame(raf);
  }, [onScreen, placement]);

  useEffect(() => {
    const onChange = () => setFullscreen(!!hostRef.current && document.fullscreenElement === hostRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  // Escape leaves the big screen.
  useEffect(() => {
    if (mode !== 'expanded') return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !document.fullscreenElement && !getState().modals.length) setPlacement('panel');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode]);

  const toggleFullscreen = () => {
    const host = hostRef.current;
    if (!host) return;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
    else void host.requestFullscreen().catch(() => toast("This browser won't show the theater full screen."));
  };

  return (
    <>
      {mode === 'expanded' && <div className="th-backdrop" onMouseDown={() => setPlacement('panel')} />}
      <div ref={hostRef} className={`th-host mode-${mode} ${fullscreen ? 'is-fullscreen' : ''}`} aria-hidden={mode === 'hidden' || mode === 'pip'}>
        {/* The player lives here. Nothing is ever drawn over it. */}
        <div ref={mediaRef} className="th-host-media" />
        {serverId !== null && (mode === 'floating' || fullscreen) && !(mode === 'expanded') && (
          <FloatBar serverId={serverId} fullscreen={fullscreen} onFullscreen={toggleFullscreen} />
        )}
        {serverId !== null && mode === 'expanded' && <BigBar serverId={serverId} fullscreen={fullscreen} onFullscreen={toggleFullscreen} />}
      </div>
    </>
  );
}

function StatusChip({ serverId }: { serverId: number }) {
  const needsGesture = useTheater((t) => t.needsGesture);
  const localPause = useTheater((t) => t.localPause);
  const error = useTheater((t) => t.error?.message ?? null);
  if (error) {
    return (
      <button className="th-chip error" onClick={() => theater.retry()} title={error}>
        <Icon path={mdiAlertCircle} size={14} />
        Can't play · Try again
      </button>
    );
  }
  if (needsGesture) {
    return (
      <button className="th-chip gold" onClick={() => theater.unlockSound()}>
        <Icon path={mdiVolumeHigh} size={14} />
        Click for sound
      </button>
    );
  }
  if (localPause) {
    return (
      <button className="th-chip" onClick={() => theater.catchUp()}>
        <Icon path={mdiSync} size={14} />
        Paused · Catch up
      </button>
    );
  }
  void serverId;
  return null;
}

function FloatBar({ serverId, fullscreen, onFullscreen }: { serverId: number; fullscreen: boolean; onFullscreen: () => void }) {
  const video = useStore((s) => currentVideo(s.theater[serverId]));
  const serverName = useStore((s) => s.servers[serverId]?.name ?? '');
  const needsAttention = useTheater((t) => t.needsGesture || t.localPause || !!t.error);
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  return (
    <div className="th-bar th-float-bar" onPointerDown={(e) => startFloatDrag(e, 'move')}>
      {!fullscreen && (
        <span className="th-grip" onPointerDown={(e) => (e.stopPropagation(), startFloatDrag(e, 'resize'))} {...tip('Drag to resize')}>
          <Icon path={mdiResizeBottomRight} size={14} />
        </span>
      )}
      {needsAttention ? (
        <StatusChip serverId={serverId} />
      ) : (
        <span className="th-bar-title" title={`${video?.title ?? ''} · ${serverName}`}>
          {video?.title}
        </span>
      )}
      <span className="th-bar-spacer" />
      {!fullscreen && (
        <button className="th-bar-btn" aria-label="Put the screen back" onClick={() => dockTheater(serverId)} {...tip('Put the screen back in the theater card')}>
          <Icon path={mdiDockRight} size={16} />
        </button>
      )}
      {!fullscreen && (
        <button className="th-bar-btn" aria-label="Big screen" onClick={() => setPlacement('expanded')} {...tip('Big screen')}>
          <Icon path={mdiArrowExpand} size={16} />
        </button>
      )}
      {!fullscreen && pipAvailable(video) && (
        <button className="th-bar-btn" aria-label="Picture-in-picture" onClick={() => void openTheaterPip()} {...tip('Picture-in-picture')}>
          <Icon path={mdiPictureInPictureBottomRight} size={16} />
        </button>
      )}
      {canFullscreen && (
        <button className="th-bar-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={onFullscreen} {...tip(fullscreen ? 'Exit full screen' : 'Full screen')}>
          <Icon path={fullscreen ? mdiFullscreenExit : mdiFullscreen} size={16} />
        </button>
      )}
      <button className="th-bar-btn" aria-label="Leave your seat" onClick={() => theater.setSeated(serverId, false)} {...tip('Leave your seat')}>
        <Icon path={mdiClose} size={16} />
      </button>
    </div>
  );
}

function BigBar({ serverId, fullscreen, onFullscreen }: { serverId: number; fullscreen: boolean; onFullscreen: () => void }) {
  const st = useStore((s) => s.theater[serverId]);
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const volume = useTheater((t) => t.myVolume);
  const muted = useTheater((t) => t.muted);
  const video = currentVideo(st);
  const canFullscreen = typeof document !== 'undefined' && document.fullscreenEnabled;
  if (!st || !video) return null;
  const shown = muted ? 0 : volume;
  return (
    <div className="th-bar th-big-bar">
      {canControl && (
        <div className="th-big-controls">
          <button className="th-bar-btn" aria-label="Previous" onClick={() => theaterControl(serverId, 'previous')}>
            <Icon path={mdiSkipPrevious} size={22} />
          </button>
          <button className="th-bar-btn play" aria-label={st.playing ? 'Pause for everyone' : 'Play for everyone'} onClick={() => theaterControl(serverId, st.playing ? 'pause' : 'play')}>
            <Icon path={st.playing ? mdiPause : mdiPlay} size={24} />
          </button>
          <button className="th-bar-btn" aria-label="Next" onClick={() => theaterControl(serverId, 'skip')}>
            <Icon path={mdiSkipNext} size={22} />
          </button>
        </div>
      )}
      <div className="th-big-middle">
        <div className="th-big-title-row">
          <span className="th-big-title" title={video.title}>
            {video.live && <span className="th-live">Live</span>}
            {video.title}
          </span>
          <StatusChip serverId={serverId} />
          {!video.live && <BigTimes st={st} video={video} />}
        </div>
        {!video.live && <TheaterProgress serverId={serverId} st={st} video={video} canControl={canControl} />}
      </div>
      <div className="th-big-right">
        <button className="th-bar-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={() => theater.setMuted(!muted)}>
          <Icon path={shown === 0 ? mdiVolumeOff : mdiVolumeHigh} size={20} />
        </button>
        <Slider value={shown} onChange={(v) => theater.setVolume(v)} label="My volume" className="th-big-volume" />
        {!fullscreen && pipAvailable(video) && (
          <button className="th-bar-btn" aria-label="Picture-in-picture" onClick={() => void openTheaterPip()} {...tip('Picture-in-picture')}>
            <Icon path={mdiPictureInPictureBottomRight} size={20} />
          </button>
        )}
        {canFullscreen && (
          <button className="th-bar-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={onFullscreen} {...tip(fullscreen ? 'Exit full screen' : 'Full screen')}>
            <Icon path={fullscreen ? mdiFullscreenExit : mdiFullscreen} size={20} />
          </button>
        )}
        {!fullscreen && (
          <button className="th-bar-btn" aria-label="Back to the card" onClick={() => setPlacement('panel')} {...tip('Back to the theater card (Esc)')}>
            <Icon path={mdiArrowCollapse} size={20} />
          </button>
        )}
      </div>
    </div>
  );
}

function BigTimes({ st, video }: { st: TheaterState; video: Video }) {
  useTicker(st.playing);
  const duration = useDuration(video);
  const pos = theaterPosition(st);
  return (
    <span className="th-big-times">
      {formatDuration(duration ? Math.min(pos, duration) : pos)}
      {duration ? ` / ${formatDuration(duration)}` : ''}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Picture-in-picture
// ---------------------------------------------------------------------------

const PIP_BAR = 44;
let pipOpening = false;

/** Copy the app's styles into the picture-in-picture window (it starts out blank). */
function copyStyles(target: Document): void {
  for (const sheet of Array.from(document.styleSheets)) {
    try {
      const css = Array.from(sheet.cssRules)
        .map((r) => r.cssText)
        .join('\n');
      const style = target.createElement('style');
      style.textContent = css;
      target.head.appendChild(style);
    } catch {
      if (sheet.href) {
        const link = target.createElement('link');
        link.rel = 'stylesheet';
        link.href = sheet.href;
        target.head.appendChild(link);
      }
    }
  }
}

/** Open the theater in a picture-in-picture window (it must be called straight from a click). */
export async function openTheaterPip(): Promise<void> {
  const serverId = seatedServer(getState());
  if (serverId === null) return;
  const dpip = documentPip();
  if (!dpip) {
    // No Document Picture-in-Picture (Safari): an uploaded video can use the browser's own.
    const v = theater.videoElement();
    if (v && document.pictureInPictureEnabled) {
      try {
        if (document.pictureInPictureElement === v) await document.exitPictureInPicture();
        else await v.requestPictureInPicture();
      } catch {
        toast("Picture-in-picture didn't open.");
      }
    }
    return;
  }
  if (dpip.window) {
    dpip.window.focus();
    return;
  }
  // One at a time (a double click would otherwise ask for two windows).
  if (pipOpening) return;
  pipOpening = true;
  const aspect = useTheater.getState().aspect || 16 / 9;
  const width = 512;
  let win: Window;
  try {
    win = await dpip.requestWindow({ width, height: Math.round(width / aspect) + PIP_BAR });
  } catch {
    toast("Picture-in-picture didn't open.");
    return;
  } finally {
    pipOpening = false;
  }
  const doc = win.document;
  copyStyles(doc);
  doc.title = 'Tavern Theater';
  doc.documentElement.className = document.documentElement.className;
  doc.body.className = `${document.body.className} thp-body`;
  const mount = doc.createElement('div');
  mount.className = 'thp';
  doc.body.append(mount);
  const root = createRoot(mount);
  root.render(<PipScreen win={win} />);
  win.addEventListener(
    'pagehide',
    () => {
      theater.leavePip(win);
      root.unmount();
    },
    { once: true },
  );
}

/** Inside the picture-in-picture window: the screen, and a slim bar of controls under it. */
function PipScreen({ win }: { win: Window }) {
  const mediaRef = useRef<HTMLDivElement>(null);
  const serverId = useStore(seatedServer);
  const st = useStore((s) => (serverId !== null ? s.theater[serverId] : undefined));
  const canControl = useStore((s) => (serverId !== null ? canControlTheater(s, serverId) : false));
  const volume = useTheater((t) => t.myVolume);
  const muted = useTheater((t) => t.muted);
  const video = currentVideo(st);

  useLayoutEffect(() => {
    if (mediaRef.current) theater.enterPip(win, mediaRef.current);
  }, [win]);

  const shown = muted ? 0 : volume;
  return (
    <>
      <div ref={mediaRef} className="thp-media" />
      <div className="th-bar thp-bar">
        {canControl && st && serverId !== null && (
          <button className="th-bar-btn play" title={st.playing ? 'Pause for everyone' : 'Play for everyone'} onClick={() => theaterControl(serverId, st.playing ? 'pause' : 'play')}>
            <Icon path={st.playing ? mdiPause : mdiPlay} size={22} />
          </button>
        )}
        <div className="thp-middle">
          {serverId !== null && <PipStatus serverId={serverId} />}
          <span className="th-bar-title" title={video?.title}>
            {video?.title ?? 'Nothing is showing'}
          </span>
        </div>
        <button className="th-bar-btn" title={muted ? 'Unmute' : 'Mute'} onClick={() => theater.setMuted(!muted)}>
          <Icon path={shown === 0 ? mdiVolumeOff : mdiVolumeHigh} size={18} />
        </button>
        <Slider value={shown} onChange={(v) => theater.setVolume(v)} label="My volume" className="thp-volume" />
        <button className="th-bar-btn" title="Back to Tavern" onClick={() => win.close()}>
          <Icon path={mdiDockRight} size={18} />
        </button>
        {serverId !== null && (
          <button className="th-bar-btn" title="Leave your seat" onClick={() => theater.setSeated(serverId, false)}>
            <Icon path={mdiClose} size={18} />
          </button>
        )}
      </div>
    </>
  );
}

/** Like StatusChip, but with plain titles (tooltips live in the main window). */
function PipStatus({ serverId }: { serverId: number }) {
  const needsGesture = useTheater((t) => t.needsGesture);
  const localPause = useTheater((t) => t.localPause);
  const error = useTheater((t) => t.error?.message ?? null);
  void serverId;
  if (error) {
    return (
      <button className="th-chip error" onClick={() => theater.retry()} title={error}>
        Can't play · Try again
      </button>
    );
  }
  if (needsGesture) {
    return (
      <button className="th-chip gold" onClick={() => theater.unlockSound()}>
        Click for sound
      </button>
    );
  }
  if (localPause) {
    return (
      <button className="th-chip" onClick={() => theater.catchUp()}>
        Paused · Catch up
      </button>
    );
  }
  return null;
}
