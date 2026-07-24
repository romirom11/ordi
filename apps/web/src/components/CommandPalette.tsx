import { useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../lib/api';
import { useT } from '../lib/i18n';

interface SearchResult { id: string; title: string; kind: string; url: string }

export function CommandPalette({ open, onClose, onNavigate }: { open: boolean; onClose: () => void; onNavigate: (to: string) => void }) {
  const t = useT();
  const [q, setQ] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const { data } = useQuery({
    queryKey: ['search', q],
    queryFn: () => api.get<{ data: SearchResult[] }>('/search' + qs({ q })),
    enabled: open && q.length > 1,
  });

  if (!open) return null;
  const results = data?.data ?? [];

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-24" onClick={onClose}>
      <div className="w-full max-w-lg overflow-hidden rounded-lg border border-border bg-card shadow-xl" onClick={(e) => e.stopPropagation()}>
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('search.placeholder')}
          className="h-12 w-full border-b border-border bg-transparent px-4 text-sm outline-none" />
        <div className="max-h-80 overflow-auto p-1">
          {results.length === 0 && q.length > 1 && <div className="p-4 text-sm text-muted-foreground">{t('search.noResults')}</div>}
          {results.map((r) => (
            <button key={r.kind + r.id} onClick={() => { onNavigate(r.url); onClose(); }}
              className="flex w-full items-center gap-2 rounded px-3 py-2 text-left text-sm hover:bg-muted">
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs text-muted-foreground">{r.kind}</span>
              <span className="truncate">{r.title}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
