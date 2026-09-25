import { useMemo, type MouseEvent } from 'react';
import { api, errorMessage } from '../api/http';
import { userAvatar } from '../lib/avatars';
import { CreateDMModal } from '../modals/DMModals';
import { ackChannel, go, openContextMenu, openModal } from '../store/actions';
import { channelTitle, dmPartner, mentionCount } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { Channel } from '../store/types';
import { ChannelType } from '../store/types';
import { Icon, mdiAccountMultiple, mdiClose, mdiPlus } from './icons';
import { MenuItem, MenuSeparator, tip } from './layers';
import { toast } from './Toasts';
import { Avatar } from './ui';

export function GroupIcon({ channel, size = 32 }: { channel: Channel; size?: number }) {
  const hue = (channel.id * 67) % 360;
  return (
    <div className="group-icon" style={{ width: size, height: size, background: `hsl(${hue} 45% 45%)` }}>
      <Icon path={mdiAccountMultiple} size={size * 0.6} />
    </div>
  );
}

async function closeDm(c: Channel) {
  try {
    await api.del(`/api/channels/${c.id}`);
    if (getState().activeChannelId === c.id) go('/channels/@me');
  } catch (err) {
    toast(errorMessage(err));
  }
}

function dmMenu(c: Channel) {
  return (
    <>
      <MenuItem label="Mark As Read" onClick={() => ackChannel(c.id)} />
      <MenuSeparator />
      <MenuItem label={c.type === ChannelType.GROUP_DM ? 'Leave Group' : 'Close DM'} danger={c.type === ChannelType.GROUP_DM} onClick={() => closeDm(c)} />
    </>
  );
}

export default function HomeSidebar({ activeChannelId }: { activeChannelId: number | null }) {
  const channels = useStore((s) => s.channels);
  const users = useStore((s) => s.users);
  const readStates = useStore((s) => s.readStates);

  const dms = useMemo(
    () =>
      Object.values(channels)
        .filter((c) => c.server_id === null)
        .sort((a, b) => (b.last_message_id ?? b.id) - (a.last_message_id ?? a.id)),
    [channels],
  );

  const openCreate = () => openModal((close) => <CreateDMModal onClose={close} />);

  return (
    <div className="sidebar-inner">
      <header className="home-header">
        <button className="home-search" onClick={openCreate}>
          Find or start a conversation
        </button>
      </header>
      <div className="channel-scroller scroller-thin">
        <ul className="dm-list">
          <li className={`dm-item nav ${activeChannelId === null ? 'selected' : ''}`}>
            <a
              href="/channels/@me"
              className="dm-link"
              onClick={(e) => {
                e.preventDefault();
                go('/channels/@me');
              }}
            >
              <span className="dm-nav-icon">
                <Icon path={mdiAccountMultiple} size={24} />
              </span>
              <span className="dm-name">People</span>
            </a>
          </li>
          <li className="dm-header">
            <span>Direct Messages</span>
            <button className="dm-header-add" aria-label="Create DM" {...tip('Create DM')} onClick={openCreate}>
              <Icon path={mdiPlus} size={16} />
            </button>
          </li>
          {dms.map((c) => {
            const s = getState();
            const partner = dmPartner(s, c);
            const selected = c.id === activeChannelId;
            const mentions = mentionCount(s, c.id);
            const unread = mentions > 0 || (!!c.last_message_id && c.last_message_id > (readStates[c.id]?.last_read_id ?? 0));
            return (
              <li key={c.id} className={`dm-item ${selected ? 'selected' : ''} ${unread && !selected ? 'unread' : ''}`}>
                <a
                  href={`/channels/@me/${c.id}`}
                  className="dm-link"
                  onClick={(e: MouseEvent) => {
                    e.preventDefault();
                    go(`/channels/@me/${c.id}`);
                  }}
                  onContextMenu={(e) => openContextMenu(e, () => dmMenu(c))}
                >
                  {c.type === ChannelType.DM ? (
                    <Avatar src={userAvatar(partner ?? users[s.me!.id])} size={32} status={partner?.status ?? 'offline'} />
                  ) : (
                    <GroupIcon channel={c} />
                  )}
                  <span className="dm-text">
                    <span className="dm-name">{channelTitle(s, c)}</span>
                    {c.type === ChannelType.GROUP_DM && <span className="dm-sub">{c.recipient_ids?.length ?? 0} Members</span>}
                  </span>
                  {mentions > 0 && !selected && <span className="mention-badge">{mentions}</span>}
                  <button
                    className="dm-close"
                    aria-label={c.type === ChannelType.GROUP_DM ? 'Leave Group' : 'Close DM'}
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      void closeDm(c);
                    }}
                  >
                    <Icon path={mdiClose} size={16} />
                  </button>
                </a>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
