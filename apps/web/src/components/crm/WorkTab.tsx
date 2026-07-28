import { useState } from 'react';
import { AlertCircle, CalendarClock, Check, Clock3, Inbox, PauseCircle } from 'lucide-react';
import { useNavigate } from '../../lib/router';
import { useCan } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { Button, EmptyState, Skeleton, fmtRelative } from '../ui';
import { CompleteActivityDialog, ScheduleActivityDialog } from './SalesActivityPanel';
import { salesActivityTypeLabel, useSalesWork, type SalesActivity, type SalesWorkItem } from './shared';

export function WorkTab() {
  const t = useT();
  const can = useCan();
  const workQ = useSalesWork();
  const [complete, setComplete] = useState<SalesActivity | null>(null);
  const [schedule, setSchedule] = useState<SalesWorkItem | null>(null);

  if (workQ.isLoading) {
    return <div className="space-y-3 p-6">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-20" />)}</div>;
  }

  const work = workQ.data;
  if (!work) return <EmptyState title={t('common.error')} />;
  const total = Object.values(work).reduce((sum, rows) => sum + rows.length, 0);
  if (total === 0) {
    return <EmptyState icon={<Check size={20} />} title={t('crm.allCaughtUp')} hint={t('crm.workHint')} />;
  }

  const groups = [
    { key: 'overdue', title: t('crm.queue.overdue'), rows: work.overdue, icon: <AlertCircle size={15} className="text-destructive" /> },
    { key: 'today', title: t('crm.queue.today'), rows: work.dueToday, icon: <Clock3 size={15} className="text-warning" /> },
    { key: 'waiting', title: t('crm.queue.waiting'), rows: work.waitingReply, icon: <Inbox size={15} className="text-primary" /> },
    { key: 'nurture', title: t('crm.queue.nurture'), rows: work.nurtureDue, icon: <PauseCircle size={15} className="text-muted-foreground" /> },
    { key: 'none', title: t('crm.queue.noAction'), rows: work.noNextAction, icon: <CalendarClock size={15} className="text-faint" /> },
  ];

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-5xl space-y-6">
        <div>
          <h2 className="text-base font-semibold">{t('crm.workTitle')}</h2>
          <p className="text-[13px] text-muted-foreground">{t('crm.workHint')}</p>
        </div>
        {groups.filter((group) => group.rows.length > 0).map((group) => (
          <section key={group.key}>
            <div className="mb-2 flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {group.icon}
              <span>{group.title}</span>
              <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] tabular-nums">{group.rows.length}</span>
            </div>
            <div className="divide-y divide-border rounded-lg border border-border bg-card">
              {group.rows.map((row) => (
                <WorkRow
                  key={`${row.entityType}:${row.id}`}
                  row={row}
                  canWrite={row.entityType === 'lead' ? can('crm.write') : can('deals.write')}
                  onComplete={() => row.nextActivity && setComplete(row.nextActivity)}
                  onSchedule={() => setSchedule(row)}
                />
              ))}
            </div>
          </section>
        ))}
      </div>
      <CompleteActivityDialog activity={complete} onClose={() => setComplete(null)} />
      <ScheduleActivityDialog
        open={!!schedule}
        onClose={() => setSchedule(null)}
        leadId={schedule?.entityType === 'lead' ? schedule.id : undefined}
        dealId={schedule?.entityType === 'deal' ? schedule.id : undefined}
      />
    </div>
  );
}

function WorkRow({ row, canWrite, onComplete, onSchedule }: {
  row: SalesWorkItem;
  canWrite: boolean;
  onComplete: () => void;
  onSchedule: () => void;
}) {
  const t = useT();
  const navigate = useNavigate();
  const href = row.entityType === 'lead' ? `/leads/${row.id}` : `/deals/${row.id}`;
  return (
    <div className="flex items-center transition-colors hover:bg-muted/50">
      <button type="button" onClick={() => navigate(href)} className="flex min-w-0 flex-1 items-center gap-3 px-3 py-2.5 text-left">
        <span className={`h-2 w-2 shrink-0 rounded-full ${row.entityType === 'lead' ? 'bg-warning' : 'bg-primary'}`} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate text-[13px] font-medium">{row.title}</span>
            <span className="shrink-0 text-xs text-faint">{row.entityType === 'lead' ? t('crm.lead') : t('crm.deal')}</span>
          </div>
          <div className="mt-0.5 flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="truncate">{row.companyName}</span>
            <span>·</span>
            <span className="truncate">
              {row.nextActivity?.subject || (row.nextActivity?.type ? salesActivityTypeLabel(t, row.nextActivity.type) : row.status)}
            </span>
          </div>
        </div>
        {row.nextActivity?.dueAt && <span className="hidden shrink-0 text-xs text-muted-foreground sm:block">{fmtRelative(row.nextActivity.dueAt)}</span>}
      </button>
      {canWrite && (
        <Button
          size="xs"
          variant="outline"
          className="mr-3 shrink-0"
          onClick={() => row.nextActivity ? onComplete() : onSchedule()}
        >
          {row.nextActivity ? <><Check size={12} /> {t('crm.completeAction')}</> : <><CalendarClock size={12} /> {t('crm.scheduleAction')}</>}
        </Button>
      )}
    </div>
  );
}
