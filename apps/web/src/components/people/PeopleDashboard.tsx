/**
 * HR → Dashboard: what needs attention, as people rather than counts. Leave
 * waiting for a decision (decided right here), who is away this week, dates
 * coming up, who is joining or leaving, and hiring. Empty sections stay out of
 * the way; when nothing needs attention the page says so.
 */
import type { ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Award, Briefcase, Cake, CalendarClock, Check, ChevronRight, Inbox, LogIn, LogOut, ShieldCheck, Users, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useNavigate, useOpen } from '../../lib/router';
import { useT, extendDict } from '../../lib/i18n';
import { Avatar, Badge, EmptyState, IconButton, Skeleton, Tooltip, appLocale, cn } from '../ui';
import { toast } from '../overlays';

extendDict({
  en: {
    'hrdash.people': 'Team: {n}',
    'hrdash.awayCount': 'Away this week: {n}',
    'hrdash.pendingCount': 'Waiting for a decision: {n}',
    'hrdash.rolesCount': 'Open roles: {n}',
    'hrdash.pending': 'Waiting for a decision',
    'hrdash.away': 'Away this week',
    'hrdash.dates': 'Coming up in 30 days',
    'hrdash.moves': 'Joining and leaving',
    'hrdash.hiring': 'Hiring',
    'hrdash.allLeave': 'All leave',
    'hrdash.calendar': 'Calendar',
    'hrdash.recruiting': 'Recruiting',
    'hrdash.birthday': 'Birthday',
    'hrdash.anniversary': '{n} years at the company',
    'hrdash.anniversaryOne': '1 year at the company',
    'hrdash.probation': 'Probation ends',
    'hrdash.firstDay': 'First day',
    'hrdash.lastDay': 'Last day',
    'hrdash.halfDay': 'half day',
    'hrdash.candidates': 'In play: {n}',
    'hrdash.noCandidates': 'No candidates yet',
    'hrdash.allClear': 'Nothing needs your attention',
    'hrdash.allClearHint': 'No leave to decide, nobody away this week, no dates, moves or open roles in the next 30 days.',
    'hrdash.decideFailed': 'Could not save the decision',
    'hrdash.awayNow': 'away now',
  },
  uk: {
    'hrdash.people': 'У команді: {n}',
    'hrdash.awayCount': 'Відсутні цього тижня: {n}',
    'hrdash.pendingCount': 'Чекають рішення: {n}',
    'hrdash.rolesCount': 'Відкриті вакансії: {n}',
    'hrdash.pending': 'Чекають рішення',
    'hrdash.away': 'Відсутні цього тижня',
    'hrdash.dates': 'Найближчі 30 днів',
    'hrdash.moves': 'Приходять і йдуть',
    'hrdash.hiring': 'Найм',
    'hrdash.allLeave': 'Усі відпустки',
    'hrdash.calendar': 'Календар',
    'hrdash.recruiting': 'Рекрутинг',
    'hrdash.birthday': 'День народження',
    'hrdash.anniversary': 'Років у компанії: {n}',
    'hrdash.anniversaryOne': 'Рік у компанії',
    'hrdash.probation': 'Кінець випробувального',
    'hrdash.firstDay': 'Перший день',
    'hrdash.lastDay': 'Останній день',
    'hrdash.halfDay': 'пів дня',
    'hrdash.candidates': 'У процесі: {n}',
    'hrdash.noCandidates': 'Кандидатів ще немає',
    'hrdash.allClear': 'Нічого не потребує уваги',
    'hrdash.allClearHint': 'Немає заявок на розгляд, ніхто не відсутній цього тижня, у найближчі 30 днів немає дат, переходів чи відкритих вакансій.',
    'hrdash.decideFailed': 'Не вдалося зберегти рішення',
    'hrdash.awayNow': 'зараз відсутні',
  },
});

interface Leave { id: string; employeeId: string; name: string; avatar: string | null; leaveType: string | null; fromDate: string; toDate: string; halfDay: boolean }
interface DateEvent { kind: 'birthday' | 'anniversary' | 'probation'; employeeId: string; name: string; avatar: string | null; date: string; years?: number }
interface Move { employeeId: string; name: string; avatar: string | null; date: string; position: string | null }
interface Dashboard {
  today: string;
  headcount: { active: number; onLeave: number };
  pendingLeave: Leave[];
  awayThisWeek: Leave[];
  dates: DateEvent[];
  joiners: Move[];
  leavers: Move[];
  recruiting: { openRoles: { id: string; title: string; positionsCount: number; activeCandidates: number }[]; stages: { stageId: string; name: string; count: number }[] };
  canRecruit: boolean;
  canApproveLeave: boolean;
}

const n = (s: string, v: number) => s.replace('{n}', String(v));

function day(iso: string): Date {
  return new Date(iso.slice(0, 10) + 'T00:00:00');
}
function fmtDay(iso: string): string {
  return day(iso).toLocaleDateString(appLocale(), { day: 'numeric', month: 'short' });
}
function fmtRange(from: string, to: string): string {
  return from === to ? fmtDay(from) : `${fmtDay(from)} – ${fmtDay(to)}`;
}
function daysBetween(from: string, to: string): number {
  return Math.round((day(to).getTime() - day(from).getTime()) / 86_400_000);
}
/** "today", "tomorrow", "in 3 days", "5 days ago", in the user's language. */
function relDay(iso: string, today: string): string {
  return new Intl.RelativeTimeFormat(appLocale(), { numeric: 'auto' }).format(daysBetween(today, iso), 'day');
}

function Section({ icon, title, count, action, children }: {
  icon: ReactNode; title: string; count?: number; action?: { label: string; onClick: () => void }; children: ReactNode;
}) {
  return (
    <section className="overflow-hidden rounded-xl border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border bg-muted/40 px-4 py-2">
        <span className="text-muted-foreground [&>svg]:block">{icon}</span>
        <h2 className="text-[13px] font-medium">{title}</h2>
        {count != null && <span className="rounded-full bg-muted px-1.5 text-[11px] tabular-nums text-muted-foreground">{count}</span>}
        {action && (
          <button type="button" onClick={action.onClick} className="ml-auto inline-flex items-center gap-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground">
            {action.label} <ChevronRight size={12} />
          </button>
        )}
      </header>
      <div className="divide-y divide-border">{children}</div>
    </section>
  );
}

/** A person line: avatar and name open their card; the rest describes why they are here. */
function PersonRow({ employeeId, name, avatar, detail, side, trailing }: {
  employeeId: string; name: string; avatar: string | null; detail?: ReactNode; side?: ReactNode; trailing?: ReactNode;
}) {
  const open = useOpen();
  return (
    <div className="flex items-center gap-3 px-4 py-2.5">
      <button
        type="button"
        onClick={(e) => open(`/people/${employeeId}`, e)}
        onAuxClick={(e) => open(`/people/${employeeId}`, e)}
        className="group flex min-w-0 flex-1 items-center gap-3 text-left"
      >
        <Avatar name={name} src={avatar} size={26} />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium group-hover:underline group-hover:underline-offset-2">{name}</span>
          {detail && <span className="block truncate text-xs text-muted-foreground">{detail}</span>}
        </span>
      </button>
      {side && <span className="shrink-0 text-right text-xs tabular-nums text-muted-foreground">{side}</span>}
      {trailing}
    </div>
  );
}

export function PeopleDashboard() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const q = useQuery({ queryKey: ['peopleDashboard'], queryFn: () => api.get<Dashboard>('/people/dashboard') });

  const decide = useMutation({
    mutationFn: ({ id, action }: { id: string; action: 'approve' | 'reject' }) => api.post(`/leave-requests/${id}/${action}`),
    onSuccess: (_r, vars) => {
      toast(vars.action === 'approve' ? t('people.leaveApprovedToast') : t('people.leaveRejectedToast'));
      for (const key of ['peopleDashboard', 'leaveRequests']) void qc.invalidateQueries({ queryKey: [key] });
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('hrdash.decideFailed')),
  });

  if (q.isLoading || !q.data) {
    return (
      <div className="mx-auto grid max-w-6xl gap-4 p-6 lg:grid-cols-2">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-40 w-full rounded-xl" />)}
      </div>
    );
  }

  const d = q.data;
  const goTab = (tab: string) => navigate(`/people?tab=${tab}`);
  const awayNow = d.awayThisWeek.filter((l) => l.fromDate <= d.today && l.toDate >= d.today).length;
  const roles = d.recruiting.openRoles;
  const moves = [
    ...d.joiners.map((m) => ({ ...m, kind: 'join' as const })),
    ...d.leavers.map((m) => ({ ...m, kind: 'leave' as const })),
  ].sort((a, b) => b.date.localeCompare(a.date));
  const nothing = d.pendingLeave.length + d.awayThisWeek.length + d.dates.length + moves.length + roles.length === 0;

  const summary: { label: string; onClick?: () => void; accent?: boolean }[] = [
    { label: n(t('hrdash.people'), d.headcount.active + d.headcount.onLeave), onClick: () => goTab('employees') },
    ...(d.pendingLeave.length ? [{ label: n(t('hrdash.pendingCount'), d.pendingLeave.length), onClick: () => goTab('leave'), accent: true }] : []),
    ...(d.awayThisWeek.length ? [{ label: n(t('hrdash.awayCount'), d.awayThisWeek.length), onClick: () => goTab('calendar') }] : []),
    ...(roles.length ? [{ label: n(t('hrdash.rolesCount'), roles.length), onClick: d.canRecruit ? () => goTab('recruiting') : undefined }] : []),
  ];

  const dateMeta = (e: DateEvent): { icon: ReactNode; label: string } => {
    if (e.kind === 'birthday') return { icon: <Cake size={13} />, label: t('hrdash.birthday') };
    if (e.kind === 'anniversary') return { icon: <Award size={13} />, label: e.years === 1 ? t('hrdash.anniversaryOne') : n(t('hrdash.anniversary'), e.years ?? 0) };
    return { icon: <ShieldCheck size={13} />, label: t('hrdash.probation') };
  };

  return (
    <div className="mx-auto max-w-6xl space-y-4 p-6">
      <div className="flex flex-wrap items-center gap-2">
        {summary.map((s) => (
          <button
            key={s.label}
            type="button"
            disabled={!s.onClick}
            onClick={s.onClick}
            className={cn(
              'rounded-full border px-3 py-1 text-xs transition-colors duration-150',
              s.accent ? 'border-warning/40 bg-warning/10 text-warning' : 'border-border text-muted-foreground',
              s.onClick && 'hover:bg-muted hover:text-foreground',
            )}
          >
            {s.label}
          </button>
        ))}
      </div>

      {nothing ? (
        <EmptyState icon={<Inbox size={20} />} title={t('hrdash.allClear')} hint={t('hrdash.allClearHint')} />
      ) : (
        <div className="gap-4 lg:columns-2 [&>section]:mb-4 [&>section]:break-inside-avoid">
          {d.pendingLeave.length > 0 && (
            <Section icon={<CalendarClock size={14} />} title={t('hrdash.pending')} count={d.pendingLeave.length} action={{ label: t('hrdash.allLeave'), onClick: () => goTab('leave') }}>
              {d.pendingLeave.map((l) => (
                <PersonRow
                  key={l.id}
                  employeeId={l.employeeId}
                  name={l.name}
                  avatar={l.avatar}
                  detail={[l.leaveType, l.halfDay ? t('hrdash.halfDay') : null].filter(Boolean).join(' · ')}
                  side={<>{fmtRange(l.fromDate, l.toDate)}<span className="block text-faint">{relDay(l.fromDate, d.today)}</span></>}
                  trailing={d.canApproveLeave && (
                    <span className="flex shrink-0 gap-1">
                      <Tooltip label={t('people.approve')}>
                        <IconButton size="sm" aria-label={t('people.approve')} disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, action: 'approve' })} className="text-success hover:bg-success/10">
                          <Check size={14} />
                        </IconButton>
                      </Tooltip>
                      <Tooltip label={t('people.reject')}>
                        <IconButton size="sm" aria-label={t('people.reject')} disabled={decide.isPending} onClick={() => decide.mutate({ id: l.id, action: 'reject' })} className="text-destructive hover:bg-destructive/10">
                          <X size={14} />
                        </IconButton>
                      </Tooltip>
                    </span>
                  )}
                />
              ))}
            </Section>
          )}

          {d.awayThisWeek.length > 0 && (
            <Section icon={<Users size={14} />} title={t('hrdash.away')} count={d.awayThisWeek.length} action={{ label: t('hrdash.calendar'), onClick: () => goTab('calendar') }}>
              {d.awayThisWeek.map((l) => {
                const now = l.fromDate <= d.today && l.toDate >= d.today;
                return (
                  <PersonRow
                    key={l.id}
                    employeeId={l.employeeId}
                    name={l.name}
                    avatar={l.avatar}
                    detail={[l.leaveType, l.halfDay ? t('hrdash.halfDay') : null].filter(Boolean).join(' · ')}
                    side={<>
                      {fmtRange(l.fromDate, l.toDate)}
                      {now ? <span className="block text-warning">{t('hrdash.awayNow')}</span> : <span className="block text-faint">{relDay(l.fromDate, d.today)}</span>}
                    </>}
                  />
                );
              })}
            </Section>
          )}

          {d.dates.length > 0 && (
            <Section icon={<Cake size={14} />} title={t('hrdash.dates')} count={d.dates.length}>
              {d.dates.map((e) => {
                const meta = dateMeta(e);
                return (
                  <PersonRow
                    key={`${e.kind}-${e.employeeId}`}
                    employeeId={e.employeeId}
                    name={e.name}
                    avatar={e.avatar}
                    detail={<span className="inline-flex items-center gap-1">{meta.icon}{meta.label}</span>}
                    side={<>{fmtDay(e.date)}<span className="block text-faint">{relDay(e.date, d.today)}</span></>}
                  />
                );
              })}
            </Section>
          )}

          {moves.length > 0 && (
            <Section icon={<LogIn size={14} />} title={t('hrdash.moves')} count={moves.length}>
              {moves.map((m) => {
                const label = t(m.kind === 'join' ? 'hrdash.firstDay' : 'hrdash.lastDay');
                return (
                  <PersonRow
                    key={`${m.kind}-${m.employeeId}`}
                    employeeId={m.employeeId}
                    name={m.name}
                    avatar={m.avatar}
                    detail={m.position}
                    side={<>
                      <span className={cn('inline-flex items-center gap-1', m.kind === 'join' ? 'text-success' : 'text-muted-foreground')}>
                        {m.kind === 'join' ? <LogIn size={12} /> : <LogOut size={12} />}{label} {fmtDay(m.date)}
                      </span>
                      <span className="block text-faint">{relDay(m.date, d.today)}</span>
                    </>}
                  />
                );
              })}
            </Section>
          )}

          {roles.length > 0 && (
            <Section
              icon={<Briefcase size={14} />}
              title={t('hrdash.hiring')}
              count={roles.length}
              action={d.canRecruit ? { label: t('hrdash.recruiting'), onClick: () => goTab('recruiting') } : undefined}
            >
              {roles.map((r) => (
                <button
                  key={r.id}
                  type="button"
                  disabled={!d.canRecruit}
                  onClick={() => goTab('recruiting')}
                  className={cn('flex w-full items-center gap-3 px-4 py-2.5 text-left', d.canRecruit && 'transition-colors duration-150 hover:bg-muted/40')}
                >
                  <span className="min-w-0 flex-1 truncate text-[13px] font-medium">{r.title}</span>
                  {r.positionsCount > 1 && <Badge>×{r.positionsCount}</Badge>}
                  <span className={cn('shrink-0 text-xs', r.activeCandidates ? 'text-muted-foreground' : 'text-faint')}>
                    {r.activeCandidates ? n(t('hrdash.candidates'), r.activeCandidates) : t('hrdash.noCandidates')}
                  </span>
                </button>
              ))}
              {d.recruiting.stages.length > 0 && (
                <div className="flex flex-wrap gap-1.5 px-4 py-2.5">
                  {d.recruiting.stages.map((s) => (
                    <span key={s.stageId} className="rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                      {s.name} <span className="tabular-nums text-foreground">{s.count}</span>
                    </span>
                  ))}
                </div>
              )}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}
