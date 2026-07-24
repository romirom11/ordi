/**
 * Global search palette (Cmd/Ctrl+K). Linear-style: elevated modal, icon-led
 * results, full keyboard navigation with kbd hints in the footer.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Building2, FileText, Receipt, Search, SquareCheck } from 'lucide-react';
import { api, qs } from '../lib/api';
import { Kbd, Spinner, cn } from './ui';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'search.hintNavigate': 'navigate',
    'search.hintOpen': 'open',
    'search.hintClose': 'close',
    'search.startTyping': 'Search across the whole workspace',
    'search.kind.task': 'Task',
    'search.kind.company': 'Client',
    'search.kind.invoice': 'Invoice',
    'search.kind.page': 'Page',
    'search.goto': 'Go to',
  },
  uk: {
    'search.hintNavigate': 'навігація',
    'search.hintOpen': 'відкрити',
    'search.hintClose': 'закрити',
    'search.startTyping': 'Пошук по всьому воркспейсу',
    'search.kind.task': 'Задача',
    'search.kind.company': 'Клієнт',
    'search.kind.invoice': 'Рахунок',
    'search.kind.page': 'Сторінка',
    'search.goto': 'Перейти',
  },
});

interface SearchResult { id: string; title: string; kind: string; url: string }

/** Static navigation commands so "⌘K → finance → ↵" jumps straight to a section. */
const NAV_COMMANDS: { labelKey: string; to: string }[] = [
  { labelKey: 'nav.dashboard', to: '/' },
  { labelKey: 'nav.myTasks', to: '/my-tasks' },
  { labelKey: 'nav.projects', to: '/projects' },
  { labelKey: 'nav.crm', to: '/crm' },
  { labelKey: 'nav.knowledge', to: '/kb' },
  { labelKey: 'nav.time', to: '/time' },
  { labelKey: 'nav.finance', to: '/finance' },
  { labelKey: 'nav.people', to: '/people' },
  { labelKey: 'nav.resourcing', to: '/resourcing' },
  { labelKey: 'nav.dashboards', to: '/dashboards' },
  { labelKey: 'nav.settings', to: '/settings' },
  { labelKey: 'nav.profile', to: '/profile' },
];

const KIND_ICON: Record<string, ReactNode> = {
  task: <SquareCheck size={15} className="text-primary" />,
  company: <Building2 size={15} className="text-success" />,
  invoice: <Receipt size={15} className="text-warning" />,
  page: <FileText size={15} className="text-muted-foreground" />,
};

export function CommandPalette({ open, onClose, onNavigate }: {
  open: boolean; onClose: () => void; onNavigate: (to: string) => void;
}) {
  const t = useT();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const { data, isFetching } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<{ data: SearchResult[] }>('/search' + qs({ q })),
    enabled: open && q.length > 1,
  });
  const results = q.length > 1 ? data?.data ?? [] : [];

  // Navigation commands matched client-side against the localized labels.
  const navMatches = q.trim().length > 0
    ? NAV_COMMANDS.filter((c) => t(c.labelKey).toLowerCase().includes(q.trim().toLowerCase()))
    : [];
  const totalCount = navMatches.length + results.length;

  useEffect(() => {
    if (!open) { setQ(''); setActive(0); }
  }, [open]);
  useEffect(() => { setActive(0); }, [q]);

  const pick = (idx: number) => {
    if (idx < navMatches.length) {
      const cmd = navMatches[idx]!;
      onNavigate(cmd.to);
    } else {
      const r = results[idx - navMatches.length];
      if (!r) return;
      onNavigate(r.url);
    }
    onClose();
  };

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(a + 1, totalCount - 1)); }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(a - 1, 0)); }
      if (e.key === 'Enter' && totalCount > 0) {
        e.preventDefault();
        pick(Math.min(active, totalCount - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, navMatches.length, results, active, onClose]);

  // Keep the active row in view while arrowing through results.
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  if (!open) return null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[14vh]"
      style={{ background: 'hsl(var(--overlay) / 0.55)', animation: 'fade-in 250ms var(--ease-smooth-out) both' }}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal
        className="w-full max-w-xl overflow-hidden rounded-xl border border-border bg-elevated shadow-modal"
        style={{ animation: 'modal-in 250ms var(--ease-smooth-out) both' }}
        onMouseDown={(e) => e.stopPropagation()}
      >
        {/* Input row */}
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={15} className="shrink-0 text-faint" />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('search.placeholder')}
            className="h-12 w-full bg-transparent text-sm outline-none placeholder:text-faint focus-visible:outline-none"
          />
          {isFetching && <Spinner className="h-3.5 w-3.5 shrink-0" />}
        </div>

        {/* Results */}
        <div ref={listRef} className="max-h-[340px] overflow-y-auto p-1.5">
          {q.length <= 1 && (
            <div className="flex flex-col items-center gap-2 py-8 text-center">
              <Search size={18} className="text-faint" />
              <p className="text-[13px] text-muted-foreground">{t('search.startTyping')}</p>
            </div>
          )}
          {q.length > 1 && totalCount === 0 && !isFetching && (
            <div className="py-8 text-center text-[13px] text-muted-foreground">{t('search.noResults')}</div>
          )}
          {navMatches.map((c, i) => (
            <button
              key={c.to}
              data-idx={i}
              onClick={() => pick(i)}
              onMouseMove={() => setActive(i)}
              className={cn(
                'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-150',
                i === active ? 'bg-muted text-foreground' : 'text-foreground/90',
              )}
            >
              <span className="shrink-0"><ArrowRight size={15} className="text-muted-foreground" /></span>
              <span className="min-w-0 flex-1 truncate">{t(c.labelKey)}</span>
              <span className="shrink-0 text-[11px] text-faint">{t('search.goto')}</span>
              {i === active && <Kbd>↵</Kbd>}
            </button>
          ))}
          {results.map((r, i) => {
            const idx = navMatches.length + i;
            return (
              <button
                key={r.kind + r.id}
                data-idx={idx}
                onClick={() => pick(idx)}
                onMouseMove={() => setActive(idx)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[13px] transition-colors duration-150',
                  idx === active ? 'bg-muted text-foreground' : 'text-foreground/90',
                )}
              >
                <span className="shrink-0">{KIND_ICON[r.kind] ?? <FileText size={15} className="text-muted-foreground" />}</span>
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
                <span className="shrink-0 text-[11px] text-faint">{t(`search.kind.${r.kind}`, r.kind)}</span>
                {idx === active && <Kbd>↵</Kbd>}
              </button>
            );
          })}
        </div>

        {/* Footer hints */}
        <div className="flex items-center gap-4 border-t border-border px-4 py-2 text-[11px] text-faint">
          <span className="flex items-center gap-1"><Kbd>↑</Kbd><Kbd>↓</Kbd> {t('search.hintNavigate')}</span>
          <span className="flex items-center gap-1"><Kbd>↵</Kbd> {t('search.hintOpen')}</span>
          <span className="flex items-center gap-1"><Kbd>Esc</Kbd> {t('search.hintClose')}</span>
        </div>
      </div>
    </div>,
    document.body,
  );
}
