import { useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { X, List, Columns3, Plus, MessageSquare } from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { Button, Input, Textarea, Select, Card, Badge, Skeleton, EmptyState, Spinner, fmtDate, cn } from '../components/ui';

interface Project {
  id: string; name: string; key: string; status: string; kind?: string;
  companyName?: string | null; description?: unknown; version?: number;
}
interface TaskStatus {
  id: string; name: string; category?: string; color?: string; position?: number; isDefault?: boolean;
}
interface Task {
  id: string; number?: number; title: string; statusId: string; priority?: string;
  assignees?: { id: string; name?: string }[];
}
interface Comment {
  id: string; body?: unknown; authorName?: string; createdAt?: string;
}
interface TaskDetail extends Task {
  description?: unknown; version?: number; labels?: { id: string; name: string; color?: string }[]; comments?: Comment[];
}
interface Cycle {
  id: string; name: string; startDate?: string; endDate?: string; status?: string; goal?: string;
  progress?: number; completedCount?: number; totalCount?: number; openCount?: number;
}

const PRIORITY_COLOR: Record<string, string> = {
  urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', none: '#9ca3af',
};
const PROJECT_STATUS = ['active', 'paused', 'completed', 'archived'];

function docToText(body: unknown): string {
  if (!body) return '';
  if (typeof body === 'string') return body;
  const walk = (node: unknown): string => {
    const n = node as { text?: string; content?: unknown[] } | null;
    if (!n) return '';
    if (typeof n.text === 'string') return n.text;
    if (Array.isArray(n.content)) return n.content.map(walk).join('');
    return '';
  };
  const b = body as { content?: unknown[] };
  if (Array.isArray(b.content)) return b.content.map((n) => walk(n)).join('\n');
  return walk(body);
}
function textToDoc(text: string) {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : [],
    })),
  };
}

const TABS = ['tasks', 'cycles', 'overview', 'settings'] as const;
type Tab = typeof TABS[number];

export function ProjectDetailPage({ id, taskId }: { id: string; taskId?: string }) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<Tab>('tasks');
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(taskId ?? null);

  useEffect(() => { setSelectedTaskId(taskId ?? null); }, [taskId]);

  const projectQ = useQuery<Project>({ queryKey: ['project', id], queryFn: () => api.get<Project>(`/projects/${id}`) });
  const statusesQ = useQuery<TaskStatus[]>({ queryKey: ['task-statuses', id], queryFn: () => api.get<TaskStatus[]>(`/projects/${id}/task-statuses`) });

  const statuses = (statusesQ.data ?? []).slice().sort((a, b) => (a.position ?? 0) - (b.position ?? 0));
  const project = projectQ.data;

  const openTask = (tid: string) => { setSelectedTaskId(tid); navigate(`/projects/${id}/tasks/${tid}`); };
  const closeTask = () => { setSelectedTaskId(null); navigate(`/projects/${id}`); };

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-border px-6 pt-4">
        <div className="mb-3 flex items-center gap-2">
          <Badge className="bg-muted font-mono text-muted-foreground">{project?.key ?? '…'}</Badge>
          <h1 className="text-lg font-semibold">{projectQ.isLoading ? <Skeleton className="h-5 w-40" /> : project?.name}</h1>
          {project?.status && <Badge className="bg-muted text-muted-foreground capitalize">{project.status}</Badge>}
          {project?.companyName && <span className="text-sm text-muted-foreground">· {project.companyName}</span>}
        </div>
        <nav className="flex gap-1 text-sm">
          {TABS.map((t) => (
            <button key={t} onClick={() => setTab(t)}
              className={cn('rounded-t-md px-3 py-1.5 capitalize', tab === t ? 'border-b-2 border-primary font-medium' : 'text-muted-foreground hover:text-foreground')}>
              {t}
            </button>
          ))}
        </nav>
      </div>

      <div className="flex-1 overflow-auto">
        {tab === 'tasks' && <TasksTab id={id} statuses={statuses} statusesLoading={statusesQ.isLoading} onOpen={openTask} />}
        {tab === 'cycles' && <CyclesTab id={id} />}
        {tab === 'overview' && <OverviewTab id={id} statuses={statuses} project={project} />}
        {tab === 'settings' && <SettingsTab project={project} />}
      </div>

      {selectedTaskId && (
        <TaskPeek key={selectedTaskId} taskId={selectedTaskId} projectId={id} projectKey={project?.key} statuses={statuses} onClose={closeTask} />
      )}
    </div>
  );
}

/* ---------------- Tasks ---------------- */

function TasksTab({ id, statuses, statusesLoading, onOpen }: {
  id: string; statuses: TaskStatus[]; statusesLoading: boolean; onOpen: (tid: string) => void;
}) {
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');
  const [view, setView] = useState<'list' | 'board'>('list');

  const tasksQ = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => api.get<Task[]>(`/tasks${qs({ projectId: id })}`) });
  const tasks = tasksQ.data ?? [];

  const addTask = useMutation({
    mutationFn: (vars: { title: string; statusId?: string }) => api.post('/tasks', { projectId: id, title: vars.title, statusId: vars.statusId }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['tasks', id] }),
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not create task.'),
  });

  const byStatus = (sid: string) => tasks.filter((t) => t.statusId === sid);
  const loading = statusesLoading || tasksQ.isLoading;

  return (
    <div className="p-6">
      <div className="mb-4 flex items-center gap-1">
        <div className="inline-flex overflow-hidden rounded-md border border-border">
          <button onClick={() => setView('list')} className={cn('flex items-center gap-1 px-2.5 py-1 text-xs', view === 'list' ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}>
            <List size={13} /> List
          </button>
          <button onClick={() => setView('board')} className={cn('flex items-center gap-1 border-l border-border px-2.5 py-1 text-xs', view === 'board' ? 'bg-muted font-medium' : 'text-muted-foreground hover:bg-muted/60')}>
            <Columns3 size={13} /> Board
          </button>
        </div>
      </div>

      {loading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-9" />)}</div>
      ) : statuses.length === 0 ? (
        <EmptyState title="No workflow yet" hint="This project has no task statuses. Configure a workflow to start adding tasks." />
      ) : view === 'list' ? (
        <ListView statuses={statuses} byStatus={byStatus} onOpen={onOpen} canWrite={canWrite} onAdd={(title, statusId) => addTask.mutate({ title, statusId })} />
      ) : (
        <BoardView statuses={statuses} byStatus={byStatus} onOpen={onOpen} canWrite={canWrite} onAdd={(title, statusId) => addTask.mutate({ title, statusId })} />
      )}
    </div>
  );
}

function TaskRow({ t, onOpen }: { t: Task; onOpen: (tid: string) => void }) {
  return (
    <button onClick={() => onOpen(t.id)} className="flex w-full items-center gap-2.5 px-3 py-2 text-left text-sm hover:bg-muted">
      <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_COLOR[t.priority ?? 'none'] ?? PRIORITY_COLOR.none }} />
      {t.number != null && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">#{t.number}</span>}
      <span className="flex-1 truncate">{t.title}</span>
      {t.assignees && t.assignees.length > 0 && (
        <span className="shrink-0 text-xs text-muted-foreground">{t.assignees.map((a) => a.name).filter(Boolean).join(', ')}</span>
      )}
    </button>
  );
}

function QuickAdd({ statusId, onAdd, placeholder }: { statusId?: string; onAdd: (title: string, statusId?: string) => void; placeholder: string }) {
  const [title, setTitle] = useState('');
  return (
    <form
      onSubmit={(e: FormEvent) => { e.preventDefault(); const v = title.trim(); if (!v) return; onAdd(v, statusId); setTitle(''); }}
      className="flex items-center gap-2 px-3 py-1.5"
    >
      <Plus size={13} className="shrink-0 text-muted-foreground" />
      <input
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        placeholder={placeholder}
        className="h-7 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
      />
    </form>
  );
}

function ListView({ statuses, byStatus, onOpen, canWrite, onAdd }: {
  statuses: TaskStatus[]; byStatus: (sid: string) => Task[]; onOpen: (tid: string) => void;
  canWrite: boolean; onAdd: (title: string, statusId?: string) => void;
}) {
  return (
    <div className="space-y-5">
      {statuses.map((s) => {
        const items = byStatus(s.id);
        return (
          <section key={s.id}>
            <h3 className="mb-1.5 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color ?? '#9ca3af' }} />
              {s.name}
              <span className="rounded bg-muted px-1.5 py-0.5 tabular-nums">{items.length}</span>
            </h3>
            <div className="overflow-hidden rounded-lg border border-border bg-card">
              {items.map((t, i) => (
                <div key={t.id} className={cn(i > 0 && 'border-t border-border')}>
                  <TaskRow t={t} onOpen={onOpen} />
                </div>
              ))}
              {canWrite && (
                <div className={cn(items.length > 0 && 'border-t border-border')}>
                  <QuickAdd statusId={s.id} onAdd={onAdd} placeholder="Add task…" />
                </div>
              )}
              {items.length === 0 && !canWrite && <p className="px-3 py-2 text-xs text-muted-foreground">No tasks</p>}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function BoardView({ statuses, byStatus, onOpen, canWrite, onAdd }: {
  statuses: TaskStatus[]; byStatus: (sid: string) => Task[]; onOpen: (tid: string) => void;
  canWrite: boolean; onAdd: (title: string, statusId?: string) => void;
}) {
  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {statuses.map((s) => {
        const items = byStatus(s.id);
        return (
          <div key={s.id} className="flex w-72 shrink-0 flex-col rounded-lg border border-border bg-muted/30">
            <div className="flex items-center justify-between border-b border-border p-2.5">
              <span className="flex items-center gap-1.5 text-sm font-medium">
                <span className="h-2 w-2 rounded-full" style={{ backgroundColor: s.color ?? '#9ca3af' }} />
                {s.name}
              </span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-xs tabular-nums text-muted-foreground">{items.length}</span>
            </div>
            <div className="flex-1 space-y-2 overflow-y-auto p-2">
              {items.map((t) => (
                <button key={t.id} onClick={() => onOpen(t.id)} className="block w-full text-left">
                  <Card className="p-2.5 hover:border-primary/50">
                    <div className="flex items-start gap-2">
                      <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_COLOR[t.priority ?? 'none'] ?? PRIORITY_COLOR.none }} />
                      <span className="text-sm leading-snug">{t.title}</span>
                    </div>
                    {t.number != null && <p className="mt-1 pl-4 font-mono text-[11px] text-muted-foreground">#{t.number}</p>}
                  </Card>
                </button>
              ))}
              {canWrite && (
                <div className="rounded-md border border-dashed border-border">
                  <QuickAdd statusId={s.id} onAdd={onAdd} placeholder="Add task…" />
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/* ---------------- Task peek ---------------- */

function TaskPeek({ taskId, projectId, projectKey, statuses, onClose }: {
  taskId: string; projectId: string; projectKey?: string; statuses: TaskStatus[]; onClose: () => void;
}) {
  const qc = useQueryClient();
  const taskQ = useQuery<TaskDetail>({
    queryKey: ['task', taskId],
    queryFn: () => api.get<TaskDetail>(`/tasks/${taskId}?include=assignees,labels,comments`),
  });
  const task = taskQ.data;

  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState('');
  const [comment, setComment] = useState('');

  useEffect(() => {
    if (task) { setTitle(task.title ?? ''); setDesc(docToText(task.description)); }
    // Reset only when a different task loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [task?.id]);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['task', taskId] });
    qc.invalidateQueries({ queryKey: ['tasks', projectId] });
  };

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/tasks/${taskId}`, { ...body, version: task?.version }),
    onSuccess: invalidate,
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not save changes.'),
  });

  const addComment = useMutation({
    mutationFn: (text: string) => api.post(`/tasks/${taskId}/comments`, {
      body: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] },
    }),
    onSuccess: () => { setComment(''); qc.invalidateQueries({ queryKey: ['task', taskId] }); },
    onError: (e) => alert(e instanceof ApiError ? e.message : 'Could not add comment.'),
  });

  const keyLabel = projectKey && task?.number != null ? `${projectKey}-${task.number}` : task?.number != null ? `#${task.number}` : '';

  return (
    <>
      <div className="fixed inset-0 z-30 bg-black/20" onClick={onClose} />
      <aside className="fixed right-0 top-0 z-40 flex h-screen w-full max-w-md flex-col border-l border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
          <span className="font-mono text-xs text-muted-foreground">{keyLabel}</span>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground"><X size={16} /></button>
        </div>

        {taskQ.isLoading ? (
          <div className="space-y-3 p-4"><Skeleton className="h-6 w-3/4" /><Skeleton className="h-20" /></div>
        ) : taskQ.isError || !task ? (
          <div className="p-4 text-sm text-destructive">Could not load this task.</div>
        ) : (
          <div className="flex-1 space-y-5 overflow-y-auto p-4">
            <input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => { if (title.trim() && title !== task.title) patch.mutate({ title }); }}
              className="w-full bg-transparent text-base font-semibold outline-none"
            />

            <div className="flex items-center gap-2">
              <label className="text-xs font-medium text-muted-foreground">Status</label>
              <Select
                value={task.statusId}
                onChange={(e) => patch.mutate({ statusId: e.target.value })}
                disabled={patch.isPending}
              >
                {statuses.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </Select>
            </div>

            {task.labels && task.labels.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {task.labels.map((l) => <Badge key={l.id} color={l.color}>{l.name}</Badge>)}
              </div>
            )}

            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Textarea
                rows={4}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                onBlur={() => { if (desc !== docToText(task.description)) patch.mutate({ description: textToDoc(desc) }); }}
                placeholder="Add a description…"
              />
            </div>

            <div>
              <h3 className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                <MessageSquare size={13} /> Comments
              </h3>
              <div className="space-y-3">
                {(task.comments ?? []).map((c) => (
                  <div key={c.id} className="text-sm">
                    <div className="mb-0.5 flex items-center gap-2 text-xs text-muted-foreground">
                      <span className="font-medium text-foreground">{c.authorName ?? 'Someone'}</span>
                      <span>{fmtDate(c.createdAt)}</span>
                    </div>
                    <p className="whitespace-pre-wrap">{docToText(c.body)}</p>
                  </div>
                ))}
                {(task.comments ?? []).length === 0 && <p className="text-xs text-muted-foreground">No comments yet.</p>}
              </div>
              <form
                onSubmit={(e: FormEvent) => { e.preventDefault(); const v = comment.trim(); if (!v) return; addComment.mutate(v); }}
                className="mt-3 space-y-2"
              >
                <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment…" />
                <div className="flex justify-end">
                  <Button type="submit" size="sm" disabled={addComment.isPending || !comment.trim()}>Comment</Button>
                </div>
              </form>
            </div>
          </div>
        )}
      </aside>
    </>
  );
}

/* ---------------- Cycles ---------------- */

function cyclePercent(c: Cycle): number | null {
  if (typeof c.progress === 'number') return Math.max(0, Math.min(100, c.progress));
  if (typeof c.completedCount === 'number' && typeof c.totalCount === 'number' && c.totalCount > 0) {
    return Math.round((c.completedCount / c.totalCount) * 100);
  }
  return null;
}

function CyclesTab({ id }: { id: string }) {
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write') || can('projects.create');
  const { data, isLoading } = useQuery<Cycle[]>({ queryKey: ['cycles', id], queryFn: () => api.get<Cycle[]>(`/projects/${id}/cycles`) });
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [goal, setGoal] = useState('');
  const [error, setError] = useState<string | null>(null);

  const mut = useMutation({
    mutationFn: () => api.post('/cycles', { projectId: id, name, startDate: start || undefined, endDate: end || undefined, goal: goal || undefined }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['cycles', id] }); setAdding(false); setName(''); setStart(''); setEnd(''); setGoal(''); },
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not create cycle.'),
  });

  const cycles = data ?? [];

  return (
    <div className="max-w-2xl p-6">
      <div className="mb-4 flex items-center justify-between">
        <h2 className="text-sm font-semibold">Cycles</h2>
        {canWrite && !adding && <Button size="sm" variant="outline" onClick={() => setAdding(true)}><Plus size={14} /> New cycle</Button>}
      </div>

      {adding && (
        <Card className="mb-4 p-4">
          <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); if (!name.trim()) { setError('Name is required.'); return; } mut.mutate(); }} className="space-y-3">
            <Input autoFocus placeholder="Cycle name (e.g. Sprint 12)" value={name} onChange={(e) => setName(e.target.value)} />
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1"><label className="text-xs text-muted-foreground">Start</label><Input type="date" value={start} onChange={(e) => setStart(e.target.value)} /></div>
              <div className="space-y-1"><label className="text-xs text-muted-foreground">End</label><Input type="date" value={end} onChange={(e) => setEnd(e.target.value)} /></div>
            </div>
            <Input placeholder="Goal (optional)" value={goal} onChange={(e) => setGoal(e.target.value)} />
            {error && <p className="text-sm text-destructive">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => setAdding(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : 'Create'}</Button>
            </div>
          </form>
        </Card>
      )}

      {isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-20" />)}</div>
      ) : cycles.length === 0 ? (
        <EmptyState title="No cycles yet" hint="Cycles are time-boxed sprints. Create one to plan and track a batch of work." />
      ) : (
        <div className="space-y-3">
          {cycles.map((c) => {
            const pct = cyclePercent(c);
            return (
              <Card key={c.id} className="p-4">
                <div className="flex items-center justify-between">
                  <span className="font-medium">{c.name}</span>
                  {c.status && <Badge className="bg-muted capitalize text-muted-foreground">{c.status}</Badge>}
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {fmtDate(c.startDate)} – {fmtDate(c.endDate)}{c.goal ? ` · ${c.goal}` : ''}
                </p>
                {pct != null && (
                  <div className="mt-3">
                    <div className="mb-1 flex justify-between text-xs text-muted-foreground">
                      <span>Progress</span><span className="tabular-nums">{pct}%</span>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                      <div className="h-full rounded-full bg-primary" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </div>
  );
}

/* ---------------- Overview ---------------- */

function OverviewTab({ id, statuses, project }: { id: string; statuses: TaskStatus[]; project?: Project }) {
  const { data } = useQuery<Task[]>({ queryKey: ['tasks', id], queryFn: () => api.get<Task[]>(`/tasks${qs({ projectId: id })}`) });
  const tasks = data ?? [];
  const catOf = (sid: string) => statuses.find((s) => s.id === sid)?.category;
  const done = tasks.filter((t) => catOf(t.statusId) === 'done').length;
  const inProgress = tasks.filter((t) => catOf(t.statusId) === 'in_progress').length;
  const open = tasks.filter((t) => { const c = catOf(t.statusId); return c !== 'done' && c !== 'canceled'; }).length;

  const tiles: { label: string; value: ReactNode }[] = [
    { label: 'Total tasks', value: tasks.length },
    { label: 'Open', value: open },
    { label: 'In progress', value: inProgress },
    { label: 'Done', value: done },
  ];

  return (
    <div className="space-y-6 p-6">
      <div className="grid gap-4 sm:grid-cols-4">
        {tiles.map((t) => (
          <Card key={t.label} className="p-4">
            <p className="text-xs text-muted-foreground">{t.label}</p>
            <p className="mt-1 text-2xl font-semibold tabular-nums">{t.value}</p>
          </Card>
        ))}
      </div>
      {project?.description != null && docToText(project.description) && (
        <Card className="p-4">
          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">About</h3>
          <p className="whitespace-pre-wrap text-sm">{docToText(project.description)}</p>
        </Card>
      )}
    </div>
  );
}

/* ---------------- Settings ---------------- */

function SettingsTab({ project }: { project?: Project }) {
  const qc = useQueryClient();
  const can = useCan();
  const canWrite = can('projects.write');
  const [name, setName] = useState('');
  const [status, setStatus] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (project) { setName(project.name ?? ''); setStatus(project.status ?? 'active'); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project?.id]);

  const mut = useMutation({
    mutationFn: () => api.patch(`/projects/${project?.id}`, { name, status, version: project?.version }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['project', project?.id] }),
    onError: (e) => setError(e instanceof ApiError ? e.message : 'Could not save.'),
  });

  if (!project) return <div className="p-6"><Skeleton className="h-40" /></div>;

  if (!canWrite) {
    return (
      <div className="max-w-lg space-y-3 p-6 text-sm">
        <div><span className="text-muted-foreground">Name:</span> {project.name}</div>
        <div><span className="text-muted-foreground">Key:</span> <span className="font-mono">{project.key}</span></div>
        <div><span className="text-muted-foreground">Status:</span> {project.status}</div>
        <p className="text-xs text-muted-foreground">You need project admin rights to change these settings.</p>
      </div>
    );
  }

  return (
    <div className="max-w-lg p-6">
      <form onSubmit={(e: FormEvent) => { e.preventDefault(); setError(null); if (!name.trim()) { setError('Name is required.'); return; } mut.mutate(); }} className="space-y-4">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Name</label>
          <Input value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Key</label>
          <Input value={project.key} disabled className="font-mono" />
          <p className="text-xs text-muted-foreground">Project key can't be changed.</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">Status</label>
          <Select value={status} onChange={(e) => setStatus(e.target.value)} className="w-full">
            {PROJECT_STATUS.map((s) => <option key={s} value={s} className="capitalize">{s}</option>)}
          </Select>
        </div>
        {error && <p className="text-sm text-destructive">{error}</p>}
        <div className="flex justify-end">
          <Button type="submit" size="sm" disabled={mut.isPending}>{mut.isPending ? <Spinner /> : 'Save'}</Button>
        </div>
      </form>
    </div>
  );
}
