import { useEffect, type ReactNode } from 'react';
import { Navigate, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { LayerHosts } from './components/layers';
import { Toasts } from './components/Toasts';
import AppShell from './pages/AppShell';
import InvitePage from './pages/InvitePage';
import LoginPage from './pages/LoginPage';
import RegisterPage from './pages/RegisterPage';
import ResetPasswordPage from './pages/ResetPasswordPage';
import { bootstrap, setNavigate } from './store/actions';
import { useStore } from './store/store';

function RequireAuth({ children }: { children: ReactNode }) {
  const status = useStore((s) => s.status);
  const location = useLocation();
  if (status === 'anonymous') {
    const redirect = encodeURIComponent(location.pathname + location.search);
    return <Navigate to={`/login?redirect=${redirect}`} replace />;
  }
  return <>{children}</>;
}

export default function App() {
  const status = useStore((s) => s.status);
  const navigate = useNavigate();

  useEffect(() => {
    setNavigate((to, opts) => navigate(to, opts));
  }, [navigate]);

  useEffect(() => {
    void bootstrap();
  }, []);

  if (status === 'loading') return <div className="boot" />;

  return (
    <>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route path="/register" element={<RegisterPage />} />
        <Route path="/reset-password" element={<ResetPasswordPage />} />
        <Route path="/invite/:code" element={<InvitePage />} />
        <Route
          path="/channels/*"
          element={
            <RequireAuth>
              <AppShell />
            </RequireAuth>
          }
        />
        <Route path="*" element={<Navigate to={status === 'anonymous' ? '/login' : '/channels/@me'} replace />} />
      </Routes>
      <LayerHosts />
      <Toasts />
    </>
  );
}
