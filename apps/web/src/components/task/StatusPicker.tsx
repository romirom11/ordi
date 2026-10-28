/**
 * The status circle of a task row, made clickable: pick a status without
 * opening the task.
 *
 * The right-click menu offered this already, but nothing suggested it exists –
 * an icon that opens a picker on the same click that would otherwise open the
 * card is the discoverable form. It started in the project list (ORD-14) and
 * moved here so every list of tasks gets the same circle (ORD-36); the statuses
 * come from the shared lookup, which is what lets a list spanning several
 * projects, like My tasks, use it row by row.
 */
import { Spinner, StatusIcon } from '../ui';
import { DropdownMenu, MenuItem, MenuLabel } from '../overlays';
import { useTaskStatuses, type TaskStatusLookup } from '../../lib/queries';
import { useT } from '../../lib/i18n';

export function TaskStatusPicker({ projectId, statusId, category, color, statusName, canWrite, size = 14, onPick }: {
  projectId: string;
  /** The task's current status – ticked in the menu, and never re-sent. */
  statusId?: string;
  category?: string;
  color?: string;
  /** Tooltip on the circle; the row usually has no other room to name the status. */
  statusName?: string;
  canWrite: boolean;
  size?: number;
  /** The whole status, not just its id – callers repaint the row from it. */
  onPick: (status: TaskStatusLookup) => void;
}) {
  const t = useT();
  // Prefetched while the row renders rather than on open: the menu measures
  // itself once to stay inside the viewport, so content arriving late would
  // leave a bottom row's menu hanging off the screen.
  const statusesQ = useTaskStatuses(projectId, canWrite);
  const statuses = statusesQ.data ?? [];

  const icon = <StatusIcon category={category} color={color} size={size} />;
  if (!canWrite) return icon;

  return (
    <DropdownMenu
      className="shrink-0"
      trigger={(
        <span
          role="button"
          tabIndex={0}
          aria-label={t('common.status')}
          title={statusName}
          className="-m-1 grid h-6 w-6 cursor-pointer place-items-center rounded-md transition-colors duration-150 hover:bg-muted [&>svg]:block"
        >
          {icon}
        </span>
      )}
    >
      <MenuLabel>{t('common.status')}</MenuLabel>
      {statuses.length === 0 ? (
        <div className="grid h-14 place-items-center">
          {statusesQ.isLoading ? <Spinner className="h-3.5 w-3.5" /> : <span className="text-[13px] text-faint">{t('common.nothingYet')}</span>}
        </div>
      ) : statuses.map((s) => (
        <MenuItem key={s.id} onSelect={() => { if (s.id !== statusId) onPick(s); }}>
          <span className="flex items-center gap-2">
            <StatusIcon category={s.category} color={s.color} size={14} /> {s.name}
            {s.id === statusId && <span className="ml-auto pl-2 text-primary">✓</span>}
          </span>
        </MenuItem>
      ))}
    </DropdownMenu>
  );
}
