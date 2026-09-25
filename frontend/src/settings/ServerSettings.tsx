import { useEffect, useMemo, useRef, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/http';
import { Icon, mdiClose, mdiDotsVertical, mdiImage, mdiMagnify } from '../components/icons';
import { MenuItem, Modal, tip } from '../components/layers';
import { toast } from '../components/Toasts';
import { Avatar, Button, Divider, Field, Select, SwitchRow, TextInput } from '../components/ui';
import { emojiUrl, serverIcon, userAvatar } from '../lib/avatars';
import { acronym, colorHex, formatShortDate } from '../lib/format';
import { P } from '../lib/permissions';
import { BanModal, KickModal } from '../modals/MemberModals';
import { ConfirmModal } from '../modals/ServerModals';
import { closeSettings, go, openContextMenu, openModal } from '../store/actions';
import { displayName, isDm, memberRoles, myServerPerms, outranks } from '../store/selectors';
import { dispatch, getState, useStore } from '../store/store';
import type { Emoji, InviteInfo, Server, User } from '../store/types';
import { ChannelType } from '../store/types';
import RoleSettings from './RoleSettings';
import { SaveBar, SettingsShell, type NavEntry } from './SettingsLayer';
import { cropImage } from '../components/ImageCropper';

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewSection({ server }: { server: Server }) {
  const channels = useStore((s) => s.channels);
  const [name, setName] = useState(server.name);
  const [tagline, setTagline] = useState(server.tagline ?? '');
  const [narrator, setNarrator] = useState(server.narrator_name ?? '');
  const [systemId, setSystemId] = useState<number | null>(server.system_channel_id);
  const dm = useStore((s) => isDm(s, server.id));
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const textChannels = Object.values(channels)
    .filter((c) => c.server_id === server.id && c.type === ChannelType.TEXT)
    .sort((a, b) => a.position - b.position);

  const dirty = name !== server.name || systemId !== server.system_channel_id || tagline !== (server.tagline ?? '') || narrator !== (server.narrator_name ?? '');
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const updated = await api.patch<Server>(`/api/servers/${server.id}`, { name, system_channel_id: systemId, tagline, narrator_name: narrator });
      dispatch('SERVER_UPDATE', updated);
    } catch (err) {
      setError(err instanceof ApiError && err.errors.name ? err.errors.name : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };
  const uploadIcon = async (file: File) => {
    const form = new FormData();
    form.append('file', file);
    try {
      dispatch('SERVER_UPDATE', await api.put<Server>(`/api/servers/${server.id}/icon`, form));
    } catch (err) {
      toast(errorMessage(err));
    }
  };
  const removeIcon = async () => {
    try {
      dispatch('SERVER_UPDATE', await api.del<Server>(`/api/servers/${server.id}/icon`));
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const icon = serverIcon(server.icon);
  return (
    <>
      <h2 className="settings-title">Server Overview</h2>
      <div className="overview-row">
        <div className="overview-icon-col">
          <button className="server-icon-upload" onClick={() => fileRef.current?.click()} aria-label="Change server icon">
            {icon ? <img src={icon} alt="" /> : <span>{acronym(server.name)}</span>}
            <span className="server-icon-overlay">
              <Icon path={mdiImage} size={20} />
              Change Icon
            </span>
          </button>
          {icon && (
            <button className="link-button subtle" onClick={removeIcon}>
              Remove
            </button>
          )}
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/gif,image/webp"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (!f) return;
              void cropImage(f, { shape: 'circle', title: 'Edit Server Icon' }).then((cropped) => {
                if (cropped) void uploadIcon(cropped);
              });
            }}
          />
        </div>
        <div className="overview-fields">
          <p className="settings-desc">We recommend an image of at least 512x512 for the server.</p>
          <Field label="Server Name" error={error}>
            <TextInput value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
          </Field>
          <Field label="Tagline" hint="A short line under the server name in the sidebar.">
            <TextInput value={tagline} onChange={(e) => setTagline(e.target.value)} maxLength={100} placeholder="Where the dice fall and the ale flows" />
          </Field>
        </div>
      </div>
      <Divider />
      <h3 className="settings-subtitle">Roleplay</h3>
      <Field label="Narrator Name" hint="What the Dungeon Master's narrator voice is called in chat.">
        <TextInput value={narrator} onChange={(e) => setNarrator(e.target.value)} maxLength={32} placeholder="The GM" />
      </Field>
      <SwitchRow
        title="DM Lock"
        description={
          dm
            ? 'While on, only Dungeon Masters can change the music, and the member list groups everyone into Dungeon Masters and players in session. You can also flip it at the top of the right-hand panel.'
            : 'Only Dungeon Masters can turn this on or off.'
        }
        checked={server.roleplay_mode}
        disabled={!dm}
        onChange={async (v) => {
          try {
            await api.put(`/api/servers/${server.id}/roleplay`, { enabled: v });
          } catch (err) {
            toast(errorMessage(err));
          }
        }}
      />
      <Divider />
      <Field label="System Messages Channel" hint="This is the channel we send system event messages to, like people joining.">
        <Select
          value={systemId ?? 0}
          options={[{ value: 0, label: 'No System Messages' }, ...textChannels.map((c) => ({ value: c.id, label: c.name ?? '' }))]}
          onChange={(v) => setSystemId(v || null)}
        />
      </Field>
      {dirty && (
        <SaveBar
          onReset={() => {
            setName(server.name);
            setTagline(server.tagline ?? '');
            setNarrator(server.narrator_name ?? '');
            setSystemId(server.system_channel_id);
          }}
          onSave={save}
          saving={saving}
        />
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Emoji
// ---------------------------------------------------------------------------

function EmojiRow({ e, serverId }: { e: Emoji; serverId: number }) {
  const creator = useStore((s) => (e.creator_id ? s.users[e.creator_id] : undefined));
  const [name, setName] = useState(e.name);
  useEffect(() => setName(e.name), [e.name]);
  const rename = async () => {
    if (name === e.name) return;
    try {
      await api.patch(`/api/servers/${serverId}/emojis/${e.id}`, { name });
    } catch (err) {
      toast(err instanceof ApiError && err.errors.name ? err.errors.name : errorMessage(err));
      setName(e.name);
    }
  };
  return (
    <div className="emoji-row">
      <img src={emojiUrl(e.id)} alt="" className="emoji-row-image" />
      <div className="emoji-row-name">
        <input value={name} onChange={(ev) => setName(ev.target.value)} onBlur={rename} onKeyDown={(ev) => ev.key === 'Enter' && (ev.target as HTMLInputElement).blur()} aria-label="Emoji name" />
      </div>
      <div className="emoji-row-creator">
        {creator && (
          <>
            <Avatar src={userAvatar(creator)} size={24} />
            {displayName(creator)}
          </>
        )}
      </div>
      <button
        className="emoji-row-delete"
        aria-label="Delete emoji"
        {...tip('Delete')}
        onClick={() =>
          openModal((close) => (
            <ConfirmModal
              title="Delete Emoji"
              body={
                <>
                  Delete <strong>:{e.name}:</strong>? Messages that used it will show its name instead.
                </>
              }
              confirm="Delete"
              onClose={close}
              onConfirm={async () => {
                await api.del(`/api/servers/${serverId}/emojis/${e.id}`);
              }}
            />
          ))
        }
      >
        <Icon path={mdiClose} size={16} />
      </button>
    </div>
  );
}

function EmojiSection({ server }: { server: Server }) {
  const emojis = useStore((s) => s.emojis);
  const list = useMemo(() => Object.values(emojis).filter((e) => e.server_id === server.id).sort((a, b) => a.name.localeCompare(b.name)), [emojis, server.id]);
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);

  const upload = async (files: FileList) => {
    setUploading(true);
    for (const f of Array.from(files)) {
      const form = new FormData();
      const base = f.name.replace(/\.[^.]+$/, '').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 32);
      form.append('name', base.length >= 2 ? base : `emoji_${base}`);
      form.append('file', f);
      try {
        await api.post(`/api/servers/${server.id}/emojis`, form);
      } catch (err) {
        toast(`${f.name}: ${err instanceof ApiError && err.errors.name ? err.errors.name : errorMessage(err)}`);
      }
    }
    setUploading(false);
  };

  return (
    <>
      <h2 className="settings-title">Emoji</h2>
      <p className="settings-desc">
        Add up to 200 custom emoji that anyone in this server can use. Animated GIFs work too. Names need at least 2 characters: letters, numbers and underscores.
      </p>
      <div className="upload-requirements">
        <div className="field-label">Upload Requirements</div>
        <ul>
          <li>File type: JPEG, PNG, GIF, WEBP</li>
          <li>Max file size: 2 MB</li>
          <li>Recommended size: 128×128</li>
          <li>Naming: the file name becomes the emoji name. You can rename it below.</li>
        </ul>
      </div>
      <Button onClick={() => fileRef.current?.click()} loading={uploading}>
        Upload Emoji
      </Button>
      <input
        ref={fileRef}
        type="file"
        multiple
        accept="image/png,image/jpeg,image/gif,image/webp"
        hidden
        onChange={(e) => {
          if (e.target.files?.length) void upload(e.target.files);
          e.target.value = '';
        }}
      />
      <Divider />
      <div className="emoji-table">
        <div className="emoji-table-head">
          <span>Image</span>
          <span>Name</span>
          <span>Uploaded by</span>
          <span />
        </div>
        {list.map((e) => (
          <EmojiRow key={e.id} e={e} serverId={server.id} />
        ))}
        {!list.length && <div className="empty-state small">No emoji yet. Upload a few favorites.</div>}
        {list.length > 0 && <div className="emoji-count">{list.length} of 200 slots used</div>}
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------
// Members
// ---------------------------------------------------------------------------

function MembersSection({ server }: { server: Server }) {
  const members = useStore((s) => s.members[server.id]);
  const users = useStore((s) => s.users);
  useStore((s) => s.roles); // re-render when roles change
  const me = useStore((s) => s.me)!;
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(members ?? {})
      .map((m) => ({ m, u: users[m.user_id] }))
      .filter(({ u }) => u && (!q || u.username.includes(q) || displayName(u).toLowerCase().includes(q)))
      .sort((a, b) => displayName(a.u).localeCompare(displayName(b.u)));
  }, [members, users, query]);

  const s = getState();
  const perms = myServerPerms(s, server.id);

  const menu = (u: User) => (
    <>
      {perms & P.KICK_MEMBERS && outranks(s, server.id, u.id) && u.id !== me.id ? (
        <MenuItem label={`Kick ${displayName(u)}`} danger onClick={() => openModal((close) => <KickModal serverId={server.id} user={u} onClose={close} />)} />
      ) : null}
      {perms & P.BAN_MEMBERS && outranks(s, server.id, u.id) && u.id !== me.id ? (
        <MenuItem label={`Ban ${displayName(u)}`} danger onClick={() => openModal((close) => <BanModal serverId={server.id} user={u} onClose={close} />)} />
      ) : null}
      {server.owner_id === me.id && u.id !== me.id && (
        <MenuItem
          label="Transfer Ownership"
          danger
          onClick={() =>
            openModal((close) => (
              <ConfirmModal
                title="Transfer Ownership"
                body={
                  <>
                    Make <strong>{displayName(u)}</strong> the owner of <strong>{server.name}</strong>? You'll lose owner powers, and only they can give them back.
                  </>
                }
                confirm="Transfer Ownership"
                onClose={close}
                onConfirm={async () => {
                  await api.post(`/api/servers/${server.id}/transfer`, { user_id: u.id });
                }}
              />
            ))
          }
        />
      )}
    </>
  );

  return (
    <>
      <h2 className="settings-title">Server Members</h2>
      <div className="members-toolbar">
        <span className="members-count">{rows.length} Members</span>
        <div className="search-input">
          <input placeholder="Search members" value={query} onChange={(e) => setQuery(e.target.value)} />
          <Icon path={mdiMagnify} size={18} />
        </div>
      </div>
      <div className="members-table">
        {rows.map(({ m, u }) => {
          const mroles = memberRoles(s, server.id, u.id);
          const hasMenu = u.id !== me.id && (perms & (P.KICK_MEMBERS | P.BAN_MEMBERS) || server.owner_id === me.id);
          return (
            <div key={u.id} className="members-row">
              <Avatar src={userAvatar(u)} size={40} />
              <div className="members-row-names">
                <div className="members-row-name">
                  {displayName(u)}
                  {server.owner_id === u.id && <span className="owner-badge">Owner</span>}
                </div>
                <div className="members-row-username">{u.username}</div>
              </div>
              <div className="members-row-joined">
                <div className="field-label">Joined</div>
                {formatShortDate(m.joined_at)}
              </div>
              <div className="members-row-roles">
                {mroles.slice(0, 3).map((r) => (
                  <span key={r.id} className="role-pill small">
                    <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : '#80848e' }} />
                    {r.name}
                  </span>
                ))}
                {mroles.length > 3 && <span className="role-pill small">+{mroles.length - 3}</span>}
              </div>
              {hasMenu ? (
                <button
                  className="icon-button"
                  aria-label="Member options"
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    openContextMenu({ clientX: r.left, clientY: r.bottom }, () => menu(u));
                  }}
                >
                  <Icon path={mdiDotsVertical} size={20} />
                </button>
              ) : (
                <span className="icon-button placeholder" />
              )}
            </div>
          );
        })}
      </div>
      <p className="settings-note">Tip: give or take roles by clicking someone's name in the member list, or in Roles → Manage Members.</p>
    </>
  );
}

// ---------------------------------------------------------------------------
// Invites & bans
// ---------------------------------------------------------------------------

function InvitesSection({ server }: { server: Server }) {
  const [invites, setInvites] = useState<InviteInfo[] | null>(null);
  const load = () =>
    api
      .get<InviteInfo[]>(`/api/servers/${server.id}/invites`)
      .then(setInvites)
      .catch((err) => toast(errorMessage(err)));
  useEffect(() => {
    void load();
  }, [server.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const revoke = async (code: string) => {
    try {
      await api.del(`/api/invites/${code}`);
      setInvites((cur) => cur?.filter((i) => i.code !== code) ?? null);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <>
      <h2 className="settings-title">Invites</h2>
      <p className="settings-desc">Every active invite link for this server. Revoke one and it stops working right away.</p>
      <div className="invite-table">
        <div className="invite-table-head">
          <span>Inviter</span>
          <span>Invite Code</span>
          <span>Uses</span>
          <span>Expires</span>
          <span />
        </div>
        {invites?.map((i) => (
          <div key={i.code} className="invite-table-row">
            <span className="invite-inviter">
              {i.inviter && <Avatar src={userAvatar(i.inviter)} size={20} />}
              {i.inviter ? displayName(i.inviter) : 'Unknown'}
            </span>
            <code>{i.code}</code>
            <span>
              {i.uses ?? 0}
              {i.max_uses ? ` / ${i.max_uses}` : ''}
            </span>
            <span>{i.expires_at ? formatShortDate(i.expires_at) : 'Never'}</span>
            <button className="invite-revoke" aria-label="Revoke invite" {...tip('Revoke Invite')} onClick={() => revoke(i.code)}>
              <Icon path={mdiClose} size={16} />
            </button>
          </div>
        ))}
        {invites?.length === 0 && <div className="empty-state small">No active invites. Make one from the server menu.</div>}
      </div>
    </>
  );
}

interface BanEntry {
  user: User;
  reason: string | null;
  created_at: string;
}

function BansSection({ server }: { server: Server }) {
  const [bans, setBans] = useState<BanEntry[] | null>(null);
  useEffect(() => {
    api
      .get<BanEntry[]>(`/api/servers/${server.id}/bans`)
      .then(setBans)
      .catch((err) => toast(errorMessage(err)));
  }, [server.id]);

  const unban = (b: BanEntry) =>
    openModal((close) => (
      <Modal
        title={`'${displayName(b.user)}'`}
        onClose={close}
        footer={
          <>
            <Button look="link" onClick={close}>
              Done
            </Button>
            <Button
              look="danger"
              onClick={async () => {
                try {
                  await api.del(`/api/servers/${server.id}/bans/${b.user.id}`);
                  setBans((cur) => cur?.filter((x) => x.user.id !== b.user.id) ?? null);
                  close();
                } catch (err) {
                  toast(errorMessage(err));
                }
              }}
            >
              Revoke Ban
            </Button>
          </>
        }
      >
        <div className="field-label">Ban Reason</div>
        <p className="modal-text">{b.reason || 'No reason given.'}</p>
      </Modal>
    ));

  return (
    <>
      <h2 className="settings-title">Server Ban List</h2>
      <p className="settings-desc">Banned people can't rejoin with any invite. Click someone to see why, or to lift their ban.</p>
      <div className="ban-list">
        {bans?.map((b) => (
          <button key={b.user.id} className="ban-row" onClick={() => unban(b)}>
            <Avatar src={userAvatar(b.user)} size={32} />
            <span className="ban-name">{displayName(b.user)}</span>
            <span className="ban-username">{b.user.username}</span>
          </button>
        ))}
        {bans?.length === 0 && <div className="empty-state small">No bans. Everyone's behaving.</div>}
      </div>
    </>
  );
}

function DeleteServerModal({ server, onClose }: { server: Server; onClose: () => void }) {
  const [typed, setTyped] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title={`Delete '${server.name}'`}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button
            look="danger"
            loading={loading}
            onClick={async () => {
              if (typed.trim() !== server.name) {
                setError("You didn't enter the server name correctly");
                return;
              }
              setLoading(true);
              try {
                await api.del(`/api/servers/${server.id}`);
                onClose();
                closeSettings();
                go('/channels/@me');
              } catch (err) {
                toast(errorMessage(err));
                setLoading(false);
              }
            }}
          >
            Delete Server
          </Button>
        </>
      }
    >
      <div className="warning-box">
        Are you sure you want to delete <strong>{server.name}</strong>? This action cannot be undone. Every channel, message and emoji goes with it.
      </div>
      <Field label="Enter server name" error={error}>
        <TextInput value={typed} onChange={(e) => setTyped(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

export default function ServerSettings({ serverId, section }: { serverId: number; section?: string }) {
  const server = useStore((s) => s.servers[serverId]);
  const roles = useStore((s) => s.roles);
  const members = useStore((s) => s.members);
  const perms = useMemo(() => myServerPerms(getState(), serverId), [serverId, roles, members]); // eslint-disable-line react-hooks/exhaustive-deps
  const isOwner = useStore((s) => s.servers[serverId]?.owner_id === s.me?.id);

  const available = useMemo(() => {
    const out: string[] = [];
    if (perms & P.MANAGE_SERVER) out.push('overview');
    if (perms & P.MANAGE_ROLES) out.push('roles');
    if (perms & P.MANAGE_EMOJIS) out.push('emoji');
    if (perms & (P.KICK_MEMBERS | P.BAN_MEMBERS | P.MANAGE_ROLES) || isOwner) out.push('members');
    if (perms & P.MANAGE_SERVER) out.push('invites');
    if (perms & P.BAN_MEMBERS) out.push('bans');
    return out;
  }, [perms, isOwner]);

  const [active, setActive] = useState(section && available.includes(section) ? section : (available[0] ?? 'members'));
  useEffect(() => {
    if (!server) closeSettings();
  }, [server]);
  if (!server) return null;

  const labels: Record<string, string> = { overview: 'Overview', roles: 'Roles', emoji: 'Emoji', members: 'Members', invites: 'Invites', bans: 'Bans' };
  const nav: NavEntry[] = [{ kind: 'header', label: server.name }];
  for (const id of ['overview', 'roles', 'emoji']) if (available.includes(id)) nav.push({ kind: 'item', id, label: labels[id] });
  const mgmt = ['members', 'invites', 'bans'].filter((id) => available.includes(id));
  if (mgmt.length) {
    nav.push({ kind: 'separator' }, { kind: 'header', label: 'User Management' });
    for (const id of mgmt) nav.push({ kind: 'item', id, label: labels[id] });
  }
  if (isOwner) {
    nav.push({ kind: 'separator' });
    nav.push({ kind: 'item', id: 'delete', label: 'Delete Server', danger: true, onClick: () => openModal((close) => <DeleteServerModal server={server} onClose={close} />) });
  }

  return (
    <SettingsShell nav={nav} active={active} onSelect={setActive}>
      {active === 'overview' && <OverviewSection server={server} />}
      {active === 'roles' && <RoleSettings server={server} />}
      {active === 'emoji' && <EmojiSection server={server} />}
      {active === 'members' && <MembersSection server={server} />}
      {active === 'invites' && <InvitesSection server={server} />}
      {active === 'bans' && <BansSection server={server} />}
    </SettingsShell>
  );
}
