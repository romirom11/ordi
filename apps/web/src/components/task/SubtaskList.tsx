/**
 * Sub-tasks of a task rendered as a Linear-style checklist: the status icon
 * cycles todo→done, rows navigate to the sub-task's own page, quick-add at
 * the bottom. Sub-tasks ARE the checklist – no separate entity.
 */
import { useState } from 'react';
import { CornerDownLeft, Plus, Trash2 } from 'lucide-react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { useNavigate, useOpen } from '../../lib/router';
import { ProgressRing, StatusIcon, Tooltip, cn } from '../ui';
import { toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';
import type { SubtaskRow, TaskStatus } from './types';

extendDict({
  en: {
    'task.subtasks': 'Sub-tasks',
    'task.addSubtask': 'Add a sub-task…',
    'task.subtaskDeleted': 'Sub-task deleted',
  },
  uk: {
    'task.subtasks': 'Підзадачі',
    'task.addSubtask': 'Додати підзадачу…',
    'task.subtaskDeleted': 'Підзадачу видалено',
  },
});

export function SubtaskList({ taskId, projectId, projectKey, statuses }: {
  taskId: string; projectId: string; projectKey?: string; statuses: TaskStatus[];
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const open = useOpen();
  const [draft, setDraft] = useState('');

  const subtasksQ = useQuery({
    queryKey: ['subtasks', taskId],
    queryFn: () => api.get<{ data: SubtaskRow[] }>(`/tasks?projectId=${projectId}`)
      .then((r) => r.data.filter((x) => x.parentId === taskId)),
  });
  const subtasks = subtasksQ.data ?? [];

  const statusById = new Map(statuses.map((s) => [s.id, s]));
  const doneStatus = statuses.find((s) => s.category === 'done');
  const openStatus = statuses.find((s) => s.isDefault)
    ?? statuses.find((s) => s.category === 'todo')
    ?? statuses[0];
  const doneCount = subtasks.filter((s) => statusById.get(s.statusId)?.category === 'done').length;

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['subtasks', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['me-tasks'] });
  };
  const onError = (e: Error) => {
    toast.error(e instanceof ApiError ? e.message : t('common.error'));
    invalidate();
  };

  const createSub = useMutation({
    mutationFn: (title: string) => api.post('/tasks', { projectId, title, parentId: taskId }),
    onSuccess: () => { setDraft(''); invalidate(); },
    onError,
  });

  const toggleSub = useMutation({
    mutationFn: (sub: SubtaskRow) => {
      const isDone = statusById.get(sub.statusId)?.category === 'done';
      const target = isDone ? openStatus : doneStatus;
      if (!target) return Promise.resolve(null);
      return api.patch(`/tasks/${sub.id}`, { statusId: target.id, version: sub.version });
    },
    onSuccess: invalidate,
    onError,
  });

  const deleteSub = useMutation({
    mutationFn: (id: string) => api.del(`/tasks/${id}`),
    onSuccess: () => { toast(t('task.subtaskDeleted')); invalidate(); },
    onError,
  });

  return (
    <section>
      <div className="mb-1 flex items-center gap-2">
        <h2 className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('task.subtasks')}</h2>
        {subtasks.length > 0 && (
          <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <ProgressRing value={(doneCount / subtasks.length) * 100} size={14} color={doneCount === subtasks.length ? '#22c55e' : undefined} />
            <span className="tabular-nums">{doneCount}/{subtasks.length}</span>
          </span>
        )}
      </div>

      <div className="overflow-hidden rounded-lg border border-border">
        {subtasks.map((sub, i) => {
          const st = statusById.get(sub.statusId);
          const isDone = st?.category === 'done';
          return (
            <div
              key={sub.id}
              className={cn(
                'group row-enter flex h-8 cursor-pointer items-center gap-2 px-2 transition-colors duration-150 hover:bg-muted',
                i > 0 && 'border-t border-border',
              )}
              style={{ ['--i' as string]: Math.min(i, 10) }}
              onClick={(e) => open(`/projects/${projectId}/tasks/${sub.id}`, e)}
              onAuxClick={(e) => open(`/projects/${projectId}/tasks/${sub.id}`, e)}
            >
              <button
                aria-label={st?.name}
                className="grid h-5 w-5 shrink-0 place-items-center rounded transition-transform duration-150 hover:scale-110"
                onClick={(e) => { e.stopPropagation(); toggleSub.mutate(sub); }}
              >
                <StatusIcon category={st?.category} color={st?.color} />
              </button>
              {projectKey && sub.number != null && (
                <span className="shrink-0 font-mono text-[11px] text-faint">{projectKey}-{sub.number}</span>
              )}
              <span className={cn('min-w-0 flex-1 truncate text-[13px]', isDone && 'text-muted-foreground line-through decoration-border-strong')}>
                {sub.title}
              </span>
              <Tooltip label={t('common.delete')}>
                <button
                  aria-label={t('common.delete')}
                  className="grid h-6 w-6 place-items-center rounded text-faint opacity-0 transition-all duration-150 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                  onClick={(e) => { e.stopPropagation(); deleteSub.mutate(sub.id); }}
                >
                  <Trash2 size={13} />
                </button>
              </Tooltip>
            </div>
          );
        })}

        {/* Quick add */}
        <div className={cn('flex h-8 items-center gap-2 px-2', subtasks.length > 0 && 'border-t border-border')}>
          <Plus size={14} className="shrink-0 text-faint" />
          <input
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && draft.trim() && !createSub.isPending) createSub.mutate(draft.trim());
            }}
            placeholder={t('task.addSubtask')}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint focus-visible:outline-none"
          />
          {draft.trim() && (
            <span className="anim-fade-in flex items-center gap-1 text-[11px] text-faint">
              <CornerDownLeft size={11} /> {t('common.create')}
            </span>
          )}
        </div>
      </div>
    </section>
  );
}
