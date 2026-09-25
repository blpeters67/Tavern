import { useState } from 'react';
import { api, errorMessage } from '../api/http';
import { P } from '../lib/permissions';
import { isLocallyMuted, joinVoice, setLocallyMuted, setUserVolume, userVolume } from '../lib/voice';
import { groupedChannels, myChannelPerms, outranks, voiceMembers } from '../store/selectors';
import { getState } from '../store/store';
import type { Channel } from '../store/types';
import ChannelIcon from './ChannelIcon';
import { MenuItem, MenuSeparator } from './layers';
import { openUserProfileAt } from './Profiles';
import { toast } from './Toasts';

function VolumeSlider({ userId }: { userId: number }) {
  const [value, setValue] = useState(() => Math.round(userVolume(userId) * 100));
  return (
    <div className="menu-slider" onClick={(e) => e.stopPropagation()}>
      <div className="menu-slider-label">
        <span>User Volume</span>
        <span>{value}%</span>
      </div>
      <input
        type="range"
        min={0}
        max={200}
        step={5}
        value={value}
        onChange={(e) => {
          const v = Number(e.target.value);
          setValue(v);
          setUserVolume(userId, v / 100);
        }}
        aria-label="User volume"
      />
    </div>
  );
}

async function moderate(serverId: number, userId: number, body: Record<string, unknown>) {
  try {
    await api.patch(`/api/servers/${serverId}/members/${userId}/voice`, body);
  } catch (err) {
    toast(errorMessage(err));
  }
}

/** Voice spaces of a server in sidebar order. */
function voiceGroupsFlat(serverId: number): Channel[] {
  return groupedChannels(getState(), serverId, false, 'voice').flatMap((g) => g.channels);
}

function voiceCount(channelId: number, limit: number | undefined): string | undefined {
  const n = voiceMembers(getState(), channelId).length;
  if (limit) return `${n}/${limit}`;
  return n ? String(n) : undefined;
}

/** Move someone to another voice space (moving yourself just switches spaces). */
export function moveVoiceUser(serverId: number, userId: number, channelId: number): void {
  if (userId === getState().me?.id) {
    joinVoice(channelId);
    return;
  }
  void moderate(serverId, userId, { channel_id: channelId });
}

/** Right-click menu for someone in a voice space. */
export function voiceUserMenu(userId: number, serverId: number) {
  const s = getState();
  const me = s.me!;
  const state = s.voiceStates[userId];
  const channel = state?.channel_id ? s.channels[state.channel_id] : undefined;
  const perms = channel ? myChannelPerms(s, channel) : 0;
  const isMe = userId === me.id;
  const canTouch = isMe || outranks(s, serverId, userId);
  // Where they can go: spaces you can see and move people into (or join, for yourself).
  const others = voiceGroupsFlat(serverId).filter((c) => {
    if (c.id === channel?.id) return false;
    const p = myChannelPerms(s, c);
    return (p & P.VIEW_CHANNEL) !== 0 && (p & (isMe ? P.CONNECT : P.MOVE_MEMBERS)) !== 0;
  });
  return (
    <>
      <MenuItem label="Profile" onClick={() => openUserProfileAt(userId, serverId)} />
      {!isMe && (
        <>
          <MenuSeparator />
          <VolumeSlider userId={userId} />
          <MenuItem label="Mute" checked={isLocallyMuted(userId)} onClick={() => setLocallyMuted(userId, !isLocallyMuted(userId))} />
        </>
      )}
      {state && canTouch && (perms & (P.MUTE_MEMBERS | P.DEAFEN_MEMBERS | P.MOVE_MEMBERS)) !== 0 && <MenuSeparator />}
      {state && canTouch && (perms & P.MUTE_MEMBERS) !== 0 && (
        <MenuItem label="Server Mute" checked={state.mute} danger onClick={() => moderate(serverId, userId, { mute: !state.mute })} />
      )}
      {state && canTouch && (perms & P.DEAFEN_MEMBERS) !== 0 && (
        <MenuItem label="Server Deafen" checked={state.deaf} danger onClick={() => moderate(serverId, userId, { deaf: !state.deaf })} />
      )}
      {state && canTouch && (perms & P.MOVE_MEMBERS) !== 0 && others.length > 0 && (
        <MenuItem
          label="Move To"
          submenu={
            <>
              {others.map((c) => (
                <MenuItem
                  key={c.id}
                  label={
                    <span className="menu-channel">
                      <ChannelIcon channel={c} size={16} />
                      <span>{c.name ?? 'Voice'}</span>
                    </span>
                  }
                  hint={voiceCount(c.id, c.user_limit)}
                  onClick={() => moveVoiceUser(serverId, userId, c.id)}
                />
              ))}
            </>
          }
        />
      )}
      {state && canTouch && !isMe && (perms & P.MOVE_MEMBERS) !== 0 && (
        <MenuItem label="Disconnect" danger onClick={() => moderate(serverId, userId, { disconnect: true })} />
      )}
    </>
  );
}
