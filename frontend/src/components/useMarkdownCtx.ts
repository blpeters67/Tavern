import { useMemo } from 'react';
import type { MarkdownContext } from '../lib/markdown';
import { channelPath, go } from '../store/actions';
import { getState } from '../store/store';
import { openCharacterProfile, openUserProfile } from './Profiles';

/**
 * Click handlers for mentions in rendered markdown. The same object for as
 * long as the server stays the same: mentions look their names up themselves,
 * so nothing here changes when users, roles or channels do.
 */
export function useMarkdownCtx(serverId: number | null): MarkdownContext {
  return useMemo<MarkdownContext>(
    () => ({
      onUser: (e, id) => openUserProfile((e.currentTarget as HTMLElement).getBoundingClientRect(), id, serverId),
      onCharacter: (e, id) => openCharacterProfile((e.currentTarget as HTMLElement).getBoundingClientRect(), id, serverId),
      onChannel: (id) => {
        const c = getState().channels[id];
        if (c) go(channelPath(c));
      },
    }),
    [serverId],
  );
}
