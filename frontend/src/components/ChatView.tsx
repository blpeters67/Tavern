import { useEffect, useRef, useState, type DragEvent } from 'react';
import { api, errorMessage } from '../api/http';
import { userAvatar } from '../lib/avatars';
import { P } from '../lib/permissions';
import { jumpToMessage, openModal, setPinned, toggleHideRolls, toggleMemberList } from '../store/actions';
import { channelTitle, dmPartner, myChannelPerms } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Channel, Message } from '../store/types';
import { ChannelType } from '../store/types';
import ChannelIcon from './ChannelIcon';
import ChatInput from './ChatInput';
import { GroupIcon } from './HomeSidebar';
import { Icon, mdiAccountMultiple, mdiClose, mdiDiceMultiple, mdiDiceMultipleOutline, mdiMenu, mdiPin, mdiUpload } from './icons';
import { Modal, Popout, tip, usePopout } from './layers';
import { MessageItem } from './Message';
import MessageList from './MessageList';
import { SearchBox } from './SearchPanel';
import { toast } from './Toasts';
import { Avatar, Spinner } from './ui';

function PinsPopout({ channel, anchor, onClose }: { channel: Channel; anchor: DOMRect; onClose: () => void }) {
  const [pins, setPins] = useState<Message[] | null>(null);
  const version = useStore((s) => s.pinsVersion[channel.id] ?? 0);
  const perms = useStore((s) => myChannelPerms(s, s.channels[channel.id]));
  const canPin = (perms & (P.PIN_MESSAGES | P.MANAGE_MESSAGES)) !== 0;

  useEffect(() => {
    let alive = true;
    api
      .get<Message[]>(`/api/channels/${channel.id}/pins`)
      .then((list) => alive && setPins(list))
      .catch((err) => {
        toast(errorMessage(err));
        if (alive) setPins([]);
      });
    return () => {
      alive = false;
    };
  }, [channel.id, version]);

  return (
    <Popout anchor={anchor} side="bottom-end" onClose={onClose} className="pins-popout">
      <div className="pins">
        <header className="pins-header">
          <Icon path={mdiPin} size={20} />
          <h3>Pinned Messages</h3>
        </header>
        <div className="pins-list scroller-thin">
          {pins === null && (
            <div className="pins-empty">
              <Spinner size={28} />
            </div>
          )}
          {pins?.length === 0 && (
            <div className="pins-empty">
              <div className="pins-empty-art">
                <Icon path={mdiPin} size={40} />
              </div>
              <p>This channel doesn't have any pinned messages... yet.</p>
            </div>
          )}
          {pins?.map((m) => (
            <div key={m.id} className="pin-card">
              <MessageItem message={m} groupStart preview />
              <div className="pin-actions">
                <button
                  className="pin-jump"
                  onClick={() => {
                    onClose();
                    void jumpToMessage(channel.id, m.id);
                  }}
                >
                  Jump
                </button>
                {canPin && (
                  <button className="pin-unpin" aria-label="Unpin" {...tip('Unpin')} onClick={() => setPinned(m, false)}>
                    <Icon path={mdiClose} size={16} />
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </Popout>
  );
}

/** Show/hide the right-hand panel (members, jukebox, search). */
export function PanelToggle() {
  const open = useStore((s) => s.memberListOpen);
  return (
    <>
      <button
        className={`header-button desktop-only ${open ? 'active' : ''}`}
        aria-label={open ? 'Hide Member List' : 'Show Member List'}
        onClick={toggleMemberList}
        {...tip(open ? 'Hide Member List' : 'Show Member List', 'bottom')}
      >
        <Icon path={mdiAccountMultiple} size={24} />
      </button>
      <button className="header-button mobile-only" aria-label="Show Member List" onClick={() => setState({ mobileMembersOpen: true })}>
        <Icon path={mdiAccountMultiple} size={24} />
      </button>
    </>
  );
}

function ChatHeader({ channel, board }: { channel: Channel; board?: boolean }) {
  const partner = useStore((s) => dmPartner(s, channel));
  const title = useStore((s) => channelTitle(s, channel));
  const hideRolls = useStore((s) => s.hideRolls);
  const pins = usePopout();
  const pinButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const open = () => pinButton.current && pins.open(pinButton.current.getBoundingClientRect());
    window.addEventListener('tavern:open-pins', open);
    return () => window.removeEventListener('tavern:open-pins', open);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const showTopic = () =>
    openModal((close) => (
      <Modal title={channel.name ?? title} onClose={close}>
        <p className="modal-text topic-text">{channel.topic}</p>
      </Modal>
    ));

  const hasMembers = channel.type === ChannelType.TEXT || channel.type === ChannelType.GROUP_DM;

  return (
    <header className="chat-header">
      <button className="mobile-nav-button" aria-label="Open navigation" onClick={() => setState({ mobileNavOpen: true })}>
        <Icon path={mdiMenu} size={24} />
      </button>
      <div className="chat-header-title">
        {channel.type === ChannelType.TEXT && <ChannelIcon channel={channel} size={22} className="chat-header-icon" />}
        {channel.type === ChannelType.DM && <Avatar src={userAvatar(partner ?? getState().me!)} size={24} status={partner?.status} className="chat-header-avatar" />}
        {channel.type === ChannelType.GROUP_DM && <GroupIcon channel={channel} size={24} />}
        <h1 className={`chat-header-name ${channel.type === ChannelType.TEXT ? 'titled' : ''}`}>{title}</h1>
        {channel.topic && (
          <>
            <div className="chat-header-divider" />
            <button className="chat-header-topic" onClick={showTopic}>
              {channel.topic}
            </button>
          </>
        )}
      </div>
      <div className="chat-header-toolbar">
        <button
          className={`header-button ${hideRolls ? 'active' : ''}`}
          aria-label={hideRolls ? 'Show dice rolls' : 'Hide dice rolls'}
          aria-pressed={hideRolls}
          onClick={toggleHideRolls}
          {...tip(hideRolls ? 'Show dice rolls in this chat (they are hidden right now)' : 'Hide dice rolls in this chat', 'bottom')}
        >
          <Icon path={hideRolls ? mdiDiceMultipleOutline : mdiDiceMultiple} size={24} />
        </button>
        <button
          ref={pinButton}
          className={`header-button ${pins.isOpen ? 'active' : ''}`}
          aria-label="Pinned Messages"
          onClick={pins.toggle}
          {...tip('Pinned Messages', 'bottom')}
        >
          <Icon path={mdiPin} size={24} />
        </button>
        {/* In the board the chat lives in the right column itself, so the
            members-list toggle has nothing to toggle. */}
        {hasMembers && !board && <PanelToggle />}
        <SearchBox channel={channel} />
      </div>
      {pins.anchor && <PinsPopout channel={channel} anchor={pins.anchor} onClose={pins.close} />}
    </header>
  );
}

export default function ChatView({ channel, board }: { channel: Channel; board?: boolean }) {
  const connected = useStore((s) => s.connected);
  const canAttach = useStore((s) => (myChannelPerms(s, s.channels[channel.id]) & (P.ATTACH_FILES | P.SEND_MESSAGES)) === (P.ATTACH_FILES | P.SEND_MESSAGES));
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);

  const hasFiles = (e: DragEvent) => Array.from(e.dataTransfer.types).includes('Files');
  const onDragEnter = (e: DragEvent) => {
    if (!hasFiles(e) || !canAttach) return;
    dragDepth.current++;
    setDragging(true);
  };
  const onDragLeave = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (!dragDepth.current) setDragging(false);
  };
  const onDrop = (e: DragEvent) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files.length) window.dispatchEvent(new CustomEvent('tavern:add-files', { detail: Array.from(e.dataTransfer.files) }));
  };

  return (
    <div
      className="chat"
      onDragEnter={onDragEnter}
      onDragLeave={onDragLeave}
      onDragOver={(e) => hasFiles(e) && canAttach && e.preventDefault()}
      onDrop={onDrop}
    >
      <ChatHeader channel={channel} board={board} />
      <div className="chat-content">
        <div className="chat-main">
          {!connected && <div className="connection-bar">Reconnecting…</div>}
          <MessageList channel={channel} />
          <ChatInput channel={channel} />
        </div>
      </div>
      {dragging && (
        <div className="drop-overlay">
          <div className="drop-card">
            <div className="drop-icon">
              <Icon path={mdiUpload} size={40} />
            </div>
            <h3>Upload to {channelTitle(getState(), channel)}</h3>
            <p>You can add comments before uploading.</p>
          </div>
        </div>
      )}
    </div>
  );
}
