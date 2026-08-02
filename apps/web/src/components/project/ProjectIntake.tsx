/**
 * Intake triage: the queue behind the public request form. Every pending item
 * is either accepted (becomes a task, requester notified) or declined (with a
 * reason, optionally mailed back). The public form existed and collected
 * requests – this is the screen where the team finally sees them.
 */
import { useState, type FormEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, Copy, Inbox, Mail, X } from 'lucide-react';
import { api, appOrigin, ApiError } from '../../lib/api';
import { useOpen } from '../../lib/router';
import { Button, Card, EmptyState, Input, Select, Skeleton, Spinner, Switch, fmtDate } from '../ui';
import { Dialog, toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'intake.title': 'Intake',
    'intake.hint': 'Requests from the public form, waiting for a decision.',
    'intake.empty': 'No pending requests',
    'intake.emptyHint': 'Requests submitted through the public form land here for triage.',
    'intake.emptyFormOff': 'The public form is off – enable it in Settings to start receiving requests.',
    'intake.accept': 'Accept',
    'intake.decline': 'Decline',
    'intake.acceptTitle': 'Accept as a task',
    'intake.declineTitle': 'Decline request',
    'intake.status': 'Status',
    'intake.assignee': 'Assignee',
    'intake.noAssignee': 'Nobody yet',
    'intake.reason': 'Reason',
    'intake.reasonPh': 'Out of scope, duplicate, needs more detail…',
    'intake.notify': 'Email the requester about this decision',
    'intake.accepted': 'Task created',
    'intake.declined': 'Request declined',
    'intake.openTask': 'Open task',
    'intake.requestedBy': 'from',
    'intake.settingsTitle': 'Intake form',
    'intake.settingsHint': 'A public page where clients submit requests without an account.',
    'intake.formEnabled': 'Public form enabled',
    'intake.formLink': 'Form link',
    'intake.copyLink': 'Copy link',
    'intake.linkCopied': 'Link copied',
    'intake.formDisabledHint': 'The link stops working while the form is off.',
  },
  uk: {
    'intake.title': 'Запити',
    'intake.hint': 'Запити з публічної форми, що чекають на рішення.',
    'intake.empty': 'Немає запитів на розгляді',
    'intake.emptyHint': 'Запити з публічної форми потрапляють сюди на тріаж.',
    'intake.emptyFormOff': 'Публічна форма вимкнена – увімкніть її в Налаштуваннях, щоб отримувати запити.',
    'intake.accept': 'Прийняти',
    'intake.decline': 'Відхилити',
    'intake.acceptTitle': 'Прийняти як задачу',
    'intake.declineTitle': 'Відхилити запит',
    'intake.status': 'Статус',
    'intake.assignee': 'Виконавець',
    'intake.noAssignee': 'Поки ніхто',
    'intake.reason': 'Причина',
    'intake.reasonPh': 'Поза скоупом, дублікат, бракує деталей…',
    'intake.notify': 'Повідомити автора запиту на email',
    'intake.accepted': 'Задачу створено',
    'intake.declined': 'Запит відхилено',
    'intake.openTask': 'Відкрити задачу',
    'intake.requestedBy': 'від',
    'intake.settingsTitle': 'Форма запитів',
    'intake.settingsHint': 'Публічна сторінка, де клієнти надсилають запити без акаунта.',
    'intake.formEnabled': 'Публічну форму ввімкнено',
    'intake.formLink': 'Посилання на форму',
    'intake.copyLink': 'Скопіювати посилання',
    'intake.linkCopied': 'Посилання скопійовано',
    'intake.formDisabledHint': 'Поки форма вимкнена, посилання не працює.',
  },
});

export interface IntakeItem {
  id: string;
  title: string;
  description?: string | null;
  requesterName?: string | null;
  requesterEmail?: string | null;
  createdAt?: string;
}

interface StatusLite { id: string; name: string; isDefault?: boolean }
interface UserLite { id: string; name: string; avatar?: string | null }

/** Pending intake items; also feeds the tab badge on the project header. */
export function useIntakeItems(projectId: string, enabled: boolean) {
  return useQuery<IntakeItem[]>({
    queryKey: ['project-intake', projectId],
    queryFn: () => api.get<{ data: IntakeItem[] }>(`/projects/${projectId}/intake`).then((r) => r.data),
    enabled,
  });
}

export function ProjectIntakeTab({ projectId, statuses, users }: {
  projectId: string;
  statuses: StatusLite[];
  users: UserLite[];
}) {
  const t = useT();
  const open = useOpen();
  const qc = useQueryClient();
  const itemsQ = useIntakeItems(projectId, true);
  const [accepting, setAccepting] = useState<IntakeItem | null>(null);
  const [declining, setDeclining] = useState<IntakeItem | null>(null);

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['project-intake', projectId] });
    qc.invalidateQueries({ queryKey: ['tasks', projectId] });
    qc.invalidateQueries({ queryKey: ['project-task-counts'] });
  };

  if (itemsQ.isLoading) {
    return <div className="space-y-3 p-6">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-20" />)}</div>;
  }
  const items = itemsQ.data ?? [];

  return (
    <div className="mx-auto max-w-3xl space-y-3 px-6 py-6">
      {items.length === 0 ? (
        <EmptyState icon={<Inbox size={20} />} title={t('intake.empty')} hint={t('intake.emptyHint')} />
      ) : items.map((item) => (
        <Card key={item.id} className="p-4">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{item.title}</p>
              <p className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-xs text-muted-foreground">
                {item.requesterName && <span>{t('intake.requestedBy')} {item.requesterName}</span>}
                {item.requesterEmail && (
                  <span className="inline-flex items-center gap-1 text-faint"><Mail size={11} /> {item.requesterEmail}</span>
                )}
                {item.createdAt && <span className="text-faint">· {fmtDate(item.createdAt)}</span>}
              </p>
              {item.description && (
                <p className="mt-2 whitespace-pre-wrap text-[13px] leading-relaxed text-muted-foreground">{item.description}</p>
              )}
            </div>
            <div className="flex shrink-0 items-center gap-1.5">
              <Button size="xs" onClick={() => setAccepting(item)}>
                <Check size={12} /> {t('intake.accept')}
              </Button>
              <Button size="xs" variant="outline" onClick={() => setDeclining(item)}>
                <X size={12} /> {t('intake.decline')}
              </Button>
            </div>
          </div>
        </Card>
      ))}

      {accepting && (
        <AcceptDialog
          item={accepting}
          statuses={statuses}
          users={users}
          onClose={() => setAccepting(null)}
          onAccepted={(taskId) => {
            setAccepting(null);
            refresh();
            toast.action(
              t('intake.accepted'),
              { label: t('intake.openTask'), onSelect: () => open(`/projects/${projectId}/tasks/${taskId}`) },
              'success',
            );
          }}
        />
      )}
      {declining && (
        <DeclineDialog
          item={declining}
          onClose={() => setDeclining(null)}
          onDeclined={() => { setDeclining(null); refresh(); toast(t('intake.declined')); }}
        />
      )}
    </div>
  );
}

function AcceptDialog({ item, statuses, users, onClose, onAccepted }: {
  item: IntakeItem;
  statuses: StatusLite[];
  users: UserLite[];
  onClose: () => void;
  onAccepted: (taskId: string) => void;
}) {
  const t = useT();
  const defaultStatus = statuses.find((s) => s.isDefault) ?? statuses[0];
  const [statusId, setStatusId] = useState(defaultStatus?.id ?? '');
  const [assigneeId, setAssigneeId] = useState('');
  const [error, setError] = useState<string | null>(null);

  const accept = useMutation({
    mutationFn: () => api.post<{ taskId: string }>(`/intake/${item.id}/accept`, {
      statusId: statusId || undefined,
      assigneeIds: assigneeId ? [assigneeId] : [],
    }),
    onSuccess: (result) => onAccepted(result.taskId),
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : t('common.error')),
  });

  return (
    <Dialog open onClose={onClose} title={t('intake.acceptTitle')} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event: FormEvent) => { event.preventDefault(); accept.mutate(); }}
      >
        <p className="text-[13px] font-medium">{item.title}</p>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('intake.status')}</label>
          <Select className="w-full" value={statusId} onChange={(event) => setStatusId(event.target.value)}>
            {statuses.map((status) => <option key={status.id} value={status.id}>{status.name}</option>)}
          </Select>
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('intake.assignee')}</label>
          <Select className="w-full" value={assigneeId} onChange={(event) => setAssigneeId(event.target.value)}>
            <option value="">{t('intake.noAssignee')}</option>
            {users.map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
          </Select>
        </div>
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={accept.isPending}>
            {accept.isPending ? <Spinner /> : t('intake.accept')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function DeclineDialog({ item, onClose, onDeclined }: {
  item: IntakeItem;
  onClose: () => void;
  onDeclined: () => void;
}) {
  const t = useT();
  const [reason, setReason] = useState('');
  const [notify, setNotify] = useState(!!item.requesterEmail);
  const [error, setError] = useState<string | null>(null);

  const decline = useMutation({
    mutationFn: () => api.post(`/intake/${item.id}/decline`, { reason: reason.trim(), notify }),
    onSuccess: onDeclined,
    onError: (cause) => setError(cause instanceof ApiError ? cause.message : t('common.error')),
  });

  return (
    <Dialog open onClose={onClose} title={t('intake.declineTitle')} width={420}>
      <form
        className="space-y-3 px-4 pb-4 pt-1"
        onSubmit={(event: FormEvent) => { event.preventDefault(); decline.mutate(); }}
      >
        <p className="text-[13px] font-medium">{item.title}</p>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">{t('intake.reason')}</label>
          <Input autoFocus value={reason} onChange={(event) => setReason(event.target.value)} placeholder={t('intake.reasonPh')} />
        </div>
        {item.requesterEmail && (
          <label className="flex items-center gap-2 text-[13px]">
            <input type="checkbox" checked={notify} onChange={(event) => setNotify(event.target.checked)} />
            {t('intake.notify')}
          </label>
        )}
        {error && <p className="text-[13px] text-destructive">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" size="sm" variant="ghost" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" variant="destructive" disabled={decline.isPending}>
            {decline.isPending ? <Spinner /> : t('intake.decline')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ─────────────── Settings: enable the form, share the link ─────────────── */

interface IntakeSettings { formToken: string; formEnabled: boolean }

export function IntakeSettingsSection({ projectId }: { projectId: string }) {
  const t = useT();
  const qc = useQueryClient();
  const settingsQ = useQuery<IntakeSettings>({
    queryKey: ['intake-settings', projectId],
    queryFn: () => api.get<IntakeSettings>(`/projects/${projectId}/intake-settings`),
  });

  const patch = useMutation({
    mutationFn: (formEnabled: boolean) => api.patch(`/projects/${projectId}/intake-settings`, { formEnabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['intake-settings', projectId] }),
    onError: (cause) => toast.error(cause instanceof ApiError ? cause.message : t('common.saveFailed')),
  });

  const settings = settingsQ.data;
  // appOrigin, not window.location: in the desktop app the window is not the instance.
  const link = settings ? `${appOrigin()}/intake/${settings.formToken}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      toast(t('intake.linkCopied'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <section>
      <h2 className="mb-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('intake.settingsTitle')}</h2>
      <div className="rounded-lg border border-border bg-card px-4">
        {settingsQ.isLoading || !settings ? (
          <div className="py-3"><Skeleton className="h-8" /></div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-4 py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{t('intake.formEnabled')}</p>
                <p className="mt-0.5 text-xs text-muted-foreground">{t('intake.settingsHint')}</p>
              </div>
              <Switch checked={settings.formEnabled} onChange={(next) => patch.mutate(next)} disabled={patch.isPending} />
            </div>
            <div className="flex items-center justify-between gap-4 border-t border-border py-3">
              <div className="min-w-0">
                <p className="text-[13px] font-medium">{t('intake.formLink')}</p>
                <p className="mt-0.5 truncate font-mono text-xs text-muted-foreground" title={link}>{link}</p>
                {!settings.formEnabled && <p className="mt-0.5 text-xs text-warning">{t('intake.formDisabledHint')}</p>}
              </div>
              <Button size="xs" variant="outline" className="shrink-0" onClick={copy}>
                <Copy size={12} /> {t('intake.copyLink')}
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}
