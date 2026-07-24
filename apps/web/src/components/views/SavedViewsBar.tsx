import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Bookmark, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Skeleton, cn } from '../ui';

export interface SavedView {
  id: string;
  name: string;
  filters?: Record<string, unknown> | null;
  sort?: Record<string, unknown> | null;
  layout?: string;
  isShared?: boolean;
  userId?: string | null;
}

export function SavedViewsBar({ projectId, currentView, onApply }: {
  projectId: string; currentView: string; onApply: (view: SavedView) => void;
}) {
  const qc = useQueryClient();
  const me = useMe();
  const myId = me.user.id;

  const viewsQ = useQuery<SavedView[]>({
    queryKey: ['saved-views', 'tasks'],
    queryFn: () => api.get<{ data: SavedView[] }>('/saved-views?entityType=tasks').then((r) => r.data),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['saved-views', 'tasks'] });

  const save = useMutation({
    mutationFn: (name: string) => api.post('/saved-views', {
      entityType: 'tasks', name, layout: currentView, filters: { projectId }, isShared: false,
    }),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not save the view.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/saved-views/${id}`),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not delete the view.'),
  });

  const views = (viewsQ.data ?? []).filter((v) => {
    const pid = (v.filters as { projectId?: unknown } | null | undefined)?.projectId;
    return pid == null || pid === projectId;
  });

  const onSave = () => {
    const name = window.prompt('View name');
    if (name && name.trim()) save.mutate(name.trim());
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {viewsQ.isLoading && <Skeleton className="h-6 w-32" />}
      {views.map((v) => {
        const canDelete = v.userId == null || v.userId === myId;
        return (
          <span key={v.id}
            className={cn(
              'inline-flex items-center gap-1 rounded-full border border-border bg-card pl-1 text-xs',
              canDelete ? 'pr-0.5' : 'pr-2',
            )}>
            <button onClick={() => onApply(v)} title={v.layout ? `Layout: ${v.layout}` : undefined}
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 hover:bg-muted">
              <Bookmark size={11} className="text-muted-foreground" />
              <span className="max-w-40 truncate">{v.name}</span>
              {v.isShared && <span className="text-[10px] text-muted-foreground">shared</span>}
            </button>
            {canDelete && (
              <button
                onClick={() => { if (window.confirm(`Delete saved view “${v.name}”?`)) remove.mutate(v.id); }}
                disabled={remove.isPending}
                aria-label={`Delete ${v.name}`}
                className="rounded-full p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground">
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
      <button onClick={onSave} disabled={save.isPending}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
        <Plus size={11} /> Save view
      </button>
    </div>
  );
}
