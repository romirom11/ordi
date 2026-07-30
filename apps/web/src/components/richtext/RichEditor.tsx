/**
 * Tiptap-based rich text editor (PRD §9.3, §8.3) – Notion-grade.
 *
 * No permanent toolbar. Formatting arrives three ways, all reading the same
 * block table (blocks.ts):
 *   · "/" slash menu (slash.ts) inserts any block
 *   · a selection bubble toolbar handles marks, colour, alignment and turn-into
 *   · the hover gutter (BlockGutter) drags, duplicates, moves and deletes blocks
 * Plus the keyboard: ⌘B/I/U, ⌘E code, ⌘⇧H highlight, ⌘K link, ⌘⌥1…3 headings,
 * and every markdown input rule StarterKit ships (`## `, `- `, `1. `, `> `, ```).
 *
 * Public API is intentionally stable – { value, onChange, placeholder?,
 * editable?, compact?, bare?, onSubmit? } + EMPTY_DOC – other pages depend on it.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEditor, EditorContent, BubbleMenu, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TiptapLink from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import Underline from '@tiptap/extension-underline';
import Highlight from '@tiptap/extension-highlight';
import TextStyle from '@tiptap/extension-text-style';
import Color from '@tiptap/extension-color';
import TextAlign from '@tiptap/extension-text-align';
import Table from '@tiptap/extension-table';
import TableRow from '@tiptap/extension-table-row';
import TableCell from '@tiptap/extension-table-cell';
import TableHeader from '@tiptap/extension-table-header';
import CodeBlockLowlight from '@tiptap/extension-code-block-lowlight';
import {
  Baseline, Bold, Check, ChevronDown, Code, Highlighter, ImagePlus, Italic, Link2,
  Strikethrough, Trash2, Underline as UnderlineIcon, X,
} from 'lucide-react';
import { Button, Input, Spinner, cn } from '../ui';
import { Dialog, toast } from '../overlays';
import { IMAGE_MIME, uploadErrorKey, uploadImage } from '../../lib/uploads';
import { extendDict, useT } from '../../lib/i18n';
import { useEntityRefClick } from './entityRefClick';
import { mentionSuggestion } from './mention';
import { EntityMention, entityMentionSuggestion } from './entityMention';
import { SlashCommand } from './slash';
import { Callout } from './extensions/callout';
import { ToggleBlock } from './extensions/toggle';
import { BlockGutter } from './BlockGutter';
import { CODE_LANGUAGES, lowlight } from './lowlight';
import { ResolvedImage } from './images';
import {
  ALIGNMENTS, HIGHLIGHTS, TEXT_COLORS, TURN_INTO, applyBlockType, currentBlock,
} from './blocks';
import './richtext.css';

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

extendDict({
  en: {
    'editor.block.text': 'Text',
    'editor.block.h1': 'Heading 1',
    'editor.block.h2': 'Heading 2',
    'editor.block.h3': 'Heading 3',
    'editor.block.bullet': 'Bullet list',
    'editor.block.ordered': 'Numbered list',
    'editor.block.task': 'To-do list',
    'editor.block.quote': 'Quote',
    'editor.block.callout': 'Callout',
    'editor.block.toggle': 'Toggle',
    'editor.block.code': 'Code block',
    'editor.block.table': 'Table',
    'editor.block.divider': 'Divider',
    'editor.block.image': 'Image',
    'editor.hint.text': 'Plain paragraph',
    'editor.hint.h1': 'Large section heading',
    'editor.hint.h2': 'Medium section heading',
    'editor.hint.h3': 'Small section heading',
    'editor.hint.bullet': 'Unordered list',
    'editor.hint.ordered': 'Ordered list',
    'editor.hint.task': 'Checkbox task list',
    'editor.hint.quote': 'Capture a quotation',
    'editor.hint.callout': 'Boxed note that stands out',
    'editor.hint.toggle': 'Collapsible section',
    'editor.hint.code': 'Formatted code snippet',
    'editor.hint.table': '3×3 table with a header row',
    'editor.hint.divider': 'Horizontal rule',
    'editor.hint.image': 'Upload one, or embed by link',
    'editor.turnInto': 'Turn into',
    'editor.insertBelow': 'Insert block below',
    'editor.blockActions': 'Drag to move, click for actions',
    'editor.moveUp': 'Move up',
    'editor.moveDown': 'Move down',
    'editor.duplicate': 'Duplicate',
    'editor.deleteBlock': 'Delete block',
    'editor.bold': 'Bold',
    'editor.italic': 'Italic',
    'editor.underline': 'Underline',
    'editor.strike': 'Strikethrough',
    'editor.code': 'Inline code',
    'editor.link': 'Link',
    'editor.linkPlaceholder': 'Paste or type a link…',
    'editor.applyLink': 'Apply link',
    'editor.removeLink': 'Remove link',
    'editor.cancel': 'Cancel',
    'editor.textColor': 'Text colour',
    'editor.highlight': 'Highlight',
    'editor.align': 'Alignment',
    'editor.align.left': 'Left',
    'editor.align.center': 'Centre',
    'editor.align.right': 'Right',
    'editor.color.default': 'Default',
    'editor.color.none': 'None',
    'editor.color.grey': 'Grey',
    'editor.color.brown': 'Brown',
    'editor.color.orange': 'Orange',
    'editor.color.yellow': 'Yellow',
    'editor.color.green': 'Green',
    'editor.color.blue': 'Blue',
    'editor.color.purple': 'Purple',
    'editor.color.pink': 'Pink',
    'editor.color.red': 'Red',
    'editor.imagePrompt': 'https://…',
    'editor.imageUpload': 'Upload an image',
    'editor.imageOrLink': 'or link to one',
    'editor.imageInsert': 'Insert',
    'editor.imageHint': 'You can also paste a screenshot straight into the page, or drop an image file on it.',
    'uploads.tooLarge': 'That file is over the 25 MB limit',
    'uploads.notImage': 'That file is not an image',
    'uploads.noStorage': 'Object storage is not configured on this instance',
    'uploads.failed': 'Upload failed',
    'editor.tableRowBefore': 'Row above',
    'editor.tableRowAfter': 'Row below',
    'editor.tableColBefore': 'Column left',
    'editor.tableColAfter': 'Column right',
    'editor.tableDeleteRow': 'Delete row',
    'editor.tableDeleteCol': 'Delete column',
    'editor.tableHeader': 'Toggle header row',
    'editor.tableDelete': 'Delete table',
    'editor.placeholder': 'Write something…',
    'editor.placeholderHeading': 'Heading',
    'editor.placeholderSlash': "Type '/' for commands…",
    'editor.noBlocks': 'No matching blocks',
  },
  uk: {
    'editor.block.text': 'Текст',
    'editor.block.h1': 'Заголовок 1',
    'editor.block.h2': 'Заголовок 2',
    'editor.block.h3': 'Заголовок 3',
    'editor.block.bullet': 'Список',
    'editor.block.ordered': 'Нумерований список',
    'editor.block.task': 'Чеклист',
    'editor.block.quote': 'Цитата',
    'editor.block.callout': 'Виноска',
    'editor.block.toggle': 'Згортання',
    'editor.block.code': 'Блок коду',
    'editor.block.table': 'Таблиця',
    'editor.block.divider': 'Розділювач',
    'editor.block.image': 'Зображення',
    'editor.hint.text': 'Звичайний абзац',
    'editor.hint.h1': 'Великий заголовок розділу',
    'editor.hint.h2': 'Середній заголовок',
    'editor.hint.h3': 'Малий заголовок',
    'editor.hint.bullet': 'Список з маркерами',
    'editor.hint.ordered': 'Список з номерами',
    'editor.hint.task': 'Список з чекбоксами',
    'editor.hint.quote': 'Виділити цитату',
    'editor.hint.callout': 'Помітна нотатка в рамці',
    'editor.hint.toggle': 'Секція, що згортається',
    'editor.hint.code': 'Форматований фрагмент коду',
    'editor.hint.table': 'Таблиця 3×3 із шапкою',
    'editor.hint.divider': 'Горизонтальна лінія',
    'editor.hint.image': 'Завантажити або вставити за посиланням',
    'editor.turnInto': 'Перетворити на',
    'editor.insertBelow': 'Вставити блок нижче',
    'editor.blockActions': 'Тягніть, щоб перемістити; клік – дії',
    'editor.moveUp': 'Вище',
    'editor.moveDown': 'Нижче',
    'editor.duplicate': 'Дублювати',
    'editor.deleteBlock': 'Видалити блок',
    'editor.bold': 'Жирний',
    'editor.italic': 'Курсив',
    'editor.underline': 'Підкреслений',
    'editor.strike': 'Перекреслений',
    'editor.code': 'Код у рядку',
    'editor.link': 'Посилання',
    'editor.linkPlaceholder': 'Вставте або введіть посилання…',
    'editor.applyLink': 'Застосувати',
    'editor.removeLink': 'Прибрати посилання',
    'editor.cancel': 'Скасувати',
    'editor.textColor': 'Колір тексту',
    'editor.highlight': 'Виділення',
    'editor.align': 'Вирівнювання',
    'editor.align.left': 'Ліворуч',
    'editor.align.center': 'По центру',
    'editor.align.right': 'Праворуч',
    'editor.color.default': 'Типовий',
    'editor.color.none': 'Без виділення',
    'editor.color.grey': 'Сірий',
    'editor.color.brown': 'Коричневий',
    'editor.color.orange': 'Оранжевий',
    'editor.color.yellow': 'Жовтий',
    'editor.color.green': 'Зелений',
    'editor.color.blue': 'Синій',
    'editor.color.purple': 'Фіолетовий',
    'editor.color.pink': 'Рожевий',
    'editor.color.red': 'Червоний',
    'editor.imagePrompt': 'https://…',
    'editor.imageUpload': 'Завантажити зображення',
    'editor.imageOrLink': 'або вставити посилання',
    'editor.imageInsert': 'Вставити',
    'editor.imageHint': 'Також можна вставити скриншот прямо в сторінку або перетягнути файл зображення на неї.',
    'uploads.tooLarge': 'Файл більший за ліміт 25 МБ',
    'uploads.notImage': 'Цей файл не є зображенням',
    'uploads.noStorage': 'На цьому інстансі не налаштоване файлове сховище',
    'uploads.failed': 'Не вдалося завантажити',
    'editor.tableRowBefore': 'Рядок вище',
    'editor.tableRowAfter': 'Рядок нижче',
    'editor.tableColBefore': 'Стовпець ліворуч',
    'editor.tableColAfter': 'Стовпець праворуч',
    'editor.tableDeleteRow': 'Видалити рядок',
    'editor.tableDeleteCol': 'Видалити стовпець',
    'editor.tableHeader': 'Шапка таблиці',
    'editor.tableDelete': 'Видалити таблицю',
    'editor.placeholder': 'Напишіть щось…',
    'editor.placeholderHeading': 'Заголовок',
    'editor.placeholderSlash': "Введіть '/' для команд…",
    'editor.noBlocks': 'Немає відповідних блоків',
  },
});

/** Image files carried by a paste or a drop, ignoring everything else. */
function imageFilesFrom(data: DataTransfer | null): File[] {
  if (!data) return [];
  return Array.from(data.files).filter((f) => IMAGE_MIME.test(f.type));
}

export interface RichEditorProps {
  value: any;
  onChange: (doc: any) => void;
  placeholder?: string;
  editable?: boolean;
  compact?: boolean;
  /** Compact sizing without the bordered card (e.g. dialog composers). */
  bare?: boolean;
  onSubmit?: () => void;
}

/* ───────────────────────── Bubble toolbar ───────────────────────── */

function BubbleButton({ onClick, active, title, children }: {
  onClick: () => void; active?: boolean; title: string; children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors duration-150',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** A bubble popover anchored under its trigger. Closed by the parent on pick. */
function BubblePanel({ children }: { children: ReactNode }) {
  return <div className="ordi-rt-blockmenu">{children}</div>;
}

function BubbleToolbar({ editor, stateRef, linkRequest }: {
  editor: Editor;
  stateRef: React.MutableRefObject<{ panelOpen: boolean }>;
  /** Bumped by ⌘K in the editor; each new value opens the link popover. */
  linkRequest: number;
}) {
  const t = useT();
  type Panel = 'block' | 'color' | 'align' | 'link' | null;
  const [panel, setPanelState] = useState<Panel>(null);
  const [linkValue, setLinkValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // shouldShow has to know a panel is open, or the bubble hides the moment an
  // input or menu steals focus from the editor.
  const setPanel = (next: Panel) => {
    stateRef.current.panelOpen = next !== null;
    setPanelState(next);
  };

  const openLink = () => {
    setLinkValue((editor.getAttributes('link').href as string | undefined) ?? '');
    setPanel('link');
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  const commitLink = () => {
    const url = linkValue.trim();
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      const href = /^(https?:|mailto:|tel:|\/|#)/i.test(url) ? url : `https://${url}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    }
    setPanel(null);
  };

  // ⌘K inside the editor opens this popover rather than the command palette.
  useEffect(() => {
    if (linkRequest > 0) openLink();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkRequest]);

  if (panel === 'link') {
    return (
      <div className="ordi-rt-bubble">
        <Link2 size={14} className="ml-1 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={linkValue}
          onChange={(e) => setLinkValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') { e.preventDefault(); commitLink(); }
            else if (e.key === 'Escape') { e.preventDefault(); setPanel(null); editor.chain().focus().run(); }
          }}
          placeholder={t('editor.linkPlaceholder')}
          className="h-7 w-56 bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-faint"
        />
        <BubbleButton title={t('editor.applyLink')} onClick={commitLink}>
          <Check size={14} />
        </BubbleButton>
        {editor.isActive('link') && (
          <BubbleButton
            title={t('editor.removeLink')}
            onClick={() => { editor.chain().focus().extendMarkRange('link').unsetLink().run(); setPanel(null); }}
          >
            <Trash2 size={14} />
          </BubbleButton>
        )}
        <BubbleButton title={t('editor.cancel')} onClick={() => { setPanel(null); editor.chain().focus().run(); }}>
          <X size={14} />
        </BubbleButton>
      </div>
    );
  }

  const block = currentBlock(editor);
  const activeAlign = ALIGNMENTS.find((a) => editor.isActive({ textAlign: a.key })) ?? ALIGNMENTS[0]!;
  const AlignIcon = activeAlign.icon;

  return (
    <div className="ordi-rt-bubble">
      {/* Turn into */}
      <div className="relative">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setPanel(panel === 'block' ? null : 'block')}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {t(block.labelKey)}
          <ChevronDown size={13} />
        </button>
        {panel === 'block' && (
          <BubblePanel>
            {TURN_INTO.map((b) => (
              <button
                key={b.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { applyBlockType(editor, b.key); setPanel(null); }}
                className={cn('ordi-rt-blockmenu-item', b.key === block.key && 'is-active')}
              >
                <b.icon size={14} className="shrink-0 text-faint" />
                {t(b.labelKey)}
              </button>
            ))}
          </BubblePanel>
        )}
      </div>

      <span className="mx-0.5 h-4 w-px bg-border" />

      <BubbleButton title={t('editor.bold')} active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </BubbleButton>
      <BubbleButton title={t('editor.italic')} active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </BubbleButton>
      <BubbleButton title={t('editor.underline')} active={editor.isActive('underline')} onClick={() => editor.chain().focus().toggleUnderline().run()}>
        <UnderlineIcon size={14} />
      </BubbleButton>
      <BubbleButton title={t('editor.strike')} active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={14} />
      </BubbleButton>
      <BubbleButton title={t('editor.code')} active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={14} />
      </BubbleButton>

      <span className="mx-0.5 h-4 w-px bg-border" />

      {/* Colour + highlight in one panel, the way Notion groups them */}
      <div className="relative">
        <BubbleButton
          title={t('editor.textColor')}
          active={editor.isActive('textStyle') || editor.isActive('highlight')}
          onClick={() => setPanel(panel === 'color' ? null : 'color')}
        >
          <Baseline size={14} />
        </BubbleButton>
        {panel === 'color' && (
          <BubblePanel>
            <div className="ordi-rt-swatch-label">{t('editor.textColor')}</div>
            <div className="ordi-rt-swatches">
              {TEXT_COLORS.map((c) => (
                <button
                  key={c.key}
                  type="button"
                  title={t(c.labelKey)}
                  aria-label={t(c.labelKey)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (c.value) editor.chain().focus().setColor(c.value).run();
                    else editor.chain().focus().unsetColor().run();
                    setPanel(null);
                  }}
                  className="ordi-rt-swatch"
                  style={{ color: c.value ?? 'hsl(var(--foreground))' }}
                >
                  A
                </button>
              ))}
            </div>
            <div className="ordi-rt-swatch-label">{t('editor.highlight')}</div>
            <div className="ordi-rt-swatches">
              {HIGHLIGHTS.map((h) => (
                <button
                  key={h.key}
                  type="button"
                  title={t(h.labelKey)}
                  aria-label={t(h.labelKey)}
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => {
                    if (h.value) editor.chain().focus().setHighlight({ color: h.value }).run();
                    else editor.chain().focus().unsetHighlight().run();
                    setPanel(null);
                  }}
                  className="ordi-rt-swatch"
                  style={h.value ? { background: h.value } : undefined}
                >
                  {h.value ? 'A' : <Highlighter size={12} />}
                </button>
              ))}
            </div>
          </BubblePanel>
        )}
      </div>

      {/* Alignment */}
      <div className="relative">
        <BubbleButton title={t('editor.align')} onClick={() => setPanel(panel === 'align' ? null : 'align')}>
          <AlignIcon size={14} />
        </BubbleButton>
        {panel === 'align' && (
          <BubblePanel>
            {ALIGNMENTS.map((a) => (
              <button
                key={a.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => { editor.chain().focus().setTextAlign(a.key).run(); setPanel(null); }}
                className={cn('ordi-rt-blockmenu-item', a.key === activeAlign.key && 'is-active')}
              >
                <a.icon size={14} className="shrink-0 text-faint" />
                {t(a.labelKey)}
              </button>
            ))}
          </BubblePanel>
        )}
      </div>

      <BubbleButton title={t('editor.link')} active={editor.isActive('link')} onClick={openLink}>
        <Link2 size={14} />
      </BubbleButton>
    </div>
  );
}

/* ───────────────────────── Table toolbar ───────────────────────── */

/** Row/column controls, shown only while the caret is inside a table. */
function TableToolbar({ editor }: { editor: Editor }) {
  const t = useT();
  const act = (label: string, run: () => void) => (
    <button key={label} type="button" onMouseDown={(e) => e.preventDefault()} onClick={run} className="ordi-rt-tablebtn">
      {label}
    </button>
  );
  return (
    <div className="ordi-rt-tabletools">
      {act(t('editor.tableRowBefore'), () => editor.chain().focus().addRowBefore().run())}
      {act(t('editor.tableRowAfter'), () => editor.chain().focus().addRowAfter().run())}
      {act(t('editor.tableColBefore'), () => editor.chain().focus().addColumnBefore().run())}
      {act(t('editor.tableColAfter'), () => editor.chain().focus().addColumnAfter().run())}
      {act(t('editor.tableHeader'), () => editor.chain().focus().toggleHeaderRow().run())}
      {act(t('editor.tableDeleteRow'), () => editor.chain().focus().deleteRow().run())}
      {act(t('editor.tableDeleteCol'), () => editor.chain().focus().deleteColumn().run())}
      {act(t('editor.tableDelete'), () => editor.chain().focus().deleteTable().run())}
    </div>
  );
}

/**
 * Language picker for the code block the caret is in. Without it the lowlight
 * grammars are unreachable from the UI and every snippet stays plain text.
 */
function CodeToolbar({ editor }: { editor: Editor }) {
  const current = (editor.getAttributes('codeBlock').language as string | null) ?? '';
  return (
    <div className="ordi-rt-tabletools">
      <select
        aria-label="Language"
        value={current}
        onMouseDown={(e) => e.stopPropagation()}
        onChange={(e) => editor.chain().focus().updateAttributes('codeBlock', { language: e.target.value || null }).run()}
        className="ordi-rt-tablebtn"
      >
        {CODE_LANGUAGES.map((l) => <option key={l.value} value={l.value}>{l.label}</option>)}
      </select>
    </div>
  );
}

/* ───────────────────────── Editor ───────────────────────── */

export function RichEditor({ value, onChange, placeholder, editable = true, compact = false, bare = false, onSubmit }: RichEditorProps) {
  const t = useT();
  const onEntityClick = useEntityRefClick();
  // Refs keep the tiptap callbacks pointing at the latest props without
  // recreating the editor instance.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const bubbleState = useRef({ panelOpen: false });
  const wrapRef = useRef<HTMLDivElement>(null);
  // ⌘K is handled inside ProseMirror but acted on by the bubble toolbar, so the
  // request crosses as a counter: the handler bumps it, the toolbar reacts.
  const [linkRequest, setLinkRequest] = useState(0);
  const requestLink = useRef(() => setLinkRequest((n) => n + 1));

  /**
   * Images: upload a file, or paste a link to one already on the web.
   *
   * The dialog exists rather than window.prompt because the desktop webview
   * answers a native prompt with null – the slash menu's Image entry would
   * silently do nothing there. The ref is what lets the extension list stay
   * memoised with no deps: the extension captures the ref, not this render's
   * setter.
   */
  const [imageFor, setImageFor] = useState<Editor | null>(null);
  const [imageUrl, setImageUrl] = useState('');
  const [uploading, setUploading] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const requestImage = useRef((ed: Editor) => { setImageUrl(''); setImageFor(ed); });

  /**
   * Upload and insert at the caret. Shared by the dialog, paste and drop, so a
   * screenshot lands the same way however it arrives.
   */
  const insertUpload = useCallback(async (ed: Editor, file: File, at?: number) => {
    setUploading(true);
    try {
      const up = await uploadImage(file);
      const chain = ed.chain().focus();
      if (at !== undefined) chain.insertContentAt(at, { type: 'image', attrs: { src: up.src, alt: file.name } });
      else chain.setImage({ src: up.src, alt: file.name });
      chain.run();
      setImageFor(null);
    } catch (e) {
      toast.error(t(uploadErrorKey(e)));
    } finally {
      setUploading(false);
    }
  }, [t]);
  // Paste and drop are wired through ProseMirror, which cannot see React state,
  // so they reach the uploader through a ref that always holds the latest one.
  const insertUploadRef = useRef(insertUpload);
  insertUploadRef.current = insertUpload;

  const insertImageUrl = useCallback(() => {
    const url = imageUrl.trim();
    if (imageFor && url) imageFor.chain().focus().setImage({ src: url }).run();
    setImageFor(null);
  }, [imageFor, imageUrl]);

  const pickFile = useCallback((file: File | null | undefined) => {
    if (file && imageFor) void insertUpload(imageFor, file);
  }, [imageFor, insertUpload]);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
        // Replaced by the lowlight version, which adds language highlighting.
        codeBlock: false,
      }),
      CodeBlockLowlight.configure({ lowlight }),
      TiptapLink.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noreferrer noopener', target: '_blank' } }),
      Underline,
      TextStyle,
      Color,
      Highlight.configure({ multicolor: true }),
      // Headings and paragraphs only: aligning a list item or a table cell
      // fights the block's own layout.
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      ResolvedImage.configure({ inline: false, allowBase64: false, HTMLAttributes: { class: 'ordi-rt-image' } }),
      Table.configure({ resizable: true, lastColumnResizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Callout,
      ToggleBlock,
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ editor: e, node }) => {
          if (e.isEmpty) return placeholderRef.current ?? t('editor.placeholder');
          if (node.type.name === 'heading') return t('editor.placeholderHeading');
          return t('editor.placeholderSlash');
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      SlashCommand.configure({ onImage: (ed) => requestImage.current(ed) }),
      Mention.configure({
        HTMLAttributes: { class: 'ordi-mention' },
        suggestion: mentionSuggestion,
      }),
      EntityMention.configure({
        HTMLAttributes: { class: 'ordi-ref' },
        suggestion: entityMentionSuggestion,
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // handlePaste/handleDrop are created before `editor` exists, so they reach it
  // through a ref that is filled in immediately after.
  const editorRef = useRef<Editor | null>(null);

  const editor = useEditor({
    extensions,
    content: value ?? EMPTY_DOC,
    editable,
    editorProps: {
      attributes: {
        class: cn(
          'ordi-prose outline-none',
          bare ? 'px-0 py-1 min-h-[3.25rem]' : compact ? 'px-3 py-2 min-h-[2.5rem]' : 'py-1 min-h-[10rem]',
        ),
      },
      handleKeyDown: (view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && onSubmitRef.current) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        // ⌘K belongs to the link popover while the caret is in the editor;
        // the command palette keeps it everywhere else.
        if ((event.metaKey || event.ctrlKey) && !event.shiftKey && event.key.toLowerCase() === 'k') {
          if (view.state.selection.empty) return false;
          event.preventDefault();
          event.stopPropagation();
          requestLink.current();
          return true;
        }
        return false;
      },
      /**
       * Pasting a screenshot is the whole point of image support, and the
       * clipboard hands it over as a File – returning true here claims the
       * paste so ProseMirror does not also insert the browser's own
       * base64 <img>, which would bloat the document instead of uploading.
       */
      handlePaste: (view, event) => {
        const files = imageFilesFrom(event.clipboardData);
        if (!files.length || !view.editable) return false;
        event.preventDefault();
        const ed = editorRef.current;
        if (ed) files.forEach((f) => void insertUploadRef.current(ed, f));
        return true;
      },
      handleDrop: (view, event, _slice, moved) => {
        // `moved` means ProseMirror is relocating existing content – the block
        // drag handle's own drop. Never treat that as a file drop.
        if (moved || !view.editable) return false;
        const files = imageFilesFrom((event as DragEvent).dataTransfer);
        if (!files.length) return false;
        event.preventDefault();
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        const ed = editorRef.current;
        if (ed) files.forEach((f) => void insertUploadRef.current(ed, f, at));
        return true;
      },
    },
    onUpdate: ({ editor: e }) => {
      onChangeRef.current(e.getJSON());
    },
  });

  editorRef.current = editor;

  // Apply external value changes when they differ from the editor content,
  // but never while the user is typing in the editor.
  useEffect(() => {
    if (!editor) return;
    const incoming = value ?? EMPTY_DOC;
    if (!editor.isFocused && JSON.stringify(editor.getJSON()) !== JSON.stringify(incoming)) {
      editor.commands.setContent(incoming, false);
    }
  }, [editor, value]);

  useEffect(() => {
    if (editor && editor.isEditable !== editable) editor.setEditable(editable);
  }, [editor, editable]);

  // Compact (comments): bordered card with focus ring. Non-compact (page body):
  // borderless, seamless – the page provides the surface context.
  const showGutter = editable && !compact && !bare;
  const wrapperClass = compact && !bare
    ? cn('w-full rounded-md border border-input bg-transparent text-sm', editable && 'focus-within:ring-2 focus-within:ring-ring/40')
    // pl-11 on the WRAPPER, not the prose: the block handles get a column of
    // their own, outside the editable element. Inside it they would overlap the
    // editor's padding, and every pointer move onto a handle would first read
    // as a move over the text and clear the very block being pointed at.
    : cn('w-full bg-transparent text-sm', showGutter && 'pl-11');

  const inTable = !!editor && editor.isActive('table');
  const inCode = !!editor && editor.isActive('codeBlock');

  return (
    <div ref={wrapRef} className={cn(wrapperClass, 'relative')} onClick={onEntityClick}>
      {editor && editable && (
        <BubbleMenu
          editor={editor}
          updateDelay={0}
          tippyOptions={{ duration: 120, maxWidth: 'none', hideOnClick: false, placement: 'top' }}
          shouldShow={({ editor: e, from, to }) => {
            if (bubbleState.current.panelOpen) return true;
            if (!e.isEditable) return false;
            if (from === to) return false;
            if (e.isActive('codeBlock')) return false;
            return e.state.doc.textBetween(from, to).trim().length > 0;
          }}
        >
          <BubbleToolbar editor={editor} stateRef={bubbleState} linkRequest={linkRequest} />
        </BubbleMenu>
      )}
      {/* Only the full-width page editor reserves a gutter column; compact
          composers keep their tight layout and go without handles. */}
      {editor && showGutter && <BlockGutter editor={editor} containerRef={wrapRef} />}
      {editor && editable && inTable && <TableToolbar editor={editor} />}
      {editor && editable && inCode && <CodeToolbar editor={editor} />}
      <EditorContent editor={editor} />
      <Dialog open={!!imageFor} onClose={() => { if (!uploading) setImageFor(null); }} title={t('editor.block.image')} width={420}>
        <div className="space-y-3 px-4 pb-4 pt-1">
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => { pickFile(e.target.files?.[0]); e.target.value = ''; }}
          />
          <Button variant="outline" className="w-full" disabled={uploading} onClick={() => fileRef.current?.click()}>
            {uploading ? <Spinner /> : <ImagePlus size={14} />} {t('editor.imageUpload')}
          </Button>
          <p className="text-center text-[11px] text-faint">{t('editor.imageOrLink')}</p>
          <div className="flex items-center gap-2">
            <Input
              value={imageUrl}
              onChange={(e) => setImageUrl(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); insertImageUrl(); } }}
              placeholder={t('editor.imagePrompt')}
              disabled={uploading}
            />
            <Button size="sm" onClick={insertImageUrl} disabled={uploading || !imageUrl.trim()}>{t('editor.imageInsert')}</Button>
          </div>
          <p className="text-[11px] text-faint">{t('editor.imageHint')}</p>
        </div>
      </Dialog>
    </div>
  );
}
