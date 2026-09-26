import { lazy, Suspense, useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useShallow } from 'zustand/react/shallow';
import CallView from '../components/CallView';
import ChannelSidebar from '../components/ChannelSidebar';
import ChatView from '../components/ChatView';
import CommunityPage from '../components/CommunityPage';
import HomeSidebar from '../components/HomeSidebar';
import { TavernLogo } from '../components/icons';
import { JukeboxWindowHost } from '../components/Jukebox';
import { BoardRoom } from '../components/GameBoard';
import { TheaterScreenHost } from '../components/Theater';
import PeoplePage from '../components/PeoplePage';
import { ProfilePopoutHost } from '../components/Profiles';
import RightPanel from '../components/RightPanel';
import ServerRail from '../components/ServerRail';
import UserPanel from '../components/UserPanel';
import '../lib/jukebox';
import '../lib/theater';
import { unlockAudioOnGesture } from '../lib/sounds';
import '../lib/voice';
import { channelOpened, go, rememberChannel } from '../store/actions';
import { canView, channelTitle, firstChannel } from '../store/selectors';
import { getState, setState, useStore, type State } from '../store/store';
import { ChannelType, type Channel } from '../store/types';

unlockAudioOnGesture();

// Big screens you open now and then load separately, so the app starts faster
// (and they're fetched in the background once it's up: see Shell).
const loadSheet = () => import('../components/SheetLayer');
const loadTheaterWindow = () => import('../components/TheaterWindow');
const loadSettings = () => import('../settings/SettingsLayer');
const SheetLayer = lazy(loadSheet);
const TheaterWindowHost = lazy(() => loadTheaterWindow().then((m) => ({ default: m.TheaterWindowHost })));
const SettingsLayer = lazy(loadSettings);

const TIPS = [
  "Start a message with your character's proxy tag (like x:) to speak as them without switching.",
  'Click a skill on your character sheet to roll it. Right-click for advantage or a private roll.',
  'Type /roll 1d20+5 (or /r stealth) in the message box to roll dice.',
  'Put speech in "quotes" in character: the rest reads as action.',
  'Select text in the message box for bold, italics, colors and sizes.',
  'Listen in on the jukebox to hear the music in sync with everyone.',
  'Take a seat in the theater to watch videos in step with everyone.',
  'Press Alt+↑ or Alt+↓ in the message box to cycle through your characters.',
  'Immersive mode (User Settings → Roleplay) hides who is playing each character.',
  'Admins can turn off "Use Characters" in out-of-character channels.',
  'Wrap text in ||double bars|| to hide it behind a spoiler.',
  'Press ↑ in an empty message box to edit your last message.',
  'Right-click a message for more options, like pinning it.',
  'Start a line with > to quote it, or >>> to quote everything after it.',
  'Shift+Enter adds a new line without sending.',
];

function LoadingScreen() {
  const [tip] = useState(() => TIPS[Math.floor(Math.random() * TIPS.length)]);
  const [slow, setSlow] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setSlow(true), 8000);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="loading-screen">
      <div className="loading-logo">
        <TavernLogo size={72} />
      </div>
      <div className="loading-tip-title">Did you know</div>
      <div className="loading-tip">{tip}</div>
      {slow && (
        <div className="loading-slow">
          Taking a while to connect.{' '}
          <button className="link-button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
    </div>
  );
}

function NoChannels({ name }: { name: string }) {
  return (
    <div className="empty-state">
      <div className="empty-state-art">
        <TavernLogo size={96} />
      </div>
      <h3>No text channels</h3>
      <p>
        You can't see any channels in <strong>{name}</strong> yet. Someone with Manage Channels can create one.
      </p>
    </div>
  );
}

export default function AppShell() {
  const status = useStore((s) => s.status);
  const params = useParams();
  const [section, channelPart] = (params['*'] ?? '').split('/');
  const serverId = section && section !== '@me' && /^\d+$/.test(section) ? Number(section) : null;
  const channelId = channelPart && /^\d+$/.test(channelPart) ? Number(channelPart) : null;
  const community = serverId !== null && channelPart === 'community';

  if (status !== 'ready') return <LoadingScreen />;
  return <Shell serverId={serverId} channelId={channelId} community={community} invalidSection={!!section && section !== '@me' && serverId === null} />;
}

const isServerView = (type: number) => type === ChannelType.TEXT || type === ChannelType.VOICE;

/**
 * A channel as the views need it. Every new message bumps its channel's
 * last_message_id, which nothing here shows, so it's left out: otherwise the
 * whole app would re-render for each message. (Read it from the store.)
 */
function viewChannel(c: Channel | undefined): Channel | undefined {
  if (!c) return undefined;
  const { last_message_id: _skip, ...rest } = c; // eslint-disable-line @typescript-eslint/no-unused-vars
  return rest as Channel;
}

/** The channel to open in a server: the one you were last in, or the first you can see. */
function fallbackChannel(s: State, serverId: number): number | null {
  const remembered = s.lastChannelByServer[serverId];
  const rc = remembered ? s.channels[remembered] : undefined;
  if (rc && rc.server_id === serverId && rc.type === ChannelType.TEXT && canView(s, rc)) return rc.id;
  return firstChannel(s, serverId)?.id ?? null;
}

function Shell({
  serverId,
  channelId,
  community,
  invalidSection,
}: {
  serverId: number | null;
  channelId: number | null;
  community: boolean;
  invalidSection: boolean;
}) {
  const server = useStore((s) => (serverId !== null ? s.servers[serverId] : undefined));
  const channel = useStore(useShallow((s) => viewChannel(channelId !== null ? s.channels[channelId] : undefined)));
  const settings = useStore((s) => s.settings);
  const navOpen = useStore((s) => s.mobileNavOpen);
  const membersOpen = useStore((s) => s.mobileMembersOpen);
  const panelOpen = useStore((s) => s.memberListOpen);
  const fxMotion = useStore((s) => s.me?.settings.fx_motion ?? true);
  const sheetOpen = useStore((s) => !!s.sheetView);
  const theaterWindowOpen = useStore((s) => !!s.theaterView);
  const boardView = useStore((s) => s.boardView);

  const viewable = useStore((s) => (channel ? canView(s, channel) : false));
  const needsFallback = serverId !== null && !!server && !community && (!channel || channel.server_id !== server.id || !isServerView(channel.type) || !viewable);
  // Where to go when the URL's channel won't do (a number, so this only
  // re-renders when the answer changes, not on every message).
  const fallback = useStore((s) => (needsFallback && server ? fallbackChannel(s, server.id) : null));
  const mentionTotal = useStore((s) => {
    let n = 0;
    for (const r of Object.values(s.readStates)) n += r.mention_count || 0;
    return n;
  });

  // Fetch the separately loaded screens once things are quiet, so opening one is instant.
  useEffect(() => {
    const warm = () => {
      void loadSheet();
      void loadTheaterWindow();
      void loadSettings();
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void, opts?: { timeout: number }) => number }).requestIdleCallback;
    if (idle) idle(warm, { timeout: 4000 });
    else window.setTimeout(warm, 1500);
  }, []);

  // Text effects hold still when you've asked for that (styles/effects.css).
  useEffect(() => {
    document.body.classList.toggle('fx-still', !fxMotion);
  }, [fxMotion]);

  // Fix up URLs that point nowhere: unknown server, missing channel, etc.
  useEffect(() => {
    if (invalidSection) {
      go('/channels/@me', true);
      return;
    }
    if (serverId !== null) {
      if (!server) {
        go('/channels/@me', true);
        return;
      }
      if (needsFallback && fallback && fallback !== channelId) go(`/channels/${server.id}/${fallback}`, true);
    } else if (channelId !== null && (!channel || channel.server_id !== null)) {
      go('/channels/@me', true);
    }
  }, [serverId, channelId, server, channel, invalidSection, needsFallback, fallback]);

  const activeChannel =
    !community && channel && viewable && (serverId === null ? channel.server_id === null : channel.server_id === serverId && isServerView(channel.type))
      ? channel
      : undefined;
  const isVoice = activeChannel?.type === ChannelType.VOICE;

  useEffect(() => {
    // Voice spaces have no messages, so they never count as the "open" text channel.
    const open = activeChannel && !isVoice ? activeChannel.id : null;
    setState({ activeChannelId: open, mobileNavOpen: false, mobileMembersOpen: false });
    channelOpened(open);
    if (activeChannel?.server_id && !isVoice) rememberChannel(activeChannel.server_id, activeChannel.id);
  }, [activeChannel?.id, activeChannel?.server_id, isVoice]);

  // A search belongs to the place it was made; leaving drops it.
  useEffect(() => {
    const panel = getState().rightPanel;
    if (panel.kind === 'search' && panel.serverId !== serverId) setState({ rightPanel: { kind: 'members' } });
  }, [serverId]);

  // Tab title with unread mention count.
  useEffect(() => {
    const s = getState();
    let title = 'Tavern';
    if (activeChannel) {
      const name = channelTitle(s, activeChannel);
      title = activeChannel.server_id ? `${name} | ${server?.name ?? 'Tavern'}` : `${name} | Tavern`;
    } else if (server) title = community ? `Community | ${server.name}` : server.name;
    document.title = mentionTotal ? `(${mentionTotal}) ${title}` : title;
  }, [activeChannel, server, mentionTotal, community]);

  const showPanel = !!server || activeChannel?.type === ChannelType.GROUP_DM;
  let view;
  if (server && community) view = <CommunityPage server={server} />;
  else if (activeChannel && isVoice) view = <CallView key={activeChannel.id} channel={activeChannel} />;
  else if (activeChannel) view = <ChatView key={activeChannel.id} channel={activeChannel} />;
  else if (server) view = <NoChannels name={server.name} />;
  else view = <PeoplePage />;

  return (
    <div className={`app ${navOpen ? 'nav-open' : ''} ${membersOpen ? 'members-open' : ''}`}>
      <div className="app-nav">
        <ServerRail activeServerId={serverId} />
        <nav className="sidebar" aria-label={server ? `${server.name} channels` : 'Direct messages'}>
          {server ? (
            <ChannelSidebar server={server} activeChannelId={activeChannel?.id ?? null} communityActive={community} />
          ) : (
            <HomeSidebar activeChannelId={activeChannel?.id ?? null} />
          )}
          <UserPanel />
        </nav>
      </div>
      <main className="main">{view}</main>
      {showPanel && <RightPanel channel={activeChannel} serverId={server?.id ?? null} open={panelOpen} />}
      <div className="mobile-scrim" onClick={() => setState({ mobileNavOpen: false, mobileMembersOpen: false })} />
      {sheetOpen && (
        <Suspense fallback={null}>
          <SheetLayer />
        </Suspense>
      )}
      <JukeboxWindowHost />
      {theaterWindowOpen && (
        <Suspense fallback={null}>
          <TheaterWindowHost />
        </Suspense>
      )}
      <TheaterScreenHost />
      {boardView && (
        <BoardRoom
          serverId={boardView.serverId}
          channel={activeChannel && activeChannel.server_id === boardView.serverId && activeChannel.type !== ChannelType.VOICE ? activeChannel : undefined}
        />
      )}
      <ProfilePopoutHost />
      {settings && (
        <Suspense fallback={null}>
          <SettingsLayer target={settings} />
        </Suspense>
      )}
    </div>
  );
}
