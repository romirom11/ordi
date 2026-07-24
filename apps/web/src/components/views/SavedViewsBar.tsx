import { useState, type FormEvent } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, Bookmark, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useMe } from '../../lib/auth';
import { Button, Input, Skeleton, cn } from '../ui';
import { Dialog, ConfirmDialog, toast } from '../overlays';

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
  const [saving, setSaving] = useState(false);
  const [saveName, setSaveName] = useState('');
  const [toDelete, setToDelete] = useState<SavedView | null>(null);

  const viewsQ = useQuery<SavedView[]>({
    queryKey: ['saved-views', 'tasks'],
    queryFn: () => api.get<{ data: SavedView[] }>('/saved-views?entityType=tasks').then((r) => r.data),
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: ['saved-views', 'tasks'] });

  const save = useMutation({
    mutationFn: (name: string) => api.post('/saved-views', {
      entityType: 'tasks', name, layout: currentView, filters: { projectId }, isShared: false,
    }),
    onSuccess: () => { invalidate(); setSaving(false); setSaveName(''); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not save the view.'),
  });

  const remove = useMutation({
    mutationFn: (id: string) => api.del(`/saved-views/${id}`),
    onSuccess: () => { invalidate(); setToDelete(null); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Could not delete the view.'),
  });

  const views = (viewsQ.data ?? []).filter((v) => {
    const pid = (v.filters as { projectId?: unknown } | null | undefined)?.projectId;
    return pid == null || pid === projectId;
  });

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
              className="inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 transition-colors duration-150 hover:bg-muted">
              <Bookmark size={11} className="text-muted-foreground" />
              <span className="max-w-40 truncate">{v.name}</span>
              {v.isShared && <span className="text-[10px] text-muted-foreground">shared</span>}
            </button>
            {canDelete && (
              <button
                onClick={() => setToDelete(v)}
                aria-label={`Delete ${v.name}`}
                className="rounded-full p-0.5 text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground">
                <X size={11} />
              </button>
            )}
          </span>
        );
      })}
      <button onClick={() => { setSaveName(''); setSaving(true); }}
        className="inline-flex items-center gap-1 rounded-full border border-dashed border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground">
        <Plus size={11} /> Save view
      </button>

      <Dialog open={saving} onClose={() => setSaving(false)} title="Save view" width={380}>
        <form
          onSubmit={(e: FormEvent) => { e.preventDefault(); const v = saveName.trim(); if (v) save.mutate(v); }}
          className="space-y-3 px-4 pb-4 pt-1"
        >
          <Input autoFocus value={saveName} onChange={(e) => setSaveName(e.target.value)} placeholder="View name" />
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setSaving(false)}>Cancel</Button>
            <Button type="submit" size="sm" disabled={save.isPending || !saveName.trim()}>Save</Button>
          </div>
        </form>
      </Dialog>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => { if (toDelete) remove.mutate(toDelete.id); }}
        title="Delete saved view"
        body={toDelete ? `Delete “${toDelete.name}”? This can’t be undone.` : ''}
        confirmLabel="Delete"
        danger
        pending={remove.isPending}
      />
    </div>
  );
}
