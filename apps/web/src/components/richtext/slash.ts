/**
 * "/" slash-command extension for the Tiptap editor.
 *
 * The item list is not written here – it is derived from BLOCKS (blocks.ts), so
 * the slash menu, the bubble menu and the block handle can never offer
 * different sets of blocks. Uses @tiptap/suggestion (same primitive as
 * mention.ts); the menu UI is the React <SlashMenu>, mounted through
 * ReactRenderer and positioned manually from the caret rect (no tippy dep).
 */
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { Extension, ReactRenderer, type Editor } from '@tiptap/react';
import { SlashMenu, type SlashItem, type SlashMenuRef } from './SlashMenu';
import { BLOCKS, applyBlockType } from './blocks';
import { translate as t } from '../../lib/i18n';

/**
 * Built per keystroke rather than once at module load: the labels are
 * translated, and the active locale can change while the app is running.
 */
function slashItems(onImage: (editor: Editor) => void): SlashItem[] {
  return BLOCKS.map((b) => ({
    title: t(b.labelKey),
    hint: t(b.hintKey),
    icon: b.icon,
    // Match the translated name too, so "/таб" finds the table in Ukrainian.
    aliases: [...b.aliases, t(b.labelKey).toLowerCase()],
    command: ({ editor, range }) => {
      editor.chain().focus().deleteRange(range).run();
      applyBlockType(editor, b.key, () => onImage(editor));
    },
  }));
}

function filterItems(items: SlashItem[], query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter(
    (item) => item.title.toLowerCase().includes(q) || (item.aliases ?? []).some((a) => a.includes(q)),
  );
}

/** Position the ReactRenderer element (fixed) from the current caret rect. */
function place(el: HTMLElement, rect: DOMRect | null): void {
  if (!rect) {
    el.style.display = 'none';
    return;
  }
  el.style.display = 'block';
  const width = el.offsetWidth || 260;
  const height = el.offsetHeight || 320;
  let left = rect.left;
  let top = rect.bottom + 6;
  if (left + width > window.innerWidth - 8) left = Math.max(8, window.innerWidth - width - 8);
  if (top + height > window.innerHeight - 8) top = Math.max(8, rect.top - height - 6);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

type SlashSuggestion = Omit<SuggestionOptions<SlashItem>, 'editor'>;

function buildSuggestion(onImage: (editor: Editor) => void): SlashSuggestion {
  return {
    char: '/',
    // Only trigger at the start of a block or after whitespace so URLs (http://…)
    // and mid-word slashes don't pop the menu. Also skip inside code blocks.
    allow: ({ state, range }) => {
      const $from = state.doc.resolve(range.from);
      if ($from.parent.type.spec.code) return false;
      if ($from.parentOffset === 0) return true;
      const charBefore = $from.parent.textBetween(
        Math.max(0, $from.parentOffset - 1),
        $from.parentOffset,
        undefined,
        ' ',
      );
      return /\s/.test(charBefore);
    },
    items: ({ query }) => filterItems(slashItems(onImage), query),
    command: ({ editor, range, props }) => {
      (props as unknown as SlashItem).command({ editor, range });
    },
    render: () => {
      let renderer: ReactRenderer<SlashMenuRef> | null = null;

      const runItem = (props: SuggestionProps<SlashItem>) => (item: SlashItem) => props.command(item as unknown as never);

      return {
        onStart: (props) => {
          renderer = new ReactRenderer(SlashMenu, {
            editor: props.editor as Editor,
            props: { items: props.items, command: runItem(props) },
          });
          const el = renderer.element as HTMLElement;
          el.style.position = 'fixed';
          el.style.zIndex = '60';
          document.body.appendChild(el);
          place(el, props.clientRect?.() ?? null);
        },
        onUpdate: (props) => {
          renderer?.updateProps({ items: props.items, command: runItem(props) });
          if (renderer) place(renderer.element as HTMLElement, props.clientRect?.() ?? null);
        },
        onKeyDown: (props: SuggestionKeyDownProps) => {
          if (props.event.key === 'Escape') {
            renderer?.destroy();
            renderer?.element.remove();
            renderer = null;
            return true;
          }
          return renderer?.ref?.onKeyDown(props) ?? false;
        },
        onExit: () => {
          renderer?.element.remove();
          renderer?.destroy();
          renderer = null;
        },
      };
    },
  };
}

export interface SlashCommandOptions {
  /** Asked for an image url; RichEditor supplies the prompt UI. */
  onImage: (editor: Editor) => void;
}

export const SlashCommand = Extension.create<SlashCommandOptions>({
  name: 'slashCommand',
  addOptions() {
    return { onImage: () => {} };
  },
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...buildSuggestion(this.options.onImage) })];
  },
});
