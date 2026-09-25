import { memo, useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { characterAvatar, serverIcon, userAvatar } from '../lib/avatars';
import { acronym, calmColor } from '../lib/format';
import { currentTrack } from '../lib/jukebox';
import { joinVoice } from '../lib/voice';
import { go, openJukebox, openSheet } from '../store/actions';
import { charactersOf, displayName, isDm, narratorName, roleColor, userIsDm, voiceMembers } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Character, Server, User } from '../store/types';
import { ChannelType } from '../store/types';
import ChannelIcon from './ChannelIcon';
import { PanelToggle } from './ChatView';
import { Icon, mdiCompassRose, mdiDramaMasks, mdiMenu, mdiMusicNote, mdiShieldCrownOutline } from './icons';
import { tip } from './layers';
import { openCharacterProfile, openUserProfile } from './Profiles';
import { Avatar, Button } from './ui';

function CharacterRow({ character, serverId, canOpen }: { character: Character; serverId: number; canOpen: boolean }) {
  const summary = character.summary;
  const line = summary ? [summary.level ? `Level ${summary.level}${summary.classes ? ` ${summary.classes}` : ''}` : summary.classes, summary.species].filter(Boolean).join(' · ') : '';
  return (
    <button
      className="cast-character"
      onClick={(e) => (canOpen ? openSheet(character.id, serverId) : openCharacterProfile(e.currentTarget.getBoundingClientRect(), character.id, serverId))}
      {...tip(canOpen ? 'Open character sheet' : 'This sheet is private')}
    >
      <img className="cast-character-avatar" src={characterAvatar(character)} alt="" />
      <span className="cast-character-text">
        <span className="cast-character-name" style={character.color ? { color: calmColor(character.color) } : undefined}>
          {character.name}
        </span>
        {line && <span className="cast-character-line">{line}</span>}
      </span>
      {summary && summary.hp.max > 0 && (
        <span className="cast-character-stats">
          <span {...tip('Hit Points')}>
            HP {summary.hp.current}/{summary.hp.max}
          </span>
          <span {...tip('Armor Class')}>AC {summary.ac}</span>
        </span>
      )}
    </button>
  );
}

const CastCard = memo(function CastCard({ user, serverId, dm }: { user: User; serverId: number; dm: boolean }) {
  const characters = useStore(useShallow((s) => charactersOf(s, user.id)));
  const color = useStore((s) => roleColor(s, serverId, user.id));
  const me = useStore((s) => s.me!);
  const iAmDm = useStore((s) => isDm(s, serverId));
  return (
    <article className={`cast-card ${dm ? 'dm' : ''}`}>
      <header className="cast-card-header" onClick={(e) => openUserProfile(e.currentTarget.getBoundingClientRect(), user.id, serverId, 'bottom')}>
        <Avatar src={userAvatar(user)} size={40} status={user.status} />
        <div className="cast-card-who">
          <div className="cast-card-name" style={{ color }}>
            {displayName(user)}
            {dm && (
              <span className="member-dm-tag" {...tip('Dungeon Master')}>
                DM
              </span>
            )}
          </div>
          <div className="cast-card-status">{user.custom_status || (user.status === 'offline' ? 'Offline' : user.username)}</div>
        </div>
      </header>
      {characters.length > 0 ? (
        <div className="cast-characters">
          {characters.map((c) => (
            <CharacterRow key={c.id} character={c} serverId={serverId} canOpen={!!c.summary || c.owner_id === me.id || iAmDm} />
          ))}
        </div>
      ) : (
        <p className="cast-card-empty">{user.id === me.id ? 'You have no characters yet. Make one in User Settings → Characters.' : 'No characters yet.'}</p>
      )}
    </article>
  );
});

function NowPlaying({ serverId }: { serverId: number }) {
  const st = useStore((s) => s.jukebox[serverId]);
  const track = currentTrack(st);
  return (
    <section className="community-card">
      <h3 className="community-card-title">
        <Icon path={mdiMusicNote} size={16} /> Now Playing
      </h3>
      {track ? (
        <div className="community-track">
          <div className="jb-cover" style={{ width: 48, height: 48 }}>
            {track.cover_url ? <img src={track.cover_url} alt="" /> : <Icon path={mdiMusicNote} size={20} />}
          </div>
          <div className="community-track-text">
            <div className="community-track-title">{track.title}</div>
            <div className="community-track-sub">
              {track.artist ?? 'Unknown artist'}
              {st && st.listeners.length > 0 && ` · ${st.listeners.length} listening`}
              {st && !st.playing && ' · Paused'}
            </div>
          </div>
        </div>
      ) : (
        <p className="community-muted">The jukebox is quiet.</p>
      )}
      <Button size="small" look="secondary" onClick={() => openJukebox(serverId, 'queue')}>
        Open Jukebox
      </Button>
    </section>
  );
}

function Session({ server }: { server: Server }) {
  const dms = useStore(
    useShallow((s) =>
      Object.keys(s.members[server.id] ?? {})
        .map(Number)
        .filter((id) => userIsDm(s, server.id, id))
        .map((id) => s.users[id])
        .filter(Boolean),
    ),
  );
  const narrator = useStore((s) => narratorName(s, server.id));
  return (
    <section className={`community-card session ${server.roleplay_mode ? 'on' : ''}`}>
      <h3 className="community-card-title">
        <Icon path={mdiDramaMasks} size={16} /> {server.roleplay_mode ? 'In Session' : 'Between Sessions'}
      </h3>
      <p className="community-muted">
        {server.roleplay_mode
          ? 'DM Lock is on: a session is running, and only Dungeon Masters control the jukebox.'
          : 'Chill time. DJs have the jukebox; a Dungeon Master can turn on DM Lock from the right-hand panel.'}
      </p>
      <div className="community-dms">
        <Icon path={mdiShieldCrownOutline} size={16} className="community-dms-icon" />
        {dms.length ? dms.map((u) => displayName(u)).join(', ') : 'No Dungeon Masters yet'}
      </div>
      <div className="community-muted small">The narrator speaks as “{narrator}”.</div>
    </section>
  );
}

function VoiceSpaces({ serverId }: { serverId: number }) {
  const spaces = useStore(
    useShallow((s) =>
      Object.values(s.channels)
        .filter((c) => c.server_id === serverId && c.type === ChannelType.VOICE)
        .sort((a, b) => a.position - b.position),
    ),
  );
  const counts = useStore(useShallow((s) => spaces.map((c) => voiceMembers(s, c.id).length)));
  if (!spaces.length) return null;
  return (
    <section className="community-card">
      <h3 className="community-card-title">Voice Spaces</h3>
      <ul className="community-voice">
        {spaces.map((c, i) => (
          <li key={c.id}>
            <button
              onClick={() => {
                if (getState().voice.channelId !== c.id) joinVoice(c.id);
                go(`/channels/${serverId}/${c.id}`);
              }}
            >
              <ChannelIcon channel={c} size={16} />
              <span className="community-voice-name">{c.name}</span>
              <span className="community-voice-count">{counts[i] ? `${counts[i]} here` : 'Empty'}</span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** The server's home page: who's here, who they play, what's going on. */
export default function CommunityPage({ server }: { server: Server }) {
  const memberIds = useStore(useShallow((s) => Object.keys(s.members[server.id] ?? {}).map(Number)));
  const users = useStore((s) => s.users);
  const inVoice = useStore((s) => Object.values(s.voiceStates).filter((v) => v.server_id === server.id && v.channel_id).length);
  const characterCount = useStore((s) => Object.values(s.characters).filter((c) => !c.deleted && s.members[server.id]?.[c.owner_id]).length);

  const cast = useMemo(() => {
    const s = getState();
    return memberIds
      .map((id) => users[id])
      .filter(Boolean)
      .map((u) => ({ user: u, dm: userIsDm(s, server.id, u.id) }))
      .sort((a, b) => Number(b.dm) - Number(a.dm) || Number(b.user.status !== 'offline') - Number(a.user.status !== 'offline') || displayName(a.user).localeCompare(displayName(b.user)));
  }, [memberIds, users, server.id]);
  const online = cast.filter((c) => c.user.status !== 'offline').length;
  const icon = serverIcon(server.icon);

  return (
    <div className="community">
      <header className="chat-header">
        <button className="mobile-nav-button" aria-label="Open navigation" onClick={() => setState({ mobileNavOpen: true })}>
          <Icon path={mdiMenu} size={24} />
        </button>
        <div className="chat-header-title">
          <Icon path={mdiCompassRose} size={22} className="chat-header-icon" />
          <h1 className="chat-header-name titled">Community</h1>
        </div>
        <div className="chat-header-toolbar">
          <PanelToggle />
        </div>
      </header>
      <div className="community-body scroller">
        <section className="community-hero">
          <div className="community-hero-icon">{icon ? <img src={icon} alt="" /> : <span>{acronym(server.name)}</span>}</div>
          <div className="community-hero-text">
            <h1 className="community-name">{server.name}</h1>
            {server.tagline && <p className="community-tagline">{server.tagline}</p>}
            <div className="community-stats">
              <span>
                <b>{cast.length}</b> {cast.length === 1 ? 'member' : 'members'}
              </span>
              <span>
                <i className="dot online" />
                <b>{online}</b> online
              </span>
              <span>
                <b>{inVoice}</b> in voice
              </span>
              <span>
                <b>{characterCount}</b> {characterCount === 1 ? 'character' : 'characters'}
              </span>
            </div>
          </div>
        </section>

        <div className="community-cards">
          <Session server={server} />
          <NowPlaying serverId={server.id} />
          <VoiceSpaces serverId={server.id} />
        </div>

        <h2 className="community-section-title">The Cast</h2>
        <div className="cast-grid">
          {cast.map(({ user, dm }) => (
            <CastCard key={user.id} user={user} serverId={server.id} dm={dm} />
          ))}
        </div>
      </div>
    </div>
  );
}
