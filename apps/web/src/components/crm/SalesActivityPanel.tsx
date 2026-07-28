import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, Plus } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Button, EmptySection, Input, Select, Spinner, Textarea, fmtDate, fmtRelative } from '../ui';
import { Dialog, toast } from '../overlays';
import {
  LEAD_ACTIVITY_OUTCOME_STATUSES,
  SALES_ACTIVITY_TYPES,
  salesActivityStatusLabel,
  salesActivityTypeLabel,
  useSalesActivities,
  type SalesActivity,
} from './shared';
import { SectionHeader } from './detail';

function toLocalInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function toDateInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof ApiError ? error.message : fallback;
}

export function SalesActivityPanel({ leadId, dealId, canWrite }: {
  leadId?: string;
  dealId?: string;
  canWrite: boolean;
}) {
  const t = useT();
  const activitiesQ = useSalesActivities({ leadId, dealId });
  const [schedule, setSchedule] = useState(false);
  const [complete, setComplete] = useState<SalesActivity | null>(null);
  const activities = activitiesQ.data ?? [];

  return (
    <section>
      <SectionHeader
        icon={<CalendarClock size={15} />}
        title={t('crm.salesHistory')}
        count={activities.length}
        action={canWrite ? (
          <Button size="xs" variant="ghost" onClick={() => setSchedule(true)}>
            <Plus size={13} /> {t('crm.scheduleAction')}
          </Button>
        ) : undefined}
      />
      {activities.length === 0 ? (
        <EmptySection
          icon={<CalendarClock size={14} />}
          title={t('crm.noSalesActivity')}
          action={canWrite ? <Button size="xs" variant="ghost" onClick={() => setSchedule(true)}>{t('common.add')}</Button> : undefined}
        />
      ) : (
        <div className="divide-y divide-border rounded-lg border border-border">
          {activities.map((activity) => (
            <div key={activity.id} className="flex items-start gap-3 px-3 py-2.5">
              <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${
                activity.status === 'completed' ? 'bg-success' : activity.status === 'cancelled' ? 'bg-faint' : 'bg-primary'
              }`} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[13px]">
                  <span className="font-medium">{activity.subject || salesActivityTypeLabel(t, activity.type)}</span>
                  {activity.channel && <span className="text-muted-foreground">{activity.channel}</span>}
                </div>
                {(activity.outcome || activity.context) && (
                  <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{activity.outcome || activity.context}</p>
                )}
                <p className="mt-1 text-[11px] text-faint">
                  {activity.completedAt
                    ? `${fmtDate(activity.completedAt)} · ${salesActivityStatusLabel(t, activity.status)}`
                    : activity.dueAt
                      ? `${fmtDate(activity.dueAt)} · ${fmtRelative(activity.dueAt)}`
                      : t('crm.noNextAction')}
                </p>
              </div>
              {canWrite && activity.status === 'planned' && (
                <Button size="xs" variant="ghost" onClick={() => setComplete(activity)}>
                  <Check size={13} /> {t('crm.completeAction')}
                </Button>
              )}
            </div>
          ))}
        </div>
      )}
      <ScheduleActivityDialog open={schedule} onClose={() => setSchedule(false)} leadId={leadId} dealId={dealId} />
      <CompleteActivityDialog activity={complete} onClose={() => setComplete(null)} />
    </section>
  );
}

export function ScheduleActivityDialog({ open, onClose, leadId, dealId }: {
  open: boolean;
  onClose: () => void;
  leadId?: string;
  dealId?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [type, setType] = useState('follow_up');
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 86_400_000)));
  const [channel, setChannel] = useState('');
  const [subject, setSubject] = useState('');
  const [context, setContext] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setType('follow_up');
    setDueAt(toLocalInput(new Date(Date.now() + 86_400_000)));
    setChannel('');
    setSubject('');
    setContext('');
    setError(null);
  };
  const mutation = useMutation({
    mutationFn: () => api.post('/sales-activities', {
      leadId,
      dealId,
      type,
      dueAt: new Date(dueAt).toISOString(),
      channel: channel.trim() || undefined,
      subject: subject.trim() || undefined,
      context: context.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      reset();
      onClose();
    },
    onError: (error) => setError(errorText(error, t('common.error'))),
  });
  const submit = (event: FormEvent) => {
    event.preventDefault();
    mutation.mutate();
  };

  return (
    <Dialog open={open} onClose={() => { reset(); onClose(); }} title={t('crm.scheduleAction')} width={440}>
      <form onSubmit={submit} className="space-y-3 px-4 pb-4 pt-1">
        <Field label={t('crm.activityType')}>
          <Select className="w-full" value={type} onChange={(event) => setType(event.target.value)}>
            {SALES_ACTIVITY_TYPES.map((value) => <option key={value} value={value}>{salesActivityTypeLabel(t, value)}</option>)}
          </Select>
        </Field>
        <Field label={t('crm.dueAt')}>
          <Input required type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('crm.channel')}>
            <Input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="LinkedIn" />
          </Field>
          <Field label={t('common.title')}>
            <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
          </Field>
        </div>
        <Field label={t('crm.context')}>
          <Textarea rows={3} value={context} onChange={(event) => setContext(event.target.value)} />
        </Field>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mutation.isPending}>{mutation.isPending ? <Spinner /> : t('common.save')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CompleteActivityDialog({ activity, onClose }: {
  activity: SalesActivity | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [outcome, setOutcome] = useState('');
  const [leadStatus, setLeadStatus] = useState('waiting_reply');
  const [followUp, setFollowUp] = useState(true);
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 5 * 86_400_000)));
  const [nurtureUntil, setNurtureUntil] = useState(() => toDateInput(new Date(Date.now() + 30 * 86_400_000)));
  const [error, setError] = useState<string | null>(null);
  const isLead = !!activity?.leadId;
  const followUpDisabled = isLead && (
    leadStatus === 'nurture' || leadStatus === 'disqualified' || leadStatus === 'no_response'
  );
  const close = () => {
    setOutcome('');
    setLeadStatus('waiting_reply');
    setFollowUp(true);
    setNurtureUntil(toDateInput(new Date(Date.now() + 30 * 86_400_000)));
    setError(null);
    onClose();
  };

  const body = useMemo(() => ({
    outcome: outcome.trim() || undefined,
    version: activity?.version,
    leadStatus: isLead ? leadStatus : undefined,
    nurtureUntil: isLead && leadStatus === 'nurture' ? nurtureUntil : undefined,
    nextActivity: followUp && dueAt ? {
      type: leadStatus === 'nurture' ? 'nurture' : 'follow_up',
      channel: activity?.channel ?? undefined,
      dueAt: new Date(dueAt).toISOString(),
    } : undefined,
  }), [activity, dueAt, followUp, isLead, leadStatus, nurtureUntil, outcome]);

  const mutation = useMutation({
    mutationFn: () => api.post(`/sales-activities/${activity!.id}/complete`, body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      qc.invalidateQueries({ queryKey: ['leads'] });
      if (activity?.leadId) qc.invalidateQueries({ queryKey: ['lead', activity.leadId] });
      close();
    },
    onError: (error) => setError(errorText(error, t('common.error'))),
  });

  return (
    <Dialog open={!!activity} onClose={close} title={t('crm.completeAction')} width={440}>
      <form onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }} className="space-y-3 px-4 pb-4 pt-1">
        <Field label={t('crm.outcome')}>
          <Textarea autoFocus rows={3} value={outcome} onChange={(event) => setOutcome(event.target.value)} />
        </Field>
        {isLead && (
          <Field label={t('common.status')}>
            <Select
              className="w-full"
              value={leadStatus}
              onChange={(event) => {
                const value = event.target.value;
                setLeadStatus(value);
                if (value === 'disqualified' || value === 'no_response') setFollowUp(false);
                if (value === 'nurture') setFollowUp(false);
              }}
            >
              {LEAD_ACTIVITY_OUTCOME_STATUSES.map((value) => (
                <option key={value} value={value}>{t(`crm.status.${value}`)}</option>
              ))}
            </Select>
          </Field>
        )}
        {isLead && leadStatus === 'nurture' && (
          <Field label={t('crm.nurtureUntil')}>
            <Input required type="date" value={nurtureUntil} onChange={(event) => setNurtureUntil(event.target.value)} />
          </Field>
        )}
        <label className="flex items-center gap-2 text-[13px]">
          <input
            type="checkbox"
            checked={followUp}
            disabled={followUpDisabled}
            onChange={(event) => setFollowUp(event.target.checked)}
          />
          {t('crm.followUp')}
        </label>
        {followUp && <Input required type="datetime-local" value={dueAt} onChange={(event) => setDueAt(event.target.value)} />}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mutation.isPending}>{mutation.isPending ? <Spinner /> : t('crm.completeAction')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium text-muted-foreground">{label}</label>
      {children}
    </div>
  );
}
