import { create } from 'zustand';
import { Icon, mdiAlertCircle, mdiCheckCircle, mdiInformation } from './icons';

interface Toast {
  id: number;
  text: string;
  kind: 'error' | 'info' | 'success';
}

const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));
let seq = 1;

export function toast(text: string, kind: Toast['kind'] = 'error') {
  const id = seq++;
  useToasts.setState((s) => ({ list: [...s.list.filter((t) => t.text !== text), { id, text, kind }].slice(-3) }));
  window.setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), kind === 'error' ? 5000 : 3000);
}

const ICONS = { error: mdiAlertCircle, info: mdiInformation, success: mdiCheckCircle };

export function Toasts() {
  const list = useToasts((s) => s.list);
  if (!list.length) return null;
  return (
    <div className="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} className={`toast toast-${t.kind}`}>
          <Icon path={ICONS[t.kind]} size={18} />
          <span>{t.text}</span>
        </div>
      ))}
    </div>
  );
}
