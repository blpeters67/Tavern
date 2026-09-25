import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { Icon, mdiEarHearing, mdiMicrophone, mdiVideo } from '../components/icons';
import { tip } from '../components/layers';
import { StreamQualityPicker } from '../components/StreamQuality';
import { Button, Select, Slider, Switch, SwitchRow } from '../components/ui';
import { levelFraction } from '../lib/micChain';
import { engine, listDevices, MicMonitor, setVoicePrefs, useVoiceUi, type NoiseMode } from '../lib/voice';
import { updateSettings } from '../store/actions';
import { useStore } from '../store/store';

const canPickOutput = typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;

function deviceOptions(devices: MediaDeviceInfo[], kind: MediaDeviceKind, fallback: string) {
  const list = devices.filter((d) => d.kind === kind && d.deviceId && d.deviceId !== 'default' && d.deviceId !== 'communications');
  return [{ value: 'default', label: 'Default' }, ...list.map((d, i) => ({ value: d.deviceId, label: d.label || `${fallback} ${i + 1}` }))];
}

/**
 * The mic check outside calls: runs the same processing as a call (so the
 * meter and "hear myself" match what others hear). In a call, the call's own
 * microphone feeds the meters instead. Starts by itself when the browser
 * already allows the microphone, like Discord's settings do.
 */
function useMicCheck(loopback: boolean) {
  const inCall = useStore((s) => s.voice.status === 'connected');
  const prefs = useVoiceUi((v) => v.prefs);
  const [checking, setChecking] = useState(false);
  const [denied, setDenied] = useState(false);
  const monitor = useRef<MicMonitor | null>(null);

  useEffect(() => {
    let alive = true;
    const perms = navigator.permissions as Permissions | undefined;
    perms
      ?.query({ name: 'microphone' as PermissionName })
      .then((st) => alive && st.state === 'granted' && setChecking(true))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, []);

  // (Re)start with the current device and processing settings.
  useEffect(() => {
    if (!checking || inCall) return;
    const m = new MicMonitor();
    monitor.current = m;
    m.setLoopback(loopback);
    void m.start().then((ok) => {
      if (!ok && monitor.current === m) {
        setChecking(false);
        setDenied(true);
      }
    });
    return () => {
      m.stop();
      if (monitor.current === m) monitor.current = null;
    };
    // loopback is applied below without restarting the mic.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [checking, inCall, prefs.inputDeviceId, prefs.noiseMode, prefs.echoCancellation, prefs.autoGainControl]);

  useEffect(() => monitor.current?.setLoopback(loopback), [loopback]);

  return {
    live: inCall || checking,
    inCall,
    checking,
    denied,
    start: () => {
      setDenied(false);
      setChecking(true);
    },
    stop: () => setChecking(false),
  };
}

/**
 * Input sensitivity and the live mic level in one bar: the fill is your voice
 * right now, the handle is where the mic opens. Green past the handle means
 * people hear you.
 */
function SensitivitySlider({ auto, live }: { auto: boolean; live: boolean }) {
  const level = useVoiceUi((v) => (live ? v.level : 0));
  const current = useVoiceUi((v) => v.threshold);
  const manual = useVoiceUi((v) => v.prefs.threshold);
  const threshold = auto ? current : manual;
  const mark = levelFraction(threshold);
  const open = live && level >= mark && level > 0;
  return (
    <div className={`sens ${auto ? 'auto' : ''} ${open ? 'open' : ''}`} style={{ '--mark': `${mark * 100}%`, '--mark-frac': mark, '--level': `${level * 100}%` } as CSSProperties}>
      <div className="sens-track" aria-hidden>
        <div className="sens-level" />
      </div>
      <input
        type="range"
        className="sens-input"
        min={-80}
        max={0}
        step={1}
        value={threshold}
        disabled={auto}
        aria-label="Input sensitivity"
        aria-valuetext={`${Math.round(threshold)} dB`}
        onChange={(e) => setVoicePrefs({ threshold: Number(e.target.value) })}
      />
      {auto && <div className="sens-auto-mark" aria-hidden />}
    </div>
  );
}

function PlainMeter({ live }: { live: boolean }) {
  const level = useVoiceUi((v) => (live ? v.level : 0));
  return (
    <div className="mic-meter" aria-hidden>
      <div className="mic-meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
    </div>
  );
}

function MicCheckRow({ check, loopback, setLoopback }: { check: ReturnType<typeof useMicCheck>; loopback: boolean; setLoopback: (v: boolean) => void }) {
  return (
    <div className="mic-check">
      {check.inCall ? (
        <span className="mic-check-note">
          <Icon path={mdiMicrophone} size={16} /> Showing your microphone in the call.
        </span>
      ) : check.checking ? (
        <>
          <Button size="small" look="secondary" onClick={check.stop}>
            Stop Mic Check
          </Button>
          <label className="mic-check-loop" {...tip('Hear what others would hear. Use headphones, or you might get feedback.')}>
            <Icon path={mdiEarHearing} size={18} />
            Hear myself
            <Switch checked={loopback} onChange={setLoopback} label="Hear myself" />
          </label>
        </>
      ) : (
        <>
          <Button size="small" onClick={check.start}>
            <Icon path={mdiMicrophone} size={16} /> Check My Mic
          </Button>
          <span className="mic-check-note">{check.denied ? "Couldn't open your microphone. Allow it in your browser and try again." : 'See your level and hear yourself.'}</span>
        </>
      )}
    </div>
  );
}

const NOISE_MODES: [NoiseMode, string, string][] = [
  ['isolation', 'Voice Isolation', 'An AI model strips out keyboard clacks, fans, barking dogs and other noise so only your voice goes out. Free and open source; uses a bit more computer power.'],
  ['standard', 'Standard', "Your browser's own noise suppression. Takes the edge off steady noise like fans and hum."],
  ['off', 'None', 'Everything your microphone hears goes out. Best for music or a studio mic.'],
];

function KeyRecorder({ code, label, onChange }: { code: string; label: string; onChange: (code: string, label: string) => void }) {
  const [recording, setRecording] = useState(false);
  useEffect(() => {
    if (!recording) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.key !== 'Escape') onChange(e.code, e.key === ' ' ? 'Space' : e.key.length === 1 ? e.key.toUpperCase() : e.key);
      setRecording(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [recording, onChange]);
  return (
    <div className={`key-recorder ${recording ? 'recording' : ''}`}>
      <kbd>{recording ? 'Press a key…' : label || code}</kbd>
      <Button size="small" look={recording ? 'danger' : 'secondary'} onClick={() => setRecording((r) => !r)}>
        {recording ? 'Cancel' : 'Change Key'}
      </Button>
    </div>
  );
}

function CameraPreview({ deviceId }: { deviceId: string }) {
  const [on, setOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const video = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    if (!on) return;
    let stream: MediaStream | null = null;
    let cancelled = false;
    setError(null);
    if (!navigator.mediaDevices) {
      setError('Browsers only allow the camera on secure pages. Open Tavern at its https:// address.');
      return;
    }
    navigator.mediaDevices
      .getUserMedia({ video: { deviceId: deviceId !== 'default' ? { ideal: deviceId } : undefined, width: { ideal: 640 }, height: { ideal: 360 } } })
      .then((s) => {
        if (cancelled) return s.getTracks().forEach((t) => t.stop());
        stream = s;
        if (video.current) video.current.srcObject = s;
      })
      .catch(() => setError("Couldn't open the camera. Check that the browser has permission to use it."));
    return () => {
      cancelled = true;
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [on, deviceId]);
  return (
    <div className="camera-preview">
      <div className="camera-preview-frame">
        {on && !error ? (
          <video ref={video} autoPlay playsInline muted />
        ) : (
          <div className="camera-preview-off">
            <Icon path={mdiVideo} size={40} />
            {error && <p>{error}</p>}
          </div>
        )}
      </div>
      <Button look={on ? 'secondary' : 'brand'} onClick={() => setOn((v) => !v)}>
        {on ? 'Stop Video' : 'Test Video'}
      </Button>
    </div>
  );
}

export default function VoiceSettings() {
  const prefs = useVoiceUi((v) => v.prefs);
  const isolating = useVoiceUi((v) => v.isolating);
  const isolationError = useVoiceUi((v) => v.isolationError);
  const soundsOn = useStore((s) => s.me!.settings.voice_sounds);
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [loopback, setLoopback] = useState(false);
  const check = useMicCheck(loopback);

  useEffect(() => {
    const refresh = () => void listDevices().then(setDevices);
    refresh();
    navigator.mediaDevices?.addEventListener?.('devicechange', refresh);
    return () => navigator.mediaDevices?.removeEventListener?.('devicechange', refresh);
  }, []);
  // Device names only show up once the page has been allowed to use a mic.
  const unnamed = devices.length > 0 && devices.every((d) => !d.label);
  useEffect(() => {
    if (check.checking && unnamed) void listDevices().then(setDevices);
  }, [check.checking, unnamed]);

  return (
    <>
      <h2 className="settings-title">Voice &amp; Video</h2>
      {!window.isSecureContext && (
        <p className="settings-note warning">
          This page isn't secure (it starts with http://), so your browser won't let Tavern use your microphone or camera. Open Tavern at its https://
          address to talk.
        </p>
      )}
      <h3 className="settings-subtitle">Voice Settings</h3>
      <div className="voice-grid">
        <label className="field">
          <span className="field-label">Input Device</span>
          <Select value={prefs.inputDeviceId} options={deviceOptions(devices, 'audioinput', 'Microphone')} onChange={(v) => setVoicePrefs({ inputDeviceId: v })} />
        </label>
        {canPickOutput && (
          <label className="field">
            <span className="field-label">Output Device</span>
            <Select value={prefs.outputDeviceId} options={deviceOptions(devices, 'audiooutput', 'Speaker')} onChange={(v) => setVoicePrefs({ outputDeviceId: v })} />
          </label>
        )}
      </div>
      {unnamed && (
        <p className="settings-note">
          Device names appear after you let Tavern use your microphone.{' '}
          <button className="link-button" onClick={check.start}>
            Allow now
          </button>
        </p>
      )}
      <div className="voice-grid">
        <div className="field">
          <span className="field-label">Input Volume</span>
          <div className="voice-slider">
            <Slider value={Math.round(prefs.inputVolume * 100)} min={0} max={200} step={5} label="Input volume" onChange={(v) => setVoicePrefs({ inputVolume: v / 100 })} />
            <span>{Math.round(prefs.inputVolume * 100)}%</span>
          </div>
        </div>
        <div className="field">
          <span className="field-label">Output Volume</span>
          <div className="voice-slider">
            <Slider value={Math.round(prefs.outputVolume * 100)} min={0} max={200} step={5} label="Output volume" onChange={(v) => setVoicePrefs({ outputVolume: v / 100 })} />
            <span>{Math.round(prefs.outputVolume * 100)}%</span>
          </div>
        </div>
      </div>

      <h3 className="settings-subtitle">Input Mode</h3>
      <div className="radio-list" role="radiogroup">
        {(
          [
            ['vad', 'Voice Activity', 'Your mic opens when you talk.'],
            ['ptt', 'Push to Talk', 'Hold a key to talk. Nothing goes out otherwise.'],
          ] as const
        ).map(([value, title, desc]) => (
          <button key={value} role="radio" aria-checked={prefs.inputMode === value} className={`radio-row ${prefs.inputMode === value ? 'selected' : ''}`} onClick={() => setVoicePrefs({ inputMode: value })}>
            <span className={`radio ${prefs.inputMode === value ? 'checked' : ''}`} />
            <span>
              <span className="radio-row-title">{title}</span>
              <span className="radio-row-desc">{desc}</span>
            </span>
          </button>
        ))}
      </div>

      {prefs.inputMode === 'ptt' ? (
        <>
          <div className="field">
            <span className="field-label">Shortcut</span>
            <KeyRecorder code={prefs.pttKey} label={prefs.pttKeyLabel} onChange={(code, label) => setVoicePrefs({ pttKey: code, pttKeyLabel: label })} />
            <div className="field-hint">Works while the Tavern tab is focused. Typing it in the message box still types it.</div>
          </div>
          <h3 className="settings-subtitle">Mic Check</h3>
          <PlainMeter live={check.live} />
          <MicCheckRow check={check} loopback={loopback} setLoopback={setLoopback} />
        </>
      ) : (
        <>
          <h3 className="settings-subtitle">Input Sensitivity</h3>
          <SwitchRow
            title="Automatically determine input sensitivity"
            description="Tavern listens to how noisy your room is and moves the marker for you."
            checked={prefs.autoSensitivity}
            onChange={(v) => setVoicePrefs({ autoSensitivity: v })}
          />
          <SensitivitySlider auto={prefs.autoSensitivity} live={check.live} />
          <div className="field-hint sens-hint">
            {prefs.autoSensitivity
              ? 'The bar is your voice right now. When it turns green, people can hear you.'
              : 'The bar is your voice right now; your mic opens when it passes the handle. Drag right if background noise gets through, left if your words get cut off.'}
          </div>
          <MicCheckRow check={check} loopback={loopback} setLoopback={setLoopback} />
        </>
      )}

      <h3 className="settings-subtitle">Noise Suppression</h3>
      <div className="radio-list" role="radiogroup">
        {NOISE_MODES.map(([value, title, desc]) => (
          <button key={value} role="radio" aria-checked={prefs.noiseMode === value} className={`radio-row ${prefs.noiseMode === value ? 'selected' : ''}`} onClick={() => setVoicePrefs({ noiseMode: value })}>
            <span className={`radio ${prefs.noiseMode === value ? 'checked' : ''}`} />
            <span>
              <span className="radio-row-title">
                {title}
                {value === 'isolation' && prefs.noiseMode === 'isolation' && isolating && check.live && <span className="radio-row-badge">On</span>}
              </span>
              <span className="radio-row-desc">{desc}</span>
            </span>
          </button>
        ))}
      </div>
      {isolationError && prefs.noiseMode !== 'off' && <p className="settings-note warning">{isolationError}</p>}
      <SwitchRow title="Echo Cancellation" description="Stops people hearing themselves through your speakers." checked={prefs.echoCancellation} onChange={(v) => setVoicePrefs({ echoCancellation: v })} />
      <SwitchRow title="Automatic Gain Control" description="Evens out your volume if you drift toward or away from the mic." checked={prefs.autoGainControl} onChange={(v) => setVoicePrefs({ autoGainControl: v })} />

      <h3 className="settings-subtitle">Video Settings</h3>
      <div className="voice-grid">
        <label className="field">
          <span className="field-label">Camera</span>
          <Select value={prefs.cameraDeviceId} options={deviceOptions(devices, 'videoinput', 'Camera')} onChange={(v) => setVoicePrefs({ cameraDeviceId: v })} />
        </label>
      </div>
      <CameraPreview deviceId={prefs.cameraDeviceId} />

      <h3 className="settings-subtitle">Screen Share</h3>
      <p className="settings-note">
        The quality your screen shares start at (you can change it while you're live, too). Motion keeps games and videos smooth; Text keeps documents
        and maps sharp.
      </p>
      <StreamQualityPicker value={prefs.streamQuality} onChange={(q) => setVoicePrefs({ streamQuality: q })} />

      <h3 className="settings-subtitle">Sounds</h3>
      <SwitchRow
        title="Join, leave and mute sounds"
        description="Little chimes when people join or leave your voice space, and when you mute or deafen."
        checked={soundsOn}
        onChange={(v) => updateSettings({ voice_sounds: v })}
      />
      {check.inCall && (
        <p className="settings-note">
          Changes apply to your current call right away.{' '}
          <button className="link-button" onClick={() => void engine.restartMic()}>
            Restart microphone
          </button>
        </p>
      )}
    </>
  );
}

