/**
 * Settings → Agents (plan 2026-09-05-001, R1-R2, R7, R10, R21, R49, R52).
 *
 * Three sections, in the order an admin needs them: the workspace Claude
 * connection (without a credential nothing can run), the agents themselves,
 * and the worker that executes them. Everything here needs `agents.manage`.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_ASSIGN_POLICIES, AGENT_CREDENTIAL_KINDS, AGENT_CREDENTIAL_SLOTS, AGENT_RUNTIMES,
  EXECUTABLE_AGENT_RUNTIMES,
} from '@ordi/shared';
import {
  Bot, Cpu, KeyRound, MoreHorizontal, Plus, RotateCcw, ShieldCheck, Trash2, Server,
} from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { useAgents, useMcpConnectors, useUsersLookup, type AgentLookup } from '../../lib/queries';
import {
  Avatar, Badge, Button, Card, Checkbox, EmptyState, Input, SegmentedControl, Select, Skeleton,
  Spinner, Switch, Textarea, cn, fmtDate, fmtRelative,
} from '../ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../overlays';
import { SectionHead, Field, RowList, AnimatedRow, StatusChip } from './primitives';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'agents.desc': 'AI agents work like team members: assign them a task and they open a pull request for review.',
    // Claude connection
    'agents.connection': 'Claude connection',
    'agents.connectionDesc': 'The credential every agent runs on. A subscription token and an API key are equal choices.',
    'agents.addCredential': 'Add credential',
    'agents.noCredentials': 'No credential yet',
    'agents.noCredentialsHint': 'Add a Claude subscription token or an API key so agents can run.',
    'agents.kind.subscription': 'Subscription',
    'agents.kind.api_key': 'API key',
    'agents.slot.primary': 'Primary',
    'agents.slot.fallback': 'Fallback',
    'agents.credStatus.active': 'Active',
    'agents.credStatus.expired': 'Expired',
    'agents.credStatus.revoked': 'Revoked',
    'agents.connectedBy': 'Connected by {name} on {date}',
    'agents.connectedOn': 'Connected on {date}',
    'agents.expires': 'Expires {date}',
    'agents.lastVerified': 'Verified {when}',
    'agents.neverVerified': 'Never verified',
    'agents.fromEnv': 'Provided by the ANTHROPIC_API_KEY variable of this deployment – change it there, not here.',
    'agents.verify': 'Verify',
    'agents.verifyOk': 'The credential works',
    'agents.verifyFailed': 'The credential was refused',
    'agents.rotate': 'Rotate secret',
    'agents.rotateTitle': 'Rotate the secret',
    'agents.rotateHint': 'The new secret replaces the old one immediately. Running agents pick it up on their next run.',
    'agents.rotated': 'Secret rotated',
    'agents.setPrimary': 'Use as primary',
    'agents.setFallback': 'Use as fallback',
    'agents.clearSlot': 'Remove from rotation',
    'agents.revoke': 'Revoke',
    'agents.revokeTitle': 'Revoke this credential',
    'agents.revokeBody': 'Agents using it stop running until another credential takes its place. The secret is deleted.',
    'agents.revoked': 'Credential revoked',
    'agents.credLabel': 'Label',
    'agents.credLabelPlaceholder': 'e.g. Company Max plan',
    'agents.secret': 'Secret',
    'agents.newSecret': 'New secret',
    'agents.expiresAt': 'Expires (optional)',
    'agents.slotLabel': 'Role in rotation',
    'agents.subscriptionHelp': 'Run “claude setup-token” on your own machine and paste the token it prints here. It is valid for a year.',
    'agents.apiKeyHelp': 'An Anthropic API key from the console. Usage is billed to that account.',
    'agents.credentialAdded': 'Credential added',
    // Agents
    'agents.list': 'Agents',
    'agents.listDesc': 'Each agent is a workspace member with a role, a project list and its own limits.',
    'agents.new': 'New agent',
    'agents.none': 'No agents yet',
    'agents.noneHint': 'Create an agent and add it to a project to assign it work.',
    'agents.ready': 'Ready',
    'agents.needsCredential': 'Credential required',
    'agents.stateDisabled': 'Disabled',
    'agents.enable': 'Enable',
    'agents.disable': 'Disable',
    'agents.enabledToast': 'Agent enabled',
    'agents.disabledToast': 'Agent disabled',
    'agents.projectsCount': '{n} projects',
    'agents.connectorsCount': '{n} connectors',
    'agents.editTitle': 'Edit agent',
    'agents.newTitle': 'New agent',
    'agents.created': 'Agent created',
    'agents.updated': 'Agent updated',
    'agents.saveFailed': 'Could not save the agent',
    'agents.runtime': 'Runtime',
    'agents.runtime.claude_code': 'Claude Code',
    'agents.runtime.codex': 'Codex',
    'agents.comingSoon': 'coming soon',
    'agents.model': 'Model',
    'agents.modelHint': 'Leave empty for the runtime default.',
    'agents.instructions': 'Instructions',
    'agents.instructionsPlaceholder': 'How this agent should work: conventions, what to check before opening a PR, what to leave alone.',
    'agents.assignPolicy': 'Who may assign work',
    'agents.policy.project_members': 'Project members',
    'agents.policy.project_admins': 'Project admins',
    'agents.policy.agents_managers': 'Agent managers only',
    'agents.policyHint.project_members': 'Anyone who can write tasks in the project may hand work to this agent.',
    'agents.policyHint.project_admins': 'Only project admins may hand work to this agent.',
    'agents.policyHint.agents_managers': 'Only people with the “Manage agents” permission may hand work to this agent.',
    'agents.maxRunMinutes': 'Max minutes per run',
    'agents.maxTurns': 'Max turns',
    'agents.maxBudget': 'Max budget, USD',
    'agents.concurrency': 'Parallel runs',
    'agents.credential': 'Credential',
    'agents.fallbackCredential': 'Fallback credential',
    'agents.workspaceDefault': 'Workspace default',
    'agents.connectors': 'Connectors',
    'agents.connectorsHint': 'The MCP servers this agent may call during a run.',
    'agents.connectorsEmpty': 'No connectors in the workspace yet.',
    'agents.builtinConnector': 'ordi (built in)',
    'agents.builtinConnectorHint': 'Always available – it is how the agent reads the task and writes back.',
    'agents.connectorsNoAccess': 'Managing connectors needs the “Manage integrations” permission.',
    'agents.agentEnabled': 'Enabled',
    'agents.agentEnabledHint': 'A disabled agent keeps its settings but is never dispatched.',
    // Workers
    'agents.workers': 'Workers',
    'agents.workersDesc': 'The processes that execute runs, and whether the runtime is installed next to them.',
    'agents.workerDisabled': 'The agent worker is off in this deployment – set AGENT_WORKER_ENABLED=true to run agents.',
    'agents.noWorkers': 'No worker has reported in yet.',
    'agents.runtimeInstalled': 'Installed',
    'agents.runtimeMissing': 'Not installed',
    'agents.workerOnline': 'Online',
    'agents.workerOffline': 'Offline',
    'agents.workerRunning': '{running} of {concurrency} running',
    'agents.workerSeen': 'Last seen {when}',
    'agents.callbackUrl': 'Connector callback URL',
  },
  uk: {
    'agents.desc': 'AI-агенти працюють як учасники команди: призначте задачу – і вони відкриють пулреквест на рев’ю.',
    // Claude connection
    'agents.connection': 'Доступ Claude',
    'agents.connectionDesc': 'Обліковий доступ, на якому працюють агенти. Токен підписки та API-ключ – рівноцінні варіанти.',
    'agents.addCredential': 'Додати доступ',
    'agents.noCredentials': 'Доступу ще немає',
    'agents.noCredentialsHint': 'Додайте токен підписки Claude або API-ключ, щоб агенти могли працювати.',
    'agents.kind.subscription': 'Підписка',
    'agents.kind.api_key': 'API-ключ',
    'agents.slot.primary': 'Основний',
    'agents.slot.fallback': 'Резервний',
    'agents.credStatus.active': 'Активний',
    'agents.credStatus.expired': 'Протермінований',
    'agents.credStatus.revoked': 'Відкликаний',
    'agents.connectedBy': 'Підключив(ла) {name}, {date}',
    'agents.connectedOn': 'Підключено {date}',
    'agents.expires': 'Діє до {date}',
    'agents.lastVerified': 'Перевірено {when}',
    'agents.neverVerified': 'Ще не перевірявся',
    'agents.fromEnv': 'Береться зі змінної ANTHROPIC_API_KEY цього розгортання – змінюйте її там, а не тут.',
    'agents.verify': 'Перевірити',
    'agents.verifyOk': 'Доступ працює',
    'agents.verifyFailed': 'Доступ відхилено',
    'agents.rotate': 'Замінити секрет',
    'agents.rotateTitle': 'Заміна секрету',
    'agents.rotateHint': 'Новий секрет одразу замінює старий. Агенти підхоплять його на наступному запуску.',
    'agents.rotated': 'Секрет замінено',
    'agents.setPrimary': 'Зробити основним',
    'agents.setFallback': 'Зробити резервним',
    'agents.clearSlot': 'Прибрати з ротації',
    'agents.revoke': 'Відкликати',
    'agents.revokeTitle': 'Відкликати цей доступ',
    'agents.revokeBody': 'Агенти, що ним користуються, зупиняться, доки не з’явиться інший доступ. Секрет буде видалено.',
    'agents.revoked': 'Доступ відкликано',
    'agents.credLabel': 'Назва',
    'agents.credLabelPlaceholder': 'напр. Компанійський план Max',
    'agents.secret': 'Секрет',
    'agents.newSecret': 'Новий секрет',
    'agents.expiresAt': 'Діє до (необов’язково)',
    'agents.slotLabel': 'Роль у ротації',
    'agents.subscriptionHelp': 'Виконайте «claude setup-token» на своєму комп’ютері та вставте сюди токен, який він виведе. Він дійсний рік.',
    'agents.apiKeyHelp': 'API-ключ Anthropic із консолі. Використання оплачує той акаунт.',
    'agents.credentialAdded': 'Доступ додано',
    // Agents
    'agents.list': 'Агенти',
    'agents.listDesc': 'Кожен агент – це учасник воркспейсу з роллю, переліком проєктів і власними лімітами.',
    'agents.new': 'Новий агент',
    'agents.none': 'Агентів ще немає',
    'agents.noneHint': 'Створіть агента й додайте його до проєкту, щоб призначати йому роботу.',
    'agents.ready': 'Готовий',
    'agents.needsCredential': 'Потрібен доступ',
    'agents.stateDisabled': 'Вимкнений',
    'agents.enable': 'Увімкнути',
    'agents.disable': 'Вимкнути',
    'agents.enabledToast': 'Агента увімкнено',
    'agents.disabledToast': 'Агента вимкнено',
    'agents.projectsCount': 'проєктів: {n}',
    'agents.connectorsCount': 'конекторів: {n}',
    'agents.editTitle': 'Редагування агента',
    'agents.newTitle': 'Новий агент',
    'agents.created': 'Агента створено',
    'agents.updated': 'Агента оновлено',
    'agents.saveFailed': 'Не вдалося зберегти агента',
    'agents.runtime': 'Середовище',
    'agents.runtime.claude_code': 'Claude Code',
    'agents.runtime.codex': 'Codex',
    'agents.comingSoon': 'скоро',
    'agents.model': 'Модель',
    'agents.modelHint': 'Залиште порожнім, щоб узяти типову модель середовища.',
    'agents.instructions': 'Інструкції',
    'agents.instructionsPlaceholder': 'Як цей агент має працювати: домовленості, що перевірити перед пулреквестом, чого не чіпати.',
    'agents.assignPolicy': 'Хто може призначати роботу',
    'agents.policy.project_members': 'Учасники проєкту',
    'agents.policy.project_admins': 'Адміни проєкту',
    'agents.policy.agents_managers': 'Лише керівники агентів',
    'agents.policyHint.project_members': 'Будь-хто, хто може редагувати задачі проєкту, може дати роботу цьому агентові.',
    'agents.policyHint.project_admins': 'Лише адміни проєкту можуть дати роботу цьому агентові.',
    'agents.policyHint.agents_managers': 'Лише люди з дозволом «Керування агентами» можуть дати роботу цьому агентові.',
    'agents.maxRunMinutes': 'Максимум хвилин на запуск',
    'agents.maxTurns': 'Максимум кроків',
    'agents.maxBudget': 'Максимальний бюджет, USD',
    'agents.concurrency': 'Паралельних запусків',
    'agents.credential': 'Доступ',
    'agents.fallbackCredential': 'Резервний доступ',
    'agents.workspaceDefault': 'Як у воркспейсі',
    'agents.connectors': 'Конектори',
    'agents.connectorsHint': 'MCP-сервери, до яких агент може звертатися під час запуску.',
    'agents.connectorsEmpty': 'У воркспейсі ще немає конекторів.',
    'agents.builtinConnector': 'ordi (вбудований)',
    'agents.builtinConnectorHint': 'Доступний завжди – саме через нього агент читає задачу й пише відповідь.',
    'agents.connectorsNoAccess': 'Керування конекторами потребує дозволу «Керування інтеграціями».',
    'agents.agentEnabled': 'Увімкнений',
    'agents.agentEnabledHint': 'Вимкнений агент зберігає налаштування, але задачі йому не надсилаються.',
    // Workers
    'agents.workers': 'Виконавці',
    'agents.workersDesc': 'Процеси, які виконують запуски, та наявність середовища поруч із ними.',
    'agents.workerDisabled': 'Виконавець агентів вимкнений у цьому розгортанні – встановіть AGENT_WORKER_ENABLED=true.',
    'agents.noWorkers': 'Жоден виконавець ще не звітував.',
    'agents.runtimeInstalled': 'Встановлено',
    'agents.runtimeMissing': 'Не встановлено',
    'agents.workerOnline': 'Онлайн',
    'agents.workerOffline': 'Офлайн',
    'agents.workerRunning': 'виконує {running} із {concurrency}',
    'agents.workerSeen': 'Востаннє на звʼязку {when}',
    'agents.callbackUrl': 'URL зворотного виклику для конекторів',
  },
});

interface CredentialView {
  id: string;
  provider: string;
  kind: string;
  label: string;
  slot: string | null;
  status: string;
  expiresAt: string | null;
  lastVerifiedAt: string | null;
  lastVerifyError: string | null;
  connectedBy: string | null;
  connectedAt: string;
  revokedAt: string | null;
  version: number;
  fromEnv?: boolean;
}

interface WorkerRow {
  id: string;
  startedAt: string;
  lastSeenAt: string;
  concurrency: number;
  running: number;
  runtimeAvailable: boolean;
  version: string | null;
  online: boolean;
}

interface OverviewResponse {
  runtimes: { key: string; available: boolean; installed: boolean }[];
  workers: WorkerRow[];
  workerEnabled: boolean;
  connectorCallbackUrl: string;
}

interface RoleRow { id: string; key?: string; name: string }

function fill(template: string, values: Record<string, string | number>): string {
  return Object.entries(values).reduce((acc, [k, v]) => acc.replace(`{${k}}`, String(v)), template);
}

/** A date input carries a day; the API stores an instant. */
function dayToIso(day: string): string | null {
  if (!day) return null;
  const d = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function isoToDay(iso: string | null): string {
  return iso ? iso.slice(0, 10) : '';
}

function errMessage(e: unknown, fallback: string): string {
  return e instanceof ApiError ? e.message : fallback;
}

/* ────────────────────────────── Claude connection ────────────────────────────── */

function CredentialCard({ cred, users }: { cred: CredentialView; users: { id: string; name: string }[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [rotateOpen, setRotateOpen] = useState(false);
  const [revokeOpen, setRevokeOpen] = useState(false);

  const invalidate = () => {
    qc.invalidateQueries({ queryKey: ['agent-credentials'] });
    qc.invalidateQueries({ queryKey: ['agents'] });
  };

  const verify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; error?: string | null; model?: string | null }>(`/agent-credentials/${cred.id}/verify`, {}),
    onSuccess: (res) => {
      invalidate();
      if (res.ok) toast(t('agents.verifyOk'));
      else toast.error(res.error ? `${t('agents.verifyFailed')} – ${res.error}` : t('agents.verifyFailed'));
    },
    onError: (e) => toast.error(errMessage(e, t('agents.verifyFailed'))),
  });

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/agent-credentials/${cred.id}`, { ...body, version: cred.version }),
    onSuccess: () => { invalidate(); toast(t('common.saved')); },
    onError: (e) => toast.error(errMessage(e, t('settings.saveFailed'))),
  });

  const revoke = useMutation({
    mutationFn: () => api.del(`/agent-credentials/${cred.id}`),
    onSuccess: () => { setRevokeOpen(false); invalidate(); toast(t('agents.revoked')); },
    onError: (e) => { setRevokeOpen(false); toast.error(errMessage(e, t('settings.saveFailed'))); },
  });

  const dead = cred.status === 'revoked';
  const who = users.find((u) => u.id === cred.connectedBy)?.name;
  const tone = dead ? 'off' : cred.status === 'active' ? 'ok' : 'muted';

  return (
    <Card className="p-4">
      <div className="flex items-start gap-3">
        <div className={cn('grid h-9 w-9 shrink-0 place-items-center rounded-lg bg-muted', dead ? 'text-faint' : 'text-foreground')}>
          <KeyRound size={17} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn('text-[13px] font-semibold', dead && 'text-muted-foreground line-through')}>{cred.label}</span>
            <Badge>{t(`agents.kind.${cred.kind}`)}</Badge>
            {cred.slot && <Badge className="bg-primary/10 text-primary">{t(`agents.slot.${cred.slot}`)}</Badge>}
          </div>
          <div className="mt-1 space-y-0.5 text-xs text-muted-foreground">
            <p>
              {cred.fromEnv
                ? t('agents.fromEnv')
                : who
                  ? fill(t('agents.connectedBy'), { name: who, date: fmtDate(cred.connectedAt) })
                  : fill(t('agents.connectedOn'), { date: fmtDate(cred.connectedAt) })}
            </p>
            {cred.expiresAt && <p>{fill(t('agents.expires'), { date: fmtDate(cred.expiresAt) })}</p>}
            <p>
              {cred.lastVerifiedAt
                ? fill(t('agents.lastVerified'), { when: fmtRelative(cred.lastVerifiedAt) })
                : t('agents.neverVerified')}
            </p>
            {cred.lastVerifyError && <p className="text-destructive">{cred.lastVerifyError}</p>}
          </div>
        </div>
        <StatusChip tone={tone}>{t(`agents.credStatus.${cred.status}`, cred.status)}</StatusChip>
        {!cred.fromEnv && !dead && (
          <>
            <Button size="sm" variant="outline" onClick={() => verify.mutate()} disabled={verify.isPending}>
              {verify.isPending ? <Spinner /> : <ShieldCheck size={14} />} {t('agents.verify')}
            </Button>
            <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
              <MenuItem icon={<RotateCcw size={14} />} onSelect={() => setRotateOpen(true)}>{t('agents.rotate')}</MenuItem>
              {cred.slot !== 'primary' && (
                <MenuItem icon={<KeyRound size={14} />} onSelect={() => patch.mutate({ slot: 'primary' })}>{t('agents.setPrimary')}</MenuItem>
              )}
              {cred.slot !== 'fallback' && (
                <MenuItem icon={<KeyRound size={14} />} onSelect={() => patch.mutate({ slot: 'fallback' })}>{t('agents.setFallback')}</MenuItem>
              )}
              {cred.slot && <MenuItem onSelect={() => patch.mutate({ slot: null })}>{t('agents.clearSlot')}</MenuItem>}
              <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setRevokeOpen(true)}>{t('agents.revoke')}</MenuItem>
            </DropdownMenu>
          </>
        )}
      </div>

      <RotateSecretDialog open={rotateOpen} onClose={() => setRotateOpen(false)} cred={cred} />

      <ConfirmDialog
        open={revokeOpen}
        onClose={() => setRevokeOpen(false)}
        onConfirm={() => revoke.mutate()}
        title={t('agents.revokeTitle')}
        body={t('agents.revokeBody')}
        confirmLabel={t('agents.revoke')}
        cancelLabel={t('common.cancel')}
        danger
        pending={revoke.isPending}
      />
    </Card>
  );
}

function RotateSecretDialog({ open, onClose, cred }: { open: boolean; onClose: () => void; cred: CredentialView }) {
  const t = useT();
  const qc = useQueryClient();
  const [secret, setSecret] = useState('');
  const [expires, setExpires] = useState('');

  useEffect(() => { if (open) { setSecret(''); setExpires(isoToDay(cred.expiresAt)); } }, [open, cred.expiresAt]);

  const rotate = useMutation({
    mutationFn: () => api.patch(`/agent-credentials/${cred.id}`, {
      secret: secret.trim(),
      expiresAt: expires ? dayToIso(expires) : null,
      version: cred.version,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-credentials'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast(t('agents.rotated'));
      onClose();
    },
    onError: (e) => toast.error(errMessage(e, t('settings.saveFailed'))),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('agents.rotateTitle')} width={440}>
      <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (secret.trim().length >= 8 && !rotate.isPending) rotate.mutate(); }}>
        <p className="text-xs text-muted-foreground">{t('agents.rotateHint')}</p>
        <Field label={t('agents.newSecret')}>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoFocus autoComplete="off" />
        </Field>
        <Field label={t('agents.expiresAt')}>
          <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={secret.trim().length < 8 || rotate.isPending}>
            {rotate.isPending ? <Spinner /> : <RotateCcw size={14} />} {t('agents.rotate')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddCredentialDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [kind, setKind] = useState<'subscription' | 'api_key'>('subscription');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [slot, setSlot] = useState<'primary' | 'fallback'>('primary');
  const [expires, setExpires] = useState('');

  useEffect(() => {
    if (open) { setKind('subscription'); setLabel(''); setSecret(''); setSlot('primary'); setExpires(''); }
  }, [open]);

  const create = useMutation({
    mutationFn: () => api.post('/agent-credentials', {
      provider: 'anthropic',
      kind,
      label: label.trim(),
      secret: secret.trim(),
      slot,
      expiresAt: expires ? dayToIso(expires) : null,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agent-credentials'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      toast(t('agents.credentialAdded'));
      onClose();
    },
    onError: (e) => toast.error(errMessage(e, t('settings.saveFailed'))),
  });

  const valid = label.trim().length > 0 && secret.trim().length >= 8;

  return (
    <Dialog open={open} onClose={onClose} title={t('agents.addCredential')} width={460}>
      <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (valid && !create.isPending) create.mutate(); }}>
        <SegmentedControl
          className="w-full"
          value={kind}
          onChange={setKind}
          options={AGENT_CREDENTIAL_KINDS.map((k) => ({ key: k, label: t(`agents.kind.${k}`) }))}
        />
        <p className="text-xs text-muted-foreground">{kind === 'subscription' ? t('agents.subscriptionHelp') : t('agents.apiKeyHelp')}</p>

        <Field label={t('agents.credLabel')}>
          <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={t('agents.credLabelPlaceholder')} autoFocus />
        </Field>
        <Field label={t('agents.secret')}>
          <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} autoComplete="off" placeholder={kind === 'api_key' ? 'sk-ant-…' : 'sk-ant-oat…'} />
        </Field>
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agents.slotLabel')}>
            <Select value={slot} onChange={(e) => setSlot(e.target.value as 'primary' | 'fallback')} className="w-full">
              {AGENT_CREDENTIAL_SLOTS.map((s) => <option key={s} value={s}>{t(`agents.slot.${s}`)}</option>)}
            </Select>
          </Field>
          <Field label={t('agents.expiresAt')}>
            <Input type="date" value={expires} onChange={(e) => setExpires(e.target.value)} />
          </Field>
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!valid || create.isPending}>
            {create.isPending ? <Spinner /> : <Plus size={14} />} {t('common.add')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ────────────────────────────── Agent editor ────────────────────────────── */

interface AgentDraft {
  name: string;
  roleId: string;
  runtime: string;
  model: string;
  instructions: string;
  assignPolicy: string;
  maxRunMinutes: string;
  maxTurns: string;
  maxBudgetUsd: string;
  concurrency: string;
  credentialId: string;
  fallbackCredentialId: string;
  connectorIds: string[];
  enabled: boolean;
}

function draftOf(agent: AgentLookup | null, defaultRoleId: string): AgentDraft {
  return {
    name: agent?.name ?? '',
    roleId: agent?.roleId ?? defaultRoleId,
    runtime: agent?.runtime ?? 'claude_code',
    model: agent?.model ?? '',
    instructions: agent?.instructions ?? '',
    assignPolicy: agent?.assignPolicy ?? 'project_members',
    maxRunMinutes: String(agent?.maxRunMinutes ?? 30),
    maxTurns: String(agent?.maxTurns ?? 60),
    maxBudgetUsd: agent?.maxBudgetUsd != null ? String(agent.maxBudgetUsd) : '',
    concurrency: String(agent?.concurrency ?? 1),
    credentialId: agent?.credentialId ?? '',
    fallbackCredentialId: agent?.fallbackCredentialId ?? '',
    connectorIds: agent?.connectorIds ?? [],
    enabled: agent?.enabled ?? true,
  };
}

/** Number fields are typed, so an empty box must not become NaN in the payload. */
function num(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function AgentDialog({ open, onClose, agent, roles, credentials }: {
  open: boolean; onClose: () => void; agent: AgentLookup | null;
  roles: RoleRow[]; credentials: CredentialView[];
}) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const connectorsQ = useMcpConnectors(can('integrations.manage'));
  const connectors = connectorsQ.data ?? [];
  const defaultRoleId = roles.find((r) => r.key === 'agent')?.id ?? roles[0]?.id ?? '';
  const [draft, setDraft] = useState<AgentDraft>(() => draftOf(agent, defaultRoleId));

  useEffect(() => { if (open) setDraft(draftOf(agent, defaultRoleId)); }, [open, agent, defaultRoleId]);

  const set = <K extends keyof AgentDraft>(key: K, value: AgentDraft[K]) => setDraft((d) => ({ ...d, [key]: value }));

  const payload = () => ({
    name: draft.name.trim(),
    roleId: draft.roleId || undefined,
    runtime: draft.runtime,
    model: draft.model.trim() || null,
    instructions: draft.instructions,
    completionCategory: 'in_review' as const,
    assignPolicy: draft.assignPolicy,
    maxRunMinutes: num(draft.maxRunMinutes, 30),
    maxTurns: num(draft.maxTurns, 60),
    maxBudgetUsd: draft.maxBudgetUsd.trim() === '' ? null : Number(draft.maxBudgetUsd),
    concurrency: num(draft.concurrency, 1),
    credentialId: draft.credentialId || null,
    fallbackCredentialId: draft.fallbackCredentialId || null,
    connectorIds: draft.connectorIds,
    enabled: draft.enabled,
  });

  const save = useMutation({
    mutationFn: () => (agent
      ? api.patch(`/agents/${agent.id}`, { ...payload(), version: agent.version })
      : api.post('/agents', payload())),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['users-lookup'] });
      toast(agent ? t('agents.updated') : t('agents.created'));
      onClose();
    },
    onError: (e) => toast.error(errMessage(e, t('agents.saveFailed'))),
  });

  // The env credential cannot be picked explicitly: it is the fallback the API
  // resolves on its own when no slot is set.
  const pickable = credentials.filter((c) => !c.fromEnv && c.status !== 'revoked');
  const toggleConnector = (id: string) => set(
    'connectorIds',
    draft.connectorIds.includes(id) ? draft.connectorIds.filter((c) => c !== id) : [...draft.connectorIds, id],
  );

  return (
    <Dialog open={open} onClose={onClose} title={agent ? t('agents.editTitle') : t('agents.newTitle')} width={560}>
      <form
        className="max-h-[68vh] space-y-3 overflow-y-auto p-4"
        onSubmit={(e) => { e.preventDefault(); if (draft.name.trim() && !save.isPending) save.mutate(); }}
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label={t('settings.name')}>
            <Input value={draft.name} onChange={(e) => set('name', e.target.value)} placeholder="Ada" autoFocus />
          </Field>
          <Field label={t('settings.role')}>
            <Select value={draft.roleId} onChange={(e) => set('roleId', e.target.value)} className="w-full">
              {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
            </Select>
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agents.runtime')}>
            <Select value={draft.runtime} onChange={(e) => set('runtime', e.target.value)} className="w-full">
              {AGENT_RUNTIMES.map((r) => {
                const executable = (EXECUTABLE_AGENT_RUNTIMES as readonly string[]).includes(r);
                return (
                  <option key={r} value={r} disabled={!executable}>
                    {t(`agents.runtime.${r}`)}{executable ? '' : ` – ${t('agents.comingSoon')}`}
                  </option>
                );
              })}
            </Select>
          </Field>
          <Field label={t('agents.model')}>
            <Input value={draft.model} onChange={(e) => set('model', e.target.value)} placeholder="claude-sonnet-4-5" />
          </Field>
        </div>
        <p className="-mt-1 text-[11px] text-faint">{t('agents.modelHint')}</p>

        <Field label={t('agents.instructions')}>
          <Textarea
            rows={5}
            value={draft.instructions}
            onChange={(e) => set('instructions', e.target.value)}
            placeholder={t('agents.instructionsPlaceholder')}
          />
        </Field>

        <Field label={t('agents.assignPolicy')}>
          <Select value={draft.assignPolicy} onChange={(e) => set('assignPolicy', e.target.value)} className="w-full">
            {AGENT_ASSIGN_POLICIES.map((p) => <option key={p} value={p}>{t(`agents.policy.${p}`)}</option>)}
          </Select>
        </Field>
        <p className="-mt-1 text-[11px] text-faint">{t(`agents.policyHint.${draft.assignPolicy}`)}</p>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agents.maxRunMinutes')}>
            <Input type="number" min={1} max={1440} value={draft.maxRunMinutes} onChange={(e) => set('maxRunMinutes', e.target.value)} />
          </Field>
          <Field label={t('agents.maxTurns')}>
            <Input type="number" min={1} max={1000} value={draft.maxTurns} onChange={(e) => set('maxTurns', e.target.value)} />
          </Field>
          <Field label={t('agents.maxBudget')}>
            <Input type="number" min={0} step="0.5" value={draft.maxBudgetUsd} onChange={(e) => set('maxBudgetUsd', e.target.value)} placeholder="–" />
          </Field>
          <Field label={t('agents.concurrency')}>
            <Input type="number" min={1} max={10} value={draft.concurrency} onChange={(e) => set('concurrency', e.target.value)} />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label={t('agents.credential')}>
            <Select value={draft.credentialId} onChange={(e) => set('credentialId', e.target.value)} className="w-full">
              <option value="">{t('agents.workspaceDefault')}</option>
              {pickable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
          <Field label={t('agents.fallbackCredential')}>
            <Select value={draft.fallbackCredentialId} onChange={(e) => set('fallbackCredentialId', e.target.value)} className="w-full">
              <option value="">{t('agents.workspaceDefault')}</option>
              {pickable.map((c) => <option key={c.id} value={c.id}>{c.label}</option>)}
            </Select>
          </Field>
        </div>

        <div>
          <div className="mb-1 text-xs font-medium text-muted-foreground">{t('agents.connectors')}</div>
          <p className="mb-1.5 text-[11px] text-faint">{t('agents.connectorsHint')}</p>
          <div className="grid max-h-40 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
            {/* The built-in ordi server is how the agent reads and answers the
                task at all, so it is always attached and cannot be unticked. */}
            <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('agents.builtinConnectorHint')}>
              <Checkbox checked disabled />
              <span className="truncate">{t('agents.builtinConnector')}</span>
            </label>
            {connectors.map((c) => (
              <label key={c.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                <Checkbox checked={draft.connectorIds.includes(c.id)} onChange={() => toggleConnector(c.id)} />
                <span className="truncate">{c.name}</span>
              </label>
            ))}
          </div>
          {!can('integrations.manage')
            ? <p className="mt-1 text-[11px] text-faint">{t('agents.connectorsNoAccess')}</p>
            : connectors.length === 0 ? <p className="mt-1 text-[11px] text-faint">{t('agents.connectorsEmpty')}</p> : null}
        </div>

        <div className="flex items-center justify-between gap-4 border-t border-border pt-3">
          <div className="min-w-0">
            <div className="text-[13px] font-medium">{t('agents.agentEnabled')}</div>
            <div className="mt-0.5 text-xs text-muted-foreground">{t('agents.agentEnabledHint')}</div>
          </div>
          <Switch checked={draft.enabled} onChange={(v) => set('enabled', v)} label={t('agents.agentEnabled')} />
        </div>

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="submit" size="sm" disabled={!draft.name.trim() || save.isPending}>
            {save.isPending ? <Spinner /> : <Bot size={14} />} {agent ? t('common.save') : t('common.create')}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ────────────────────────────── Panel ────────────────────────────── */

export function AgentsPanel() {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const usersQ = useUsersLookup();
  const agentsQ = useAgents();
  const rolesQ = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: RoleRow[] }>('/roles') });
  const credsQ = useQuery({
    queryKey: ['agent-credentials'],
    queryFn: () => api.get<{ data: CredentialView[] }>('/agent-credentials').then((r) => r.data),
  });
  const overviewQ = useQuery({
    queryKey: ['agents-overview'],
    queryFn: () => api.get<OverviewResponse>('/agents/overview'),
    refetchInterval: 30_000,
  });

  const [credOpen, setCredOpen] = useState(false);
  const [editing, setEditing] = useState<AgentLookup | null>(null);
  const [agentOpen, setAgentOpen] = useState(false);

  const setActive = useMutation({
    mutationFn: ({ id, enable }: { id: string; enable: boolean }) => api.post(`/agents/${id}/${enable ? 'enable' : 'disable'}`, {}),
    onSuccess: (_r, v) => {
      qc.invalidateQueries({ queryKey: ['agents'] });
      qc.invalidateQueries({ queryKey: ['users'] });
      toast(v.enable ? t('agents.enabledToast') : t('agents.disabledToast'));
    },
    onError: (e) => toast.error(errMessage(e, t('settings.saveFailed'))),
  });

  const credentials = credsQ.data ?? [];
  const agents = agentsQ.data ?? [];
  const roles = rolesQ.data?.data ?? [];
  const overview = overviewQ.data;
  const users = usersQ.data ?? [];
  const connectorsQ = useMcpConnectors(can('integrations.manage'));
  const connectorName = useMemo(
    () => new Map((connectorsQ.data ?? []).map((c) => [c.id, c.name])),
    [connectorsQ.data],
  );

  const openAgent = (agent: AgentLookup | null) => { setEditing(agent); setAgentOpen(true); };

  return (
    <div>
      <SectionHead title={t('settings.agents')} desc={t('agents.desc')} />

      {/* ── Claude connection ── */}
      <div className="mb-2 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('agents.connection')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('agents.connectionDesc')}</p>
        </div>
        <Button size="sm" variant="outline" onClick={() => setCredOpen(true)}><Plus size={14} /> {t('agents.addCredential')}</Button>
      </div>

      {credsQ.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-20 w-full" />)}</div>
      ) : credentials.length === 0 ? (
        <EmptyState icon={<KeyRound size={18} />} title={t('agents.noCredentials')} hint={t('agents.noCredentialsHint')} />
      ) : (
        <div className="space-y-2">
          {credentials.map((c) => <CredentialCard key={c.id} cred={c} users={users} />)}
        </div>
      )}

      {/* ── Agents ── */}
      <div className="mb-2 mt-8 flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('agents.list')}</div>
          <p className="mt-0.5 text-xs text-muted-foreground">{t('agents.listDesc')}</p>
        </div>
        <Button size="sm" onClick={() => openAgent(null)}><Plus size={14} /> {t('agents.new')}</Button>
      </div>

      {agentsQ.isLoading ? (
        <div className="space-y-2">{[0, 1].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : agents.length === 0 ? (
        <EmptyState icon={<Bot size={18} />} title={t('agents.none')} hint={t('agents.noneHint')} />
      ) : (
        <RowList>
          {agents.map((a, i) => (
            <AnimatedRow key={a.id} index={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <Avatar name={a.name} src={a.avatar} size={28} agent />
              <button
                type="button"
                onClick={() => openAgent(a)}
                className="min-w-0 flex-1 text-left"
              >
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{a.name}</span>
                  <Badge>{t(`agents.runtime.${a.runtime}`, a.runtime)}</Badge>
                </div>
                <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-faint">
                  <span>{a.roleName || '–'}</span>
                  <span>· {t(`agents.policy.${a.assignPolicy}`, a.assignPolicy)}</span>
                  <span>· {fill(t('agents.connectorsCount'), { n: a.connectorIds.length })}</span>
                  <span>· {fill(t('agents.projectsCount'), { n: a.projectIds.length })}</span>
                  {a.connectorIds.length > 0 && connectorName.size > 0 && (
                    <span className="truncate">
                      · {a.connectorIds.map((id) => connectorName.get(id)).filter(Boolean).join(', ')}
                    </span>
                  )}
                </div>
              </button>
              <StatusChip tone={!a.enabled || !a.isActive ? 'off' : a.dispatchable ? 'ok' : 'muted'}>
                {!a.enabled || !a.isActive ? t('agents.stateDisabled') : a.dispatchable ? t('agents.ready') : t('agents.needsCredential')}
              </StatusChip>
              <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
                <MenuItem icon={<Bot size={14} />} onSelect={() => openAgent(a)}>{t('common.edit')}</MenuItem>
                {a.enabled && a.isActive
                  ? <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setActive.mutate({ id: a.id, enable: false })}>{t('agents.disable')}</MenuItem>
                  : <MenuItem icon={<RotateCcw size={14} />} onSelect={() => setActive.mutate({ id: a.id, enable: true })}>{t('agents.enable')}</MenuItem>}
              </DropdownMenu>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      {/* ── Workers ── */}
      <div className="mb-2 mt-8">
        <div className="text-[11px] font-semibold uppercase tracking-wider text-faint">{t('agents.workers')}</div>
        <p className="mt-0.5 text-xs text-muted-foreground">{t('agents.workersDesc')}</p>
      </div>

      {overviewQ.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : overview ? (
        <Card className="p-4">
          {!overview.workerEnabled && (
            <p className="mb-3 rounded-md border border-warning/40 bg-warning/5 p-2.5 text-xs text-warning">{t('agents.workerDisabled')}</p>
          )}
          <div className="flex flex-wrap gap-2">
            {overview.runtimes.map((r) => (
              <span key={r.key} className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs">
                <Cpu size={13} className="text-muted-foreground" />
                {t(`agents.runtime.${r.key}`, r.key)}
                {r.available
                  ? <Badge className={r.installed ? 'bg-success/10 text-success' : 'bg-muted text-muted-foreground'}>
                      {r.installed ? t('agents.runtimeInstalled') : t('agents.runtimeMissing')}
                    </Badge>
                  : <Badge>{t('agents.comingSoon')}</Badge>}
              </span>
            ))}
          </div>

          {overview.workers.length === 0 ? (
            <p className="mt-3 text-xs text-muted-foreground">{t('agents.noWorkers')}</p>
          ) : (
            <RowList className="mt-3">
              {overview.workers.map((w) => (
                <div key={w.id} className="flex items-center gap-3 border-b border-border px-3 py-2 last:border-0">
                  <Server size={14} className="shrink-0 text-muted-foreground" />
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-[11px]">{w.id}</div>
                    <div className="text-[11px] text-faint">
                      {fill(t('agents.workerRunning'), { running: w.running, concurrency: w.concurrency })}
                      {w.version ? ` · v${w.version}` : ''}
                      {' · '}{fill(t('agents.workerSeen'), { when: fmtRelative(w.lastSeenAt) })}
                    </div>
                  </div>
                  <StatusChip tone={w.online ? 'ok' : 'off'}>{w.online ? t('agents.workerOnline') : t('agents.workerOffline')}</StatusChip>
                </div>
              ))}
            </RowList>
          )}

          {overview.connectorCallbackUrl && (
            <p className="mt-3 truncate text-[11px] text-faint">
              {t('agents.callbackUrl')}: <span className="font-mono">{overview.connectorCallbackUrl}</span>
            </p>
          )}
        </Card>
      ) : null}

      <AddCredentialDialog open={credOpen} onClose={() => setCredOpen(false)} />
      <AgentDialog
        open={agentOpen}
        onClose={() => setAgentOpen(false)}
        agent={editing}
        roles={roles}
        credentials={credentials}
      />
    </div>
  );
}
