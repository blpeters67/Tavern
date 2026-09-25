import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/http';
import { Modal } from '../components/layers';
import { Button, Field, TextInput } from '../components/ui';
import { openModal, startSession } from '../store/actions';
import { useStore } from '../store/store';
import type { Me } from '../store/types';
import AuthLayout from './AuthLayout';

function safeRedirect(raw: string | null): string {
  if (raw && raw.startsWith('/') && !raw.startsWith('//')) return raw;
  return '/channels/@me';
}

export default function LoginPage() {
  const status = useStore((s) => s.status);
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const redirect = safeRedirect(params.get('redirect'));
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [setupRequired, setSetupRequired] = useState(false);

  useEffect(() => {
    api
      .get<{ setup_required: boolean }>('/api/auth/status', { quiet401: true })
      .then((d) => setSetupRequired(d.setup_required))
      .catch(() => undefined);
  }, []);

  if (status === 'ready' || status === 'connecting') return <Navigate to={redirect} replace />;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setErrors({});
    try {
      const res = await api.post<{ user: Me }>('/api/auth/login', { login, password }, { quiet401: true });
      startSession(res.user);
      navigate(redirect, { replace: true });
    } catch (err) {
      if (err instanceof ApiError && Object.keys(err.errors).length) setErrors(err.errors);
      else setErrors({ login: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  const forgot = async () => {
    if (!login.trim()) {
      setErrors({ login: 'Enter your email or username first.' });
      return;
    }
    try {
      const res = await api.post<{ email_enabled: boolean }>('/api/auth/forgot', { login }, { quiet401: true });
      openModal((close) => (
        <Modal
          title="Instructions sent"
          onClose={close}
          centered
          footer={
            <Button onClick={close} grow>
              Okay
            </Button>
          }
        >
          <p className="modal-text center">
            If an account matches <strong>{login}</strong>, we sent it a link to reset the password. Check both your inbox and spam folder.
            {!res.email_enabled && (
              <>
                <br />
                <br />
                <span className="text-muted">Email isn't set up on this server yet, so the link was printed in the server log instead. Ask whoever runs Tavern.</span>
              </>
            )}
          </p>
        </Modal>
      ));
    } catch (err) {
      setErrors({ login: errorMessage(err) });
    }
  };

  return (
    <AuthLayout>
      <form className="auth-form" onSubmit={submit} noValidate>
        <h1 className="auth-title">Welcome back!</h1>
        <p className="auth-subtitle">We're so excited to see you again!</p>

        {setupRequired && (
          <div className="auth-notice">
            Nobody has an account yet. Open the <strong>setup link</strong> printed in the server log to create the owner account.
          </div>
        )}

        <Field label="Email or Username" required error={errors.login} htmlFor="login">
          <TextInput id="login" autoComplete="username" autoFocus value={login} onChange={(e) => setLogin(e.target.value)} />
        </Field>
        <Field label="Password" required error={errors.password} htmlFor="password" className="field-tight">
          <TextInput id="password" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button type="button" className="link-button auth-forgot" onClick={forgot}>
          Forgot your password?
        </button>
        <Button type="submit" size="large" grow loading={loading}>
          Log In
        </Button>
        <div className="auth-switch">
          <span>Need an account?</span>{' '}
          <Link to={setupRequired ? '/register' : '/register'} className="link">
            Register
          </Link>
        </div>
      </form>
    </AuthLayout>
  );
}
