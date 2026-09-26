/** Per-browser layout choices for the right-hand panel: which cards are folded up. */
import { create } from 'zustand';
import { load, save } from './storage';

export type CardName = 'jukebox' | 'theater' | 'board';

const usePanelPrefs = create<Record<CardName, boolean>>(() => load<Record<CardName, boolean>>('collapsedCards', { jukebox: false, theater: false, board: false }));

/** Is this card folded up (the eye is closed)? */
export function useCollapsed(name: CardName): boolean {
  return usePanelPrefs((s) => !!s[name]);
}

export function setCollapsed(name: CardName, collapsed: boolean): void {
  usePanelPrefs.setState({ [name]: collapsed } as Partial<Record<CardName, boolean>>);
  save('collapsedCards', usePanelPrefs.getState());
}

export function isCollapsed(name: CardName): boolean {
  return !!usePanelPrefs.getState()[name];
}
