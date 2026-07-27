/**
 * The label picker: search, multi-select, and creating a label without leaving
 * the flow. Shared by the task sidebar, quick-create and the project rail –
 * each passes its own `scope`, so a task never offers project labels and back.
 *
 * Callers own the trigger (a chip, a rail row) and wrap this in their own
 * DropdownMenu; this is the menu body only.
 */
import { useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { useLabels, type LabelLookup, type LabelScope } from '../lib/queries';
import { Spinner } from './ui';
import { toast } from './overlays';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'labels.search': 'Search or create a label',
    'labels.create': 'Create label',
    'labels.created': 'Label created',
    'labels.createFailed': 'Could not create the label',
    'labels.none': 'No labels yet',
    'labels.noMatches': 'No labels match',
  },
  uk: {
    'labels.search': 'Знайти або створити мітку',
    'labels.create': 'Створити мітку',
    'labels.created': 'Мітку створено',
    'labels.createFailed': 'Не вдалося створити мітку',
    'labels.none': 'Ще немає міток',
    'labels.noMatches': 'Міток не знайдено',
  },
});

/**
 * Palette for labels created from a picker. Picking by position keeps quick
 * creations distinguishable without asking for a colour mid-flow.
 */
export const LABEL_COLORS = ['#6366f1', '#ec4899', '#f59e0b', '#10b981', '#06b6d4', '#8b5cf6', '#ef4444', '#84cc16'];

export function LabelsMenu({ scope, value, onChange }: {
  scope: LabelScope;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [query, setQuery] = useState('');
  const labels = useLabels(scope).data ?? [];

  const needle = query.trim();
  const matches = needle
    ? labels.filter((l) => l.name.toLowerCase().includes(needle.toLowerCase()))
    : labels;
  const exists = labels.some((l) => l.name.toLowerCase() === needle.toLowerCase());
  // Creating a label edits the workspace vocabulary, hence settings.manage –
  // the same bar the settings screens use.
  const canCreate = can('settings.manage') && needle.length > 0 && !exists;

  const toggle = (id: string) => {
    onChange(value.includes(id) ? value.filter((x) => x !== id) : [...value, id]);
  };

  const create = useMutation({
    mutationFn: (name: string) => api.post<{ id: string }>('/labels', {
      name, color: LABEL_COLORS[labels.length % LABEL_COLORS.length], scope,
    }),
    // The list is the source of truth for the selection, so the new label is
    // attached in the same gesture that creates it.
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['labels', scope] });
      onChange([...value, r.id]);
      setQuery('');
      toast(t('labels.created'));
    },
    onError: () => toast.error(t('labels.createFailed')),
  });

  return (
    <div className="min-w-0">
      <div className="px-1 pb-1 pt-0.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canCreate && !create.isPending) create.mutate(needle); }}
          placeholder={t('labels.search')}
          autoFocus
          className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none placeholder:text-faint focus:border-primary/60"
        />
      </div>
      <div className="max-h-52 overflow-y-auto">
        {/* Deliberately not MenuItem: picking labels is multi-select, so the
            menu has to survive each toggle. */}
        {matches.map((l) => (
          <LabelRow key={l.id} label={l} checked={value.includes(l.id)} onToggle={() => toggle(l.id)} />
        ))}
        {matches.length === 0 && !canCreate && (
          <p className="px-2.5 py-2 text-xs text-faint">{labels.length === 0 ? t('labels.none') : t('labels.noMatches')}</p>
        )}
      </div>
      {canCreate && (
        <>
          <div className="mx-1 my-1 h-px bg-border" />
          <button
            type="button"
            disabled={create.isPending}
            onClick={() => create.mutate(needle)}
            className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted disabled:opacity-60"
          >
            {create.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Plus size={14} className="text-muted-foreground" />}
            <span className="min-w-0 flex-1 truncate">{t('labels.create')} &ldquo;{needle}&rdquo;</span>
          </button>
        </>
      )}
    </div>
  );
}

function LabelRow({ label, checked, onToggle }: { label: LabelLookup; checked: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
    >
      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? '#8a8f98' }} />
      <span className="min-w-0 flex-1 truncate">{label.name}</span>
      {checked && <span className="shrink-0 text-primary">✓</span>}
    </button>
  );
}
