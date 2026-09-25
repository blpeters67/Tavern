import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../api/http';
import IconPickerField from '../components/IconPickerField';
import { Icon, iconHash, mdiFolder, mdiImage, mdiLock, mdiTextBoxOutline, mdiVolumeHigh } from '../components/icons';
import { Modal } from '../components/layers';
import { toast } from '../components/Toasts';
import { Button, Field, Select, Switch, TextInput } from '../components/ui';
import { load, save } from '../lib/storage';
import { acceptInvite, channelPath, go } from '../store/actions';
import { displayName } from '../store/selectors';
import { dispatch, getState, useStore } from '../store/store';
import type { Channel, InviteInfo, Server, ServerPayload } from '../store/types';
import { ChannelType } from '../store/types';
import { P, everyoneRole } from '../lib/permissions';
import { extractCode } from './inviteCode';
import { cropImage } from '../components/ImageCropper';

// ---------------------------------------------------------------------------
// Create / join a server
// ---------------------------------------------------------------------------

export function CreateServerModal({ onClose }: { onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [mode, setMode] = useState<'create' | 'join'>('create');
  const [name, setName] = useState(`${displayName(me)}'s server`);
  const [icon, setIcon] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [invite, setInvite] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const create = async (e?: FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    setError('');
    const form = new FormData();
    form.append('name', name);
    if (icon) form.append('icon', icon);
    try {
      const server = await api.post<ServerPayload>('/api/servers', form);
      dispatch('SERVER_CREATE', server);
      onClose();
      const general = server.channels.find((c) => c.type === ChannelType.TEXT);
      go(general ? `/channels/${server.id}/${general.id}` : `/channels/${server.id}`);
    } catch (err) {
      setError(err instanceof ApiError && err.errors.name ? err.errors.name : errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const join = async (e?: FormEvent) => {
    e?.preventDefault();
    const code = extractCode(invite);
    if (!code) {
      setError('Please enter a valid invite link or invite code.');
      return;
    }
    setLoading(true);
    setError('');
    try {
      await api.get<InviteInfo>(`/api/invites/${encodeURIComponent(code)}`);
      await acceptInvite(code);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError && err.status === 404 ? 'The invite is invalid or has expired.' : errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  if (mode === 'join') {
    return (
      <Modal
        title="Join a Server"
        subtitle="Enter an invite below to join an existing server"
        centered
        onClose={onClose}
        className="create-server-modal"
        footer={
          <>
            <Button look="link" onClick={() => setMode('create')}>
              Back
            </Button>
            <Button onClick={() => join()} loading={loading}>
              Join Server
            </Button>
          </>
        }
      >
        <form onSubmit={join}>
          <Field label="Invite Link" required error={error}>
            <TextInput autoFocus value={invite} onChange={(e) => setInvite(e.target.value)} placeholder={`${location.origin}/invite/hTKzmak`} />
          </Field>
          <div className="field-label">Invites should look like</div>
          <div className="invite-examples">
            <div>hTKzmak</div>
            <div>{location.origin}/invite/hTKzmak</div>
          </div>
        </form>
      </Modal>
    );
  }

  return (
    <Modal
      title="Create Your Server"
      subtitle="Your server is where you and your friends hang out. Make yours and start talking."
      centered
      onClose={onClose}
      className="create-server-modal"
      footer={
        <>
          <Button look="link" onClick={() => setMode('join')}>
            Join a server instead
          </Button>
          <Button onClick={() => create()} loading={loading}>
            Create
          </Button>
        </>
      }
    >
      <form onSubmit={create}>
        <div className="icon-upload-row">
          <button type="button" className={`icon-upload ${preview ? 'has-image' : ''}`} onClick={() => fileRef.current?.click()} aria-label="Upload server icon">
            {preview ? (
              <img src={preview} alt="" />
            ) : (
              <>
                <Icon path={mdiImage} size={24} />
                <span>Upload</span>
              </>
            )}
            <span className="icon-upload-plus">+</span>
          </button>
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
                if (!cropped) return;
                setIcon(cropped);
                setPreview(URL.createObjectURL(cropped));
              });
            }}
          />
        </div>
        <Field label="Server Name" required error={error}>
          <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={100} />
        </Field>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Create channel / category
// ---------------------------------------------------------------------------

export function CreateChannelModal({
  serverId,
  parentId,
  category,
  voice,
  onClose,
}: {
  serverId: number;
  parentId?: number | null;
  category?: boolean;
  voice?: boolean;
  onClose: () => void;
}) {
  const [type, setType] = useState<number>(category ? ChannelType.CATEGORY : voice ? ChannelType.VOICE : ChannelType.TEXT);
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState<string | null>(null);
  const [priv, setPriv] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const parent = useStore((s) => (parentId ? s.channels[parentId] : undefined));
  const roles = useStore((s) => s.roles);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    setError('');
    try {
      const ch = await api.post<Channel>(`/api/servers/${serverId}/channels`, {
        name,
        type,
        emoji: type === ChannelType.CATEGORY ? null : emoji,
        parent_id: type === ChannelType.CATEGORY ? null : (parentId ?? null),
      });
      dispatch('CHANNEL_CREATE', ch);
      if (priv) {
        const everyone = everyoneRole(roles, serverId);
        if (everyone) await api.put(`/api/channels/${ch.id}/permissions/0/${everyone.id}`, { allow: 0, deny: P.VIEW_CHANNEL });
      }
      onClose();
      if (ch.type === ChannelType.TEXT) go(channelPath(ch));
    } catch (err) {
      setError(err instanceof ApiError && (err.errors.name || err.errors.emoji) ? err.errors.name || err.errors.emoji : errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const isCategory = type === ChannelType.CATEGORY;
  const isVoice = type === ChannelType.VOICE;
  const noun = isCategory ? 'Category' : isVoice ? 'Voice Space' : 'Channel';
  const option = (t: number, icon: string, title: string, desc: string) => (
    <button type="button" className={`type-option ${type === t ? 'selected' : ''}`} onClick={() => setType(t)}>
      <Icon path={icon} size={24} />
      <span className="type-option-text">
        <span className="type-option-title">{title}</span>
        <span className="type-option-desc">{desc}</span>
      </span>
      <span className={`radio ${type === t ? 'checked' : ''}`} />
    </button>
  );
  return (
    <Modal
      title={`Create ${noun}`}
      subtitle={!isCategory && parent ? `in ${parent.name}` : undefined}
      onClose={onClose}
      className="create-channel-modal"
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit()} loading={loading} disabled={!name.trim()}>
            Create {noun}
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {!category && (
          <div className="field">
            <div className="field-label">Type</div>
            {option(ChannelType.TEXT, mdiTextBoxOutline, 'Text', 'Scenes, story posts, dice rolls, images and chatter')}
            {option(ChannelType.VOICE, mdiVolumeHigh, 'Voice', 'Talk, share your screen or turn on your camera together')}
            {option(ChannelType.CATEGORY, mdiFolder, 'Category', 'A heading that groups channels together')}
          </div>
        )}
        <Field label={`${noun} Name`} error={error}>
          <div className="name-with-icon">
            {!isCategory && <IconPickerField value={emoji} type={type} serverId={serverId} onChange={setEmoji} />}
            <TextInput
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={isCategory ? 'Adventures' : isVoice ? 'The Lounge' : 'Sessions'}
              maxLength={100}
            />
          </div>
        </Field>
        <div className="private-toggle">
          <div className="private-toggle-text">
            <div className="private-toggle-title">
              <Icon path={mdiLock} size={16} /> Private {noun}
            </div>
            <div className="private-toggle-desc">Only people with roles you allow in its settings will be able to see it.</div>
          </div>
          <Switch checked={priv} onChange={setPriv} label="Private" />
        </div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Invites
// ---------------------------------------------------------------------------

const AGE_OPTIONS = [
  { value: 1800, label: '30 minutes' },
  { value: 3600, label: '1 hour' },
  { value: 21600, label: '6 hours' },
  { value: 43200, label: '12 hours' },
  { value: 86400, label: '1 day' },
  { value: 604800, label: '7 days' },
  { value: 0, label: 'Never' },
];
const USE_OPTIONS = [
  { value: 0, label: 'No limit' },
  { value: 1, label: '1 use' },
  { value: 5, label: '5 uses' },
  { value: 10, label: '10 uses' },
  { value: 25, label: '25 uses' },
  { value: 50, label: '50 uses' },
  { value: 100, label: '100 uses' },
];

export function InviteModal({ serverId, channelId, onClose }: { serverId: number; channelId?: number; onClose: () => void }) {
  const server = useStore((s) => s.servers[serverId]);
  const target = useStore((s) => {
    if (channelId) return s.channels[channelId];
    const sys = server?.system_channel_id ? s.channels[server.system_channel_id] : undefined;
    return sys ?? Object.values(s.channels).find((c) => c.server_id === serverId && c.type === ChannelType.TEXT);
  });
  const [opts, setOpts] = useState(() => load<{ max_age: number; max_uses: number }>('inviteOpts', { max_age: 604800, max_uses: 0 }));
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [copied, setCopied] = useState(false);

  const generate = async (o = opts) => {
    if (!target) return;
    try {
      setInvite(await api.post<InviteInfo>(`/api/channels/${target.id}/invites`, o));
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  useEffect(() => {
    void generate();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const copy = async () => {
    if (!invite) return;
    try {
      await navigator.clipboard.writeText(invite.url);
    } catch {
      /* clipboard blocked; the text is selectable anyway */
    }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  const age = AGE_OPTIONS.find((o) => o.value === opts.max_age)?.label ?? '7 days';
  return (
    <Modal
      title={`Invite friends to ${server?.name ?? 'server'}`}
      subtitle={
        target ? (
          <span className="invite-channel">
            <Icon path={iconHash} size={16} /> {target.name}
          </span>
        ) : undefined
      }
      onClose={onClose}
      className="invite-modal"
    >
      {!editing ? (
        <>
          <div className="field-label">Send a server invite link to a friend</div>
          <div className={`copy-input ${copied ? 'copied' : ''}`}>
            <input readOnly value={invite?.url ?? 'Generating…'} onFocus={(e) => e.target.select()} aria-label="Invite link" />
            <Button look={copied ? 'green' : 'brand'} size="small" onClick={copy} disabled={!invite}>
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
          <div className="invite-footnote">
            {opts.max_age ? `Your invite link expires in ${age}.` : 'Your invite link will never expire.'}
            {opts.max_uses ? ` It works ${opts.max_uses} time${opts.max_uses === 1 ? '' : 's'}.` : ''}{' '}
            <button className="link-button" onClick={() => setEditing(true)}>
              Edit invite link.
            </button>
          </div>
        </>
      ) : (
        <div className="invite-settings">
          <Field label="Expire After">
            <Select value={opts.max_age} options={AGE_OPTIONS} onChange={(v) => setOpts({ ...opts, max_age: v })} />
          </Field>
          <Field label="Max Number of Uses">
            <Select value={opts.max_uses} options={USE_OPTIONS} onChange={(v) => setOpts({ ...opts, max_uses: v })} />
          </Field>
          <div className="modal-actions-inline">
            <Button look="link" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button
              onClick={() => {
                save('inviteOpts', opts);
                setEditing(false);
                void generate(opts);
              }}
            >
              Generate a New Link
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------
// Confirmations
// ---------------------------------------------------------------------------

export function ConfirmModal({
  title,
  body,
  confirm,
  cancel = 'Cancel',
  onConfirm,
  onClose,
  danger = true,
}: {
  title: string;
  body: React.ReactNode;
  confirm: string;
  cancel?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
  danger?: boolean;
}) {
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            {cancel}
          </Button>
          <Button
            look={danger ? 'danger' : 'brand'}
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await onConfirm();
                onClose();
              } catch (err) {
                toast(errorMessage(err));
                setLoading(false);
              }
            }}
          >
            {confirm}
          </Button>
        </>
      }
    >
      <div className="modal-text">{body}</div>
    </Modal>
  );
}

export function LeaveServerModal({ server, onClose }: { server: Server; onClose: () => void }) {
  return (
    <ConfirmModal
      title={`Leave '${server.name}'`}
      body={
        <>
          Are you sure you want to leave <strong>{server.name}</strong>? You won't be able to rejoin this server unless you are re-invited.
        </>
      }
      confirm="Leave Server"
      onClose={onClose}
      onConfirm={async () => {
        await api.del(`/api/servers/${server.id}/members/@me`);
        if (getState().activeChannelId && getState().channels[getState().activeChannelId!]?.server_id === server.id) go('/channels/@me');
      }}
    />
  );
}

export function DeleteChannelModal({ channel, onClose }: { channel: Channel; onClose: () => void }) {
  const isCategory = channel.type === ChannelType.CATEGORY;
  return (
    <ConfirmModal
      title={isCategory ? 'Delete Category' : 'Delete Channel'}
      body={
        <>
          Are you sure you want to delete <strong>{channel.name}</strong>?{' '}
          {isCategory ? 'The channels inside it will be kept.' : 'This cannot be undone.'}
        </>
      }
      confirm={isCategory ? 'Delete Category' : 'Delete Channel'}
      onClose={onClose}
      onConfirm={async () => {
        await api.del(`/api/channels/${channel.id}`);
      }}
    />
  );
}
