/**
 * Tiptap-based rich text editor (PRD §9.3, §8.3).
 * Controlled-ish: emits tiptap JSON via onChange; external value changes are
 * applied only when the editor is not focused (to avoid clobbering typing).
 */
import { useEffect, useMemo, useRef, type ReactNode } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import TiptapLink from '@tiptap/extension-link';
import Placeholder from '@tiptap/extension-placeholder';
import TaskList from '@tiptap/extension-task-list';
import TaskItem from '@tiptap/extension-task-item';
import Mention from '@tiptap/extension-mention';
import {
  Bold,
  Italic,
  Strikethrough,
  Code,
  Heading1,
  Heading2,
  Heading3,
  List,
  ListOrdered,
  ListChecks,
  SquareCode,
  TextQuote,
  Link2,
  Undo2,
  Redo2,
} from 'lucide-react';
import { cn } from '../ui';
import { mentionSuggestion } from './mention';
import './richtext.css';

export const EMPTY_DOC = { type: 'doc', content: [{ type: 'paragraph' }] };

export interface RichEditorProps {
  value: any;
  onChange: (doc: any) => void;
  placeholder?: string;
  editable?: boolean;
  compact?: boolean;
  onSubmit?: () => void;
}

function ToolbarButton({
  onClick,
  active,
  disabled,
  title,
  children,
}: {
  onClick: () => void;
  active?: boolean;
  disabled?: boolean;
  title: string;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      disabled={disabled}
      // preventDefault keeps focus in the editor while clicking toolbar buttons
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={cn(
        'inline-flex h-7 w-7 items-center justify-center rounded transition-colors disabled:pointer-events-none disabled:opacity-40',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

function Toolbar({ editor }: { editor: Editor }) {
  const setLink = () => {
    const prev = (editor.getAttributes('link').href as string | undefined) ?? '';
    const url = window.prompt('Link URL', prev);
    if (url === null) return;
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    } else {
      editor.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-0.5 border-b border-border px-1.5 py-1">
      <ToolbarButton title="Bold (Ctrl+B)" active={editor.isActive('bold')} onClick={() => editor.chain().focus().toggleBold().run()}>
        <Bold size={14} />
      </ToolbarButton>
      <ToolbarButton title="Italic (Ctrl+I)" active={editor.isActive('italic')} onClick={() => editor.chain().focus().toggleItalic().run()}>
        <Italic size={14} />
      </ToolbarButton>
      <ToolbarButton title="Strikethrough" active={editor.isActive('strike')} onClick={() => editor.chain().focus().toggleStrike().run()}>
        <Strikethrough size={14} />
      </ToolbarButton>
      <ToolbarButton title="Inline code" active={editor.isActive('code')} onClick={() => editor.chain().focus().toggleCode().run()}>
        <Code size={14} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton title="Heading 1" active={editor.isActive('heading', { level: 1 })} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()}>
        <Heading1 size={14} />
      </ToolbarButton>
      <ToolbarButton title="Heading 2" active={editor.isActive('heading', { level: 2 })} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>
        <Heading2 size={14} />
      </ToolbarButton>
      <ToolbarButton title="Heading 3" active={editor.isActive('heading', { level: 3 })} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>
        <Heading3 size={14} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton title="Bullet list" active={editor.isActive('bulletList')} onClick={() => editor.chain().focus().toggleBulletList().run()}>
        <List size={14} />
      </ToolbarButton>
      <ToolbarButton title="Ordered list" active={editor.isActive('orderedList')} onClick={() => editor.chain().focus().toggleOrderedList().run()}>
        <ListOrdered size={14} />
      </ToolbarButton>
      <ToolbarButton title="Task list" active={editor.isActive('taskList')} onClick={() => editor.chain().focus().toggleTaskList().run()}>
        <ListChecks size={14} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton title="Code block" active={editor.isActive('codeBlock')} onClick={() => editor.chain().focus().toggleCodeBlock().run()}>
        <SquareCode size={14} />
      </ToolbarButton>
      <ToolbarButton title="Quote" active={editor.isActive('blockquote')} onClick={() => editor.chain().focus().toggleBlockquote().run()}>
        <TextQuote size={14} />
      </ToolbarButton>
      <ToolbarButton title="Link" active={editor.isActive('link')} onClick={setLink}>
        <Link2 size={14} />
      </ToolbarButton>
      <span className="mx-1 h-4 w-px bg-border" />
      <ToolbarButton title="Undo (Ctrl+Z)" disabled={!editor.can().undo()} onClick={() => editor.chain().focus().undo().run()}>
        <Undo2 size={14} />
      </ToolbarButton>
      <ToolbarButton title="Redo" disabled={!editor.can().redo()} onClick={() => editor.chain().focus().redo().run()}>
        <Redo2 size={14} />
      </ToolbarButton>
    </div>
  );
}

export function RichEditor({ value, onChange, placeholder, editable = true, compact = false, onSubmit }: RichEditorProps) {
  // Refs keep the tiptap callbacks pointing at the latest props without
  // recreating the editor instance.
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;
  const onSubmitRef = useRef(onSubmit);
  onSubmitRef.current = onSubmit;

  const extensions = useMemo(
    () => [
      StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
      TiptapLink.configure({ openOnClick: false }),
      Placeholder.configure({ placeholder: placeholder ?? 'Write something…' }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Mention.configure({
        HTMLAttributes: { class: 'ordi-mention' },
        suggestion: mentionSuggestion,
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
        class: cn('ordi-prose px-3 py-2 outline-none', compact ? 'min-h-[4.5rem]' : 'min-h-[16rem]'),
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

  return (
    <div className={cn('w-full rounded-md border border-input bg-transparent text-sm', editable && 'focus-within:ring-2 focus-within:ring-ring/40')}>
      {!compact && editable && editor && <Toolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}
