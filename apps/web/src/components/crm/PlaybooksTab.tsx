import { useEffect, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { FileText, Pencil, Plus, Workflow, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { extendDict, useT } from '../../lib/i18n';
import { useCan } from '../../lib/auth';
import { Badge, Button, Card, EmptySection, Input, Spinner, Textarea } from '../ui';
import { Dialog, toast } from '../overlays';
import { SearchSelect } from '../SearchSelect';
import {
  SALES_ACTIVITY_TYPES,
  salesActivityTypeLabel,
  useSalesMessageTemplates,
  useSalesSequences,
  type SalesMessageTemplate,
  type SalesSequence,
} from './shared';

extendDict({
  en: {
    'crm.tabPlaybooks': 'Playbooks',
    'crm.playbooksHint': 'Reusable copy and manual sales sequences.',
    'crm.messageTemplates': 'Message templates',
    'crm.sequences': 'Sequences',
    'crm.newTemplate': 'New template',
    'crm.editTemplate': 'Edit template',
    'crm.newSequence': 'New sequence',
    'crm.editSequence': 'Edit sequence',
    'crm.noTemplates': 'No message templates yet.',
    'crm.noSequences': 'No sales sequences yet.',
    'crm.templateName': 'Template name',
    'crm.messageTemplate': 'Message template',
    'crm.noTemplate': 'No template',
    'crm.subject': 'Subject',
    'crm.messageBody': 'Message body',
    'crm.templateVariables': 'Variables: {{companyName}}, {{contactFirstName}}, {{contactName}}, {{ownerName}}, {{leadTitle}}',
    'crm.sequenceName': 'Sequence name',
    'crm.sequenceDescription': 'Description',
    'crm.sequenceSteps': 'Steps',
    'crm.addStep': 'Add step',
    'crm.removeStep': 'Remove step',
    'crm.delayDays': 'Delay, days',
    'crm.active': 'Active',
    'crm.inactive': 'Paused',
    'crm.enrolledCount': '{count} active',
    'crm.usedSequenceLocked': 'Steps are locked after the sequence is used.',
    'crm.playbookSaved': 'Playbook saved',
    'crm.savePlaybookFailed': 'Could not save the playbook.',
  },
  uk: {
    'crm.tabPlaybooks': 'Сценарії',
    'crm.playbooksHint': 'Шаблони текстів і послідовності ручних дій.',
    'crm.messageTemplates': 'Шаблони повідомлень',
    'crm.sequences': 'Послідовності',
    'crm.newTemplate': 'Новий шаблон',
    'crm.editTemplate': 'Редагувати шаблон',
    'crm.newSequence': 'Нова послідовність',
    'crm.editSequence': 'Редагувати послідовність',
    'crm.noTemplates': 'Шаблонів повідомлень ще немає.',
    'crm.noSequences': 'Послідовностей продажів ще немає.',
    'crm.templateName': 'Назва шаблону',
    'crm.messageTemplate': 'Шаблон повідомлення',
    'crm.noTemplate': 'Без шаблону',
    'crm.subject': 'Тема',
    'crm.messageBody': 'Текст повідомлення',
    'crm.templateVariables': 'Змінні: {{companyName}}, {{contactFirstName}}, {{contactName}}, {{ownerName}}, {{leadTitle}}',
    'crm.sequenceName': 'Назва послідовності',
    'crm.sequenceDescription': 'Опис',
    'crm.sequenceSteps': 'Кроки',
    'crm.addStep': 'Додати крок',
    'crm.removeStep': 'Прибрати крок',
    'crm.delayDays': 'Затримка, днів',
    'crm.active': 'Активний',
    'crm.inactive': 'Призупинено',
    'crm.enrolledCount': 'Активних: {count}',
    'crm.usedSequenceLocked': 'Після першого використання кроки не змінюються.',
    'crm.playbookSaved': 'Сценарій збережено',
    'crm.savePlaybookFailed': 'Не вдалося зберегти сценарій.',
  },
});

function errorMessage(error: unknown, fallback: string) {
  return error instanceof ApiError ? error.message : fallback;
}

export function PlaybooksTab() {
  const t = useT();
  const canWrite = useCan()('crm.write');
  const templatesQ = useSalesMessageTemplates();
  const sequencesQ = useSalesSequences();
  const [template, setTemplate] = useState<SalesMessageTemplate | 'new' | null>(null);
  const [sequence, setSequence] = useState<SalesSequence | 'new' | null>(null);

  return (
    <div className="min-h-0 flex-1 overflow-auto p-4">
      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <FileText size={15} className="text-muted-foreground" />
            <h2 className="flex-1 text-sm font-semibold">{t('crm.messageTemplates')}</h2>
            {canWrite && (
              <Button size="xs" onClick={() => setTemplate('new')}>
                <Plus size={12} /> {t('crm.newTemplate')}
              </Button>
            )}
          </div>
          {!templatesQ.data?.length ? (
            <EmptySection icon={<FileText size={16} />} title={t('crm.noTemplates')} />
          ) : (
            <div className="divide-y divide-border">
              {templatesQ.data.map((row) => (
                <button
                  key={row.id}
                  type="button"
                  disabled={!canWrite}
                  onClick={() => setTemplate(row)}
                  className="flex w-full items-start gap-3 px-4 py-3 text-left transition-colors hover:bg-muted/40 disabled:cursor-default"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-[13px] font-medium">{row.name}</span>
                      <Badge color={row.active ? 'green' : 'gray'}>
                        {row.active ? t('crm.active') : t('crm.inactive')}
                      </Badge>
                    </div>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {salesActivityTypeLabel(t, row.activityType)}
                      {row.channel ? ` · ${row.channel}` : ''}
                    </p>
                    <p className="mt-1 line-clamp-2 text-xs text-faint">{row.body}</p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <Card className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Workflow size={15} className="text-muted-foreground" />
            <h2 className="flex-1 text-sm font-semibold">{t('crm.sequences')}</h2>
            {canWrite && (
              <Button size="xs" onClick={() => setSequence('new')}>
                <Plus size={12} /> {t('crm.newSequence')}
              </Button>
            )}
          </div>
          {!sequencesQ.data?.length ? (
            <EmptySection icon={<Workflow size={16} />} title={t('crm.noSequences')} />
          ) : (
            <div className="divide-y divide-border">
              {sequencesQ.data.map((sequence) => (
                <SequenceRow
                  key={sequence.id}
                  sequence={sequence}
                  canWrite={canWrite}
                  onEdit={() => setSequence(sequence)}
                />
              ))}
            </div>
          )}
        </Card>
      </div>

      <TemplateDialog value={template} onClose={() => setTemplate(null)} />
      <SequenceDialog value={sequence} onClose={() => setSequence(null)} />
    </div>
  );
}

function SequenceRow({ sequence, canWrite, onEdit }: {
  sequence: SalesSequence;
  canWrite: boolean;
  onEdit: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: () => api.patch(`/sales-sequences/${sequence.id}`, {
      active: !sequence.active,
      version: sequence.version,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-sequences'] });
      toast(t('crm.playbookSaved'));
    },
    onError: (error) => toast.error(errorMessage(error, t('crm.savePlaybookFailed'))),
  });
  return (
    <div className="px-4 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-[13px] font-medium">{sequence.name}</span>
            <Badge color={sequence.active ? 'green' : 'gray'}>
              {sequence.active ? t('crm.active') : t('crm.inactive')}
            </Badge>
            {!!sequence.activeEnrollments && (
              <span className="text-[11px] text-muted-foreground">
                {t('crm.enrolledCount').replace('{count}', String(sequence.activeEnrollments))}
              </span>
            )}
          </div>
          {sequence.description && <p className="mt-0.5 text-xs text-muted-foreground">{sequence.description}</p>}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {sequence.steps.map((step) => (
              <span key={step.id} className="rounded-md bg-muted px-2 py-1 text-[11px] text-muted-foreground">
                {step.position}. {salesActivityTypeLabel(t, step.activityType)}
                {step.delayDays ? ` +${step.delayDays}d` : ''}
              </span>
            ))}
          </div>
        </div>
        {canWrite && (
          <div className="flex items-center gap-1">
            <Button size="xs" variant="ghost" onClick={onEdit}>
              <Pencil size={12} /> {t('common.edit')}
            </Button>
            <Button size="xs" variant="ghost" onClick={() => toggle.mutate()} disabled={toggle.isPending}>
              {sequence.active ? t('crm.inactive') : t('crm.active')}
            </Button>
          </div>
        )}
      </div>
    </div>
  );
}

function TemplateDialog({ value, onClose }: {
  value: SalesMessageTemplate | 'new' | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const editing = value && value !== 'new' ? value : null;
  const [name, setName] = useState('');
  const [activityType, setActivityType] = useState('outreach');
  const [channel, setChannel] = useState('');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [active, setActive] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setName(editing?.name ?? '');
    setActivityType(editing?.activityType ?? 'outreach');
    setChannel(editing?.channel ?? '');
    setSubject(editing?.subject ?? '');
    setBody(editing?.body ?? '');
    setActive(editing?.active ?? true);
    setError(null);
  }, [editing, value]);

  const save = useMutation({
    mutationFn: () => {
      const payload = {
        name: name.trim(),
        activityType,
        channel: channel.trim() || null,
        subject: subject.trim() || null,
        body: body.trim(),
        active,
        ...(editing ? { version: editing.version } : {}),
      };
      return editing
        ? api.patch(`/sales-message-templates/${editing.id}`, payload)
        : api.post('/sales-message-templates', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-message-templates'] });
      toast(t('crm.playbookSaved'));
      onClose();
    },
    onError: (cause) => setError(errorMessage(cause, t('crm.savePlaybookFailed'))),
  });

  return (
    <Dialog
      open={!!value}
      onClose={onClose}
      title={editing ? t('crm.editTemplate') : t('crm.newTemplate')}
      width={520}
    >
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event) => { event.preventDefault(); save.mutate(); }}
      >
        <Field label={t('crm.templateName')}>
          <Input required value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('crm.activityType')}>
            <SearchSelect
              className="w-full"
              value={activityType}
              onChange={setActivityType}
              options={SALES_ACTIVITY_TYPES.map((type) => ({ value: type, label: salesActivityTypeLabel(t, type) }))}
            />
          </Field>
          <Field label={t('crm.channel')}>
            <Input value={channel} onChange={(event) => setChannel(event.target.value)} placeholder="LinkedIn" />
          </Field>
        </div>
        <Field label={t('crm.subject')}>
          <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
        </Field>
        <Field label={t('crm.messageBody')}>
          <Textarea required rows={7} value={body} onChange={(event) => setBody(event.target.value)} />
        </Field>
        <p className="text-[11px] text-faint">{t('crm.templateVariables')}</p>
        <label className="flex items-center gap-2 text-[13px]">
          <input type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} />
          {t('crm.active')}
        </label>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={save.isPending || !name.trim() || !body.trim()}>
            {save.isPending ? <Spinner /> : t('common.save')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

interface StepForm {
  delayDays: string;
  templateId: string;
  activityType: string;
  channel: string;
  subject: string;
  context: string;
}

function emptyStep(): StepForm {
  return {
    delayDays: '0',
    templateId: '',
    activityType: 'follow_up',
    channel: '',
    subject: '',
    context: '',
  };
}

function SequenceDialog({ value, onClose }: {
  value: SalesSequence | 'new' | null;
  onClose: () => void;
}) {
  const t = useT();
  const qc = useQueryClient();
  const templatesQ = useSalesMessageTemplates();
  const editing = value && value !== 'new' ? value : null;
  const stepsLocked = !!editing?.enrollmentCount;
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [steps, setSteps] = useState<StepForm[]>([emptyStep()]);
  const [error, setError] = useState<string | null>(null);

  const reset = () => {
    setName('');
    setDescription('');
    setSteps([emptyStep()]);
    setError(null);
  };
  useEffect(() => {
    if (!editing) {
      reset();
      return;
    }
    setName(editing.name);
    setDescription(editing.description);
    setSteps(editing.steps.map((step) => ({
      delayDays: String(step.delayDays),
      templateId: step.templateId ?? '',
      activityType: step.activityType,
      channel: step.channel ?? '',
      subject: step.subject ?? '',
      context: step.context ?? '',
    })));
    setError(null);
  }, [editing, value]);
  const patchStep = (index: number, patch: Partial<StepForm>) => {
    setSteps((current) => current.map((step, position) => position === index ? { ...step, ...patch } : step));
  };
  const save = useMutation({
    mutationFn: () => {
      const stepPayload = steps.map((step) => ({
        delayDays: Number(step.delayDays || 0),
        ...(step.templateId
          ? { templateId: step.templateId }
          : {
            activityType: step.activityType,
            channel: step.channel.trim() || null,
            subject: step.subject.trim() || null,
            context: step.context.trim() || null,
          }),
      }));
      const payload = {
        name: name.trim(),
        description: description.trim(),
        ...(editing ? { version: editing.version } : {}),
        ...(!stepsLocked ? { steps: stepPayload } : {}),
      };
      return editing
        ? api.patch(`/sales-sequences/${editing.id}`, payload)
        : api.post('/sales-sequences', payload);
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['sales-sequences'] });
      toast(t('crm.playbookSaved'));
      reset();
      onClose();
    },
    onError: (cause) => setError(errorMessage(cause, t('crm.savePlaybookFailed'))),
  });

  return (
    <Dialog
      open={!!value}
      onClose={() => { reset(); onClose(); }}
      title={editing ? t('crm.editSequence') : t('crm.newSequence')}
      width={640}
    >
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event: FormEvent) => { event.preventDefault(); save.mutate(); }}
      >
        <Field label={t('crm.sequenceName')}>
          <Input required value={name} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label={t('crm.sequenceDescription')}>
          <Textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">{t('crm.sequenceSteps')}</span>
            {!stepsLocked && (
              <Button type="button" size="xs" variant="ghost" onClick={() => setSteps((current) => [...current, emptyStep()])}>
                <Plus size={12} /> {t('crm.addStep')}
              </Button>
            )}
          </div>
          {steps.map((step, index) => (
            <div key={index} className="space-y-2 rounded-lg border border-border p-3">
              <div className="flex items-center gap-2">
                <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-muted text-[11px] font-medium">
                  {index + 1}
                </span>
                <SearchSelect
                  className="min-w-0 flex-1"
                  value={step.templateId}
                  disabled={stepsLocked}
                  onChange={(templateId) => patchStep(index, { templateId })}
                  options={[
                    { value: '', label: t('crm.noTemplate') },
                    ...(step.templateId && !templatesQ.data?.some((template) => template.id === step.templateId)
                      ? [{ value: step.templateId, label: t('crm.inactive') }]
                      : []),
                    ...(templatesQ.data ?? []).map((template) => ({
                      value: template.id,
                      label: template.name,
                      hint: template.active ? undefined : t('crm.inactive'),
                      disabled: !template.active,
                    })),
                  ]}
                />
                <Input
                  className="w-28"
                  min={0}
                  max={3650}
                  type="number"
                  value={step.delayDays}
                  disabled={stepsLocked}
                  aria-label={t('crm.delayDays')}
                  onChange={(event) => patchStep(index, { delayDays: event.target.value })}
                />
                {!stepsLocked && steps.length > 1 && (
                  <Button
                    type="button"
                    size="xs"
                    variant="ghost"
                    aria-label={t('crm.removeStep')}
                    onClick={() => setSteps((current) => current.filter((_, position) => position !== index))}
                  >
                    <X size={13} />
                  </Button>
                )}
              </div>
              {!step.templateId && (
                <>
                  <div className="grid grid-cols-2 gap-2">
                    <SearchSelect
                      className="w-full"
                      value={step.activityType}
                      disabled={stepsLocked}
                      onChange={(activityType) => patchStep(index, { activityType })}
                      options={SALES_ACTIVITY_TYPES.map((type) => ({ value: type, label: salesActivityTypeLabel(t, type) }))}
                    />
                    <Input
                      value={step.channel}
                      disabled={stepsLocked}
                      placeholder={t('crm.channel')}
                      onChange={(event) => patchStep(index, { channel: event.target.value })}
                    />
                  </div>
                  <Input
                    value={step.subject}
                    disabled={stepsLocked}
                    placeholder={t('crm.subject')}
                    onChange={(event) => patchStep(index, { subject: event.target.value })}
                  />
                  <Textarea
                    rows={2}
                    value={step.context}
                    disabled={stepsLocked}
                    placeholder={t('crm.context')}
                    onChange={(event) => patchStep(index, { context: event.target.value })}
                  />
                </>
              )}
            </div>
          ))}
        </div>
        {(stepsLocked || !editing) && (
          <p className="text-[11px] text-faint">{t('crm.usedSequenceLocked')}</p>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={() => { reset(); onClose(); }}>
            {t('common.cancel')}
          </Button>
          <Button type="submit" size="sm" disabled={save.isPending || !name.trim() || !steps.length}>
            {save.isPending ? <Spinner /> : t(editing ? 'common.save' : 'common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}
