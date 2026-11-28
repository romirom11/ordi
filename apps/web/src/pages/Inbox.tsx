/**
 * Inbox ("Вхідні"): everything waiting on me, in one place – questions put to
 * me on tasks, agent runs that stopped on my work, my mentions and the leave
 * requests waiting on my decision. Each row links to the thing itself; the
 * work is done there, not here. The data and the links live in lib/inbox.ts.
 */
import type { ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { AtSign, Bot, CalendarCheck, Inbox, MessageCircleQuestion } from 'lucide-react';
import { api } from '../lib/api';
import { Link } from '../lib/router';
import { useT, extendDict } from '../lib/i18n';
import { EmptySection, EmptyState, PageHeader, Skeleton, cn, fmtDate, fmtRelative } from '../components/ui';
import {
  approvalLink, mentionLink, taskLink, useInbox,
  type InboxApproval, type InboxMention, type InboxQuestion, type InboxStoppedRun,
} from '../lib/inbox';

extendDict({
  en: {
    'inbox.subtitle': 'What is waiting on you',
    'inbox.waitingOnYou': 'Waiting on you',
    'inbox.agentStopped': 'Agent stopped',
    'inbox.mentions': 'Mentions',
    'inbox.approvals': 'Approvals',
    'inbox.emptyWaiting': 'Nobody is waiting on an answer from you.',
    'inbox.emptyStopped': 'No agent has stopped on your work.',
    'inbox.emptyMentions': 'No mentions in the last 30 days.',
    'inbox.emptyApprovals': 'Nothing waits on your approval.',
    'inbox.allClear': 'All clear',
    'inbox.allClearHint': 'Questions put to you, stopped agent runs, mentions and approvals will show up here.',
    'inbox.loadFailed': 'Could not load the Inbox',
    'inbox.asks': '{name} asks',
    'inbox.failed': 'Failed',
    'inbox.waitingQuota': 'Waiting for quota',
    'inbox.retryAt': 'retries {when}',
    'inbox.mentionedBy': '{name} mentioned you',
    'inbox.leave': 'Leave',
    'inbox.halfDay': 'half day',
  },
  uk: {
    'inbox.subtitle': 'Що чекає на вас',
    'inbox.waitingOnYou': 'Чекає на вас',
    'inbox.agentStopped': 'Агент зупинився',
    'inbox.mentions': 'Згадки',
    'inbox.approvals': 'Погодження',
    'inbox.emptyWaiting': 'Ніхто не чекає на вашу відповідь.',
    'inbox.emptyStopped': 'Жоден агент не зупинився на вашій роботі.',
    'inbox.emptyMentions': 'Згадок за останні 30 днів немає.',
    'inbox.emptyApprovals': 'Нічого не чекає на ваше погодження.',
    'inbox.allClear': 'Усе розібрано',
    'inbox.allClearHint': 'Тут з’являться питання до вас, зупинені запуски агентів, згадки та погодження.',
    'inbox.loadFailed': 'Не вдалося завантажити Вхідні',
    'inbox.asks': '{name} питає',
    'inbox.failed': 'Помилка',
    'inbox.waitingQuota': 'Чекає на квоту',
    'inbox.retryAt': 'повтор {when}',
    'inbox.mentionedBy': '{name} згадує вас',
    'inbox.leave': 'Відпустка',
    'inbox.halfDay': 'пів дня',
  },
});

const fill = (s: string, vars: Record<string, string>) => s.replace(/\{(\w+)\}/g, (_m, k: string) => vars[k] ?? '');

function Section({ icon, title, count, empty, children }: {
  icon: ReactNode; title: string; count: number; empty: string; children: ReactNode;
}) {
  return (
    <section className="px-6 pt-5">
      <header className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
        {icon}
        <h2>{title}</h2>
        <span className="font-normal tabular-nums text-faint">{count}</span>
      </header>
      {count === 0 ? <EmptySection title={empty} /> : <ul className="divide-y divide-border rounded-lg border border-border bg-card">{children}</ul>}
    </section>
  );
}

function Row({ to, onOpen, unread, children }: { to: string; onOpen?: () => void; unread?: boolean; children: ReactNode }) {
  return (
    <li>
      <Link
        to={to}
        onClick={onOpen}
        className={cn('flex min-w-0 items-start gap-3 px-3 py-2.5 text-[13px] transition-colors duration-150 hover:bg-muted/60', unread && 'bg-primary/5')}
      >
        {children}
      </Link>
    </li>
  );
}

const Ref = ({ value }: { value: string | null }) => (value ? <span className="shrink-0 font-mono text-[11px] text-faint">{value}</span> : null);

function QuestionRow({ q }: { q: InboxQuestion }) {
  const t = useT();
  return (
    <Row to={taskLink(q.task)}>
      <MessageCircleQuestion size={15} className="mt-0.5 shrink-0 text-warning" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Ref value={q.task.ref} />
          <span className="truncate font-medium">{q.task.title}</span>
        </div>
        <p className="mt-0.5 line-clamp-2 whitespace-pre-wrap text-muted-foreground">{q.question}</p>
      </div>
      <span className="shrink-0 text-xs text-faint">{fill(t('inbox.asks'), { name: q.askedBy.name })} · {fmtRelative(q.askedAt)}</span>
    </Row>
  );
}

function StoppedRow({ r }: { r: InboxStoppedRun }) {
  const t = useT();
  const failed = r.status === 'failed';
  return (
    <Row to={taskLink(r.task)}>
      <Bot size={15} className={cn('mt-0.5 shrink-0', failed ? 'text-destructive' : 'text-warning')} aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Ref value={r.task.ref} />
          <span className="truncate font-medium">{r.task.title}</span>
        </div>
        <p className="mt-0.5 truncate text-muted-foreground">
          <span className={failed ? 'text-destructive' : 'text-warning'}>{failed ? t('inbox.failed') : t('inbox.waitingQuota')}</span>
          {' · '}{r.agent.name}
          {!failed && r.retryAt && <> · {fill(t('inbox.retryAt'), { when: fmtRelative(r.retryAt) })}</>}
          {failed && r.error && <> · {r.error}</>}
        </p>
      </div>
      <span className="shrink-0 text-xs text-faint">{fmtRelative(r.at)}</span>
    </Row>
  );
}

function MentionRow({ m }: { m: InboxMention }) {
  const t = useT();
  const qc = useQueryClient();
  const open = () => {
    if (m.readAt) return;
    void api.post(`/notifications/${m.id}/read`).then(() => {
      qc.invalidateQueries({ queryKey: ['notifications'] });
      qc.invalidateQueries({ queryKey: ['inbox'] });
    }).catch(() => {});
  };
  return (
    <Row to={mentionLink(m)} onOpen={open} unread={!m.readAt}>
      <AtSign size={15} className="mt-0.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-2">
          <Ref value={m.ref} />
          <span className="truncate font-medium">{m.title ?? ''}</span>
        </div>
        {m.actorName && <p className="mt-0.5 truncate text-muted-foreground">{fill(t('inbox.mentionedBy'), { name: m.actorName })}</p>}
      </div>
      <span className="shrink-0 text-xs text-faint">{fmtRelative(m.at)}</span>
    </Row>
  );
}

function ApprovalRow({ a, to }: { a: InboxApproval; to: string }) {
  const t = useT();
  return (
    <Row to={to}>
      <CalendarCheck size={15} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden />
      <div className="min-w-0 flex-1">
        <span className="truncate font-medium">{a.employeeName}</span>
        <p className="mt-0.5 truncate text-muted-foreground">
          {a.leaveTypeName ?? t('inbox.leave')} · {fmtDate(a.fromDate)}{a.toDate !== a.fromDate && <> – {fmtDate(a.toDate)}</>}
          {a.halfDay && <> · {t('inbox.halfDay')}</>}
        </p>
      </div>
      <span className="shrink-0 text-xs text-faint">{fmtRelative(a.at)}</span>
    </Row>
  );
}

export function InboxPage() {
  const t = useT();
  const q = useInbox();
  const d = q.data;
  const total = d ? d.waitingOnYou.length + d.agentStopped.length + d.mentions.length + d.approvals.length : 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <PageHeader title={t('nav.inbox')} subtitle={t('inbox.subtitle')} />
      {q.isLoading ? (
        <div className="space-y-3 px-6 pt-5">
          {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      ) : q.isError || !d ? (
        <EmptyState icon={<Inbox size={20} />} title={t('inbox.loadFailed')} />
      ) : total === 0 ? (
        <EmptyState icon={<Inbox size={20} />} title={t('inbox.allClear')} hint={t('inbox.allClearHint')} />
      ) : (
        <div className="pb-10">
          <Section icon={<MessageCircleQuestion size={13} />} title={t('inbox.waitingOnYou')} count={Math.max(d.totals?.waitingOnYou ?? 0, d.waitingOnYou.length)} empty={t('inbox.emptyWaiting')}>
            {d.waitingOnYou.map((x) => <QuestionRow key={x.id} q={x} />)}
          </Section>
          <Section icon={<CalendarCheck size={13} />} title={t('inbox.approvals')} count={d.approvals.length} empty={t('inbox.emptyApprovals')}>
            {d.approvals.map((x) => <ApprovalRow key={x.id} a={x} to={approvalLink(d.approverEmployeeId)} />)}
          </Section>
          <Section icon={<Bot size={13} />} title={t('inbox.agentStopped')} count={d.agentStopped.length} empty={t('inbox.emptyStopped')}>
            {d.agentStopped.map((x) => <StoppedRow key={x.id} r={x} />)}
          </Section>
          <Section icon={<AtSign size={13} />} title={t('inbox.mentions')} count={d.mentions.length} empty={t('inbox.emptyMentions')}>
            {d.mentions.map((x) => <MentionRow key={x.id} m={x} />)}
          </Section>
        </div>
      )}
    </div>
  );
}
