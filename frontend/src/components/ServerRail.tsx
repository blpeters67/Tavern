import { useMemo, type MouseEvent, type ReactNode } from 'react';
import { serverIcon, userAvatar } from '../lib/avatars';
import { acronym } from '../lib/format';
import { P } from '../lib/permissions';
import { go, markServerRead, openContextMenu, openModal, openSettings } from '../store/actions';
import { channelTitle, dmPartner, mentionCount, myServerPerms, serverBadge } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Server } from '../store/types';
import { ChannelType } from '../store/types';
import { GroupIcon } from './HomeSidebar';
import { Icon, mdiPlus, TavernLogo } from './icons';
import { MenuItem, MenuSeparator, tip } from './layers';
import { CreateChannelModal, CreateServerModal, InviteModal, LeaveServerModal } from '../modals/ServerModals';

function RailItem({
  active,
  unread,
  mentions,
  label,
  onClick,
  onContextMenu,
  children,
  className,
}: {
  active?: boolean;
  unread?: boolean;
  mentions?: number;
  label: string;
  onClick: () => void;
  onContextMenu?: (e: MouseEvent) => void;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rail-item ${active ? 'active' : ''} ${unread ? 'unread' : ''} ${className ?? ''}`}>
      <span className="rail-pill" />
      <button className="rail-button" aria-label={label} onClick={onClick} onContextMenu={onContextMenu} {...tip(label, 'right')}>
        {children}
      </button>
      {!!mentions && <span className="rail-badge">{mentions > 99 ? '99+' : mentions}</span>}
    </div>
  );
}

export function serverMenu(server: Server) {
  const s = getState();
  const perms = myServerPerms(s, server.id);
  const isOwner = s.me?.id === server.owner_id;
  const canSettings = (perms & (P.MANAGE_SERVER | P.MANAGE_ROLES | P.MANAGE_EMOJIS | P.KICK_MEMBERS | P.BAN_MEMBERS)) !== 0;
  return (
    <>
      <MenuItem label="Mark As Read" onClick={() => markServerRead(server.id)} />
      <MenuSeparator />
      {(perms & P.CREATE_INVITE) !== 0 && <MenuItem label="Invite People" brand onClick={() => openModal((close) => <InviteModal serverId={server.id} onClose={close} />)} />}
      {canSettings && <MenuItem label="Server Settings" onClick={() => openSettings({ kind: 'server', id: server.id })} />}
      {(perms & P.MANAGE_CHANNELS) !== 0 && (
        <MenuItem label="Create Channel" onClick={() => openModal((close) => <CreateChannelModal serverId={server.id} onClose={close} />)} />
      )}
      {!isOwner && (
        <>
          <MenuSeparator />
          <MenuItem label="Leave Server" danger onClick={() => openModal((close) => <LeaveServerModal server={server} onClose={close} />)} />
        </>
      )}
    </>
  );
}

export default function ServerRail({ activeServerId }: { activeServerId: number | null }) {
  const servers = useStore((s) => s.servers);
  const members = useStore((s) => s.members);
  const me = useStore((s) => s.me);
  const channels = useStore((s) => s.channels);
  const readStates = useStore((s) => s.readStates);
  const roles = useStore((s) => s.roles);
  const users = useStore((s) => s.users);

  const ordered = useMemo(() => {
    const joined = (id: number) => (me ? (members[id]?.[me.id]?.joined_at ?? '') : '');
    return Object.values(servers).sort((a, b) => joined(a.id).localeCompare(joined(b.id)) || a.id - b.id);
  }, [servers, members, me]);

  const badges = useMemo(() => {
    const s = getState();
    return Object.fromEntries(ordered.map((srv) => [srv.id, serverBadge(s, srv.id)]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ordered, channels, readStates, roles, members]);

  // DMs with unread messages show up at the top, like Discord.
  const unreadDms = useMemo(() => {
    const s = getState();
    return Object.values(channels)
      .filter((c) => c.server_id === null && mentionCount(s, c.id) > 0)
      .sort((a, b) => (b.last_message_id ?? 0) - (a.last_message_id ?? 0));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channels, readStates, users]);

  return (
    <nav className="rail scroller-none" aria-label="Servers">
      <RailItem label="Direct Messages" active={activeServerId === null} onClick={() => go('/channels/@me')} className="rail-home">
        <TavernLogo size={30} />
      </RailItem>
      {unreadDms.map((dm) => {
        const s = getState();
        const partner = dmPartner(s, dm);
        return (
          <RailItem key={dm.id} label={channelTitle(s, dm)} mentions={mentionCount(s, dm.id)} onClick={() => go(`/channels/@me/${dm.id}`)} className="rail-dm">
            {dm.type === ChannelType.GROUP_DM ? <GroupIcon channel={dm} size={48} /> : <img src={userAvatar(partner ?? { id: dm.id, avatar: null })} alt="" />}
          </RailItem>
        );
      })}
      <div className="rail-separator" />
      {ordered.map((srv) => {
        const icon = serverIcon(srv.icon);
        const b = badges[srv.id];
        return (
          <RailItem
            key={srv.id}
            label={srv.name}
            active={activeServerId === srv.id}
            unread={b?.unread}
            mentions={b?.mentions}
            onClick={() => go(`/channels/${srv.id}`)}
            onContextMenu={(e) => openContextMenu(e, () => serverMenu(srv))}
          >
            {icon ? <img src={icon} alt="" /> : <span className="rail-acronym">{acronym(srv.name)}</span>}
          </RailItem>
        );
      })}
      <RailItem label="Add a Server" onClick={() => openModal((close) => <CreateServerModal onClose={close} />)} className="rail-add">
        <Icon path={mdiPlus} size={24} />
      </RailItem>
    </nav>
  );
}
