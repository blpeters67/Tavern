/**
 * Text effects in the message box (TipTap). Effects ride on the textStyle
 * mark next to colour and size, so they serialise as [text]{#color large wave}
 * (lib/richtext.ts). A small plugin numbers the letters of effect text so the
 * box shows a live preview while you type.
 */
import { Extension } from '@tiptap/core';
import type { Mark, MarkType } from '@tiptap/pm/model';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { needsLetters, parseEffects, rand, toggleEffect } from './textEffects';

declare module '@tiptap/core' {
  interface Commands<ReturnType> {
    textEffects: {
      /** Add an effect to the selection (or to what you type next), or take it off if it's all there already. */
      toggleTextEffect: (id: string) => ReturnType;
      /** Remove every effect from the selection (colour and size stay). */
      clearTextEffects: () => ReturnType;
    };
  }
}

/** Effects of the text at the cursor or across the selection (the ones all of it has). */
export function effectsInSelection(state: import('@tiptap/pm/state').EditorState): string[] {
  const type = state.schema.marks.textStyle;
  if (!type) return [];
  const { from, to, empty } = state.selection;
  if (empty) return effectsOf(state.storedMarks ?? state.selection.$from.marks(), type);
  let common: string[] | null = null;
  state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mine = effectsOf(node.marks, type);
    common = common === null ? mine : common.filter((e) => mine.includes(e));
  });
  return common ?? [];
}

function effectsOf(marks: readonly Mark[], type: MarkType): string[] {
  return parseEffects(marks.find((m) => m.type === type)?.attrs.effects);
}

function styleAttrs(marks: readonly Mark[], type: MarkType, effects: string[]): Record<string, unknown> | null {
  const attrs: Record<string, unknown> = { ...(marks.find((m) => m.type === type)?.attrs ?? {}), effects: effects.length ? effects.join(' ') : null };
  return Object.values(attrs).some((v) => v !== null && v !== undefined && v !== '') ? attrs : null;
}

const segmenter = typeof Intl !== 'undefined' && 'Segmenter' in Intl ? new Intl.Segmenter(undefined, { granularity: 'grapheme' }) : null;
const MAX_PREVIEW_LETTERS = 1500;

export const TextEffects = Extension.create({
  name: 'textEffects',

  addGlobalAttributes() {
    return [
      {
        types: ['textStyle'],
        attributes: {
          effects: {
            default: null,
            parseHTML: (element) => element.getAttribute('data-fx'),
            renderHTML: (attributes) => {
              const list = parseEffects(attributes.effects);
              if (!list.length) return {};
              return { 'data-fx': list.join(' '), class: ['fx', ...list.map((e) => `fx-${e}`)].join(' ') };
            },
          },
        },
      },
    ];
  },

  addCommands() {
    return {
      toggleTextEffect:
        (id: string) =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks.textStyle;
          if (!type) return false;
          const { from, to, empty } = state.selection;
          if (empty) {
            const marks = state.storedMarks ?? state.selection.$from.marks();
            const current = effectsOf(marks, type);
            const attrs = styleAttrs(marks, type, toggleEffect(current, id, !current.includes(id)));
            if (dispatch) {
              const others = marks.filter((m) => m.type !== type);
              tr.setStoredMarks(attrs ? [...others, type.create(attrs)] : others);
            }
            return true;
          }
          let all = true;
          state.doc.nodesBetween(from, to, (node) => {
            if (node.isText && !effectsOf(node.marks, type).includes(id)) all = false;
          });
          if (dispatch) {
            state.doc.nodesBetween(from, to, (node, pos) => {
              if (!node.isText) return;
              const start = Math.max(pos, from);
              const end = Math.min(pos + node.nodeSize, to);
              const attrs = styleAttrs(node.marks, type, toggleEffect(effectsOf(node.marks, type), id, !all));
              if (attrs) tr.addMark(start, end, type.create(attrs));
              else tr.removeMark(start, end, type);
            });
          }
          return true;
        },
      clearTextEffects:
        () =>
        ({ state, tr, dispatch }) => {
          const type = state.schema.marks.textStyle;
          if (!type) return false;
          const { from, to, empty } = state.selection;
          if (!dispatch) return true;
          if (empty) {
            const marks = state.storedMarks ?? state.selection.$from.marks();
            const attrs = styleAttrs(marks, type, []);
            const others = marks.filter((m) => m.type !== type);
            tr.setStoredMarks(attrs ? [...others, type.create(attrs)] : others);
            return true;
          }
          state.doc.nodesBetween(from, to, (node, pos) => {
            if (!node.isText) return;
            const start = Math.max(pos, from);
            const end = Math.min(pos + node.nodeSize, to);
            const attrs = styleAttrs(node.marks, type, []);
            if (attrs) tr.addMark(start, end, type.create(attrs));
            else tr.removeMark(start, end, type);
          });
          return true;
        },
    };
  },

  addProseMirrorPlugins() {
    return [
      new Plugin({
        key: new PluginKey('textEffectsPreview'),
        props: {
          decorations(state) {
            const decos: Decoration[] = [];
            let run: string | null = null;
            let i = 0;
            let letters = 0;
            state.doc.descendants((node, pos) => {
              if (!node.isText) {
                if (node.isInline) run = null;
                return;
              }
              const raw = node.marks.find((m) => m.type.name === 'textStyle')?.attrs.effects as string | null | undefined;
              const effects = parseEffects(raw);
              if (!effects.length || !needsLetters(effects) || letters > MAX_PREVIEW_LETTERS) {
                run = null;
                return;
              }
              const key = effects.join(' ');
              if (key !== run) {
                run = key;
                i = 0;
              }
              const text = node.text ?? '';
              const parts = segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : Array.from(text);
              let offset = 0;
              for (const g of parts) {
                if (!/^\s$/.test(g)) {
                  decos.push(Decoration.inline(pos + offset, pos + offset + g.length, { class: 'fx-ch', style: `--i:${i};--r:${rand(i).toFixed(3)}` }));
                  i++;
                  letters++;
                }
                offset += g.length;
              }
            });
            return decos.length ? DecorationSet.create(state.doc, decos) : DecorationSet.empty;
          },
        },
      }),
    ];
  },
});
