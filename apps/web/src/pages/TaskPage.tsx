/**
 * Full-page task view (Linear-style). Route: /projects/:id/tasks/:taskId
 * Two columns: main content (title, description, sub-tasks, activity) and a
 * properties sidebar. Every edit PATCHes with the optimistic-lock version;
 * conflicts refetch + toast.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Copy, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { usePageTitle } from '../lib/tabs';
import { useUsersLookup } from '../lib/queries';
import { Button, EmptyState, IconButton, Kbd, Skeleton, Tooltip } from '../components/ui';
import { toast } from '../components/overlays';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { PropertySidebar } from '../components/task/PropertySidebar';
import { SubtaskList } from '../components/task/SubtaskList';
import { ActivityFeed } from '../components/task/CommentThread';
import type { TaskDetail, TaskPatch, TaskStatus, UserLite } from '../components/task/types';
import { useT, extendDict } from '../lib/i18n';
import '../components/task/task.css';

extendDict({
  en: {
    'task.copied': 'Copied',
    'task.copyRef': 'Copy ID',
    'task.conflict': 'This task was updated elsewhere – reloaded the latest version.',
    'task.backToProject': 'Back to project',
    'task.description': 'Description',
  },
  uk: {
    'task.copied': 'Скопійовано',
    'task.copyRef': 'Копіювати ID',
    'task.conflict': 'Задачу оновили в іншому місці – завантажено останню версію.',
    'task.backToProject': 'Назад до проєкту',
    'task.description': 'Опис',
  },
});

interface ProjectLite { id: string; name: string; key: string }

function TaskSkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-4">
        <Skeleton className="h-4 w-32" />
        <Skeleton className="h-4 w-14" />
      </div>
      <div className="flex min-h-0 flex-1">
        <div className="flex-1">
          <div className="mx-auto w-full max-w-[760px] space-y-6 px-8 py-7">
            <Skeleton className="h-8 w-2/3" />
            <div className="space-y-2">
              <Skeleton className="h-3.5 w-full" />
              <Skeleton className="h-3.5 w-11/12" />
              <Skeleton className="h-3.5 w-1/2" />
            </div>
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-20 w-full" />
          </div>
        </div>
        <aside className="hidden w-64 shrink-0 space-y-3 border-l border-border p-4 min-[1100px]:block">
          {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-6 w-full" />)}
        </aside>
      </div>
    </div>
  );
}

export function TaskPage({ projectId, taskId }: { projectId: string; taskId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const taskQ = useQuery({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}?include=assignees,labels,relations,links,comments,git_links`),
  });
  const reposQ = useQuery({
    queryKey: ['project-repos', projectId],
    queryFn: () => api.get<{ data: unknown[] }>(`/projects/${projectId}/repositories`).then((r) => r.data),
    staleTime: 60_000,
  });
  const projectQ = useQuery({
    queryKey: ['project', projectId],
    queryFn: () => api.get<ProjectLite>(`/projects/${projectId}`),
  });
  const statusesQ = useQuery({
    queryKey: ['task-statuses', projectId],
    queryFn: () => api.get<{ data: TaskStatus[] }>(`/projects/${projectId}/task-statuses`).then((r) => r.data),
  });
  const usersQ = useUsersLookup();

  const task = taskQ.data;
  const project = projectQ.data;
  const statuses = statusesQ.data ?? [];
  const refLabel = task?.ref ?? (project && task ? `${project.key}-${task.number}` : '');
  const hasRepos = (reposQ.data ?? []).length > 0;

  usePageTitle(task ? `${refLabel} ${task.title}` : null);

  /* ── Patch mutation (version-aware) ── */
  const patchM = useMutation({
    mutationFn: (patch: TaskPatch) => {
      const cur = qc.getQueryData<TaskDetail>(['task', taskId]);
      return api.patch<TaskDetail>(`/tasks/${taskId}`, { ...patch, version: cur?.version ?? task?.version });
    },
    onSuccess: (resp) => {
      qc.setQueryData<TaskDetail>(['task', taskId], (old) => (old ? {
        ...old,
        ...resp,
        assignees: old.assignees,
        labels: old.labels,
        comments: old.comments,
      } : old));
      qc.invalidateQueries({ queryKey: ['task', taskId] });
      qc.invalidateQueries({ queryKey: ['task-audit', taskId] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['me-tasks'] });
      qc.invalidateQueries({ queryKey: ['subtasks'] });
    },
    onError: (e: Error) => {
      if (e instanceof ApiError && (e.status === 409 || e.code === 'conflict')) {
        toast.error(t('task.conflict'));
      } else {
        toast.error(e instanceof ApiError ? e.message : t('common.saveFailed'));
      }
      qc.invalidateQueries({ queryKey: ['task', taskId] });
    },
  });
  const patch = useCallback((p: TaskPatch) => patchM.mutate(p), [patchM]);

  /* ── Title (borderless auto-growing textarea) ── */
  const [title, setTitle] = useState('');
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (task && document.activeElement !== titleRef.current) setTitle(task.title);
  }, [task?.title, task]);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, task]);
  const saveTitle = () => {
    const next = title.trim();
    if (!task) return;
    if (!next) { setTitle(task.title); return; }
    if (next !== task.title) patch({ title: next });
  };

  /* ── Description (debounced save) ── */
  const descRef = useRef<unknown>(null);
  const savedDescRef = useRef<string>('');
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (task) {
      descRef.current = task.description ?? EMPTY_DOC;
      savedDescRef.current = JSON.stringify(task.description ?? EMPTY_DOC);
    }
    // Only reset the baseline when a different task loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);
  const flushDescription = useCallback(() => {
    if (descTimer.current) { clearTimeout(descTimer.current); descTimer.current = null; }
    const json = JSON.stringify(descRef.current ?? EMPTY_DOC);
    if (descRef.current != null && json !== savedDescRef.current) {
      savedDescRef.current = json;
      patch({ description: descRef.current });
    }
  }, [patch]);
  const onDescChange = (doc: unknown) => {
    descRef.current = doc;
    if (descTimer.current) clearTimeout(descTimer.current);
    descTimer.current = setTimeout(flushDescription, 800);
  };

  /* ── Esc → back to project ── */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) { el.blur(); return; }
      if (document.querySelector('[role="menu"], [role="dialog"]')) return; // overlay handles it
      navigate(`/projects/${projectId}`);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [navigate, projectId]);

  const copyRef = async () => {
    try {
      await navigator.clipboard.writeText(refLabel);
      toast(t('task.copied'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  if (taskQ.isLoading) return <TaskSkeleton />;
  if (taskQ.isError || !task) {
    return (
      <EmptyState
        icon={<AlertTriangle size={20} />}
        title={t('tasks.loadFailed')}
        action={<Button size="sm" variant="outline" onClick={() => navigate(`/projects/${projectId}`)}>{t('task.backToProject')}</Button>}
      />
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Top bar: breadcrumb + actions */}
      <div className="flex h-11 shrink-0 items-center justify-between gap-2 border-b border-border px-4">
        <nav className="flex min-w-0 items-center gap-1.5 text-[13px]">
          <Link
            to={`/projects/${projectId}`}
            className="max-w-[280px] truncate text-muted-foreground transition-colors duration-150 hover:text-foreground"
          >
            {project?.name ?? '…'}
          </Link>
          <ChevronRight size={13} className="shrink-0 text-faint" />
          <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{refLabel}</span>
        </nav>
        <div className="flex shrink-0 items-center gap-1">
          <Tooltip label={t('task.copyRef')}>
            <IconButton size="sm" aria-label={t('task.copyRef')} onClick={copyRef}><Copy size={13} /></IconButton>
          </Tooltip>
          <Tooltip label={<span className="flex items-center gap-1.5">{t('task.backToProject')} <Kbd>Esc</Kbd></span>}>
            <IconButton size="sm" aria-label={t('task.backToProject')} onClick={() => navigate(`/projects/${projectId}`)}>
              <X size={14} />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {/* Two columns */}
      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto min-[1100px]:flex-row min-[1100px]:overflow-hidden">
        <div className="min-[1100px]:min-h-0 min-[1100px]:flex-1 min-[1100px]:overflow-y-auto">
          <div className="page-enter mx-auto w-full max-w-[760px] px-8 pb-10 pt-7">
            {/* Title */}
            <textarea
              ref={titleRef}
              rows={1}
              value={title}
              placeholder={t('tasks.title')}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
              }}
              className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-faint focus-visible:outline-none"
            />

            {/* Description */}
            <div className="task-desc mt-1" onBlur={flushDescription}>
              <RichEditor
                value={task.description ?? EMPTY_DOC}
                onChange={onDescChange}
                placeholder={t('tasks.addDescription')}
                compact
              />
            </div>

            <div className="my-6 h-px bg-border" />

            <SubtaskList taskId={taskId} projectId={projectId} projectKey={project?.key} statuses={statuses} />

            <div className="my-6 h-px bg-border" />

            <ActivityFeed taskId={taskId} comments={task.comments ?? []} users={usersQ.data ?? []} />
          </div>
        </div>

        {/* Properties sidebar */}
        <aside className="anim-fade-in shrink-0 border-t border-border bg-surface min-[1100px]:w-64 min-[1100px]:overflow-y-auto min-[1100px]:border-l min-[1100px]:border-t-0">
          <PropertySidebar
            task={task}
            statuses={statuses}
            users={usersQ.data ?? []}
            onPatch={patch}
            hasRepos={hasRepos}
          />
        </aside>
      </div>
    </div>
  );
}
