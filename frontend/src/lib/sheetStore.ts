/**
 * Loading and editing character sheets. Sheets live in the store (s.sheets)
 * and stay live through CHARACTER_SHEET_UPDATE events. Edits are JSON Merge
 * Patches (RFC 7396): they apply locally at once, then go to the server one
 * request at a time per character, with edits made meanwhile folded into a
 * single follow-up patch. Lists on the sheet are keyed maps (id -> entry), so
 * two people editing different items never clobber each other.
 */

import { useEffect, useState } from 'react';
import { api, errorMessage } from '../api/http';
import { toast } from '../components/Toasts';
import { getState, setState, useStore, type SheetEntry } from '../store/store';
import { mergePatch, type Sheet } from './sheet';

interface SheetResponse {
  character_id: number;
  sheet: Sheet;
  can_edit: boolean;
}

const inflight = new Map<number, Promise<SheetEntry | null>>();

function store(characterId: number, entry: SheetEntry) {
  setState((s) => ({ sheets: { ...s.sheets, [characterId]: entry } }));
}

/** Fetch a sheet (cached unless stale or forced). Null if you can't see it. */
export function loadSheet(characterId: number, force = false): Promise<SheetEntry | null> {
  const cached = getState().sheets[characterId];
  if (cached && !cached.stale && !force) return Promise.resolve(cached);
  let p = inflight.get(characterId);
  if (!p) {
    p = api
      .get<SheetResponse>(`/api/characters/${characterId}/sheet`)
      .then((r) => {
        const entry: SheetEntry = { sheet: r.sheet, canEdit: r.can_edit };
        // Keep optimistic local edits that haven't reached the server yet.
        const q = queues.get(characterId);
        if (q?.pending) entry.sheet = mergePatch(entry.sheet, q.pending);
        store(characterId, entry);
        return entry;
      })
      .finally(() => inflight.delete(characterId));
    inflight.set(characterId, p);
  }
  return p;
}

/**
 * The live sheet for a character, loading it on first use (and again if it
 * went stale). `error` is set if it couldn't be loaded (e.g. it's private).
 */
export function useSheet(characterId: number | null | undefined): { entry: SheetEntry | undefined; error: string | null } {
  const entry = useStore((s) => (characterId ? s.sheets[characterId] : undefined));
  const [error, setError] = useState<string | null>(null);
  const stale = !!entry?.stale;
  useEffect(() => {
    if (!characterId) return;
    if (entry && !stale) return;
    let cancelled = false;
    setError(null);
    loadSheet(characterId, stale).catch((err) => {
      if (!cancelled) setError(errorMessage(err));
    });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [characterId, stale, !entry]);
  return { entry, error };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

type Patch = Record<string, unknown>;

interface Queue {
  sending: boolean;
  /** Local edits not yet sent (already applied to the store). */
  pending: Patch | null;
}

const queues = new Map<number, Queue>();

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Fold patch b into patch a so that applying the result == applying a then b. */
export function composePatches(a: Patch, b: Patch): Patch {
  const out: Patch = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (isObj(v) && isObj(out[k])) out[k] = composePatches(out[k] as Patch, v);
    else out[k] = v;
  }
  return out;
}

/**
 * Change a sheet. `patch` is a merge patch: set a key to change it, to null
 * to remove it, nest objects to reach deeper (e.g. {hp: {current: 7}} or
 * {inventory: {[id]: null}}). Arrays are replaced whole.
 */
export function patchSheet(characterId: number, patch: Patch): void {
  const entry = getState().sheets[characterId];
  if (!entry) return;
  if (!entry.canEdit) {
    toast("You can't edit this sheet.");
    return;
  }
  store(characterId, { ...entry, sheet: mergePatch(entry.sheet, patch) });
  let q = queues.get(characterId);
  if (!q) queues.set(characterId, (q = { sending: false, pending: null }));
  q.pending = q.pending ? composePatches(q.pending, patch) : patch;
  if (!q.sending) void flush(characterId);
}

/** Whether a character has edits still on their way to the server. */
export function sheetSaving(characterId: number): boolean {
  const q = queues.get(characterId);
  return !!q && (q.sending || !!q.pending);
}

async function flush(characterId: number): Promise<void> {
  const q = queues.get(characterId);
  if (!q || q.sending || !q.pending) return;
  const patch = q.pending;
  q.pending = null;
  q.sending = true;
  try {
    const r = await api.patch<SheetResponse>(`/api/characters/${characterId}/sheet`, { patch });
    const cur = getState().sheets[characterId];
    // Someone else's newer edit may already be here via the gateway; only
    // take the server copy if it's at least as new as what we hold.
    if (!cur || cur.sheet.rev <= r.sheet.rev) {
      const sheet = q.pending ? mergePatch(r.sheet, q.pending) : r.sheet;
      store(characterId, { sheet, canEdit: r.can_edit });
    }
  } catch (err) {
    toast(errorMessage(err));
    q.pending = null;
    // Resync with the server's copy so the sheet doesn't lie.
    loadSheet(characterId, true).catch(() => undefined);
  } finally {
    q.sending = false;
    if (q.pending) void flush(characterId);
  }
}
