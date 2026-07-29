import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  AlertTriangle, Activity, CheckCircle2, ListTodo, Receipt, Handshake,
  FolderKanban, CheckSquare, MessageSquare, Users, Building2, BookText, Clock,
  CalendarRange, User as UserIcon, Rocket, ChevronRight, X,
} from 'lucide-react';
import { api } from '../lib/api';
import { useNavigate, useOpen } from '../lib/router';
import { useMe, useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { Card, Kbd, PageHeader, Skeleton, EmptyState, PriorityIcon, ProgressBar, fmtMoney, fmtDate, fmtRelative, cn } from '../components/ui';
import { extendDict, useT } from '../lib/i18n';

extendDict({
  en: {
    'dashboard.myOpenTasks': 'My open tasks',
    'dashboard.activeDealsValue': 'Active deals value',
    'dashboard.outstanding': 'Outstanding',
    'dashboard.you': 'You',
    'dashboard.noDeals': 'No open deals',
    'dashboard.noDealsHint': 'Deals in progress will show up here.',
    'onboarding.title': 'Getting started',
    'onboarding.subtitle': 'A few steps to make ordi yours.',
    'onboarding.project': 'Create your first project',
    'onboarding.task': 'Create a task',
    'onboarding.taskHint': 'Press',
    'onboarding.team': 'Invite your team',
    'onboarding.client': 'Add your first client',
    'onboarding.progress': '{done} of {total} done',
    'activity.verb.created': 'created',
    'activity.verb.updated': 'updated',
    'activity.verb.deleted': 'deleted',
    'activity.verb.viewed': 'viewed',
    'activity.verb.member_added': 'added a member to',
    'activity.verb.member_removed': 'removed a member from',
    'activity.verb.status_changed': 'changed the status of',
    'activity.verb.stage_changed': 'moved',
    'activity.verb.payment_recorded': 'recorded a payment on',
    'activity.verb.moved': 'moved',
    'activity.verb.archived': 'archived',
    'activity.verb.restored': 'restored',
    'activity.verb.published': 'published',
    'activity.verb.commented': 'commented on',
    'activity.verb.sent': 'sent',
    'activity.verb.paid': 'paid',
    'activity.verb.desktop.authorize': 'signed in to the desktop app as',
    'activity.verb.oauth.authorize': 'authorized an MCP client as',
    'activity.verb.invite_revoked': 'revoked an invitation for',
    'activity.verb.role_changed': 'changed the role of',
    'activity.verb.deactivated': 'deactivated',
    'activity.verb.totp_enabled': 'enabled two-factor auth for',
    'activity.verb.totp_disabled': 'disabled two-factor auth for',
    'activity.noun.task': 'a task',
    'activity.noun.project': 'a project',
    'activity.noun.deal': 'a deal',
    'activity.noun.invoice': 'an invoice',
    'activity.noun.quote': 'a quote',
    'activity.noun.recurring_invoice': 'a subscription',
    'activity.noun.expense': 'an expense',
    'activity.noun.credit_note': 'a credit note',
    'activity.noun.contact': 'a contact',
    'activity.noun.company': 'a client',
    'activity.noun.note': 'a note',
    'activity.noun.comment': 'a comment',
    'activity.noun.employee': 'an employee profile',
    'activity.noun.leave_request': 'a leave request',
    'activity.noun.applicant': 'an applicant',
    'activity.noun.job_opening': 'a job opening',
    'activity.noun.allocation': 'an allocation',
    'activity.noun.time_entry': 'a time entry',
    'activity.noun.compensation': 'compensation',
    'activity.noun.kb_page': 'a knowledge page',
    'activity.noun.kb_space': 'a knowledge space',
    'activity.noun.kb_page_comment': 'a page comment',
    'activity.noun.cycle': 'a cycle',
    'activity.noun.user': 'a user',
    'activity.noun.custom_field': 'a custom field',
    'activity.noun.attachment': 'a file',
  },
  uk: {
    'dashboard.myOpenTasks': 'Мої відкриті задачі',
    'dashboard.activeDealsValue': 'Сума активних угод',
    'dashboard.outstanding': 'Заборгованість',
    'dashboard.you': 'Ви',
    'dashboard.noDeals': 'Немає відкритих угод',
    'dashboard.noDealsHint': 'Угоди в роботі зʼявляться тут.',
    'onboarding.title': 'Початок роботи',
    'onboarding.subtitle': 'Кілька кроків, щоб зробити ordi своїм.',
    'onboarding.project': 'Створіть перший проєкт',
    'onboarding.task': 'Створіть задачу',
    'onboarding.taskHint': 'Натисніть',
    'onboarding.team': 'Запросіть команду',
    'onboarding.client': 'Додайте першого клієнта',
    'onboarding.progress': 'Виконано {done} з {total}',
    'activity.verb.created': 'створено',
    'activity.verb.updated': 'оновлено',
    'activity.verb.deleted': 'видалено',
    'activity.verb.viewed': 'переглянуто',
    'activity.verb.member_added': 'додано учасника до',
    'activity.verb.member_removed': 'вилучено учасника з',
    'activity.verb.status_changed': 'змінено статус',
    'activity.verb.stage_changed': 'переміщено',
    'activity.verb.payment_recorded': 'зафіксовано платіж за',
    'activity.verb.desktop.authorize': 'вхід у десктопний застосунок як',
    'activity.verb.oauth.authorize': 'надано доступ MCP-клієнту як',
    'activity.verb.invite_revoked': 'скасовано запрошення для',
    'activity.verb.role_changed': 'змінено роль',
    'activity.verb.deactivated': 'деактивовано',
    'activity.verb.totp_enabled': 'увімкнено двофакторний вхід для',
    'activity.verb.totp_disabled': 'вимкнено двофакторний вхід для',
    'activity.verb.payment_recorded.you': 'зафіксували платіж за',
    'activity.verb.moved': 'переміщено',
    'activity.verb.archived': 'архівовано',
    'activity.verb.restored': 'відновлено',
    'activity.verb.published': 'опубліковано',
    'activity.verb.commented': 'прокоментовано',
    'activity.verb.sent': 'надіслано',
    'activity.verb.paid': 'оплачено',
    // 2nd-person forms used after the "Ви" prefix ("Ви створили…").
    'activity.verb.created.you': 'створили',
    'activity.verb.updated.you': 'оновили',
    'activity.verb.deleted.you': 'видалили',
    'activity.verb.viewed.you': 'переглянули',
    'activity.verb.member_added.you': 'додали учасника до',
    'activity.verb.member_removed.you': 'вилучили учасника з',
    'activity.verb.status_changed.you': 'змінили статус',
    'activity.verb.stage_changed.you': 'перемістили',
    'activity.verb.moved.you': 'перемістили',
    'activity.verb.archived.you': 'архівували',
    'activity.verb.restored.you': 'відновили',
    'activity.verb.published.you': 'опублікували',
    'activity.verb.commented.you': 'прокоментували',
    'activity.verb.sent.you': 'надіслали',
    'activity.verb.paid.you': 'оплатили',
    'activity.noun.task': 'задачу',
    'activity.noun.project': 'проєкт',
    'activity.noun.deal': 'угоду',
    'activity.noun.invoice': 'рахунок',
    'activity.noun.quote': 'кошторис',
    'activity.noun.recurring_invoice': 'підписку',
    'activity.noun.expense': 'витрату',
    'activity.noun.credit_note': 'кредит-ноту',
    'activity.noun.contact': 'контакт',
    'activity.noun.company': 'клієнта',
    'activity.noun.note': 'нотатку',
    'activity.noun.comment': 'коментар',
    'activity.noun.employee': 'профіль співробітника',
    'activity.noun.leave_request': 'запит на відпустку',
    'activity.noun.applicant': 'кандидата',
    'activity.noun.job_opening': 'вакансію',
    'activity.noun.allocation': 'алокацію',
    'activity.noun.time_entry': 'запис часу',
    'activity.noun.compensation': 'компенсацію',
    'activity.noun.kb_page': 'сторінку бази знань',
    'activity.noun.kb_space': 'простір бази знань',
    'activity.noun.kb_page_comment': 'коментар до сторінки',
    'activity.noun.cycle': 'цикл',
    'activity.noun.user': 'користувача',
    'activity.noun.custom_field': 'кастомне поле',
    'activity.noun.attachment': 'файл',
  },
});

const ONBOARDING_HINT_KEY = 'ordi:hint:onboarding-checklist';

interface OnboardingItem {
  key: string;
  label: string;
  done: boolean;
  onClick?: () => void;
  hint?: ReactNode;
}

/** Non-interactive Checkbox-style circle: draws a check when done, faint ring otherwise. */
function CheckCircle({ done }: { done: boolean }) {
  return (
    <span
      className={cn(
        'grid h-[18px] w-[18px] shrink-0 place-items-center rounded-full border transition-colors duration-150',
        done ? 'border-success bg-success/15' : 'border-border-strong bg-transparent',
      )}
    >
      <svg width="11" height="11" viewBox="0 0 12 12" fill="none" aria-hidden>
        <path
          d="M2.5 6.5L5 9L9.5 3.5"
          stroke="hsl(var(--success))" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"
          style={{
            strokeDasharray: 12,
            strokeDashoffset: done ? 0 : 12,
            transition: 'stroke-dashoffset var(--duration-medium) var(--ease-smooth-out)',
          }}
        />
      </svg>
    </span>
  );
}

function OnboardingChecklist({ hasTasks }: { hasTasks: boolean }) {
  const t = useT();
  const navigate = useNavigate();
  const canCrm = useCan()('crm.read');
  const [dismissed, setDismissed] = useState(() => {
    try { return localStorage.getItem(ONBOARDING_HINT_KEY) === '1'; } catch { return false; }
  });
  const [leaving, setLeaving] = useState(false);

  const projectsQ = useQuery({
    queryKey: ['onboarding', 'projects'],
    queryFn: () => api.get<{ data: unknown[] }>('/projects').then((r) => r.data),
    enabled: !dismissed,
    staleTime: 60_000,
  });
  const usersQ = useQuery({
    queryKey: ['onboarding', 'users'],
    queryFn: () => api.get<{ data: unknown[] }>('/users/lookup').then((r) => r.data),
    enabled: !dismissed,
    staleTime: 60_000,
  });
  const companiesQ = useQuery({
    queryKey: ['onboarding', 'companies'],
    queryFn: () => api.get<{ data: unknown[] }>('/companies').then((r) => r.data),
    enabled: !dismissed && canCrm,
    staleTime: 60_000,
  });

  const settled = projectsQ.isSuccess && usersQ.isSuccess && (!canCrm || companiesQ.isSuccess);
  if (dismissed || !settled) return null;

  const items: OnboardingItem[] = [
    {
      key: 'project',
      label: t('onboarding.project'),
      done: (projectsQ.data?.length ?? 0) > 0,
      onClick: () => navigate('/projects'),
    },
    {
      key: 'task',
      label: t('onboarding.task'),
      done: hasTasks,
      hint: <span className="flex items-center gap-1 text-xs text-faint">{t('onboarding.taskHint')} <Kbd>C</Kbd></span>,
    },
    {
      key: 'team',
      label: t('onboarding.team'),
      done: (usersQ.data?.length ?? 0) > 1,
      onClick: () => navigate('/settings/users'),
    },
  ];
  if (canCrm) {
    items.push({
      key: 'client',
      label: t('onboarding.client'),
      done: (companiesQ.data?.length ?? 0) > 0,
      onClick: () => navigate('/crm'),
    });
  }

  const total = items.length;
  const doneCount = items.filter((i) => i.done).length;
  if (doneCount >= 4) return null;

  const dismiss = () => {
    try { localStorage.setItem(ONBOARDING_HINT_KEY, '1'); } catch { /* private mode */ }
    setLeaving(true);
    window.setTimeout(() => setDismissed(true), 150);
  };

  return (
    <div
      className={cn(
        'anim-pop-in overflow-hidden rounded-lg border border-primary/15 bg-primary/5',
        'transition-[opacity,transform] duration-[150ms] ease-smooth-out',
        leaving && 'scale-[0.98] opacity-0',
      )}
    >
      <div className="flex items-start justify-between gap-3 px-4 pt-3.5">
        <div className="flex items-start gap-2.5">
          <span className="mt-px shrink-0 text-primary"><Rocket size={16} /></span>
          <div>
            <div className="text-sm font-semibold">{t('onboarding.title')}</div>
            <div className="text-xs text-muted-foreground">{t('onboarding.subtitle')}</div>
          </div>
        </div>
        <button
          aria-label={t('hint.dismiss')}
          onClick={dismiss}
          className="-mr-1 grid h-5 w-5 shrink-0 place-items-center rounded text-faint transition-colors duration-150 hover:bg-primary/10 hover:text-foreground"
        >
          <X size={12} />
        </button>
      </div>

      <div className="mt-3 flex items-center gap-2 px-4">
        <div className="flex-1"><ProgressBar value={(doneCount / total) * 100} color="hsl(var(--success))" /></div>
        <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
          {t('onboarding.progress').replace('{done}', String(doneCount)).replace('{total}', String(total))}
        </span>
      </div>

      <div className="mt-2 pb-2">
        {items.map((item, i) => {
          const clickable = !item.done && !!item.onClick;
          return (
            <button
              key={item.key}
              type="button"
              onClick={clickable ? item.onClick : undefined}
              disabled={!clickable}
              style={{ ['--i' as string]: Math.min(i, 10) }}
              className={cn(
                'row-enter flex w-full items-center gap-2.5 px-4 py-2 text-left text-[13px]',
                clickable ? 'transition-colors duration-150 hover:bg-primary/5' : 'cursor-default',
              )}
            >
              <CheckCircle done={item.done} />
              <span className={cn('flex-1 truncate', item.done && 'text-muted-foreground line-through')}>{item.label}</span>
              {!item.done && item.hint}
              {clickable && <ChevronRight size={14} className="shrink-0 text-faint" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

/* ───────────────────────── Types (snake_case: raw SQL rows) ───────────────────────── */

interface MeTask {
  id: string;
  title: string;
  due_date?: string | null;
  priority?: string;
  number?: number;
  project_id?: string;
  key?: string;
  category?: string;
  status_name?: string;
  ref?: string;
}
interface MeTasksResponse {
  overdue: MeTask[];
  today: MeTask[];
  week: MeTask[];
  later: MeTask[];
}
interface DealStageRow { stage?: string; count?: number; amount?: number | string }
interface ReceivableRow { currency?: string; outstanding?: number | string }
interface ActivityItem {
  id: string;
  entityType?: string;
  entityId?: string;
  actorId?: string | null;
  action?: string;
  createdAt?: string;
}
interface DashboardData {
  receivables?: ReceivableRow[];
  overdue?: { count?: number; amount?: number | string };
  dealsByStage?: DealStageRow[];
  recentActivity?: ActivityItem[];
  projectCount?: number;
}

/* ───────────────────────── Helpers ───────────────────────── */

function taskRef(t: MeTask): string {
  if (t.ref) return t.ref;
  if (t.key && t.number != null) return `${t.key}-${t.number}`;
  return '';
}

const ACTIVITY_ICON: Record<string, ReactNode> = {
  task: <CheckSquare size={13} />,
  project: <FolderKanban size={13} />,
  deal: <Handshake size={13} />,
  invoice: <Receipt size={13} />,
  quote: <Receipt size={13} />,
  recurring_invoice: <Receipt size={13} />,
  expense: <Receipt size={13} />,
  credit_note: <Receipt size={13} />,
  contact: <UserIcon size={13} />,
  company: <Building2 size={13} />,
  note: <MessageSquare size={13} />,
  comment: <MessageSquare size={13} />,
  employee: <Users size={13} />,
  leave_request: <CalendarRange size={13} />,
  applicant: <Users size={13} />,
  job_opening: <Users size={13} />,
  allocation: <Users size={13} />,
  compensation: <Users size={13} />,
  kb_page: <BookText size={13} />,
  kb_space: <BookText size={13} />,
  kb_page_comment: <MessageSquare size={13} />,
  time_entry: <Clock size={13} />,
  cycle: <CalendarRange size={13} />,
  user: <UserIcon size={13} />,
};

function activityIcon(entityType?: string): ReactNode {
  return (entityType && ACTIVITY_ICON[entityType]) || <Activity size={13} />;
}

function humanize(s?: string): string {
  return (s ?? '').replace(/_/g, ' ').trim();
}

function activityText(a: ActivityItem, t: (k: string, fallback?: string) => string, isYou: boolean): string {
  const action = a.action || 'updated';
  const base = t(`activity.verb.${action}`, humanize(action));
  // After a "You/Ви" prefix some locales need a different verb form.
  const verb = isYou ? t(`activity.verb.${action}.you`, base) : base;
  const noun = a.entityType ? t(`activity.noun.${a.entityType}`, humanize(a.entityType)) : '';
  const text = noun ? `${verb} ${noun}` : verb;
  // Standalone sentence starts with a capital; after "You " it stays lowercase.
  return isYou ? text : text.charAt(0).toUpperCase() + text.slice(1);
}

/* ───────────────────────── Page ───────────────────────── */

export function DashboardPage() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  const open = useOpen();
  // Tab/window title should say "Dashboard", not the greeting headline.
  // (Runs after PageHeader's registration, so this one wins.)
  usePageTitle(t('nav.dashboard'));

  const dash = useQuery<DashboardData>({
    queryKey: ['dashboard'],
    queryFn: () => api.get<DashboardData>('/dashboard'),
  });
  const meTasks = useQuery<MeTasksResponse>({
    queryKey: ['me', 'tasks'],
    queryFn: () => api.get<MeTasksResponse>('/me/tasks'),
  });

  const isLoading = dash.isLoading || meTasks.isLoading;
  const firstName = me.user.name.split(' ')[0] ?? me.user.name;

  if (isLoading) {
    return (
      <div>
        <PageHeader title={`${t('dashboard.greeting')}, ${firstName}`} subtitle={t('dashboard.subtitle')} />
        <div className="space-y-4 p-6">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-[72px]" />)}
          </div>
          <div className="grid gap-4 xl:grid-cols-2">
            <Skeleton className="h-64" />
            <Skeleton className="h-40" />
            <Skeleton className="h-56 xl:col-span-2" />
          </div>
        </div>
      </div>
    );
  }

  const buckets: { key: string; tasks: MeTask[]; overdue?: boolean }[] = [
    { key: 'overdue', tasks: meTasks.data?.overdue ?? [], overdue: true },
    { key: 'today', tasks: meTasks.data?.today ?? [] },
    { key: 'week', tasks: meTasks.data?.week ?? [] },
    { key: 'later', tasks: meTasks.data?.later ?? [] },
  ];
  const openTaskRows = buckets.flatMap((b) => b.tasks.map((task) => ({ task, overdue: !!b.overdue })));
  const totalOpen = openTaskRows.length;
  const overdueCount = meTasks.data?.overdue.length ?? 0;

  const receivablesRows = dash.data?.receivables ?? [];
  const outstandingTotal = receivablesRows.reduce((s, r) => s + Number(r.outstanding ?? 0), 0);
  const outstandingCurrency = receivablesRows[0]?.currency ?? 'USD';

  const dealsByStage = dash.data?.dealsByStage ?? [];
  const dealsTotal = dealsByStage.reduce((s, d) => s + Number(d.amount ?? 0), 0);
  const maxDealAmount = Math.max(1, ...dealsByStage.map((d) => Number(d.amount ?? 0)));

  const activity = dash.data?.recentActivity ?? [];

  const stats: { key: string; icon: ReactNode; label: string; value: string; accent?: boolean; onClick: () => void }[] = [
    { key: 'myTasks', icon: <ListTodo size={14} />, label: t('dashboard.myOpenTasks'), value: String(totalOpen), onClick: () => navigate('/my-tasks') },
    { key: 'overdue', icon: <AlertTriangle size={14} className={overdueCount > 0 ? 'text-destructive' : undefined} />, label: t('common.overdue'), value: String(overdueCount), accent: overdueCount > 0, onClick: () => navigate('/my-tasks') },
  ];
  if (receivablesRows.length > 0) {
    stats.push({ key: 'receivables', icon: <Receipt size={14} />, label: t('dashboard.outstanding'), value: fmtMoney(outstandingTotal, outstandingCurrency), onClick: () => navigate('/finance') });
  }
  if (dealsByStage.length > 0) {
    stats.push({ key: 'deals', icon: <Handshake size={14} />, label: t('dashboard.activeDealsValue'), value: fmtMoney(dealsTotal), onClick: () => navigate('/deals') });
  }

  return (
    <div>
      <PageHeader title={`${t('dashboard.greeting')}, ${firstName}`} subtitle={t('dashboard.subtitle')} />

      <div className="space-y-4 p-6">
        <OnboardingChecklist hasTasks={totalOpen > 0} />

        {/* Stat tiles */}
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {stats.map((s, i) => (
            <button
              key={s.key}
              onClick={s.onClick}
              style={{ ['--i' as string]: Math.min(i, 10) }}
              className="row-enter rounded-lg border border-border bg-card p-3 text-left transition-colors duration-150 hover:bg-muted/60"
            >
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">{s.icon} {s.label}</div>
              <div className={cn('mt-1.5 text-2xl font-semibold tabular-nums', s.accent && 'text-destructive')}>{s.value}</div>
            </button>
          ))}
        </div>

        <div className="grid gap-4 xl:grid-cols-2">
          {/* My tasks */}
          <Card className="p-4">
            <div className="mb-3 flex items-center justify-between">
              <h2 className="text-sm font-semibold">{t('nav.myTasks')}</h2>
              <button onClick={() => navigate('/my-tasks')} className="text-xs text-muted-foreground transition-colors hover:text-foreground">{t('common.viewAll')}</button>
            </div>
            {totalOpen === 0 ? (
              <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
                <CheckCircle2 size={16} className="text-primary" /> {t('dashboard.allCaughtUp')}
              </div>
            ) : (
              <div>
                {openTaskRows.slice(0, 8).map(({ task, overdue }, i) => (
                  <button
                    key={task.id}
                    onClick={(e) => task.project_id && open(`/projects/${task.project_id}/tasks/${task.id}`, e)}
                    onAuxClick={(e) => task.project_id && open(`/projects/${task.project_id}/tasks/${task.id}`, e)}
                    style={{ ['--i' as string]: Math.min(i, 10) }}
                    className="row-enter flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] transition-colors duration-150 hover:bg-muted"
                  >
                    <PriorityIcon priority={task.priority} size={14} />
                    {taskRef(task) && <span className="shrink-0 font-mono text-[11px] text-muted-foreground">{taskRef(task)}</span>}
                    <span className="flex-1 truncate">{task.title}</span>
                    {task.due_date && (
                      <span className={cn('shrink-0 text-xs tabular-nums', overdue ? 'text-destructive' : 'text-muted-foreground')}>
                        {fmtDate(task.due_date)}
                      </span>
                    )}
                  </button>
                ))}
              </div>
            )}
          </Card>

          {/* Deals by stage */}
          <Card className="p-4">
            <h2 className="mb-3 text-sm font-semibold">{t('dashboard.dealsByStage')}</h2>
            {dealsByStage.length === 0 ? (
              <EmptyState title={t('dashboard.noDeals')} hint={t('dashboard.noDealsHint')} />
            ) : (
              <div className="space-y-3">
                {dealsByStage.map((d, i) => {
                  const amt = Number(d.amount ?? 0);
                  return (
                    <div key={d.stage ?? i} className="row-enter" style={{ ['--i' as string]: Math.min(i, 10) }}>
                      <div className="mb-1 flex items-center justify-between text-xs">
                        <span className="text-muted-foreground">{d.stage ?? t('deals.stage')}</span>
                        <span className="tabular-nums">{d.count ?? 0} · {fmtMoney(amt)}</span>
                      </div>
                      <ProgressBar value={(amt / maxDealAmount) * 100} />
                    </div>
                  );
                })}
              </div>
            )}
          </Card>

          {/* Recent activity */}
          <Card className="p-4 xl:col-span-2">
            <h2 className="mb-3 flex items-center gap-1.5 text-sm font-semibold"><Activity size={14} /> {t('dashboard.recentActivity')}</h2>
            {activity.length === 0 ? (
              <EmptyState title={t('dashboard.noActivity')} hint={t('dashboard.noActivityHint')} />
            ) : (
              <ul className="space-y-1">
                {activity.slice(0, 12).map((a, i) => (
                  <li
                    key={a.id}
                    className="row-enter flex items-center gap-2.5 rounded-md px-1.5 py-1.5 text-[13px]"
                    style={{ ['--i' as string]: Math.min(i, 10) }}
                  >
                    <span className="grid h-6 w-6 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                      {activityIcon(a.entityType)}
                    </span>
                    <span className="flex-1 truncate">
                      {a.actorId === me.user.id && <span className="font-medium">{t('dashboard.you')} </span>}
                      <span className="text-muted-foreground">{activityText(a, t, a.actorId === me.user.id)}</span>
                    </span>
                    <span className="shrink-0 text-xs text-faint">{fmtRelative(a.createdAt)}</span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
