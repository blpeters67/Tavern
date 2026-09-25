import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, Navigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/http';
import { Button, Field, TextInput } from '../components/ui';
import { serverIcon } from '../lib/avatars';
import { acronym } from '../lib/format';
import { startSession } from '../store/actions';
import { useStore } from '../store/store';
import type { InviteInfo, Me } from '../store/types';
import AuthLayout from './AuthLayout';

export default function RegisterPage() {
  const status = useStore((s) => s.status);
  const [params] = useSearchParams();
  const setupCode = params.get('setup');
  const [form, setForm] = useState({ email: '', display_name: '', username: '', password: '', invite: params.get('invite') ?? setupCode ?? '' });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [setupRequired, setSetupRequired] = useState(!!setupCode);
  const target = useRef('/channels/@me');

  useEffect(() => {
    api
      .get<{ setup_required: boolean }>('/api/auth/status', { quiet401: true })
      .then((d) => setSetupRequired(d.setup_required))
      .catch(() => undefined);
  }, []);

  const inviteFromUrl = params.get('invite');
  useEffect(() => {
    if (!inviteFromUrl) return;
    api
      .get<InviteInfo>(`/api/invites/${encodeURIComponent(inviteFromUrl)}`, { quiet401: true })
      .then(setInvite)
      .catch(() => setErrors((e) => ({ ...e, invite: 'This invite is invalid or has expired.' })));
  }, [inviteFromUrl]);

  if (status === 'ready' || status === 'connecting') return <Navigate to={target.current} replace />;

  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) => setForm({ ...form, [key]: e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrors({});
    try {
      const res = await api.post<{ user: Me; server_id: number | null }>('/api/auth/register', form, { quiet401: true });
      // Where to land once the session starts (the <Navigate> above does the move).
      target.current = res.server_id ? `/channels/${res.server_id}` : '/channels/@me';
      startSession(res.user);
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) setErrors(err.errors);
      else setErrors({ email: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const icon = invite ? serverIcon(invite.server.icon) : null;

  return (
    <AuthLayout className="auth-box-register">
      <form className="auth-form" onSubmit={submit} noValidate>
        {invite ? (
          <div className="auth-invite-head">
            <div className="auth-invite-icon">{icon ? <img src={icon} alt="" /> : <span>{acronym(invite.server.name)}</span>}</div>
            <div className="auth-subtitle">You've been invited to join</div>
            <h1 className="auth-title">{invite.server.name}</h1>
          </div>
        ) : (
          <h1 className="auth-title">{setupRequired ? 'Set up your Tavern' : 'Create an account'}</h1>
        )}
        {setupRequired && !invite && <p className="auth-subtitle">This first account will own the place. You'll make your first server next.</p>}

        <Field label="Email" required error={errors.email} htmlFor="email">
          <TextInput id="email" type="email" autoComplete="email" autoFocus value={form.email} onChange={set('email')} />
        </Field>
        <Field label="Display Name" error={errors.display_name} htmlFor="display_name" hint="This is how others see you. You can use special characters and emoji.">
          <TextInput id="display_name" autoComplete="nickname" value={form.display_name} onChange={set('display_name')} maxLength={32} />
        </Field>
        <Field
          label="Username"
          required
          error={errors.username}
          htmlFor="username"
          hint="Lowercase letters, numbers, underscores and periods."
        >
          <TextInput id="username" autoComplete="username" value={form.username} onChange={set('username')} maxLength={32} />
        </Field>
        <Field label="Password" required error={errors.password} htmlFor="password">
          <TextInput id="password" type="password" autoComplete="new-password" value={form.password} onChange={set('password')} />
        </Field>
        {!invite && (
          <Field
            label={setupRequired ? 'Setup Code' : 'Invite Link'}
            required
            error={errors.invite}
            htmlFor="invite"
            hint={setupRequired ? 'Printed in the server log the first time Tavern starts.' : 'Tavern is invite-only. Paste the invite link a friend sent you.'}
          >
            <TextInput id="invite" value={form.invite} onChange={set('invite')} placeholder={setupRequired ? 'A1B2C3D4' : 'https://…/invite/AbCd1234'} />
          </Field>
        )}
        {invite && errors.invite && <div className="auth-error">{errors.invite}</div>}

        <Button type="submit" size="large" grow loading={loading} className="auth-submit">
          {invite ? 'Continue' : 'Create Account'}
        </Button>
        <div className="auth-switch">
          <Link to={inviteFromUrl ? `/login?redirect=${encodeURIComponent(`/invite/${inviteFromUrl}`)}` : '/login'} className="link">
            Already have an account?
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
