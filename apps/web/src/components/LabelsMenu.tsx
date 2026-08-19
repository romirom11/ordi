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
import { ArrowLeft, Pencil, Plus, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useCan } from '../lib/auth';
import { useLabels, type LabelLookup, type LabelScope } from '../lib/queries';
import { Spinner, cn } from './ui';
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
    'labels.edit': 'Edit label',
    'labels.back': 'Back',
    'labels.save': 'Save',
    'labels.saved': 'Label saved',
    'labels.saveFailed': 'Could not save the label',
    'labels.delete': 'Delete label',
    'labels.deleted': 'Label deleted',
    'labels.deleteFailed': 'Could not delete the label',
    'labels.deleteHint': 'Removes it from every task it is attached to.',
  },
  uk: {
    'labels.search': 'Знайти або створити мітку',
    'labels.create': 'Створити мітку',
    'labels.created': 'Мітку створено',
    'labels.createFailed': 'Не вдалося створити мітку',
    'labels.none': 'Ще немає міток',
    'labels.noMatches': 'Міток не знайдено',
    'labels.edit': 'Редагувати мітку',
    'labels.back': 'Назад',
    'labels.save': 'Зберегти',
    'labels.saved': 'Мітку збережено',
    'labels.saveFailed': 'Не вдалося зберегти мітку',
    'labels.delete': 'Видалити мітку',
    'labels.deleted': 'Мітку видалено',
    'labels.deleteFailed': 'Не вдалося видалити мітку',
    'labels.deleteHint': 'Зникне з усіх задач, до яких прикріплена.',
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
  const [editing, setEditing] = useState<LabelLookup | null>(null);
  const labels = useLabels(scope).data ?? [];
  const canManage = can('settings.manage');

  const needle = query.trim();
  const matches = needle
    ? labels.filter((l) => l.name.toLowerCase().includes(needle.toLowerCase()))
    : labels;
  const exists = labels.some((l) => l.name.toLowerCase() === needle.toLowerCase());
  // Creating a label edits the workspace vocabulary, hence settings.manage –
  // the same bar the settings screens use.
  const canCreate = canManage && needle.length > 0 && !exists;

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

  if (editing) {
    return <LabelEditor label={editing} scope={scope} onDone={() => setEditing(null)} />;
  }

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
          <LabelRow
            key={l.id}
            label={l}
            checked={value.includes(l.id)}
            onToggle={() => toggle(l.id)}
            onEdit={canManage ? () => setEditing(l) : undefined}
          />
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

function LabelRow({ label, checked, onToggle, onEdit }: {
  label: LabelLookup; checked: boolean; onToggle: () => void; onEdit?: () => void;
}) {
  const t = useT();
  return (
    <div className="group flex items-center rounded-md transition-colors duration-150 hover:bg-muted">
      <button
        type="button"
        onClick={onToggle}
        className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
      >
        <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: label.color ?? '#8a8f98' }} />
        <span className="min-w-0 flex-1 truncate">{label.name}</span>
        {checked && <span className="shrink-0 text-primary">✓</span>}
      </button>
      {onEdit && (
        <button
          type="button"
          aria-label={t('labels.edit')}
          title={t('labels.edit')}
          onClick={onEdit}
          className="mr-1 grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint opacity-0 transition-opacity duration-150 hover:bg-muted hover:text-foreground focus-visible:opacity-100 group-hover:opacity-100"
        >
          <Pencil size={12} />
        </button>
      )}
    </div>
  );
}

/**
 * In-place editing for the workspace vocabulary: rename, recolor, delete.
 * Lives inside the picker because that is where labels are created and where a
 * typo is noticed – a settings page nobody visits would not get them fixed.
 */
function LabelEditor({ label, scope, onDone }: { label: LabelLookup; scope: LabelScope; onDone: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color ?? LABEL_COLORS[0]!);
  // Chips on task rows resolve names/colors through ['labels', scope], so one
  // invalidation repaints every place the label shows.
  const invalidate = () => qc.invalidateQueries({ queryKey: ['labels', scope] });

  const save = useMutation({
    mutationFn: () => api.patch(`/labels/${label.id}`, { name: name.trim(), color }),
    onSuccess: () => { invalidate(); toast(t('labels.saved')); onDone(); },
    onError: () => toast.error(t('labels.saveFailed')),
  });
  const remove = useMutation({
    mutationFn: () => api.del(`/labels/${label.id}`),
    onSuccess: () => { invalidate(); toast(t('labels.deleted')); onDone(); },
    onError: () => toast.error(t('labels.deleteFailed')),
  });

  const pending = save.isPending || remove.isPending;
  const canSave = name.trim().length > 0 && !pending;

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1 px-1 pb-1 pt-0.5">
        <button
          type="button"
          aria-label={t('labels.back')}
          title={t('labels.back')}
          onClick={onDone}
          className="grid h-6 w-6 shrink-0 place-items-center rounded-md text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          <ArrowLeft size={13} />
        </button>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && canSave) save.mutate(); }}
          autoFocus
          className="h-7 w-full rounded-md border border-border bg-surface px-2 text-[13px] outline-none placeholder:text-faint focus:border-primary/60"
        />
      </div>
      <div className="flex items-center gap-1.5 px-2 py-1.5">
        {LABEL_COLORS.map((c) => (
          <button
            key={c}
            type="button"
            aria-label={c}
            onClick={() => setColor(c)}
            className={cn(
              'h-5 w-5 rounded-full transition-transform duration-150 hover:scale-110',
              c === color && 'ring-2 ring-ring ring-offset-2 ring-offset-elevated',
            )}
            style={{ backgroundColor: c }}
          />
        ))}
      </div>
      <div className="mx-1 my-1 h-px bg-border" />
      <div className="flex items-center gap-2 px-1 pb-1">
        <button
          type="button"
          title={t('labels.deleteHint')}
          disabled={pending}
          onClick={() => remove.mutate()}
          className="flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[13px] text-faint transition-colors duration-150 hover:bg-destructive/10 hover:text-destructive disabled:opacity-60"
        >
          {remove.isPending ? <Spinner className="h-3.5 w-3.5" /> : <Trash2 size={13} />}
          {t('labels.delete')}
        </button>
        <button
          type="button"
          disabled={!canSave}
          onClick={() => save.mutate()}
          className="ml-auto flex items-center gap-1.5 rounded-md bg-primary px-2.5 py-1.5 text-[13px] text-primary-foreground transition-opacity duration-150 hover:opacity-90 disabled:opacity-60"
        >
          {save.isPending && <Spinner className="h-3.5 w-3.5" />}
          {t('labels.save')}
        </button>
      </div>
    </div>
  );
}
