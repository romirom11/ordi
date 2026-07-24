/**
 * Compact Linear-style toolbar for the project Tasks section: active filter
 * chips on the left, quiet icon buttons on the right (saved views bookmark,
 * Filter funnel, Display sliders). The view layout choice lives inside the
 * Display popover, so this row stays a single quiet line.
 */
import { useState, type FormEvent, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bookmark, CalendarDays, Plus, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Avatar, Button, IconButton, Input, PriorityIcon, Spinner, StatusIcon, Tooltip, cn } from '../ui';
import { ConfirmDialog, Dialog, DropdownMenu, MenuLabel, MenuSeparator, toast, useMenuClose } from '../overlays';
import { useT } from '../../lib/i18n';
import type { SavedView } from '../views/SavedViewsBar';
import { FilterPopover, type LabelLite, type StatusLite } from './FilterPopover';
import { DisplayPopover } from './DisplayPopover';
import {
  DUE_LABEL_KEY, PRIORITY_LABEL_KEY, EMPTY_FILTERS,
  countFilters, isTaskView, sanitizeFilters,
  type TaskFilters, type TaskViewPrefs,
} from './taskViewPrefs';
import type { UserLite } from './pickers';

/* ───────────────────────── Filter chips ───────────────────────── */

function Chip({ icon, label, onRemove }: { icon: ReactNode; label: string; onRemove: () => void }) {
  return (
    <span className="anim-pop-in inline-flex h-6 shrink-0 items-center gap-1.5 rounded-md border border-border bg-card pl-1.5 pr-0.5 text-xs text-foreground">
      <span className="shrink-0 [&>svg]:block">{icon}</span>
      <span className="max-w-36 truncate">{label}</span>
      <button
        type="button"
        onClick={onRemove}
        aria-label={`${label} ×`}
        className="rounded p-0.5 text-faint transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        <X size={11} />
      </button>
    </span>
  );
}

function FilterChips({ filters, onFilters, statuses, labels, users }: {
  filters: TaskFilters; onFilters: (f: TaskFilters) => void;
  statuses: StatusLite[]; labels: LabelLite[]; users: UserLite[];
}) {
  const t = useT();
  const chips: ReactNode[] = [];

  for (const sid of filters.statusIds) {
    const s = statuses.find((x) => x.id === sid);
    if (!s) continue;
    chips.push(<Chip key={`s-${sid}`} icon={<StatusIcon category={s.category} color={s.color} size={13} />} label={s.name}
      onRemove={() => onFilters({ ...filters, statusIds: filters.statusIds.filter((x) => x !== sid) })} />);
  }
  for (const p of filters.priorities) {
    chips.push(<Chip key={`p-${p}`} icon={<PriorityIcon priority={p} size={13} />} label={t(PRIORITY_LABEL_KEY[p] ?? p)}
      onRemove={() => onFilters({ ...filters, priorities: filters.priorities.filter((x) => x !== p) })} />);
  }
  for (const uid of filters.assigneeIds) {
    const u = users.find((x) => x.id === uid);
    chips.push(<Chip key={`u-${uid}`} icon={<Avatar name={u?.name ?? '?'} src={u?.avatar} size={14} />} label={u?.name ?? '?'}
      onRemove={() => onFilters({ ...filters, assigneeIds: filters.assigneeIds.filter((x) => x !== uid) })} />);
  }
  for (const lid of filters.labelIds) {
    const l = labels.find((x) => x.id === lid);
    if (!l) continue;
    chips.push(<Chip key={`l-${lid}`}
      icon={<span className="block h-2 w-2 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />} label={l.name}
      onRemove={() => onFilters({ ...filters, labelIds: filters.labelIds.filter((x) => x !== lid) })} />);
  }
  if (filters.due) {
    chips.push(<Chip key="due" icon={<CalendarDays size={12} className="text-muted-foreground" />} label={t(DUE_LABEL_KEY[filters.due])}
      onRemove={() => onFilters({ ...filters, due: null })} />);
  }

  if (chips.length === 0) return null;
  return (
    <>
      {chips}
      {countFilters(filters) > 1 && (
        <button
          type="button"
          onClick={() => onFilters(EMPTY_FILTERS)}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {t('tasksview.clearFilters')}
        </button>
      )}
    </>
  );
}

/* ───────────────────────── Saved views menu ───────────────────────── */

function SavedViewsList({ views, loading, myId, onApply, onDelete, onSave }: {
  views: SavedView[]; loading: boolean; myId: string;
  onApply: (v: SavedView) => void; onDelete: (v: SavedView) => void; onSave: () => void;
}) {
  const t = useT();
  const close = useMenuClose();
  return (
    <div>
      <MenuLabel>{t('tasksview.views')}</MenuLabel>
      {loading && <div className="flex justify-center py-2"><Spinner className="h-3.5 w-3.5" /></div>}
      {!loading && views.length === 0 && (
        <p className="px-2 pb-1.5 text-xs text-faint">{t('tasksview.noViews')}</p>
      )}
      {views.map((v) => {
        const canDelete = v.userId == null || v.userId === myId;
        return (
          <div key={v.id} className="group/sv flex items-center rounded-md transition-colors duration-150 hover:bg-muted">
            <button
              type="button"
              onClick={() => { onApply(v); close(); }}
              className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-left text-[13px]"
            >
              <Bookmark size={13} className="shrink-0 text-muted-foreground" />
              <span className="min-w-0 flex-1 truncate">{v.name}</span>
              {v.isShared && <span className="shrink-0 text-[10px] uppercase tracking-wide text-faint">{t('tasksview.shared')}</span>}
            </button>
            {canDelete && (
              <button
                type="button"
                aria-label={`${t('tasksview.deleteView')}: ${v.name}`}
                onClick={() => { onDelete(v); close(); }}
                className="mr-1 rounded p-1 text-faint opacity-0 transition-all duration-150 hover:bg-border/60 hover:text-foreground group-hover/sv:opacity-100"
              >
                <X size={12} />
              </button>
            )}
          </div>
        );
      })}
      <MenuSeparator />
      <button
        type="button"
        onClick={() => { onSave(); close(); }}
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
      >
        <Plus size={13} />
        {t('tasksview.saveView')}
      </button>
    </div>
  );
}

/* ───────────────────────── Toolbar ───────────────────────── */

export function TasksToolbar({ projectId, prefs, onPrefs, filters, onFilters, statuses, labels, users }: {
  projectId: string;
  prefs: TaskViewPrefs;
  onPrefs: (patch: Partial<TaskViewPrefs>) => void;
  filters: TaskFilters;
  onFilters: (f: TaskFilters) => void;
  statuses: StatusLite[];
  labels: LabelLite[];
  users: UserLite[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const me = useMe();
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [toDelete, setToDelete] = useState<SavedView | null>(null);

  const viewsQ = useQuery<SavedView[]>({
    queryKey: ['saved-views', 'tasks'],
    queryFn: () => api.get<{ data: SavedView[] }>('/saved-views?entityType=tasks').then((r) => r.data),
  });
  const views = (viewsQ.data ?? []).filter((v) => {
    const pid = (v.filters as { projectId?: unknown } | null | undefined)?.projectId;
    return pid == null || pid === projectId;
  });
  const invalidate = () => qc.invalidateQueries({ queryKey: ['saved-views', 'tasks'] });

  const save = useMutation({
    mutationFn: (name: string) => api.post('/saved-views', {
      entityType: 'tasks',
      name,
      layout: prefs.view,
      filters: {
        projectId,
        taskFilters: filters,
        display: {
          grouping: prefs.grouping, ordering: prefs.ordering,
          showSubtasks: prefs.showSubtasks, showEmptyGroups: prefs.showEmptyGroups, props: prefs.props,
        },
      },
      isShared: false,
    }),
    onSuccess: () => { invalidate(); setSaving(false); setSaveName(''); toast(t('tasksview.viewSaved')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('tasksview.saveViewFailed')),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/saved-views/${id}`),
    onSuccess: () => { invalidate(); setToDelete(null); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('tasksview.deleteViewFailed')),
  });

  const applyView = (v: SavedView) => {
    const patch: Partial<TaskViewPrefs> = {};
    if (isTaskView(v.layout)) patch.view = v.layout;
    const f = v.filters as { taskFilters?: unknown; display?: Partial<TaskViewPrefs> } | null | undefined;
    const display = f?.display;
    if (display && typeof display === 'object') {
      if (display.grouping) patch.grouping = display.grouping;
      if (display.ordering) patch.ordering = display.ordering;
      if (typeof display.showSubtasks === 'boolean') patch.showSubtasks = display.showSubtasks;
      if (typeof display.showEmptyGroups === 'boolean') patch.showEmptyGroups = display.showEmptyGroups;
      if (display.props && typeof display.props === 'object') patch.props = { ...prefs.props, ...display.props };
    }
    onPrefs(patch);
    if (f && 'taskFilters' in (f as object)) onFilters(sanitizeFilters(f.taskFilters));
  };

  return (
    <>
      <div className="sticky top-0 z-20 border-b border-border bg-surface/95 px-4 backdrop-blur-sm">
        <div className="flex min-h-[38px] flex-wrap items-center gap-1.5 py-1">
          <FilterChips filters={filters} onFilters={onFilters} statuses={statuses} labels={labels} users={users} />
          <div className="ml-auto flex items-center gap-0.5 pl-2">
            <DropdownMenu
              align="end"
              width={224}
              trigger={
                <Tooltip label={t('tasksview.views')} side="bottom">
                  <IconButton size="md" aria-label={t('tasksview.views')} className={cn(views.length > 0 && 'text-foreground')}>
                    <Bookmark size={15} />
                  </IconButton>
                </Tooltip>
              }
            >
              <SavedViewsList
                views={views}
                loading={viewsQ.isLoading}
                myId={me.user.id}
                onApply={applyView}
                onDelete={setToDelete}
                onSave={() => { setSaveName(''); setSaving(true); }}
              />
            </DropdownMenu>
            <FilterPopover statuses={statuses} labels={labels} users={users} filters={filters} onChange={onFilters} />
            <DisplayPopover prefs={prefs} onChange={onPrefs} />
          </div>
        </div>
      </div>

      <Dialog open={saving} onClose={() => setSaving(false)} title={t('tasksview.saveView')} width={380}>
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); const v = saveName.trim(); if (v) save.mutate(v); }}
          className="space-y-3 px-4 pb-4 pt-1"
        >
          <Input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder={t('tasksview.viewName')} />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSaving(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={save.isPending || !saveName.trim()}>
              {save.isPending ? <Spinner /> : t('common.save')}
            </Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => { if (toDelete) remove.mutate(toDelete.id); }}
        title={toDelete?.name ?? ''}
        body={t('tasksview.noUndo')}
        confirmLabel={t('tasksview.deleteView')}
        danger
        pending={remove.isPending}
      />
    </>
  );
}
