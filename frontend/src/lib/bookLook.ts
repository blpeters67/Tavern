/**
 * The "book look" switch next to the message box. When it's on, what you send
 * shows as roleplay prose for everyone: a tinted box, "speech" in white,
 * everything else as italic action in your colour.
 *
 * Each channel remembers what you last picked there. Until you pick, it follows
 * who you're speaking as: on as a character, off as yourself.
 */

import { create } from 'zustand';
import { load, save } from './storage';

const useBook = create<{ byChannel: Record<number, boolean> }>(() => ({
  byChannel: load<Record<number, boolean>>('bookLook', {}),
}));

export function bookLookFor(channelId: number, inCharacter: boolean): boolean {
  return useBook.getState().byChannel[channelId] ?? inCharacter;
}

export function useBookLook(channelId: number, inCharacter: boolean): boolean {
  return useBook((s) => s.byChannel[channelId] ?? inCharacter);
}

export function setBookLook(channelId: number, on: boolean): void {
  useBook.setState((s) => {
    const byChannel = { ...s.byChannel, [channelId]: on };
    save('bookLook', byChannel);
    return { byChannel };
  });
}
