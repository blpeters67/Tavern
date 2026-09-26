import { memo, useMemo } from 'react';
import { characterAvatar, userAvatar } from '../lib/avatars';
import { channelPermissions, P } from '../lib/permissions';
import { openContextMenu } from '../store/actions';
import { displayName, narratorName, permCtx, roleColor, userIsDm } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Channel, User } from '../store/types';
import { ChannelType, NARRATOR } from '../store/types';
import { Icon, mdiCrown, mdiDramaMasks, mdiFeather, mdiStarFourPoints, mdiVolumeHigh } from './icons';
import { JukeboxCard, RoleplayToggle } from './Jukebox';
import { tip } from './layers';
import { openUserProfile, userMenu } from './Profiles';
import { SearchResults } from './SearchPanel';
import { TheaterCard } from './Theater';
import { BoardCard } from './GameBoard';
import { Avatar } from './ui';
import { calmColor } from '../lib/format';

interface Group {
  key: string;
  title: string;
  users: User[];
  tone?: 'gold';
}

/** What someone is up to, under their name: writing, who they're playing, or their custom status. */
function MemberActivity({ user, serverId, channelId }: { user: User; serverId: number | null; channelId: number | null }) {
  const typing = useStore((s) => (channelId !== null ? !!s.typing[channelId]?.[user.id] : false));
  const persona = useStore((s) => (channelId !== null ? s.channelPersonas[channelId]?.[user.id] : undefined));
  const character = useStore((s) => (persona && persona > 0 ? s.characters[persona] : undefined));
  const immersive = useStore((s) => !!s.me?.settings.immersive);
  const narrator = useStore((s) => (persona === NARRATOR ? narratorName(s, serverId) : null));

  if (typing) {
    return (
      <span className="member-activity writing">
        <Icon path={mdiFeather} size={13} />
        Writing<span className="writing-dots" aria-hidden />
      </span>
    );
  }
  // Immersive mode hides who plays whom, so don't spell it out here either.
  if (!immersive && character && !character.deleted) {
    return (
      <span className="member-activity in-character" {...tip(`Speaking as ${character.name} here`, 'left')}>
        <img className="member-activity-avatar" src={characterAvatar(character)} alt="" />
        <span className="member-activity-name" style={character.color ? { color: calmColor(character.color) } : undefined}>
          {character.name}
        </span>
      </span>
    );
  }
  if (!immersive && narrator) {
    return (
      <span className="member-activity in-character narrator" {...tip('Narrating here', 'left')}>
        <Icon path={mdiStarFourPoints} size={13} />
        <span className="member-activity-name">{narrator}</span>
      </span>
    );
  }
  if (user.custom_status) {
    return (
      <span className="member-activity custom" title={user.custom_status}>
        {user.custom_status}
      </span>
    );
  }
  return null;
}

const MemberRow = memo(function MemberRow({
  user,
  serverId,
  channelId,
  owner,
  offline,
}: {
  user: User;
  serverId: number | null;
  channelId: number | null;
  owner: boolean;
  offline: boolean;
}) {
  const color = useStore((s) => roleColor(s, serverId, user.id));
  const dm = useStore((s) => (serverId !== null ? userIsDm(s, serverId, user.id) : false));
  const voiceChannel = useStore((s) => {
    const vs = s.voiceStates[user.id];
    return vs?.channel_id && vs.server_id === serverId ? s.channels[vs.channel_id] : undefined;
  });
  return (
    <div
      className={`member ${offline ? 'offline' : ''}`}
      role="button"
      tabIndex={0}
      onClick={(e) => openUserProfile(e.currentTarget.getBoundingClientRect(), user.id, serverId, 'left')}
      onKeyDown={(e) => e.key === 'Enter' && openUserProfile(e.currentTarget.getBoundingClientRect(), user.id, serverId, 'left')}
      onContextMenu={(e) =>
        openContextMenu(e, () =>
          userMenu(user.id, serverId, () => window.dispatchEvent(new CustomEvent('tavern:insert-text', { detail: `@${user.username}` }))),
        )
      }
    >
      <Avatar src={userAvatar(user)} size={32} status={user.status} />
      <div className="member-text">
        <div className="member-name-row">
          <span className="member-name" style={{ color }}>
            {displayName(user)}
          </span>
          {owner && (
            <span className="owner-crown" {...tip('Server Owner')}>
              <Icon path={mdiCrown} size={14} />
            </span>
          )}
          {dm && (
            <span className="member-dm-tag" {...tip('Dungeon Master')}>
              DM
            </span>
          )}
        </div>
        {!offline && <MemberActivity user={user} serverId={serverId} channelId={channelId} />}
      </div>
      {voiceChannel && !offline && (
        <span className="member-voice" {...tip(`In ${voiceChannel.name ?? 'voice'}`, 'left')}>
          <Icon path={mdiVolumeHigh} size={16} />
        </span>
      )}
    </div>
  );
});

function useGroups(channel: Channel | undefined, serverId: number | null): Group[] {
  const members = useStore((s) => (serverId !== null ? s.members[serverId] : undefined));
  const users = useStore((s) => s.users);
  const roles = useStore((s) => s.roles);
  const roleplay = useStore((s) => (serverId !== null ? !!s.servers[serverId]?.roleplay_mode : false));

  return useMemo<Group[]>(() => {
    const s = getState();
    const byName = (a: User, b: User) => displayName(a).localeCompare(displayName(b));
    if (channel?.type === ChannelType.GROUP_DM) {
      const list = (channel.recipient_ids ?? []).map((id) => users[id]).filter(Boolean);
      return [{ key: 'members', title: 'Members', users: list.sort(byName) }];
    }
    if (serverId === null || !members) return [];
    const ctx = permCtx(s, serverId);
    if (!ctx) return [];
    // In a text channel, only people who can see it (like Discord); elsewhere, everyone.
    const visible = Object.values(members).filter(
      (m) => !channel || channel.type !== ChannelType.TEXT || channelPermissions({ ...ctx, member: m }, m.user_id, channel) & P.VIEW_CHANNEL,
    );
    const list = visible.map((m) => users[m.user_id]).filter(Boolean);
    const online = list.filter((u) => u.status !== 'offline');
    const offline = list.filter((u) => u.status === 'offline');

    if (roleplay) {
      const dms = online.filter((u) => userIsDm(s, serverId, u.id));
      const players = online.filter((u) => !userIsDm(s, serverId, u.id));
      return [
        { key: 'dm', title: dms.length === 1 ? 'Dungeon Master' : 'Dungeon Masters', users: dms.sort(byName), tone: 'gold' as const },
        { key: 'session', title: 'In Session', users: players.sort(byName) },
        { key: 'offline', title: 'Offline', users: offline.sort(byName) },
      ].filter((g) => g.users.length);
    }

    const hoisted = Object.values(roles)
      .filter((r) => r.server_id === serverId && r.hoist && !r.is_default)
      .sort((a, b) => b.position - a.position);
    const out: Group[] = hoisted.map((r) => ({ key: `r${r.id}`, title: r.name, users: [] }));
    const rest: User[] = [];
    for (const u of online) {
      const roleIds = members[u.id]?.role_ids ?? [];
      const top = hoisted.find((r) => roleIds.includes(r.id));
      if (top) out.find((g) => g.key === `r${top.id}`)!.users.push(u);
      else rest.push(u);
    }
    out.push({ key: 'online', title: 'Online', users: rest });
    out.push({ key: 'offline', title: 'Offline', users: offline });
    return out.filter((g) => g.users.length).map((g) => ({ ...g, users: g.users.sort(byName) }));
  }, [channel, serverId, members, users, roles, roleplay]);
}

function MemberGroups({ channel, serverId }: { channel: Channel | undefined; serverId: number | null }) {
  const groups = useGroups(channel, serverId);
  const ownerId = useStore((s) => (serverId !== null ? s.servers[serverId]?.owner_id : undefined));
  const channelId = channel && channel.type !== ChannelType.VOICE ? channel.id : null;
  return (
    <div className="member-list-inner">
      {groups.map((g) => (
        <div key={g.key} className={`member-group ${g.tone ?? ''}`}>
          <h3 className="member-group-title">
            {g.key === 'session' && <Icon path={mdiDramaMasks} size={14} />}
            {g.title} — {g.users.length}
          </h3>
          {g.users.map((u) => (
            <MemberRow key={u.id} user={u} serverId={serverId} channelId={channelId} owner={ownerId === u.id} offline={g.key === 'offline'} />
          ))}
        </div>
      ))}
    </div>
  );
}

/**
 * The right-hand column: in servers, the DM Lock switch, the jukebox and the
 * theater on top of the member list; in group DMs, just the members.
 */
export default function RightPanel({ channel, serverId, open }: { channel: Channel | undefined; serverId: number | null; open: boolean }) {
  const hasJukebox = useStore((s) => serverId !== null && !!s.jukebox[serverId]);
  const hasTheater = useStore((s) => serverId !== null && !!s.theater[serverId]);
  const hasBoard = useStore((s) => serverId !== null && !!s.board[serverId]);
  const panel = useStore((s) => s.rightPanel);
  const search =
    panel.kind === 'search' && panel.serverId === serverId && (serverId !== null || panel.channelId === channel?.id) ? panel : null;
  return (
    <aside className={`right-panel scroller-thin ${open ? '' : 'collapsed'} ${search ? 'searching' : ''}`} aria-label={search ? 'Search results' : 'Members'}>
      {search ? (
        <SearchResults key={search.query} query={search.query} serverId={search.serverId} channelId={search.channelId} />
      ) : (
        <>
          {serverId !== null && (
            <div className="right-panel-top">
              <RoleplayToggle serverId={serverId} />
              {hasJukebox && <JukeboxCard serverId={serverId} />}
              {hasTheater && <TheaterCard serverId={serverId} />}
              {hasBoard && <BoardCard serverId={serverId} />}
            </div>
          )}
          <MemberGroups channel={channel} serverId={serverId} />
        </>
      )}
    </aside>
  );
}
