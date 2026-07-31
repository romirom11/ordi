/**
 * Right-hand properties sidebar of the full task page (Linear-style).
 * Every row is a DropdownMenu that PATCHes the task (with optimistic-lock
 * version handled by the parent's mutation).
 */
import type { ReactNode } from 'react';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { CalendarDays, CalendarPlus, Diamond, Gauge, Tag, UserPlus2, X } from 'lucide-react';
import { api } from '../../lib/api';
import {
  Avatar, AvatarGroup, Badge, PriorityIcon, StatusIcon, cn, fmtDate,
} from '../ui';
import { DropdownMenu, MenuItem, MenuLabel, MenuSeparator, useMenuClose } from '../overlays';
import { LabelsMenu } from '../LabelsMenu';
import { GitBlock } from './GitBlock';
import { useT, extendDict } from '../../lib/i18n';
import { TaskTimer } from './TaskTimer';
import type { MilestoneLite, TaskDetail, TaskPatch, TaskStatus, UserLite } from './types';
import { Calendar } from '../DatePicker';

extendDict({
  en: {
    'task.properties': 'Properties',
    'task.labels': 'Labels',
    'task.startDate': 'Start date',
    'task.estimate': 'Estimate',
    'task.milestone': 'Milestone',
    'task.setMilestone': 'No milestone',
    'task.noMilestones': 'No milestones in this project yet',
    'task.unassigned': 'Unassigned',
    'task.addLabel': 'Add label',
    'task.setDue': 'Set due date',
    'task.setStart': 'Set start date',
    'task.setEstimate': 'Set estimate',
    'task.clear': 'Clear',
    'task.points': 'points',
    'task.created': 'Created',
    'task.updated': 'Updated',
    'task.pickDate': 'Pick a date',
    'task.today': 'Today',
    'task.tomorrow': 'Tomorrow',
    'task.nextWeek': 'Next week',
    'task.priority.urgent': 'Urgent',
    'task.priority.high': 'High',
    'task.priority.medium': 'Medium',
    'task.priority.low': 'Low',
    'task.priority.none': 'No priority',
  },
  uk: {
    'task.properties': 'Властивості',
    'task.labels': 'Мітки',
    'task.startDate': 'Дата початку',
    'task.estimate': 'Оцінка',
    'task.milestone': 'Віха',
    'task.setMilestone': 'Без віхи',
    'task.noMilestones': 'У проєкті ще немає віх',
    'task.unassigned': 'Не призначено',
    'task.addLabel': 'Додати мітку',
    'task.setDue': 'Вказати дедлайн',
    'task.setStart': 'Вказати початок',
    'task.setEstimate': 'Вказати оцінку',
    'task.clear': 'Очистити',
    'task.points': 'балів',
    'task.created': 'Створено',
    'task.updated': 'Оновлено',
    'task.pickDate': 'Оберіть дату',
    'task.today': 'Сьогодні',
    'task.tomorrow': 'Завтра',
    'task.nextWeek': 'Наступного тижня',
    'task.priority.urgent': 'Терміновий',
    'task.priority.high': 'Високий',
    'task.priority.medium': 'Середній',
    'task.priority.low': 'Низький',
    'task.priority.none': 'Без пріоритету',
  },
});

const PRIORITIES = ['urgent', 'high', 'medium', 'low', 'none'] as const;

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-start gap-2 px-3 py-0.5">
      <span className="w-[72px] shrink-0 pt-[7px] text-xs text-faint">{label}</span>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

function Chip({ children, empty }: { children: ReactNode; empty?: boolean }) {
  return (
    <span
      className={cn(
        'flex min-h-7 w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-[13px]',
        'transition-colors duration-150 hover:bg-muted',
        empty && 'text-faint',
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

function isoDate(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** The shared calendar inside a menu – picking a day applies it and closes. */
function DatePickInput({ value, onSet }: {
  value: string | null; onSet: (v: string) => void; ariaLabel?: string;
}) {
  const close = useMenuClose();
  return <Calendar value={value} onSelect={(day) => { onSet(day); close(); }} />;
}

/** Numeric estimate input inside the menu – Enter applies and closes. */
function EstimateInput({ onSubmit }: { onSubmit: (n: number) => void }) {
  const close = useMenuClose();
  const [draft, setDraft] = useState('');
  const submit = () => {
    const n = Number(draft);
    if (draft.trim() !== '' && Number.isFinite(n) && n >= 0) { onSubmit(n); close(); }
  };
  return (
    <input
      type="number"
      min={0}
      placeholder="8"
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') submit(); }}
      className="h-7 w-full rounded-md border border-input bg-transparent px-2 text-[13px] tabular-nums outline-none transition-colors duration-150 hover:border-border-strong focus:border-primary/60"
    />
  );
}

function DateMenu({ label, emptyLabel, icon, value, overdue, onSet, t }: {
  label: string; emptyLabel: string; icon: ReactNode; value: string | null;
  overdue?: boolean; onSet: (v: string | null) => void; t: (k: string) => string;
}) {
  const now = new Date();
  const tomorrow = new Date(now.getTime() + 86_400_000);
  const nextWeek = new Date(now.getTime() + 7 * 86_400_000);
  return (
    <Row label={label}>
      <DropdownMenu
        className="w-full"
        width={264}
        trigger={
          <Chip empty={!value}>
            {icon}
            <span className={cn('truncate', overdue && 'text-destructive')}>{value ? fmtDate(value) : emptyLabel}</span>
          </Chip>
        }
      >
        <MenuLabel>{label}</MenuLabel>
        <DatePickInput value={value} onSet={onSet} />
        <MenuSeparator />
        <MenuItem icon={<CalendarDays size={14} />} onSelect={() => onSet(isoDate(now))}>{t('task.today')}</MenuItem>
        <MenuItem icon={<CalendarDays size={14} />} onSelect={() => onSet(isoDate(tomorrow))}>{t('task.tomorrow')}</MenuItem>
        <MenuItem icon={<CalendarDays size={14} />} onSelect={() => onSet(isoDate(nextWeek))}>{t('task.nextWeek')}</MenuItem>
        {value && (
          <>
            <MenuSeparator />
            <MenuItem icon={<X size={14} />} danger onSelect={() => onSet(null)}>{t('task.clear')}</MenuItem>
          </>
        )}
      </DropdownMenu>
    </Row>
  );
}

export function PropertySidebar({ task, statuses, users, onPatch, hasRepos }: {
  task: TaskDetail;
  statuses: TaskStatus[];
  users: UserLite[];
  onPatch: (patch: TaskPatch) => void;
  hasRepos?: boolean;
}) {
  const t = useT();

  // The project's milestones, so a task can say which one it delivers.
  const { data: milestoneRows } = useQuery<MilestoneLite[]>({
    queryKey: ['milestones', task.projectId],
    queryFn: () => api.get<{ data: MilestoneLite[] }>(`/projects/${task.projectId}/milestones`).then((r) => r.data),
    staleTime: 60_000,
  });
  const milestones = milestoneRows ?? [];
  const milestone = milestones.find((m) => m.id === task.milestoneId);

  const status = statuses.find((s) => s.id === task.statusId);
  const assigneeIds = task.assignees.map((a) => a.userId);
  const labelIds = task.labels.map((l) => l.id);
  const dueOverdue = !!task.dueDate
    && new Date(task.dueDate).setHours(0, 0, 0, 0) < new Date().setHours(0, 0, 0, 0)
    && status?.category !== 'done' && status?.category !== 'canceled';

  const toggleAssignee = (id: string) => {
    onPatch({ assigneeIds: assigneeIds.includes(id) ? assigneeIds.filter((a) => a !== id) : [...assigneeIds, id] });
  };

  return (
    <div className="flex flex-col gap-0.5 py-3">
      <TaskTimer taskId={task.id} />
      <p className="px-3 pb-1.5 pt-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('task.properties')}</p>

      {/* Status */}
      <Row label={t('common.status')}>
        <DropdownMenu
          className="w-full"
          width={200}
          trigger={
            <Chip>
              <StatusIcon category={status?.category} color={status?.color} />
              <span className="truncate">{status?.name ?? '–'}</span>
            </Chip>
          }
        >
          {statuses.map((s) => (
            <MenuItem
              key={s.id}
              icon={<StatusIcon category={s.category} color={s.color} />}
              checked={s.id === task.statusId}
              onSelect={() => { if (s.id !== task.statusId) onPatch({ statusId: s.id }); }}
            >
              {s.name}
            </MenuItem>
          ))}
        </DropdownMenu>
      </Row>

      {/* Priority */}
      <Row label={t('tasks.priority')}>
        <DropdownMenu
          className="w-full"
          width={190}
          trigger={
            <Chip empty={task.priority === 'none'}>
              <PriorityIcon priority={task.priority} />
              <span className="truncate">{t(`task.priority.${task.priority}`)}</span>
            </Chip>
          }
        >
          {PRIORITIES.map((p) => (
            <MenuItem
              key={p}
              icon={<PriorityIcon priority={p} />}
              checked={p === task.priority}
              onSelect={() => { if (p !== task.priority) onPatch({ priority: p }); }}
            >
              {t(`task.priority.${p}`)}
            </MenuItem>
          ))}
        </DropdownMenu>
      </Row>

      {/* Assignees */}
      <Row label={t('tasks.assignees')}>
        <DropdownMenu
          className="w-full"
          width={220}
          trigger={
            <Chip empty={task.assignees.length === 0}>
              {task.assignees.length === 0 ? (
                <>
                  <UserPlus2 size={14} />
                  <span className="truncate">{t('task.unassigned')}</span>
                </>
              ) : (
                <>
                  <AvatarGroup users={task.assignees.map((a) => ({ id: a.userId, name: a.name }))} size={18} max={4} />
                  <span className="truncate">
                    {task.assignees.length === 1 ? task.assignees[0]!.name : task.assignees.length}
                  </span>
                </>
              )}
            </Chip>
          }
        >
          <MenuLabel>{t('tasks.assignees')}</MenuLabel>
          {users.map((u) => (
            <ToggleItem
              key={u.id}
              icon={<Avatar name={u.name} src={u.avatar} size={18} />}
              checked={assigneeIds.includes(u.id)}
              onToggle={() => toggleAssignee(u.id)}
            >
              {u.name}
            </ToggleItem>
          ))}
        </DropdownMenu>
      </Row>

      {/* Labels */}
      <Row label={t('task.labels')}>
        <DropdownMenu
          className="w-full"
          width={240}
          trigger={
            <Chip empty={task.labels.length === 0}>
              {task.labels.length === 0 ? (
                <>
                  <Tag size={14} />
                  <span className="truncate">{t('task.addLabel')}</span>
                </>
              ) : (
                <span className="flex flex-wrap items-center gap-1">
                  {task.labels.map((l) => (
                    <Badge key={l.id} color={l.color}>
                      <span className="h-1.5 w-1.5 rounded-full" style={{ backgroundColor: l.color }} />
                      {l.name}
                    </Badge>
                  ))}
                </span>
              )}
            </Chip>
          }
        >
          <LabelsMenu scope="task" value={labelIds} onChange={(ids) => onPatch({ labelIds: ids })} />
        </DropdownMenu>
      </Row>

      {/* Milestone */}
      <Row label={t('task.milestone')}>
        <DropdownMenu
          className="w-full"
          width={220}
          trigger={
            <Chip empty={!milestone}>
              <Diamond size={14} className={cn(milestone?.done && 'text-success')} fill={milestone?.done ? 'currentColor' : 'none'} />
              <span className="truncate">{milestone?.name ?? t('task.setMilestone')}</span>
            </Chip>
          }
        >
          {milestones.length === 0 && <MenuLabel>{t('task.noMilestones')}</MenuLabel>}
          {milestones.map((m) => (
            <MenuItem
              key={m.id}
              icon={<Diamond size={14} className={cn(m.done && 'text-success')} fill={m.done ? 'currentColor' : 'none'} />}
              checked={m.id === task.milestoneId}
              onSelect={() => onPatch({ milestoneId: m.id === task.milestoneId ? null : m.id })}
            >
              {m.name}
            </MenuItem>
          ))}
          {task.milestoneId && (
            <>
              <MenuSeparator />
              <MenuItem icon={<X size={14} />} danger onSelect={() => onPatch({ milestoneId: null })}>{t('task.clear')}</MenuItem>
            </>
          )}
        </DropdownMenu>
      </Row>

      <div className="mx-3 my-2 h-px bg-border" />

      {/* Due date */}
      <DateMenu
        label={t('tasks.dueDate')}
        emptyLabel={t('task.setDue')}
        icon={<CalendarDays size={14} className={cn(dueOverdue && 'text-destructive')} />}
        value={task.dueDate}
        overdue={dueOverdue}
        onSet={(v) => onPatch({ dueDate: v })}
        t={t}
      />

      {/* Start date */}
      <DateMenu
        label={t('task.startDate')}
        emptyLabel={t('task.setStart')}
        icon={<CalendarPlus size={14} />}
        value={task.startDate}
        onSet={(v) => onPatch({ startDate: v })}
        t={t}
      />

      {/* Estimate */}
      <Row label={t('task.estimate')}>
        <DropdownMenu
          className="w-full"
          width={190}
          trigger={
            <Chip empty={task.estimate == null}>
              <Gauge size={14} />
              <span className="truncate tabular-nums">
                {task.estimate != null ? `${task.estimate} ${t('task.points')}` : t('task.setEstimate')}
              </span>
            </Chip>
          }
        >
          <MenuLabel>{t('task.estimate')}</MenuLabel>
          <div className="px-2 pb-1.5">
            <EstimateInput onSubmit={(n) => onPatch({ estimate: n })} />
          </div>
          <MenuSeparator />
          <div className="grid grid-cols-6 gap-0.5 px-1 pb-1">
            {[1, 2, 3, 5, 8, 13].map((n) => (
              <MenuItem key={n} onSelect={() => onPatch({ estimate: n })}>
                <span className="block text-center tabular-nums">{n}</span>
              </MenuItem>
            ))}
          </div>
          {task.estimate != null && (
            <>
              <MenuSeparator />
              <MenuItem icon={<X size={14} />} danger onSelect={() => onPatch({ estimate: null })}>{t('task.clear')}</MenuItem>
            </>
          )}
        </DropdownMenu>
      </Row>

      <div className="mx-3 my-2 h-px bg-border" />

      {/* Git */}
      <div className="px-1.5 pb-1">
        <GitBlock taskId={task.id} links={task.gitLinks ?? []} showLinks={hasRepos} />
      </div>

      <div className="mx-3 my-2 h-px bg-border" />

      <div className="space-y-1 px-3 pt-1 text-xs text-faint">
        <p className="flex justify-between gap-2"><span>{t('task.created')}</span><span>{fmtDate(task.createdAt)}</span></p>
        <p className="flex justify-between gap-2"><span>{t('task.updated')}</span><span>{fmtDate(task.updatedAt)}</span></p>
      </div>
    </div>
  );
}
