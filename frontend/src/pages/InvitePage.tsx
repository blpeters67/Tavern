import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, errorMessage } from '../api/http';
import { Button, Spinner } from '../components/ui';
import { toast } from '../components/Toasts';
import { serverIcon } from '../lib/avatars';
import { acronym } from '../lib/format';
import { acceptInvite } from '../store/actions';
import { displayName } from '../store/selectors';
import { useStore } from '../store/store';
import type { InviteInfo } from '../store/types';
import AuthLayout from './AuthLayout';

export default function InvitePage() {
  const { code = '' } = useParams();
  const navigate = useNavigate();
  const status = useStore((s) => s.status);
  const servers = useStore((s) => s.servers);
  const [invite, setInvite] = useState<InviteInfo | null>(null);
  const [failed, setFailed] = useState(false);
  const [joining, setJoining] = useState(false);

  useEffect(() => {
    api
      .get<InviteInfo>(`/api/invites/${encodeURIComponent(code)}`, { quiet401: true })
      .then(setInvite)
      .catch(() => setFailed(true));
  }, [code]);

  const loggedIn = status === 'ready' || status === 'connecting';
  const already = invite && servers[invite.server.id];

  const accept = async () => {
    if (!invite) return;
    if (!loggedIn) {
      navigate(`/register?invite=${encodeURIComponent(code)}`);
      return;
    }
    if (already) {
      navigate(`/channels/${invite.server.id}`);
      return;
    }
    setJoining(true);
    try {
      await acceptInvite(code);
    } catch (err) {
      toast(errorMessage(err));
      setJoining(false);
    }
  };

  const icon = invite ? serverIcon(invite.server.icon) : null;

  return (
    <AuthLayout className="auth-box-invite">
      {!invite && !failed && (
        <div className="auth-center">
          <Spinner />
        </div>
      )}
      {failed && (
        <div className="auth-form center">
          <h1 className="auth-title">Invite Invalid</h1>
          <p className="auth-subtitle">This invite may be expired, or it might have run out of uses. Ask for a new one.</p>
          <Button size="large" grow onClick={() => navigate(loggedIn ? '/channels/@me' : '/login')}>
            Continue to Tavern
          </Button>
        </div>
      )}
      {invite && (
        <div className="auth-form center">
          <div className="auth-invite-icon big">{icon ? <img src={icon} alt="" /> : <span>{acronym(invite.server.name)}</span>}</div>
          <div className="auth-subtitle">{invite.inviter ? `${displayName(invite.inviter)} invited you to join` : "You've been invited to join"}</div>
          <h1 className="auth-title">{invite.server.name}</h1>
          <div className="invite-counts">
            <span>
              <i className="dot online" />
              {invite.online_count} Online
            </span>
            <span>
              <i className="dot" />
              {invite.member_count} {invite.member_count === 1 ? 'Member' : 'Members'}
            </span>
          </div>
          <Button size="large" grow loading={joining} onClick={accept}>
            {already ? 'Open Server' : loggedIn ? 'Accept Invite' : 'Accept Invite'}
          </Button>
          {!loggedIn && (
            <div className="auth-switch">
              <Link to={`/login?redirect=${encodeURIComponent(`/invite/${code}`)}`} className="link">
                Already have an account?
              </Link>
            </div>
          )}
        </div>
      )}
    </AuthLayout>
  );
}
