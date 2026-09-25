/**
 * The video player for attachments and video links. It uses its own controls
 * because the browser's controls drop the seek bar and volume slider when a
 * video is narrow (a phone video in chat), and the box always takes the
 * video's own shape so there are no black bars beside it.
 */
import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react';
import { formatDuration } from '../lib/format';
import { load, save } from '../lib/storage';
import {
  Icon,
  mdiAlertCircle,
  mdiDownload,
  mdiFullscreen,
  mdiFullscreenExit,
  mdiPause,
  mdiPictureInPictureBottomRight,
  mdiPlay,
  mdiVolumeHigh,
  mdiVolumeLow,
  mdiVolumeMedium,
  mdiVolumeOff,
} from './icons';
import { tip } from './layers';
import { Spinner } from './ui';

/** Only one video plays at a time: starting one pauses the last. */
let playingNow: HTMLVideoElement | null = null;

const SPEEDS = [1, 1.25, 1.5, 2, 0.5];
const HIDE_AFTER_MS = 2500;
const canPip = typeof document !== 'undefined' && 'pictureInPictureEnabled' in document && document.pictureInPictureEnabled;

function fit(w: number, h: number, maxW: number, maxH: number): { width: number; height: number } {
  const scale = Math.min(1, maxW / w, maxH / h);
  return { width: Math.max(1, Math.round(w * scale)), height: Math.max(1, Math.round(h * scale)) };
}

function volumeIcon(volume: number, muted: boolean): string {
  if (muted || volume === 0) return mdiVolumeOff;
  if (volume < 0.34) return mdiVolumeLow;
  if (volume < 0.67) return mdiVolumeMedium;
  return mdiVolumeHigh;
}

export interface VideoPlayerProps {
  src: string;
  /** The video's size, when the server knows it (so the box is right before it loads). */
  width?: number | null;
  height?: number | null;
  maxW?: number;
  maxH?: number;
  /** Fill the parent (media grids) instead of sizing to the video. */
  fill?: boolean;
  /** Offer a download button with this file name. */
  filename?: string;
}

export default function VideoPlayer({ src, width, height, maxW = 550, maxH = 350, fill, filename }: VideoPlayerProps) {
  const box = useRef<HTMLDivElement>(null);
  const video = useRef<HTMLVideoElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(width && height ? { w: width, h: height } : null);
  const [paused, setPaused] = useState(true);
  const [started, setStarted] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [buffered, setBuffered] = useState<[number, number][]>([]);
  const [volume, setVolumeState] = useState(() => load<number>('videoVolume', 1));
  const [muted, setMutedState] = useState(() => load<boolean>('videoMuted', false));
  const [speed, setSpeed] = useState(1);
  const [waiting, setWaiting] = useState(false);
  const [failed, setFailed] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [scrub, setScrub] = useState<number | null>(null);
  const [hover, setHover] = useState<{ frac: number; time: number } | null>(null);
  const [idle, setIdle] = useState(false);
  const idleTimer = useRef<number | null>(null);
  const lastSeek = useRef(0);
  const [narrow, setNarrow] = useState(false);

  // While playing, the bar moves every frame by setting --p on the track
  // directly; the player itself only re-renders when the clock's second changes.
  // (timeupdate only fires ~4x a second, too jumpy for the bar.)
  useEffect(() => {
    if (paused) return;
    let raf = 0;
    let second = -1;
    const tick = () => {
      const v = video.current;
      if (v && scrub === null) {
        const t = v.currentTime;
        if (track.current && Number.isFinite(v.duration) && v.duration > 0) track.current.style.setProperty('--p', String(Math.min(1, t / v.duration)));
        if (Math.floor(t) !== second) {
          second = Math.floor(t);
          setTime(t);
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [paused, scrub]);

  useEffect(() => {
    const onFs = () => setFullscreen(!!box.current && document.fullscreenElement === box.current);
    document.addEventListener('fullscreenchange', onFs);
    return () => document.removeEventListener('fullscreenchange', onFs);
  }, []);

  // Narrow players hide the less important buttons.
  useEffect(() => {
    const el = box.current;
    if (!el || typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(([entry]) => setNarrow(entry.contentRect.width < 280));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(
    () => () => {
      if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
      if (playingNow === video.current) playingNow = null;
    },
    [],
  );

  const poke = () => {
    setIdle(false);
    if (idleTimer.current !== null) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), HIDE_AFTER_MS);
  };

  const togglePlay = () => {
    const v = video.current;
    if (!v || failed) return;
    if (v.paused || v.ended) void v.play().catch(() => undefined);
    else v.pause();
  };

  const seekTo = (t: number, preview = false) => {
    const v = video.current;
    if (!v || !Number.isFinite(t)) return;
    const clamped = Math.max(0, Math.min(t, duration || t));
    setTime(clamped);
    // While dragging, don't flood the decoder: a seek every ~80ms is plenty.
    const now = performance.now();
    if (preview && now - lastSeek.current < 80) return;
    lastSeek.current = now;
    const fast = (v as HTMLVideoElement & { fastSeek?: (t: number) => void }).fastSeek;
    if (preview && typeof fast === 'function') fast.call(v, clamped);
    else v.currentTime = clamped;
  };

  const applyVolume = (next: number, nextMuted: boolean) => {
    const v = video.current;
    const vol = Math.max(0, Math.min(1, next));
    setVolumeState(vol);
    setMutedState(nextMuted);
    save('videoVolume', vol);
    save('videoMuted', nextMuted);
    if (v) {
      v.volume = vol;
      v.muted = nextMuted;
    }
  };

  const toggleMute = () => {
    if (muted || volume === 0) applyVolume(volume === 0 ? 0.5 : volume, false);
    else applyVolume(volume, true);
  };

  const toggleFullscreen = () => {
    const el = box.current;
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    if (!el) return;
    if (document.fullscreenElement) void document.exitFullscreen();
    else if (el.requestFullscreen) void el.requestFullscreen().catch(() => v?.webkitEnterFullscreen?.());
    else v?.webkitEnterFullscreen?.(); // iPhone: only the video itself can go fullscreen
  };

  const togglePip = () => {
    const v = video.current;
    if (!v) return;
    if (document.pictureInPictureElement === v) void document.exitPictureInPicture();
    else void v.requestPictureInPicture().catch(() => undefined);
  };

  const cycleSpeed = () => {
    const next = SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length];
    setSpeed(next);
    if (video.current) video.current.playbackRate = next;
  };

  const fracAt = (clientX: number) => {
    const r = bar.current?.getBoundingClientRect();
    if (!r || r.width === 0) return 0;
    return Math.max(0, Math.min(1, (clientX - r.left) / r.width));
  };

  const onSeekDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration || e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    const t = fracAt(e.clientX) * duration;
    setScrub(t);
    seekTo(t, true);
  };
  const onSeekMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!duration) return;
    const frac = fracAt(e.clientX);
    setHover({ frac, time: frac * duration });
    if (scrub !== null) {
      setScrub(frac * duration);
      seekTo(frac * duration, true);
    }
  };
  const onSeekUp = (e: PointerEvent<HTMLDivElement>) => {
    if (scrub === null) return;
    seekTo(fracAt(e.clientX) * duration);
    setScrub(null);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const v = video.current;
    if (!v || e.target !== e.currentTarget) return;
    const key = e.key.toLowerCase();
    if (key === ' ' || key === 'k') togglePlay();
    else if (key === 'arrowleft' || key === 'j') seekTo(v.currentTime - (key === 'j' ? 10 : 5));
    else if (key === 'arrowright' || key === 'l') seekTo(v.currentTime + (key === 'l' ? 10 : 5));
    else if (key === 'arrowup') applyVolume(volume + 0.1, false);
    else if (key === 'arrowdown') applyVolume(volume - 0.1, false);
    else if (key === 'm') toggleMute();
    else if (key === 'f') toggleFullscreen();
    else return;
    e.preventDefault();
    poke();
  };

  const shown = scrub ?? time;
  const showControls = paused || !idle || scrub !== null;

  // Paused, seeking or dragging: the bar follows the state.
  useEffect(() => {
    if (!paused && scrub === null) return;
    track.current?.style.setProperty('--p', String(duration ? Math.min(1, shown / duration) : 0));
  }, [paused, scrub, shown, duration]);

  let style: CSSProperties | undefined;
  if (!fill) {
    const size = dims ? fit(dims.w, dims.h, maxW, maxH) : { width: Math.min(400, maxW), height: Math.min(225, maxH) };
    style = { width: size.width, aspectRatio: `${size.width} / ${size.height}` };
  }

  return (
    <div
      ref={box}
      className={`vp ${fill ? 'fill' : ''} ${showControls ? 'show' : ''} ${started ? 'started' : ''} ${fullscreen ? 'fullscreen' : ''} ${narrow ? 'narrow' : ''}`}
      style={style}
      tabIndex={0}
      role="group"
      aria-label="Video player"
      onKeyDown={onKey}
      onPointerMove={poke}
      onPointerLeave={() => !paused && setIdle(true)}
    >
      <video
        ref={video}
        src={src}
        preload="metadata"
        playsInline
        onClick={togglePlay}
        onDoubleClick={toggleFullscreen}
        onLoadedMetadata={(e) => {
          const v = e.currentTarget;
          v.volume = volume;
          v.muted = muted;
          if (v.videoWidth && v.videoHeight) setDims({ w: v.videoWidth, h: v.videoHeight });
          if (Number.isFinite(v.duration)) setDuration(v.duration);
        }}
        onDurationChange={(e) => Number.isFinite(e.currentTarget.duration) && setDuration(e.currentTarget.duration)}
        onTimeUpdate={(e) => paused && scrub === null && setTime(e.currentTarget.currentTime)}
        onProgress={(e) => {
          const b = e.currentTarget.buffered;
          const ranges: [number, number][] = [];
          for (let i = 0; i < b.length; i++) ranges.push([b.start(i), b.end(i)]);
          setBuffered(ranges);
        }}
        onPlay={(e) => {
          if (playingNow && playingNow !== e.currentTarget) playingNow.pause();
          playingNow = e.currentTarget;
          setPaused(false);
          setStarted(true);
          poke();
        }}
        onPause={(e) => {
          setPaused(true);
          setTime(e.currentTarget.currentTime);
          if (playingNow === e.currentTarget) playingNow = null;
        }}
        onEnded={() => setPaused(true)}
        onWaiting={() => setWaiting(true)}
        onPlaying={() => setWaiting(false)}
        onCanPlay={() => setWaiting(false)}
        onSeeked={() => setWaiting(false)}
        onVolumeChange={(e) => {
          setVolumeState(e.currentTarget.volume);
          setMutedState(e.currentTarget.muted);
        }}
        onError={() => setFailed(true)}
      />

      {!started && !failed && (
        <button className="vp-big-play" aria-label="Play" onClick={togglePlay}>
          <Icon path={mdiPlay} size={30} />
        </button>
      )}
      {waiting && !paused && (
        <span className="vp-spinner">
          <Spinner size={36} />
        </span>
      )}
      {failed && (
        <div className="vp-error">
          <Icon path={mdiAlertCircle} size={28} />
          <span>This video can't play in your browser.</span>
          <a href={src} download={filename} target="_blank" rel="noreferrer noopener">
            Download it
          </a>
        </div>
      )}

      {!failed && (
        <div className="vp-controls" onPointerDown={(e) => e.stopPropagation()}>
          <div
            ref={bar}
            className={`vp-seek ${scrub !== null ? 'dragging' : ''}`}
            role="slider"
            tabIndex={0}
            aria-label="Seek"
            aria-valuemin={0}
            aria-valuemax={Math.round(duration)}
            aria-valuenow={Math.round(shown)}
            aria-valuetext={`${formatDuration(shown * 1000)} of ${formatDuration(duration * 1000)}`}
            onPointerDown={onSeekDown}
            onPointerMove={onSeekMove}
            onPointerUp={onSeekUp}
            onPointerCancel={() => setScrub(null)}
            onPointerLeave={() => setHover(null)}
            onKeyDown={(e) => {
              const v = video.current;
              if (!v) return;
              if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
                e.preventDefault();
                e.stopPropagation();
                seekTo(v.currentTime + (e.key === 'ArrowLeft' ? -5 : 5));
              } else if (e.key === 'Home' || e.key === 'End') {
                e.preventDefault();
                e.stopPropagation();
                seekTo(e.key === 'Home' ? 0 : duration);
              }
            }}
          >
            <div className="vp-track" ref={track}>
              {duration > 0 &&
                buffered.map(([a, b], i) => <div key={i} className="vp-buffered" style={{ left: `${(a / duration) * 100}%`, width: `${((b - a) / duration) * 100}%` }} />)}
              <div className="vp-played" />
              <div className="vp-thumb" />
            </div>
            {hover && duration > 0 && (
              <div className="vp-hover-time" style={{ left: `${Math.min(92, Math.max(8, hover.frac * 100))}%` }}>
                {formatDuration(hover.time * 1000)}
              </div>
            )}
          </div>
          <div className="vp-row">
            <button className="vp-btn" aria-label={paused ? 'Play' : 'Pause'} onClick={togglePlay}>
              <Icon path={paused ? mdiPlay : mdiPause} size={22} />
            </button>
            <span className="vp-time">
              {formatDuration(shown * 1000)}
              {!narrow && <span className="vp-time-total"> / {formatDuration(duration * 1000)}</span>}
            </span>
            <span className="vp-spacer" />
            <div className="vp-volume">
              <input
                type="range"
                className="slider vp-volume-slider"
                min={0}
                max={1}
                step={0.01}
                value={muted ? 0 : volume}
                aria-label="Volume"
                style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as CSSProperties}
                onChange={(e) => applyVolume(Number(e.target.value), Number(e.target.value) === 0)}
              />
              <button className="vp-btn" aria-label={muted ? 'Unmute' : 'Mute'} onClick={toggleMute}>
                <Icon path={volumeIcon(volume, muted)} size={20} />
              </button>
            </div>
            {!narrow && (
              <button className="vp-btn vp-speed" aria-label={`Speed ${speed}x`} onClick={cycleSpeed} {...tip('Playback speed')}>
                {speed}×
              </button>
            )}
            {canPip && !narrow && (
              <button className="vp-btn" aria-label="Picture in picture" onClick={togglePip} {...tip('Picture in Picture')}>
                <Icon path={mdiPictureInPictureBottomRight} size={20} />
              </button>
            )}
            {filename && !narrow && (
              <a className="vp-btn" href={src} download={filename} aria-label="Download" {...tip('Download')}>
                <Icon path={mdiDownload} size={20} />
              </a>
            )}
            <button className="vp-btn" aria-label={fullscreen ? 'Exit full screen' : 'Full screen'} onClick={toggleFullscreen}>
              <Icon path={fullscreen ? mdiFullscreenExit : mdiFullscreen} size={22} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
