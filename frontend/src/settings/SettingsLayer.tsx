import { useEffect, useState, type ReactNode } from 'react';
import { Icon, mdiArrowLeft, mdiClose } from '../components/icons';
import { Button } from '../components/ui';
import { closeSettings } from '../store/actions';
import { getState, type SettingsTarget } from '../store/store';
import ChannelSettings from './ChannelSettings';
import ServerSettings from './ServerSettings';
import UserSettings from './UserSettings';

export type NavEntry =
  | { kind: 'header'; label: string }
  | { kind: 'item'; id: string; label: string; danger?: boolean; onClick?: () => void }
  | { kind: 'separator' };

export function SettingsShell({
  nav,
  active,
  onSelect,
  children,
  footer,
}: {
  nav: NavEntry[];
  active: string;
  onSelect: (id: string) => void;
  children: ReactNode;
  footer?: ReactNode;
}) {
  // On phones the sidebar and the page take turns filling the screen.
  const [mobilePage, setMobilePage] = useState(false);
  return (
    <div className={`settings-layer ${mobilePage ? 'mobile-page' : ''}`} role="dialog" aria-modal>
      <div className="settings-sidebar-region scroller-thin">
        <nav className="settings-sidebar">
          {nav.map((entry, i) => {
            if (entry.kind === 'header')
              return (
                <div key={i} className="settings-nav-header">
                  {entry.label}
                </div>
              );
            if (entry.kind === 'separator') return <div key={i} className="settings-nav-separator" />;
            return (
              <button
                key={entry.id}
                className={`settings-nav-item ${active === entry.id ? 'selected' : ''} ${entry.danger ? 'danger' : ''}`}
                onClick={() => {
                  if (entry.onClick) entry.onClick();
                  else {
                    onSelect(entry.id);
                    setMobilePage(true);
                  }
                }}
              >
                {entry.label}
              </button>
            );
          })}
          {footer && <div className="settings-nav-footer">{footer}</div>}
        </nav>
      </div>
      <div className="settings-content-region">
        <div className="settings-content scroller-auto">
          <button className="settings-back" onClick={() => setMobilePage(false)}>
            <Icon path={mdiArrowLeft} size={20} /> Back
          </button>
          <div className="settings-content-inner">{children}</div>
          <div className="settings-close">
            <button className="settings-close-button" onClick={closeSettings} aria-label="Close settings">
              <Icon path={mdiClose} size={18} />
            </button>
            <span className="settings-close-hint">ESC</span>
          </div>
        </div>
      </div>
    </div>
  );
}

/** The "Careful — you have unsaved changes!" bar. */
export function SaveBar({ onReset, onSave, saving }: { onReset: () => void; onSave: () => void; saving?: boolean }) {
  return (
    <div className="save-bar" role="region" aria-label="Unsaved changes">
      <span className="save-bar-text">Careful — you have unsaved changes!</span>
      <div className="save-bar-actions">
        <Button look="link" size="small" onClick={onReset}>
          Reset
        </Button>
        <Button look="green" size="small" onClick={onSave} loading={saving}>
          Save Changes
        </Button>
      </div>
    </div>
  );
}

export default function SettingsLayer({ target }: { target: SettingsTarget }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const s = getState();
      if (s.modals.length || s.contextMenu) return;
      if ((e.target as HTMLElement).closest?.('.popout')) return;
      closeSettings();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);

  if (target.kind === 'user') return <UserSettings section={target.section} />;
  if (target.kind === 'server') return <ServerSettings serverId={target.id} section={target.section} />;
  return <ChannelSettings channelId={target.id} section={target.section} />;
}
