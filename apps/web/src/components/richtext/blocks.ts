/**
 * Every block the editor can produce, in one table.
 *
 * The slash menu, the bubble menu's "turn into" list and the block handle's
 * menu all read from here, so a new block type appears in all three at once and
 * cannot be reachable from one but not the others – which is how an editor ends
 * up feeling half-finished.
 */
import type { Editor } from '@tiptap/react';
import {
  AlignCenter, AlignLeft, AlignRight, ChevronRight, Code, Heading1, Heading2, Heading3,
  Image as ImageIcon, Info, List, ListChecks, ListOrdered, Minus, Table as TableIcon,
  TextQuote, Type,
  type LucideIcon,
} from 'lucide-react';

export type BlockKey =
  | 'paragraph' | 'h1' | 'h2' | 'h3'
  | 'bulletList' | 'orderedList' | 'taskList'
  | 'blockquote' | 'callout' | 'toggle'
  | 'codeBlock' | 'table' | 'divider' | 'image';

export interface BlockDef {
  key: BlockKey;
  icon: LucideIcon;
  /** i18n key for the name shown in every menu. */
  labelKey: string;
  /** i18n key for the one-line hint the slash menu shows under the name. */
  hintKey: string;
  /** Extra search terms for the slash menu, latin and cyrillic. */
  aliases: readonly string[];
  /** True for blocks an existing paragraph can be converted into. */
  turnInto?: boolean;
}

export const BLOCKS: readonly BlockDef[] = [
  { key: 'paragraph', icon: Type, labelKey: 'editor.block.text', hintKey: 'editor.hint.text', aliases: ['p', 'paragraph', 'текст', 'абзац'], turnInto: true },
  { key: 'h1', icon: Heading1, labelKey: 'editor.block.h1', hintKey: 'editor.hint.h1', aliases: ['h1', 'title', 'заголовок'], turnInto: true },
  { key: 'h2', icon: Heading2, labelKey: 'editor.block.h2', hintKey: 'editor.hint.h2', aliases: ['h2', 'підзаголовок'], turnInto: true },
  { key: 'h3', icon: Heading3, labelKey: 'editor.block.h3', hintKey: 'editor.hint.h3', aliases: ['h3'], turnInto: true },
  { key: 'bulletList', icon: List, labelKey: 'editor.block.bullet', hintKey: 'editor.hint.bullet', aliases: ['ul', 'bullet', 'список'], turnInto: true },
  { key: 'orderedList', icon: ListOrdered, labelKey: 'editor.block.ordered', hintKey: 'editor.hint.ordered', aliases: ['ol', 'number', 'нумерований'], turnInto: true },
  { key: 'taskList', icon: ListChecks, labelKey: 'editor.block.task', hintKey: 'editor.hint.task', aliases: ['todo', 'task', 'checkbox', 'чеклист', 'задачі'], turnInto: true },
  { key: 'blockquote', icon: TextQuote, labelKey: 'editor.block.quote', hintKey: 'editor.hint.quote', aliases: ['quote', 'цитата'], turnInto: true },
  { key: 'callout', icon: Info, labelKey: 'editor.block.callout', hintKey: 'editor.hint.callout', aliases: ['callout', 'note', 'info', 'виноска', 'нотатка'], turnInto: true },
  { key: 'toggle', icon: ChevronRight, labelKey: 'editor.block.toggle', hintKey: 'editor.hint.toggle', aliases: ['toggle', 'details', 'collapse', 'спойлер', 'згорнути'], turnInto: true },
  { key: 'codeBlock', icon: Code, labelKey: 'editor.block.code', hintKey: 'editor.hint.code', aliases: ['code', 'pre', 'snippet', 'код'], turnInto: true },
  { key: 'table', icon: TableIcon, labelKey: 'editor.block.table', hintKey: 'editor.hint.table', aliases: ['table', 'grid', 'таблиця'] },
  { key: 'divider', icon: Minus, labelKey: 'editor.block.divider', hintKey: 'editor.hint.divider', aliases: ['hr', 'rule', 'divider', 'розділювач', 'лінія'] },
  { key: 'image', icon: ImageIcon, labelKey: 'editor.block.image', hintKey: 'editor.hint.image', aliases: ['image', 'picture', 'photo', 'зображення', 'картинка'] },
];

/** The subset offered as "turn into" – blocks that replace a paragraph in place. */
export const TURN_INTO: readonly BlockDef[] = BLOCKS.filter((b) => b.turnInto);

/**
 * Apply a block type at the selection. `onImage` is asked for a url when the
 * image block is chosen, because prompting belongs to the UI, not here.
 */
export function applyBlockType(editor: Editor, key: BlockKey, onImage?: () => void): void {
  const chain = editor.chain().focus();
  switch (key) {
    case 'h1': chain.setNode('heading', { level: 1 }).run(); break;
    case 'h2': chain.setNode('heading', { level: 2 }).run(); break;
    case 'h3': chain.setNode('heading', { level: 3 }).run(); break;
    case 'bulletList': chain.toggleBulletList().run(); break;
    case 'orderedList': chain.toggleOrderedList().run(); break;
    case 'taskList': chain.toggleTaskList().run(); break;
    case 'blockquote': chain.toggleBlockquote().run(); break;
    case 'callout': chain.toggleCallout().run(); break;
    case 'toggle': chain.toggleToggleBlock().run(); break;
    case 'codeBlock': chain.toggleCodeBlock().run(); break;
    case 'table': chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(); break;
    case 'divider': chain.setHorizontalRule().run(); break;
    case 'image': onImage?.(); break;
    default:
      // Leaving a list needs lifting, not just a node type swap – setParagraph
      // alone would leave an empty list item wrapped around the text.
      if (editor.isActive('bulletList') || editor.isActive('orderedList') || editor.isActive('taskList')) {
        chain.liftListItem('listItem').setParagraph().run();
      } else {
        chain.setParagraph().run();
      }
  }
}

/** The block type at the selection, for the bubble menu's label. */
export function currentBlock(editor: Editor): BlockDef {
  const byKey = (k: BlockKey) => BLOCKS.find((b) => b.key === k)!;
  if (editor.isActive('heading', { level: 1 })) return byKey('h1');
  if (editor.isActive('heading', { level: 2 })) return byKey('h2');
  if (editor.isActive('heading', { level: 3 })) return byKey('h3');
  if (editor.isActive('taskList')) return byKey('taskList');
  if (editor.isActive('bulletList')) return byKey('bulletList');
  if (editor.isActive('orderedList')) return byKey('orderedList');
  if (editor.isActive('callout')) return byKey('callout');
  if (editor.isActive('toggleBlock')) return byKey('toggle');
  if (editor.isActive('blockquote')) return byKey('blockquote');
  if (editor.isActive('codeBlock')) return byKey('codeBlock');
  return byKey('paragraph');
}

/* ── Text colour and highlight ───────────────────────────────────────────── */

/**
 * A fixed palette rather than a colour picker: hand-picked values keep a
 * document readable in both themes, which arbitrary hex does not.
 */
export const TEXT_COLORS: readonly { key: string; labelKey: string; value: string | null }[] = [
  { key: 'default', labelKey: 'editor.color.default', value: null },
  { key: 'grey', labelKey: 'editor.color.grey', value: '#8b8f9a' },
  { key: 'brown', labelKey: 'editor.color.brown', value: '#a1734e' },
  { key: 'orange', labelKey: 'editor.color.orange', value: '#d9820b' },
  { key: 'yellow', labelKey: 'editor.color.yellow', value: '#c9a227' },
  { key: 'green', labelKey: 'editor.color.green', value: '#3f9e6a' },
  { key: 'blue', labelKey: 'editor.color.blue', value: '#4d8fdb' },
  { key: 'purple', labelKey: 'editor.color.purple', value: '#9270d8' },
  { key: 'pink', labelKey: 'editor.color.pink', value: '#d267a5' },
  { key: 'red', labelKey: 'editor.color.red', value: '#e05252' },
];

/** Highlights carry alpha so the text on top stays legible in either theme. */
export const HIGHLIGHTS: readonly { key: string; labelKey: string; value: string | null }[] = [
  { key: 'none', labelKey: 'editor.color.none', value: null },
  { key: 'grey', labelKey: 'editor.color.grey', value: 'rgba(139,143,154,0.28)' },
  { key: 'orange', labelKey: 'editor.color.orange', value: 'rgba(217,130,11,0.28)' },
  { key: 'yellow', labelKey: 'editor.color.yellow', value: 'rgba(201,162,39,0.32)' },
  { key: 'green', labelKey: 'editor.color.green', value: 'rgba(63,158,106,0.28)' },
  { key: 'blue', labelKey: 'editor.color.blue', value: 'rgba(77,143,219,0.28)' },
  { key: 'purple', labelKey: 'editor.color.purple', value: 'rgba(146,112,216,0.28)' },
  { key: 'pink', labelKey: 'editor.color.pink', value: 'rgba(210,103,165,0.28)' },
  { key: 'red', labelKey: 'editor.color.red', value: 'rgba(224,82,82,0.28)' },
];

export const ALIGNMENTS: readonly { key: 'left' | 'center' | 'right'; icon: LucideIcon; labelKey: string }[] = [
  { key: 'left', icon: AlignLeft, labelKey: 'editor.align.left' },
  { key: 'center', icon: AlignCenter, labelKey: 'editor.align.center' },
  { key: 'right', icon: AlignRight, labelKey: 'editor.align.right' },
];
