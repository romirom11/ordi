/**
 * Floating "#" entity-reference menu for the Tiptap editor (Linear-style).
 * Rendered via ReactRenderer from entityMention.ts; keyboard nav is driven
 * imperatively through the exposed ref so the editor keeps focus.
 * Visual language mirrors the "/" slash menu (.ordi-rt-menu classes).
 */
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react';
import { BookText, Building2, CheckSquare, Hash, Receipt, type LucideIcon } from 'lucide-react';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'rt.entity.task': 'Task',
    'rt.entity.page': 'Page',
    'rt.entity.company': 'Company',
    'rt.entity.invoice': 'Invoice',
    'rt.entity.empty': 'Nothing found',
    'rt.entity.hint': 'Type to link a task, page, company or invoice',
  },
  uk: {
    'rt.entity.task': 'Задача',
    'rt.entity.page': 'Сторінка',
    'rt.entity.company': 'Компанія',
    'rt.entity.invoice': 'Рахунок',
    'rt.entity.empty': 'Нічого не знайдено',
    'rt.entity.hint': 'Введіть запит, щоб послатися на задачу, сторінку, компанію чи рахунок',
  },
});

export interface EntityItem {
  id: string;
  title: string;
  kind: string;
  url: string;
}

export interface EntityMenuRef {
  onKeyDown: (props: { event: KeyboardEvent }) => boolean;
}

interface EntityMenuProps {
  items: EntityItem[];
  query: string;
  command: (item: EntityItem) => void;
}

const KIND_ICONS: Record<string, LucideIcon> = {
  task: CheckSquare,
  page: BookText,
  company: Building2,
  invoice: Receipt,
};

export const EntityMentionMenu = forwardRef<EntityMenuRef, EntityMenuProps>(function EntityMentionMenu(
  { items, query, command },
  ref,
) {
  const t = useT();
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
      if (event.key === 'Enter' || event.key === 'Tab') {
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
        <div className="ordi-rt-menu-empty">{query.trim() === '' ? t('rt.entity.hint') : t('rt.entity.empty')}</div>
      </div>
    );
  }

  return (
    <div ref={listRef} className="ordi-rt-menu">
      {items.map((item, i) => {
        const Icon = KIND_ICONS[item.kind] ?? Hash;
        return (
          <button
            key={`${item.kind}-${item.id}`}
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
              <span className="ordi-rt-menu-hint">{t(`rt.entity.${item.kind}`, item.kind)}</span>
            </span>
          </button>
        );
      })}
    </div>
  );
});
