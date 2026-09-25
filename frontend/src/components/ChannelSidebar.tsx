import { useEffect, useMemo, useRef, useState, type DragEvent, type MouseEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { api, errorMessage } from '../api/http';
import { serverIcon, userAvatar } from '../lib/avatars';
import { P, everyoneRole } from '../lib/permissions';
import { load, save } from '../lib/storage';
import { joinVoice, useVoiceUi } from '../lib/voice';
import { CreateChannelModal, DeleteChannelModal, InviteModal } from '../modals/ServerModals';
import { ackChannel, go, openContextMenu, openModal, openSettings, toggleCategory } from '../store/actions';
import { displayName, groupedChannels, isUnread, mentionCount, myChannelPerms, myServerPerms, outranks, voiceMembers, type ChannelGroup } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Channel, Server, VoiceState } from '../store/types';
import { ChannelType } from '../store/types';
import ChannelIcon from './ChannelIcon';
import {
  Icon,
  mdiAccountGroupOutline,
  mdiAccountPlus,
  mdiChevronDown,
  mdiClose,
  mdiCog,
  mdiHeadphonesOff,
  mdiLock,
  mdiMicrophoneOff,
  mdiPlus,
  mdiVideo,
  TavernLogo,
} from './icons';
import { MenuItem, MenuSeparator, Popout, tip, usePopout } from './layers';
import { moveVoiceUser, voiceUserMenu } from './VoiceMenus';
import { serverMenu } from './ServerRail';
import { toast } from './Toasts';

type DropSpot = { targetId: number; where: 'before' | 'after' | 'into' } | null;
type Section = 'text' | 'voice';

function isPrivateChannel(c: Channel, channels: Record<number, Channel>, everyoneId: number | undefined): boolean {
  const denies = (ch: Channel | undefined) => !!ch?.overwrites?.some((o) => o.type === 0 && o.id === everyoneId && o.deny & P.VIEW_CHANNEL);
  return denies(c) || (!!c.parent_id && denies(channels[c.parent_id]));
}

export function channelMenu(channel: Channel) {
  const s = getState();
  const perms = myChannelPerms(s, channel);
  const manage = (perms & P.MANAGE_CHANNELS) !== 0;
  const isCategory = channel.type === ChannelType.CATEGORY;
  return (
    <>
      {channel.type === ChannelType.TEXT && <MenuItem label="Mark As Read" onClick={() => ackChannel(channel.id)} />}
      {channel.type === ChannelType.VOICE && s.voice.channelId !== channel.id && (perms & P.CONNECT) !== 0 && (
        <MenuItem label="Join Voice Space" onClick={() => joinVoice(channel.id)} />
      )}
      {!isCategory && (manage || perms & P.CREATE_INVITE) !== 0 && <MenuSeparator />}
      {!isCategory && (perms & P.CREATE_INVITE) !== 0 && channel.server_id && (
        <MenuItem label="Invite People" brand onClick={() => openModal((close) => <InviteModal serverId={channel.server_id!} channelId={channel.id} onClose={close} />)} />
      )}
      {manage && <MenuItem label={isCategory ? 'Edit Category' : 'Edit Channel'} onClick={() => openSettings({ kind: 'channel', id: channel.id })} />}
      {manage && (
        <>
          <MenuSeparator />
          <MenuItem
            label={isCategory ? 'Delete Category' : 'Delete Channel'}
            danger
            onClick={() => openModal((close) => <DeleteChannelModal channel={channel} onClose={close} />)}
          />
        </>
      )}
    </>
  );
}

function ServerBrand({ server }: { server: Server }) {
  const menu = usePopout();
  const icon = serverIcon(server.icon);
  const canManage = useStore((s) => (myServerPerms(s, server.id) & P.MANAGE_CHANNELS) !== 0);
  return (
    <>
      <header
        className={`server-brand ${menu.isOpen ? 'open' : ''}`}
        onClick={(e) => menu.toggle(e)}
        role="button"
        tabIndex={0}
        aria-expanded={menu.isOpen}
      >
        <div className="server-brand-art">{icon ? <img src={icon} alt="" /> : <TavernLogo size={34} />}</div>
        <div className="server-brand-text">
          <h2 className="server-brand-name">{server.name}</h2>
          {server.tagline && <div className="server-brand-tagline">{server.tagline}</div>}
        </div>
        <Icon path={menu.isOpen ? mdiClose : mdiChevronDown} size={18} className="server-brand-chevron" />
      </header>
      {menu.anchor && (
        <Popout anchor={menu.anchor} side="bottom" gap={4} onClose={menu.close} className="server-menu-popout">
          <div className="menu server-menu" onClick={menu.close}>
            {serverMenu(server)}
            {canManage && (
              <MenuItem label="Create Category" onClick={() => openModal((close) => <CreateChannelModal serverId={server.id} category onClose={close} />)} />
            )}
          </div>
        </Popout>
      )}
    </>
  );
}

function VoiceUserRow({
  state,
  serverId,
  onDragStart,
  onDragEnd,
}: {
  state: VoiceState;
  serverId: number;
  onDragStart?: (e: DragEvent) => void;
  onDragEnd?: () => void;
}) {
  const user = useStore((s) => s.users[state.user_id]);
  const localMuted = useVoiceUi((v) => !!v.localMutes[state.user_id]);
  if (!user) return null;
  const muted = state.mute || state.self_mute;
  const deaf = state.deaf || state.self_deaf;
  return (
    <li
      className={`voice-user ${state.speaking && !muted ? 'speaking' : ''} ${onDragStart ? 'draggable' : ''}`}
      onContextMenu={(e) => openContextMenu(e, () => voiceUserMenu(state.user_id, serverId))}
      draggable={!!onDragStart}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
    >
      <span className="voice-user-avatar">
        <img src={userAvatar(user)} alt="" />
      </span>
      <span className="voice-user-name">{displayName(user)}</span>
      <span className="voice-user-icons">
        {state.self_stream && <span className="live-badge">Live</span>}
        {state.self_video && <Icon path={mdiVideo} size={15} />}
        {(muted || localMuted) && (
          <span {...tip(state.mute ? 'Server muted' : localMuted ? 'Muted for you' : 'Muted')}>
            <Icon path={mdiMicrophoneOff} size={15} className={state.mute || localMuted ? 'danger' : ''} />
          </span>
        )}
        {deaf && (
          <span {...tip(state.deaf ? 'Server deafened' : 'Deafened')}>
            <Icon path={mdiHeadphonesOff} size={15} className={state.deaf ? 'danger' : ''} />
          </span>
        )}
      </span>
    </li>
  );
}

function useSplit(): [number, (v: number) => void] {
  const [split, setSplit] = useState(() => load<number>('sidebarSplit', 0.62));
  return [
    split,
    (v: number) => {
      const clamped = Math.max(0.18, Math.min(0.86, v));
      setSplit(clamped);
      save('sidebarSplit', clamped);
    },
  ];
}

export default function ChannelSidebar({ server, activeChannelId, communityActive }: { server: Server; activeChannelId: number | null; communityActive?: boolean }) {
  const channels = useStore((s) => s.channels);
  useStore((s) => s.readStates); // re-render for unread dots
  const roles = useStore((s) => s.roles);
  const members = useStore((s) => s.members);
  const collapsed = useStore((s) => s.collapsedCategories);
  const voiceStates = useStore((s) => s.voiceStates);
  const myVoiceChannel = useStore((s) => s.voice.channelId);
  const [drag, setDrag] = useState<Channel | null>(null);
  const [drop, setDrop] = useState<DropSpot>(null);
  // Dragging someone (or yourself) from one voice space to another.
  const [userDrag, setUserDrag] = useState<{ userId: number; from: number } | null>(null);
  const [userDrop, setUserDrop] = useState<number | null>(null);
  const [split, setSplit] = useSplit();
  const splitHost = useRef<HTMLDivElement>(null);
  const [resizing, setResizing] = useState(false);

  const textGroups = useMemo(() => groupedChannels(getState(), server.id, false, 'text'), [server.id, channels, roles, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const voiceGroups = useMemo(() => groupedChannels(getState(), server.id, false, 'voice'), [server.id, channels, roles, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const serverPerms = useMemo(() => myServerPerms(getState(), server.id), [server.id, roles, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const canManage = (serverPerms & P.MANAGE_CHANNELS) !== 0;
  const everyoneId = everyoneRole(roles, server.id)?.id;
  const hasVoice = voiceGroups.some((g) => g.channels.length) || canManage;

  // ---- resizable split between text channels and voice spaces ----
  const startResize = (e: ReactPointerEvent) => {
    e.preventDefault();
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
    setResizing(true);
  };
  const onResize = (e: ReactPointerEvent) => {
    if (!resizing || !splitHost.current) return;
    const rect = splitHost.current.getBoundingClientRect();
    setSplit((e.clientY - rect.top) / rect.height);
  };
  const stopResize = () => setResizing(false);

  // ---- drag & drop ordering (admins only) ----
  const onDragStart = (e: DragEvent, ch: Channel) => {
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(ch.id));
    setDrag(ch);
  };
  const onDragOver = (e: DragEvent, target: Channel) => {
    if (!drag || drag.id === target.id) return;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const upper = e.clientY < rect.top + rect.height / 2;
    let spot: DropSpot = null;
    if (drag.type === ChannelType.CATEGORY) {
      if (target.type === ChannelType.CATEGORY) spot = { targetId: target.id, where: upper ? 'before' : 'after' };
    } else if (target.type === ChannelType.CATEGORY) {
      spot = { targetId: target.id, where: 'into' };
    } else if (target.type === drag.type) {
      spot = { targetId: target.id, where: upper ? 'before' : 'after' };
    }
    if (!spot) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (spot.targetId !== drop?.targetId || spot.where !== drop?.where) setDrop(spot);
  };
  const endDrag = () => {
    setDrag(null);
    setDrop(null);
  };

  // ---- dragging people between voice spaces ----
  const canDragUser = (v: VoiceState) => {
    const s = getState();
    if (v.user_id === s.me?.id) return true;
    const from = s.channels[v.channel_id ?? 0];
    return !!from && (myChannelPerms(s, from) & P.MOVE_MEMBERS) !== 0 && outranks(s, server.id, v.user_id);
  };
  const canDropUserOn = (c: Channel) => {
    if (!userDrag || userDrag.from === c.id) return false;
    const s = getState();
    const perms = myChannelPerms(s, c);
    return (perms & P.VIEW_CHANNEL) !== 0 && (perms & (userDrag.userId === s.me?.id ? P.CONNECT : P.MOVE_MEMBERS)) !== 0;
  };
  const startUserDrag = (e: DragEvent, v: VoiceState) => {
    e.stopPropagation(); // not a channel reorder
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', `voice-user:${v.user_id}`);
    setUserDrag({ userId: v.user_id, from: v.channel_id ?? 0 });
  };
  const endUserDrag = () => {
    setUserDrag(null);
    setUserDrop(null);
  };
  const voiceDropProps = (c: Channel) => {
    const channelDrag = dragProps(c);
    return {
      ...channelDrag,
      onDragOver: (e: DragEvent) => {
        if (!userDrag) return channelDrag.onDragOver?.(e);
        if (!canDropUserOn(c)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        if (userDrop !== c.id) setUserDrop(c.id);
      },
      onDragLeave: (e: DragEvent) => {
        if (userDrag && !(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node | null)) setUserDrop((d) => (d === c.id ? null : d));
      },
      onDrop: (e: DragEvent) => {
        if (!userDrag) return channelDrag.onDrop?.(e);
        e.preventDefault();
        const moving = userDrag;
        const ok = canDropUserOn(c);
        endUserDrag();
        if (ok) moveVoiceUser(server.id, moving.userId, c.id);
      },
    };
  };
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const dragged = drag;
    const spot = drop;
    endDrag();
    if (!dragged || !spot) return;
    const s = getState();
    const section: Section = dragged.type === ChannelType.VOICE ? 'voice' : 'text';
    const all = groupedChannels(s, server.id, true, section);
    const changes: { id: number; position: number; parent_id: number | null }[] = [];
    if (dragged.type === ChannelType.CATEGORY) {
      const cats = Object.values(s.channels)
        .filter((c) => c.server_id === server.id && c.type === ChannelType.CATEGORY && c.id !== dragged.id)
        .sort((a, b) => a.position - b.position || a.id - b.id);
      const idx = cats.findIndex((c) => c.id === spot.targetId);
      cats.splice(spot.where === 'before' ? idx : idx + 1, 0, dragged);
      cats.forEach((c, i) => c.position !== i && changes.push({ id: c.id, position: i, parent_id: null }));
    } else {
      const target = s.channels[spot.targetId];
      const parentId = spot.where === 'into' ? target.id : target.parent_id;
      const group = all.find((g) => (g.category?.id ?? null) === (parentId ?? null));
      const list = (group?.channels ?? []).filter((c) => c.id !== dragged.id);
      const idx = spot.where === 'into' ? list.length : list.findIndex((c) => c.id === target.id) + (spot.where === 'after' ? 1 : 0);
      list.splice(idx, 0, dragged);
      list.forEach((c, i) => {
        if (c.position !== i || (c.parent_id ?? null) !== (parentId ?? null)) changes.push({ id: c.id, position: i, parent_id: parentId ?? null });
      });
    }
    if (!changes.length) return;
    setState((st) => {
      const next = { ...st.channels };
      for (const ch of changes) next[ch.id] = { ...next[ch.id], position: ch.position, parent_id: ch.parent_id };
      return { channels: next };
    });
    try {
      await api.patch(`/api/servers/${server.id}/channels`, changes);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const dragProps = (
    ch: Channel,
  ): {
    draggable?: boolean;
    onDragStart?: (e: DragEvent) => void;
    onDragOver?: (e: DragEvent) => void;
    onDrop?: (e: DragEvent) => void;
    onDragEnd?: () => void;
  } =>
    canManage
      ? {
          draggable: true,
          onDragStart: (e: DragEvent) => onDragStart(e, ch),
          onDragOver: (e: DragEvent) => onDragOver(e, ch),
          onDrop: (e: DragEvent) => void onDrop(e),
          onDragEnd: endDrag,
        }
      : {};

  const dropClass = (id: number) => (drop?.targetId === id ? `drop-${drop.where}` : '');

  const renderText = (c: Channel) => {
    const s = getState();
    const selected = c.id === activeChannelId;
    const unread = isUnread(s, c);
    const mentions = mentionCount(s, c.id);
    const perms = myChannelPerms(s, c);
    const priv = isPrivateChannel(c, channels, everyoneId);
    return (
      <li key={c.id} className={`channel-item ${selected ? 'selected' : ''} ${unread && !selected ? 'unread' : ''} ${dropClass(c.id)}`} {...dragProps(c)}>
        {unread && !selected && <span className="unread-pill" />}
        <a
          href={`/channels/${server.id}/${c.id}`}
          className="channel-link"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            go(`/channels/${server.id}/${c.id}`);
          }}
          onContextMenu={(e) => openContextMenu(e, () => channelMenu(c))}
          aria-current={selected ? 'page' : undefined}
        >
          <span className="channel-icon">
            <ChannelIcon channel={c} size={19} />
            {priv && <Icon path={mdiLock} size={10} className="channel-lock" />}
          </span>
          <span className="channel-name">{c.name}</span>
          <span className="channel-actions">
            {(perms & P.CREATE_INVITE) !== 0 && (
              <button
                className="channel-action"
                aria-label="Create Invite"
                {...tip('Create Invite')}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openModal((close) => <InviteModal serverId={server.id} channelId={c.id} onClose={close} />);
                }}
              >
                <Icon path={mdiAccountPlus} size={16} />
              </button>
            )}
            {(perms & P.MANAGE_CHANNELS) !== 0 && (
              <button
                className="channel-action"
                aria-label="Edit Channel"
                {...tip('Edit Channel')}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSettings({ kind: 'channel', id: c.id });
                }}
              >
                <Icon path={mdiCog} size={16} />
              </button>
            )}
          </span>
          {mentions > 0 && !selected && <span className="mention-badge">{mentions}</span>}
        </a>
      </li>
    );
  };

  const renderVoice = (c: Channel) => {
    const s = getState();
    const selected = c.id === activeChannelId;
    const perms = myChannelPerms(s, c);
    const people = voiceMembers(s, c.id);
    const connectedHere = myVoiceChannel === c.id;
    const full = !!c.user_limit && people.length >= c.user_limit;
    return (
      <li
        key={c.id}
        className={`channel-item voice-item ${selected ? 'selected' : ''} ${connectedHere ? 'connected' : ''} ${dropClass(c.id)} ${userDrop === c.id ? 'user-drop' : ''}`}
        {...voiceDropProps(c)}
      >
        <a
          href={`/channels/${server.id}/${c.id}`}
          className="channel-link"
          onClick={(e: MouseEvent) => {
            e.preventDefault();
            if (!connectedHere) {
              if (!(perms & P.CONNECT)) {
                toast("You don't have permission to join that voice space.");
                return;
              }
              if (full && !(perms & P.MOVE_MEMBERS)) {
                toast('That voice space is full.');
                return;
              }
              joinVoice(c.id);
            }
            go(`/channels/${server.id}/${c.id}`);
          }}
          onContextMenu={(e) => openContextMenu(e, () => channelMenu(c))}
          aria-current={selected ? 'page' : undefined}
        >
          <span className="channel-icon">
            <ChannelIcon channel={c} size={19} />
          </span>
          <span className="channel-name">{c.name}</span>
          {c.user_limit ? (
            <span className={`voice-limit ${full ? 'full' : ''}`}>
              {String(people.length).padStart(2, '0')}/{String(c.user_limit).padStart(2, '0')}
            </span>
          ) : null}
          <span className="channel-actions">
            {(perms & P.MANAGE_CHANNELS) !== 0 && (
              <button
                className="channel-action"
                aria-label="Edit Voice Space"
                {...tip('Edit Voice Space')}
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  openSettings({ kind: 'channel', id: c.id });
                }}
              >
                <Icon path={mdiCog} size={16} />
              </button>
            )}
          </span>
        </a>
        {people.length > 0 && (
          <ul className="voice-users">
            {people.map((v) => (
              <VoiceUserRow
                key={v.user_id}
                state={v}
                serverId={server.id}
                onDragStart={canDragUser(v) ? (e) => startUserDrag(e, v) : undefined}
                onDragEnd={endUserDrag}
              />
            ))}
          </ul>
        )}
      </li>
    );
  };

  const renderGroup = (g: ChannelGroup, section: Section) => {
    const render = section === 'voice' ? renderVoice : renderText;
    if (!g.category) return g.channels.map(render);
    const cat = g.category;
    const isCollapsed = collapsed[cat.id];
    const s = getState();
    const shown = isCollapsed
      ? g.channels.filter((c) => c.id === activeChannelId || (section === 'text' ? isUnread(s, c) : voiceMembers(s, c.id).length > 0))
      : g.channels;
    const canCreate = (myChannelPerms(s, cat) & P.MANAGE_CHANNELS) !== 0 || canManage;
    return (
      <li key={`${section}-${cat.id}`} className={`category ${dropClass(cat.id)}`}>
        <div className="category-header" {...dragProps(cat)} onContextMenu={(e) => canManage && openContextMenu(e, () => channelMenu(cat))}>
          <button className="category-toggle" onClick={() => toggleCategory(cat.id)} aria-expanded={!isCollapsed}>
            <Icon path={mdiChevronDown} size={12} className={`category-chevron ${isCollapsed ? 'collapsed' : ''}`} />
            <span className="category-name">{cat.name}</span>
          </button>
          {canCreate && (
            <button
              className="category-add"
              aria-label={section === 'voice' ? 'Create Voice Space' : 'Create Channel'}
              {...tip(section === 'voice' ? 'Create Voice Space' : 'Create Channel')}
              onClick={() => openModal((close) => <CreateChannelModal serverId={server.id} parentId={cat.id} voice={section === 'voice'} onClose={close} />)}
            >
              <Icon path={mdiPlus} size={16} />
            </button>
          )}
        </div>
        <ul className="category-channels">{shown.map(render)}</ul>
      </li>
    );
  };

  const sectionHeader = (section: Section) => (
    <div className="section-header">
      <span className="section-title">{section === 'voice' ? 'Voice Spaces' : 'Text Channels'}</span>
      {canManage && (
        <button
          className="section-add"
          aria-label={section === 'voice' ? 'Create Voice Space' : 'Create Channel'}
          {...tip(section === 'voice' ? 'Create Voice Space' : 'Create Channel')}
          onClick={() => openModal((close) => <CreateChannelModal serverId={server.id} voice={section === 'voice'} onClose={close} />)}
        >
          <Icon path={mdiPlus} size={18} />
        </button>
      )}
    </div>
  );

  // Keep the voice pane from collapsing to nothing on short windows.
  useEffect(() => {
    const fix = () => setSplit(split);
    window.addEventListener('resize', fix);
    return () => window.removeEventListener('resize', fix);
  }, [split]); // eslint-disable-line react-hooks/exhaustive-deps

  void voiceStates;

  return (
    <div className="sidebar-inner">
      <ServerBrand server={server} />
      <nav className="sidebar-nav">
        <a
          href={`/channels/${server.id}/community`}
          className={`sidebar-nav-item ${communityActive ? 'selected' : ''}`}
          onClick={(e) => {
            e.preventDefault();
            go(`/channels/${server.id}/community`);
          }}
        >
          <Icon path={mdiAccountGroupOutline} size={22} />
          <span>Community</span>
        </a>
      </nav>
      <div className={`channel-split ${resizing ? 'resizing' : ''}`} ref={splitHost}>
        <div className="channel-pane" style={hasVoice ? { flexBasis: `${split * 100}%` } : { flexBasis: '100%' }}>
          {sectionHeader('text')}
          <div className="channel-scroller scroller-thin">
            <ul className="channel-tree" onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
              {textGroups.map((g) => renderGroup(g, 'text'))}
            </ul>
          </div>
        </div>
        {hasVoice && (
          <>
            <div
              className="channel-split-handle"
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize text and voice sections"
              onPointerDown={startResize}
              onPointerMove={onResize}
              onPointerUp={stopResize}
              onPointerCancel={stopResize}
              onDoubleClick={() => setSplit(0.62)}
            >
              <span />
            </div>
            <div className="channel-pane voice-pane" style={{ flexBasis: `${(1 - split) * 100}%` }}>
              {sectionHeader('voice')}
              <div className="channel-scroller scroller-thin">
                <ul className="channel-tree" onDragLeave={(e) => e.currentTarget === e.target && setDrop(null)}>
                  {voiceGroups.map((g) => renderGroup(g, 'voice'))}
                </ul>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
