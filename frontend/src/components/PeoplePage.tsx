import { useMemo, useState } from 'react';
import { userAvatar } from '../lib/avatars';
import { CreateDMModal } from '../modals/DMModals';
import { openContextMenu, openDM, openModal } from '../store/actions';
import { displayName } from '../store/selectors';
import { setState, useStore } from '../store/store';
import { Icon, mdiAccountMultiple, mdiDotsVertical, mdiMenu, mdiMessageText, TavernLogo } from './icons';
import { tip } from './layers';
import { ProfilePopoutHost, userMenu } from './Profiles';
import { Avatar, STATUS_LABEL } from './ui';

/** Home page: everyone you share a server with (Tavern has no friend list). */
export default function PeoplePage() {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [tab, setTab] = useState<'online' | 'all'>('online');
  const [query, setQuery] = useState('');

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => u.id !== me.id)
      .filter((u) => (tab === 'online' ? u.status !== 'offline' : true))
      .filter((u) => !q || u.username.includes(q) || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [users, me.id, tab, query]);

  return (
    <div className="people">
      <header className="chat-header">
        <button className="mobile-nav-button" aria-label="Open navigation" onClick={() => setState({ mobileNavOpen: true })}>
          <Icon path={mdiMenu} size={24} />
        </button>
        <div className="chat-header-title">
          <Icon path={mdiAccountMultiple} size={24} className="chat-header-icon" />
          <h1 className="chat-header-name">People</h1>
          <div className="chat-header-divider" />
          <div className="people-tabs" role="tablist">
            <button className={`people-tab ${tab === 'online' ? 'active' : ''}`} onClick={() => setTab('online')} role="tab" aria-selected={tab === 'online'}>
              Online
            </button>
            <button className={`people-tab ${tab === 'all' ? 'active' : ''}`} onClick={() => setTab('all')} role="tab" aria-selected={tab === 'all'}>
              All
            </button>
            <button className="people-tab add" onClick={() => openModal((close) => <CreateDMModal onClose={close} />)}>
              New Message
            </button>
          </div>
        </div>
      </header>
      <div className="people-body">
        <div className="people-search">
          <input placeholder="Search" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Search people" />
        </div>
        <h2 className="people-count">
          {tab === 'online' ? 'Online' : 'Everyone'} — {people.length}
        </h2>
        <div className="people-list scroller-auto">
          {people.map((u) => (
            <div key={u.id} className="person" onClick={() => void openDM([u.id])} role="button" tabIndex={0}>
              <div className="person-main">
                <Avatar src={userAvatar(u)} size={32} status={u.status} />
                <div className="person-text">
                  <div className="person-name">
                    {displayName(u)} <span className="person-username">{u.username}</span>
                  </div>
                  <div className="person-status">{STATUS_LABEL[u.status]}</div>
                </div>
              </div>
              <div className="person-actions">
                <button
                  className="person-action"
                  aria-label="Message"
                  {...tip('Message')}
                  onClick={(e) => {
                    e.stopPropagation();
                    void openDM([u.id]);
                  }}
                >
                  <Icon path={mdiMessageText} size={20} />
                </button>
                <button
                  className="person-action"
                  aria-label="More"
                  {...tip('More')}
                  onClick={(e) => {
                    e.stopPropagation();
                    const r = e.currentTarget.getBoundingClientRect();
                    openContextMenu({ clientX: r.left, clientY: r.bottom + 4 }, () => userMenu(u.id, null));
                  }}
                >
                  <Icon path={mdiDotsVertical} size={20} />
                </button>
              </div>
            </div>
          ))}
          {people.length === 0 && (
            <div className="empty-state">
              <div className="empty-state-art">
                <TavernLogo size={96} />
              </div>
              <p>{tab === 'online' ? "Nobody's around right now. The tavern is quiet." : 'Join a server to meet people. They show up here.'}</p>
            </div>
          )}
        </div>
      </div>
      <ProfilePopoutHost />
    </div>
  );
}
