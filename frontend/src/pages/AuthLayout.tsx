import type { ReactNode } from 'react';
import { TavernLogo } from '../components/icons';

export default function AuthLayout({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className="auth-page">
      <div className="auth-bg" aria-hidden />
      <div className="auth-wordmark" aria-hidden>
        <TavernLogo size={30} />
        <span>Tavern</span>
      </div>
      <div className={`auth-box ${className ?? ''}`}>{children}</div>
    </div>
  );
}
