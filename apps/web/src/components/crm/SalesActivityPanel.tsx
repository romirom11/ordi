import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, Check, MoreHorizontal, Pencil, Play, Plus, Workflow, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Avatar, Button, EmptySection, Input, Spinner, Textarea, Tooltip, fmtDate, fmtRelative } from '../ui';
import { DateField, DateTimeField } from '../DatePicker';
import { ConfirmDialog, Dialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { SearchSelect } from '../SearchSelect';
import {
  LEAD_ACTIVITY_OUTCOME_STATUSES,
  StatusPill,
  SALES_ACTIVITY_TYPES,
  salesActivityStatusLabel,
  salesActivityTypeLabel,
  useContacts,
  useSalesMessageTemplates,
  useUsersLookup,
  useSalesSequenceEnrollments,
  useSalesSequences,
  useSalesActivities,
  type SalesActivity,
  type SalesSequenceEnrollment,
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

export function SalesActivityPanel({ leadId, dealId, companyId, contactId, canWrite, canSchedule = canWrite }: {
  leadId?: string;
  dealId?: string;
  companyId?: string | null;
  contactId?: string | null;
  canWrite: boolean;
  canSchedule?: boolean;
}) {
  const t = useT();
  const activitiesQ = useSalesActivities({ leadId, dealId });
  const [schedule, setSchedule] = useState(false);
  const [complete, setComplete] = useState<SalesActivity | null>(null);
  const [edit, setEdit] = useState<SalesActivity | null>(null);
  const [cancel, setCancel] = useState<SalesActivity | null>(null);
  const activities = activitiesQ.data ?? [];
  const qc = useQueryClient();
  const cancelMutation = useMutation({
    mutationFn: (activity: SalesActivity) => api.post(`/sales-activities/${activity.id}/cancel`, {
      version: activity.version,
    }),
    onSuccess: (_, activity) => {
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      if (activity.leadId) {
        qc.invalidateQueries({ queryKey: ['leads'] });
        qc.invalidateQueries({ queryKey: ['lead', activity.leadId] });
      }
      setCancel(null);
      toast(t('crm.activityCancelled'));
    },
    onError: (error) => toast.error(errorText(error, t('common.error'))),
  });

  return (
    <section>
      <SectionHeader
        icon={<CalendarClock size={15} />}
        title={t('crm.salesHistory')}
        count={activities.length}
        action={canSchedule ? (
          <Button size="xs" variant="ghost" onClick={() => setSchedule(true)}>
            <Plus size={13} /> {t('crm.scheduleAction')}
          </Button>
        ) : undefined}
      />
      {canSchedule && (
        <SequenceControls
          leadId={leadId}
          dealId={dealId}
          companyId={companyId}
          contactId={contactId}
          hasPlanned={activities.some((activity) => activity.status === 'planned')}
        />
      )}
      {activities.length === 0 ? (
        <EmptySection
          icon={<CalendarClock size={14} />}
          title={t('crm.noSalesActivity')}
          action={canSchedule ? <Button size="xs" variant="ghost" onClick={() => setSchedule(true)}>{t('common.add')}</Button> : undefined}
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
                <div className="flex shrink-0 items-center gap-1">
                  <Button size="xs" variant="ghost" onClick={() => setComplete(activity)}>
                    <Check size={13} /> {t('crm.completeAction')}
                  </Button>
                  <DropdownMenu
                    align="end"
                    trigger={(
                      <Button size="xs" variant="ghost" aria-label={t('common.actions')}>
                        <MoreHorizontal size={14} />
                      </Button>
                    )}
                  >
                    <MenuItem icon={<Pencil size={13} />} onSelect={() => setEdit(activity)}>
                      {t('common.edit')}
                    </MenuItem>
                    <MenuItem icon={<X size={13} />} danger onSelect={() => setCancel(activity)}>
                      {t('crm.cancelAction')}
                    </MenuItem>
                  </DropdownMenu>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
      {/* Mounted on open: its template and user lookups fire on mount, and the
        * default activity type is read once, so a fresh mount is the sync. */}
      {schedule && (
        <ScheduleActivityDialog
          open
          onClose={() => setSchedule(false)}
          leadId={leadId}
          dealId={dealId}
          defaultType={activities.some((activity) => activity.status === 'completed') ? 'follow_up' : 'outreach'}
        />
      )}
      {edit && <EditActivityDialog activity={edit} onClose={() => setEdit(null)} />}
      {complete && <CompleteActivityDialog activity={complete} onClose={() => setComplete(null)} />}
      <ConfirmDialog
        open={!!cancel}
        onClose={() => setCancel(null)}
        onConfirm={() => { if (cancel) cancelMutation.mutate(cancel); }}
        title={t('crm.cancelAction')}
        body={t('crm.cancelActionBody')}
        confirmLabel={t('crm.cancelAction')}
        cancelLabel={t('common.cancel')}
        pending={cancelMutation.isPending}
      />
    </section>
  );
}

function SequenceControls({ leadId, dealId, companyId, contactId, hasPlanned }: {
  leadId?: string;
  dealId?: string;
  companyId?: string | null;
  contactId?: string | null;
  /** A sequence owns the next step, so the API refuses to start one over a
   * planned action. Say so on the button rather than in an error afterwards. */
  hasPlanned: boolean;
}) {
  const t = useT();
  const qc = useQueryClient();
  const sequencesQ = useSalesSequences(true);
  const enrollmentsQ = useSalesSequenceEnrollments({ leadId, dealId });
  const contactsQ = useContacts(companyId);
  const active = enrollmentsQ.data?.find((row) => row.status === 'active');
  const [open, setOpen] = useState(false);
  const [stop, setStop] = useState<SalesSequenceEnrollment | null>(null);
  const [sequenceId, setSequenceId] = useState('');
  const [selectedContactId, setSelectedContactId] = useState(contactId ?? '');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setSelectedContactId(contactId ?? '');
  }, [contactId]);
  useEffect(() => {
    if (!sequenceId && sequencesQ.data?.[0]) setSequenceId(sequencesQ.data[0].id);
  }, [sequenceId, sequencesQ.data]);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['sales-sequence-enrollments'] });
    qc.invalidateQueries({ queryKey: ['sales-sequences'] });
    qc.invalidateQueries({ queryKey: ['sales-activities'] });
    qc.invalidateQueries({ queryKey: ['sales-work'] });
    qc.invalidateQueries({ queryKey: ['leads'] });
  };
  const start = useMutation({
    mutationFn: () => api.post(`/sales-sequences/${sequenceId}/enroll`, {
      leadId,
      dealId,
      contactId: selectedContactId || undefined,
    }),
    onSuccess: () => {
      refresh();
      setOpen(false);
      setError(null);
      toast(t('crm.sequenceStarted'));
    },
    onError: (cause) => setError(errorText(cause, t('common.error'))),
  });
  const stopMutation = useMutation({
    mutationFn: (enrollment: SalesSequenceEnrollment) =>
      api.post(`/sales-sequence-enrollments/${enrollment.id}/stop`, {
        version: enrollment.version,
      }),
    onSuccess: () => {
      refresh();
      setStop(null);
      toast(t('crm.sequenceStopped'));
    },
    onError: (cause) => toast.error(errorText(cause, t('common.error'))),
  });

  return (
    <>
      {active ? (
        <div className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.04] px-3 py-2">
          <Workflow size={14} className="shrink-0 text-primary" />
          <div className="min-w-0 flex-1">
            <p className="truncate text-[13px] font-medium">{active.sequenceName}</p>
            <p className="text-[11px] text-muted-foreground">
              {t('crm.sequenceStep').replace('{current}', String(active.currentStepPosition))}
            </p>
          </div>
          <Button size="xs" variant="ghost" onClick={() => setStop(active)}>
            <X size={12} /> {t('crm.stopSequence')}
          </Button>
        </div>
      ) : (
        <div className="mb-3">
          <Tooltip label={hasPlanned ? t('crm.sequenceNeedsClearNext') : undefined}>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setOpen(true)}
              disabled={hasPlanned || !sequencesQ.data?.length}
            >
              <Play size={12} /> {t('crm.startSequence')}
            </Button>
          </Tooltip>
        </div>
      )}

      <Dialog
        open={open}
        onClose={() => { setOpen(false); setError(null); }}
        title={t('crm.startSequence')}
        width={420}
      >
        <form
          className="space-y-3 px-4 pb-4 pt-1"
          onSubmit={(event) => { event.preventDefault(); start.mutate(); }}
        >
          <Field label={t('crm.sequence')}>
            <SearchSelect
              className="w-full"
              value={sequenceId}
              onChange={setSequenceId}
              options={(sequencesQ.data ?? []).map((sequence) => ({
                value: sequence.id,
                label: sequence.name,
                hint: t('crm.stepsCount').replace('{count}', String(sequence.steps.length)),
              }))}
            />
          </Field>
          {!!contactsQ.data?.length && (
            <Field label={t('crm.contact')}>
              <SearchSelect
                className="w-full"
                value={selectedContactId}
                onChange={setSelectedContactId}
                options={[
                  { value: '', label: t('crm.noContact') },
                  ...contactsQ.data.map((contact) => ({
                    value: contact.id,
                    label: [contact.firstName, contact.lastName].filter(Boolean).join(' '),
                    hint: contact.position ?? undefined,
                  })),
                ]}
              />
            </Field>
          )}
          {error && <p className="text-[13px] text-destructive">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button type="button" size="sm" variant="ghost" onClick={() => setOpen(false)}>
              {t('common.cancel')}
            </Button>
            <Button type="submit" size="sm" disabled={start.isPending || !sequenceId}>
              {start.isPending ? <Spinner /> : t('crm.startSequence')}
            </Button>
          </div>
        </form>
      </Dialog>
      <ConfirmDialog
        open={!!stop}
        onClose={() => setStop(null)}
        onConfirm={() => { if (stop) stopMutation.mutate(stop); }}
        title={t('crm.stopSequence')}
        body={t('crm.stopSequenceBody')}
        confirmLabel={t('crm.stopSequence')}
        cancelLabel={t('common.cancel')}
        pending={stopMutation.isPending}
      />
    </>
  );
}

export function ScheduleActivityDialog({ open, onClose, leadId, dealId, defaultType = 'follow_up' }: {
  open: boolean;
  onClose: () => void;
  leadId?: string;
  dealId?: string;
  /** `outreach` on a record with no history – nothing has happened to follow up on. */
  defaultType?: string;
}) {
  const t = useT();
  const qc = useQueryClient();
  const templatesQ = useSalesMessageTemplates(true);
  const usersQ = useUsersLookup();
  const [templateId, setTemplateId] = useState('');
  const [type, setType] = useState(defaultType);
  const [ownerId, setOwnerId] = useState('');
  const [dueAt, setDueAt] = useState(() => toLocalInput(new Date(Date.now() + 86_400_000)));
  const [channel, setChannel] = useState('');
  const [subject, setSubject] = useState('');
  const [context, setContext] = useState('');
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setTemplateId('');
    setType(defaultType);
    setOwnerId('');
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
      templateId: templateId || undefined,
      ownerId: ownerId || undefined,
      dueAt: new Date(dueAt).toISOString(),
      channel: channel.trim() || undefined,
      subject: subject.trim() || undefined,
      context: context.trim() || undefined,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      if (leadId) {
        qc.invalidateQueries({ queryKey: ['leads'] });
        qc.invalidateQueries({ queryKey: ['lead', leadId] });
      }
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
        {!!templatesQ.data?.length && (
          <Field label={t('crm.messageTemplate')}>
            <SearchSelect
              className="w-full"
              value={templateId}
              onChange={(id) => {
                setTemplateId(id);
                const template = templatesQ.data?.find((row) => row.id === id);
                if (!template) return;
                setType(template.activityType);
                setChannel(template.channel ?? '');
                setSubject(template.subject ?? '');
                setContext(template.body);
              }}
              options={[
                { value: '', label: t('crm.noTemplate') },
                ...templatesQ.data.map((template) => ({ value: template.id, label: template.name })),
              ]}
            />
          </Field>
        )}
        <Field label={t('crm.activityType')}>
          <SearchSelect
            className="w-full"
            value={type}
            onChange={setType}
            options={SALES_ACTIVITY_TYPES.map((value) => ({ value, label: salesActivityTypeLabel(t, value) }))}
          />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('crm.dueAt')}>
            <DateTimeField value={dueAt} onChange={setDueAt} />
          </Field>
          <Field label={t('crm.owner')}>
            <SearchSelect
              className="w-full"
              value={ownerId}
              onChange={setOwnerId}
              options={[
                { value: '', label: t('crm.ownerDefault') },
                ...(usersQ.data ?? []).map((user) => ({
                  value: user.id, label: user.name, icon: <Avatar name={user.name} src={user.avatar} size={16} />,
                })),
              ]}
            />
          </Field>
        </div>
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
          <Button type="submit" size="sm" disabled={mutation.isPending || !dueAt}>{mutation.isPending ? <Spinner /> : t('common.save')}</Button>
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
  const inSequence = !!activity?.sequenceEnrollmentId;
  const isReviewReady = isLead && activity?.type === 'review' && leadStatus === 'ready';
  const followUpDisabled = isLead && (
    leadStatus === 'nurture' || leadStatus === 'disqualified' || leadStatus === 'no_response'
  );

  useEffect(() => {
    if (!activity) return;
    const review = !!activity.leadId && activity.type === 'review';
    setOutcome('');
    setLeadStatus(review ? 'ready' : 'waiting_reply');
    setFollowUp(true);
    setDueAt(toLocalInput(new Date(Date.now() + (review ? 1 : 5) * 86_400_000)));
    setNurtureUntil(toDateInput(new Date(Date.now() + 30 * 86_400_000)));
    setError(null);
  }, [activity?.id, activity?.leadId, activity?.type]);

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
    nextActivity: !inSequence && followUp && dueAt ? {
      type: leadStatus === 'nurture' ? 'nurture' : isReviewReady ? 'outreach' : 'follow_up',
      channel: activity?.channel ?? undefined,
      dueAt: new Date(dueAt).toISOString(),
    } : undefined,
  }), [activity, dueAt, followUp, inSequence, isLead, isReviewReady, leadStatus, nurtureUntil, outcome]);

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
            <SearchSelect
              className="w-full"
              value={leadStatus}
              onChange={(value) => {
                setLeadStatus(value);
                if (value === 'disqualified' || value === 'no_response') setFollowUp(false);
                if (value === 'nurture') setFollowUp(false);
              }}
              options={LEAD_ACTIVITY_OUTCOME_STATUSES.map((value) => ({
                value, label: t(`crm.status.${value}`), render: <StatusPill status={value} />,
              }))}
            />
          </Field>
        )}
        {isLead && leadStatus === 'nurture' && (
          <Field label={t('crm.nurtureUntil')}>
            <DateField value={nurtureUntil} onChange={(value) => setNurtureUntil(value ?? nurtureUntil)} clearable={false} />
          </Field>
        )}
        {inSequence ? (
          <p className="rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-[13px] text-muted-foreground">
            {t('crm.sequencePlansNext')}
          </p>
        ) : (
          <>
            <label className="flex items-center gap-2 text-[13px]">
              <input
                type="checkbox"
                checked={followUp}
                disabled={followUpDisabled}
                onChange={(event) => setFollowUp(event.target.checked)}
              />
              {isReviewReady ? t('crm.planOutreach') : t('crm.followUp')}
            </label>
            {followUp && (
              <Field label={t('crm.dueAt')}>
                <DateTimeField value={dueAt} onChange={setDueAt} />
              </Field>
            )}
          </>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={close}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={mutation.isPending || (followUp && !dueAt)}>{mutation.isPending ? <Spinner /> : t('crm.completeAction')}</Button>
        </div>
      </form>
    </Dialog>
  );
}

function EditActivityDialog({ activity, onClose }: {
  activity: SalesActivity | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const [type, setType] = useState('follow_up');
  const [dueAt, setDueAt] = useState('');
  const [channel, setChannel] = useState('');
  const [subject, setSubject] = useState('');
  const [context, setContext] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!activity) return;
    setType(activity.type);
    setDueAt(activity.dueAt ? toLocalInput(new Date(activity.dueAt)) : '');
    setChannel(activity.channel ?? '');
    setSubject(activity.subject ?? '');
    setContext(activity.context ?? '');
    setError(null);
  }, [activity]);

  const mutation = useMutation({
    mutationFn: () => api.patch(`/sales-activities/${activity!.id}`, {
      type,
      dueAt: new Date(dueAt).toISOString(),
      channel: channel.trim() || null,
      subject: subject.trim() || null,
      context: context.trim() || null,
      version: activity?.version,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-activities'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      if (activity?.leadId) {
        qc.invalidateQueries({ queryKey: ['leads'] });
        qc.invalidateQueries({ queryKey: ['lead', activity.leadId] });
      }
      toast(t('crm.activityUpdated'));
      onClose();
    },
    onError: (error) => setError(errorText(error, t('common.error'))),
  });

  return (
    <Dialog open={!!activity} onClose={onClose} title={t('crm.editAction')} width={440}>
      <form
        onSubmit={(event) => { event.preventDefault(); mutation.mutate(); }}
        className="space-y-3 px-4 pb-4 pt-1"
      >
        <Field label={t('crm.activityType')}>
          <SearchSelect
            className="w-full"
            value={type}
            onChange={setType}
            options={SALES_ACTIVITY_TYPES.map((value) => ({ value, label: salesActivityTypeLabel(t, value) }))}
          />
        </Field>
        <Field label={t('crm.dueAt')}>
          <DateTimeField value={dueAt} onChange={setDueAt} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('crm.channel')}>
            <Input value={channel} onChange={(event) => setChannel(event.target.value)} />
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
          <Button type="submit" size="sm" disabled={mutation.isPending || !dueAt}>
            {mutation.isPending ? <Spinner /> : t('common.save')}
          </Button>
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
