import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  AGENT_ASSIGN_POLICIES, AGENT_RUNTIMES, EXECUTABLE_AGENT_RUNTIMES,
  PERMISSIONS, PERMISSION_META, type Permission,
} from '@ordi/shared';
import {
  Building2, ArrowLeftRight, Users as UsersIcon, Shield, SlidersHorizontal, Wallet, Plug,
  ScrollText, Inbox, Plus, Copy, Upload, Trash2, Lock, Globe, ImageIcon, ChevronRight,
  ChevronLeft, MoreHorizontal, Check, RotateCcw, Boxes, Receipt, FolderKanban, Bot, CalendarClock,
  KeyRound, Sun, Plug2,
} from 'lucide-react';
import { api, qs, ApiError } from '../lib/api';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { WORKSPACE_CURRENCIES, currencyOptions } from '../lib/currency';
import {
  Button, Input, Select, Card, Badge, Checkbox, PageBody, Breadcrumbs, EmptyState, Skeleton, Switch, Avatar, Spinner, cn,
} from '../components/ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../components/overlays';
import { ImportExportPanel } from '../components/ImportExportPanel';
import { IntegrationsPanel } from '../components/settings/IntegrationsPanel';
import { McpPanel } from '../components/settings/McpPanel';
import { AgentsPanel } from '../components/settings/AgentsPanel';
import { McpConnectorsPanel } from '../components/settings/McpConnectorsPanel';
import { InvoicesPanel } from '../components/settings/InvoicesPanel';
import { ModulesPanel } from '../components/settings/ModulesPanel';
import { ChartOfAccountsBlock, ExpenseCategoriesBlock } from '../components/finance/accounts';
import { ProjectTypesPanel } from '../components/settings/ProjectTypesPanel';
import { LeaveTypesPanel } from '../components/settings/LeaveTypesPanel';
import { HolidaysPanel } from '../components/settings/HolidaysPanel';
import { CustomFieldsPanel } from '../components/settings/CustomFieldsPanel';
import { FieldGroupMatrix } from '../components/settings/FieldGroupMatrix';
import { SectionHead, SettingRow, Field, RowList, AnimatedRow } from '../components/settings/primitives';
import { downscaleImage } from '../components/settings/image';
import { useMcpConnectors } from '../lib/queries';
import { usePageTitle } from '../lib/tabs';
import { useT } from '../lib/i18n';
import { extendDict } from '../lib/i18n';
import { APP_VERSION, compareVersions, isVersion } from '../lib/version';

extendDict({
  en: {
    'settings.subtitle': 'Manage your workspace, members and configuration',
    'settings.groupGeneral': 'General',
    'settings.groupMembers': 'Members',
    'settings.groupConfig': 'Configuration',
    'settings.groupSystem': 'System',
    'settings.groupAgents': 'AI agents',
    'settings.agents': 'Agents',
    'settings.connectors': 'Connectors',
    'settings.agentBadge': 'Agent',
    'settings.isAgent': 'This is an AI agent',
    'settings.isAgentHint': 'It joins as a member without a password and works through Claude Code.',
    'settings.agentCreated': 'Agent created',
    'settings.agentCreateFailed': 'Could not create the agent',
    'settings.createAgent': 'Create agent',
    'settings.workspaceDesc': 'Your workspace identity and defaults.',
    'settings.logo': 'Logo',
    'settings.logoHint': 'Square image, at least 128×128. PNG or WebP.',
    'settings.upload': 'Upload',
    'settings.remove': 'Remove',
    'settings.dropImage': 'Drop image here',
    'settings.logoTooLarge': 'Image too large after processing – try a simpler image.',
    'settings.logoInvalid': "Couldn't read that image.",
    'settings.logoUpdated': 'Logo updated',
    'settings.workingDays': 'Working days',
    'settings.defaultBillable': 'Default billable',
    'settings.defaultBillableHint': 'New tasks are billable by default.',
    'settings.estimateUnit': 'Estimate unit',
    'settings.usersDesc': 'People with access to this workspace.',
    'settings.rolesDesc': 'Define what each role can do.',
    'settings.financeDesc': 'Tax rates and finance defaults.',
    'settings.integrationsDesc': 'Connect GitHub and Slack, and send outgoing webhooks.',
    'settings.auditDesc': 'Immutable record of changes across the workspace.',
    'settings.eventsDesc': 'Failed background events awaiting replay.',
    'settings.importExportDesc': 'Bulk import and export via CSV.',
    'settings.name': 'Full name',
    'settings.deactivate': 'Deactivate',
    'settings.reactivate': 'Reactivate',
    'settings.deactivated': 'Deactivated',
    'settings.userDeactivated': 'User deactivated',
    'settings.userReactivated': 'User reactivated',
    'settings.deactivateTitle': 'Deactivate user',
    'settings.deactivateBody': 'They will be signed out everywhere and their API tokens revoked. Open tasks assigned to them need a new owner.',
    'settings.openTasksNone': 'No open tasks assigned – nothing to hand over.',
    'settings.openTasksCount': 'Open tasks assigned',
    'settings.handOffTo': 'Hand open tasks to',
    'settings.leaveUnassigned': 'Leave unassigned',
    'settings.handedOff': 'Tasks handed over',
    'settings.roleUpdated': 'Role updated',
    'settings.inviteSent': 'Invitation created',
    'settings.inviteCopyHint': 'Share this link so they can set up their account.',
    'settings.inviteEmailFailed': 'The invite was created, but the email could not be sent. Share this link instead, and check your SMTP settings.',
    'settings.inviteNoEmail': 'Invite created – email not sent',
    'settings.pending': 'Pending',
    'settings.copyInviteLink': 'Copy invite link',
    'settings.resendInvite': 'Resend invite',
    'settings.revokeInvite': 'Revoke invite',
    'settings.inviteResent': 'Invitation sent again',
    'settings.inviteRevoked': 'Invitation revoked',
    'settings.resetPassword': 'Reset password',
    'settings.resetPasswordSent': 'Reset link sent',
    'settings.resetPasswordNoEmail': 'Reset link created – email not sent',
    'settings.resetPasswordCopyHint': 'Share this link so {name} can choose a new password. It works once and expires in an hour.',
    'settings.resetPasswordEmailFailed': 'The reset link was created, but the email could not be sent. Share this link instead, and check your SMTP settings.',
    'settings.newVersion': '{version} is available',
    'settings.noUsers': 'No members yet',
    'settings.permissions': 'Permissions',
    'settings.systemRoleLocked': 'System role – permissions are fixed.',
    'settings.deleteRole': 'Delete role',
    'settings.deleteRoleConfirm': 'Delete this role? Members will need a new role assigned.',
    'settings.backToRoles': 'All roles',
    'settings.member': 'member',
    'settings.members': 'members',
    'settings.invoices': 'Invoices',
    'settings.saveFailed': 'Could not save changes',
    'settings.conflict': 'Someone else made changes – reloaded latest.',
    'settings.unit.hours': 'hours',
    'settings.unit.points': 'points',
    'settings.unit.days': 'days',
  },
  uk: {
    'settings.subtitle': 'Керуйте робочим простором, учасниками та налаштуваннями',
    'settings.groupGeneral': 'Загальні',
    'settings.groupMembers': 'Учасники',
    'settings.groupConfig': 'Налаштування',
    'settings.groupSystem': 'Система',
    'settings.groupAgents': 'AI-агенти',
    'settings.agents': 'Агенти',
    'settings.connectors': 'Конектори',
    'settings.agentBadge': 'Агент',
    'settings.isAgent': 'Це AI-агент',
    'settings.isAgentHint': 'Він приєднається як учасник без пароля і працюватиме через Claude Code.',
    'settings.agentCreated': 'Агента створено',
    'settings.agentCreateFailed': 'Не вдалося створити агента',
    'settings.createAgent': 'Створити агента',
    'settings.workspaceDesc': 'Ідентичність робочого простору та типові значення.',
    'settings.logo': 'Логотип',
    'settings.logoHint': 'Квадратне зображення, щонайменше 128×128. PNG або WebP.',
    'settings.upload': 'Завантажити',
    'settings.remove': 'Видалити',
    'settings.dropImage': 'Перетягніть зображення сюди',
    'settings.logoTooLarge': 'Зображення завелике після обробки – оберіть простіше.',
    'settings.logoInvalid': 'Не вдалося прочитати зображення.',
    'settings.logoUpdated': 'Логотип оновлено',
    'settings.workingDays': 'Робочі дні',
    'settings.defaultBillable': 'Оплачувані за замовчуванням',
    'settings.defaultBillableHint': 'Нові задачі є оплачуваними за замовчуванням.',
    'settings.estimateUnit': 'Одиниця оцінки',
    'settings.usersDesc': 'Люди з доступом до цього робочого простору.',
    'settings.rolesDesc': 'Визначте, що може робити кожна роль.',
    'settings.financeDesc': 'Податкові ставки та фінансові налаштування.',
    'settings.integrationsDesc': 'Підключіть GitHub і Slack та надсилайте вихідні вебхуки.',
    'settings.auditDesc': 'Незмінний запис змін у робочому просторі.',
    'settings.eventsDesc': 'Невдалі фонові події, що очікують повтору.',
    'settings.importExportDesc': 'Масовий імпорт та експорт через CSV.',
    'settings.name': "Повне ім'я",
    'settings.deactivate': 'Деактивувати',
    'settings.reactivate': 'Активувати',
    'settings.deactivated': 'Деактивовано',
    'settings.userDeactivated': 'Користувача деактивовано',
    'settings.userReactivated': 'Користувача активовано',
    'settings.deactivateTitle': 'Деактивувати користувача',
    'settings.deactivateBody': 'Його сесії завершаться, API-токени буде відкликано. Відкриті задачі, призначені на нього, потрібно комусь передати.',
    'settings.openTasksNone': 'Відкритих задач немає, передавати нічого.',
    'settings.openTasksCount': 'Відкритих задач',
    'settings.handOffTo': 'Передати відкриті задачі',
    'settings.leaveUnassigned': 'Залишити без виконавця',
    'settings.handedOff': 'Задачі передано',
    'settings.roleUpdated': 'Роль оновлено',
    'settings.inviteSent': 'Запрошення створено',
    'settings.inviteCopyHint': 'Надішліть це посилання, щоб вони налаштували обліковий запис.',
    'settings.inviteEmailFailed': 'Запрошення створено, але лист не вдалося надіслати. Передайте це посилання вручну і перевірте налаштування SMTP.',
    'settings.inviteNoEmail': 'Запрошення створено – лист не надіслано',
    'settings.pending': 'Очікує',
    'settings.copyInviteLink': 'Скопіювати посилання',
    'settings.resendInvite': 'Надіслати ще раз',
    'settings.revokeInvite': 'Скасувати запрошення',
    'settings.inviteResent': 'Запрошення надіслано ще раз',
    'settings.inviteRevoked': 'Запрошення скасовано',
    'settings.resetPassword': 'Скинути пароль',
    'settings.resetPasswordSent': 'Посилання надіслано',
    'settings.resetPasswordNoEmail': 'Посилання створено – лист не надіслано',
    'settings.resetPasswordCopyHint': 'Надішліть це посилання, щоб {name} задав(ла) новий пароль. Воно одноразове і діє годину.',
    'settings.resetPasswordEmailFailed': 'Посилання створено, але лист не вдалося надіслати. Передайте його вручну і перевірте налаштування SMTP.',
    'settings.newVersion': 'Доступна {version}',
    'settings.noUsers': 'Ще немає учасників',
    'settings.permissions': 'Дозволи',
    'settings.systemRoleLocked': 'Системна роль – дозволи незмінні.',
    'settings.deleteRole': 'Видалити роль',
    'settings.deleteRoleConfirm': 'Видалити цю роль? Учасникам знадобиться нова роль.',
    'settings.backToRoles': 'Усі ролі',
    'settings.member': 'учасник',
    'settings.members': 'учасників',
    'settings.invoices': 'Рахунки',
    'settings.saveFailed': 'Не вдалося зберегти зміни',
    'settings.conflict': 'Хтось інший вніс зміни – завантажено найновіше.',
    // Permission catalog (labels come from the shared package in English).
    'perm.crm.read': 'Перегляд компаній і контактів',
    'perm.crm.write': 'Створення/редагування компаній і контактів',
    'perm.crm.delete': 'Видалення записів CRM',
    'perm.crm.export': 'Експорт даних CRM',
    'perm.deals.read': 'Перегляд угод',
    'perm.deals.write': 'Створення/редагування угод',
    'perm.deals.delete': 'Видалення угод',
    'perm.projects.read': 'Перегляд проєктів воркспейсу',
    'perm.projects.create': 'Створення проєктів',
    'perm.projects.write': 'Керування налаштуваннями проєкту (як адмін проєкту)',
    'perm.projects.delete': 'Видалення проєктів',
    'perm.projects.export': 'Експорт даних проєкту',
    'perm.kb.read': 'Перегляд бази знань',
    'perm.kb.write': 'Створення/редагування сторінок',
    'perm.kb.manage_spaces': 'Створення/видалення просторів воркспейсу',
    'perm.time.track': 'Трекінг власного часу',
    'perm.time.read_all': 'Перегляд часу всіх',
    'perm.time.manage': 'Редагування чужого часу та ставок',
    'perm.finance.read': 'Перегляд рахунків, кошторисів, дебіторки',
    'perm.finance.write': 'Створення/редагування фінансових документів',
    'perm.finance.send': 'Надсилання документів',
    'perm.finance.payments': 'Фіксація платежів',
    'perm.finance.delete': 'Видалення фінансових документів',
    'perm.finance.settings': 'Нумерація, податки, нагадування',
    'perm.finance.export': 'Експорт фінансових даних',
    'perm.finance.read_costs': 'Перегляд витрат і прибутковості',
    'perm.people.read': 'Перегляд співробітників та структури',
    'perm.people.read_sensitive': 'Перегляд чутливих полів',
    'perm.people.read_compensation': 'Перегляд компенсацій (найвужчий)',
    'perm.people.write': 'Редагування співробітників та життєвого циклу',
    'perm.people.manage_leave': 'Керування типами відпусток/квотами/календарями',
    'perm.people.approve_leave': 'Погодження відпусток поза лінією менеджера',
    'perm.people.recruit': 'Вакансії, кандидати, співбесіди',
    'perm.integrations.manage': 'Керування git та вебхуками',
    'perm.settings.manage': 'Налаштування воркспейсу, шаблони, кастомні поля',
    'perm.users.manage': 'Запрошення/керування користувачами',
    'perm.roles.manage': 'Керування ролями',
    'perm.audit.read': 'Перегляд журналу аудиту',
    'permdomain.crm': 'CRM',
    'permdomain.deals': 'Угоди',
    'permdomain.projects': 'Проєкти',
    'permdomain.kb': 'База знань',
    'permdomain.time': 'Час',
    'permdomain.finance': 'Фінанси',
    'permdomain.people': 'Люди',
    'permdomain.integrations': 'Інтеграції',
    'permdomain.settings': 'Налаштування',
    'settings.unit.hours': 'години',
    'settings.unit.points': 'бали',
    'settings.unit.days': 'дні',
    'settings.day.1': 'Пн',
    'settings.day.2': 'Вт',
    'settings.day.3': 'Ср',
    'settings.day.4': 'Чт',
    'settings.day.5': 'Пт',
    'settings.day.6': 'Сб',
    'settings.day.7': 'Нд',
  },
});

interface NavItem { id: string; label: string; perm?: string; icon: React.ComponentType<{ size?: number }> }
interface NavGroup { label: string; items: NavItem[] }

const GROUPS: NavGroup[] = [
  {
    label: 'settings.groupGeneral',
    items: [
      { id: 'workspace', label: 'dashboards.workspace', perm: 'settings.manage', icon: Building2 },
      { id: 'import-export', label: 'settings.importExport', perm: 'settings.manage', icon: ArrowLeftRight },
    ],
  },
  {
    label: 'settings.groupMembers',
    items: [
      { id: 'users', label: 'settings.users', perm: 'users.manage', icon: UsersIcon },
      { id: 'roles', label: 'settings.roles', perm: 'roles.manage', icon: Shield },
    ],
  },
  {
    label: 'settings.groupConfig',
    items: [
      { id: 'modules', label: 'settings.modules', perm: 'settings.manage', icon: Boxes },
      { id: 'project-types', label: 'settings.projectTypes', perm: 'settings.manage', icon: FolderKanban },
      { id: 'leave-types', label: 'settings.leaveTypes', perm: 'people.manage_leave', icon: CalendarClock },
      { id: 'holidays', label: 'settings.holidays', perm: 'people.manage_leave', icon: Sun },
      { id: 'custom-fields', label: 'settings.customFields', perm: 'settings.manage', icon: SlidersHorizontal },
      { id: 'finance', label: 'nav.finance', perm: 'finance.settings', icon: Wallet },
      { id: 'invoices', label: 'settings.invoices', perm: 'finance.settings', icon: Receipt },
      { id: 'integrations', label: 'settings.integrations', perm: 'integrations.manage', icon: Plug },
      // Personal MCP/API tokens – available to every authenticated user, no perm gate.
      { id: 'mcp', label: 'settings.mcp', icon: Bot },
    ],
  },
  {
    label: 'settings.groupAgents',
    items: [
      { id: 'agents', label: 'settings.agents', perm: 'agents.manage', icon: Bot },
      { id: 'connectors', label: 'settings.connectors', perm: 'integrations.manage', icon: Plug2 },
    ],
  },
  {
    label: 'settings.groupSystem',
    items: [
      { id: 'audit', label: 'settings.auditLog', perm: 'audit.read', icon: ScrollText },
      { id: 'events', label: 'settings.eventQueue', perm: 'audit.read', icon: Inbox },
    ],
  },
];

/**
 * "ordi vX.Y.Z" under the settings nav, and – for people who can update the
 * instance – a link when a newer release exists. The GitHub check is
 * best-effort: air-gapped installs simply never see the link.
 */
function VersionFooter() {
  const t = useT();
  const can = useCan();
  const latest = useQuery({
    queryKey: ['latest-release'],
    queryFn: async () => {
      const res = await fetch('https://api.github.com/repos/romirom11/ordi/releases/latest');
      if (!res.ok) return null;
      const body = await res.json() as { tag_name?: string; html_url?: string };
      const version = (body.tag_name ?? '').replace(/^v/, '');
      return isVersion(version) ? { version, url: body.html_url ?? 'https://github.com/romirom11/ordi/releases/latest' } : null;
    },
    enabled: can('settings.manage'),
    staleTime: 6 * 3600_000,
    retry: false,
  });

  const newer = latest.data && compareVersions(latest.data.version, APP_VERSION) > 0 ? latest.data : null;
  return (
    <div className="mt-6 space-y-0.5 px-2 text-[11px] text-faint">
      <div>ordi v{APP_VERSION}</div>
      {newer && (
        <a href={newer.url} target="_blank" rel="noreferrer" className="block text-primary hover:underline">
          {t('settings.newVersion').replace('{version}', `v${newer.version}`)}
        </a>
      )}
    </div>
  );
}

export function SettingsPage({ section }: { section?: string }) {
  const t = useT();
  const can = useCan();
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => !n.perm || can(n.perm)) })).filter((g) => g.items.length > 0);
  const flat = groups.flatMap((g) => g.items);
  const requested = section ?? 'workspace';
  const active = flat.find((i) => i.id === requested) ?? flat[0];
  // PageHeader used to name the tab; the slim trail bar does it explicitly now.
  usePageTitle(active ? `${t('nav.settings')} · ${t(active.label)}` : t('nav.settings'));

  if (!active) {
    return <EmptyState title={t('settings.noneAvailable')} hint={t('settings.noneAvailableHint')} />;
  }

  return (
    <div className="flex flex-col">
      {/* Slim trail only – each panel carries its own heading and description. */}
      <div className="flex h-11 shrink-0 items-center border-b border-border px-4">
        <Breadcrumbs items={[{ label: t('nav.settings'), to: '/settings' }, { label: t(active.label) }]} />
      </div>
      <div className="flex min-h-[calc(100vh-53px)]">
        <aside className="w-52 shrink-0 border-r border-border p-3">
          <nav className="space-y-4">
            {groups.map((g) => (
              <div key={g.label}>
                <div className="px-2 pb-1 text-[10px] font-semibold uppercase tracking-wider text-faint">{t(g.label)}</div>
                <div className="space-y-0.5">
                  {g.items.map((i) => {
                    const Icon = i.icon;
                    const isActive = i.id === active.id;
                    return (
                      <Link
                        key={i.id}
                        to={`/settings/${i.id}`}
                        className={cn(
                          'flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px] transition-colors duration-150',
                          isActive ? 'bg-muted font-medium text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
                        )}
                      >
                        <Icon size={15} />
                        <span className="truncate">{t(i.label)}</span>
                      </Link>
                    );
                  })}
                </div>
              </div>
            ))}
          </nav>
          <VersionFooter />
        </aside>
        <div className="min-w-0 flex-1">
          <PageBody key={active.id} width="default" className="anim-fade-in">
            {active.id === 'workspace' && <WorkspacePanel />}
            {active.id === 'users' && <UsersPanel />}
            {active.id === 'roles' && <RolesPanel />}
            {active.id === 'modules' && <ModulesPanel />}
            {active.id === 'project-types' && <ProjectTypesPanel />}
            {active.id === 'leave-types' && <LeaveTypesPanel />}
            {active.id === 'holidays' && <HolidaysPanel />}
            {active.id === 'custom-fields' && <CustomFieldsPanel />}
            {active.id === 'finance' && <FinancePanel />}
            {active.id === 'invoices' && <InvoicesPanel />}
            {active.id === 'integrations' && <IntegrationsPanel />}
            {active.id === 'mcp' && <McpPanel />}
            {active.id === 'agents' && <AgentsPanel />}
            {active.id === 'connectors' && <McpConnectorsPanel />}
            {active.id === 'audit' && <AuditPanel />}
            {active.id === 'events' && <DlqPanel />}
            {active.id === 'import-export' && <ImportExportPanel />}
          </PageBody>
        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────── Workspace ────────────────────────────── */

const ESTIMATE_UNITS = ['hours', 'days', 'points'];
const DAY_KEYS = [1, 2, 3, 4, 5, 6, 7];
const DAY_LABELS: Record<number, string> = { 1: 'Mon', 2: 'Tue', 3: 'Wed', 4: 'Thu', 5: 'Fri', 6: 'Sat', 7: 'Sun' };

interface WorkspaceData {
  name?: string; logo?: string | null; defaultCurrency?: string; workingDays?: number[];
  defaultBillable?: boolean; defaultEstimateUnit?: string;
}

function WorkspacePanel() {
  const t = useT();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspace-settings'], queryFn: () => api.get<WorkspaceData>('/settings/workspace') });
  const fileRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);
  const [uploading, setUploading] = useState(false);

  const [name, setName] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [billable, setBillable] = useState(true);
  const [unit, setUnit] = useState('hours');

  useEffect(() => {
    if (ws.data) {
      setName(ws.data.name ?? '');
      setCurrency(ws.data.defaultCurrency ?? 'USD');
      setDays(ws.data.workingDays ?? [1, 2, 3, 4, 5]);
      setBillable(ws.data.defaultBillable ?? true);
      setUnit(ws.data.defaultEstimateUnit ?? 'hours');
    }
  }, [ws.data]);

  const patch = useMutation({
    mutationFn: (body: Partial<WorkspaceData>) => api.patch('/settings/workspace', body),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-settings'] });
      qc.invalidateQueries({ queryKey: ['workspace'] });
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const logo = ws.data?.logo ?? null;
  const dirty = !!ws.data && (
    name !== (ws.data.name ?? '') ||
    currency !== (ws.data.defaultCurrency ?? 'USD') ||
    JSON.stringify([...days].sort()) !== JSON.stringify([...(ws.data.workingDays ?? [1, 2, 3, 4, 5])].sort()) ||
    billable !== (ws.data.defaultBillable ?? true) ||
    unit !== (ws.data.defaultEstimateUnit ?? 'hours')
  );

  const saveForm = () => {
    patch.mutate(
      { name, defaultCurrency: currency, workingDays: [...days].sort((a, b) => a - b), defaultBillable: billable, defaultEstimateUnit: unit },
      { onSuccess: () => { qc.invalidateQueries({ queryKey: ['workspace-settings'] }); qc.invalidateQueries({ queryKey: ['workspace'] }); toast(t('common.saved')); } },
    );
  };

  const handleFile = async (file: File) => {
    if (!file.type.startsWith('image/')) { toast.error(t('settings.logoInvalid')); return; }
    setUploading(true);
    try {
      const { dataUrl, bytes } = await downscaleImage(file);
      if (bytes > 200 * 1024) { toast.error(t('settings.logoTooLarge')); return; }
      await patch.mutateAsync({ logo: dataUrl });
      toast(t('settings.logoUpdated'));
    } catch {
      toast.error(t('settings.logoInvalid'));
    } finally {
      setUploading(false);
    }
  };

  const toggleDay = (d: number) => setDays((prev) => prev.includes(d) ? prev.filter((x) => x !== d) : [...prev, d]);

  if (ws.isLoading) return <div className="space-y-4"><Skeleton className="h-6 w-40" /><Skeleton className="h-24 w-full" /><Skeleton className="h-40 w-full" /></div>;

  return (
    <div>
      <SectionHead title={t('dashboards.workspace')} desc={t('settings.workspaceDesc')} />

      {/* Logo */}
      <input ref={fileRef} type="file" accept="image/*" className="hidden"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) handleFile(f); e.target.value = ''; }} />
      <SettingRow label={t('settings.logo')} hint={t('settings.logoHint')}>
        <div className="flex items-center gap-3">
          <div
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => { e.preventDefault(); setDragOver(false); const f = e.dataTransfer.files?.[0]; if (f) handleFile(f); }}
            onClick={() => fileRef.current?.click()}
            className={cn(
              'grid h-14 w-14 cursor-pointer place-items-center overflow-hidden rounded-lg border border-dashed transition-colors',
              dragOver ? 'border-primary bg-primary/5' : 'border-border-strong bg-muted/40 hover:border-primary/50',
            )}
            title={t('settings.dropImage')}
          >
            {uploading ? <Spinner /> : logo ? <img src={logo} alt="" className="h-full w-full object-cover" /> : <ImageIcon size={18} className="text-faint" />}
          </div>
          <div className="flex flex-col gap-1.5">
            <Button size="xs" variant="outline" onClick={() => fileRef.current?.click()} disabled={uploading}><Upload size={13} /> {t('settings.upload')}</Button>
            {logo && <Button size="xs" variant="ghost" onClick={() => patch.mutate({ logo: null }, { onSuccess: () => { qc.invalidateQueries({ queryKey: ['workspace-settings'] }); toast(t('settings.logoUpdated')); } })} disabled={uploading}><Trash2 size={13} /> {t('settings.remove')}</Button>}
          </div>
        </div>
      </SettingRow>

      {/* Name */}
      <SettingRow label={t('common.name')}>
        <Input value={name} onChange={(e) => setName(e.target.value)} className="w-64" />
      </SettingRow>

      {/* Currency */}
      <SettingRow label={t('settings.defaultCurrency')}>
        <Select value={currency} onChange={(e) => setCurrency(e.target.value)} className="w-32">
          {currencyOptions(currency, WORKSPACE_CURRENCIES).map((c) => <option key={c} value={c}>{c}</option>)}
        </Select>
      </SettingRow>

      {/* Estimate unit */}
      <SettingRow label={t('settings.estimateUnit')}>
        <Select value={unit} onChange={(e) => setUnit(e.target.value)} className="w-32">
          {ESTIMATE_UNITS.map((u) => <option key={u} value={u}>{t(`settings.unit.${u}`, u)}</option>)}
        </Select>
      </SettingRow>

      {/* Default billable */}
      <SettingRow label={t('settings.defaultBillable')} hint={t('settings.defaultBillableHint')}>
        <Switch checked={billable} onChange={setBillable} />
      </SettingRow>

      {/* Working days */}
      <SettingRow label={t('settings.workingDays')} className="items-start">
        <div className="flex gap-1">
          {DAY_KEYS.map((d) => {
            const on = days.includes(d);
            return (
              <button
                key={d}
                type="button"
                onClick={() => toggleDay(d)}
                className={cn(
                  'h-7 w-9 rounded-md border text-xs font-medium transition-colors',
                  on ? 'border-primary bg-primary text-primary-foreground' : 'border-border text-muted-foreground hover:border-border-strong hover:text-foreground',
                )}
              >
                {t(`settings.day.${d}`, DAY_LABELS[d])}
              </button>
            );
          })}
        </div>
      </SettingRow>

      <div className="mt-5 flex h-8 items-center gap-3">
        {dirty && <Button size="sm" onClick={saveForm} disabled={patch.isPending}>{patch.isPending ? <Spinner /> : null} {t('common.save')}</Button>}
      </div>
    </div>
  );
}

/* ────────────────────────────── Users ────────────────────────────── */

interface UserRow { id: string; name?: string | null; email?: string | null; roleId?: string | null; isActive?: boolean; avatar?: string | null; actorType?: string | null }
interface PendingInvite { id: string; email: string; name?: string | null; roleId?: string | null; expiresAt?: string; inviteUrl: string }
interface Role { id: string; key?: string; name: string; isSystem?: boolean; permissions?: string[]; userCount?: number }

/**
 * "Who takes over?" before a user is switched off (ORD-20). Lists the open
 * tasks they still hold and offers a successor; the admin can also leave
 * them unassigned, but never keep them on someone who cannot sign in.
 */
function DeactivateUserDialog({ user, candidates, pending, onClose, onConfirm }: {
  user: UserRow | null; candidates: UserRow[]; pending: boolean;
  onClose: () => void; onConfirm: (reassignTo: string | null) => void;
}) {
  const t = useT();
  const [reassignTo, setReassignTo] = useState('');
  useEffect(() => { setReassignTo(''); }, [user?.id]);
  const open = useQuery({
    queryKey: ['user-open-tasks', user?.id],
    queryFn: () => api.get<{ count: number; data: { id: string; ref: string; title: string }[] }>(`/users/${user!.id}/open-tasks`),
    enabled: !!user,
  });
  const count = open.data?.count ?? 0;
  const sample = open.data?.data ?? [];

  return (
    <Dialog open={!!user} onClose={onClose} title={t('settings.deactivateTitle')} width={440}>
      <div className="space-y-3 px-4 pb-4 pt-1">
        <div className="flex items-center gap-2">
          <Avatar name={user?.name} src={user?.avatar} size={24} />
          <div className="min-w-0">
            <div className="truncate text-[13px] font-medium">{user?.name ?? '–'}</div>
            <div className="truncate text-xs text-faint">{user?.email}</div>
          </div>
        </div>
        <p className="text-[13px] text-muted-foreground">{t('settings.deactivateBody')}</p>

        {open.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : count === 0 ? (
          <p className="text-[13px] text-muted-foreground">{t('settings.openTasksNone')}</p>
        ) : (
          <>
            <div className="rounded-md border border-border bg-muted/40 px-3 py-2">
              <div className="text-xs font-medium text-muted-foreground">{t('settings.openTasksCount')}: <span className="tabular-nums text-foreground">{count}</span></div>
              <ul className="mt-1 max-h-32 space-y-0.5 overflow-y-auto text-[13px]">
                {sample.map((task) => (
                  <li key={task.id} className="truncate"><span className="font-mono text-xs text-faint">{task.ref}</span> {task.title}</li>
                ))}
                {count > sample.length && <li className="text-xs text-faint">…</li>}
              </ul>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">{t('settings.handOffTo')}</label>
              <Select value={reassignTo} onChange={(e) => setReassignTo(e.target.value)} className="w-full">
                <option value="">{t('settings.leaveUnassigned')}</option>
                {candidates.map((u) => <option key={u.id} value={u.id}>{u.name ?? u.email ?? u.id}</option>)}
              </Select>
            </div>
          </>
        )}

        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="ghost" size="sm" onClick={onClose}>{t('common.cancel')}</Button>
          <Button type="button" variant="destructive" size="sm" disabled={pending || open.isLoading} onClick={() => onConfirm(reassignTo || null)}>
            {pending && <Spinner className="h-3 w-3" />} {t('settings.deactivate')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

function UsersPanel() {
  const t = useT();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: UserRow[] }>('/users') });
  // Someone you invited exists, but is not a user yet – show them so the list
  // reflects what you just did rather than looking like nothing happened.
  const invites = useQuery({ queryKey: ['invites'], queryFn: () => api.get<{ data: PendingInvite[] }>('/users/invites') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const [inviteOpen, setInviteOpen] = useState(false);

  const changeRole = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) => api.patch(`/users/${id}/role`, { roleId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['roles'] }); toast(t('settings.roleUpdated')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  // Deactivation goes through a dialog (ORD-20): open tasks the person holds
  // are handed to a successor, or left unassigned, never orphaned on them.
  const [deactivating, setDeactivating] = useState<UserRow | null>(null);
  const setActive = useMutation({
    mutationFn: ({ id, active, reassignTo }: { id: string; active: boolean; reassignTo?: string | null }) =>
      api.post<{ handedOffTasks?: number }>(`/users/${id}/${active ? 'reactivate' : 'deactivate'}`, active ? undefined : { reassignTo: reassignTo ?? null }),
    onSuccess: (r, v) => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['tasks'] });
      qc.invalidateQueries({ queryKey: ['me-tasks'] });
      setDeactivating(null);
      if (v.active) toast(t('settings.userReactivated'));
      else toast(r?.handedOffTasks ? `${t('settings.userDeactivated')} · ${t('settings.handedOff')}: ${r.handedOffTasks}` : t('settings.userDeactivated'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  // Someone who lost their password gets a one-time link, not a password an
  // admin picked for them – the link is shown here too, because an instance
  // without SMTP configured still has to be able to hand it over.
  const [resetLink, setResetLink] = useState<{ name: string; url: string; emailSent: boolean } | null>(null);
  const resetPassword = useMutation({
    mutationFn: async (u: UserRow) => ({
      user: u,
      res: await api.post<{ resetUrl: string; emailSent?: boolean }>(`/users/${u.id}/reset-password`, {}),
    }),
    onSuccess: ({ user, res }) => {
      setResetLink({ name: user.name || user.email || '', url: res.resetUrl, emailSent: res.emailSent !== false });
      if (res.emailSent === false) toast.info(t('settings.resetPasswordNoEmail'));
      else toast(t('settings.resetPasswordSent'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const revoke = useMutation({
    mutationFn: (id: string) => api.del(`/users/invites/${id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['invites'] }); toast(t('settings.inviteRevoked')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const resend = useMutation({
    mutationFn: (id: string) => api.post<{ emailSent?: boolean }>(`/users/invites/${id}/resend`, {}),
    onSuccess: (r) => {
      qc.invalidateQueries({ queryKey: ['invites'] });
      toast(r?.emailSent === false ? t('settings.inviteNoEmail') : t('settings.inviteResent'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const roleList = roles.data?.data ?? [];
  const roleName = (id?: string | null) => roleList.find((r) => r.id === id)?.name ?? '–';
  const rows = users.data?.data ?? [];
  const pending = invites.data?.data ?? [];

  return (
    <div>
      <SectionHead title={t('settings.users')} desc={t('settings.usersDesc')}
        actions={<Button size="sm" onClick={() => setInviteOpen(true)}><Plus size={14} /> {t('settings.invite')}</Button>} />

      {users.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 && pending.length === 0 ? (
        <EmptyState icon={<UsersIcon size={18} />} title={t('settings.noUsers')} />
      ) : (
        <RowList>
          {pending.map((inv, i) => (
            <AnimatedRow key={inv.id} index={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <Avatar name={inv.name} size={28} className="opacity-60" />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium text-muted-foreground">{inv.name}</span>
                  <Badge className="bg-warning/10 text-warning">{t('settings.pending')}</Badge>
                </div>
                <div className="truncate text-xs text-faint">{inv.email}</div>
              </div>
              <span className="w-36 shrink-0 text-xs text-muted-foreground">{roleName(inv.roleId)}</span>
              <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
                <MenuItem icon={<Copy size={14} />} onSelect={() => { navigator.clipboard?.writeText(inv.inviteUrl); toast(t('common.copy')); }}>
                  {t('settings.copyInviteLink')}
                </MenuItem>
                <MenuItem icon={<RotateCcw size={14} />} onSelect={() => resend.mutate(inv.id)}>{t('settings.resendInvite')}</MenuItem>
                <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => revoke.mutate(inv.id)}>{t('settings.revokeInvite')}</MenuItem>
              </DropdownMenu>
            </AnimatedRow>
          ))}
          {rows.map((u, i) => (
            <AnimatedRow key={u.id} index={pending.length + i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <Avatar name={u.name} src={u.avatar} size={28} agent={u.actorType === 'agent'} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{u.name ?? '–'}</span>
                  {u.actorType === 'agent' && <Badge className="bg-primary/10 text-primary">{t('settings.agentBadge')}</Badge>}
                  {u.isActive === false && <Badge className="bg-destructive/10 text-destructive">{t('settings.deactivated')}</Badge>}
                </div>
                <div className="truncate text-xs text-faint">{u.email}</div>
              </div>
              <Select
                value={u.roleId ?? ''}
                onChange={(e) => changeRole.mutate({ id: u.id, roleId: e.target.value })}
                className="h-7 w-36 text-xs"
                title={roleName(u.roleId)}
              >
                {!u.roleId && <option value="">–</option>}
                {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
              <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
                {u.isActive === false ? (
                  <MenuItem icon={<RotateCcw size={14} />} onSelect={() => setActive.mutate({ id: u.id, active: true })}>{t('settings.reactivate')}</MenuItem>
                ) : (
                  <>
                    {/* Agents authenticate with API tokens – they have no password to reset. */}
                    {u.actorType !== 'agent' && (
                      <MenuItem icon={<KeyRound size={14} />} onSelect={() => resetPassword.mutate(u)}>{t('settings.resetPassword')}</MenuItem>
                    )}
                    <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setDeactivating(u)}>{t('settings.deactivate')}</MenuItem>
                  </>
                )}
              </DropdownMenu>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} roles={roleList} />
      <DeactivateUserDialog
        user={deactivating}
        candidates={rows.filter((u) => u.isActive !== false && u.id !== deactivating?.id)}
        pending={setActive.isPending}
        onClose={() => setDeactivating(null)}
        onConfirm={(reassignTo) => deactivating && setActive.mutate({ id: deactivating.id, active: false, reassignTo })}
      />

      <Dialog open={!!resetLink} onClose={() => setResetLink(null)} title={t('settings.resetPassword')} width={420}>
        <div className="space-y-3 p-4">
          <div className={cn('rounded-md border p-3', resetLink?.emailSent ? 'border-border bg-muted/50' : 'border-warning/40 bg-warning/5')}>
            <p className="mb-2 text-xs text-muted-foreground">
              {resetLink?.emailSent
                ? t('settings.resetPasswordCopyHint').replace('{name}', resetLink.name)
                : t('settings.resetPasswordEmailFailed')}
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{resetLink?.url}</span>
              <Button size="xs" variant="outline" onClick={() => { navigator.clipboard?.writeText(resetLink?.url ?? ''); toast(t('common.copy')); }}><Copy size={12} /></Button>
            </div>
          </div>
          <div className="flex justify-end pt-1">
            <Button variant="ghost" size="sm" onClick={() => setResetLink(null)}>{t('common.close')}</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const t = useT();
  const can = useCan();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [emailSent, setEmailSent] = useState(true);

  // The agent path of the same dialog (R1): same person, same permissions,
  // one switch. Creating an agent needs users.manage *and* agents.manage.
  const canCreateAgent = can('users.manage') && can('agents.manage');
  const [isAgent, setIsAgent] = useState(false);
  const [runtime, setRuntime] = useState<string>('claude_code');
  const [assignPolicy, setAssignPolicy] = useState<string>('project_members');
  const [connectorIds, setConnectorIds] = useState<string[]>([]);
  const connectorsQ = useMcpConnectors(open && isAgent && can('integrations.manage'));
  const connectors = connectorsQ.data ?? [];
  const humanRoleId = roles.find((r) => !r.isSystem)?.id ?? roles[0]?.id ?? '';
  const agentRoleId = roles.find((r) => r.key === 'agent')?.id ?? humanRoleId;

  useEffect(() => {
    if (open) {
      setEmail(''); setName(''); setRoleId(humanRoleId); setInviteUrl(null); setEmailSent(true);
      setIsAgent(false); setRuntime('claude_code'); setAssignPolicy('project_members'); setConnectorIds([]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, roles]);

  // Switching mode swaps the sensible default role, not one the admin picked.
  const toggleAgent = (on: boolean) => {
    setIsAgent(on);
    setRoleId(on ? agentRoleId : humanRoleId);
  };

  const createAgent = useMutation({
    mutationFn: () => api.post('/agents', {
      name: name.trim(),
      roleId: roleId || undefined,
      runtime,
      assignPolicy,
      connectorIds,
      enabled: true,
    }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['users-lookup'] });
      qc.invalidateQueries({ queryKey: ['agents'] });
      // The new agent may hold connectors – their "used by N agents" changes.
      qc.invalidateQueries({ queryKey: ['mcp-connectors'] });
      toast(t('settings.agentCreated'));
      onClose();
    },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('settings.agentCreateFailed')),
  });

  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl?: string; emailSent?: boolean }>('/users/invite', { email, name, roleId }),
    onSuccess: (r) => {
      setInviteUrl(r?.inviteUrl ?? null);
      setEmailSent(r?.emailSent !== false);
      qc.invalidateQueries({ queryKey: ['users'] });
      qc.invalidateQueries({ queryKey: ['invites'] });
      // The invite is valid either way; only the delivery may have failed.
      if (r?.emailSent === false) toast.info(t('settings.inviteNoEmail'));
      else toast(t('settings.inviteSent'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={isAgent ? t('settings.createAgent') : t('settings.inviteUser')} width={420}>
      <div className="space-y-3 p-4">
        {canCreateAgent && (
          <div className="flex items-center justify-between gap-4 rounded-md border border-border bg-muted/40 px-3 py-2">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[13px] font-medium"><Bot size={14} /> {t('settings.isAgent')}</div>
              <div className="mt-0.5 text-xs text-muted-foreground">{t('settings.isAgentHint')}</div>
            </div>
            <Switch checked={isAgent} onChange={toggleAgent} label={t('settings.isAgent')} />
          </div>
        )}
        <Field label={t('settings.name')}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder={isAgent ? 'Ada' : 'Jane Doe'} autoFocus /></Field>
        {!isAgent && (
          <Field label={t('auth.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" /></Field>
        )}
        <Field label={t('settings.role')}>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="w-full">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>

        {isAgent && (
          <>
            <Field label={t('agents.runtime')}>
              <Select value={runtime} onChange={(e) => setRuntime(e.target.value)} className="w-full">
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
            <Field label={t('agents.assignPolicy')}>
              <Select value={assignPolicy} onChange={(e) => setAssignPolicy(e.target.value)} className="w-full">
                {AGENT_ASSIGN_POLICIES.map((p) => <option key={p} value={p}>{t(`agents.policy.${p}`)}</option>)}
              </Select>
            </Field>
            <p className="-mt-1 text-[11px] text-faint">{t(`agents.policyHint.${assignPolicy}`)}</p>
            <div>
              <div className="mb-1 text-xs font-medium text-muted-foreground">{t('agents.connectors')}</div>
              <div className="grid max-h-32 grid-cols-2 gap-x-3 gap-y-1.5 overflow-y-auto rounded-md border border-border p-2.5">
                {/* Always attached – the agent talks to ordi through it. */}
                <label className="flex items-center gap-1.5 text-xs text-muted-foreground" title={t('agents.builtinConnectorHint')}>
                  <Checkbox checked disabled />
                  <span className="truncate">{t('agents.builtinConnector')}</span>
                </label>
                {connectors.map((c) => (
                  <label key={c.id} className="flex cursor-pointer items-center gap-1.5 text-xs">
                    <Checkbox
                      checked={connectorIds.includes(c.id)}
                      onChange={() => setConnectorIds((ids) => (ids.includes(c.id) ? ids.filter((x) => x !== c.id) : [...ids, c.id]))}
                    />
                    <span className="truncate">{c.name}</span>
                  </label>
                ))}
              </div>
              {!can('integrations.manage')
                ? <p className="mt-1 text-[11px] text-faint">{t('agents.connectorsNoAccess')}</p>
                : connectors.length === 0 ? <p className="mt-1 text-[11px] text-faint">{t('agents.connectorsEmpty')}</p> : null}
            </div>
          </>
        )}

        {inviteUrl ? (
          <div className={cn('rounded-md border p-3', emailSent ? 'border-border bg-muted/50' : 'border-warning/40 bg-warning/5')}>
            <p className="mb-2 text-xs text-muted-foreground">
              {emailSent ? t('settings.inviteCopyHint') : t('settings.inviteEmailFailed')}
            </p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{inviteUrl}</span>
              <Button size="xs" variant="outline" onClick={() => { navigator.clipboard?.writeText(inviteUrl); toast(t('common.copy')); }}><Copy size={12} /></Button>
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>{inviteUrl ? t('common.close') : t('common.cancel')}</Button>
          {!inviteUrl && (isAgent ? (
            <Button size="sm" onClick={() => createAgent.mutate()} disabled={!name || !roleId || createAgent.isPending}>
              {createAgent.isPending ? <Spinner /> : <Bot size={14} />} {t('settings.createAgent')}
            </Button>
          ) : (
            <Button size="sm" onClick={() => invite.mutate()} disabled={!email || !name || !roleId || invite.isPending}>
              {invite.isPending ? <Spinner /> : <Plus size={14} />} {t('settings.invite')}
            </Button>
          ))}
        </div>
      </div>
    </Dialog>
  );
}

/* ────────────────────────────── Roles ────────────────────────────── */

interface CatalogPerm { key: string; domain: string; label: string }

function useCatalog(): { domain: string; perms: { key: string; label: string }[] }[] {
  const t = useT();
  const catalog = useQuery({ queryKey: ['rolesCatalog'], queryFn: () => api.get<{ permissions?: CatalogPerm[] }>('/roles/catalog') });
  return useMemo(() => {
    let flat: CatalogPerm[] = catalog.data?.permissions ?? [];
    if (flat.length === 0) flat = PERMISSIONS.map((key) => ({ key, domain: PERMISSION_META[key as Permission].domain, label: PERMISSION_META[key as Permission].label }));
    const byDomain = new Map<string, { key: string; label: string }[]>();
    for (const f of flat) {
      const bucket = byDomain.get(f.domain) ?? [];
      // Localize the shared English catalog labels when a translation exists.
      bucket.push({ key: f.key, label: t(`perm.${f.key}`, f.label) });
      byDomain.set(f.domain, bucket);
    }
    return Array.from(byDomain.entries()).map(([domain, perms]) => ({ domain, perms }));
  }, [catalog.data, t]);
}

function RolesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const grouped = useCatalog();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [newRole, setNewRole] = useState('');

  const create = useMutation({
    mutationFn: () => api.post<Role>('/roles', { name: newRole.trim(), permissions: [] }),
    onSuccess: (r) => { setNewRole(''); setCreateOpen(false); qc.invalidateQueries({ queryKey: ['roles'] }); if (r?.id) setSelectedId(r.id); toast(t('common.saved')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const roleList = roles.data?.data ?? [];
  const selected = roleList.find((r) => r.id === selectedId) ?? null;

  if (selected) {
    return <RoleEditor key={selected.id} role={selected} grouped={grouped} onBack={() => setSelectedId(null)} />;
  }

  return (
    <div>
      <SectionHead title={t('settings.roles')} desc={t('settings.rolesDesc')}
        actions={<Button size="sm" onClick={() => setCreateOpen(true)}><Plus size={14} /> {t('settings.createRole')}</Button>} />

      {roles.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : (
        <RowList>
          {roleList.map((role, i) => (
            <AnimatedRow
              key={role.id}
              index={i}
              onClick={() => setSelectedId(role.id)}
              className="flex w-full cursor-pointer items-center gap-3 border-b border-border px-3 py-3 text-left transition-colors last:border-0 hover:bg-muted/50"
            >
              <div className="grid h-8 w-8 place-items-center rounded-md bg-muted text-muted-foreground">
                {role.isSystem ? <Lock size={15} /> : <Shield size={15} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{role.name}</span>
                  {role.isSystem && <Badge>{t('settings.system')}</Badge>}
                </div>
                <div className="text-xs text-faint">
                  {(role.userCount ?? 0)} {(role.userCount === 1 ? t('settings.member') : t('settings.members'))}
                  {' · '}{(role.permissions?.length ?? 0)} {t('settings.permissions').toLowerCase()}
                </div>
              </div>
              <ChevronRight size={16} className="text-faint" />
            </AnimatedRow>
          ))}
        </RowList>
      )}

      {!roles.isLoading && <FieldGroupMatrix roles={roleList} />}

      <Dialog open={createOpen} onClose={() => setCreateOpen(false)} title={t('settings.createRole')} width={380}>
        <form className="space-y-3 p-4" onSubmit={(e) => { e.preventDefault(); if (newRole.trim()) create.mutate(); }}>
          <Field label={t('settings.newRole')}><Input value={newRole} onChange={(e) => setNewRole(e.target.value)} placeholder={t('settings.roleNamePlaceholder')} autoFocus /></Field>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={() => setCreateOpen(false)}>{t('common.cancel')}</Button>
            <Button type="submit" size="sm" disabled={!newRole.trim() || create.isPending}>{t('common.create')}</Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}

function RoleEditor({ role, grouped, onBack }: { role: Role; grouped: { domain: string; perms: { key: string; label: string }[] }[]; onBack: () => void }) {
  const t = useT();
  const qc = useQueryClient();
  const [perms, setPerms] = useState<Set<string>>(() => new Set(role.permissions ?? []));
  const [name, setName] = useState(role.name);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const locked = !!role.isSystem;

  const initial = useMemo(() => new Set(role.permissions ?? []), [role.permissions]);
  const dirty = !locked && (name !== role.name || perms.size !== initial.size || [...perms].some((p) => !initial.has(p)));

  const save = useMutation({
    mutationFn: () => api.patch(`/roles/${role.id}`, { name, permissions: Array.from(perms) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast(t('common.saved')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const del = useMutation({
    mutationFn: () => api.del(`/roles/${role.id}`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['roles'] }); toast(t('common.saved')); onBack(); },
    onError: () => { setConfirmDelete(false); toast.error(t('settings.saveFailed')); },
  });

  const toggle = (k: string) => setPerms((prev) => { const n = new Set(prev); n.has(k) ? n.delete(k) : n.add(k); return n; });

  return (
    <div>
      <button
        onClick={onBack}
        className="-ml-1.5 mb-3 inline-flex items-center gap-0.5 rounded-md py-0.5 pl-1 pr-2 text-[13px] text-muted-foreground transition-colors duration-150 hover:bg-muted/60 hover:text-foreground"
      >
        <ChevronLeft size={15} /> {t('settings.backToRoles')}
      </button>

      <SectionHead
        title={
          <div className="flex items-center gap-2">
            {locked ? <span>{role.name}</span> : <Input value={name} onChange={(e) => setName(e.target.value)} className="h-8 w-56 text-base font-semibold" />}
            {locked && <Badge><Lock size={11} /> {t('settings.system')}</Badge>}
          </div>
        }
        desc={locked ? t('settings.systemRoleLocked') : t('settings.permissions')}
        actions={
          <div className="flex items-center gap-2">
            {!locked && role.key == null && (
              <Button size="sm" variant="ghost" className="text-destructive" onClick={() => setConfirmDelete(true)}><Trash2 size={14} /></Button>
            )}
            {dirty && <Button size="sm" onClick={() => save.mutate()} disabled={save.isPending}>{save.isPending ? <Spinner /> : null} {t('common.save')}</Button>}
          </div>
        }
      />

      <div className="space-y-5">
        {grouped.map((g) => (
          <div key={g.domain}>
            <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-faint">{t(`permdomain.${g.domain}`, g.domain)}</div>
            <RowList>
              {g.perms.map((p) => (
                <div key={p.key} className="flex items-center justify-between gap-3 border-b border-border px-3 py-2.5 last:border-0">
                  <div className="min-w-0">
                    <div className="text-[13px]">{p.label}</div>
                    <div className="font-mono text-[10px] text-faint">{p.key}</div>
                  </div>
                  <Switch checked={perms.has(p.key)} onChange={() => toggle(p.key)} disabled={locked} />
                </div>
              ))}
            </RowList>
          </div>
        ))}
      </div>

      <ConfirmDialog
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        onConfirm={() => del.mutate()}
        title={t('settings.deleteRole')}
        body={t('settings.deleteRoleConfirm')}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}

/* ────────────────────────────── Finance ────────────────────────────── */

interface TaxRate { id: string; name?: string | null; ratePercent?: number | string }
function FinancePanel() {
  const t = useT();
  const taxes = useQuery({ queryKey: ['taxRates'], queryFn: () => api.get<{ data: TaxRate[] }>('/tax-rates') });
  const rows = taxes.data?.data ?? [];
  return (
    <div>
      <SectionHead title={t('nav.finance')} desc={t('settings.financeDesc')} />
      <div className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('settings.taxRates')}</div>
      {taxes.isLoading ? (
        <Skeleton className="h-20 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Wallet size={18} />} title={t('settings.noTaxRates')} hint={t('settings.financeHint')} />
      ) : (
        <RowList>
          {rows.map((tr) => (
            <div key={tr.id} className="flex items-center justify-between border-b border-border px-3 py-2.5 text-[13px] last:border-0">
              <span>{tr.name ?? '–'}</span>
              <span className="tabular-nums text-muted-foreground">{Number(tr.ratePercent ?? 0)}%</span>
            </div>
          ))}
        </RowList>
      )}

      <div className="mt-8">
        <ChartOfAccountsBlock />
      </div>
      <div className="mt-8">
        <ExpenseCategoriesBlock />
      </div>
    </div>
  );
}

/* ────────────────────────────── Audit log ────────────────────────────── */

interface AuditRow { id: string; entityType: string; entityId: string; actorId?: string | null; actorType?: string; action: string; diff?: Record<string, unknown>; sensitivity?: string; createdAt: string }

function AuditPanel() {
  const t = useT();
  const [entityType, setEntityType] = useState('');
  const { data, isLoading } = useQuery<{ data: AuditRow[] }>({
    queryKey: ['audit', entityType],
    queryFn: () => api.get<{ data: AuditRow[] }>(`/audit${qs({ entityType })}`),
  });
  const rows = data?.data ?? [];
  return (
    <div>
      <SectionHead title={t('settings.auditLog')} desc={t('settings.auditDesc')}
        actions={
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-40">
            <option value="">{t('settings.allEntities')}</option>
            {['company', 'contact', 'deal', 'project', 'task', 'invoice', 'quote', 'payment', 'employee', 'leave_request', 'user', 'compensation'].map((et) => <option key={et} value={et}>{et}</option>)}
          </Select>
        } />
      {isLoading ? <Skeleton className="h-40 w-full" /> : rows.length === 0 ? (
        <EmptyState icon={<ScrollText size={18} />} title={t('settings.noAuditRecords')} hint={t('settings.noAuditRecordsHint')} />
      ) : (
        <RowList className="divide-y divide-border">
          {rows.map((r) => (
            <div key={r.id} className="px-3 py-2.5 text-[13px]">
              <div className="flex items-center gap-2">
                <Badge>{r.entityType}</Badge>
                <span className="font-medium">{r.action}</span>
                {r.sensitivity === 'sensitive' && <Badge className="bg-destructive/10 text-destructive">{t('settings.sensitive')}</Badge>}
                <span className="ml-auto text-xs text-faint">{r.actorType ?? 'user'} · {new Date(r.createdAt).toLocaleString()}</span>
              </div>
              {r.diff && Object.keys(r.diff).length > 0 && (
                <pre className="mt-1 overflow-x-auto rounded bg-muted/60 p-2 text-[11px] text-muted-foreground">{JSON.stringify(r.diff, null, 1)}</pre>
              )}
            </div>
          ))}
        </RowList>
      )}
    </div>
  );
}

/* ────────────────────────────── Event queue (DLQ) ────────────────────────────── */

interface DlqRow { id: string; consumer: string; eventId: string; error: string; attempts: number; createdAt: string; payload?: Record<string, unknown> }

function DlqPanel() {
  const t = useT();
  const qc = useQueryClient();
  const { data, isLoading, isError } = useQuery<{ data: DlqRow[]; counts?: Record<string, number> }>({
    queryKey: ['dlq'],
    queryFn: () => api.get<{ data: DlqRow[]; counts?: Record<string, number> }>('/dlq'),
  });
  const replay = useMutation({
    mutationFn: (id: string) => api.post(`/dlq/${id}/replay`),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['dlq'] }); toast(t('settings.replay')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const rows = data?.data ?? [];
  return (
    <div>
      <SectionHead title={t('settings.dlqTitle')} desc={t('settings.eventsDesc')} />
      {isLoading ? <Skeleton className="h-32 w-full" /> : isError ? (
        <EmptyState icon={<Inbox size={18} />} title={t('settings.dlqForbidden')} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Check size={18} />} title={t('settings.queueHealthy')} hint={t('settings.queueHealthyHint')} />
      ) : (
        <RowList>
          {rows.map((r) => (
            <div key={r.id} className="flex items-start gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-0">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Badge>{r.consumer}</Badge>
                  <span className="truncate font-mono text-[11px] text-muted-foreground">{r.eventId}</span>
                  <span className="text-xs text-faint">×{r.attempts}</span>
                </div>
                <p className="mt-0.5 truncate text-xs text-destructive">{r.error}</p>
              </div>
              <Button size="xs" variant="outline" disabled={replay.isPending} onClick={() => replay.mutate(r.id)}><RotateCcw size={12} /> {t('settings.replay')}</Button>
            </div>
          ))}
        </RowList>
      )}
    </div>
  );
}