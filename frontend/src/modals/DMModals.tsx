import { useMemo, useState } from 'react';
import { Icon, mdiClose } from '../components/icons';
import { Modal } from '../components/layers';
import { Avatar, Button } from '../components/ui';
import { userAvatar } from '../lib/avatars';
import { openDM } from '../store/actions';
import { displayName } from '../store/selectors';
import { useStore } from '../store/store';

const MAX_GROUP = 9;

export function CreateDMModal({ onClose }: { onClose: () => void }) {
  const users = useStore((s) => s.users);
  const me = useStore((s) => s.me)!;
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<number[]>([]);
  const [loading, setLoading] = useState(false);

  const people = useMemo(() => {
    const q = query.trim().toLowerCase();
    return Object.values(users)
      .filter((u) => u.id !== me.id)
      .filter((u) => !q || u.username.includes(q) || displayName(u).toLowerCase().includes(q))
      .sort((a, b) => displayName(a).localeCompare(displayName(b)));
  }, [users, me.id, query]);

  const toggle = (id: number) =>
    setPicked((cur) => (cur.includes(id) ? cur.filter((x) => x !== id) : cur.length >= MAX_GROUP ? cur : [...cur, id]));

  const create = async () => {
    if (!picked.length) return;
    setLoading(true);
    await openDM(picked);
    setLoading(false);
    onClose();
  };

  return (
    <Modal
      title="Select People"
      subtitle={picked.length >= MAX_GROUP ? 'This group has a 10 member limit.' : `You can add ${MAX_GROUP - picked.length} more ${MAX_GROUP - picked.length === 1 ? 'person' : 'people'}.`}
      onClose={onClose}
      className="create-dm-modal"
      footer={
        <Button grow onClick={create} loading={loading} disabled={!picked.length}>
          {picked.length > 1 ? 'Create Group DM' : 'Create DM'}
        </Button>
      }
    >
      <div className="dm-picker-search">
        {picked.map((id) => (
          <button key={id} className="dm-chip" onClick={() => toggle(id)}>
            {displayName(users[id])}
            <Icon path={mdiClose} size={12} />
          </button>
        ))}
        <input
          autoFocus
          value={query}
          placeholder={picked.length ? '' : 'Type the username of a friend'}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && picked.length) setPicked(picked.slice(0, -1));
            if (e.key === 'Enter' && people[0]) toggle(people[0].id);
          }}
        />
      </div>
      <div className="dm-picker-list scroller-thin">
        {people.length === 0 && <div className="dm-picker-empty">No one found. You can message anyone you share a server with.</div>}
        {people.map((u) => {
          const on = picked.includes(u.id);
          return (
            <button key={u.id} className={`dm-picker-row ${on ? 'on' : ''}`} onClick={() => toggle(u.id)}>
              <Avatar src={userAvatar(u)} size={32} status={u.status} />
              <span className="dm-picker-name">{displayName(u)}</span>
              <span className="dm-picker-username">{u.username}</span>
              <span className={`checkbox ${on ? 'checked' : ''}`} />
            </button>
          );
        })}
      </div>
    </Modal>
  );
}
