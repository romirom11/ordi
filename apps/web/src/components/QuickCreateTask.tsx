/**
 * Quick task creation (global "C" shortcut) — Linear-style "New issue" composer:
 * borderless title + rich-text description, a chip row of property pickers
 * (status / priority / assignees / project / labels / due date), a "create
 * more" switch and Cmd/Ctrl+Enter to create. `!high`-style tokens in the
 * title still set the priority.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarDays, ChevronDown, Tag, UserRound, X } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Avatar, Button, Kbd, PriorityIcon, Spinner, StatusIcon, Switch, cn, fmtDate } from './ui';
import { Dialog, DropdownMenu, MenuItem, MenuLabel, MenuSeparator, toast, useMenuClose } from './overlays';
import { ProjectIcon } from './project/ProjectIcon';
import { RichEditor, EMPTY_DOC } from './richtext/RichEditor';
import { docIsEmpty } from './richtext/RichText';
import { useUsersLookup } from '../lib/queries';
import { useT, extendDict } from '../lib/i18n';

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
    'qc.noLabels': 'No labels in this workspace yet',
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
    'qc.noLabels': 'У воркспейсі поки немає міток',
    'qc.dueDate': 'Термін',
    'qc.pickDate': 'Оберіть дату',
    'qc.clearDate': 'Прибрати дату',
    'qc.createMore': 'Створювати ще',
    'qc.createTask': 'Створити задачу',
    'qc.unassigned': 'Без виконавця',
  },
});

interface ProjectLite { id: string; name: string; key: string }
interface StatusLite { id: string; name: string; category: string; color: string; position: number; isDefault?: boolean }
interface LabelLite { id: string; name: string; color: string }
interface UserLite { id: string; name?: string | null; email?: string | null; avatar?: string | null }
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

/** Property chip: the trigger button of every picker in the chip row. */
function ChipButton({ children, muted }: { children: ReactNode; muted?: boolean }) {
  return (
    <span
      className={cn(
        'flex h-7 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2 text-[13px]',
        'transition-colors duration-150 hover:border-border-strong hover:bg-muted',
        muted && 'text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
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

/** Native date input inside a menu — picking a date applies it and closes. */
function DatePickInput({ value, onSet, ariaLabel }: { value: string; onSet: (v: string) => void; ariaLabel: string }) {
  const close = useMenuClose();
  return (
    <input
      type="date"
      aria-label={ariaLabel}
      defaultValue={value}
      onChange={(e) => { if (e.target.value) { onSet(e.target.value); close(); } }}
      className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-[13px] outline-none transition-colors duration-150 hover:border-border-strong focus:border-primary/60"
    />
  );
}

export function QuickCreateTask({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const titleRef = useRef<HTMLInputElement>(null);

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

  const statusesQ = useQuery<StatusLite[]>({
    queryKey: ['task-statuses', projectId],
    queryFn: () => api.get<{ data: StatusLite[] }>(`/projects/${projectId}/task-statuses`).then((r) => r.data),
    enabled: open && !!projectId,
  });
  const statuses = useMemo(
    () => [...(statusesQ.data ?? [])].sort((a, b) => a.position - b.position),
    [statusesQ.data],
  );
  const status = statuses.find((s) => s.id === statusId);

  const usersQ = useUsersLookup();
  const users = (usersQ.data ?? []) as UserLite[];
  const labelsQ = useQuery<LabelLite[]>({
    queryKey: ['labels'],
    queryFn: () => api.get<{ data: LabelLite[] }>('/labels').then((r) => r.data),
    enabled: open,
  });
  const labels = labelsQ.data ?? [];

  // Initial project: last used (localStorage) if still available, else first.
  useEffect(() => {
    if (!open || projectId || !projects.length) return;
    const last = localStorage.getItem(LAST_PROJECT_KEY);
    const preset = projects.find((p) => p.id === last) ?? projects[0]!;
    setProjectId(preset.id);
  }, [open, projects, projectId]);

  // Default status: project default (falls back to the first by position).
  useEffect(() => {
    if (!statuses.length) { setStatusId(''); return; }
    setStatusId((cur) =>
      statuses.some((s) => s.id === cur) ? cur : (statuses.find((s) => s.isDefault) ?? statuses[0]!).id,
    );
  }, [statuses]);

  // Fresh form on every open (project sticks via localStorage).
  useEffect(() => {
    if (!open) return;
    setTitle('');
    setDesc(EMPTY_DOC);
    setDescKey((k) => k + 1);
    setPriority('none');
    setAssigneeIds([]);
    setLabelIds([]);
    setDueDate('');
  }, [open]);

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
      qc.invalidateQueries({ queryKey: ['subtasks'] });
      localStorage.setItem(LAST_PROJECT_KEY, projectId);
      toast(`${created.ref ?? ''} · ${t('tasks.createdToast')}`.replace(/^ · /, ''));
      if (createMore) {
        setTitle('');
        setDesc(EMPTY_DOC);
        setDescKey((k) => k + 1);
        requestAnimationFrame(() => titleRef.current?.focus());
      } else {
        onClose();
      }
    },
    onError: (e: Error) => toast.error(e instanceof ApiError ? e.message : t('tasks.createFailed')),
  });
  const canCreate = parsed.title.trim() !== '' && !!projectId && !create.isPending;
  const submit = () => { if (canCreate) create.mutate(); };

  const selectedLabels = labels.filter((l) => labelIds.includes(l.id));
  const selectedUsers = users.filter((u) => assigneeIds.includes(u.id));
  const userName = (u: UserLite) => u.name || u.email || u.id;

  return (
    <Dialog open={open} onClose={onClose} title={t('tasks.newTask')} width={640}>
      <div
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
        }}
        onMouseDown={() => {
          // Dialog stops mousedown propagation, so DropdownMenu's document-level
          // outside-click handler never fires for clicks inside the dialog.
          // Re-dispatch a document mousedown so open chip menus close as expected
          // (menus themselves are portaled to <body> and unaffected).
          document.dispatchEvent(new MouseEvent('mousedown'));
        }}
      >
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
                <ChipButton muted={!status}>
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
                <ChipButton muted={effectivePriority === 'none'}>
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
                <ChipButton muted={selectedUsers.length === 0}>
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
              {users.map((u) => (
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
                <ChipButton muted={!project}>
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
              width={220}
              trigger={
                <ChipButton muted={selectedLabels.length === 0}>
                  {selectedLabels.length === 0 ? (
                    <Tag size={13} className="text-muted-foreground" />
                  ) : (
                    <span className="flex items-center -space-x-0.5">
                      {selectedLabels.slice(0, 4).map((l) => (
                        <span
                          key={l.id}
                          className="h-2.5 w-2.5 rounded-full ring-1 ring-elevated"
                          style={{ backgroundColor: l.color }}
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
              <MenuLabel>{t('qc.labels')}</MenuLabel>
              {labels.length === 0 && <div className="px-2 py-1.5 text-xs text-faint">{t('qc.noLabels')}</div>}
              {labels.map((l) => (
                <ToggleItem
                  key={l.id}
                  icon={<span className="block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color }} />}
                  checked={labelIds.includes(l.id)}
                  onToggle={() =>
                    setLabelIds((cur) => (cur.includes(l.id) ? cur.filter((id) => id !== l.id) : [...cur, l.id]))
                  }
                >
                  {l.name}
                </ToggleItem>
              ))}
            </DropdownMenu>

            {/* Due date */}
            <DropdownMenu
              width={210}
              trigger={
                <ChipButton muted={!dueDate}>
                  <CalendarDays size={13} className={dueDate ? undefined : 'text-muted-foreground'} />
                  <span className="max-w-[120px] truncate">{dueDate ? fmtDate(dueDate) : t('qc.dueDate')}</span>
                  <ChevronDown size={12} className="text-faint" />
                </ChipButton>
              }
            >
              <MenuLabel>{t('qc.dueDate')}</MenuLabel>
              <div className="px-2 pb-1.5">
                <DatePickInput value={dueDate} onSet={setDueDate} ariaLabel={t('qc.pickDate')} />
              </div>
              {dueDate && (
                <>
                  <MenuSeparator />
                  <MenuItem icon={<X size={14} />} danger onSelect={() => setDueDate('')}>{t('qc.clearDate')}</MenuItem>
                </>
              )}
            </DropdownMenu>
          </div>
        </div>

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
      </div>
    </Dialog>
  );
}
