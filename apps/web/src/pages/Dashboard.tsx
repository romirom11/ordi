import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { AlertTriangle, CalendarClock, CalendarDays, Activity, CheckCircle2 } from 'lucide-react';
import { api } from '../lib/api';
import { useNavigate } from '../lib/router';
import { useMe } from '../lib/auth';
import { Card, PageHeader, Skeleton, EmptyState, Badge, fmtMoney, fmtDate, cn } from '../components/ui';
import { useT } from '../lib/i18n';

interface TaskLite {
  id: string;
  taskId?: string;
  projectId?: string;
  projectKey?: string;
  number?: number;
  title: string;
  priority?: string;
  dueDate?: string | null;
}
interface DealStageAgg {
  stageId?: string;
  stageName?: string;
  name?: string;
  count?: number;
  amount?: number | string;
}
interface ActivityItem {
  id: string;
  action?: string;
  actorName?: string;
  summary?: string;
  message?: string;
  createdAt?: string;
}
interface DashboardData {
  myTasks?: { overdue?: TaskLite[]; today?: TaskLite[]; upcoming?: TaskLite[] };
  receivables?: unknown;
  overdue?: unknown;
  dealsByStage?: DealStageAgg[];
  recentActivity?: ActivityItem[];
  projectCount?: number;
}

const PRIORITY_COLOR: Record<string, string> = {
  urgent: '#ef4444', high: '#f97316', medium: '#eab308', low: '#3b82f6', none: '#9ca3af',
};

function PriorityDot({ priority }: { priority?: string }) {
  return <span className="inline-block h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: PRIORITY_COLOR[priority ?? 'none'] ?? PRIORITY_COLOR.none }} />;
}

function taskKey(t: TaskLite): string {
  if (t.projectKey && t.number != null) return `${t.projectKey}-${t.number}`;
  return '';
}

type MoneyRow = { label: string; amount: number; currency: string };
function normalizeMoney(value: unknown, label: string): MoneyRow[] {
  if (value == null) return [];
  const pick = (o: Record<string, unknown>): number =>
    Number(o.outstanding ?? o.receivable ?? o.total ?? o.amount ?? o.value ?? 0);
  if (Array.isArray(value)) {
    return value.map((v) => {
      const o = (v ?? {}) as Record<string, unknown>;
      return { label, amount: pick(o), currency: String(o.currency ?? 'USD') };
    });
  }
  if (typeof value === 'object') {
    const o = value as Record<string, unknown>;
    return [{ label, amount: pick(o), currency: String(o.currency ?? 'USD') }];
  }
  if (typeof value === 'number') return [{ label, amount: value, currency: 'USD' }];
  return [];
}

export function DashboardPage() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const { data, isLoading } = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
  });

  const openTask = (t: TaskLite) => {
    const pid = t.projectId;
    const tid = t.taskId ?? t.id;
    if (pid && tid) navigate(`/projects/${pid}/tasks/${tid}`);
  };

  const myTasks = data?.myTasks ?? {};
  const buckets: { key: string; label: string; icon: ReactNode; tasks: TaskLite[] }[] = [
    { key: 'overdue', label: t('common.overdue'), icon: <AlertTriangle size={14} className="text-destructive" />, tasks: myTasks.overdue ?? [] },
    { key: 'today', label: t('common.today'), icon: <CalendarClock size={14} />, tasks: myTasks.today ?? [] },
    { key: 'upcoming', label: t('common.upcoming'), icon: <CalendarDays size={14} />, tasks: myTasks.upcoming ?? [] },
  ];
  const totalTasks = buckets.reduce((n, b) => n + b.tasks.length, 0);

  const receivables = [
    ...normalizeMoney(data?.receivables, 'finance.receivable'),
    ...normalizeMoney(data?.overdue, 'finance.overdue'),
  ].filter((r) => r.amount !== 0 || r.label === 'finance.receivable');

  const dealsByStage = data?.dealsByStage ?? [];
  const maxDeal = Math.max(1, ...dealsByStage.map((d) => Number(d.amount ?? 0)));

  return (
    <div>
      <PageHeader title={`${t('dashboard.greeting')}, ${me.user.name.split(' ')[0] ?? me.user.name}`} subtitle={t('dashboard.subtitle')} />

      {isLoading ? (
        <div className="grid gap-4 p-6 md:grid-cols-2">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40" />)}
        </div>
      ) : (
        <div className="grid gap-4 p-6 md:grid-cols-2">
          {/* My tasks */}
          <Card className="p-4 md:col-span-2">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('nav.myTasks')}</h2>
              <button onClick={() => navigate('/my-tasks')} className="text-xs text-muted-foreground hover:text-foreground">{t('common.viewAll')}</button>
            </div>
            {totalTasks === 0 ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <CheckCircle2 size={16} className="text-primary" /> {t('dashboard.allCaughtUp')}
              </div>
            ) : (
              <div className="grid gap-4 sm:grid-cols-3">
                {buckets.map((b) => (
                  <div key={b.key}>
                    <div className="mb-2 flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                      {b.icon} {b.label} <span className="ml-auto rounded bg-muted px-1.5 py-0.5 tabular-nums">{b.tasks.length}</span>
                    </div>
                    <div className="space-y-0.5">
                      {b.tasks.slice(0, 5).map((t) => (
                        <button key={t.id} onClick={() => openTask(t)}
                          className="flex w-full items-center gap-2 rounded px-1.5 py-1 text-left text-sm hover:bg-muted">
                          <PriorityDot priority={t.priority} />
                          {taskKey(t) && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{taskKey(t)}</span>}
                          <span className="truncate">{t.title}</span>
                        </button>
                      ))}
                      {b.tasks.length === 0 && <p className="px-1.5 text-xs text-muted-foreground">{t('dashboard.nothingHere')}</p>}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {/* Receivables (present only when finance data is returned) */}
          {receivables.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold">{t('finance.receivables')}</h2>
              <div className="grid grid-cols-2 gap-3">
                {receivables.map((r, i) => (
                  <div key={i} className="rounded-md border border-border p-3">
                    <p className="text-xs text-muted-foreground">{t(r.label)}</p>
                    <p className={cn('mt-1 text-lg font-semibold tabular-nums', r.label === 'finance.overdue' && r.amount > 0 && 'text-destructive')}>
                      {fmtMoney(r.amount, r.currency)}
                    </p>
                  </div>
                ))}
              </div>
            </Card>
          )}

          {/* Deals by stage */}
          {dealsByStage.length > 0 && (
            <Card className="p-4">
              <h2 className="mb-3 text-sm font-semibold">{t('dashboard.dealsByStage')}</h2>
              <div className="space-y-2">
                {dealsByStage.map((d, i) => {
                  const amt = Number(d.amount ?? 0);
                  return (
                    <div key={d.stageId ?? i}>
                      <div className="mb-0.5 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{d.stageName ?? d.name ?? t('deals.stage')}</span>
                        <span className="tabular-nums">{d.count ?? 0} · {fmtMoney(amt)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                        <div className="h-full rounded-full bg-primary" style={{ width: `${Math.round((amt / maxDeal) * 100)}%` }} />
                      </div>
                    </div>
                  );
                })}
              </div>
            </Card>
          )}

          {/* Recent activity */}
          <Card className="p-4 md:col-span-2">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Activity size={14} /> {t('dashboard.recentActivity')}</h2>
            {(data?.recentActivity ?? []).length === 0 ? (
              <EmptyState title={t('dashboard.noActivity')} hint={t('dashboard.noActivityHint')} />
            ) : (
              <ul className="space-y-2">
                {(data?.recentActivity ?? []).slice(0, 12).map((a) => (
                  <li key={a.id} className="flex items-start gap-2 text-sm">
                    <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-muted-foreground/50" />
                    <span className="flex-1">
                      {a.actorName && <span className="font-medium">{a.actorName} </span>}
                      <span className="text-muted-foreground">{a.summary ?? a.message ?? a.action ?? t('dashboard.madeChange')}</span>
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">{fmtDate(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      )}
    </div>
  );
}
