/**
 * Project settings → Task statuses: the project's own board columns. A project
 * admin adds, renames, recolours, recategorises, reorders and deletes them;
 * deleting one moves its tasks to another status first.
 */
import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useTaskStatuses, type TaskStatusLookup } from '../../lib/queries';
import { Badge, Button, IconButton, Input, Select, Skeleton, Spinner, StatusIcon, Switch, cn } from '../ui';
import { Dialog, toast } from '../overlays';
import { Field } from '../settings/primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'tstatus.title': 'Task statuses',
    'tstatus.hint': 'The columns of this project\'s board. New tasks start in the default status.',
    'tstatus.new': 'New status',
    'tstatus.edit': 'Edit status',
    'tstatus.category': 'Category',
    'tstatus.cat.backlog': 'Backlog',
    'tstatus.cat.todo': 'To do',
    'tstatus.cat.in_progress': 'In progress',
    'tstatus.cat.done': 'Done',
    'tstatus.cat.canceled': 'Canceled',
    'tstatus.catHint.backlog': 'Ideas and work nobody has planned yet.',
    'tstatus.catHint.todo': 'Planned, not started.',
    'tstatus.catHint.in_progress': 'Someone is working on it.',
    'tstatus.catHint.done': 'Finished: counts as done in progress and is never overdue.',
    'tstatus.catHint.canceled': 'Closed without being done; never overdue.',
    'tstatus.color': 'Color',
    'tstatus.default': 'Default',
    'tstatus.defaultHint': 'New tasks start in this status.',
    'tstatus.defaultLocked': 'To change the default, make another status the default.',
    'tstatus.moveUp': 'Move up',
    'tstatus.moveDown': 'Move down',
    'tstatus.deleteTitle': 'Delete "{name}"',
    'tstatus.deleteBody': 'Its tasks move to the status you pick. Nothing else is lost.',
    'tstatus.deleteDefault': 'This is the default status: the one you pick becomes the default.',
    'tstatus.moveTo': 'Move its tasks to',
    'tstatus.deleted': 'Status deleted',
    'tstatus.lastOne': 'A project needs at least one status.',
  },
  uk: {
    'tstatus.title': 'Статуси задач',
    'tstatus.hint': 'Колонки дошки цього проєкту. Нові задачі потрапляють у статус за замовчуванням.',
    'tstatus.new': 'Новий статус',
    'tstatus.edit': 'Редагувати статус',
    'tstatus.category': 'Категорія',
    'tstatus.cat.backlog': 'Беклог',
    'tstatus.cat.todo': 'До виконання',
    'tstatus.cat.in_progress': 'У роботі',
    'tstatus.cat.done': 'Готово',
    'tstatus.cat.canceled': 'Скасовано',
    'tstatus.catHint.backlog': 'Ідеї та робота, яку ще ніхто не запланував.',
    'tstatus.catHint.todo': 'Заплановано, ще не розпочато.',
    'tstatus.catHint.in_progress': 'Над задачею хтось працює.',
    'tstatus.catHint.done': 'Завершено: рахується як виконане в прогресі й ніколи не буває простроченим.',
    'tstatus.catHint.canceled': 'Закрито без виконання; ніколи не буває простроченим.',
    'tstatus.color': 'Колір',
    'tstatus.default': 'За замовчуванням',
    'tstatus.defaultHint': 'Нові задачі починаються в цьому статусі.',
    'tstatus.defaultLocked': 'Щоб змінити статус за замовчуванням, зробіть таким інший статус.',
    'tstatus.moveUp': 'Перемістити вгору',
    'tstatus.moveDown': 'Перемістити вниз',
    'tstatus.deleteTitle': 'Видалити «{name}»',
    'tstatus.deleteBody': 'Його задачі перейдуть у статус, який ви оберете. Більше нічого не втрачається.',
    'tstatus.deleteDefault': 'Це статус за замовчуванням: обраний статус стане за замовчуванням замість нього.',
    'tstatus.moveTo': 'Перенести задачі в',
    'tstatus.deleted': 'Статус видалено',
    'tstatus.lastOne': 'У проєкті має лишитися щонайменше один статус.',
  },
});

const CATEGORIES = ['backlog', 'todo', 'in_progress', 'done', 'canceled'] as const;
const COLORS = ['#6b7280', '#3b82f6', '#0ea5e9', '#10b981', '#f59e0b', '#f97316', '#ef4444', '#ec4899', '#8b5cf6'];

export function TaskStatusesSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const statusesQ = useTaskStatuses(projectId);
  const statuses = statusesQ.data ?? [];
  const [editing, setEditing] = useState<TaskStatusLookup | null>(null);
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<TaskStatusLookup | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['task-statuses', projectId] });
  const apiError = (e: unknown) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));

  const reorder = useMutation({
    mutationFn: (ids: string[]) => api.patch(`/projects/${projectId}/task-statuses/order`, { ids }),
    onSuccess: invalidate,
    onError: apiError,
  });

  const move = (idx: number, dir: -1 | 1) => {
    const ids = statuses.map((s) => s.id);
    const target = idx + dir;
    if (target < 0 || target >= ids.length) return;
    [ids[idx], ids[target]] = [ids[target]!, ids[idx]!];
    reorder.mutate(ids);
  };

  return (
    <section>
      <div className="mb-1 flex items-center justify-between">
        <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('tstatus.title')}</h2>
        <Button size="xs" variant="ghost" onClick={() => setCreating(true)}>
          <Plus size={13} /> {t('tstatus.new')}
        </Button>
      </div>
      <p className="mb-2 text-xs text-muted-foreground">{t('tstatus.hint')}</p>
      <div className="rounded-lg border border-border bg-card px-4">
        {statusesQ.isLoading ? (
          <div className="py-3"><Skeleton className="h-8" /></div>
        ) : statuses.map((s, i) => (
          <div key={s.id} className={cn('group flex items-center gap-3 py-2', i > 0 && 'border-t border-border')}>
            <StatusIcon category={s.category} color={s.color} />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium">{s.name}</span>
                {s.isDefault && <Badge className="bg-primary/10 text-primary">{t('tstatus.default')}</Badge>}
              </div>
              <p className="text-xs text-muted-foreground">{t(`tstatus.cat.${s.category}`, s.category)}</p>
            </div>
            <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover:opacity-100">
              <IconButton size="sm" aria-label={t('tstatus.moveUp')} onClick={() => move(i, -1)} disabled={i === 0 || reorder.isPending}><ArrowUp size={14} /></IconButton>
              <IconButton size="sm" aria-label={t('tstatus.moveDown')} onClick={() => move(i, 1)} disabled={i === statuses.length - 1 || reorder.isPending}><ArrowDown size={14} /></IconButton>
              <IconButton size="sm" aria-label={t('tstatus.edit')} onClick={() => setEditing(s)}><Pencil size={14} /></IconButton>
              <IconButton
                size="sm"
                aria-label={t('common.delete')}
                title={statuses.length <= 1 ? t('tstatus.lastOne') : undefined}
                className="text-destructive"
                disabled={statuses.length <= 1}
                onClick={() => setDeleting(s)}
              >
                <Trash2 size={14} />
              </IconButton>
            </div>
          </div>
        ))}
      </div>

      <StatusDialog
        projectId={projectId}
        open={creating || !!editing}
        status={editing}
        onClose={() => { setCreating(false); setEditing(null); }}
      />
      <DeleteStatusDialog
        projectId={projectId}
        status={deleting}
        others={statuses.filter((s) => s.id !== deleting?.id)}
        onClose={() => setDeleting(null)}
      />
    </section>
  );
}

function StatusDialog({ projectId, open, status, onClose }: {
  projectId: string; open: boolean; status: TaskStatusLookup | null; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [category, setCategory] = useState<string>('in_progress');
  const [color, setColor] = useState(COLORS[0]!);
  const [isDefault, setIsDefault] = useState(false);

  useEffect(() => {
    if (!open) return;
    setName(status?.name ?? '');
    setCategory(status?.category ?? 'in_progress');
    setColor(status?.color ?? COLORS[0]!);
    setIsDefault(!!status?.isDefault);
  }, [open, status]);

  // The default can be handed to another status, never switched off on its own.
  const defaultLocked = !!status?.isDefault;

  const save = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = { name: name.trim(), category, color };
      if (!defaultLocked && isDefault) body.isDefault = true;
      return status
        ? api.patch(`/task-statuses/${status.id}`, body)
        : api.post(`/projects/${projectId}/task-statuses`, body);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task-statuses', projectId] });
      toast(t('common.saved'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={status ? t('tstatus.edit') : t('tstatus.new')} width={440}>
      <form
        className="space-y-3.5 px-4 pb-4 pt-1"
        onSubmit={(e: FormEvent) => { e.preventDefault(); if (name.trim()) save.mutate(); }}
      >
        <Field label={t('common.name')}>
          <Input autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
        </Field>

        <Field label={t('tstatus.category')}>
          <Select value={category} onChange={(e) => setCategory(e.target.value)}>
            {CATEGORIES.map((c) => <option key={c} value={c}>{t(`tstatus.cat.${c}`)}</option>)}
          </Select>
          <span className="mt-1 block text-xs text-muted-foreground">{t(`tstatus.catHint.${category}`)}</span>
        </Field>

        <Field label={t('tstatus.color')}>
          <div className="flex h-8 items-center gap-1.5">
            {COLORS.map((c) => (
              <button
                key={c}
                type="button"
                aria-label={c}
                aria-pressed={color === c}
                onClick={() => setColor(c)}
                className={cn(
                  'h-5 w-5 rounded-full transition-transform duration-150',
                  color === c ? 'scale-110 ring-2 ring-ring ring-offset-2 ring-offset-elevated' : 'hover:scale-110',
                )}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </Field>

        <div className="flex items-center justify-between gap-4 rounded-lg border border-border px-3 py-2.5">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('tstatus.default')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t(defaultLocked ? 'tstatus.defaultLocked' : 'tstatus.defaultHint')}</div>
          </div>
          <Switch checked={isDefault} disabled={defaultLocked} onChange={setIsDefault} label={t('tstatus.default')} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : null} {status ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeleteStatusDialog({ projectId, status, others, onClose }: {
  projectId: string; status: TaskStatusLookup | null; others: TaskStatusLookup[]; onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [moveTo, setMoveTo] = useState('');

  // Suggest the closest status of the same kind, so "Delete" alone is usually right.
  useEffect(() => {
    if (!status) return;
    const sameKind = others.find((s) => s.category === status.category);
    setMoveTo((sameKind ?? others.find((s) => s.isDefault) ?? others[0])?.id ?? '');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.id]);

  const del = useMutation({
    mutationFn: () => api.del(`/task-statuses/${status!.id}?migrateTo=${encodeURIComponent(moveTo)}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['task-statuses', projectId] });
      // Tasks changed status, so every list and card that shows one is stale.
      for (const key of ['tasks', 'task', 'me-tasks', 'subtasks']) qc.invalidateQueries({ queryKey: [key] });
      toast(t('tstatus.deleted'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  return (
    <Dialog open={!!status} onClose={onClose} title={t('tstatus.deleteTitle').replace('{name}', status?.name ?? '')} width={420}>
      <div className="space-y-3.5 px-4 pb-4 pt-2">
        <p className="text-[13px] text-muted-foreground">
          {t('tstatus.deleteBody')} {status?.isDefault && t('tstatus.deleteDefault')}
        </p>
        <Field label={t('tstatus.moveTo')}>
          <Select value={moveTo} onChange={(e) => setMoveTo(e.target.value)}>
            {others.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </Select>
        </Field>
        <div className="flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" variant="destructive" size="sm" disabled={!moveTo || del.isPending} onClick={() => del.mutate()}>
            {del.isPending ? <Spinner /> : null} {t('common.delete')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}
