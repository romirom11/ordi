/**
 * "/" slash-command extension for the Tiptap editor.
 * Uses @tiptap/suggestion (same primitive as mention.ts) to open a floating
 * command menu. The menu UI is the React <SlashMenu>, mounted through
 * ReactRenderer and positioned manually from the caret rect (no tippy dep).
 */
import Suggestion, { type SuggestionOptions, type SuggestionProps, type SuggestionKeyDownProps } from '@tiptap/suggestion';
import { Extension, ReactRenderer, type Editor } from '@tiptap/react';
import {
  Type,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  TextQuote,
  SquareCode,
  Minus,
} from 'lucide-react';
import { SlashMenu, type SlashItem, type SlashMenuRef } from './SlashMenu';

const SLASH_ITEMS: SlashItem[] = [
  {
    title: 'Text',
    hint: 'Plain paragraph',
    icon: Type,
    aliases: ['paragraph', 'p', 'body'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setParagraph().run(),
  },
  {
    title: 'Heading 1',
    hint: 'Large section heading',
    icon: Heading1,
    aliases: ['h1', 'title', 'big'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 1 }).run(),
  },
  {
    title: 'Heading 2',
    hint: 'Medium section heading',
    icon: Heading2,
    aliases: ['h2', 'subtitle'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 2 }).run(),
  },
  {
    title: 'Heading 3',
    hint: 'Small section heading',
    icon: Heading3,
    aliases: ['h3'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setNode('heading', { level: 3 }).run(),
  },
  {
    title: 'Bullet list',
    hint: 'Unordered list',
    icon: List,
    aliases: ['ul', 'unordered', 'bullet'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBulletList().run(),
  },
  {
    title: 'Numbered list',
    hint: 'Ordered list',
    icon: ListOrdered,
    aliases: ['ol', 'ordered', 'number'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleOrderedList().run(),
  },
  {
    title: 'To-do list',
    hint: 'Checkbox task list',
    icon: ListChecks,
    aliases: ['todo', 'task', 'checkbox', 'check'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleTaskList().run(),
  },
  {
    title: 'Quote',
    hint: 'Capture a quotation',
    icon: TextQuote,
    aliases: ['blockquote', 'citation'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleBlockquote().run(),
  },
  {
    title: 'Code block',
    hint: 'Formatted code snippet',
    icon: SquareCode,
    aliases: ['code', 'pre', 'snippet'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).toggleCodeBlock().run(),
  },
  {
    title: 'Divider',
    hint: 'Horizontal rule',
    icon: Minus,
    aliases: ['hr', 'rule', 'separator', 'line'],
    command: ({ editor, range }) => editor.chain().focus().deleteRange(range).setHorizontalRule().run(),
  },
];

function filterItems(query: string): SlashItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return SLASH_ITEMS;
  return SLASH_ITEMS.filter(
    (item) =>
      item.title.toLowerCase().includes(q) || (item.aliases ?? []).some((a) => a.includes(q)),
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

const suggestion: SlashSuggestion = {
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
  items: ({ query }) => filterItems(query),
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

export const SlashCommand = Extension.create({
  name: 'slashCommand',
  addProseMirrorPlugins() {
    return [Suggestion({ editor: this.editor, ...suggestion })];
  },
});
