import { useState } from 'react';
import { api, errorMessage } from '../api/http';
import { Modal } from '../components/layers';
import { toast } from '../components/Toasts';
import { Button, Field, TextArea } from '../components/ui';
import { displayName } from '../store/selectors';
import { useStore } from '../store/store';
import type { User } from '../store/types';

export function KickModal({ serverId, user, onClose }: { serverId: number; user: User; onClose: () => void }) {
  const server = useStore((s) => s.servers[serverId]);
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title={`Kick '${displayName(user)}' from Server`}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button
            look="danger"
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await api.del(`/api/servers/${serverId}/members/${user.id}`);
                onClose();
              } catch (err) {
                toast(errorMessage(err));
                setLoading(false);
              }
            }}
          >
            Kick
          </Button>
        </>
      }
    >
      <p className="modal-text">
        Are you sure you want to kick <strong>@{user.username}</strong> from <strong>{server?.name}</strong>? They will be able to rejoin again with a new invite.
      </p>
    </Modal>
  );
}

export function BanModal({ serverId, user, onClose }: { serverId: number; user: User; onClose: () => void }) {
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  return (
    <Modal
      title={`Ban '${displayName(user)}'`}
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button
            look="danger"
            loading={loading}
            onClick={async () => {
              setLoading(true);
              try {
                await api.put(`/api/servers/${serverId}/bans/${user.id}`, { reason: reason.trim() || null });
                onClose();
              } catch (err) {
                toast(errorMessage(err));
                setLoading(false);
              }
            }}
          >
            Ban
          </Button>
        </>
      }
    >
      <p className="modal-text">
        Are you sure you want to ban <strong>@{user.username}</strong>? They won't be able to rejoin with any invite until someone unbans them.
      </p>
      <Field label="Reason for Ban">
        <TextArea value={reason} onChange={(e) => setReason(e.target.value)} maxLength={512} rows={3} />
      </Field>
    </Modal>
  );
}
