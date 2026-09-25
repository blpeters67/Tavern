import { useMemo, useState } from 'react';
import { create } from 'zustand';
import { api, errorMessage } from '../api/http';
import { characterAvatar, serverIcon, userAvatar } from '../lib/avatars';
import { calmColor, colorHex, formatShortDate } from '../lib/format';
import { P } from '../lib/permissions';
import { BanModal, KickModal } from '../modals/MemberModals';
import { CharacterEditorModal } from '../modals/CharacterModals';
import { alignmentName } from '../lib/sheet';
import { openDM, openModal, openSheet } from '../store/actions';
import { canManageRole, charactersOf, displayName, isDm, memberRoles, myServerPerms, outranks, sortedRoles } from '../store/selectors';
import { getState, useStore } from '../store/store';
import type { User } from '../store/types';
import {
  Icon,
  mdiCardAccountDetailsOutline,
  mdiCircleMultipleOutline,
  mdiClose,
  mdiCrown,
  mdiDramaMasks,
  mdiHeartPulse,
  mdiPlus,
  mdiShieldOutline,
  TavernLogo,
} from './icons';
import { MenuItem, MenuSeparator, Popout, tip, type PopoutSide } from './layers';
import { toast } from './Toasts';
import { Avatar, Button } from './ui';

interface OpenProfile {
  kind: 'user' | 'character';
  id: number;
  serverId: number | null;
  rect: DOMRect;
  side: PopoutSide;
}

const useProfile = create<{ open: OpenProfile | null }>(() => ({ open: null }));

export function openUserProfile(rect: DOMRect, id: number, serverId: number | null, side: PopoutSide = 'right') {
  useProfile.setState({ open: { kind: 'user', id, serverId, rect, side } });
}

export function openCharacterProfile(rect: DOMRect, id: number, serverId: number | null, side: PopoutSide = 'right') {
  useProfile.setState({ open: { kind: 'character', id, serverId, rect, side } });
}

// Remember where the pointer last went down, so menus can open a profile
// "where you clicked" after the menu itself is gone.
let lastPointer = { x: window.innerWidth / 2, y: window.innerHeight / 3 };
window.addEventListener('pointerdown', (e) => (lastPointer = { x: e.clientX, y: e.clientY }), true);

export function openUserProfileAt(id: number, serverId: number | null) {
  openUserProfile(new DOMRect(lastPointer.x, lastPointer.y, 0, 0), id, serverId, 'right');
}

export function closeProfile() {
  useProfile.setState({ open: null });
}

export function ProfilePopoutHost() {
  const open = useProfile((s) => s.open);
  if (!open) return null;
  return (
    <Popout anchor={open.rect} side={open.side} onClose={closeProfile} className="profile-popout" key={`${open.kind}${open.id}`}>
      {open.kind === 'user' ? <UserCard userId={open.id} serverId={open.serverId} /> : <CharacterCard characterId={open.id} serverId={open.serverId} />}
    </Popout>
  );
}

function bannerFor(user: Pick<User, 'banner_color' | 'id'>): string {
  if (user.banner_color !== null && user.banner_color !== undefined) return colorHex(user.banner_color);
  const palette = ['#3b4f86', '#2f6b6b', '#6b4f2a', '#5b3b72', '#7a3b46', '#2f5a3e'];
  return palette[user.id % palette.length];
}

function UserCard({ userId, serverId }: { userId: number; serverId: number | null }) {
  const user = useStore((s) => s.users[userId]);
  const me = useStore((s) => s.me)!;
  const server = useStore((s) => (serverId ? s.servers[serverId] : undefined));
  const member = useStore((s) => (serverId ? s.members[serverId]?.[userId] : undefined));
  const rolesMap = useStore((s) => s.roles);
  const characters = useStore((s) => s.characters);
  const [picking, setPicking] = useState(false);

  const roles = useMemo(() => (serverId ? memberRoles(getState(), serverId, userId) : []), [serverId, userId, member, rolesMap]); // eslint-disable-line react-hooks/exhaustive-deps
  const chars = useMemo(() => charactersOf(getState(), userId), [userId, characters]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!user) return <div className="profile-card">Unknown user</div>;

  const s = getState();
  const assignable = serverId ? sortedRoles(s, serverId).filter((r) => !r.is_default && canManageRole(s, serverId, r)) : [];
  const canAssign = assignable.length > 0;
  const toggleRole = async (roleId: number, add: boolean) => {
    try {
      const path = `/api/servers/${serverId}/members/${userId}/roles/${roleId}`;
      if (add) await api.put(path);
      else await api.del(path);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <div className="profile-card">
      <div className="profile-banner" style={{ background: bannerFor(user) }} />
      <div className="profile-avatar-wrap">
        <Avatar src={userAvatar(user)} size={80} status={user.status} />
      </div>
      {server?.owner_id === userId && (
        <div className="profile-badges">
          <span className="profile-badge" {...tip('Server Owner')}>
            <Icon path={mdiCrown} size={16} />
          </span>
        </div>
      )}
      <div className="profile-body">
        <div className="profile-names">
          <div className="profile-display">{displayName(user)}</div>
          <div className="profile-username">{user.username}</div>
          {user.custom_status && <div className="profile-custom-status">{user.custom_status}</div>}
        </div>
        {user.about && (
          <section className="profile-section">
            <h4>About Me</h4>
            <p className="profile-about">{user.about}</p>
          </section>
        )}
        <section className="profile-section">
          <h4>Member Since</h4>
          <div className="profile-since">
            <span className="since-item" {...tip('Tavern')}>
              <TavernLogo size={16} /> {formatShortDate(user.created_at)}
            </span>
            {server && member && (
              <>
                <span className="since-dot" />
                <span className="since-item" {...tip(server.name)}>
                  {server.icon ? <img src={serverIcon(server.icon)!} alt="" className="since-icon" /> : <span className="since-icon acronym" />}
                  {formatShortDate(member.joined_at)}
                </span>
              </>
            )}
          </div>
        </section>
        {serverId && member && (
          <section className="profile-section">
            <h4>{roles.length || canAssign ? 'Roles' : 'No Roles'}</h4>
            <div className="role-pills">
              {roles.map((r) => (
                <span key={r.id} className="role-pill">
                  <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : '#80848e' }}>
                    {canManageRole(s, serverId, r) && (
                      <button className="role-remove" aria-label={`Remove ${r.name}`} onClick={() => toggleRole(r.id, false)}>
                        <Icon path={mdiClose} size={10} />
                      </button>
                    )}
                  </span>
                  {r.name}
                </span>
              ))}
              {canAssign && (
                <button className="role-pill role-add" aria-label="Add Role" {...tip('Add Role')} onClick={() => setPicking((v) => !v)}>
                  <Icon path={mdiPlus} size={14} />
                </button>
              )}
            </div>
            {picking && (
              <div className="role-picker scroller-thin">
                {assignable.map((r) => {
                  const has = member.role_ids.includes(r.id);
                  return (
                    <button key={r.id} className={`role-picker-item ${has ? 'on' : ''}`} onClick={() => toggleRole(r.id, !has)}>
                      <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : '#80848e' }} />
                      <span className="role-picker-name">{r.name}</span>
                      <span className={`checkbox ${has ? 'checked' : ''}`} />
                    </button>
                  );
                })}
              </div>
            )}
          </section>
        )}
        {!me.settings.immersive && chars.length > 0 && (
          <section className="profile-section">
            <h4>Characters</h4>
            <div className="profile-characters">
              {chars.map((c) => (
                <button
                  key={c.id}
                  className="profile-character"
                  style={c.color ? ({ '--char-color': calmColor(c.color) } as React.CSSProperties) : undefined}
                  onClick={(e) => openCharacterProfile((e.currentTarget as HTMLElement).getBoundingClientRect(), c.id, serverId)}
                >
                  <img src={characterAvatar(c)} alt="" />
                  <span>{c.name}</span>
                </button>
              ))}
            </div>
          </section>
        )}
        {userId !== me.id && (
          <Button
            look="secondary"
            grow
            className="profile-message"
            onClick={() => {
              closeProfile();
              void openDM([userId]);
            }}
          >
            Send Message
          </Button>
        )}
      </div>
    </div>
  );
}

function CharacterCard({ characterId, serverId }: { characterId: number; serverId: number | null }) {
  const ch = useStore((s) => s.characters[characterId]);
  const owner = useStore((s) => (ch ? s.users[ch.owner_id] : undefined));
  const me = useStore((s) => s.me)!;
  const dm = useStore((s) => (serverId ? isDm(s, serverId) : false));
  if (!ch) return <div className="profile-card">Unknown character</div>;
  const mine = ch.owner_id === me.id;
  const hidePlayer = me.settings.immersive && !mine;
  const sum = ch.summary;
  const canSeeSheet = mine || dm || ch.sheet_visibility === 'public';
  const color = ch.color ? calmColor(ch.color) : '#8b93a7';
  return (
    <div className="profile-card character-card" style={{ '--char-color': color } as React.CSSProperties}>
      <div className="profile-banner character-banner" />
      <div className="profile-avatar-wrap">
        <img className="character-card-avatar" src={characterAvatar(ch)} alt="" />
      </div>
      <div className="profile-body">
        <div className="profile-names">
          <div className="profile-display character-name-display">{ch.name}</div>
          <div className="profile-username character-kind">
            <Icon path={mdiDramaMasks} size={14} /> {ch.deleted ? 'Retired character' : sum?.classes ? `Level ${sum.level} ${sum.classes}` : 'Character'}
          </div>
        </div>
        {sum && (sum.species || sum.alignment || sum.hp.max > 0) && (
          <section className="profile-section character-stats">
            {sum.species && <span className="char-stat">{sum.species}</span>}
            {sum.alignment && <span className="char-stat">{alignmentName(sum.alignment)}</span>}
            <span className="char-stat">
              <Icon path={mdiHeartPulse} size={14} /> {sum.hp.current}/{sum.hp.max}
              {sum.hp.temp ? ` +${sum.hp.temp}` : ''}
            </span>
            <span className="char-stat">
              <Icon path={mdiShieldOutline} size={14} /> AC {sum.ac}
            </span>
            {sum.gold > 0 && (
              <span className="char-stat gold">
                <Icon path={mdiCircleMultipleOutline} size={14} /> {sum.gold.toLocaleString()} gp
              </span>
            )}
          </section>
        )}
        {canSeeSheet && !ch.deleted && (
          <Button
            look="gold"
            grow
            className="profile-message"
            onClick={() => {
              closeProfile();
              openSheet(ch.id, serverId);
            }}
          >
            <Icon path={mdiCardAccountDetailsOutline} size={18} /> Character Sheet
          </Button>
        )}
        {!hidePlayer && owner && (
          <section className="profile-section">
            <h4>Played By</h4>
            <button
              className="played-by"
              onClick={(e) => openUserProfile((e.currentTarget as HTMLElement).getBoundingClientRect(), owner.id, serverId)}
            >
              <Avatar src={userAvatar(owner)} size={24} />
              <span className="played-by-name">{displayName(owner)}</span>
              <span className="played-by-username">{owner.username}</span>
            </button>
          </section>
        )}
        {mine && !ch.deleted && (
          <Button
            look="secondary"
            grow
            className="profile-message secondary-action"
            onClick={() => {
              closeProfile();
              openModal((close) => <CharacterEditorModal character={ch} onClose={close} />);
            }}
          >
            Edit Name & Picture
          </Button>
        )}
      </div>
    </div>
  );
}

/** Right-click menu for a person (member list, names in chat). */
export function userMenu(userId: number, serverId: number | null, onMention?: () => void) {
  const s = getState();
  const me = s.me!;
  const perms = serverId ? myServerPerms(s, serverId) : 0;
  const isMember = serverId ? !!s.members[serverId]?.[userId] : false;
  const canKick = serverId && isMember && userId !== me.id && perms & P.KICK_MEMBERS && outranks(s, serverId, userId);
  const canBan = serverId && userId !== me.id && perms & P.BAN_MEMBERS && outranks(s, serverId, userId);
  const user = s.users[userId];
  return (
    <>
      {onMention && <MenuItem label="Mention" onClick={onMention} />}
      {userId !== me.id && <MenuItem label="Message" onClick={() => void openDM([userId])} />}
      {(canKick || canBan) && <MenuSeparator />}
      {canKick && <MenuItem label={`Kick ${displayName(user)}`} danger onClick={() => openModal((close) => <KickModal serverId={serverId!} user={user} onClose={close} />)} />}
      {canBan && <MenuItem label={`Ban ${displayName(user)}`} danger onClick={() => openModal((close) => <BanModal serverId={serverId!} user={user} onClose={close} />)} />}
    </>
  );
}
