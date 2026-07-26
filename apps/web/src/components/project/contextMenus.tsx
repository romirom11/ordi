import { useState, type ReactNode } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Copy, ExternalLink, Link2, Settings, Trash2 } from 'lucide-react';
import { appOrigin, api, ApiError } from '../../lib/api';
import { useNavigate } from '../../lib/router';
import { useTabs } from '../../lib/tabs';
import { StatusIcon, PriorityIcon } from '../ui';
import { ContextMenu, ConfirmDialog, toast, type ContextMenuEntry } from '../overlays';
import { PROJECT_STATUSES, STATUS_META } from './pickers';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'ctx.openNewTab': 'Open in new tab',
    'ctx.copyLink': 'Copy link',
    'ctx.copyRef': 'Copy reference',
    'ctx.openSettings': 'Open settings',
    'ctx.linkCopied': 'Link copied',
    'ctx.refCopied': 'Reference copied',
    'ctx.deleteProject': 'Delete project',
    'ctx.deleteProjectBody': 'This permanently deletes the project and its tasks. This cannot be undone.',
    'ctx.deleteTask': 'Delete task',
    'ctx.deleteTaskBody': 'This permanently deletes the task. This cannot be undone.',
    'ctx.projectDeleted': 'Project deleted',
    'ctx.taskDeleted': 'Task deleted',
    'ctx.priorityUrgent': 'Urgent',
    'ctx.priorityHigh': 'High',
    'ctx.priorityMedium': 'Medium',
    'ctx.priorityLow': 'Low',
    'ctx.priorityNone': 'No priority',
  },
  uk: {
    'ctx.openNewTab': 'Відкрити в новій вкладці',
    'ctx.copyLink': 'Копіювати посилання',
    'ctx.copyRef': 'Копіювати ідентифікатор',
    'ctx.openSettings': 'Відкрити налаштування',
    'ctx.linkCopied': 'Посилання скопійовано',
    'ctx.refCopied': 'Ідентифікатор скопійовано',
    'ctx.deleteProject': 'Видалити проєкт',
    'ctx.deleteProjectBody': 'Проєкт і всі його задачі буде видалено назавжди. Цю дію не можна скасувати.',
    'ctx.deleteTask': 'Видалити задачу',
    'ctx.deleteTaskBody': 'Задачу буде видалено назавжди. Цю дію не можна скасувати.',
    'ctx.projectDeleted': 'Проєкт видалено',
    'ctx.taskDeleted': 'Задачу видалено',
    'ctx.priorityUrgent': 'Терміново',
    'ctx.priorityHigh': 'Високий',
    'ctx.priorityMedium': 'Середній',
    'ctx.priorityLow': 'Низький',
    'ctx.priorityNone': 'Без пріоритету',
  },
});

const PRIORITY_ORDER = ['urgent', 'high', 'medium', 'low', 'none'] as const;
const PRIORITY_KEY: Record<string, string> = {
  urgent: 'ctx.priorityUrgent', high: 'ctx.priorityHigh', medium: 'ctx.priorityMedium',
  low: 'ctx.priorityLow', none: 'ctx.priorityNone',
};

function copyToClipboard(text: string, okMsg: string) {
  navigator.clipboard?.writeText(text).then(() => toast(okMsg)).catch(() => toast.error(text));
}

function Dot({ color }: { color: string }) {
  return <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: color }} />;
}

/* ───────────────────────── Project row / header menu ───────────────────────── */

export interface ProjectMenuTarget {
  id: string; name: string; key?: string; status: string; version?: number;
}

export function ProjectContextMenu({ project, canWrite, canDelete, onDeleted, children, className }: {
  project: ProjectMenuTarget; canWrite: boolean; canDelete: boolean;
  onDeleted?: () => void; children: ReactNode; className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tabs = useTabs();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const setStatus = useMutation({
    mutationFn: (status: string) => api.patch(`/projects/${project.id}`, { status, version: project.version }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['project', project.id] }); qc.invalidateQueries({ queryKey: ['projects'] }); },
    onError: (e) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        qc.invalidateQueries({ queryKey: ['project', project.id] });
        toast.error(t('projects.conflict'));
      } else toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
  });

  const del = useMutation({
    mutationFn: () => api.del(`/projects/${project.id}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['projects'] });
      toast(t('ctx.projectDeleted'));
      setConfirmOpen(false);
      onDeleted?.();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const meta = STATUS_META[project.status] ?? { color: '#8a8f98', key: '' };
  const url = `/projects/${project.id}`;

  const items: ContextMenuEntry[] = [];
  if (canWrite) {
    items.push({
      key: 'status', label: t('common.status'), icon: <Dot color={meta.color} />,
      children: PROJECT_STATUSES.map((s) => ({
        key: s, label: t(STATUS_META[s]!.key), icon: <Dot color={STATUS_META[s]!.color} />,
        onSelect: () => { if (s !== project.status) setStatus.mutate(s); },
      })),
    });
    items.push({ type: 'separator' });
  }
  items.push({ key: 'newtab', label: t('ctx.openNewTab'), icon: <ExternalLink size={15} />, onSelect: () => tabs?.openInNewTab(url) });
  items.push({ key: 'copy', label: t('ctx.copyLink'), icon: <Link2 size={15} />, onSelect: () => copyToClipboard(appOrigin() + url, t('ctx.linkCopied')) });
  items.push({ type: 'separator' });
  items.push({ key: 'settings', label: t('ctx.openSettings'), icon: <Settings size={15} />, onSelect: () => navigate(`${url}?section=settings`) });
  if (canDelete) {
    items.push({ type: 'separator' });
    items.push({ key: 'delete', label: t('ctx.deleteProject'), icon: <Trash2 size={15} />, danger: true, onSelect: () => setConfirmOpen(true) });
  }

  return (
    <>
      <ContextMenu items={items} className={className}>{children}</ContextMenu>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => del.mutate()}
        title={project.name}
        body={t('ctx.deleteProjectBody')}
        confirmLabel={t('ctx.deleteProject')}
        danger
        pending={del.isPending}
      />
    </>
  );
}

/* ───────────────────────── Task row menu ───────────────────────── */

export interface TaskMenuTarget {
  id: string; number?: number; ref?: string; statusId: string; priority?: string; version?: number;
}
export interface TaskStatusLite { id: string; name: string; category?: string; color?: string }

function taskRef(task: TaskMenuTarget, projectKey?: string): string {
  if (task.ref) return task.ref;
  if (task.number == null) return '';
  return projectKey ? `${projectKey}-${task.number}` : `#${task.number}`;
}

export function TaskContextMenu({ task, projectId, projectKey, statuses, canWrite, children, className }: {
  task: TaskMenuTarget; projectId: string; projectKey?: string; statuses: TaskStatusLite[];
  canWrite: boolean; children: ReactNode; className?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const tabs = useTabs();
  const [confirmOpen, setConfirmOpen] = useState(false);

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/tasks/${task.id}`, { ...body, version: task.version }),
    onMutate: async (body) => {
      await qc.cancelQueries({ queryKey: ['tasks', projectId] });
      const prev = qc.getQueryData(['tasks', projectId]);
      qc.setQueryData<TaskMenuTarget[]>(['tasks', projectId], (old) => (old ?? []).map((x) => x.id === task.id ? { ...x, ...body } : x));
      return { prev };
    },
    onError: (e, _v, ctx) => {
      if (ctx?.prev) qc.setQueryData(['tasks', projectId], ctx.prev);
      toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ['tasks', projectId] }),
  });

  const del = useMutation({
    mutationFn: () => api.del(`/tasks/${task.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['tasks', projectId] }); toast(t('ctx.taskDeleted')); setConfirmOpen(false); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const current = statuses.find((s) => s.id === task.statusId);
  const ref = taskRef(task, projectKey);
  const priority = task.priority ?? 'none';

  const items: ContextMenuEntry[] = [];
  if (canWrite) {
    items.push({
      key: 'status', label: t('common.status'),
      icon: <StatusIcon category={current?.category} color={current?.color} size={15} />,
      children: statuses.map((s) => ({
        key: s.id, label: s.name, icon: <StatusIcon category={s.category} color={s.color} size={15} />,
        onSelect: () => { if (s.id !== task.statusId) patch.mutate({ statusId: s.id }); },
      })),
    });
    items.push({
      key: 'priority', label: t('tasks.priority'),
      icon: <PriorityIcon priority={priority} size={15} />,
      children: PRIORITY_ORDER.map((p) => ({
        key: p, label: t(PRIORITY_KEY[p]!), icon: <PriorityIcon priority={p} size={15} />,
        onSelect: () => { if (p !== priority) patch.mutate({ priority: p }); },
      })),
    });
    items.push({ type: 'separator' });
  }
  items.push({ key: 'newtab', label: t('ctx.openNewTab'), icon: <ExternalLink size={15} />, onSelect: () => tabs?.openInNewTab(`/projects/${projectId}/tasks/${task.id}`) });
  if (ref) items.push({ key: 'copyref', label: t('ctx.copyRef'), icon: <Copy size={15} />, onSelect: () => copyToClipboard(ref, t('ctx.refCopied')) });
  if (canWrite) {
    items.push({ type: 'separator' });
    items.push({ key: 'delete', label: t('ctx.deleteTask'), icon: <Trash2 size={15} />, danger: true, onSelect: () => setConfirmOpen(true) });
  }

  return (
    <>
      <ContextMenu items={items} className={className}>{children}</ContextMenu>
      <ConfirmDialog
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        onConfirm={() => del.mutate()}
        title={ref || t('ctx.deleteTask')}
        body={t('ctx.deleteTaskBody')}
        confirmLabel={t('ctx.deleteTask')}
        danger
        pending={del.isPending}
      />
    </>
  );
}
