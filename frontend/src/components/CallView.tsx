import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { userAvatar } from '../lib/avatars';
import { colorWithAlpha } from '../lib/format';
import { P } from '../lib/permissions';
import { engine, joinVoice, leaveVoice, useVoiceUi, type VideoTile } from '../lib/voice';
import { openContextMenu, openSettings } from '../store/actions';
import { displayName, myChannelPerms, voiceMembers } from '../store/selectors';
import { setState, useStore } from '../store/store';
import type { Channel, VoiceState } from '../store/types';
import ChannelIcon from './ChannelIcon';
import { PanelToggle } from './ChatView';
import {
  Icon,
  mdiAlert,
  mdiCog,
  mdiFullscreen,
  mdiHeadphones,
  mdiHeadphonesOff,
  mdiMenu,
  mdiMicrophone,
  mdiMicrophoneOff,
  mdiMonitorOff,
  mdiMonitorShare,
  mdiPhoneHangup,
  mdiVideo,
  mdiVideoOff,
  mdiVolumeHigh,
} from './icons';
import { tip } from './layers';
import { toast } from './Toasts';
import { Avatar, Button } from './ui';
import { StreamQualityButton, toggleScreenShare } from './StreamQuality';
import { voiceUserMenu } from './VoiceMenus';

const canShareScreen = typeof navigator !== 'undefined' && !!navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices;

/** One square on the stage: someone's camera, their screen, or their avatar. */
interface StageTile {
  key: string;
  userId: number;
  kind: 'avatar' | 'camera' | 'screen';
  stream?: MediaStream;
  local?: boolean;
}

function buildTiles(people: VoiceState[], videos: VideoTile[]): StageTile[] {
  const out: StageTile[] = [];
  for (const p of people) {
    const camera = videos.find((v) => v.userId === p.user_id && v.kind === 'camera');
    out.push(camera ? { key: camera.key, userId: p.user_id, kind: 'camera', stream: camera.stream, local: camera.local } : { key: `a${p.user_id}`, userId: p.user_id, kind: 'avatar' });
  }
  for (const v of videos) {
    if (v.kind === 'screen' && people.some((p) => p.user_id === v.userId)) out.push({ key: v.key, userId: v.userId, kind: 'screen', stream: v.stream, local: v.local });
  }
  return out;
}

/** Pick columns and a tile width so `count` 16:9 tiles fill the box without scrolling. */
function useFitGrid(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [fit, setFit] = useState({ cols: 1, width: 320 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const gap = 8;
      const W = el.clientWidth;
      const H = el.clientHeight;
      if (!W || !H || !count) return;
      let best = { cols: 1, width: 0 };
      for (let cols = 1; cols <= count; cols++) {
        const rows = Math.ceil(count / cols);
        const w = Math.min((W - gap * (cols - 1)) / cols, ((H - gap * (rows - 1)) / rows) * (16 / 9));
        if (w > best.width) best = { cols, width: w };
      }
      setFit({ cols: best.cols, width: Math.floor(best.width) });
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [count]);
  return { ref, ...fit };
}

function Video({ stream, mirror, contain }: { stream: MediaStream; mirror?: boolean; contain?: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && el.srcObject !== stream) el.srcObject = stream;
  }, [stream]);
  return <video ref={ref} className={`tile-video ${mirror ? 'mirror' : ''} ${contain ? 'contain' : ''}`} autoPlay playsInline muted />;
}

const Tile = memo(function Tile({
  tile,
  serverId,
  focused,
  small,
  width,
  onFocus,
}: {
  tile: StageTile;
  serverId: number;
  focused: boolean;
  small?: boolean;
  width?: number;
  onFocus: (key: string | null) => void;
}) {
  const user = useStore((s) => s.users[tile.userId]);
  const state = useStore((s) => s.voiceStates[tile.userId]);
  const isMe = useStore((s) => s.me?.id === tile.userId);
  const selfSpeaking = useVoiceUi((v) => (isMe ? v.selfSpeaking : false));
  const peerState = useVoiceUi((v) => v.peerStates[tile.userId]);
  const el = useRef<HTMLDivElement>(null);
  if (!user) return null;
  const speaking = tile.kind !== 'screen' && (isMe ? selfSpeaking : !!state?.speaking) && !state?.self_mute && !state?.mute;
  const trouble = !isMe && (peerState === 'failed' || peerState === 'disconnected');
  const tint = user.banner_color !== null ? colorWithAlpha(user.banner_color, 0.22) : undefined;
  const name = displayName(user);

  return (
    <div
      ref={el}
      className={`tile tile-${tile.kind} ${speaking ? 'speaking' : ''} ${focused ? 'focused' : ''} ${small ? 'small' : ''}`}
      style={width ? { width } : undefined}
      role="button"
      tabIndex={0}
      aria-label={tile.kind === 'screen' ? `${name}'s screen` : name}
      onClick={() => onFocus(focused ? null : tile.key)}
      onKeyDown={(e) => e.key === 'Enter' && onFocus(focused ? null : tile.key)}
      onContextMenu={(e) => openContextMenu(e, () => voiceUserMenu(tile.userId, serverId))}
    >
      {tile.stream ? (
        <Video stream={tile.stream} mirror={tile.local && tile.kind === 'camera'} contain={tile.kind === 'screen'} />
      ) : (
        <div className="tile-avatar-wrap" style={tint ? { background: tint } : undefined}>
          <Avatar src={userAvatar(user)} size={small ? 48 : 80} className="tile-avatar" />
        </div>
      )}
      <div className="tile-label">
        {tile.kind === 'screen' && <span className="tile-live">LIVE</span>}
        <span className="tile-name">{tile.kind === 'screen' ? `${name}'s screen` : name}</span>
        {tile.kind !== 'screen' && (state?.mute || state?.self_mute) && (
          <span className={`tile-flag ${state?.mute ? 'server' : ''}`} {...tip(state?.mute ? 'Server muted' : 'Muted')}>
            <Icon path={mdiMicrophoneOff} size={14} />
          </span>
        )}
        {tile.kind !== 'screen' && (state?.deaf || state?.self_deaf) && (
          <span className={`tile-flag ${state?.deaf ? 'server' : ''}`} {...tip(state?.deaf ? 'Server deafened' : 'Deafened')}>
            <Icon path={mdiHeadphonesOff} size={14} />
          </span>
        )}
      </div>
      {trouble && (
        <span className="tile-trouble" {...tip("Can't reach them right now. Retrying…")}>
          <Icon path={mdiAlert} size={16} />
        </span>
      )}
      {tile.stream && (
        <button
          className="tile-fullscreen"
          aria-label="Full screen"
          {...tip('Full Screen')}
          onClick={(e) => {
            e.stopPropagation();
            void el.current?.requestFullscreen?.().catch(() => undefined);
          }}
        >
          <Icon path={mdiFullscreen} size={18} />
        </button>
      )}
    </div>
  );
});

function Stage({ channel, people }: { channel: Channel; people: VoiceState[] }) {
  const videos = useVoiceUi((v) => v.tiles);
  const tiles = buildTiles(people, videos);
  const [focus, setFocus] = useState<string | null>(null);
  const focused = focus ? tiles.find((t) => t.key === focus) : undefined;
  const grid = useFitGrid(focused ? 0 : tiles.length);
  const onFocus = useCallback((key: string | null) => setFocus(key), []);
  const serverId = channel.server_id!;

  if (focused) {
    const rest = tiles.filter((t) => t.key !== focused.key);
    return (
      <div className="stage stage-focus">
        <div className="stage-spotlight">
          <Tile tile={focused} serverId={serverId} focused onFocus={onFocus} />
        </div>
        {rest.length > 0 && (
          <div className="stage-strip scroller-thin">
            {rest.map((t) => (
              <Tile key={t.key} tile={t} serverId={serverId} focused={false} small onFocus={onFocus} />
            ))}
          </div>
        )}
      </div>
    );
  }
  return (
    <div className="stage" ref={grid.ref}>
      <div className="stage-grid" style={{ gridTemplateColumns: `repeat(${grid.cols}, ${grid.width}px)` }}>
        {tiles.map((t) => (
          <Tile key={t.key} tile={t} serverId={serverId} focused={false} width={grid.width} onFocus={onFocus} />
        ))}
      </div>
    </div>
  );
}

function ControlButton({
  label,
  icon,
  state,
  pressed,
  danger,
  disabled,
  reason,
  onClick,
}: {
  label: string;
  icon: string;
  /** alert = something's off that you'd want to notice (muted); active = something's on (camera). */
  state?: 'alert' | 'active';
  pressed?: boolean;
  danger?: boolean;
  disabled?: boolean;
  reason?: string;
  onClick: () => void;
}) {
  return (
    <button
      className={`call-button ${state ?? ''} ${danger ? 'danger' : ''}`}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      onClick={onClick}
      {...tip(disabled && reason ? reason : label)}
    >
      <Icon path={icon} size={24} />
    </button>
  );
}

function Controls({ channel }: { channel: Channel }) {
  const voice = useStore((s) => s.voice);
  const me = useStore((s) => s.voiceStates[s.me!.id]);
  const perms = useStore((s) => myChannelPerms(s, channel));
  const canSpeak = (perms & P.SPEAK) !== 0 && !me?.mute;
  const canStream = (perms & P.STREAM) !== 0;
  const muted = voice.selfMute || voice.selfDeaf || !!me?.mute;
  return (
    <div className="call-controls">
      <ControlButton
        label={muted ? 'Unmute' : 'Mute'}
        icon={muted ? mdiMicrophoneOff : mdiMicrophone}
        state={muted ? 'alert' : undefined}
        pressed={muted}
        disabled={!canSpeak}
        reason={me?.mute ? 'You were muted by a moderator' : "You don't have permission to speak here"}
        onClick={() => engine.setSelfMute(!(voice.selfMute || voice.selfDeaf))}
      />
      <ControlButton
        label={voice.selfDeaf ? 'Undeafen' : 'Deafen'}
        icon={voice.selfDeaf ? mdiHeadphonesOff : mdiHeadphones}
        state={voice.selfDeaf ? 'alert' : undefined}
        pressed={voice.selfDeaf}
        onClick={() => engine.setSelfDeaf(!voice.selfDeaf)}
      />
      <span className="call-controls-gap" />
      <ControlButton
        label={voice.video ? 'Turn Off Camera' : 'Turn On Camera'}
        icon={voice.video ? mdiVideo : mdiVideoOff}
        state={voice.video ? 'active' : undefined}
        pressed={voice.video}
        disabled={!canStream}
        reason="You don't have permission to share video here"
        onClick={() => void engine.toggleCamera()}
      />
      {canShareScreen && (
        <ControlButton
          label={voice.stream ? 'Stop Sharing' : 'Share Your Screen'}
          icon={voice.stream ? mdiMonitorOff : mdiMonitorShare}
          state={voice.stream ? 'active' : undefined}
          pressed={voice.stream}
          disabled={!canStream}
          reason="You don't have permission to share your screen here"
          onClick={toggleScreenShare}
        />
      )}
      {canShareScreen && voice.stream && <StreamQualityButton />}
      <ControlButton label="Voice Settings" icon={mdiCog} onClick={() => openSettings({ kind: 'user', section: 'voice' })} />
      <span className="call-controls-gap" />
      <ControlButton label="Disconnect" icon={mdiPhoneHangup} danger onClick={leaveVoice} />
    </div>
  );
}

function JoinScreen({ channel, people }: { channel: Channel; people: VoiceState[] }) {
  const users = useStore(useShallow((s) => people.map((p) => s.users[p.user_id]).filter(Boolean)));
  const perms = useStore((s) => myChannelPerms(s, channel));
  const elsewhere = useStore((s) => s.voice.channelId !== null && s.voice.channelId !== channel.id);
  const connecting = useStore((s) => s.voice.channelId === channel.id && s.voice.status === 'connecting');
  const full = !!channel.user_limit && people.length >= channel.user_limit && !(perms & P.MOVE_MEMBERS);
  const allowed = (perms & P.CONNECT) !== 0;
  const speaking = useStore(useShallow((s) => people.filter((p) => s.voiceStates[p.user_id]?.speaking).map((p) => p.user_id)));

  return (
    <div className="call-join">
      <div className="call-join-icon">
        <ChannelIcon channel={channel} size={40} />
      </div>
      <h2 className="call-join-title">{channel.name}</h2>
      <p className="call-join-sub">
        {users.length === 0 ? 'No one is here yet.' : users.length === 1 ? `${displayName(users[0])} is here.` : `${users.length} people are here.`}
      </p>
      {users.length > 0 && (
        <div className="call-join-people">
          {users.slice(0, 12).map((u) => (
            <div key={u.id} className={`call-join-person ${speaking.includes(u.id) ? 'speaking' : ''}`} {...tip(displayName(u))}>
              <Avatar src={userAvatar(u)} size={48} />
            </div>
          ))}
          {users.length > 12 && <span className="call-join-more">+{users.length - 12}</span>}
        </div>
      )}
      <Button
        look="green"
        size="large"
        loading={connecting}
        disabled={!allowed || full}
        onClick={() => {
          if (!allowed) return toast("You don't have permission to join this voice space.");
          joinVoice(channel.id);
        }}
      >
        {elsewhere ? 'Switch Here' : 'Join Voice'}
      </Button>
      {!allowed && <p className="call-join-note">You don't have permission to join this voice space.</p>}
      {allowed && full && <p className="call-join-note">This voice space is full.</p>}
      {allowed && !full && !window.isSecureContext && (
        <p className="call-join-note">This page isn't secure (http://), so you can listen but not talk. Open Tavern at its https:// address to use your mic.</p>
      )}
    </div>
  );
}

/** The main area for a voice space: who's there, their cameras and screens, and the call controls. */
export default function CallView({ channel }: { channel: Channel }) {
  const people = useStore(useShallow((s) => voiceMembers(s, channel.id)));
  const connectedHere = useStore((s) => s.voice.channelId === channel.id && s.voice.status === 'connected');
  return (
    <div className="call-view">
      <header className="chat-header call-header">
        <button className="mobile-nav-button" aria-label="Open navigation" onClick={() => setState({ mobileNavOpen: true })}>
          <Icon path={mdiMenu} size={24} />
        </button>
        <div className="chat-header-title">
          <ChannelIcon channel={channel} size={22} className="chat-header-icon" />
          <h1 className="chat-header-name">{channel.name}</h1>
          {channel.user_limit ? (
            <span className="call-header-count" {...tip('People here / limit', 'bottom')}>
              {people.length}/{channel.user_limit}
            </span>
          ) : people.length > 0 ? (
            <span className="call-header-count">
              <Icon path={mdiVolumeHigh} size={14} /> {people.length}
            </span>
          ) : null}
        </div>
        <div className="chat-header-toolbar">
          <PanelToggle />
        </div>
      </header>
      <div className="call-body">{connectedHere ? <Stage channel={channel} people={people} /> : <JoinScreen channel={channel} people={people} />}</div>
      {connectedHere && <Controls channel={channel} />}
    </div>
  );
}
