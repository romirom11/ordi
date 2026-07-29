/**
 * The hover gutter Notion puts to the left of every block: `+` inserts a block
 * below, `⋮⋮` drags it and opens the block menu.
 *
 * Written against the ProseMirror view directly rather than as an extension so
 * the buttons are ordinary React (and therefore ordinary Tailwind). Dragging is
 * the one part that has to speak ProseMirror: setting a NodeSelection and
 * handing the slice to `view.dragging` lets the editor's own drop handling move
 * the block, which is how the paid drag-handle extension works too – doing it
 * with dataTransfer alone would drop plain HTML instead of moving the node.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { NodeSelection } from '@tiptap/pm/state';
import type { Editor } from '@tiptap/react';
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2 } from 'lucide-react';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator } from '../overlays';
import { cn } from '../ui';
import { useT } from '../../lib/i18n';
import { TURN_INTO, applyBlockType } from './blocks';

interface Hovered {
  /** Document position of the top-level block the pointer is over. */
  pos: number;
  /** Offset of the block's top edge inside the editor's offset parent. */
  top: number;
  /** Block height, so a one-line handle can sit on the first line of a big block. */
  height: number;
}

/** The top-level block under a viewport point, or null. */
function blockAt(editor: Editor, x: number, y: number): Hovered | null {
  const view = editor.view;
  const found = view.posAtCoords({ left: x, top: y });
  if (!found) return null;
  const $pos = view.state.doc.resolve(found.inside >= 0 ? found.inside : found.pos);
  // Depth 1 is a direct child of the doc – the block a handle should act on.
  const depth = Math.min($pos.depth, 1);
  const pos = depth === 0 ? $pos.start(1) - 1 : $pos.before(1);
  if (pos < 0) return null;
  const dom = view.nodeDOM(pos);
  const el = dom instanceof HTMLElement ? dom : (dom as ChildNode | null)?.parentElement;
  if (!el) return null;
  const host = view.dom.offsetParent ?? view.dom;
  const rect = el.getBoundingClientRect();
  const hostRect = host.getBoundingClientRect();
  return { pos, top: rect.top - hostRect.top, height: rect.height };
}

export function BlockGutter({ editor, containerRef }: {
  editor: Editor;
  /** The editor wrapper – it owns the gutter column, so tracking lives here. */
  containerRef: React.RefObject<HTMLDivElement | null>;
}) {
  const t = useT();
  const [hovered, setHovered] = useState<Hovered | null>(null);
  /**
   * Set while the handle's menu is open. The menu is a body portal, so reaching
   * it takes the pointer out of the container – without this the gutter would
   * unmount from under the menu and every click would land on nothing.
   */
  const frozen = useRef(false);

  useEffect(() => {
    const host = containerRef.current;
    if (!host) return;
    const gutterEl = () => host.querySelector('.ordi-rt-gutter');

    // Tracking is bound to the wrapper, not to the editable element: the
    // handles sit in the wrapper's own left padding, so binding to the editor
    // would clear the state the moment the pointer moved onto them.
    const onMove = (e: MouseEvent) => {
      if (frozen.current || !editor.isEditable) return;
      if (gutterEl()?.contains(e.target as Node)) return;
      setHovered(blockAt(editor, e.clientX, e.clientY));
    };
    const onLeave = () => { if (!frozen.current) setHovered(null); };
    // A click that dismisses the menu without choosing anything still has to
    // release the freeze, or the gutter stays pinned to a stale block.
    const onDocDown = (e: MouseEvent) => {
      if (!frozen.current) return;
      if (host.contains(e.target as Node)) return;
      if ((e.target as HTMLElement | null)?.closest('[role="menu"]')) return;
      frozen.current = false;
      setHovered(null);
    };
    host.addEventListener('mousemove', onMove);
    host.addEventListener('mouseleave', onLeave);
    document.addEventListener('mousedown', onDocDown);
    return () => {
      host.removeEventListener('mousemove', onMove);
      host.removeEventListener('mouseleave', onLeave);
      document.removeEventListener('mousedown', onDocDown);
    };
  }, [editor, containerRef]);

  const select = useCallback((pos: number) => {
    const { view } = editor;
    if (pos < 0 || pos > view.state.doc.content.size) return null;
    const tr = view.state.tr.setSelection(NodeSelection.create(view.state.doc, pos));
    view.dispatch(tr);
    return view.state.selection;
  }, [editor]);

  const onDragStart = (e: React.DragEvent) => {
    if (!hovered) return;
    const { view } = editor;
    const selection = select(hovered.pos);
    if (!selection) return;
    // dataTransfer must carry something or Firefox cancels the drag outright;
    // the payload itself is unused because view.dragging owns the real slice.
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', '');
    const dom = view.nodeDOM(hovered.pos);
    if (dom instanceof HTMLElement) e.dataTransfer.setDragImage(dom, 8, 8);
    view.dragging = { slice: selection.content(), move: true };
  };

  /** Insert an empty paragraph after the block and put the caret in it. */
  const insertBelow = () => {
    if (!hovered) return;
    const { state } = editor.view;
    const node = state.doc.nodeAt(hovered.pos);
    if (!node) return;
    const at = hovered.pos + node.nodeSize;
    editor.chain().focus().insertContentAt(at, { type: 'paragraph' }).run();
    setHovered(null);
  };

  const move = (delta: -1 | 1) => {
    // Lift the block out and drop it back one slot over. ProseMirror has no
    // "move block" primitive, so this is a delete plus an insert in one tr.
    if (!hovered) return;
    const { state, dispatch } = editor.view;
    const node = state.doc.nodeAt(hovered.pos);
    if (!node) return;
    const $pos = state.doc.resolve(hovered.pos);
    const index = $pos.index(0);
    const parent = state.doc;
    const target = index + delta;
    if (target < 0 || target >= parent.childCount) return;
    let insertAt = 0;
    for (let i = 0; i < (delta === 1 ? target + 1 : target); i++) insertAt += parent.child(i).nodeSize;
    const tr = state.tr.delete(hovered.pos, hovered.pos + node.nodeSize);
    tr.insert(tr.mapping.map(insertAt, -1), node);
    dispatch(tr);
    setHovered(null);
  };

  const duplicate = () => {
    if (!hovered) return;
    const node = editor.view.state.doc.nodeAt(hovered.pos);
    if (!node) return;
    editor.chain().focus()
      .insertContentAt(hovered.pos + node.nodeSize, node.toJSON())
      .run();
    setHovered(null);
  };

  const remove = () => {
    if (!hovered) return;
    const node = editor.view.state.doc.nodeAt(hovered.pos);
    if (!node) return;
    editor.chain().focus().deleteRange({ from: hovered.pos, to: hovered.pos + node.nodeSize }).run();
    setHovered(null);
  };

  /** Run a menu action and hand hover tracking back to the pointer. */
  const done = (run: () => void) => { run(); frozen.current = false; };

  if (!hovered) return null;

  const btn = 'grid h-5 w-5 place-items-center rounded text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground';

  return (
    <div
      className="ordi-rt-gutter"
      // Sit on the block's first line rather than centred, so a long paragraph
      // does not push the handle into the middle of nowhere.
      style={{ top: hovered.top + Math.min(hovered.height, 26) / 2 }}
    >
      <button type="button" aria-label={t('editor.insertBelow')} title={t('editor.insertBelow')} className={btn} onClick={insertBelow}>
        <Plus size={14} />
      </button>
      <DropdownMenu
        align="start"
        side="bottom"
        width={196}
        trigger={
          <span
            draggable
            aria-label={t('editor.blockActions')}
            title={t('editor.blockActions')}
            onDragStart={onDragStart}
            onDragEnd={() => { frozen.current = false; setHovered(null); }}
            onMouseDown={() => { frozen.current = true; }}
            className={cn(btn, 'cursor-grab active:cursor-grabbing')}
          >
            <GripVertical size={14} />
          </span>
        }
      >
        <MenuLabel>{t('editor.turnInto')}</MenuLabel>
        {TURN_INTO.map((b) => (
          <MenuItem
            key={b.key}
            icon={<b.icon size={14} />}
            onSelect={() => done(() => { select(hovered.pos); applyBlockType(editor, b.key); })}
          >
            {t(b.labelKey)}
          </MenuItem>
        ))}
        <MenuSeparator />
        <MenuItem icon={<ArrowUp size={14} />} onSelect={() => done(() => move(-1))}>{t('editor.moveUp')}</MenuItem>
        <MenuItem icon={<ArrowDown size={14} />} onSelect={() => done(() => move(1))}>{t('editor.moveDown')}</MenuItem>
        <MenuItem icon={<Copy size={14} />} onSelect={() => done(duplicate)}>{t('editor.duplicate')}</MenuItem>
        <MenuSeparator />
        <MenuItem danger icon={<Trash2 size={14} />} onSelect={() => done(remove)}>{t('editor.deleteBlock')}</MenuItem>
      </DropdownMenu>
    </div>
  );
}
