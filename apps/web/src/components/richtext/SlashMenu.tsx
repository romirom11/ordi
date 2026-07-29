/**
 * Floating "/" command menu for the Tiptap editor (Notion-style).
 * Rendered via @tiptap/react ReactRenderer from slash.ts; keyboard nav is
 * driven imperatively through the exposed ref so the editor keeps focus.
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Editor, Range } from '@tiptap/react';
import { translate } from '../../lib/i18n';

export interface SlashItem {
  title: string;
  hint: string;
  icon: LucideIcon;
  aliases?: string[];
  command: (opts: { editor: Editor; range: Range }) => void;
}

export interface SlashMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface SlashMenuProps {
  items: SlashItem[];
  command: (item: SlashItem) => void;
}

export const SlashMenu = forwardRef<SlashMenuRef, SlashMenuProps>(function SlashMenu({ items, command }, ref) {
  const [selected, setSelected] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setSelected(0), [items]);

  useLayoutEffect(() => {
    const el = listRef.current?.querySelector<HTMLElement>('[data-active="true"]');
    el?.scrollIntoView({ block: 'nearest' });
  }, [selected]);

  useImperativeHandle(ref, () => ({
    onKeyDown: ({ event }) => {
      if (items.length === 0) return false;
      if (event.key === 'ArrowDown') {
        setSelected((s) => (s + 1) % items.length);
        return true;
      }
      if (event.key === 'ArrowUp') {
        setSelected((s) => (s - 1 + items.length) % items.length);
        return true;
      }
      if (event.key === 'Enter') {
        const item = items[selected];
        if (item) command(item);
        return true;
      }
      return false;
    },
  }));

  if (items.length === 0) {
    return (
      <div className="ordi-rt-menu">
        <div className="ordi-rt-menu-empty">{translate('editor.noBlocks', 'No matching blocks')}</div>
      </div>
    );
  }

  return (
    <div ref={listRef} className="ordi-rt-menu">
      {items.map((item, i) => {
        const Icon = item.icon;
        return (
          <button
            key={item.title}
            type="button"
            data-active={i === selected}
            className="ordi-rt-menu-item"
            onMouseEnter={() => setSelected(i)}
            onMouseDown={(e) => {
              e.preventDefault();
              command(item);
            }}
          >
            <span className="ordi-rt-menu-icon">
              <Icon size={15} strokeWidth={2} />
            </span>
            <span className="ordi-rt-menu-text">
              <span className="ordi-rt-menu-title">{item.title}</span>
              <span className="ordi-rt-menu-hint">{item.hint}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
});
