/**
 * Full-page task view (Linear-style). Route: /projects/:id/tasks/:taskId
 * Two columns: main content (title, description, sub-tasks, activity) and a
 * properties sidebar. Every edit PATCHes with the optimistic-lock version.
 * Property pickers refetch + toast on a conflict; the title and description
 * are typed text and go through a local draft (lib/useDraftSync) that is
 * kept until the server acknowledges it and never replaced by a conflict.
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, ChevronRight, Copy, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { usePageTitle } from '../lib/tabs';
import { useTaskStatuses, useUsersLookup } from '../lib/queries';
import { useMe, useProjectRole } from '../lib/auth';
import { draftStorageKey } from '../lib/draftSync';
import { useDraftSync } from '../lib/useDraftSync';
import { DraftConflictBanner, DraftStatusLine } from '../components/DraftStatus';
import { RichText } from '../components/richtext/RichText';
import { Button, EmptyState, IconButton, Kbd, Skeleton, Tooltip } from '../components/ui';
import { toast } from '../components/overlays';
import { RichEditor, EMPTY_DOC } from '../components/richtext/RichEditor';
import { PropertySidebar } from '../components/task/PropertySidebar';
import { RailResizeHandle, useRailWidth } from '../components/RailResize';
import { CustomFieldsSection } from '../components/crm/CustomFieldsSection';
import { SubtaskList } from '../components/task/SubtaskList';
import { ActivityFeed } from '../components/task/CommentThread';
import { AgentRunsBlock } from '../components/task/AgentRunsBlock';
import type { TaskDetail, TaskPatch, UserLite } from '../components/task/types';
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

interface ProjectLite { id: string; name: string; key: string; visibility?: 'workspace' | 'private' }

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

/** Typed text of a task: kept as a local draft until the server has it. */
type TaskText = { title: string; description: unknown };

const isConflict = (e: unknown) => e instanceof ApiError && (e.status === 409 || e.code === 'conflict');

/** One instance per task: its draft, timers and title state never carry over to the next one. */
export function TaskPage(props: { projectId: string; taskId: string }) {
  return <TaskPageView key={props.taskId} {...props} />;
}

function TaskPageView({ projectId, taskId }: { projectId: string; taskId: string }) {
  const t = useT();
  const me = useMe();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const rail = useRailWidth('task', 256);

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
  const statusesQ = useTaskStatuses(projectId);
  const usersQ = useUsersLookup();

  const task = taskQ.data;
  const project = projectQ.data;
  const statuses = statusesQ.data ?? [];
  const refLabel = task?.ref ?? (project && task ? `${project.key}-${task.number}` : '');
  const hasRepos = (reposQ.data ?? []).length > 0;
  // Same rule the project board uses: members and admins write tasks. Agent
  // runs borrow it for cancel/retry (agents.manage also unlocks them).
  const projectRole = useProjectRole(projectId, project?.visibility);
  const canWriteTasks = projectRole === 'admin' || projectRole === 'member';
  const hasAgentAssignee = (task?.assignees ?? []).some(
    (a) => (usersQ.data ?? []).find((u) => u.id === a.userId)?.actorType === 'agent',
  );

  usePageTitle(task ? `${refLabel} ${task.title}` : null);

  /* ── Patch mutation (version-aware) ── */
  const applySaved = (resp: TaskDetail) => {
    qc.setQueryData<TaskDetail>(['task', taskId], (old) => {
      if (!old || (old.version ?? 0) > (resp.version ?? 0)) return old;
      return { ...old, ...resp, assignees: old.assignees, labels: old.labels, comments: old.comments };
    });
    qc.invalidateQueries({ queryKey: ['task', taskId] });
    qc.invalidateQueries({ queryKey: ['task-audit', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks'] });
    qc.invalidateQueries({ queryKey: ['me-tasks'] });
    qc.invalidateQueries({ queryKey: ['me', 'tasks'] });
    qc.invalidateQueries({ queryKey: ['subtasks'] });
  };
  const patchM = useMutation({
    mutationFn: (patch: TaskPatch) => {
      const cur = qc.getQueryData<TaskDetail>(['task', taskId]);
      return api.patch<TaskDetail>(`/tasks/${taskId}`, { ...patch, version: cur?.version ?? task?.version });
    },
    onSuccess: (resp) => applySaved(resp),
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

  /* ── Title + description: one local draft, saved in the background ── */
  const [savedThisVisit, setSavedThisVisit] = useState(false);
  const text = useDraftSync<TaskText, TaskDetail>({
    storageKey: draftStorageKey(me.user.id, 'task', taskId),
    snapshot: taskQ.data,
    fields: (d) => ({ title: d.title, description: d.description ?? EMPTY_DOC }),
    version: (d) => d.version,
    send: (body, version) => api.patch<TaskDetail>(`/tasks/${taskId}`, { ...body, version }),
    isConflict,
    refresh: () => taskQ.refetch({ throwOnError: true }),
    autosave: true,
    onSaved: (resp) => { applySaved(resp); setSavedThisVisit(true); },
  });
  const textRef = useRef(text);
  textRef.current = text;

  /* Title: a borderless auto-growing textarea, committed to the draft on blur/Enter */
  const title = text.draft?.title ?? task?.title ?? '';
  const titleRef = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const el = titleRef.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${el.scrollHeight}px`;
  }, [title, task]);
  const saveTitle = () => {
    const next = title.trim();
    if (!next) { text.edit({ title: text.server?.title ?? task?.title ?? '' }); return; }
    if (next !== title) text.edit({ title: next });
    void text.save({ auto: true });
  };

  /* Description: debounced save of the draft */
  const descTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushDescription = useCallback(() => {
    if (descTimer.current) { clearTimeout(descTimer.current); descTimer.current = null; }
    void textRef.current.save({ auto: true });
  }, []);
  const onDescChange = (doc: unknown) => {
    text.edit({ description: doc });
    if (descTimer.current) clearTimeout(descTimer.current);
    descTimer.current = setTimeout(flushDescription, 800);
  };
  // Leaving the page sends what is pending; if that fails the stored draft
  // brings it back on return.
  useEffect(() => () => { if (descTimer.current) flushDescription(); }, [flushDescription]);

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
          <DraftStatusLine
            className="mr-1"
            status={text.status}
            persisted={text.persisted}
            error={text.error}
            quietWhenSaved={!savedThisVisit}
            onRetry={() => { void text.save(); }}
            onSave={() => { void text.save(); }}
            onDiscard={text.discard}
          />
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
            {text.status === 'conflict' && text.server && (
              <DraftConflictBanner
                what={t('draft.whatTask', 'task')}
                onKeepMine={text.keepMine}
                onTakeTheirs={text.takeTheirs}
                theirs={(
                  <div className="space-y-2">
                    <p className="text-[15px] font-semibold">{text.server.title}</p>
                    <RichText doc={text.server.description} className="text-[13px]" />
                  </div>
                )}
              />
            )}
            {/* Title */}
            <textarea
              ref={titleRef}
              rows={1}
              value={title}
              placeholder={t('tasks.title')}
              aria-label={t('tasks.title')}
              onChange={(e) => text.edit({ title: e.target.value })}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); (e.target as HTMLTextAreaElement).blur(); }
              }}
              className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold leading-snug outline-none placeholder:text-faint focus-visible:outline-none"
            />

            {/* Description */}
            <div className="task-desc mt-1" onBlur={flushDescription}>
              <RichEditor
                value={text.draft?.description ?? task.description ?? EMPTY_DOC}
                onChange={onDescChange}
                placeholder={t('tasks.addDescription')}
                compact
              />
            </div>

            <div className="mt-6">
              <CustomFieldsSection
                entityType="tasks"
                projectId={projectId}
                values={task.customFields}
                editable
                collapsible
                onSave={(customFields) => patch({ customFields })}
              />
            </div>

            <div className="my-6 h-px bg-border" />

            <SubtaskList taskId={taskId} projectId={projectId} projectKey={project?.key} statuses={statuses} />

            <div className="my-6 h-px bg-border" />

            <AgentRunsBlock taskId={taskId} canWrite={canWriteTasks} showWhenEmpty={hasAgentAssignee} />

            <ActivityFeed taskId={taskId} comments={task.comments ?? []} users={usersQ.data ?? []} projectRole={projectRole} />
          </div>
        </div>

        {/* Properties sidebar – width is user-draggable, see RailResize */}
        <aside style={rail.railStyle} className="anim-fade-in relative shrink-0 border-t border-border bg-surface min-[1100px]:w-[var(--rail-w)] min-[1100px]:overflow-y-auto min-[1100px]:border-l min-[1100px]:border-t-0">
          <RailResizeHandle width={rail.width} base={rail.base} onWidth={rail.onWidth} className="min-[1100px]:block" />
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
