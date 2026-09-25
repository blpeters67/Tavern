import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, errorMessage } from '../api/http';
import { Icon, mdiCardAccountDetailsOutline, mdiCheck, mdiEye, mdiImage, mdiLock } from '../components/icons';
import { bookVars } from '../components/Message';
import { Modal, tip } from '../components/layers';
import { Button, Field, TextInput } from '../components/ui';
import { characterAvatar, defaultCharacterAvatar } from '../lib/avatars';
import { formatTimestamp } from '../lib/format';
import { openSheet } from '../store/actions';
import { dispatch, getState, useStore } from '../store/store';
import type { Character } from '../store/types';
import { cropImage } from '../components/ImageCropper';

const NAME_COLORS = ['#e0b252', '#f0a35e', '#f47b7b', '#e879b9', '#b48cf2', '#8fa6ff', '#7aa2f7', '#5ccfe6', '#5fd3a1', '#a3d977', '#d8c9a7', '#c9d1de'];

export function proxyString(c: Pick<Character, 'proxy_prefix' | 'proxy_suffix'>): string {
  return c.proxy_prefix || c.proxy_suffix ? `${c.proxy_prefix ?? ''}text${c.proxy_suffix ?? ''}` : '';
}

/** Create or edit a character: name, picture and proxy tag. */
export function CharacterEditorModal({ character, onClose }: { character?: Character; onClose: () => void }) {
  const me = useStore((s) => s.me)!;
  const settings = me.settings;
  const [name, setName] = useState(character?.name ?? '');
  const [proxy, setProxy] = useState(character ? proxyString(character) : '');
  const [file, setFile] = useState<File | null>(null);
  const [removeAvatar, setRemoveAvatar] = useState(false);
  const [color, setColor] = useState<string | null>(character?.color ?? null);
  const [visibility, setVisibility] = useState<'public' | 'private'>(character?.sheet_visibility ?? 'public');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const preview = useMemo(() => (file ? URL.createObjectURL(file) : null), [file]);
  useEffect(() => () => void (preview && URL.revokeObjectURL(preview)), [preview]);

  const avatar = preview ?? (character && !removeAvatar ? characterAvatar({ ...character, name: name || character.name }) : defaultCharacterAvatar(character?.id ?? me.id, name || '?'));

  // Show what a proxied message would look like.
  const example = useMemo(() => {
    const m = /^(.*)text(.*)$/i.exec(proxy.trim());
    if (!m) return null;
    const prefix = m[1].trimEnd();
    const suffix = m[2].trimStart();
    const needsSpace = /[\p{L}\p{N}]$/u.test(prefix);
    return `${prefix}${needsSpace ? ' ' : ''}Hello there!${suffix}`;
  }, [proxy]);

  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    setLoading(true);
    setErrors({});
    const form = new FormData();
    form.append('name', name);
    if (proxy.trim()) form.append('proxy', proxy.trim());
    else if (character) form.append('clear_proxy', 'true');
    if (file) form.append('avatar', file);
    else if (removeAvatar) form.append('remove_avatar', 'true');
    if (color) form.append('color', color);
    else if (character?.color) form.append('clear_color', 'true');
    form.append('sheet_visibility', visibility);
    try {
      const saved = character
        ? await api.patch<Character>(`/api/users/@me/characters/${character.id}`, form)
        : await api.post<Character>('/api/users/@me/characters', form);
      dispatch(character ? 'CHARACTER_UPDATE' : 'CHARACTER_CREATE', saved);
      onClose();
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) setErrors(err.errors);
      else setErrors({ name: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <Modal
      title={character ? 'Edit Character' : 'New Character'}
      onClose={onClose}
      className="character-modal"
      size="medium"
      footer={
        <>
          {character && (
            <Button
              look="outline"
              className="character-sheet-button"
              onClick={() => {
                const s = getState();
                const serverId = s.activeChannelId ? (s.channels[s.activeChannelId]?.server_id ?? null) : null;
                onClose();
                openSheet(character.id, serverId);
              }}
            >
              <Icon path={mdiCardAccountDetailsOutline} size={16} /> Character Sheet
            </Button>
          )}
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => submit()} loading={loading} disabled={!name.trim()}>
            {character ? 'Save' : 'Create Character'}
          </Button>
        </>
      }
    >
      <form className="character-form" onSubmit={submit}>
        <div className="character-form-avatar">
          <button type="button" className="avatar-upload" onClick={() => fileRef.current?.click()} aria-label="Change picture">
            <img src={avatar} alt="" />
            <span className="avatar-upload-overlay">
              <Icon path={mdiImage} size={20} />
              Change
              <br />
              Picture
            </span>
          </button>
          {(file || (character?.avatar && !removeAvatar)) && (
            <button
              type="button"
              className="link-button subtle"
              onClick={() => {
                setFile(null);
                setRemoveAvatar(true);
              }}
            >
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
              void cropImage(f, { shape: 'circle', title: 'Edit Character Picture' }).then((cropped) => {
                if (!cropped) return;
                setFile(cropped);
                setRemoveAvatar(false);
              });
            }}
          />
        </div>
        <div className="character-form-fields">
          <Field label="Name" required error={errors.name}>
            <TextInput autoFocus value={name} onChange={(e) => setName(e.target.value)} maxLength={80} placeholder="Xargorf the Unwashed" />
          </Field>
          <Field
            label="Proxy Tag"
            error={errors.proxy}
            hint={
              <>
                Optional. Write <code>text</code> where your message goes, like <code>x:text</code> or <code>[text]</code>.
              </>
            }
          >
            <TextInput value={proxy} onChange={(e) => setProxy(e.target.value)} maxLength={70} placeholder="x:text" spellCheck={false} />
          </Field>
          <Field label="Name Colour" error={errors.color} hint="Colours their name, the edge of their messages and their spoken lines.">
            <div className="name-colors">
              <button type="button" className={`name-color default ${color === null ? 'on' : ''}`} onClick={() => setColor(null)} {...tip('Default')}>
                {color === null && <Icon path={mdiCheck} size={14} />}
              </button>
              {NAME_COLORS.map((c) => (
                <button key={c} type="button" className={`name-color ${color === c ? 'on' : ''}`} style={{ background: c }} aria-label={c} onClick={() => setColor(c)}>
                  {color === c && <Icon path={mdiCheck} size={14} />}
                </button>
              ))}
              <label className={`name-color custom ${color && !NAME_COLORS.includes(color) ? 'on' : ''}`} {...tip('Pick any colour')} style={color && !NAME_COLORS.includes(color) ? { background: color } : undefined}>
                <input type="color" value={color ?? '#e0b252'} onChange={(e) => setColor(e.target.value.toLowerCase())} aria-label="Custom colour" />
                <span>+</span>
              </label>
            </div>
          </Field>
          <Field label="Character Sheet">
            <div className="sheet-visibility" role="radiogroup">
              <button type="button" role="radio" aria-checked={visibility === 'public'} className={visibility === 'public' ? 'on' : ''} onClick={() => setVisibility('public')}>
                <Icon path={mdiEye} size={16} />
                <span>
                  <b>Public</b>
                  <small>Anyone in your servers can open it.</small>
                </span>
              </button>
              <button type="button" role="radio" aria-checked={visibility === 'private'} className={visibility === 'private' ? 'on' : ''} onClick={() => setVisibility('private')}>
                <Icon path={mdiLock} size={16} />
                <span>
                  <b>Private</b>
                  <small>Only you and the Dungeon Masters.</small>
                </span>
              </button>
            </div>
          </Field>
        </div>
      </form>
      <div className="field-label">Preview</div>
      <div className="character-preview">
        <div className={`message group-start ic book ${settings.ic_serif ? 'serif' : ''}`} style={bookVars(color)}>
          <div className="message-contents">
            <img className="message-avatar" src={avatar} alt="" />
            <h3 className="message-header">
              <span className="message-name">{name || 'Your character'}</span>
              <time className="message-timestamp">{formatTimestamp(new Date().toISOString())}</time>
            </h3>
            <div className="message-body">
              <span className="rp-action">{name ? `${name.split(' ')[0]} raises a tankard.` : 'They raise a tankard.'} </span>
              <span className="rp-speech">"Hello there!"</span>
            </div>
          </div>
        </div>
        {example && (
          <div className="character-preview-hint">
            Typing <code>{example}</code> sends that line as <strong>{name || 'this character'}</strong>.
          </div>
        )}
      </div>
    </Modal>
  );
}
