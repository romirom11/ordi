import { useState, type KeyboardEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Select, PriorityIcon, cn } from '../ui';
import { toast } from '../overlays';
import { DateField } from '../DatePicker';

interface SheetStatus { id: string; name: string; category?: string }
interface SheetTask {
  id: string;
  number?: number;
  ref?: string;
  title: string;
  statusId: string;
  priority?: string;
  dueDate?: string | null;
  startDate?: string | null;
  estimate?: number | string | null;
  version?: number;
}

const PRIORITIES = ['none', 'low', 'medium', 'high', 'urgent'] as const;

const cellInput = 'h-7 w-full rounded border border-transparent bg-transparent px-1.5 text-sm outline-none focus:border-input focus:ring-1 focus:ring-ring/40';

export function SpreadsheetView({ tasks, statuses, projectId, onOpenTask }: {
  tasks: SheetTask[]; statuses: SheetStatus[]; projectId: string; onOpenTask: (taskId: string) => void;
}) {
  const qc = useQueryClient();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [editing, setEditing] = useState<{ id: string; value: string } | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: ['tasks', projectId] });

  const patch = useMutation({
    mutationFn: (vars: { id: string; body: Record<string, unknown>; version?: number }) =>
      api.patch(`/tasks/${vars.id}`, vars.version != null ? { ...vars.body, version: vars.version } : vars.body),
    onSuccess: invalidate,
    onError: (e) => { toast.error(e instanceof ApiError ? e.message : 'Could not save changes.'); invalidate(); },
  });

  const bulk = useMutation({
    mutationFn: (body: { taskIds: string[]; statusId?: string; priority?: string }) => api.post('/tasks/bulk', body),
    onSuccess: () => { invalidate(); setSelected(new Set()); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : 'Bulk update failed.'),
  });

  const patchField = (t: SheetTask, body: Record<string, unknown>) =>
    patch.mutate({ id: t.id, body, version: t.version });

  const toggle = (id: string) => setSelected((prev) => {
    const next = new Set(prev);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const allSelected = tasks.length > 0 && tasks.every((t) => selected.has(t.id));
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(tasks.map((t) => t.id)));

  const commitTitle = (t: SheetTask) => {
    if (editing && editing.id === t.id) {
      const v = editing.value.trim();
      if (v && v !== t.title) patchField(t, { title: v });
    }
    setEditing(null);
  };

  const commitDue = (t: SheetTask, raw: string) => {
    const cur = t.dueDate ? t.dueDate.slice(0, 10) : '';
    if (raw === cur) return;
    patchField(t, { dueDate: raw || null });
  };

  const commitEstimate = (t: SheetTask, raw: string) => {
    const cur = t.estimate == null || t.estimate === '' ? '' : String(Number(t.estimate));
    if (raw.trim() === cur) return;
    if (raw.trim() === '') { patchField(t, { estimate: null }); return; }
    const n = Number(raw);
    if (!Number.isFinite(n)) return;
    patchField(t, { estimate: n });
  };

  const blurOnEnter = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
  };

  const bulkIds = [...selected];

  return (
    <div className="space-y-2">
      {selected.size > 0 && (
        <p className="text-xs text-muted-foreground">{selected.size} selected – use the Status / Priority header to bulk edit.</p>
      )}
      <div className="overflow-x-auto rounded-lg border border-border bg-card">
        <table className="w-full min-w-[720px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-border text-left text-xs font-medium text-muted-foreground">
              <th className="w-8 px-2 py-1.5">
                <input type="checkbox" checked={allSelected} onChange={toggleAll} aria-label="Select all" />
              </th>
              <th className="w-20 px-2 py-1.5">Key</th>
              <th className="px-2 py-1.5">Title</th>
              <th className="w-40 px-2 py-1.5">
                {selected.size > 0 ? (
                  <Select className="h-7 w-full text-xs" value="" disabled={bulk.isPending}
                    onChange={(e) => { if (e.target.value) bulk.mutate({ taskIds: bulkIds, statusId: e.target.value }); }}>
                    <option value="">Status: set {selected.size}…</option>
                    {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                ) : 'Status'}
              </th>
              <th className="w-32 px-2 py-1.5">
                {selected.size > 0 ? (
                  <Select className="h-7 w-full text-xs" value="" disabled={bulk.isPending}
                    onChange={(e) => { if (e.target.value) bulk.mutate({ taskIds: bulkIds, priority: e.target.value }); }}>
                    <option value="">Priority: set {selected.size}…</option>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                ) : 'Priority'}
              </th>
              <th className="w-36 px-2 py-1.5">Due date</th>
              <th className="w-24 px-2 py-1.5">Estimate</th>
            </tr>
          </thead>
          <tbody>
            {tasks.map((t) => (
              <tr key={t.id} className={cn('border-b border-border/60 last:border-b-0', selected.has(t.id) && 'bg-muted/40')}>
                <td className="px-2 py-1">
                  <input type="checkbox" checked={selected.has(t.id)} onChange={() => toggle(t.id)} aria-label={`Select ${t.title}`} />
                </td>
                <td className="px-2 py-1">
                  <button onClick={() => onOpenTask(t.id)} title="Open task"
                    className="inline-flex items-center gap-1.5 font-mono text-[11px] text-muted-foreground hover:text-foreground hover:underline">
                    <PriorityIcon priority={t.priority} size={12} />
                    {t.ref ?? (t.number != null ? `#${t.number}` : '–')}
                  </button>
                </td>
                <td className="px-1 py-1">
                  {editing?.id === t.id ? (
                    <input
                      autoFocus
                      className={cn(cellInput, 'border-input ring-1 ring-ring/40')}
                      value={editing.value}
                      onChange={(e) => setEditing({ id: t.id, value: e.target.value })}
                      onBlur={() => commitTitle(t)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitTitle(t);
                        if (e.key === 'Escape') setEditing(null);
                      }}
                    />
                  ) : (
                    <button onClick={() => setEditing({ id: t.id, value: t.title })}
                      className="block h-7 w-full truncate rounded border border-transparent px-1.5 text-left leading-7 hover:border-input">
                      {t.title}
                    </button>
                  )}
                </td>
                <td className="px-1 py-1">
                  <Select className="h-7 w-full text-xs" value={t.statusId} disabled={patch.isPending}
                    onChange={(e) => patchField(t, { statusId: e.target.value })}>
                    {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </Select>
                </td>
                <td className="px-1 py-1">
                  <Select className="h-7 w-full text-xs" value={t.priority ?? 'none'} disabled={patch.isPending}
                    onChange={(e) => patchField(t, { priority: e.target.value })}>
                    {PRIORITIES.map((p) => <option key={p} value={p}>{p}</option>)}
                  </Select>
                </td>
                <td className="px-1 py-1">
                  <DateField
                    size="sm"
                    value={t.dueDate ? t.dueDate.slice(0, 10) : null}
                    onChange={(v) => commitDue(t, v ?? '')}
                  />
                </td>
                <td className="px-1 py-1">
                  <input
                    key={`${t.id}:${t.estimate ?? ''}`}
                    type="number"
                    step="any"
                    min="0"
                    defaultValue={t.estimate == null || t.estimate === '' ? '' : Number(t.estimate)}
                    className={cn(cellInput, 'text-xs tabular-nums')}
                    onBlur={(e) => commitEstimate(t, e.target.value)}
                    onKeyDown={blurOnEnter}
                  />
                </td>
              </tr>
            ))}
            {tasks.length === 0 && (
              <tr><td colSpan={7} className="px-3 py-6 text-center text-sm text-muted-foreground">No tasks yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
