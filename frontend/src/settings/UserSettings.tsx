import { useEffect, useMemo, useRef, useState, type CSSProperties, type FormEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { api, ApiError, errorMessage } from '../api/http';
import { Icon, mdiBookOpenPageVariant, mdiDramaMasks, mdiLock, mdiMenuDown, mdiMenuUp, mdiPencil, TavernLogo } from '../components/icons';
import { Modal, tip } from '../components/layers';
import { toast } from '../components/Toasts';
import { Avatar, Button, Divider, Field, SwitchRow, TextArea, TextInput } from '../components/ui';
import { characterAvatar, userAvatar } from '../lib/avatars';
import { calmColor, colorHex, formatTimestamp } from '../lib/format';
import { CharacterEditorModal, proxyString } from '../modals/CharacterModals';
import { ConfirmModal } from '../modals/ServerModals';
import { logout, openModal, openSheet, updateSettings } from '../store/actions';
import { displayName, myCharacters } from '../store/selectors';
import { dispatch, useStore } from '../store/store';
import type { Character, Me } from '../store/types';
import { SaveBar, SettingsShell, type NavEntry } from './SettingsLayer';
import VoiceSettings from './VoiceSettings';
import { cropImage } from '../components/ImageCropper';

const BANNER_PRESETS = [0x5865f2, 0x3ba55c, 0xfaa61a, 0xed4245, 0xeb459f, 0x1abc9c, 0x9b59b6, 0x206694, 0x992d22, 0x2b2d31];

// ---------------------------------------------------------------------------
// Account edit modals
// ---------------------------------------------------------------------------

function EditAccountModal({ field, onClose }: { field: 'username' | 'email' | 'display_name' | 'password'; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const [value, setValue] = useState(field === 'username' ? me.username : field === 'email' ? me.email : field === 'display_name' ? (me.display_name ?? '') : '');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const titles = {
    username: ['Change your username', 'Enter a new username and your existing password.'],
    email: ['Change your email address', 'Enter a new email address and your existing password.'],
    display_name: ['Change your display name', 'This is how others see you. You can use special characters and emoji.'],
    password: ['Update your password', 'Enter your current password and a new password.'],
  } as const;

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setErrors({});
    if (field === 'password' && value !== confirm) {
      setErrors({ confirm: "Passwords don't match." });
      return;
    }
    setLoading(true);
    const body: Record<string, string> = field === 'password' ? { password, new_password: value } : { [field]: value };
    if (field === 'username' || field === 'email') body.password = password;
    try {
      const updated = await api.patch<Me>('/api/users/@me', body);
      dispatch('ME_UPDATE', updated);
      if (field === 'password') toast('Password updated. Other devices were logged out.', 'success');
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) setErrors(err.errors);
      else setErrors({ [field]: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const [title, subtitle] = titles[field];
  return (
    <Modal
      title={title}
      subtitle={subtitle}
      centered
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit()} loading={loading}>
            Done
          </Button>
        </>
      }
    >
      <form onSubmit={submit}>
        {field === 'password' ? (
          <>
            <Field label="Current Password" error={errors.password}>
              <TextInput type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
            </Field>
            <Field label="New Password" error={errors.new_password}>
              <TextInput type="password" autoComplete="new-password" value={value} onChange={(e) => setValue(e.target.value)} />
            </Field>
            <Field label="Confirm New Password" error={errors.confirm}>
              <TextInput type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
            </Field>
          </>
        ) : (
          <>
            <Field label={field === 'display_name' ? 'Display Name' : field === 'email' ? 'Email' : 'Username'} error={errors[field]}>
              <TextInput autoFocus value={value} onChange={(e) => setValue(e.target.value)} type={field === 'email' ? 'email' : 'text'} maxLength={field === 'email' ? 254 : 32} />
            </Field>
            {field !== 'display_name' && (
              <Field label="Current Password" error={errors.password}>
                <TextInput type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            )}
          </>
        )}
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

function maskEmail(email: string): string {
  const [user, domain] = email.split('@');
  return `${'*'.repeat(Math.max(4, user.length))}@${domain}`;
}

// ---------------------------------------------------------------------------
// Sections
// ---------------------------------------------------------------------------

function AccountSection({ goProfile }: { goProfile: () => void }) {
  const me = useStore((s) => s.me)!;
  const [reveal, setReveal] = useState(false);
  const edit = (field: 'username' | 'email' | 'display_name' | 'password') => openModal((close) => <EditAccountModal field={field} onClose={close} />);
  return (
    <>
      <h2 className="settings-title">My Account</h2>
      <div className="account-card">
        <div className="account-banner" style={{ background: me.banner_color !== null ? colorHex(me.banner_color) : '#5865f2' }} />
        <div className="account-card-header">
          <Avatar src={userAvatar(me)} size={80} status={me.status === 'invisible' ? 'offline' : me.status} className="account-avatar" />
          <div className="account-card-name">{displayName(me)}</div>
          <Button onClick={goProfile}>Edit User Profile</Button>
        </div>
        <div className="account-fields">
          <div className="account-field">
            <div>
              <div className="account-field-label">Display Name</div>
              <div className="account-field-value">{me.display_name ?? <span className="text-muted">You haven't added a display name yet.</span>}</div>
            </div>
            <Button look="secondary" size="small" onClick={() => edit('display_name')}>
              {me.display_name ? 'Edit' : 'Add'}
            </Button>
          </div>
          <div className="account-field">
            <div>
              <div className="account-field-label">Username</div>
              <div className="account-field-value">{me.username}</div>
            </div>
            <Button look="secondary" size="small" onClick={() => edit('username')}>
              Edit
            </Button>
          </div>
          <div className="account-field">
            <div>
              <div className="account-field-label">Email</div>
              <div className="account-field-value">
                {reveal ? me.email : maskEmail(me.email)}{' '}
                <button className="link-button" onClick={() => setReveal((r) => !r)}>
                  {reveal ? 'Hide' : 'Reveal'}
                </button>
              </div>
            </div>
            <Button look="secondary" size="small" onClick={() => edit('email')}>
              Edit
            </Button>
          </div>
        </div>
      </div>
      <Divider style={{ margin: '40px 0' }} />
      <h3 className="settings-subtitle">Password and Authentication</h3>
      <Button onClick={() => edit('password')}>Change Password</Button>
      <p className="settings-note">Forgot it? Log out and use "Forgot your password?" on the login screen. We'll email you a reset link.</p>
    </>
  );
}

function ProfileSection() {
  const me = useStore((s) => s.me)!;
  const [displayNameValue, setDisplayName] = useState(me.display_name ?? '');
  const [about, setAbout] = useState(me.about ?? '');
  const [banner, setBanner] = useState<number | null>(me.banner_color);
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [saving, setSaving] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (avatarFile ? URL.createObjectURL(avatarFile) : null), [avatarFile]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const dirty = displayNameValue !== (me.display_name ?? '') || about !== (me.about ?? '') || banner !== me.banner_color || !!avatarFile || removeAvatar;
  const reset = () => {
    setDisplayName(me.display_name ?? '');
    setAbout(me.about ?? '');
    setBanner(me.banner_color);
    setAvatarFile(null);
    setRemoveAvatar(false);
  };
  const save = async () => {
    setSaving(true);
    try {
      let updated = await api.patch<Me>('/api/users/@me', { display_name: displayNameValue, about, banner_color: banner });
      if (avatarFile) {
        const form = new FormData();
        form.append('file', avatarFile);
        updated = await api.put<Me>('/api/users/@me/avatar', form);
      } else if (removeAvatar) {
        updated = await api.del<Me>('/api/users/@me/avatar');
      }
      dispatch('ME_UPDATE', updated);
      setAvatarFile(null);
      setRemoveAvatar(false);
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setSaving(false);
    }
  };

  const avatarSrc = preview ?? (removeAvatar ? userAvatar({ id: me.id, avatar: null }) : userAvatar(me));
  return (
    <>
      <h2 className="settings-title">Profile</h2>
      <div className="profile-editor">
        <div className="profile-editor-form">
          <Field label="Display Name">
            <TextInput value={displayNameValue} onChange={(e) => setDisplayName(e.target.value)} maxLength={32} placeholder={me.username} />
          </Field>
          <Divider />
          <div className="field">
            <div className="field-label">Avatar</div>
            <div className="button-row">
              <Button onClick={() => fileRef.current?.click()}>Change Avatar</Button>
              {(me.avatar || avatarFile) && !removeAvatar && (
                <Button
                  look="link"
                  onClick={() => {
                    setAvatarFile(null);
                    setRemoveAvatar(true);
                  }}
                >
                  Remove Avatar
                </Button>
              )}
            </div>
            <input
              ref={fileRef}
              type="file"
              accept="image/png,image/jpeg,image/gif,image/webp"
              hidden
              onChange={(e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                void cropImage(f, { shape: 'circle', title: 'Edit Profile Picture' }).then((cropped) => {
                  if (!cropped) return;
                  setAvatarFile(cropped);
                  setRemoveAvatar(false);
                });
              }}
            />
          </div>
          <Divider />
          <div className="field">
            <div className="field-label">Banner Color</div>
            <div className="color-swatches">
              <button className={`swatch default ${banner === null ? 'selected' : ''}`} onClick={() => setBanner(null)} {...tip('Default')} />
              {BANNER_PRESETS.map((c) => (
                <button key={c} className={`swatch ${banner === c ? 'selected' : ''}`} style={{ background: colorHex(c) }} onClick={() => setBanner(c)} aria-label={colorHex(c)} />
              ))}
              <label className="swatch custom" {...tip('Custom color')}>
                <input type="color" value={banner !== null ? colorHex(banner) : '#5865f2'} onChange={(e) => setBanner(parseInt(e.target.value.slice(1), 16))} />
                <Icon path={mdiPencil} size={14} />
              </label>
            </div>
          </div>
          <Divider />
          <Field label="About Me" hint={`${190 - about.length} characters left`}>
            <TextArea value={about} onChange={(e) => setAbout(e.target.value.slice(0, 190))} rows={4} placeholder="Tell people a bit about yourself" />
          </Field>
        </div>
        <div className="profile-editor-preview">
          <div className="field-label">Preview</div>
          <div className="profile-card preview">
            <div className="profile-banner" style={{ background: banner !== null ? colorHex(banner) : '#5865f2' }} />
            <div className="profile-avatar-wrap">
              <Avatar src={avatarSrc} size={80} status={me.status === 'invisible' ? 'offline' : me.status} />
            </div>
            <div className="profile-body">
              <div className="profile-names">
                <div className="profile-display">{displayNameValue || me.username}</div>
                <div className="profile-username">{me.username}</div>
              </div>
              {about && (
                <section className="profile-section">
                  <h4>About Me</h4>
                  <p className="profile-about">{about}</p>
                </section>
              )}
            </div>
          </div>
        </div>
      </div>
      {dirty && <SaveBar onReset={reset} onSave={save} saving={saving} />}
    </>
  );
}

function CharactersSection() {
  const chars = useStore(useShallow((s) => myCharacters(s)));
  const me = useStore((s) => s.me)!;

  const move = async (c: Character, dir: -1 | 1) => {
    const list = [...chars];
    const i = list.findIndex((x) => x.id === c.id);
    const j = i + dir;
    if (j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    const positions = list.map((x, idx) => ({ id: x.id, position: idx + 1 }));
    for (const p of positions) dispatch('CHARACTER_UPDATE', { ...list.find((x) => x.id === p.id)!, position: p.position });
    try {
      await api.patch('/api/users/@me/characters', positions);
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  const remove = (c: Character) =>
    openModal((close) => (
      <ConfirmModal
        title={`Retire ${c.name}?`}
        body={
          <>
            <strong>{c.name}</strong> will disappear from your character list. Old messages keep their name and picture.
          </>
        }
        confirm="Retire Character"
        onClose={close}
        onConfirm={async () => {
          await api.del(`/api/users/@me/characters/${c.id}`);
          dispatch('CHARACTER_UPDATE', { ...c, deleted: true });
        }}
      />
    ));

  return (
    <>
      <h2 className="settings-title">Characters</h2>
      <p className="settings-desc">
        Characters are extra identities you can post as, each with its own name and picture. They go with you into every server and DM. Pick who you're speaking as
        with the picture next to the message box.
      </p>
      <Button onClick={() => openModal((close) => <CharacterEditorModal onClose={close} />)}>New Character</Button>
      <Divider />
      <div className="character-list">
        <div className="character-row self">
          <img src={userAvatar(me)} alt="" />
          <div className="character-row-text">
            <div className="character-row-name">{displayName(me)}</div>
            <div className="character-row-sub">Yourself. Always first in the list.</div>
          </div>
        </div>
        {chars.map((c, i) => (
          <div key={c.id} className="character-row" style={c.color ? ({ '--char-color': calmColor(c.color) } as CSSProperties) : undefined}>
            <img src={characterAvatar(c)} alt="" className={c.color ? 'colored' : ''} />
            <div className="character-row-text">
              <div className="character-row-name" style={c.color ? { color: calmColor(c.color) } : undefined}>
                {c.name}
                {c.sheet_visibility === 'private' && (
                  <span className="character-row-lock" {...tip('Private sheet')}>
                    <Icon path={mdiLock} size={13} />
                  </span>
                )}
              </div>
              <div className="character-row-sub">
                {c.summary?.level ? <span className="character-row-summary">{summaryLine(c)}</span> : null}
                {proxyString(c) ? <code>{proxyString(c)}</code> : <span className="text-muted">No proxy tag</span>}
              </div>
            </div>
            <div className="character-row-actions">
              <Button look="gold" size="small" onClick={() => openSheet(c.id, null)}>
                Sheet
              </Button>
              <button className="icon-button" aria-label="Move up" disabled={i === 0} onClick={() => move(c, -1)} {...tip('Move up')}>
                <Icon path={mdiMenuUp} size={24} />
              </button>
              <button className="icon-button" aria-label="Move down" disabled={i === chars.length - 1} onClick={() => move(c, 1)} {...tip('Move down')}>
                <Icon path={mdiMenuDown} size={24} />
              </button>
              <Button look="secondary" size="small" onClick={() => openModal((close) => <CharacterEditorModal character={c} onClose={close} />)}>
                Edit
              </Button>
              <Button look="outline" size="small" className="btn-danger-outline" onClick={() => remove(c)}>
                Retire
              </Button>
            </div>
          </div>
        ))}
        {chars.length === 0 && (
          <div className="empty-state small">
            <Icon path={mdiDramaMasks} size={48} />
            <p>No characters yet. Make one and give them a face.</p>
          </div>
        )}
      </div>
    </>
  );
}

function ModePreview({ immersive }: { immersive: boolean }) {
  const me = useStore((s) => s.me)!;
  return (
    <div className="mode-preview">
      <div className="mode-preview-avatar">
        <Icon path={mdiDramaMasks} size={22} />
      </div>
      <div>
        <div className="mode-preview-header">
          <span className="mode-preview-name">Xargorf</span>
          {!immersive && (
            <span className="player-tag static">
              <img src={userAvatar(me)} alt="" />
              <span>{displayName(me)}</span>
            </span>
          )}
          <span className="mode-preview-time">{formatTimestamp(new Date().toISOString()).replace(/^Today at /, '')}</span>
        </div>
        <div className="mode-preview-text">
          <em>sets down a suspiciously heavy sack</em>
        </div>
      </div>
    </div>
  );
}

function RoleplaySection() {
  const settings = useStore((s) => s.me!.settings);
  return (
    <>
      <h2 className="settings-title">Roleplay</h2>
      <h3 className="settings-subtitle">Switching Characters</h3>
      <SwitchRow
        title="Character picker in the message bar"
        description="Shows who you're speaking as next to the message box. Click it to switch."
        checked={settings.switch_picker}
        onChange={(v) => updateSettings({ switch_picker: v })}
      />
      <SwitchRow
        title="Proxy tags"
        description={
          <>
            Start or wrap a message in a character's tag, like <code>x: hello</code> or <code>[hello]</code>, to send just that message as them.
          </>
        }
        checked={settings.switch_proxy}
        onChange={(v) => updateSettings({ switch_proxy: v })}
      />
      <SwitchRow
        title="Keyboard shortcut"
        description={
          <>
            <kbd>Alt</kbd> + <kbd>↑</kbd> / <kbd>↓</kbd> cycles through your characters while you're typing.
          </>
        }
        checked={settings.switch_hotkey}
        onChange={(v) => updateSettings({ switch_hotkey: v })}
      />
      <SwitchRow
        title="Remember per channel"
        description="Each channel remembers who you last spoke as. Turn this off to keep one character everywhere until you switch."
        checked={settings.switch_remember}
        onChange={(v) => updateSettings({ switch_remember: v })}
      />
      <h3 className="settings-subtitle">Who's Playing Who</h3>
      <div className="mode-cards" role="radiogroup">
        <button className={`mode-card ${!settings.immersive ? 'selected' : ''}`} role="radio" aria-checked={!settings.immersive} onClick={() => updateSettings({ immersive: false })}>
          <ModePreview immersive={false} />
          <div className="mode-card-footer">
            <span className={`radio ${!settings.immersive ? 'checked' : ''}`} />
            <div>
              <div className="mode-card-title">Puppeteer</div>
              <div className="mode-card-desc">Show the player next to every character.</div>
            </div>
          </div>
        </button>
        <button className={`mode-card ${settings.immersive ? 'selected' : ''}`} role="radio" aria-checked={settings.immersive} onClick={() => updateSettings({ immersive: true })}>
          <ModePreview immersive />
          <div className="mode-card-footer">
            <span className={`radio ${settings.immersive ? 'checked' : ''}`} />
            <div>
              <div className="mode-card-title">Immersive</div>
              <div className="mode-card-desc">Characters only. No hints about who's behind them.</div>
            </div>
          </div>
        </button>
      </div>
      <p className="settings-note">This only changes what you see. Everyone picks their own mode.</p>
      <h3 className="settings-subtitle">Messages</h3>
      <SwitchRow
        title="Formatting bar"
        description="Shows bold, italics, colours and text sizes above the message box while you type. The shortcuts (Ctrl+B, Ctrl+I, Ctrl+U) work either way."
        checked={settings.format_toolbar}
        onChange={(v) => updateSettings({ format_toolbar: v })}
      />
      <div className="settings-callout">
        <Icon path={mdiBookOpenPageVariant} size={20} />
        <p>
          <strong>Book look</strong> is the Book button in the formatting bar above the message box. Turn it on and the messages you send show as story: a box
          in your character's colour, "speech in quotes" in white and everything else as italic action. Each channel remembers your choice.
        </p>
      </div>
      <SwitchRow
        title="Book font"
        description="Shows book-look messages (yours and everyone's) in a serif typeface. Turn it off to read them in the normal font."
        checked={settings.ic_serif}
        onChange={(v) => updateSettings({ ic_serif: v })}
      />
      <h3 className="settings-subtitle">Text Effects</h3>
      <SwitchRow
        title="Animate text effects"
        description="Wave, fire, typewriter and the rest move. Turn it off and they hold still but keep their colours. Also off if your system asks for reduced motion."
        checked={settings.fx_motion}
        onChange={(v) => updateSettings({ fx_motion: v })}
      />
      <h3 className="settings-subtitle">Dice</h3>
      <SwitchRow
        title="Rolling animation"
        description="Dice tumble for a moment before landing when someone rolls. Turned off automatically if your system asks for reduced motion."
        checked={settings.dice_animations}
        onChange={(v) => updateSettings({ dice_animations: v })}
      />
      <SwitchRow title="Dice sounds" description="A quick clatter when a roll lands." checked={settings.dice_sounds} onChange={(v) => updateSettings({ dice_sounds: v })} />
    </>
  );
}

function summaryLine(c: Character): string {
  const sm = c.summary;
  if (!sm) return '';
  const cls = sm.classes && !sm.classes.includes('/') ? sm.classes.replace(/ \d+$/, '') : sm.classes;
  return [`Level ${sm.level}${cls ? ` ${cls}` : ''}`, sm.species].filter(Boolean).join(' · ');
}

export default function UserSettings({ section }: { section?: string }) {
  const [active, setActive] = useState(section ?? 'account');
  const nav: NavEntry[] = [
    { kind: 'header', label: 'User Settings' },
    { kind: 'item', id: 'account', label: 'My Account' },
    { kind: 'item', id: 'profile', label: 'Profile' },
    { kind: 'item', id: 'characters', label: 'Characters' },
    { kind: 'separator' },
    { kind: 'header', label: 'App Settings' },
    { kind: 'item', id: 'roleplay', label: 'Roleplay' },
    { kind: 'item', id: 'voice', label: 'Voice & Video' },
    { kind: 'separator' },
    {
      kind: 'item',
      id: 'logout',
      label: 'Log Out',
      danger: true,
      onClick: () =>
        openModal((close) => (
          <ConfirmModal title="Log Out" body="Are you sure you want to log out?" confirm="Log Out" onClose={close} onConfirm={() => logout()} />
        )),
    },
  ];
  return (
    <SettingsShell
      nav={nav}
      active={active}
      onSelect={setActive}
      footer={
        <span className="settings-version">
          <TavernLogo size={14} /> Tavern 2.14.1
        </span>
      }
    >
      {active === 'account' && <AccountSection goProfile={() => setActive('profile')} />}
      {active === 'profile' && <ProfileSection />}
      {active === 'characters' && <CharactersSection />}
      {active === 'roleplay' && <RoleplaySection />}
      {active === 'voice' && <VoiceSettings />}
    </SettingsShell>
  );
}
