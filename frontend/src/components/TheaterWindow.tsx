/** The theater's queue, library and "Find Videos" window (the jukebox window's twin). */
import { useEffect, useMemo, useRef, useState, type DragEvent, type FormEvent } from 'react';
import { api, ApiError, errorMessage, upload } from '../api/http';
import { formatDuration } from '../lib/format';
import { closeTheater, openModal, openTheater } from '../store/actions';
import { canControlTheater, displayName } from '../store/selectors';
import { getState, setState, useStore, type TheaterTab } from '../store/store';
import type { Video, VideoQueueEntry } from '../store/types';
import {
  Icon,
  mdiCheck,
  mdiClose,
  mdiCloudUpload,
  mdiDelete,
  mdiDotsHorizontal,
  mdiDragVertical,
  mdiLink,
  mdiMagnify,
  mdiMovieOpen,
  mdiPencil,
  mdiPlay,
  mdiPlaylistPlus,
  mdiRefresh,
  mdiTagOutline,
  mdiYoutube,
} from './icons';
import { ClearQueueModal } from './Jukebox';
import { MenuItem, Modal, tip } from './layers';
import { toast } from './Toasts';
import { Button, Field, Spinner, TextInput } from './ui';

const MB = 1024 * 1024;
/** The server keeps at most this many in a queue. */
const QUEUE_MAX = 500;

function lockReason(serverId: number): string {
  return getState().servers[serverId]?.roleplay_mode ? 'DM Lock is on: only Dungeon Masters can run the theater' : 'Only DJs can run the theater';
}

async function enqueue(serverId: number, videoIds: number[], where: 'end' | 'next' | 'now') {
  try {
    await api.post(`/api/servers/${serverId}/theater/queue`, { video_ids: videoIds, where });
  } catch (err) {
    toast(errorMessage(err));
  }
}

async function loadVideos(serverId: number) {
  try {
    const res = await api.get<{ videos: Video[]; search_enabled: boolean; max_video_mb: number }>(`/api/servers/${serverId}/theater/videos`);
    setState((s) => ({
      theaterLibraries: {
        ...s.theaterLibraries,
        [serverId]: {
          videos: Object.fromEntries(res.videos.map((v) => [v.id, v])),
          loaded: true,
          searchEnabled: res.search_enabled,
          maxVideoMb: res.max_video_mb,
        },
      },
    }));
  } catch (err) {
    toast(errorMessage(err));
  }
}

export function TheaterWindowHost() {
  const view = useStore((s) => s.theaterView);
  if (!view) return null;
  return <TheaterWindow serverId={view.serverId} tab={view.tab} />;
}

function TheaterWindow({ serverId, tab }: { serverId: number; tab: TheaterTab }) {
  const server = useStore((s) => s.servers[serverId]);
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const searchOn = useStore((s) => s.theaterLibraries[serverId]?.searchEnabled ?? false);
  useEffect(() => {
    void loadVideos(serverId);
  }, [serverId]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && !getState().modals.length && closeTheater();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  if (!server) return null;
  return (
    <div className="modal-root jukebox-root" onMouseDown={(e) => e.target === e.currentTarget && closeTheater()}>
      <div className="jukebox-window theater-window" role="dialog" aria-modal aria-label="Theater">
        <header className="jw-header">
          <Icon path={mdiMovieOpen} size={22} />
          <h2>Theater</h2>
          <nav className="jw-tabs">
            <button className={tab === 'queue' ? 'active' : ''} onClick={() => openTheater(serverId, 'queue')}>
              Queue
            </button>
            <button className={tab === 'library' ? 'active' : ''} onClick={() => openTheater(serverId, 'library')}>
              Library
            </button>
            {canControl && searchOn && (
              <button className={tab === 'search' ? 'active' : ''} onClick={() => openTheater(serverId, 'search')}>
                <Icon path={mdiMagnify} size={16} />
                Find Videos
              </button>
            )}
          </nav>
          {!canControl && <span className="jw-locked">{lockReason(serverId)}</span>}
          <button className="jw-close" aria-label="Close" onClick={closeTheater}>
            <Icon path={mdiClose} size={22} />
          </button>
        </header>
        <div className="jw-body scroller-thin">
          {tab === 'queue' ? <QueueTab serverId={serverId} /> : tab === 'search' && canControl ? <SearchTab serverId={serverId} /> : <LibraryTab serverId={serverId} />}
        </div>
      </div>
    </div>
  );
}

function VideoThumb({ video, width = 64 }: { video?: Video; width?: number }) {
  const height = Math.round((width * 9) / 16);
  return (
    <div className="th-thumb" style={{ width, height }}>
      {video?.thumbnail_url ? <img src={video.thumbnail_url} alt="" loading="lazy" /> : <Icon path={mdiMovieOpen} size={Math.round(height * 0.55)} />}
      {video?.kind === 'youtube' && <Icon path={mdiYoutube} size={14} className="th-thumb-yt" />}
    </div>
  );
}

function VideoRow({
  video,
  entry,
  current,
  actions,
  dragProps,
  className,
}: {
  video?: Video;
  entry?: VideoQueueEntry;
  current?: boolean;
  actions?: React.ReactNode;
  dragProps?: Record<string, unknown>;
  className?: string;
}) {
  const adder = useStore((s) => (entry?.added_by ? s.users[entry.added_by] : undefined));
  if (!video) return null;
  const processing = video.status === 'processing';
  return (
    <div className={`jw-track th-row ${current ? 'current' : ''} ${video.status !== 'ready' ? video.status : ''} ${className ?? ''}`} {...dragProps}>
      {dragProps && <Icon path={mdiDragVertical} size={18} className="jw-drag" />}
      <VideoThumb video={video} />
      <div className="jw-track-text">
        <div className="jw-track-title">
          {current && <span className="jw-now-badge">Now</span>}
          {video.live && <span className="th-live">Live</span>}
          <span className="th-row-title">{video.title}</span>
        </div>
        <div className="jw-track-sub">
          {video.channel && <span>{video.channel}</span>}
          {video.kind === 'file' && <span>Uploaded</span>}
          {video.tags.map((t) => (
            <span key={t} className="jw-tag">
              {t}
            </span>
          ))}
          {adder && <span className="jw-added">added by {displayName(adder)}</span>}
        </div>
        {processing && (
          <div className="jw-processing">
            <div className="jw-processing-bar" style={{ width: `${Math.round((video.progress ?? 0) * 100)}%` }} />
            <span>
              {video.kind === 'file'
                ? video.progress
                  ? `Preparing ${Math.round(video.progress * 100)}%`
                  : 'Preparing…'
                : video.title === 'YouTube playlist'
                  ? 'Reading the playlist…'
                  : 'Looking it up…'}
            </span>
          </div>
        )}
        {video.status === 'failed' && <div className="jw-error">{video.error ?? 'Failed'}</div>}
      </div>
      <span className="jw-duration">{video.live ? '' : video.duration_ms ? formatDuration(video.duration_ms) : ''}</span>
      <div className="jw-actions">{actions}</div>
    </div>
  );
}

function QueueTab({ serverId }: { serverId: number }) {
  const st = useStore((s) => s.theater[serverId]);
  const library = useStore((s) => s.theaterLibraries[serverId]);
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const [dragQid, setDragQid] = useState<string | null>(null);
  const [overQid, setOverQid] = useState<string | null>(null);
  if (!st) return null;
  const videoOf = (e: VideoQueueEntry) => library?.videos[e.video_id] ?? st.videos[String(e.video_id)];
  const current = st.current ? videoOf(st.current) : undefined;

  const drop = async () => {
    const from = dragQid;
    const to = overQid;
    setDragQid(null);
    setOverQid(null);
    if (!from || !to || from === to) return;
    // Dropped on a row further down: it goes after that row (so the last place can be reached).
    const all = st.queue.map((e) => e.qid);
    const down = all.indexOf(from) < all.indexOf(to);
    const qids = all.filter((q) => q !== from);
    qids.splice(qids.indexOf(to) + (down ? 1 : 0), 0, from);
    try {
      await api.put(`/api/servers/${serverId}/theater/queue`, { qids });
    } catch (err) {
      toast(errorMessage(err));
    }
  };

  return (
    <div className="jw-queue">
      <h3 className="jw-section">Now Showing</h3>
      {current ? (
        <VideoRow video={current} entry={st.current!} current />
      ) : (
        <p className="jw-muted">Nothing is showing. {canControl ? 'Add something from the Library.' : ''}</p>
      )}
      <div className="jw-section-row">
        <h3 className="jw-section">Up Next{st.queue.length ? ` — ${st.queue.length}` : ''}</h3>
        {canControl && st.queue.length > 0 && (
          <Button
            size="small"
            look="outline"
            onClick={() =>
              openModal((close) => (
                <ClearQueueModal
                  onClose={close}
                  text="Everything after the current video will be taken out of the queue. The library keeps every video."
                  onConfirm={async () => {
                    await api.del(`/api/servers/${serverId}/theater/queue`);
                  }}
                />
              ))
            }
          >
            Clear Queue
          </Button>
        )}
      </div>
      {st.queue.length === 0 && <p className="jw-muted">The queue is empty.</p>}
      <div className="jw-list">
        {st.queue.map((e) => (
          <VideoRow
            key={e.qid}
            video={videoOf(e)}
            entry={e}
            className={overQid === e.qid && dragQid !== e.qid ? 'drop-target' : ''}
            dragProps={
              canControl
                ? {
                    draggable: true,
                    onDragStart: (ev: DragEvent) => {
                      ev.dataTransfer.effectAllowed = 'move';
                      setDragQid(e.qid);
                    },
                    onDragOver: (ev: DragEvent) => {
                      ev.preventDefault();
                      if (overQid !== e.qid) setOverQid(e.qid);
                    },
                    onDrop: (ev: DragEvent) => {
                      ev.preventDefault();
                      void drop();
                    },
                    onDragEnd: () => {
                      setDragQid(null);
                      setOverQid(null);
                    },
                  }
                : undefined
            }
            actions={
              canControl && (
                <>
                  <button className="jw-action" aria-label="Play now" {...tip('Play now')} onClick={() => playQueued(serverId, e)}>
                    <Icon path={mdiPlay} size={18} />
                  </button>
                  <button
                    className="jw-action danger"
                    aria-label="Remove from queue"
                    {...tip('Remove')}
                    onClick={() => api.del(`/api/servers/${serverId}/theater/queue/${e.qid}`).catch((err) => toast(errorMessage(err)))}
                  >
                    <Icon path={mdiClose} size={18} />
                  </button>
                </>
              )
            }
          />
        ))}
      </div>
      {st.history.length > 0 && (
        <>
          <h3 className="jw-section">Recently Shown</h3>
          <div className="jw-list faded">
            {[...st.history]
              .reverse()
              .slice(0, 8)
              .map((e) => (
                <VideoRow
                  key={`h${e.qid}`}
                  video={videoOf(e)}
                  entry={e}
                  actions={
                    canControl && (
                      <button className="jw-action" aria-label="Queue again" {...tip('Queue again')} onClick={() => enqueue(serverId, [e.video_id], 'end')}>
                        <Icon path={mdiPlaylistPlus} size={18} />
                      </button>
                    )
                  }
                />
              ))}
          </div>
        </>
      )}
    </div>
  );
}

async function playQueued(serverId: number, e: VideoQueueEntry) {
  // Straight to that entry (a reorder-then-skip would be a random pick with shuffle on).
  try {
    await api.post(`/api/servers/${serverId}/theater/control`, { action: 'jump', value: e.qid });
  } catch (err) {
    toast(errorMessage(err));
  }
}

/** Uploads go one video per request: tunnels and proxies cap each request (Cloudflare's free plan at 100 MB). */
function uploadError(err: unknown, name: string): string {
  if (err instanceof ApiError && err.status === 413 && err.message === 'That upload is too big.') {
    return `${name} is too big to send through this connection. Cloudflare's free plan takes at most 100 MB per upload; YouTube links have no limit.`;
  }
  return errorMessage(err);
}

function LibraryTab({ serverId }: { serverId: number }) {
  const library = useStore((s) => s.theaterLibraries[serverId]);
  const canControl = useStore((s) => canControlTheater(s, serverId));
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | null>(null);
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState<'queue' | 'library' | null>(null);
  const [uploading, setUploading] = useState<{ index: number; count: number; progress: number } | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const videos = useMemo(() => Object.values(library?.videos ?? {}).sort((a, b) => b.id - a.id), [library]);
  const tags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const v of videos) for (const g of v.tags) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([g]) => g);
  }, [videos]);
  const q = query.trim().toLowerCase();
  const shown = videos.filter(
    (v) =>
      (!tag || v.tags.includes(tag)) &&
      (!q || v.title.toLowerCase().includes(q) || (v.channel ?? '').toLowerCase().includes(q) || v.tags.some((g) => g.toLowerCase().includes(q))),
  );

  if (!library?.loaded) {
    return (
      <div className="jw-loading">
        <Spinner />
      </div>
    );
  }

  const add = async (queue: boolean) => {
    const link = url.trim();
    if (!link || adding) return;
    setAdding(queue ? 'queue' : 'library');
    try {
      const res = await api.post<{ video: Video; existing?: boolean; playlist?: boolean }>(`/api/servers/${serverId}/theater/add`, {
        url: link,
        tags: tag ? [tag] : [],
        queue: queue ? 'end' : null,
      });
      setUrl('');
      if (res.playlist) toast(queue ? 'Reading the playlist. Its videos join the queue in a moment.' : 'Reading the playlist. Its videos show up below in a moment.', 'info');
      else if (res.existing) toast(queue ? `Queued “${res.video.title}” (it was already in the library).` : 'That one is already in the library.', 'info');
      else if (queue) toast(res.video.status === 'ready' ? `Queued “${res.video.title}”.` : 'Looking it up. It joins the queue when it’s ready.', 'success');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setAdding(null);
    }
  };

  const doUpload = async (files: FileList | null) => {
    const list = Array.from(files ?? []);
    if (fileInput.current) fileInput.current.value = '';
    if (!list.length) return;
    const limit = library.maxVideoMb * MB;
    const ok = list.filter((f) => f.size <= limit);
    for (const f of list) if (f.size > limit) toast(`${f.name} is bigger than ${library.maxVideoMb} MB.`);
    for (let i = 0; i < ok.length; i++) {
      const f = ok[i];
      setUploading({ index: i, count: ok.length, progress: 0 });
      const form = new FormData();
      form.append('files', f);
      form.append('tags', JSON.stringify(tag ? [tag] : []));
      try {
        await upload('POST', `/api/servers/${serverId}/theater/videos`, form, (p) => setUploading({ index: i, count: ok.length, progress: p })).promise;
      } catch (err) {
        toast(uploadError(err, f.name));
      }
    }
    setUploading(null);
  };

  const readyShown = shown.filter((v) => v.status === 'ready');
  const uploadLabel = uploading
    ? `Uploading${uploading.count > 1 ? ` ${uploading.index + 1} of ${uploading.count}` : ''} · ${Math.round(uploading.progress * 100)}%`
    : 'Upload Videos';

  return (
    <div className="jw-library">
      {canControl && (
        <div className="jw-add">
          <form
            className="jw-import"
            onSubmit={(e: FormEvent) => {
              e.preventDefault();
              void add(true);
            }}
          >
            <Icon path={mdiLink} size={18} />
            <input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Paste a YouTube link (playlists work too)" />
            <Button size="small" type="submit" loading={adding === 'queue'} disabled={!url.trim() || adding !== null}>
              Add to Queue
            </Button>
            <Button size="small" look="secondary" loading={adding === 'library'} disabled={!url.trim() || adding !== null} onClick={() => void add(false)}>
              Library Only
            </Button>
          </form>
          <button className="jw-upload" onClick={() => fileInput.current?.click()} disabled={uploading !== null}>
            <Icon path={mdiCloudUpload} size={20} />
            {uploadLabel}
          </button>
          <input ref={fileInput} type="file" accept="video/*,.mkv,.mov,.m4v,.avi,.wmv,.flv,.mpg,.mpeg,.ogv,.3gp,.ts" multiple hidden onChange={(e) => doUpload(e.target.files)} />
          <span className="jw-muted th-upload-note">
            Uploads can be up to {library.maxVideoMb} MB each and are converted to play everywhere. YouTube videos play straight from YouTube.
          </span>
        </div>
      )}
      <div className="jw-filter">
        <div className="search-input">
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search the library" />
          <Icon path={mdiMagnify} size={18} />
        </div>
        <div className="jw-tags">
          <button className={`jw-tag-chip ${tag === null ? 'on' : ''}`} onClick={() => setTag(null)}>
            All
          </button>
          {tags.map((g) => (
            <button key={g} className={`jw-tag-chip ${tag === g ? 'on' : ''}`} onClick={() => setTag(tag === g ? null : g)}>
              <Icon path={mdiTagOutline} size={13} />
              {g}
            </button>
          ))}
        </div>
        {canControl && readyShown.length > 1 && (
          <Button size="small" look="secondary" onClick={() => enqueue(serverId, readyShown.map((v) => v.id).reverse().slice(0, QUEUE_MAX), 'end')}>
            Queue all {Math.min(readyShown.length, QUEUE_MAX)}
          </Button>
        )}
      </div>
      {videos.length === 0 && (
        <div className="jw-empty">
          <Icon path={mdiMovieOpen} size={36} />
          <p>The library is empty.{canControl ? ' Paste a YouTube link, find a video, or upload one to get started.' : ''}</p>
        </div>
      )}
      <div className="jw-list">
        {shown.map((v) => (
          <VideoRow
            key={v.id}
            video={v}
            actions={
              canControl && (
                <>
                  {v.status === 'ready' && (
                    <>
                      <button className="jw-action" aria-label="Play now" {...tip('Play now')} onClick={() => enqueue(serverId, [v.id], 'now')}>
                        <Icon path={mdiPlay} size={18} />
                      </button>
                      <button className="jw-action" aria-label="Add to queue" {...tip('Add to queue')} onClick={() => enqueue(serverId, [v.id], 'end')}>
                        <Icon path={mdiPlaylistPlus} size={18} />
                      </button>
                    </>
                  )}
                  <VideoMenuButton serverId={serverId} video={v} />
                </>
              )
            }
          />
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Find Videos: search YouTube
// ---------------------------------------------------------------------------

interface SearchResult {
  id: string;
  title: string;
  channel: string | null;
  duration_ms: number | null;
  url: string;
  thumbnail: string;
  video_id: number | null;
  video_status: string | null;
}

/** The last search per server, so switching tabs doesn't lose it. */
const lastSearch: Record<number, { q: string; results: SearchResult[] }> = {};

function SearchTab({ serverId }: { serverId: number }) {
  const library = useStore((s) => s.theaterLibraries[serverId]);
  const [q, setQ] = useState(() => lastSearch[serverId]?.q ?? '');
  const [results, setResults] = useState<SearchResult[] | null>(() => lastSearch[serverId]?.results ?? null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [done, setDone] = useState<Record<string, 'queue' | 'library'>>({});
  const input = useRef<HTMLInputElement>(null);
  const haveIds = useMemo(() => {
    const ids = new Set<string>();
    for (const v of Object.values(library?.videos ?? {})) if (v.youtube_id && v.status !== 'failed') ids.add(v.youtube_id);
    return ids;
  }, [library]);

  useEffect(() => input.current?.focus(), []);

  const search = async (e?: FormEvent) => {
    e?.preventDefault();
    const query = q.trim();
    if (!query || loading) return;
    setLoading(true);
    try {
      const res = await api.get<{ results: SearchResult[] }>(`/api/servers/${serverId}/theater/search?q=${encodeURIComponent(query)}`);
      setResults(res.results);
      lastSearch[serverId] = { q: query, results: res.results };
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const add = async (r: SearchResult, queue: boolean) => {
    setBusy(`${r.id}:${queue ? 'queue' : 'library'}`);
    try {
      const res = await api.post<{ video: Video; existing?: boolean }>(`/api/servers/${serverId}/theater/add`, {
        url: r.url,
        title: r.title,
        channel: r.channel,
        duration_ms: r.duration_ms || null,
        queue: queue ? 'end' : null,
      });
      setDone((d) => ({ ...d, [r.id]: queue ? 'queue' : 'library' }));
      if (queue) toast(res.video.status === 'ready' ? `Queued “${res.video.title}”.` : `Looking up “${r.title}”. It joins the queue when it’s ready.`, 'success');
      else toast(res.existing ? 'That one is already in the library.' : `Added “${r.title}” to the library.`, 'info');
    } catch (err) {
      toast(errorMessage(err));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="jw-search">
      <form className="jw-search-form" onSubmit={search}>
        <div className="search-input">
          <input ref={input} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search YouTube for trailers, scenes, music videos…" maxLength={200} />
          <Icon path={mdiMagnify} size={18} />
        </div>
        <Button type="submit" loading={loading} disabled={!q.trim()}>
          Search
        </Button>
      </form>
      {results === null && !loading && (
        <div className="jw-empty">
          <Icon path={mdiMagnify} size={36} />
          <p>Find a video on YouTube, then add it to the queue or keep it in the library.</p>
        </div>
      )}
      {loading && !results && (
        <div className="jw-loading">
          <Spinner />
        </div>
      )}
      {results && results.length === 0 && !loading && (
        <div className="jw-empty">
          <p>Nothing found. Try other words.</p>
        </div>
      )}
      {results && results.length > 0 && (
        <div className={`jw-results ${loading ? 'stale' : ''}`}>
          {results.map((r) => {
            const inLibrary = haveIds.has(r.id) || r.video_id !== null || done[r.id] !== undefined;
            const queued = done[r.id] === 'queue';
            return (
              <div key={r.id} className="jw-result">
                <a className="jw-result-thumb" href={r.url} target="_blank" rel="noreferrer noopener" {...tip('Open on YouTube')}>
                  <img src={r.thumbnail} alt="" loading="lazy" />
                  {r.duration_ms ? <span className="jw-result-time">{formatDuration(r.duration_ms)}</span> : null}
                </a>
                <div className="jw-result-text">
                  <div className="jw-result-title" title={r.title}>
                    {r.title}
                  </div>
                  <div className="jw-result-sub">
                    {r.channel}
                    {inLibrary && <span className="jw-result-have">In library</span>}
                  </div>
                </div>
                <div className="jw-result-actions">
                  <Button size="small" onClick={() => add(r, true)} loading={busy === `${r.id}:queue`} className={queued ? 'done' : ''}>
                    <Icon path={queued ? mdiCheck : mdiPlaylistPlus} size={16} />
                    {queued ? 'Queued' : 'Add to Queue'}
                  </Button>
                  <Button size="small" look="secondary" onClick={() => add(r, false)} loading={busy === `${r.id}:library`} disabled={inLibrary}>
                    {inLibrary ? 'In Library' : 'Add to Library'}
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function VideoMenuButton({ serverId, video }: { serverId: number; video: Video }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="jw-menu-wrap">
      <button className="jw-action" aria-label="More" onClick={() => setOpen((v) => !v)}>
        <Icon path={mdiDotsHorizontal} size={18} />
      </button>
      {open && (
        <div className="menu jw-menu" onMouseLeave={() => setOpen(false)}>
          {video.status === 'ready' && <MenuItem label="Play Next" onClick={() => (setOpen(false), void enqueue(serverId, [video.id], 'next'))} />}
          <MenuItem
            label="Edit Details"
            icon={mdiPencil}
            onClick={() => {
              setOpen(false);
              openModal((close) => <VideoEditModal serverId={serverId} video={video} onClose={close} />);
            }}
          />
          {video.status === 'failed' && video.kind === 'youtube' && video.youtube_id && (
            <MenuItem
              label="Try Again"
              icon={mdiRefresh}
              onClick={() => {
                setOpen(false);
                api.post(`/api/servers/${serverId}/theater/videos/${video.id}/retry`).catch((err) => toast(errorMessage(err)));
              }}
            />
          )}
          {video.source_url && (
            <MenuItem label="Open on YouTube" icon={mdiYoutube} onClick={() => (setOpen(false), window.open(video.source_url!, '_blank', 'noopener'))} />
          )}
          <MenuItem
            label="Delete from Library"
            danger
            icon={mdiDelete}
            onClick={() => {
              setOpen(false);
              api.del(`/api/servers/${serverId}/theater/videos/${video.id}`).catch((err) => toast(errorMessage(err)));
            }}
          />
        </div>
      )}
    </div>
  );
}

function VideoEditModal({ serverId, video, onClose }: { serverId: number; video: Video; onClose: () => void }) {
  const [title, setTitle] = useState(video.title);
  const [tags, setTags] = useState(video.tags.join(', '));
  const [saving, setSaving] = useState(false);
  const save = async () => {
    setSaving(true);
    try {
      await api.patch(`/api/servers/${serverId}/theater/videos/${video.id}`, {
        title,
        tags: tags
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onClose();
    } catch (err) {
      toast(errorMessage(err));
      setSaving(false);
    }
  };
  return (
    <Modal
      title="Edit Video"
      onClose={onClose}
      footer={
        <>
          <Button look="link" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={save} loading={saving} disabled={!title.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="track-edit">
        <VideoThumb video={video} width={160} />
        <div className="track-edit-fields">
          <Field label="Title">
            <TextInput value={title} onChange={(e) => setTitle(e.target.value)} maxLength={200} />
          </Field>
          <Field label="Tags" hint="Comma separated, like Trailer, Session 3, Cutscene">
            <TextInput value={tags} onChange={(e) => setTags(e.target.value)} />
          </Field>
        </div>
      </div>
    </Modal>
  );
}
