/**
 * Linear-style Display popover: view layout segmented control, grouping /
 * ordering selects, sub-task & empty-group switches, and display-property
 * chips. Footer resets to defaults.
 */
import type { ReactNode } from 'react';
import {
  ArrowDownWideNarrow, ArrowUpNarrowWide, CalendarDays, Columns3, GanttChart, List, SlidersHorizontal, Table2,
} from 'lucide-react';
import { IconButton, SegmentedControl, Select, Switch, Tooltip, cn } from '../ui';
import { DropdownMenu } from '../overlays';
import { useT } from '../../lib/i18n';
import {
  DEFAULT_PREFS, DISPLAY_PROPS, GROUPINGS, ORDERINGS,
  type DisplayProp, type Grouping, type Ordering, type TaskView, type TaskViewPrefs,
} from './taskViewPrefs';

const VIEW_ICONS: { key: TaskView; icon: ReactNode; labelKey: string }[] = [
  { key: 'list', icon: <List size={14} />, labelKey: 'tasks.list' },
  { key: 'board', icon: <Columns3 size={14} />, labelKey: 'tasks.board' },
  { key: 'calendar', icon: <CalendarDays size={14} />, labelKey: 'tasks.calendar' },
  { key: 'timeline', icon: <GanttChart size={14} />, labelKey: 'tasks.timeline' },
  { key: 'spreadsheet', icon: <Table2 size={14} />, labelKey: 'tasks.spreadsheet' },
];

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex h-8 items-center justify-between gap-3 px-1">
      <span className="truncate text-[13px] text-muted-foreground">{label}</span>
      <span className="shrink-0">{children}</span>
    </div>
  );
}

export function DisplayPopover({ prefs, onChange }: {
  prefs: TaskViewPrefs; onChange: (patch: Partial<TaskViewPrefs>) => void;
}) {
  const t = useT();

  const groupingLabel: Record<Grouping, string> = {
    status: t('common.status'), assignee: t('tasksview.assignee'), priority: t('tasks.priority'),
    label: t('tasksview.labels'), milestone: t('tasksview.milestone'), none: t('tasksview.none'),
  };
  const orderingLabel: Record<Ordering, string> = {
    priority: t('tasks.priority'), dueDate: t('tasks.dueDate'), created: t('tasksview.orderCreated'), title: t('common.title'),
  };
  const propLabel: Record<DisplayProp, string> = {
    id: t('tasksview.propId'), priority: t('tasks.priority'), status: t('common.status'),
    assignee: t('tasksview.assignee'), labels: t('tasksview.labels'), dueDate: t('tasks.dueDate'),
    progress: t('tasksview.propProgress'),
  };

  const isListy = prefs.view === 'list' || prefs.view === 'board';
  const desc = prefs.orderingDir === 'desc';
  const dirLabel = t(desc ? 'tasksview.orderDesc' : 'tasksview.orderAsc');

  return (
    <DropdownMenu
      align="end"
      width={300}
      trigger={
        <Tooltip label={t('tasksview.display')} side="bottom">
          <IconButton size="md" aria-label={t('tasksview.display')}>
            <SlidersHorizontal size={15} />
          </IconButton>
        </Tooltip>
      }
    >
      <div className="px-1.5 pb-1.5 pt-1.5">
        <SegmentedControl
          className="w-full"
          options={VIEW_ICONS.map((v) => ({ key: v.key, label: v.icon, title: t(v.labelKey) }))}
          value={prefs.view}
          onChange={(v) => onChange({ view: v })}
        />
      </div>

      <div className="border-t border-border px-1 py-1">
        <Row label={t('tasksview.grouping')}>
          <Select
            value={prefs.grouping}
            disabled={!isListy}
            onChange={(e) => onChange({ grouping: e.target.value as Grouping })}
            className="h-7 w-[130px] text-xs"
          >
            {GROUPINGS.map((g) => <option key={g} value={g}>{groupingLabel[g]}</option>)}
          </Select>
        </Row>
        <Row label={t('tasksview.ordering')}>
          <span className="flex items-center gap-1">
            <Select
              value={prefs.ordering}
              onChange={(e) => onChange({ ordering: e.target.value as Ordering })}
              className="h-7 w-[130px] text-xs"
            >
              {ORDERINGS.map((o) => <option key={o} value={o}>{orderingLabel[o]}</option>)}
            </Select>
            <Tooltip label={dirLabel} side="bottom">
              <IconButton
                size="sm"
                aria-label={dirLabel}
                onClick={() => onChange({ orderingDir: desc ? 'asc' : 'desc' })}
              >
                {desc ? <ArrowDownWideNarrow size={14} /> : <ArrowUpNarrowWide size={14} />}
              </IconButton>
            </Tooltip>
          </span>
        </Row>
        <Row label={t('tasksview.showSubtasks')}>
          <Switch checked={prefs.showSubtasks} onChange={(v) => onChange({ showSubtasks: v })} label={t('tasksview.showSubtasks')} />
        </Row>
        <Row label={t('tasksview.showEmptyGroups')}>
          <Switch checked={prefs.showEmptyGroups} onChange={(v) => onChange({ showEmptyGroups: v })} label={t('tasksview.showEmptyGroups')} />
        </Row>
      </div>

      <div className="border-t border-border px-1 pb-1.5 pt-1.5">
        <p className="px-1 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">{t('tasksview.displayProps')}</p>
        <div className="flex flex-wrap gap-1 px-1">
          {DISPLAY_PROPS.map((p) => {
            const on = prefs.props[p];
            return (
              <button
                key={p}
                type="button"
                aria-pressed={on}
                onClick={() => onChange({ props: { ...prefs.props, [p]: !on } })}
                className={cn(
                  'rounded-md border px-2 py-0.5 text-xs transition-colors duration-150',
                  on
                    ? 'border-border-strong bg-muted font-medium text-foreground'
                    : 'border-border text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                )}
              >
                {propLabel[p]}
              </button>
            );
          })}
        </div>
      </div>

      <div className="flex items-center justify-end border-t border-border px-1.5 pb-0.5 pt-1.5">
        <button
          type="button"
          onClick={() => onChange({ ...DEFAULT_PREFS, view: prefs.view, collapsed: prefs.collapsed })}
          className="rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors duration-150 hover:bg-muted hover:text-foreground"
        >
          {t('tasksview.reset')}
        </button>
      </div>
    </DropdownMenu>
  );
}
