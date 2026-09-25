import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, errorMessage } from '../api/http';
import { jumpToMessage } from '../store/actions';
import { channelTitle, displayName } from '../store/selectors';
import { getState, setState, useStore } from '../store/store';
import type { Channel, Message } from '../store/types';
import ChannelIcon from './ChannelIcon';
import { Icon, mdiClose, mdiMagnify } from './icons';
import { tip } from './layers';
import { MessageItem } from './Message';
import { Spinner } from './ui';

const PAGE = 25;

interface Parsed {
  text: string;
  authorId?: number;
  channelId?: number;
  has?: 'image' | 'file' | 'roll';
  problems: string[];
}

/** Split Discord-style filters (from:, in:, has:) out of the search text. */
function parseQuery(raw: string, serverId: number | null): Parsed {
  const s = getState();
  const out: Parsed = { text: '', problems: [] };
  const words: string[] = [];
  const re = /(from|in|has):(?:"([^"]+)"|(\S+))|("[^"]*"|\S+)/gi;
  for (const m of raw.matchAll(re)) {
    if (!m[1]) {
      words.push(m[4]);
      continue;
    }
    const key = m[1].toLowerCase();
    const value = (m[2] ?? m[3] ?? '').replace(/^[@#]/, '');
    const lower = value.toLowerCase();
    if (key === 'from') {
      const user = Object.values(s.users).find((u) => u.username.toLowerCase() === lower || displayName(u).toLowerCase() === lower);
      if (user) out.authorId = user.id;
      else out.problems.push(`No one called "${value}"`);
    } else if (key === 'in') {
      const channel = Object.values(s.channels).find((c) => c.server_id === serverId && (c.name ?? '').toLowerCase() === lower);
      if (channel) out.channelId = channel.id;
      else out.problems.push(`No channel called "${value}"`);
    } else if (key === 'has') {
      if (lower === 'image' || lower === 'file' || lower === 'roll') out.has = lower;
      else if (lower === 'link') words.push('http');
      else out.problems.push('has: can be image, file or roll');
    }
  }
  out.text = words.join(' ').trim();
  return out;
}

/** The search field in the chat header. Results show in the right-hand panel. */
export function SearchBox({ channel }: { channel: Channel }) {
  const panel = useStore((s) => s.rightPanel);
  const active = panel.kind === 'search';
  const [value, setValue] = useState(active ? panel.query : '');
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!active) setValue('');
  }, [active]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const q = value.trim();
    if (!q) return;
    setState({
      rightPanel: { kind: 'search', query: q, serverId: channel.server_id, channelId: channel.server_id ? null : channel.id },
      memberListOpen: true,
      mobileMembersOpen: true,
    });
  };
  const clear = () => {
    setValue('');
    setState({ rightPanel: { kind: 'members' } });
    input.current?.blur();
  };

  const where = channel.server_id ? (getState().servers[channel.server_id]?.name ?? 'server') : channelTitle(getState(), channel);
  return (
    <form className={`search-box ${value || active ? 'filled' : ''}`} onSubmit={submit} role="search">
      <input
        ref={input}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => e.key === 'Escape' && clear()}
        placeholder="Search"
        aria-label={`Search ${where}`}
        maxLength={200}
      />
      {value || active ? (
        <button type="button" className="search-box-icon clear" aria-label="Clear search" onClick={clear}>
          <Icon path={mdiClose} size={16} />
        </button>
      ) : (
        <span className="search-box-icon" aria-hidden>
          <Icon path={mdiMagnify} size={16} />
        </span>
      )}
    </form>
  );
}

/** Search results, shown in place of the member list. */
export function SearchResults({ query, serverId, channelId }: { query: string; serverId: number | null; channelId: number | null }) {
  const [results, setResults] = useState<Message[] | null>(null);
  const [total, setTotal] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const parsed = parseQuery(query, serverId);
  const key = `${query}|${serverId}|${channelId}`;

  const fetchPage = async (offset: number): Promise<{ total: number; messages: Message[] } | null> => {
    const params = new URLSearchParams();
    if (parsed.text) params.set('q', parsed.text);
    if (parsed.channelId) params.set('channel_id', String(parsed.channelId));
    else if (channelId) params.set('channel_id', String(channelId));
    else if (serverId) params.set('server_id', String(serverId));
    if (parsed.authorId) params.set('author_id', String(parsed.authorId));
    if (parsed.has) params.set('has', parsed.has);
    params.set('limit', String(PAGE));
    params.set('offset', String(offset));
    return api.get<{ total: number; messages: Message[] }>(`/api/search?${params}`);
  };

  useEffect(() => {
    let alive = true;
    setResults(null);
    setError(null);
    if (parsed.problems.length) {
      setError(parsed.problems.join('. ') + '.');
      setResults([]);
      return;
    }
    fetchPage(0).then(
      (r) => {
        if (!alive || !r) return;
        setResults(r.messages);
        setTotal(r.total);
      },
      (err) => {
        if (!alive) return;
        setError(errorMessage(err));
        setResults([]);
      },
    );
    return () => {
      alive = false;
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps

  const more = async () => {
    if (!results) return;
    setLoadingMore(true);
    try {
      const r = await fetchPage(results.length);
      if (r) setResults([...results, ...r.messages]);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setLoadingMore(false);
    }
  };

  const close = () => setState({ rightPanel: { kind: 'members' } });

  return (
    <div className="search-results">
      <header className="search-results-header">
        <span className="search-results-count">
          {results === null ? 'Searching…' : `${total.toLocaleString()} ${total === 1 ? 'Result' : 'Results'}`}
        </span>
        <button className="search-results-close" aria-label="Close search" {...tip('Close Search', 'left')} onClick={close}>
          <Icon path={mdiClose} size={18} />
        </button>
      </header>
      <div className="search-results-hint">
        Try <code>from:name</code>, <code>in:channel</code>, <code>has:image</code> or <code>has:roll</code>.
      </div>
      {results === null && (
        <div className="search-results-empty">
          <Spinner size={28} />
        </div>
      )}
      {error && <div className="search-results-error">{error}</div>}
      {results && results.length === 0 && !error && (
        <div className="search-results-empty">
          <Icon path={mdiMagnify} size={40} />
          <p>Nothing matched. Try fewer or different words.</p>
        </div>
      )}
      {results?.map((m, i) => {
        const channel = getState().channels[m.channel_id];
        const showChannel = !!channel && (i === 0 || results[i - 1].channel_id !== m.channel_id);
        return (
          <div key={m.id} className="search-result">
            {showChannel && channel && (
              <div className="search-result-channel">
                <ChannelIcon channel={channel} size={14} />
                {channelTitle(getState(), channel)}
              </div>
            )}
            <div className="search-result-card">
              <MessageItem message={m} groupStart preview />
              <button className="search-result-jump" onClick={() => void jumpToMessage(m.channel_id, m.id)}>
                Jump
              </button>
            </div>
          </div>
        );
      })}
      {results && results.length < total && (
        <button className="search-results-more" onClick={more} disabled={loadingMore}>
          {loadingMore ? 'Loading…' : 'Show More'}
        </button>
      )}
    </div>
  );
}
