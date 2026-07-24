/**
 * Tiptap-based rich text editor (PRD §9.3, §8.3) — Notion/Linear-grade.
 *
 * No permanent toolbar: formatting happens through a "/" slash command menu
 * (slash.ts) and a selection bubble toolbar (below). Controlled-ish: emits
 * tiptap JSON via onChange; external value changes are applied only when the
 * editor is not focused (to avoid clobbering typing).
 *
 * Public API is intentionally stable — { value, onChange, placeholder?,
 * editable?, compact?, onSubmit? } + EMPTY_DOC — other pages depend on it.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useEditor, EditorContent, BubbleMenu, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TiptapLink from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import { Bold, Italic, Strikethrough, Code, Link2, Check, ChevronDown, X } from 'lucide-react';
import { cn } from '../ui';
import { useEntityRefClick } from './entityRefClick';
import { mentionSuggestion } from './mention';
import { EntityMention, entityMentionSuggestion } from './entityMention';
import { SlashCommand } from './slash';
import './richtext.css';

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

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

function BubbleButton({
  onClick,
  active,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded-md transition-colors',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

const BLOCK_TYPES = [
  { key: 'paragraph', label: 'Text' },
  { key: 'h1', label: 'Heading 1' },
  { key: 'h2', label: 'Heading 2' },
  { key: 'h3', label: 'Heading 3' },
  { key: 'quote', label: 'Quote' },
] as const;

function currentBlockLabel(editor: Editor): string {
  if (editor.isActive('heading', { level: 1 })) return 'Heading 1';
  if (editor.isActive('heading', { level: 2 })) return 'Heading 2';
  if (editor.isActive('heading', { level: 3 })) return 'Heading 3';
  if (editor.isActive('blockquote')) return 'Quote';
  return 'Text';
}

function applyBlockType(editor: Editor, key: string) {
  const chain = editor.chain().focus();
  switch (key) {
    case 'h1':
      chain.setNode('heading', { level: 1 }).run();
      break;
    case 'h2':
      chain.setNode('heading', { level: 2 }).run();
      break;
    case 'h3':
      chain.setNode('heading', { level: 3 }).run();
      break;
    case 'quote':
      if (editor.isActive('blockquote')) chain.setParagraph().run();
      else chain.setParagraph().setBlockquote().run();
      break;
    default:
      chain.setParagraph().run();
  }
}

function BubbleToolbar({
  editor,
  stateRef,
}: {
  editor: Editor;
  stateRef: React.MutableRefObject<{ linkOpen: boolean }>;
}) {
  const [blockOpen, setBlockOpen] = useState(false);
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkValue, setLinkValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Keep shouldShow aware of the open link popover so the bubble stays visible
  // while the input steals focus from the editor.
  const setLink = (open: boolean) => {
    stateRef.current.linkOpen = open;
    setLinkOpen(open);
  };

  const openLink = () => {
    setLinkValue((editor.getAttributes('link').href as string | undefined) ?? '');
    setLink(true);
    setBlockOpen(false);
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
    setLink(false);
  };

  const cancelLink = () => {
    setLink(false);
    editor.chain().focus().run();
  };

  if (linkOpen) {
    return (
      <div className="ordi-rt-bubble">
        <Link2 size={14} className="ml-1 shrink-0 text-muted-foreground" />
        <input
          ref={inputRef}
          value={linkValue}
          onChange={(e) => setLinkValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              commitLink();
            } else if (e.key === 'Escape') {
              e.preventDefault();
              cancelLink();
            }
          }}
          placeholder="Paste or type a link…"
          className="h-7 w-52 bg-transparent px-1 text-[13px] text-foreground outline-none placeholder:text-faint"
        />
        <BubbleButton title="Apply link" onClick={commitLink}>
          <Check size={14} />
        </BubbleButton>
        <BubbleButton title="Cancel" onClick={cancelLink}>
          <X size={14} />
        </BubbleButton>
      </div>
    );
  }

  return (
    <div className="ordi-rt-bubble">
      <div className="relative">
        <button
          type="button"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setBlockOpen((o) => !o)}
          className="inline-flex h-7 items-center gap-1 rounded-md px-2 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          {currentBlockLabel(editor)}
          <ChevronDown size={13} />
        </button>
        {blockOpen && (
          <div className="ordi-rt-blockmenu">
            {BLOCK_TYPES.map((b) => (
              <button
                key={b.key}
                type="button"
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => {
                  applyBlockType(editor, b.key);
                  setBlockOpen(false);
                }}
                className="ordi-rt-blockmenu-item"
              >
                {b.label}
              </button>
            ))}
          </div>
        )}
      </div>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <BubbleButton title="Bold" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </BubbleButton>
      <BubbleButton title="Italic" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </BubbleButton>
      <BubbleButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={14} />
      </BubbleButton>
      <BubbleButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={14} />
      </BubbleButton>
      <span className="mx-0.5 h-4 w-px bg-border" />
      <BubbleButton title="Link" active={editor.isActive('link')} onClick={openLink}>
        <Link2 size={14} />
      </BubbleButton>
    </div>
  );
}

/* ───────────────────────── Editor ───────────────────────── */

export function RichEditor({ value, onChange, placeholder, editable = true, compact = false, bare = false, onSubmit }: RichEditorProps) {
  const onEntityClick = useEntityRefClick();
  // Refs keep the tiptap callbacks pointing at the latest props without
  // recreating the editor instance.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;
  const placeholderRef = useRef(placeholder);
  placeholderRef.current = placeholder;
  const bubbleState = useRef({ linkOpen: false });

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TiptapLink.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: 'noreferrer noopener', target: '_blank' } }),
      Placeholder.configure({
        includeChildren: false,
        placeholder: ({ editor: e, node }) => {
          if (e.isEmpty) return placeholderRef.current ?? 'Write something…';
          if (node.type.name === 'heading') return 'Heading';
          return "Type '/' for commands…";
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      SlashCommand,
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
      handleKeyDown: (_view, event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter' && onSubmitRef.current) {
          event.preventDefault();
          onSubmitRef.current();
          return true;
        }
        return false;
      },
    },
    onUpdate: ({ editor: e }) => {
      onChangeRef.current(e.getJSON());
    },
  });

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
  // borderless, seamless — the page provides the surface context.
  const wrapperClass = compact && !bare
    ? cn('w-full rounded-md border border-input bg-transparent text-sm', editable && 'focus-within:ring-2 focus-within:ring-ring/40')
    : 'w-full bg-transparent text-sm';

  return (
    <div className={wrapperClass} onClick={onEntityClick}>
      {editor && editable && (
        <BubbleMenu
          editor={editor}
          updateDelay={0}
          tippyOptions={{ duration: 120, maxWidth: 'none', hideOnClick: false }}
          shouldShow={({ editor: e, from, to }) => {
            if (bubbleState.current.linkOpen) return true;
            if (!e.isEditable) return false;
            if (from === to) return false;
            if (e.isActive('codeBlock')) return false;
            return e.state.doc.textBetween(from, to).trim().length > 0;
          }}
        >
          <BubbleToolbar editor={editor} stateRef={bubbleState} />
        </BubbleMenu>
      )}
      <EditorContent editor={editor} />
    </div>
  );
}
