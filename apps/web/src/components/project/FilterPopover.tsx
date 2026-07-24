/**
 * Linear-style Filter popover: a search field on top, then filter dimensions
 * (Status / Priority / Assignee / Labels / Due date). Picking a dimension slides
 * to its option list; options multi-select without closing the popover.
 */
import { useMemo, useState, type ReactNode } from 'react';
import { CalendarDays, Check, ChevronLeft, ChevronRight, Filter, Search, Tag, UserCircle2 } from 'lucide-react';
import { Avatar, IconButton, PriorityIcon, StatusIcon, Tooltip, cn } from '../ui';
import { DropdownMenu } from '../overlays';
import { useT } from '../../lib/i18n';
import {
  DUE_LABEL_KEY, DUE_PRESETS, PRIORITIES, PRIORITY_LABEL_KEY,
  countFilters, type DuePreset, type TaskFilters,
} from './taskViewPrefs';
import type { UserLite } from './pickers';

export interface LabelLite { id: string; name: string; color?: string | null }
export interface StatusLite { id: string; name: string; category?: string; color?: string }

type Dim = 'status' | 'priority' | 'assignee' | 'label' | 'due';

function toggle(list: string[], id: string): string[] {
  return list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
}

function OptionRow({ icon, label, selected, onToggle }: {
  icon: ReactNode; label: string; selected: boolean; onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
    >
      <span className="shrink-0 text-muted-foreground [&>svg]:block">{icon}</span>
      <span className="flex-1 truncate">{label}</span>
      {selected && <Check size={14} className="shrink-0 text-primary" />}
    </button>
  );
}

function FilterPanel({ statuses, labels, users, filters, onChange }: {
  statuses: StatusLite[]; labels: LabelLite[]; users: UserLite[];
  filters: TaskFilters; onChange: (f: TaskFilters) => void;
}) {
  const t = useT();
  const [dim, setDim] = useState<Dim | null>(null);
  const [query, setQuery] = useState('');

  const dims: { key: Dim; label: string; icon: ReactNode; count: number }[] = [
    { key: 'status', label: t('common.status'), icon: <StatusIcon category="todo" size={14} />, count: filters.statusIds.length },
    { key: 'priority', label: t('tasks.priority'), icon: <PriorityIcon priority="high" size={14} />, count: filters.priorities.length },
    { key: 'assignee', label: t('tasksview.assignee'), icon: <UserCircle2 size={14} />, count: filters.assigneeIds.length },
    { key: 'label', label: t('tasksview.labels'), icon: <Tag size={14} />, count: filters.labelIds.length },
    { key: 'due', label: t('tasks.dueDate'), icon: <CalendarDays size={14} />, count: filters.due ? 1 : 0 },
  ];

  const q = query.trim().toLowerCase();
  const match = (s: string) => !q || s.toLowerCase().includes(q);
  const enter = (d: Dim) => { setDim(d); setQuery(''); };
  const back = () => { setDim(null); setQuery(''); };

  const options = useMemo(() => {
    switch (dim) {
      case 'status':
        return statuses.filter((s) => match(s.name)).map((s) => ({
          key: s.id,
          icon: <StatusIcon category={s.category} color={s.color} size={14} />,
          label: s.name,
          selected: filters.statusIds.includes(s.id),
          toggle: () => onChange({ ...filters, statusIds: toggle(filters.statusIds, s.id) }),
        }));
      case 'priority':
        return PRIORITIES.filter((p) => match(t(PRIORITY_LABEL_KEY[p]!))).map((p) => ({
          key: p,
          icon: <PriorityIcon priority={p} size={14} />,
          label: t(PRIORITY_LABEL_KEY[p]!),
          selected: filters.priorities.includes(p),
          toggle: () => onChange({ ...filters, priorities: toggle(filters.priorities, p) }),
        }));
      case 'assignee':
        return users.filter((u) => match(u.name)).map((u) => ({
          key: u.id,
          icon: <Avatar name={u.name} src={u.avatar} size={16} />,
          label: u.name,
          selected: filters.assigneeIds.includes(u.id),
          toggle: () => onChange({ ...filters, assigneeIds: toggle(filters.assigneeIds, u.id) }),
        }));
      case 'label':
        return labels.filter((l) => match(l.name)).map((l) => ({
          key: l.id,
          icon: <span className="mx-0.5 block h-2.5 w-2.5 rounded-full" style={{ backgroundColor: l.color ?? '#8a8f98' }} />,
          label: l.name,
          selected: filters.labelIds.includes(l.id),
          toggle: () => onChange({ ...filters, labelIds: toggle(filters.labelIds, l.id) }),
        }));
      case 'due':
        return DUE_PRESETS.filter((p) => match(t(DUE_LABEL_KEY[p]))).map((p: DuePreset) => ({
          key: p,
          icon: <CalendarDays size={14} />,
          label: t(DUE_LABEL_KEY[p]),
          selected: filters.due === p,
          toggle: () => onChange({ ...filters, due: filters.due === p ? null : p }),
        }));
      default:
        return [];
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dim, q, statuses, labels, users, filters, onChange, t]);

  return (
    <div className="w-full">
      {/* Search / breadcrumb header */}
      <div className="flex items-center gap-1.5 border-b border-border px-2 pb-2 pt-1">
        {dim ? (
          <button
            type="button"
            onClick={back}
            aria-label={t('common.close')}
            className="grid h-5 w-5 shrink-0 place-items-center rounded text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
          >
            <ChevronLeft size={13} />
          </button>
        ) : (
          <Search size={13} className="shrink-0 text-faint" />
        )}
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Backspace' && !query && dim) { e.preventDefault(); back(); }
            if (e.key === 'Enter' && dim && options.length > 0) { e.preventDefault(); options[0]!.toggle(); }
          }}
          placeholder={dim ? dims.find((d) => d.key === dim)?.label : t('tasksview.addFilter')}
          className="h-6 min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-faint"
        />
      </div>

      <div className="max-h-72 overflow-y-auto pt-1">
        {dim === null
          ? dims.filter((d) => match(d.label)).map((d) => (
            <button
              key={d.key}
              type="button"
              onClick={() => enter(d.key)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
            >
              <span className="shrink-0 text-muted-foreground [&>svg]:block">{d.icon}</span>
              <span className="flex-1 truncate">{d.label}</span>
              {d.count > 0 && (
                <span className="rounded bg-primary/15 px-1 text-[11px] font-medium tabular-nums text-primary">{d.count}</span>
              )}
              <ChevronRight size={12} className="shrink-0 text-faint" />
            </button>
          ))
          : options.map((o) => (
            <OptionRow key={o.key} icon={o.icon} label={o.label} selected={o.selected} onToggle={o.toggle} />
          ))}
        {dim !== null && options.length === 0 && (
          <p className="px-2 py-3 text-center text-xs text-faint">{t('common.nothingYet')}</p>
        )}
      </div>
    </div>
  );
}

export function FilterPopover({ statuses, labels, users, filters, onChange }: {
  statuses: StatusLite[]; labels: LabelLite[]; users: UserLite[];
  filters: TaskFilters; onChange: (f: TaskFilters) => void;
}) {
  const t = useT();
  const active = countFilters(filters) > 0;
  return (
    <DropdownMenu
      align="end"
      width={252}
      trigger={
        <Tooltip label={t('tasksview.filter')} side="bottom">
          <IconButton size="md" aria-label={t('tasksview.filter')} className={cn(active && 'bg-muted text-foreground')}>
            <Filter size={15} />
          </IconButton>
        </Tooltip>
      }
    >
      <FilterPanel statuses={statuses} labels={labels} users={users} filters={filters} onChange={onChange} />
    </DropdownMenu>
  );
}
