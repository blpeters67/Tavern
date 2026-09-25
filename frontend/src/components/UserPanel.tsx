import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/http';
import { userAvatar } from '../lib/avatars';
import { latestRtt, pingServer } from '../lib/clock';
import { engine, leaveVoice, useVoiceUi, type PeerLatency } from '../lib/voice';
import { go, openModal, openSettings } from '../store/actions';
import { displayName } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Me, StatusChoice } from '../store/types';
import {
  Icon,
  mdiClose,
  mdiCog,
  mdiEmoticonOutline,
  mdiHeadphones,
  mdiHeadphonesOff,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorOff,
  mdiMonitorShare,
  mdiPencil,
  mdiPhoneHangup,
  mdiSignal,
  mdiVideo,
  mdiVideoOff,
} from './icons';
import { Modal, Popout, tip, usePopout } from './layers';
import { toggleScreenShare } from './StreamQuality';
import { toast } from './Toasts';
import { Avatar, Button, STATUS_LABEL, StatusDot, TextInput } from './ui';

const STATUS_HELP: Partial<Record<StatusChoice, string>> = {
  dnd: 'Mutes the red badges on your tab title.',
  invisible: "You'll look offline, but still have full access.",
};

const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;

async function patchMe(body: Partial<Pick<Me, 'status' | 'custom_status'>>) {
  try {
    await api.patch<Me>('/api/users/@me', body);
    return true;
  } catch (err) {
    toast(errorMessage(err));
    return false;
  }
}

function CustomStatusModal({ current, onClose }: { current: string; onClose: () => void }) {
  const [value, setValue] = useState(current);
  const [saving, setSaving] = useState(false);
  const save = async (text: string | null) => {
    setSaving(true);
    if (await patchMe({ custom_status: text })) onClose();
    setSaving(false);
  };
  return (
    <Modal
      title="Set a custom status"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button loading={saving} onClick={() => save(value.trim() || null)}>
            Save
          </Button>
        </>
      }
    >
      <label className="field-label" htmlFor="custom-status">
        What's happening?
      </label>
      <div className="custom-status-input">
        <Icon path={mdiEmoticonOutline} size={20} className="custom-status-emoji" />
        <TextInput
          id="custom-status"
          autoFocus
          value={value}
          maxLength={128}
          placeholder="Brewing potions until Friday"
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && !saving && save(value.trim() || null)}
        />
        {value && (
          <button className="custom-status-clear" aria-label="Clear" onClick={() => setValue('')}>
            <Icon path={mdiClose} size={16} />
          </button>
        )}
      </div>
      <p className="field-hint">Shows under your name in the member list and on your profile.</p>
    </Modal>
  );
}

function openCustomStatus(current: string) {
  openModal((close) => <CustomStatusModal current={current} onClose={close} />);
}

function latencyClass(ms: number | null): string {
  if (ms === null) return '';
  return ms < 150 ? 'good' : ms < 300 ? 'ok' : 'bad';
}

/**
 * The tooltip on the Voice Connected bars: round trips to the server and to
 * each person in the call, refreshed every second while it's showing. Voice
 * goes straight between browsers, so the per-person times are what you hear.
 */
function LatencyTip() {
  const trouble = useVoiceUi((v) => Object.values(v.peerStates).some((p) => p === 'failed' || p === 'disconnected'));
  const [server, setServer] = useState<number | null>(latestRtt);
  const [peers, setPeers] = useState<PeerLatency[] | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      pingServer(); // lands in latestRtt() for the next round
      const list = await engine.peerLatency();
      if (!alive) return;
      setPeers(list);
      setServer(latestRtt());
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 1000);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);
  const users = getState().users;
  return (
    <div className="latency-tip">
      {trouble && <div className="latency-trouble">Having trouble reaching someone. Retrying…</div>}
      <div className="latency-title">Latency</div>
      <div className="latency-row">
        <span className="latency-name">Server</span>
        <span className={latencyClass(server)}>{server === null ? '…' : `${server} ms`}</span>
      </div>
      {peers?.map((p) => (
        <div key={p.userId} className="latency-row">
          <span className="latency-name">{displayName(users[p.userId])}</span>
          <span className={latencyClass(p.rtt)}>
            {p.rtt !== null ? `${p.rtt} ms${p.relay ? ' (relay)' : ''}` : p.state === 'failed' ? 'no connection' : 'connecting…'}
          </span>
        </div>
      ))}
      {peers?.length === 0 && <div className="latency-note">Nobody else is here yet.</div>}
    </div>
  );
}

/** The "Voice Connected" strip above your name while you're in a voice space. */
function VoicePanel() {
  const voice = useStore((s) => s.voice);
  const channel = useStore((s) => (s.voice.channelId ? s.channels[s.voice.channelId] : undefined));
  const server = useStore((s) => (s.voice.serverId ? s.servers[s.voice.serverId] : undefined));
  const connection = useVoiceUi((v) => v.connection);
  const trouble = useVoiceUi((v) => Object.values(v.peerStates).some((p) => p === 'failed' || p === 'disconnected'));
  if (voice.status === 'idle' || !channel || !server) return null;

  const state = connection === 'failed' ? 'failed' : voice.status === 'connecting' ? 'connecting' : trouble ? 'trouble' : 'connected';
  const label = { failed: 'Connection Failed', connecting: 'Connecting…', trouble: 'Voice Connected', connected: 'Voice Connected' }[state];
  return (
    <div className="voice-panel">
      <div className="voice-panel-row">
        <div className="voice-panel-info">
          <div className={`voice-panel-state ${state}`} {...tip(<LatencyTip />)}>
            <Icon path={mdiSignal} size={16} />
            <span>{label}</span>
          </div>
          <button className="voice-panel-where" onClick={() => go(`/channels/${server.id}/${channel.id}`)}>
            {channel.name} / {server.name}
          </button>
        </div>
        <button className="panel-button voice-panel-leave" aria-label="Disconnect" {...tip('Disconnect')} onClick={leaveVoice}>
          <Icon path={mdiPhoneHangup} size={20} />
        </button>
      </div>
      <div className="voice-panel-buttons">
        <button
          className={`voice-panel-button ${voice.video ? 'on' : ''}`}
          aria-pressed={voice.video}
          onClick={() => void engine.toggleCamera()}
          {...tip(voice.video ? 'Turn Off Camera' : 'Turn On Camera')}
        >
          <Icon path={voice.video ? mdiVideo : mdiVideoOff} size={18} />
          Video
        </button>
        {canShareScreen && (
          <button
            className={`voice-panel-button ${voice.stream ? 'on' : ''}`}
            aria-pressed={voice.stream}
            onClick={toggleScreenShare}
            {...tip(voice.stream ? 'Stop Sharing' : 'Share Your Screen')}
          >
            <Icon path={voice.stream ? mdiMonitorOff : mdiMonitorShare} size={18} />
            Screen
          </button>
        )}
      </div>
    </div>
  );
}

export default function UserPanel() {
  const me = useStore((s) => s.me)!;
  const voice = useStore((s) => s.voice);
  const serverMuted = useStore((s) => !!s.voiceStates[me.id]?.mute);
  const pop = usePopout();
  const shown = me.status === 'invisible' ? 'offline' : me.status;
  const muted = voice.selfMute || voice.selfDeaf || serverMuted;

  return (
    <section className="user-panel-wrap" aria-label="User area">
      <VoicePanel />
      <div className="user-panel">
        <button className={`user-panel-me ${pop.isOpen ? 'active' : ''}`} onClick={pop.toggle} aria-label="Set status">
          <Avatar src={userAvatar(me)} size={32} status={shown} />
          <span className="user-panel-names">
            <span className="user-panel-name">{displayName(me)}</span>
            <span className="user-panel-sub">
              {me.custom_status ? (
                <span className="sub-status custom">{me.custom_status}</span>
              ) : (
                <span className="sub-status">{STATUS_LABEL[me.status]}</span>
              )}
              <span className="sub-username">{me.username}</span>
            </span>
          </span>
        </button>
        <div className="user-panel-actions">
          <button
            className={`panel-button ${muted ? 'alert' : ''}`}
            aria-label={muted ? 'Unmute' : 'Mute'}
            aria-pressed={muted}
            disabled={serverMuted}
            {...tip(serverMuted ? 'Server muted' : muted ? 'Unmute' : 'Mute')}
            onClick={() => engine.setSelfMute(!(voice.selfMute || voice.selfDeaf))}
          >
            <Icon path={muted ? mdiMicrophoneOff : mdiMicrophone} size={20} />
          </button>
          <button
            className={`panel-button ${voice.selfDeaf ? 'alert' : ''}`}
            aria-label={voice.selfDeaf ? 'Undeafen' : 'Deafen'}
            aria-pressed={voice.selfDeaf}
            {...tip(voice.selfDeaf ? 'Undeafen' : 'Deafen')}
            onClick={() => engine.setSelfDeaf(!voice.selfDeaf)}
          >
            <Icon path={voice.selfDeaf ? mdiHeadphonesOff : mdiHeadphones} size={20} />
          </button>
          <button className="panel-button" aria-label="User Settings" {...tip('User Settings')} onClick={() => openSettings({ kind: 'user' })}>
            <Icon path={mdiCog} size={20} />
          </button>
        </div>
      </div>
      {pop.anchor && (
        <Popout anchor={pop.anchor} side="top-start" onClose={pop.close} className="status-popout">
          <div className="status-card">
            <div className="status-card-banner" style={{ background: me.banner_color !== null ? `#${me.banner_color.toString(16).padStart(6, '0')}` : undefined }} />
            <Avatar src={userAvatar(me)} size={80} status={shown} className="status-card-avatar" />
            <div className="status-card-body">
              <div className="status-card-name">{displayName(me)}</div>
              <div className="status-card-username">{me.username}</div>
              {me.custom_status && <div className="status-card-custom">{me.custom_status}</div>}
              <div className="menu status-menu">
                {(['online', 'idle', 'dnd', 'invisible'] as StatusChoice[]).map((s) => (
                  <button
                    key={s}
                    className={`menu-item status-option ${me.status === s ? 'current' : ''}`}
                    onClick={() => {
                      pop.close();
                      void patchMe({ status: s });
                    }}
                  >
                    <StatusDot status={s} size={10} />
                    <span className="status-option-text">
                      <span className="menu-label">{STATUS_LABEL[s]}</span>
                      {STATUS_HELP[s] && <span className="status-option-help">{STATUS_HELP[s]}</span>}
                    </span>
                  </button>
                ))}
                <div className="menu-separator" />
                <button
                  className="menu-item"
                  onClick={() => {
                    pop.close();
                    openCustomStatus(me.custom_status ?? '');
                  }}
                >
                  <span className="menu-label">{me.custom_status ? 'Edit Custom Status' : 'Set Custom Status'}</span>
                  <Icon path={mdiEmoticonOutline} size={16} className="menu-icon" />
                </button>
                {me.custom_status && (
                  <button
                    className="menu-item"
                    onClick={() => {
                      pop.close();
                      void patchMe({ custom_status: null });
                    }}
                  >
                    <span className="menu-label">Clear Custom Status</span>
                    <Icon path={mdiClose} size={16} className="menu-icon" />
                  </button>
                )}
                <button
                  className="menu-item"
                  onClick={() => {
                    pop.close();
                    openSettings({ kind: 'user', section: 'profile' });
                  }}
                >
                  <span className="menu-label">Edit Profile</span>
                  <Icon path={mdiPencil} size={16} className="menu-icon" />
                </button>
              </div>
            </div>
          </div>
        </Popout>
      )}
    </section>
  );
}
