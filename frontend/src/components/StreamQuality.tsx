/**
 * Screen share quality: the "Go Live" window (pick size, smoothness and focus
 * before the browser's screen picker opens), and the quality popover for a
 * stream that's already running (changes apply without picking the screen again).
 */
import { useEffect, useState } from 'react';
import {
  engine,
  normalizeStreamQuality,
  setVoicePrefs,
  STREAM_FPS,
  STREAM_RESOLUTIONS,
  streamBitrate,
  useVoiceUi,
  type StreamQuality,
  type StreamStats,
} from '../lib/voice';
import { openModal } from '../store/actions';
import { voiceMembers } from '../store/selectors';
import { getState, useStore } from '../store/store';
import { Icon, mdiMonitorShare, mdiTune } from './icons';
import { Modal, Popout, tip, usePopout } from './layers';
import { Button } from './ui';

function resolutionLabel(r: number): string {
  return r ? `${r}p` : 'Source';
}

function mbps(bits: number): string {
  const v = bits / 1_000_000;
  return v >= 10 ? `${Math.round(v)} Mbps` : `${v.toFixed(1)} Mbps`;
}

function Segmented<T extends string | number>({ label, value, options, onChange }: { label: string; value: T; options: { value: T; label: string; hint?: string }[]; onChange: (v: T) => void }) {
  return (
    <div className="sq-field">
      <span className="sq-label">{label}</span>
      <div className="sq-seg" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={String(o.value)}
            role="radio"
            aria-checked={o.value === value}
            className={o.value === value ? 'on' : ''}
            onClick={() => onChange(o.value)}
            {...(o.hint ? tip(o.hint) : {})}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Resolution, frame rate, and what to keep when things get tight. */
export function StreamQualityPicker({ value, onChange }: { value: StreamQuality; onChange: (q: StreamQuality) => void }) {
  return (
    <div className="sq-picker">
      <Segmented
        label="Resolution"
        value={value.resolution}
        options={STREAM_RESOLUTIONS.map((r) => ({ value: r, label: resolutionLabel(r), hint: r ? undefined : 'Your screen at its own size' }))}
        onChange={(resolution) => onChange({ ...value, resolution })}
      />
      <Segmented label="Frame Rate" value={value.fps} options={STREAM_FPS.map((f) => ({ value: f, label: `${f} FPS` }))} onChange={(fps) => onChange({ ...value, fps })} />
      <Segmented
        label="Best For"
        value={value.optimize}
        options={[
          { value: 'motion', label: 'Motion', hint: 'Games and videos: stays smooth, gets a little softer when the connection is busy' },
          { value: 'detail', label: 'Text', hint: 'Documents, maps and code: stays sharp, gets choppier when the connection is busy' },
        ]}
        onChange={(optimize) => onChange({ ...value, optimize })}
      />
    </div>
  );
}

/** How much upload a choice can take, for the people in the call right now. */
function UploadNote({ quality }: { quality: StreamQuality }) {
  const viewers = useStore((s) => {
    const cid = s.voice.channelId;
    return cid ? Math.max(0, voiceMembers(s, cid).length - 1) : 0;
  });
  const each = streamBitrate(quality);
  return (
    <p className="sq-note">
      Each person watching gets their own copy, so a stream can use up to {mbps(each)} of upload per viewer
      {viewers > 1 ? ` (about ${mbps(each * viewers)} for the ${viewers} people here)` : ''}. If it stutters, lower the resolution first; for text, lower the
      frame rate instead.
    </p>
  );
}

function GoLiveModal({ onClose }: { onClose: () => void }) {
  const saved = useVoiceUi((v) => v.prefs.streamQuality);
  const [quality, setQuality] = useState<StreamQuality>(() => normalizeStreamQuality(saved));
  const [starting, setStarting] = useState(false);
  const goLive = async () => {
    setStarting(true);
    setVoicePrefs({ streamQuality: quality });
    // Straight from this click: browsers only open the screen picker for a click.
    const ok = await engine.startScreen(quality);
    setStarting(false);
    if (ok) onClose();
  };
  return (
    <Modal
      title="Share Your Screen"
      subtitle="Pick the stream quality, then choose a screen, window or tab."
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button look="green" loading={starting} onClick={() => void goLive()}>
            <Icon path={mdiMonitorShare} size={18} />
            Go Live
          </Button>
        </>
      }
    >
      <StreamQualityPicker value={quality} onChange={setQuality} />
      <UploadNote quality={quality} />
    </Modal>
  );
}

/** Start sharing: the Go Live window first. (Stops the stream if one is running.) */
export function toggleScreenShare(): void {
  if (engine.isSharingScreen()) {
    engine.stopScreenShare();
    return;
  }
  if (!getState().voice.channelId) return;
  openModal((close) => <GoLiveModal onClose={close} />);
}

function describeStats(st: StreamStats | null): string {
  if (!st) return 'Starting…';
  if (!st.viewers) return 'Nobody else is here to watch yet.';
  const size = st.height ? `${st.width}×${st.height}` : '…';
  const who = st.viewers === 1 ? '1 viewer' : `${st.viewers} viewers`;
  return `Sending ${size} at ${st.fps} FPS to ${who}${st.bitrate ? ` · ${mbps(st.bitrate)} total` : ''}`;
}

function LiveStats() {
  const [stats, setStats] = useState<StreamStats | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      const st = await engine.streamStats();
      if (alive) setStats(st);
    };
    void poll();
    const t = window.setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      window.clearInterval(t);
    };
  }, []);
  return (
    <div className="sq-stats">
      <div>{describeStats(stats)}</div>
      {stats?.limit === 'bandwidth' && <div className="sq-warn">Held back by your upload speed. A lower resolution or frame rate will run smoother.</div>}
      {stats?.limit === 'cpu' && <div className="sq-warn">Held back by your computer's speed. A lower resolution or frame rate will run smoother.</div>}
    </div>
  );
}

/** The quality button next to "Stop Sharing" while a stream is running. */
export function StreamQualityButton({ className, iconSize = 24 }: { className?: string; iconSize?: number }) {
  const pop = usePopout();
  const quality = useVoiceUi((v) => v.prefs.streamQuality);
  return (
    <>
      <button className={className ?? 'call-button'} aria-label="Stream Quality" onClick={pop.toggle} {...tip('Stream Quality')}>
        <Icon path={mdiTune} size={iconSize} />
      </button>
      {pop.anchor && (
        <Popout anchor={pop.anchor} side="top" onClose={pop.close} className="sq-popout">
          <h3 className="sq-title">Stream Quality</h3>
          <StreamQualityPicker value={quality} onChange={(q) => setVoicePrefs({ streamQuality: q })} />
          <LiveStats />
        </Popout>
      )}
    </>
  );
}
