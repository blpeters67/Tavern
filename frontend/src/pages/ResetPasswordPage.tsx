import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, ApiError, errorMessage } from '../api/http';
import { Button, Field, Spinner, TextInput } from '../components/ui';
import { endSession, startSession } from '../store/actions';
import { getState } from '../store/store';
import type { Me } from '../store/types';
import AuthLayout from './AuthLayout';

export default function ResetPasswordPage() {
  const navigate = useNavigate();
  // The token lives in the URL fragment so it never reaches server logs.
  const [token] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('token') ?? '');
  const [valid, setValid] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!token) {
      setValid(false);
      return;
    }
    api
      .post<{ valid: boolean }>('/api/auth/reset/check', { token }, { quiet401: true })
      .then((d) => setValid(d.valid))
      .catch(() => setValid(false));
  }, [token]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (password !== confirm) {
      setErrors({ confirm: "Passwords don't match." });
      return;
    }
    setLoading(true);
    setErrors({});
    try {
      const res = await api.post<{ user: Me }>('/api/auth/reset', { token, password }, { quiet401: true });
      if (getState().status !== 'anonymous') endSession();
      startSession(res.user);
      navigate('/channels/@me', { replace: true });
    } catch (err) {
      if (err instanceof ApiError && err.code === 'invalid_token') setValid(false);
      else if (err instanceof ApiError && Object.keys(err.errors).length) setErrors(err.errors);
      else setErrors({ password: errorMessage(err) });
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthLayout>
      {valid === null && (
        <div className="auth-center">
          <Spinner />
        </div>
      )}
      {valid === false && (
        <div className="auth-form center">
          <h1 className="auth-title">That link didn't work</h1>
          <p className="auth-subtitle">Password reset links work once and expire after an hour. Request a fresh one from the login page.</p>
          <Link to="/login" className="btn btn-brand btn-large btn-grow">
            <span className="btn-contents">Back to Login</span>
          </Link>
        </div>
      )}
      {valid && (
        <form className="auth-form" onSubmit={submit} noValidate>
          <h1 className="auth-title">Change Your Password</h1>
          <p className="auth-subtitle">Choose a new password. This also logs you out on your other devices.</p>
          <Field label="New Password" required error={errors.password} htmlFor="new-password">
            <TextInput id="new-password" type="password" autoComplete="new-password" autoFocus value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Confirm New Password" required error={errors.confirm} htmlFor="confirm-password">
            <TextInput id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
          </Field>
          <Button type="submit" size="large" grow loading={loading}>
            Change Password
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
