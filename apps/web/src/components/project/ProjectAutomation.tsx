/**
 * Project automation settings: task templates and the recurring rules that
 * instantiate them on a schedule. The worker that creates the tasks has been
 * running all along – these sections are the first way to feed it from the UI.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Repeat, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { Button, Input, PriorityIcon, Select, Skeleton, Spinner, Switch, fmtDate } from '../ui';
import { ConfirmDialog, Dialog, toast } from '../overlays';
import { PRIORITIES, PRIORITY_LABEL_KEY } from './taskViewPrefs';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'automation.templates': 'Task templates',
    'automation.templatesHint': 'Reusable task blueprints – the source for recurring tasks.',
    'automation.newTemplate': 'New template',
    'automation.templateName': 'Template name',
    'automation.templateTitle': 'Task title',
    'automation.templateTitleHint': 'What the created task will be called. Defaults to the template name.',
    'automation.priority': 'Priority',
    'automation.workspaceTag': 'Workspace',
    'automation.noTemplates': 'No templates yet.',
    'automation.deleteTemplateTitle': 'Delete template',
    'automation.deleteTemplateBody': 'Delete “{name}”? Recurring rules using it will stop creating tasks.',
    'automation.recurring': 'Recurring tasks',
    'automation.recurringHint': 'Create a task from a template on a schedule – weekly reports, monthly reviews.',
    'automation.newRecurring': 'New recurring task',
    'automation.template': 'Template',
    'automation.frequency': 'Frequency',
    'automation.freq.daily': 'Daily',
    'automation.freq.weekly': 'Weekly',
    'automation.freq.monthly': 'Monthly',
    'automation.freq.custom': 'Custom',
    'automation.nextRun': 'Next run',
    'automation.noRecurring': 'No recurring tasks yet.',
    'automation.needTemplate': 'Create a task template first – a recurring rule instantiates one.',
    'automation.deleteRecurringTitle': 'Delete recurring task',
    'automation.deleteRecurringBody': 'Delete this rule? Already-created tasks stay.',
    'automation.created': 'Created',
    'automation.deleted': 'Deleted',
  },
  uk: {
    'automation.templates': 'Шаблони задач',
    'automation.templatesHint': 'Багаторазові заготовки задач – джерело для повторюваних задач.',
    'automation.newTemplate': 'Новий шаблон',
    'automation.templateName': 'Назва шаблону',
    'automation.templateTitle': 'Назва задачі',
    'automation.templateTitleHint': 'Як називатиметься створена задача. Типово – назва шаблону.',
    'automation.priority': 'Пріоритет',
    'automation.workspaceTag': 'Простір',
    'automation.noTemplates': 'Шаблонів поки немає.',
    'automation.deleteTemplateTitle': 'Видалити шаблон',
    'automation.deleteTemplateBody': 'Видалити «{name}»? Повторювані правила з ним перестануть створювати задачі.',
    'automation.recurring': 'Повторювані задачі',
    'automation.recurringHint': 'Створює задачу з шаблону за розкладом – тижневі звіти, місячні ревʼю.',
    'automation.newRecurring': 'Нова повторювана задача',
    'automation.template': 'Шаблон',
    'automation.frequency': 'Періодичність',
    'automation.freq.daily': 'Щодня',
    'automation.freq.weekly': 'Щотижня',
    'automation.freq.monthly': 'Щомісяця',
    'automation.freq.custom': 'Власна',
    'automation.nextRun': 'Наступний запуск',
    'automation.noRecurring': 'Повторюваних задач поки немає.',
    'automation.needTemplate': 'Спершу створіть шаблон задачі – повторюване правило створює задачі з нього.',
    'automation.deleteRecurringTitle': 'Видалити повторювану задачу',
    'automation.deleteRecurringBody': 'Видалити це правило? Уже створені задачі залишаться.',
    'automation.created': 'Створено',
    'automation.deleted': 'Видалено',
  },
});

interface TaskTemplate {
  id: string;
  projectId?: string | null;
  name: string;
  definition: { titlePattern?: string; priority?: string };
}

interface RecurringRule {
  id: string;
  projectId: string;
  templateId: string;
  frequency: 'daily' | 'weekly' | 'monthly' | 'custom';
  nextRun?: string | null;
  active: boolean;
}

const FREQUENCIES = ['daily', 'weekly', 'monthly'] as const;

function errMsg(cause: unknown, fallback: string): string {
  return cause instanceof ApiError ? cause.message : fallback;
}

export function ProjectAutomationSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();

  const templatesQ = useQuery<TaskTemplate[]>({
    queryKey: ['task-templates', projectId],
    queryFn: () => api.get<{ data: TaskTemplate[] }>(`/task-templates?projectId=${projectId}`).then((r) => r.data),
  });
  const recurringQ = useQuery<RecurringRule[]>({
    queryKey: ['recurring-tasks', projectId],
    queryFn: () => api.get<{ data: RecurringRule[] }>(`/recurring-tasks?projectId=${projectId}`).then((r) => r.data),
  });
  const templates = templatesQ.data ?? [];
  const rules = recurringQ.data ?? [];
  const templateById = new Map(templates.map((tpl) => [tpl.id, tpl]));

  const [addingTemplate, setAddingTemplate] = useState(false);
  const [addingRule, setAddingRule] = useState(false);
  const [templateToDelete, setTemplateToDelete] = useState<TaskTemplate | null>(null);
  const [ruleToDelete, setRuleToDelete] = useState<RecurringRule | null>(null);

  const refreshTemplates = () => qc.invalidateQueries({ queryKey: ['task-templates', projectId] });
  const refreshRules = () => qc.invalidateQueries({ queryKey: ['recurring-tasks', projectId] });

  const deleteTemplate = useMutation({
    mutationFn: (id: string) => api.del(`/task-templates/${id}`),
    onSuccess: () => { setTemplateToDelete(null); refreshTemplates(); toast(t('automation.deleted')); },
    onError: (cause) => toast.error(errMsg(cause, t('common.error'))),
  });
  const deleteRule = useMutation({
    mutationFn: (id: string) => api.del(`/recurring-tasks/${id}`),
    onSuccess: () => { setRuleToDelete(null); refreshRules(); toast(t('automation.deleted')); },
    onError: (cause) => toast.error(errMsg(cause, t('common.error'))),
  });
  const toggleRule = useMutation({
    mutationFn: (vars: { id: string; active: boolean }) => api.patch(`/recurring-tasks/${vars.id}`, { active: vars.active }),
    onSuccess: refreshRules,
    onError: (cause) => toast.error(errMsg(cause, t('common.saveFailed'))),
  });

  return (
    <>
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('automation.templates')}</h2>
          <Button size="xs" variant="ghost" onClick={() => setAddingTemplate(true)}>
            <Plus size={13} /> {t('automation.newTemplate')}
          </Button>
        </div>
        <div className="rounded-lg border border-border bg-card px-4">
          {templatesQ.isLoading ? (
            <div className="py-3"><Skeleton className="h-8" /></div>
          ) : templates.length === 0 ? (
            <p className="py-3 text-[13px] text-muted-foreground">{t('automation.noTemplates')} {t('automation.templatesHint')}</p>
          ) : templates.map((tpl, index) => (
            <div key={tpl.id} className={`flex items-center gap-3 py-2.5 ${index > 0 ? 'border-t border-border' : ''}`}>
              <PriorityIcon priority={tpl.definition?.priority ?? 'none'} size={14} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{tpl.name}</p>
                {tpl.definition?.titlePattern && tpl.definition.titlePattern !== tpl.name && (
                  <p className="truncate text-xs text-muted-foreground">{tpl.definition.titlePattern}</p>
                )}
              </div>
              {!tpl.projectId && (
                <span className="shrink-0 rounded bg-muted px-1.5 py-0.5 text-[11px] text-muted-foreground">{t('automation.workspaceTag')}</span>
              )}
              {tpl.projectId && (
                <Button size="xs" variant="ghost" className="shrink-0 hover:text-destructive" onClick={() => setTemplateToDelete(tpl)}>
                  <Trash2 size={13} />
                </Button>
              )}
            </div>
          ))}
        </div>
      </section>

      <section>
        <div className="mb-1 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('automation.recurring')}</h2>
          <Button size="xs" variant="ghost" onClick={() => setAddingRule(true)} disabled={!templates.length}>
            <Plus size={13} /> {t('automation.newRecurring')}
          </Button>
        </div>
        <div className="rounded-lg border border-border bg-card px-4">
          {recurringQ.isLoading ? (
            <div className="py-3"><Skeleton className="h-8" /></div>
          ) : rules.length === 0 ? (
            <p className="py-3 text-[13px] text-muted-foreground">
              {templates.length ? `${t('automation.noRecurring')} ${t('automation.recurringHint')}` : t('automation.needTemplate')}
            </p>
          ) : rules.map((rule, index) => (
            <div key={rule.id} className={`flex items-center gap-3 py-2.5 ${index > 0 ? 'border-t border-border' : ''}`}>
              <Repeat size={14} className="shrink-0 text-muted-foreground" />
              <div className="min-w-0 flex-1">
                <p className="truncate text-[13px] font-medium">{templateById.get(rule.templateId)?.name ?? '—'}</p>
                <p className="text-xs text-muted-foreground">
                  {t(`automation.freq.${rule.frequency}`)}
                  {rule.nextRun && <> · {t('automation.nextRun')}: {fmtDate(rule.nextRun)}</>}
                </p>
              </div>
              <Switch
                checked={rule.active}
                disabled={toggleRule.isPending}
                onChange={(active) => toggleRule.mutate({ id: rule.id, active })}
              />
              <Button size="xs" variant="ghost" className="shrink-0 hover:text-destructive" onClick={() => setRuleToDelete(rule)}>
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      </section>

      {addingTemplate && (
        <NewTemplateDialog
          projectId={projectId}
          onClose={() => setAddingTemplate(false)}
          onCreated={() => { setAddingTemplate(false); refreshTemplates(); toast(t('automation.created')); }}
        />
      )}
      {addingRule && (
        <NewRecurringDialog
          projectId={projectId}
          templates={templates}
          onClose={() => setAddingRule(false)}
          onCreated={() => { setAddingRule(false); refreshRules(); toast(t('automation.created')); }}
        />
      )}

      <ConfirmDialog
        open={!!templateToDelete}
        onClose={() => setTemplateToDelete(null)}
        onConfirm={() => templateToDelete && deleteTemplate.mutate(templateToDelete.id)}
        title={t('automation.deleteTemplateTitle')}
        body={t('automation.deleteTemplateBody').replace('{name}', templateToDelete?.name ?? '')}
        confirmLabel={t('common.delete')}
        danger
        pending={deleteTemplate.isPending}
      />
      <ConfirmDialog
        open={!!ruleToDelete}
        onClose={() => setRuleToDelete(null)}
        onConfirm={() => ruleToDelete && deleteRule.mutate(ruleToDelete.id)}
        title={t('automation.deleteRecurringTitle')}
        body={t('automation.deleteRecurringBody')}
        confirmLabel={t('common.delete')}
        danger
        pending={deleteRule.isPending}
      />
    </>
  );
}

function NewTemplateDialog({ projectId, onClose, onCreated }: {
  projectId: string; onClose: () => void; onCreated: () => void;
}) {
  const t = useT();
  const [name, setName] = useState('');
  const [titlePattern, setTitlePattern] = useState('');
  const [priority, setPriority] = useState('none');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/task-templates', {
      projectId,
      name: name.trim(),
      definition: { titlePattern: titlePattern.trim() || name.trim(), priority },
    }),
    onSuccess: onCreated,
    onError: (cause) => setError(errMsg(cause, t('common.error'))),
  });

  return (
    <Dialog open onClose={onClose} title={t('automation.newTemplate')} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event: FormEvent) => {
          event.preventDefault();
          if (!name.trim()) { setError(t('common.nameRequired')); return; }
          create.mutate();
        }}
      >
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('automation.templateName')}</label>
          <Input autoFocus value={name} onChange={(event) => setName(event.target.value)} placeholder="Weekly client report" />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('automation.templateTitle')}</label>
          <Input value={titlePattern} onChange={(event) => setTitlePattern(event.target.value)} placeholder={name || undefined} />
          <p className="text-[11px] text-faint">{t('automation.templateTitleHint')}</p>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('automation.priority')}</label>
          <Select className="w-full" value={priority} onChange={(event) => setPriority(event.target.value)}>
            {PRIORITIES.map((value) => <option key={value} value={value}>{t(PRIORITY_LABEL_KEY[value]!)}</option>)}
          </Select>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={create.isPending}>
            {create.isPending ? <Spinner /> : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function NewRecurringDialog({ projectId, templates, onClose, onCreated }: {
  projectId: string; templates: TaskTemplate[]; onClose: () => void; onCreated: () => void;
}) {
  const t = useT();
  const [templateId, setTemplateId] = useState(templates[0]?.id ?? '');
  const [frequency, setFrequency] = useState<string>('weekly');
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () => api.post('/recurring-tasks', { projectId, templateId, frequency }),
    onSuccess: onCreated,
    onError: (cause) => setError(errMsg(cause, t('common.error'))),
  });

  return (
    <Dialog open onClose={onClose} title={t('automation.newRecurring')} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event: FormEvent) => { event.preventDefault(); if (templateId) create.mutate(); }}
      >
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('automation.template')}</label>
          <Select className="w-full" value={templateId} onChange={(event) => setTemplateId(event.target.value)}>
            {templates.map((tpl) => <option key={tpl.id} value={tpl.id}>{tpl.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('automation.frequency')}</label>
          <Select className="w-full" value={frequency} onChange={(event) => setFrequency(event.target.value)}>
            {FREQUENCIES.map((value) => <option key={value} value={value}>{t(`automation.freq.${value}`)}</option>)}
          </Select>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={create.isPending || !templateId}>
            {create.isPending ? <Spinner /> : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
