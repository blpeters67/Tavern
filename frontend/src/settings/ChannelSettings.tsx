import { useEffect, useMemo, useState } from 'react';
import { api, ApiError, errorMessage } from '../api/http';
import { Icon, mdiCheck, mdiClose, mdiPlus, mdiSlashForward } from '../components/icons';
import { Popout, usePopout } from '../components/layers';
import { toast } from '../components/Toasts';
import IconPickerField from '../components/IconPickerField';
import { Avatar, Field, Select, Slider, TextArea, TextInput } from '../components/ui';
import { userAvatar } from '../lib/avatars';
import { colorHex } from '../lib/format';
import { ALL, everyoneRole, P, PERMISSION_GROUPS } from '../lib/permissions';
import { DeleteChannelModal } from '../modals/ServerModals';
import { closeSettings, openModal } from '../store/actions';
import { displayName, myChannelPerms, sortedRoles } from '../store/selectors';
import { dispatch, getState, useStore } from '../store/store';
import type { Channel, Overwrite } from '../store/types';
import { ChannelType } from '../store/types';
import { SaveBar, SettingsShell, type NavEntry } from './SettingsLayer';

function OverviewSection({ channel }: { channel: Channel }) {
  const channels = useStore((s) => s.channels);
  const [name, setName] = useState(channel.name ?? '');
  const [topic, setTopic] = useState(channel.topic ?? '');
  const [parent, setParent] = useState<number>(channel.parent_id ?? 0);
  const [emoji, setEmoji] = useState<string | null>(channel.emoji ?? null);
  const [limit, setLimit] = useState<number>(channel.user_limit ?? 0);
  const [bitrate, setBitrate] = useState<number>(channel.bitrate ?? 64);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const isText = channel.type === ChannelType.TEXT;
  const isVoice = channel.type === ChannelType.VOICE;
  const isCategory = channel.type === ChannelType.CATEGORY;
  const categories = Object.values(channels)
    .filter((c) => c.server_id === channel.server_id && c.type === ChannelType.CATEGORY)
    .sort((a, b) => a.position - b.position);

  const dirty =
    name !== (channel.name ?? '') ||
    topic !== (channel.topic ?? '') ||
    parent !== (channel.parent_id ?? 0) ||
    emoji !== (channel.emoji ?? null) ||
    (isVoice && (limit !== (channel.user_limit ?? 0) || bitrate !== (channel.bitrate ?? 64)));
  const reset = () => {
    setName(channel.name ?? '');
    setTopic(channel.topic ?? '');
    setParent(channel.parent_id ?? 0);
    setEmoji(channel.emoji ?? null);
    setLimit(channel.user_limit ?? 0);
    setBitrate(channel.bitrate ?? 64);
  };
  const save = async () => {
    setSaving(true);
    setError('');
    try {
      const body: Record<string, unknown> = { name: name.trim() };
      if (!isCategory) {
        body.parent_id = parent || null;
        body.emoji = emoji ?? '';
      }
      if (isText) body.topic = topic;
      if (isVoice) {
        body.user_limit = limit;
        body.bitrate = bitrate;
      }
      dispatch('CHANNEL_UPDATE', await api.patch<Channel>(`/api/channels/${channel.id}`, body));
    } catch (err) {
      setError(err instanceof ApiError && err.errors.name ? err.errors.name : errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <h2 className="settings-title">Overview</h2>
      <Field
        label={isCategory ? 'Category Name' : isVoice ? 'Voice Space Name' : 'Channel Name'}
        error={error}
        hint={isCategory ? undefined : 'Capitals, spaces and punctuation are fine. Pick an icon to show next to the name in the sidebar.'}
      >
        <div className="channel-name-row">
          {!isCategory && channel.server_id !== null && <IconPickerField value={emoji} type={channel.type} serverId={channel.server_id} onChange={setEmoji} />}
          <TextInput value={name} onChange={(e) => setName(e.target.value.replace(/^#+/, ''))} maxLength={100} placeholder={isVoice ? 'The Lounge' : 'Tavern Hall'} />
        </div>
      </Field>
      {isText && (
        <Field label="Channel Topic" hint={`${1024 - topic.length} characters left`}>
          <TextArea value={topic} onChange={(e) => setTopic(e.target.value.slice(0, 1024))} rows={4} placeholder="Let everyone know what this channel is for (or which scene is running)" />
        </Field>
      )}
      {isVoice && (
        <Field label="User Limit" hint="How many people can be in this voice space at once. People who can Move Members can always join.">
          <div className="limit-row">
            <Slider value={limit} min={0} max={99} step={1} label="User limit" onChange={setLimit} />
            <span className="limit-value">{limit === 0 ? 'No limit' : `${limit} ${limit === 1 ? 'user' : 'users'}`}</span>
          </div>
        </Field>
      )}
      {isVoice && (
        <Field
          label="Bitrate"
          hint="How clear voices sound in this space, for everyone. Higher sounds better but uses more upload, since each person sends their voice to every other person. 64 kbps is plenty for talking; go higher for singing or music."
        >
          <div className="limit-row">
            <Slider value={bitrate} min={8} max={256} step={8} label="Bitrate" onChange={setBitrate} />
            <span className="limit-value">{bitrate} kbps</span>
          </div>
        </Field>
      )}
      {!isCategory && (
        <Field label="Category">
          <Select value={parent} options={[{ value: 0, label: 'No category' }, ...categories.map((c) => ({ value: c.id, label: c.name ?? '' }))]} onChange={setParent} />
        </Field>
      )}
      {dirty && <SaveBar onReset={reset} onSave={save} saving={saving} />}
    </>
  );
}

type Tri = 'deny' | 'inherit' | 'allow';

function TriToggle({ value, onChange, disabled }: { value: Tri; onChange: (v: Tri) => void; disabled?: boolean }) {
  return (
    <div className={`tri-toggle ${disabled ? 'disabled' : ''}`} role="radiogroup">
      <button className={`tri deny ${value === 'deny' ? 'on' : ''}`} onClick={() => onChange('deny')} disabled={disabled} aria-label="Deny" role="radio" aria-checked={value === 'deny'}>
        <Icon path={mdiClose} size={16} />
      </button>
      <button
        className={`tri inherit ${value === 'inherit' ? 'on' : ''}`}
        onClick={() => onChange('inherit')}
        disabled={disabled}
        aria-label="Inherit"
        role="radio"
        aria-checked={value === 'inherit'}
      >
        <Icon path={mdiSlashForward} size={16} />
      </button>
      <button className={`tri allow ${value === 'allow' ? 'on' : ''}`} onClick={() => onChange('allow')} disabled={disabled} aria-label="Allow" role="radio" aria-checked={value === 'allow'}>
        <Icon path={mdiCheck} size={16} />
      </button>
    </div>
  );
}

const keyOf = (o: Pick<Overwrite, 'type' | 'id'>) => `${o.type}:${o.id}`;

function PermissionsSection({ channel }: { channel: Channel }) {
  const serverId = channel.server_id!;
  const roles = useStore((s) => s.roles);
  const members = useStore((s) => s.members[serverId]);
  const users = useStore((s) => s.users);
  const everyone = everyoneRole(roles, serverId);
  const serverOverwrites = channel.overwrites ?? [];
  const [drafts, setDrafts] = useState<Record<string, Overwrite>>({});
  const [selected, setSelected] = useState<string>(() => (everyone ? `0:${everyone.id}` : ''));
  const [saving, setSaving] = useState(false);
  const adder = usePopout();

  useEffect(() => setDrafts({}), [channel.overwrites]);

  const current = useMemo(() => {
    const map: Record<string, Overwrite> = {};
    for (const o of serverOverwrites) map[keyOf(o)] = o;
    return { ...map, ...drafts };
  }, [serverOverwrites, drafts]);

  // Targets shown on the left: @everyone, anything with an overwrite, plus anything just added.
  const targets = useMemo(() => {
    const list: Overwrite[] = [];
    if (everyone) list.push(current[`0:${everyone.id}`] ?? { type: 0, id: everyone.id, allow: 0, deny: 0 });
    const s = getState();
    for (const r of sortedRoles(s, serverId)) if (!r.is_default && current[`0:${r.id}`]) list.push(current[`0:${r.id}`]);
    for (const o of Object.values(current)) if (o.type === 1) list.push(o);
    return list;
  }, [current, everyone, serverId]);

  const sel = current[selected] ?? targets.find((t) => keyOf(t) === selected) ?? targets[0];
  const perms = myChannelPerms(getState(), channel);
  const canEdit = (perms & P.MANAGE_ROLES) !== 0;

  const setBit = (bit: number, v: Tri) => {
    if (!sel) return;
    const next: Overwrite = { ...sel, allow: sel.allow & ~bit, deny: sel.deny & ~bit };
    if (v === 'allow') next.allow |= bit;
    if (v === 'deny') next.deny |= bit;
    setDrafts((d) => ({ ...d, [keyOf(next)]: next }));
  };

  const dirtyKeys = Object.keys(drafts).filter((k) => {
    const orig = serverOverwrites.find((o) => keyOf(o) === k);
    const d = drafts[k];
    return !orig ? d.allow !== 0 || d.deny !== 0 || d.type === 0 : orig.allow !== d.allow || orig.deny !== d.deny;
  });

  const save = async () => {
    setSaving(true);
    try {
      let latest: Channel | null = null;
      for (const k of dirtyKeys) {
        const o = drafts[k];
        latest = await api.put<Channel>(`/api/channels/${channel.id}/permissions/${o.type}/${o.id}`, { allow: o.allow, deny: o.deny });
      }
      if (latest) dispatch('CHANNEL_UPDATE', latest);
      setDrafts({});
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const removeTarget = async (o: Overwrite) => {
    try {
      dispatch('CHANNEL_UPDATE', await api.del<Channel>(`/api/channels/${channel.id}/permissions/${o.type}/${o.id}`));
      setDrafts((d) => {
        const n = { ...d };
        delete n[keyOf(o)];
        return n;
      });
      if (everyone) setSelected(`0:${everyone.id}`);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const addable = useMemo(() => {
    const s = getState();
    const roleTargets = sortedRoles(s, serverId)
      .filter((r) => !r.is_default && !current[`0:${r.id}`])
      .map((r) => ({ key: `0:${r.id}`, label: r.name, color: r.color, type: 0 as const, id: r.id }));
    const memberTargets = Object.keys(members ?? {})
      .map(Number)
      .filter((id) => !current[`1:${id}`] && users[id])
      .map((id) => ({ key: `1:${id}`, label: displayName(users[id]), color: 0, type: 1 as const, id }));
    return [...roleTargets, ...memberTargets];
  }, [current, members, users, serverId]);

  const label = (o: Overwrite) => (o.type === 0 ? (roles[o.id]?.name ?? 'deleted role') : displayName(users[o.id]));
  // Only what applies here: voice spaces skip message permissions, text channels skip voice ones.
  const applies = (p: { voice?: boolean; text?: boolean }) =>
    channel.type === ChannelType.CATEGORY || (channel.type === ChannelType.VOICE ? !p.text : !p.voice);
  const channelPerms = PERMISSION_GROUPS.map((g) => ({ ...g, perms: g.perms.filter((p) => p.channel && applies(p)) })).filter((g) => g.perms.length);
  const isPrivate = !!everyone && ((current[`0:${everyone.id}`]?.deny ?? 0) & P.VIEW_CHANNEL) !== 0;

  return (
    <>
      <h2 className="settings-title">Channel Permissions</h2>
      <p className="settings-desc">
        Use permissions to customise who can do what in this {channel.type === ChannelType.CATEGORY ? 'category (channels inside inherit it)' : 'channel'}.
        {isPrivate && ' This one is private: @everyone is blocked from viewing it.'}
      </p>
      <div className="perm-editor">
        <div className="perm-targets">
          <div className="perm-targets-header">
            <span>Roles / Members</span>
            {canEdit && (
              <button className="icon-button" aria-label="Add role or member" onClick={adder.toggle}>
                <Icon path={mdiPlus} size={18} />
              </button>
            )}
          </div>
          {targets.map((o) => (
            <button key={keyOf(o)} className={`perm-target ${sel && keyOf(sel) === keyOf(o) ? 'selected' : ''}`} onClick={() => setSelected(keyOf(o))}>
              {o.type === 0 ? (
                <span className="role-dot" style={{ background: roles[o.id]?.color ? colorHex(roles[o.id].color) : '#80848e' }} />
              ) : (
                <Avatar src={userAvatar(users[o.id])} size={20} />
              )}
              <span className="perm-target-name">{label(o)}</span>
            </button>
          ))}
        </div>
        <div className="perm-list">
          {sel && (
            <>
              <div className="perm-list-header">
                <span>
                  Permissions for <strong>{label(sel)}</strong>
                </span>
                {canEdit && !(everyone && sel.type === 0 && sel.id === everyone.id) && (
                  <button className="link-button danger" onClick={() => removeTarget(sel)}>
                    Remove
                  </button>
                )}
              </div>
              {channelPerms.map((g) => (
                <div key={g.title} className="perm-group">
                  <h3 className="settings-subtitle">{g.title}</h3>
                  {g.perms.map((p) => {
                    const value: Tri = sel.allow & p.bit ? 'allow' : sel.deny & p.bit ? 'deny' : 'inherit';
                    const cant = perms !== ALL && !(perms & p.bit);
                    return (
                      <div key={p.bit} className="perm-row">
                        <div className="perm-row-text">
                          <div className="perm-row-name">{p.name}</div>
                          <div className="perm-row-desc">{p.description}</div>
                        </div>
                        <TriToggle value={value} onChange={(v) => setBit(p.bit, v)} disabled={!canEdit || cant} />
                      </div>
                    );
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      </div>
      {adder.anchor && (
        <Popout anchor={adder.anchor} side="bottom-start" onClose={adder.close} className="perm-add-popout">
          <div className="menu perm-add-menu scroller-thin">
            {addable.length === 0 && <div className="menu-empty">Everyone's already listed.</div>}
            {addable.map((t) => (
              <button
                key={t.key}
                className="menu-item"
                onClick={() => {
                  setDrafts((d) => ({ ...d, [t.key]: { type: t.type, id: t.id, allow: 0, deny: 0 } }));
                  setSelected(t.key);
                  adder.close();
                }}
              >
                <span className="menu-label">
                  {t.type === 0 ? <span className="role-dot" style={{ background: t.color ? colorHex(t.color) : '#80848e' }} /> : <Avatar src={userAvatar(users[t.id])} size={16} />}
                  {t.label}
                </span>
              </button>
            ))}
          </div>
        </Popout>
      )}
      {dirtyKeys.length > 0 && <SaveBar onReset={() => setDrafts({})} onSave={save} saving={saving} />}
    </>
  );
}

export default function ChannelSettings({ channelId, section }: { channelId: number; section?: string }) {
  const channel = useStore((s) => s.channels[channelId]);
  const perms = useStore((s) => myChannelPerms(s, s.channels[channelId]));
  const [active, setActive] = useState(section ?? 'overview');

  useEffect(() => {
    if (!channel) closeSettings();
  }, [channel]);
  if (!channel) return null;

  const isCategory = channel.type === ChannelType.CATEGORY;
  const nav: NavEntry[] = [
    { kind: 'header', label: channel.name ?? '' },
    { kind: 'item', id: 'overview', label: 'Overview' },
  ];
  if (perms & P.MANAGE_ROLES) nav.push({ kind: 'item', id: 'permissions', label: 'Permissions' });
  nav.push({ kind: 'separator' });
  nav.push({
    kind: 'item',
    id: 'delete',
    label: isCategory ? 'Delete Category' : channel.type === ChannelType.VOICE ? 'Delete Voice Space' : 'Delete Channel',
    danger: true,
    onClick: () =>
      openModal((close) => (
        <DeleteChannelModal
          channel={channel}
          onClose={() => {
            close();
          }}
        />
      )),
  });

  return (
    <SettingsShell nav={nav} active={active} onSelect={setActive}>
      {active === 'overview' && <OverviewSection channel={channel} />}
      {active === 'permissions' && <PermissionsSection channel={channel} />}
    </SettingsShell>
  );
}
