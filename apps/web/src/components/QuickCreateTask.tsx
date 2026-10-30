/**
 * Quick task creation (global "C" shortcut) – Linear-style "New issue" composer:
 * borderless title + rich-text description, a chip row of property pickers
 * (status / priority / assignees / project / labels / due date), a "create
 * more" switch and Cmd/Ctrl+Enter to create. `!high`-style tokens in the
 * title still set the priority.
 *
 * Closing the composer (Esc, outside click, ✕) never throws typed text away:
 * the form is kept as a draft for this person and comes back on the next
 * open, until the task is created or the draft is discarded.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, Tag, UserRound, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { useNavigate, usePathname } from '../lib/router';
import { useMe } from '../lib/auth';
import { draftStorageKey } from '../lib/draftSync';
import { appDraftStore } from '../lib/useDraftSync';
import { Avatar, Button, Kbd, PriorityIcon, Spinner, StatusIcon, Switch, cn, fmtDate } from './ui';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, toast, useMenuClose } from './overlays';
import { ProjectIcon } from './project/ProjectIcon';
import { RichEditor, EMPTY_DOC } from './richtext/RichEditor';
import { docIsEmpty } from './richtext/RichText';
import { useUsersLookup, useLabels, useTaskStatuses, activeUsers } from '../lib/queries';
import { useT, extendDict } from '../lib/i18n';
import { Calendar } from './DatePicker';
import { LabelsMenu } from './LabelsMenu';

extendDict({
  en: {
    'tasks.project': 'Project',
    'tasks.createdToast': 'Task created',
    'task.priority.urgent': 'Urgent',
    'task.priority.high': 'High',
    'task.priority.medium': 'Medium',
    'task.priority.low': 'Low',
    'task.priority.none': 'No priority',
    'qc.status': 'Status',
    'qc.assignee': 'Assignee',
    'qc.labels': 'Labels',
    'qc.dueDate': 'Due date',
    'qc.pickDate': 'Pick a date',
    'qc.clearDate': 'Clear date',
    'qc.createMore': 'Create more',
    'qc.createTask': 'Create task',
    'qc.unassigned': 'Unassigned',
  },
  uk: {
    'tasks.project': 'Проєкт',
    'tasks.createdToast': 'Задачу створено',
    'task.priority.urgent': 'Терміновий',
    'task.priority.high': 'Високий',
    'task.priority.medium': 'Середній',
    'task.priority.low': 'Низький',
    'task.priority.none': 'Без пріоритету',
    'qc.status': 'Статус',
    'qc.assignee': 'Виконавець',
    'qc.labels': 'Мітки',
    'qc.dueDate': 'Термін',
    'qc.pickDate': 'Оберіть дату',
    'qc.clearDate': 'Прибрати дату',
    'qc.createMore': 'Створювати ще',
    'qc.createTask': 'Створити задачу',
    'qc.unassigned': 'Без виконавця',
  },
});

interface ProjectLite { id: string; name: string; key: string }
interface UserLite { id: string; name?: string | null; email?: string | null; avatar?: string | null; isActive?: boolean }
interface CreatedTask { id: string; ref?: string; title: string }

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;
const LAST_PROJECT_KEY = 'ordi:quickcreate:project';

/** Parse quick syntax in the title (PRD §8.3): `!high` priority token. */
function parseQuickSyntax(raw: string): { title: string; priority?: string } {
  let title = raw;
  let priority: string | undefined;
  const m = title.match(/!(urgent|high|medium|low|none)\b/i);
  if (m) {
    priority = m[1]!.toLowerCase();
    title = title.replace(m[0], '').replace(/\s{2,}/g, ' ').trim();
  }
  return { title, priority };
}

/**
 * Property chip: the trigger of every picker in the chip row. A real button,
 * so Tab reaches it and Enter/Space open its menu (the DropdownMenu anchor
 * opens on the click the button fires). `label` names the property for
 * assistive tech, since the chip itself only shows the value.
 */
function ChipButton({ children, muted, label, value, disabled }: {
  children: ReactNode; muted?: boolean; label: string; value: string; disabled?: boolean;
}) {
  return (
    <button
      type="button"
      aria-haspopup="menu"
      aria-label={`${label}: ${value}`}
      disabled={disabled}
      className={cn(
        'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[13px]',
        'transition-colors duration-150 hover:border-border-strong hover:bg-muted disabled:cursor-default disabled:opacity-60',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
    </button>
  );
}

/** Everything the composer holds, as kept between openings. */
interface QuickDraft {
  title: string; desc: unknown; priority: string; assigneeIds: string[]; labelIds: string[];
  dueDate: string; projectId: string; statusId: string;
}

function readQuickDraft(key: string): QuickDraft | null {
  try {
    const raw = appDraftStore.getItem(key);
    const d = raw ? JSON.parse(raw) as QuickDraft : null;
    return d && typeof d.title === 'string' ? d : null;
  } catch {
    return null;
  }
}

/** Menu row that toggles without closing the dropdown (multi-select). */
function ToggleItem({ children, icon, checked, onToggle }: {
  children: ReactNode; icon?: ReactNode; checked: boolean; onToggle: () => void;
}) {
  return (
    <button
      role="menuitemcheckbox"
      aria-checked={checked}
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] text-foreground transition-colors duration-150 hover:bg-muted"
    >
      {icon && <span className="[&>svg]:block">{icon}</span>}
      <span className="flex-1 truncate">{children}</span>
      <span className={cn('text-primary transition-opacity duration-150', checked ? 'opacity-100' : 'opacity-0')}>✓</span>
    </button>
  );
}

/** The shared calendar inside a menu – picking a day applies it and closes. */
function DatePickInput({ value, onSet }: {
  value: string | null; onSet: (v: string) => void;
}) {
  const close = useMenuClose();
  return <Calendar value={value} onSelect={(day) => { onSet(day); close(); }} />;
}

export function QuickCreateTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const me = useMe();
  const draftKey = draftStorageKey(me.user.id, 'quick-create', 'task');
  /** The form came back from an earlier, unfinished opening. */
  const [restored, setRestored] = useState(false);
  const [draftStored, setDraftStored] = useState(true);
  /** A restored status waits for its project's statuses to load. */
  const pendingStatus = useRef<string | null>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const submitRef = useRef<() => void>(() => {});

  const [projectId, setProjectId] = useState('');
  const [statusId, setStatusId] = useState('');
  const [priority, setPriority] = useState<string>('none');
  const [assigneeIds, setAssigneeIds] = useState<string[]>([]);
  const [labelIds, setLabelIds] = useState<string[]>([]);
  const [dueDate, setDueDate] = useState('');
  const [title, setTitle] = useState('');
  const [desc, setDesc] = useState<any>(EMPTY_DOC);
  const [descKey, setDescKey] = useState(0); // remount editor to reset content
  const [createMore, setCreateMore] = useState(false);

  const projectsQ = useQuery<ProjectLite[]>({
    queryKey: ['projects'],
    queryFn: () => api.get<{ data: ProjectLite[] }>('/projects').then((r) => r.data),
    enabled: open,
  });
  const projects = projectsQ.data ?? [];
  const project = projects.find((p) => p.id === projectId);

  const statusesQ = useTaskStatuses(projectId, open);
  const statuses = statusesQ.data ?? [];
  const status = statuses.find((s) => s.id === statusId);

  const usersQ = useUsersLookup();
  const users = (usersQ.data ?? []) as UserLite[];
  const labels = useLabels('task').data ?? [];

  // A task composed from inside a project belongs to that project (ORD-21):
  // the project page and its task pages both live under /projects/:id.
  const pathname = usePathname();
  const routeProjectId = pathname.match(/^\/projects\/([^/]+)/)?.[1] ?? null;

  // Initial project: the one whose page is open; otherwise last used
  // (localStorage) if still available, else first. The route wins once per
  // opening only – a project picked by hand afterwards must stick.
  const routeApplied = useRef(false);
  useEffect(() => { if (!open) routeApplied.current = false; }, [open]);
  useEffect(() => {
    if (!open || !projects.length) return;
    if (!routeApplied.current) {
      routeApplied.current = true;
      const fromRoute = routeProjectId ? projects.find((p) => p.id === routeProjectId) : undefined;
      if (fromRoute) { setProjectId(fromRoute.id); return; }
    }
    if (projectId && projects.some((p) => p.id === projectId)) return;
    let last: string | null = null;
    try { last = localStorage.getItem(LAST_PROJECT_KEY); } catch { /* optional preference */ }
    const preset = projects.find((p) => p.id === last) ?? projects[0]!;
    setProjectId(preset.id);
  }, [open, projects, projectId, routeProjectId]);

  // Default status: project default (falls back to the first by position).
  useEffect(() => {
    if (!statuses.length) { setStatusId(''); return; }
    const pending = pendingStatus.current;
    if (pending && statuses.some((s) => s.id === pending)) {
      pendingStatus.current = null;
      setStatusId(pending);
      return;
    }
    setStatusId((cur) =>
      statuses.some((s) => s.id === cur) ? cur : (statuses.find((s) => s.isDefault) ?? statuses[0]!).id,
    );
  }, [statuses]);

  const resetForm = () => {
    setTitle('');
    setDesc(EMPTY_DOC);
    setDescKey((k) => k + 1);
    setPriority('none');
    setAssigneeIds([]);
    setLabelIds([]);
    setDueDate('');
  };

  // On open: the unfinished draft if there is one, else a fresh form (the
  // project sticks via localStorage).
  useEffect(() => {
    if (!open) return;
    const draft = readQuickDraft(draftKey);
    if (!draft) { setRestored(false); resetForm(); return; }
    setTitle(draft.title);
    setDesc(draft.desc ?? EMPTY_DOC);
    setDescKey((k) => k + 1);
    setPriority(draft.priority || 'none');
    setAssigneeIds(draft.assigneeIds ?? []);
    setLabelIds(draft.labelIds ?? []);
    setDueDate(draft.dueDate ?? '');
    if (draft.projectId) {
      routeApplied.current = true; // the draft's project wins over the route's
      setProjectId(draft.projectId);
      pendingStatus.current = draft.statusId || null;
    }
    setRestored(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, draftKey]);

  // Mirror the form while it holds typed text, so closing loses nothing.
  const hasText = title.trim() !== '' || !docIsEmpty(desc);
  useEffect(() => {
    if (!open) return;
    try {
      if (!hasText) { appDraftStore.removeItem(draftKey); setDraftStored(true); return; }
      const draft: QuickDraft = { title, desc, priority, assigneeIds, labelIds, dueDate, projectId, statusId };
      appDraftStore.setItem(draftKey, JSON.stringify(draft));
      setDraftStored(true);
    } catch { setDraftStored(false); }
  }, [open, hasText, title, desc, priority, assigneeIds, labelIds, dueDate, projectId, statusId, draftKey]);

  useEffect(() => {
    if (!hasText || draftStored) return;
    const onUnload = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', onUnload);
    return () => window.removeEventListener('beforeunload', onUnload);
  }, [hasText, draftStored]);

  const discardDraft = () => {
    appDraftStore.removeItem(draftKey);
    setRestored(false);
    resetForm();
    requestAnimationFrame(() => titleRef.current?.focus());
  };

  const parsed = parseQuickSyntax(title);
  const effectivePriority = parsed.priority ?? priority;

  const create = useMutation({
    mutationFn: () => {
      const body: Record<string, unknown> = {
        projectId,
        title: parsed.title,
        priority: effectivePriority,
        assigneeIds,
        labelIds,
      };
      if (statusId) body.statusId = statusId;
      if (!docIsEmpty(desc)) body.description = desc;
      if (dueDate) body.dueDate = dueDate;
      return api.post<CreatedTask>('/tasks', body);
    },
    onSuccess: (created) => {
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['me-tasks'] });
      qc.invalidateQueries({ queryKey: ['me', 'tasks'] });
      qc.invalidateQueries({ queryKey: ['onboarding'] });
      qc.invalidateQueries({ queryKey: ['subtasks'] });
      try { localStorage.setItem(LAST_PROJECT_KEY, projectId); } catch { /* optional preference */ }
      toast.action(`${created.ref ?? ''} · ${t('tasks.createdToast')}`.replace(/^ · /, ''), {
        label: t('common.open', 'Open'), onSelect: () => navigate(`/projects/${projectId}/tasks/${created.id}`),
      });
      appDraftStore.removeItem(draftKey);
      setRestored(false);
      if (createMore) {
        setTitle('');
        setDesc(EMPTY_DOC);
        setDescKey((k) => k + 1);
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        resetForm();
        onClose();
      }
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('tasks.createFailed')),
    onSettled: () => { submitting.current = false; },
  });
  const canCreate = parsed.title.trim() !== '' && !!projectId && !create.isPending;
  // `isPending` only flips on the next render, so two Cmd+Enter handlers firing in
  // the same tick (rich editor + shortcut) used to create the task twice.
  const submit = () => {
    if (!canCreate || submitting.current) return;
    submitting.current = true;
    create.mutate();
  };
  submitRef.current = submit;

  // The chip menus (status, assignee, due date…) unmount on close and drop focus
  // to <body>, where a React onKeyDown inside the dialog never sees the event –
  // so the shortcut lives on the window while the composer is open.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitRef.current(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const selectedLabels = labels.filter((l) => labelIds.includes(l.id));
  const selectedUsers = users.filter((u) => assigneeIds.includes(u.id));
  const userName = (u: UserLite) => u.name || u.email || u.id;

  return (
    <Dialog open={open} onClose={onClose} title={t('tasks.newTask')} width={640}>
      <>
        <div className="px-4 pt-2">
          {/* Title */}
          <input
            ref={titleRef}
            autoFocus
            placeholder={t('tasks.title')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="h-9 w-full bg-transparent text-[15px] font-semibold text-foreground outline-none placeholder:text-faint"
          />

          {/* Description */}
          <div className="max-h-[38vh] overflow-y-auto">
            <RichEditor
              key={descKey}
              value={desc}
              onChange={setDesc}
              placeholder={t('tasks.addDescription')}
              compact
              bare
              onSubmit={submit}
            />
          </div>

          {/* Property chips */}
          <div className="mt-3 flex flex-wrap items-center gap-1.5 pb-3.5">
            {/* Status */}
            <DropdownMenu
              width={220}
              disabled={!projectId || statusesQ.isLoading}
              trigger={
                <ChipButton label={t('qc.status')} value={status?.name ?? t('common.loading')} muted={!status} disabled={!projectId || statusesQ.isLoading}>
                  {statusesQ.isLoading ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <StatusIcon category={status?.category ?? 'backlog'} color={status?.color} size={13} />
                  )}
                  <span className="max-w-[120px] truncate">{status ? status.name : t('qc.status')}</span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('qc.status')}</MenuLabel>
              {statuses.map((s) => (
                <MenuItem
                  key={s.id}
                  icon={<StatusIcon category={s.category} color={s.color} size={14} />}
                  checked={s.id === statusId}
                  onSelect={() => setStatusId(s.id)}
                >
                  {s.name}
                </MenuItem>
              ))}
            </DropdownMenu>

            {/* Priority */}
            <DropdownMenu
              width={186}
              trigger={
                <ChipButton label={t('tasks.priority')} value={t(`task.priority.${effectivePriority}`)} muted={effectivePriority === 'none'}>
                  <PriorityIcon priority={effectivePriority} size={13} />
                  <span className="max-w-[120px] truncate">{t(`task.priority.${effectivePriority}`)}</span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('tasks.priority')}</MenuLabel>
              {PRIORITIES.map((p) => (
                <MenuItem
                  key={p}
                  icon={<PriorityIcon priority={p} />}
                  checked={p === effectivePriority}
                  onSelect={() => setPriority(p)}
                >
                  {t(`task.priority.${p}`)}
                </MenuItem>
              ))}
            </DropdownMenu>

            {/* Assignees (multi) */}
            <DropdownMenu
              width={230}
              trigger={
                <ChipButton label={t('tasks.assignees')} value={selectedUsers.map(userName).join(', ') || t('qc.unassigned')} muted={selectedUsers.length === 0}>
                  {selectedUsers.length === 0 ? (
                    <UserRound size={13} className="text-muted-foreground" />
                  ) : (
                    <span className="flex -space-x-1.5">
                      {selectedUsers.slice(0, 3).map((u) => (
                        <Avatar key={u.id} name={userName(u)} src={u.avatar} size={16} className="ring-1 ring-elevated" />
                      ))}
                    </span>
                  )}
                  <span className="max-w-[140px] truncate">
                    {selectedUsers.length === 0
                      ? t('qc.assignee')
                      : selectedUsers.length === 1
                        ? userName(selectedUsers[0]!)
                        : String(selectedUsers.length)}
                  </span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('tasks.assignees')}</MenuLabel>
              {activeUsers(users).map((u) => (
                <ToggleItem
                  key={u.id}
                  icon={<Avatar name={userName(u)} src={u.avatar} size={18} />}
                  checked={assigneeIds.includes(u.id)}
                  onToggle={() =>
                    setAssigneeIds((cur) => (cur.includes(u.id) ? cur.filter((id) => id !== u.id) : [...cur, u.id]))
                  }
                >
                  {userName(u)}
                </ToggleItem>
              ))}
              {assigneeIds.length > 0 && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<X size={14} />} onSelect={() => setAssigneeIds([])}>{t('qc.unassigned')}</MenuItem>
                </>
              )}
            </DropdownMenu>

            {/* Project */}
            <DropdownMenu
              width={260}
              trigger={
                <ChipButton label={t('tasks.project')} value={project?.name ?? t('common.select')} muted={!project}>
                  {projectsQ.isLoading ? (
                    <Spinner className="h-3 w-3" />
                  ) : (
                    <ProjectIcon seed={project ? project.key || project.id : '?'} size={14} radius={4} />
                  )}
                  <span className="max-w-[160px] truncate">{project ? project.name : t('tasks.project')}</span>
                  {project && <span className="font-mono text-[10px] text-faint">{project.key}</span>}
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('tasks.project')}</MenuLabel>
              {projects.map((p) => (
                <MenuItem
                  key={p.id}
                  icon={<ProjectIcon seed={p.key || p.id} size={16} radius={4} />}
                  checked={p.id === projectId}
                  onSelect={() => setProjectId(p.id)}
                >
                  <span className="flex items-baseline gap-1.5">
                    <span className="truncate">{p.name}</span>
                    <span className="font-mono text-[10px] text-faint">{p.key}</span>
                  </span>
                </MenuItem>
              ))}
            </DropdownMenu>

            {/* Labels (multi) */}
            <DropdownMenu
              width={240}
              trigger={
                <ChipButton label={t('qc.labels')} value={selectedLabels.map((l) => l.name).join(', ') || t('common.nothingYet')} muted={selectedLabels.length === 0}>
                  {selectedLabels.length === 0 ? (
                    <Tag size={13} className="text-muted-foreground" />
                  ) : (
                    <span className="flex items-center -space-x-0.5">
                      {selectedLabels.slice(0, 4).map((l) => (
                        <span
                          key={l.id}
                          className="h-2.5 w-2.5 rounded-full ring-1 ring-elevated"
                          style={{ backgroundColor: l.color ?? '#8a8f98' }}
                        />
                      ))}
                    </span>
                  )}
                  <span className="max-w-[140px] truncate">
                    {selectedLabels.length === 0
                      ? t('qc.labels')
                      : selectedLabels.length === 1
                        ? selectedLabels[0]!.name
                        : String(selectedLabels.length)}
                  </span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <LabelsMenu scope="task" value={labelIds} onChange={setLabelIds} />
            </DropdownMenu>

            {/* Due date */}
            <DropdownMenu
              width={264}
              trigger={
                <ChipButton label={t('qc.dueDate')} value={dueDate ? fmtDate(dueDate) : t('common.select')} muted={!dueDate}>
                  <CalendarDays size={13} className={dueDate ? undefined : 'text-muted-foreground'} />
                  <span className="max-w-[120px] truncate">{dueDate ? fmtDate(dueDate) : t('qc.dueDate')}</span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('qc.dueDate')}</MenuLabel>
              <DatePickInput value={dueDate || null} onSet={setDueDate} />
              {dueDate && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<X size={14} />} danger onSelect={() => setDueDate('')}>{t('qc.clearDate')}</MenuItem>
                </>
              )}
            </DropdownMenu>
          </div>
        </div>

        {hasText && (restored || !draftStored) && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2 text-xs text-muted-foreground">
            <span role="status">{draftStored ? t('draft.restored') : t('draft.notStored')}</span>
            <Button type="button" size="xs" variant="ghost" onClick={discardDraft}>{t('draft.discard')}</Button>
          </div>
        )}

        {/* Footer */}
        <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
          <label className="flex cursor-pointer select-none items-center gap-2 text-[12px] text-muted-foreground">
            <Switch checked={createMore} onChange={setCreateMore} label={t('qc.createMore')} />
            {t('qc.createMore')}
          </label>
          <div className="flex items-center gap-3">
            <span className="hidden items-center gap-1 text-[11px] text-faint sm:flex">
              <Kbd>{navigator.platform.includes('Mac') ? '⌘' : 'Ctrl'}</Kbd>
              <Kbd>↵</Kbd>
            </span>
            <Button size="sm" disabled={!canCreate} onClick={submit}>
              {create.isPending && <Spinner className="h-3 w-3 border-white/40 border-t-white" />}
              {t('qc.createTask')}
            </Button>
          </div>
        </div>
      </>
    </Dialog>
  );
}
