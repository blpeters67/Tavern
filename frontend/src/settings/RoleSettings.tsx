import { useEffect, useMemo, useState, type DragEvent } from 'react';
import { api, errorMessage } from '../api/http';
import { Icon, mdiClose, mdiDragVertical, mdiLock, mdiMagnify, mdiPencil, mdiPlus, mdiShieldCrownOutline } from '../components/icons';
import { tip } from '../components/layers';
import { toast } from '../components/Toasts';
import { Avatar, Button, Divider, Field, Switch, TextInput } from '../components/ui';
import { userAvatar } from '../lib/avatars';
import { colorHex } from '../lib/format';
import { ADMIN_PERMISSION, ALL, P, PERMISSION_GROUPS } from '../lib/permissions';
import { ConfirmModal } from '../modals/ServerModals';
import { openModal } from '../store/actions';
import { canManageRole, displayName, myServerPerms, sortedRoles } from '../store/selectors';
import { dispatch, getState, useStore } from '../store/store';
import type { Role, Server } from '../store/types';
import { SaveBar } from './SettingsLayer';

const ROLE_COLORS = [
  0x1abc9c, 0x2ecc71, 0x3498db, 0x9b59b6, 0xe91e63, 0xf1c40f, 0xe67e22, 0xe74c3c, 0x95a5a6, 0x607d8b, 0x11806a, 0x1f8b4c, 0x206694, 0x71368a, 0xad1457, 0xc27c0e,
  0xa84300, 0x992d22, 0x979c9f, 0x546e7a,
];

type Draft = Pick<Role, 'name' | 'color' | 'permissions' | 'hoist' | 'mentionable'>;

function draftOf(r: Role): Draft {
  return { name: r.name, color: r.color, permissions: r.permissions, hoist: r.hoist, mentionable: r.mentionable };
}

export default function RoleSettings({ server }: { server: Server }) {
  const rolesMap = useStore((s) => s.roles);
  const membersMap = useStore((s) => s.members[server.id]);
  const users = useStore((s) => s.users);
  const roles = useMemo(() => sortedRoles(getState(), server.id), [rolesMap, server.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [selectedId, setSelectedId] = useState<number | null>(() => roles.find((r) => !r.is_default)?.id ?? roles[0]?.id ?? null);
  const [tab, setTab] = useState<'display' | 'permissions' | 'members'>('display');
  const role = roles.find((r) => r.id === selectedId) ?? roles[0];
  const [draft, setDraft] = useState<Draft | null>(role ? draftOf(role) : null);
  const [saving, setSaving] = useState(false);
  const [permQuery, setPermQuery] = useState('');
  const [adding, setAdding] = useState(false);
  const [dragId, setDragId] = useState<number | null>(null);
  const [dropSpot, setDropSpot] = useState<{ id: number; where: 'before' | 'after' } | null>(null);

  useEffect(() => {
    if (role) setDraft(draftOf(role));
  }, [role?.id, role?.name, role?.color, role?.permissions, role?.hoist, role?.mentionable]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!role || !draft) return null;
  const s = getState();
  const editable = canManageRole(s, server.id, role) || (role.is_default && (myServerPerms(s, server.id) & P.MANAGE_ROLES) !== 0);
  const myPerms = myServerPerms(s, server.id);
  const dirty = JSON.stringify(draft) !== JSON.stringify(draftOf(role));
  const memberCount = (r: Role) => (r.is_default ? Object.keys(membersMap ?? {}).length : Object.values(membersMap ?? {}).filter((m) => m.role_ids.includes(r.id)).length);

  const save = async () => {
    setSaving(true);
    const body: Partial<Draft> = {};
    (Object.keys(draft) as (keyof Draft)[]).forEach((k) => {
      if (draft[k] !== role[k]) (body as Record<string, unknown>)[k] = draft[k];
    });
    try {
      const updated = await api.patch<Role>(`/api/servers/${server.id}/roles/${role.id}`, body);
      dispatch('ROLES_UPDATE', { server_id: server.id, roles: Object.values(getState().roles).filter((r) => r.server_id === server.id).map((r) => (r.id === updated.id ? updated : r)) });
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const create = async () => {
    try {
      const r = await api.post<Role>(`/api/servers/${server.id}/roles`, { name: 'new role' });
      setSelectedId(r.id);
      setTab('display');
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const remove = () =>
    openModal((close) => (
      <ConfirmModal
        title="Delete Role"
        body={
          <>
            Are you sure you want to delete the <strong>{role.name}</strong> role? This cannot be undone.
          </>
        }
        confirm="Delete"
        onClose={close}
        onConfirm={async () => {
          await api.del(`/api/servers/${server.id}/roles/${role.id}`);
          setSelectedId(roles.find((r) => r.id !== role.id && !r.is_default)?.id ?? roles.find((r) => r.is_default)?.id ?? null);
        }}
      />
    ));

  const togglePerm = (bit: number, on: boolean) => setDraft({ ...draft, permissions: on ? draft.permissions | bit : draft.permissions & ~bit });
  const adminOn = (draft.permissions & P.ADMINISTRATOR) !== 0;
  const setAdmin = (on: boolean) => {
    if (!on) {
      togglePerm(P.ADMINISTRATOR, false);
      return;
    }
    openModal((close) => (
      <ConfirmModal
        title="Are you sure?"
        body="Selecting the Admin permission will grant this role every single permission below it."
        confirm="Yes"
        cancel="No"
        onClose={close}
        onConfirm={() => setDraft((d) => (d ? { ...d, permissions: d.permissions | P.ADMINISTRATOR } : d))}
      />
    ));
  };

  // ---- drag to reorder ----
  const movable = roles.filter((r) => !r.is_default);
  const onDrop = async () => {
    const spot = dropSpot;
    const dragged = dragId;
    setDragId(null);
    setDropSpot(null);
    if (!spot || dragged === null || spot.id === dragged) return;
    const ids = movable.map((r) => r.id).filter((id) => id !== dragged);
    const idx = ids.indexOf(spot.id) + (spot.where === 'after' ? 1 : 0);
    ids.splice(idx, 0, dragged);
    try {
      const updated = await api.put<Role[]>(`/api/servers/${server.id}/roles/order`, { role_ids: ids });
      dispatch('ROLES_UPDATE', { server_id: server.id, roles: updated });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const withRole = Object.values(membersMap ?? {})
    .filter((m) => m.role_ids.includes(role.id))
    .map((m) => users[m.user_id])
    .filter(Boolean);
  const withoutRole = Object.values(membersMap ?? {})
    .filter((m) => !m.role_ids.includes(role.id))
    .map((m) => users[m.user_id])
    .filter(Boolean);

  const setMember = async (userId: number, add: boolean) => {
    try {
      const path = `/api/servers/${server.id}/members/${userId}/roles/${role.id}`;
      if (add) await api.put(path);
      else await api.del(path);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const q = permQuery.trim().toLowerCase();
  return (
    <div className="roles-layout">
      <div className="roles-sidebar">
        <div className="roles-sidebar-header">
          <span>Roles</span>
          <button className="icon-button" aria-label="Create Role" {...tip('Create Role')} onClick={create}>
            <Icon path={mdiPlus} size={18} />
          </button>
        </div>
        <div className="roles-list scroller-thin">
          {roles.map((r) => {
            const canDrag = !r.is_default && canManageRole(s, server.id, r);
            return (
              <button
                key={r.id}
                className={`role-list-item ${r.id === role.id ? 'selected' : ''} ${dropSpot?.id === r.id ? `drop-${dropSpot.where}` : ''}`}
                onClick={() => setSelectedId(r.id)}
                draggable={canDrag}
                onDragStart={(e: DragEvent) => {
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData('text/plain', String(r.id));
                  setDragId(r.id);
                }}
                onDragOver={(e: DragEvent) => {
                  if (dragId === null || r.is_default || r.id === dragId) return;
                  e.preventDefault();
                  const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
                  const where = e.clientY < rect.top + rect.height / 2 ? 'before' : 'after';
                  if (dropSpot?.id !== r.id || dropSpot.where !== where) setDropSpot({ id: r.id, where });
                }}
                onDrop={(e) => {
                  e.preventDefault();
                  void onDrop();
                }}
                onDragEnd={() => {
                  setDragId(null);
                  setDropSpot(null);
                }}
              >
                {canDrag && <Icon path={mdiDragVertical} size={16} className="role-drag" />}
                <span className="role-dot" style={{ background: r.color ? colorHex(r.color) : '#80848e' }} />
                <span className="role-list-name">{r.name}</span>
                {!canManageRole(s, server.id, r) && !r.is_default && <Icon path={mdiLock} size={14} className="role-lock" />}
              </button>
            );
          })}
        </div>
        <p className="roles-hint">Drag to reorder. Higher roles outrank lower ones.</p>
      </div>

      <div className="role-editor">
        <div className="role-editor-header">
          <h2 className="settings-title">Edit Role — {role.name}</h2>
          <span className="role-member-count">
            {memberCount(role)} {memberCount(role) === 1 ? 'member' : 'members'}
          </span>
        </div>
        {!editable && (
          <div className="warning-box">
            <Icon path={mdiLock} size={16} /> You can only edit roles below your highest role.
          </div>
        )}
        <div className="tab-bar">
          <button className={`tab ${tab === 'display' ? 'active' : ''}`} onClick={() => setTab('display')}>
            Display
          </button>
          <button className={`tab ${tab === 'permissions' ? 'active' : ''}`} onClick={() => setTab('permissions')}>
            Permissions
          </button>
          {!role.is_default && (
            <button className={`tab ${tab === 'members' ? 'active' : ''}`} onClick={() => setTab('members')}>
              Manage Members ({withRole.length})
            </button>
          )}
        </div>

        <fieldset className="role-editor-body" disabled={!editable}>
          {tab === 'display' && (
            <>
              {role.is_default ? (
                <p className="settings-desc">
                  <strong>@everyone</strong> is the role every member has. Its permissions are the baseline for everyone in the server.
                </p>
              ) : (
                <>
                  <Field label="Role Name" required>
                    <TextInput value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} maxLength={100} />
                  </Field>
                  <Divider />
                  <div className="field">
                    <div className="field-label">Role Color</div>
                    <p className="settings-desc">Members use the color of the highest role they have.</p>
                    <div className="role-colors">
                      <button className={`swatch big default ${draft.color === 0 ? 'selected' : ''}`} onClick={() => setDraft({ ...draft, color: 0 })} {...tip('Default')}>
                        {draft.color === 0 && <span className="swatch-check" />}
                      </button>
                      <label className="swatch big custom" style={{ background: draft.color && !ROLE_COLORS.includes(draft.color) ? colorHex(draft.color) : undefined }} {...tip('Custom Color')}>
                        <input type="color" value={draft.color ? colorHex(draft.color) : '#99aab5'} onChange={(e) => setDraft({ ...draft, color: parseInt(e.target.value.slice(1), 16) })} />
                        <Icon path={mdiPencil} size={14} />
                      </label>
                      <div className="swatch-grid">
                        {ROLE_COLORS.map((c) => (
                          <button key={c} className={`swatch ${draft.color === c ? 'selected' : ''}`} style={{ background: colorHex(c) }} onClick={() => setDraft({ ...draft, color: c })} aria-label={colorHex(c)} />
                        ))}
                      </div>
                    </div>
                  </div>
                  <Divider />
                  <div className="switch-row">
                    <div className="switch-row-top">
                      <span className="switch-row-title">Display role members separately from online members</span>
                      <Switch checked={draft.hoist} onChange={(v) => setDraft({ ...draft, hoist: v })} />
                    </div>
                  </div>
                  <div className="switch-row">
                    <div className="switch-row-top">
                      <span className="switch-row-title">Allow anyone to @mention this role</span>
                      <Switch checked={draft.mentionable} onChange={(v) => setDraft({ ...draft, mentionable: v })} />
                    </div>
                    <div className="switch-row-desc">Members with "Mention @everyone, @here, and All Roles" can always ping this role.</div>
                  </div>
                  {editable && (
                    <Button look="danger" onClick={remove} className="role-delete">
                      Delete Role
                    </Button>
                  )}
                </>
              )}
            </>
          )}

          {tab === 'permissions' && (
            <>
              <div className="search-input wide">
                <input placeholder="Search permissions" value={permQuery} onChange={(e) => setPermQuery(e.target.value)} />
                <Icon path={mdiMagnify} size={18} />
              </div>
              {(!q || ADMIN_PERMISSION.name.toLowerCase().includes(q) || ADMIN_PERMISSION.description.toLowerCase().includes(q)) && (
                <div className="perm-group perm-admin">
                  <div className={`switch-row admin-row ${adminOn ? 'on' : ''} ${myPerms !== ALL ? 'disabled' : ''}`}>
                    <div className="switch-row-top">
                      <span className="switch-row-title">
                        <Icon path={mdiShieldCrownOutline} size={20} />
                        {ADMIN_PERMISSION.name}
                      </span>
                      <Switch checked={adminOn} onChange={setAdmin} disabled={myPerms !== ALL} label="Admin" />
                    </div>
                    <div className="switch-row-desc">{ADMIN_PERMISSION.description}</div>
                  </div>
                </div>
              )}
              {PERMISSION_GROUPS.map((g) => {
                const perms = g.perms.filter((p) => !q || p.name.toLowerCase().includes(q) || p.description.toLowerCase().includes(q));
                if (!perms.length) return null;
                return (
                  <div key={g.title} className={`perm-group ${adminOn ? 'granted-by-admin' : ''}`}>
                    <h3 className="settings-subtitle">{g.title}</h3>
                    {perms.map((p) => {
                      const on = adminOn || (draft.permissions & p.bit) === p.bit;
                      const cantGrant = myPerms !== ALL && !(myPerms & p.bit);
                      return (
                        <div key={p.bit} className={`switch-row ${cantGrant || adminOn ? 'disabled' : ''}`}>
                          <div className="switch-row-top">
                            <span className="switch-row-title">{p.name}</span>
                            <Switch checked={on} onChange={(v) => togglePerm(p.bit, v)} disabled={cantGrant || adminOn} label={p.name} />
                          </div>
                          <div className="switch-row-desc">{adminOn ? 'Granted by Admin. ' : ''}{p.description}</div>
                        </div>
                      );
                    })}
                  </div>
                );
              })}
            </>
          )}

          {tab === 'members' && !role.is_default && (
            <>
              <div className="role-members-toolbar">
                <Button size="small" onClick={() => setAdding((v) => !v)}>
                  {adding ? 'Done' : 'Add Members'}
                </Button>
              </div>
              {adding && (
                <div className="role-add-list scroller-thin">
                  {withoutRole.length === 0 && <div className="empty-state small">Everyone already has this role.</div>}
                  {withoutRole.map((u) => (
                    <button key={u.id} className="role-member-row add" onClick={() => setMember(u.id, true)}>
                      <Avatar src={userAvatar(u)} size={24} />
                      <span className="role-member-name">{displayName(u)}</span>
                      <span className="role-member-username">{u.username}</span>
                      <Icon path={mdiPlus} size={16} />
                    </button>
                  ))}
                </div>
              )}
              <div className="role-members">
                {withRole.length === 0 && <div className="empty-state small">Nobody has this role yet.</div>}
                {withRole.map((u) => (
                  <div key={u.id} className="role-member-row">
                    <Avatar src={userAvatar(u)} size={24} />
                    <span className="role-member-name">{displayName(u)}</span>
                    <span className="role-member-username">{u.username}</span>
                    <button className="icon-button" aria-label="Remove member" {...tip('Remove member')} onClick={() => setMember(u.id, false)}>
                      <Icon path={mdiClose} size={16} />
                    </button>
                  </div>
                ))}
              </div>
            </>
          )}
        </fieldset>
      </div>
      {dirty && editable && <SaveBar onReset={() => setDraft(draftOf(role))} onSave={save} saving={saving} />}
    </div>
  );
}
