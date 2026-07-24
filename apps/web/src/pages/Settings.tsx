import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { PERMISSIONS, PERMISSION_META, type Permission } from '@ordi/shared';
import {
  Building2, ArrowLeftRight, Users as UsersIcon, Shield, SlidersHorizontal, Wallet, Plug,
  ScrollText, Inbox, Plus, Copy, Upload, Trash2, Lock, Globe, ImageIcon, ChevronRight,
  ChevronLeft, MoreHorizontal, Check, RotateCcw, Boxes, Receipt, FolderKanban,
} from 'lucide-react';
import { api, qs } from '../lib/api';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import {
  Button, Input, Select, Card, Badge, PageBody, Breadcrumbs, EmptyState, Skeleton, Switch, Avatar, Spinner, cn,
} from '../components/ui';
import { Dialog, ConfirmDialog, DropdownMenu, MenuItem, toast } from '../components/overlays';
import { ImportExportPanel } from '../components/ImportExportPanel';
import { IntegrationsPanel } from '../components/settings/IntegrationsPanel';
import { InvoicesPanel } from '../components/settings/InvoicesPanel';
import { ModulesPanel } from '../components/settings/ModulesPanel';
import { ProjectTypesPanel } from '../components/settings/ProjectTypesPanel';
import { SectionHead, SettingRow, Field, RowList, AnimatedRow } from '../components/settings/primitives';
import { downscaleImage } from '../components/settings/image';
import { usePageTitle } from '../lib/tabs';
import { useT } from '../lib/i18n';
import { extendDict } from '../lib/i18n';

extendDict({
  en: {
    'settings.subtitle': 'Manage your workspace, members and configuration',
    'settings.groupGeneral': 'General',
    'settings.groupMembers': 'Members',
    'settings.groupConfig': 'Configuration',
    'settings.groupSystem': 'System',
    'settings.workspaceDesc': 'Your workspace identity and defaults.',
    'settings.logo': 'Logo',
    'settings.logoHint': 'Square image, at least 128×128. PNG or WebP.',
    'settings.upload': 'Upload',
    'settings.remove': 'Remove',
    'settings.dropImage': 'Drop image here',
    'settings.logoTooLarge': 'Image too large after processing — try a simpler image.',
    'settings.logoInvalid': "Couldn't read that image.",
    'settings.logoUpdated': 'Logo updated',
    'settings.workingDays': 'Working days',
    'settings.defaultBillable': 'Default billable',
    'settings.defaultBillableHint': 'New tasks are billable by default.',
    'settings.estimateUnit': 'Estimate unit',
    'settings.usersDesc': 'People with access to this workspace.',
    'settings.rolesDesc': 'Define what each role can do.',
    'settings.customFieldsDesc': 'Add custom fields to any entity type.',
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
    'settings.roleUpdated': 'Role updated',
    'settings.inviteSent': 'Invitation created',
    'settings.inviteCopyHint': 'Share this link so they can set up their account.',
    'settings.noUsers': 'No members yet',
    'settings.permissions': 'Permissions',
    'settings.systemRoleLocked': 'System role — permissions are fixed.',
    'settings.deleteRole': 'Delete role',
    'settings.deleteRoleConfirm': 'Delete this role? Members will need a new role assigned.',
    'settings.backToRoles': 'All roles',
    'settings.member': 'member',
    'settings.members': 'members',
    'settings.invoices': 'Invoices',
    'settings.saveFailed': 'Could not save changes',
    'settings.conflict': 'Someone else made changes — reloaded latest.',
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
    'settings.workspaceDesc': 'Ідентичність робочого простору та типові значення.',
    'settings.logo': 'Логотип',
    'settings.logoHint': 'Квадратне зображення, щонайменше 128×128. PNG або WebP.',
    'settings.upload': 'Завантажити',
    'settings.remove': 'Видалити',
    'settings.dropImage': 'Перетягніть зображення сюди',
    'settings.logoTooLarge': 'Зображення завелике після обробки — оберіть простіше.',
    'settings.logoInvalid': 'Не вдалося прочитати зображення.',
    'settings.logoUpdated': 'Логотип оновлено',
    'settings.workingDays': 'Робочі дні',
    'settings.defaultBillable': 'Оплачувані за замовчуванням',
    'settings.defaultBillableHint': 'Нові задачі є оплачуваними за замовчуванням.',
    'settings.estimateUnit': 'Одиниця оцінки',
    'settings.usersDesc': 'Люди з доступом до цього робочого простору.',
    'settings.rolesDesc': 'Визначте, що може робити кожна роль.',
    'settings.customFieldsDesc': 'Додавайте власні поля до будь-якого типу сутностей.',
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
    'settings.roleUpdated': 'Роль оновлено',
    'settings.inviteSent': 'Запрошення створено',
    'settings.inviteCopyHint': 'Надішліть це посилання, щоб вони налаштували обліковий запис.',
    'settings.noUsers': 'Ще немає учасників',
    'settings.permissions': 'Дозволи',
    'settings.systemRoleLocked': 'Системна роль — дозволи незмінні.',
    'settings.deleteRole': 'Видалити роль',
    'settings.deleteRoleConfirm': 'Видалити цю роль? Учасникам знадобиться нова роль.',
    'settings.backToRoles': 'Усі ролі',
    'settings.member': 'учасник',
    'settings.members': 'учасників',
    'settings.invoices': 'Інвойси',
    'settings.saveFailed': 'Не вдалося зберегти зміни',
    'settings.conflict': 'Хтось інший вніс зміни — завантажено найновіше.',
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

interface NavItem { id: string; label: string; perm: string; icon: React.ComponentType<{ size?: number }> }
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
      { id: 'custom-fields', label: 'settings.customFields', perm: 'settings.manage', icon: SlidersHorizontal },
      { id: 'finance', label: 'nav.finance', perm: 'finance.settings', icon: Wallet },
      { id: 'invoices', label: 'settings.invoices', perm: 'finance.settings', icon: Receipt },
      { id: 'integrations', label: 'settings.integrations', perm: 'integrations.manage', icon: Plug },
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

export function SettingsPage({ section }: { section?: string }) {
  const t = useT();
  const can = useCan();
  const groups = GROUPS.map((g) => ({ ...g, items: g.items.filter((n) => can(n.perm)) })).filter((g) => g.items.length > 0);
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
      {/* Slim trail only — each panel carries its own heading and description. */}
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
        </aside>
        <div className="min-w-0 flex-1">
          <PageBody key={active.id} width="default" className="anim-fade-in">
            {active.id === 'workspace' && <WorkspacePanel />}
            {active.id === 'users' && <UsersPanel />}
            {active.id === 'roles' && <RolesPanel />}
            {active.id === 'modules' && <ModulesPanel />}
            {active.id === 'project-types' && <ProjectTypesPanel />}
            {active.id === 'custom-fields' && <CustomFieldsPanel />}
            {active.id === 'finance' && <FinancePanel />}
            {active.id === 'invoices' && <InvoicesPanel />}
            {active.id === 'integrations' && <IntegrationsPanel />}
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

const CURRENCIES = ['USD', 'EUR', 'GBP', 'UAH', 'CAD', 'AUD', 'CHF', 'JPY', 'PLN', 'SEK', 'NOK', 'INR', 'BRL', 'SGD'];
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
          {CURRENCIES.map((c) => <option key={c} value={c}>{c}</option>)}
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

interface UserRow { id: string; name?: string | null; email?: string | null; roleId?: string | null; isActive?: boolean; avatar?: string | null }
interface Role { id: string; key?: string; name: string; isSystem?: boolean; permissions?: string[]; userCount?: number }

function UsersPanel() {
  const t = useT();
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['users'], queryFn: () => api.get<{ data: UserRow[] }>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api.get<{ data: Role[] }>('/roles') });
  const [inviteOpen, setInviteOpen] = useState(false);

  const changeRole = useMutation({
    mutationFn: ({ id, roleId }: { id: string; roleId: string }) => api.patch(`/users/${id}/role`, { roleId }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['users'] }); qc.invalidateQueries({ queryKey: ['roles'] }); toast(t('settings.roleUpdated')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const setActive = useMutation({
    mutationFn: ({ id, active }: { id: string; active: boolean }) => api.post(`/users/${id}/${active ? 'reactivate' : 'deactivate'}`),
    onSuccess: (_r, v) => { qc.invalidateQueries({ queryKey: ['users'] }); toast(v.active ? t('settings.userReactivated') : t('settings.userDeactivated')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const roleList = roles.data?.data ?? [];
  const roleName = (id?: string | null) => roleList.find((r) => r.id === id)?.name ?? '—';
  const rows = users.data?.data ?? [];

  return (
    <div>
      <SectionHead title={t('settings.users')} desc={t('settings.usersDesc')}
        actions={<Button size="sm" onClick={() => setInviteOpen(true)}><Plus size={14} /> {t('settings.invite')}</Button>} />

      {users.isLoading ? (
        <div className="space-y-2">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-12 w-full" />)}</div>
      ) : rows.length === 0 ? (
        <EmptyState icon={<UsersIcon size={18} />} title={t('settings.noUsers')} />
      ) : (
        <RowList>
          {rows.map((u, i) => (
            <AnimatedRow key={u.id} index={i} className="flex items-center gap-3 border-b border-border px-3 py-2.5 last:border-0">
              <Avatar name={u.name} src={u.avatar} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate text-[13px] font-medium">{u.name ?? '—'}</span>
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
                {!u.roleId && <option value="">—</option>}
                {roleList.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </Select>
              <DropdownMenu align="end" trigger={<Button variant="ghost" size="sm" className="h-7 w-7 px-0"><MoreHorizontal size={15} /></Button>}>
                {u.isActive === false ? (
                  <MenuItem icon={<RotateCcw size={14} />} onSelect={() => setActive.mutate({ id: u.id, active: true })}>{t('settings.reactivate')}</MenuItem>
                ) : (
                  <MenuItem icon={<Trash2 size={14} />} danger onSelect={() => setActive.mutate({ id: u.id, active: false })}>{t('settings.deactivate')}</MenuItem>
                )}
              </DropdownMenu>
            </AnimatedRow>
          ))}
        </RowList>
      )}

      <InviteDialog open={inviteOpen} onClose={() => setInviteOpen(false)} roles={roleList} />
    </div>
  );
}

function InviteDialog({ open, onClose, roles }: { open: boolean; onClose: () => void; roles: Role[] }) {
  const t = useT();
  const qc = useQueryClient();
  const [email, setEmail] = useState('');
  const [name, setName] = useState('');
  const [roleId, setRoleId] = useState('');
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);

  useEffect(() => {
    if (open) { setEmail(''); setName(''); setRoleId(roles.find((r) => !r.isSystem)?.id ?? roles[0]?.id ?? ''); setInviteUrl(null); }
  }, [open, roles]);

  const invite = useMutation({
    mutationFn: () => api.post<{ inviteUrl?: string }>('/users/invite', { email, name, roleId }),
    onSuccess: (r) => { setInviteUrl(r?.inviteUrl ?? null); qc.invalidateQueries({ queryKey: ['users'] }); toast(t('settings.inviteSent')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  return (
    <Dialog open={open} onClose={onClose} title={t('settings.inviteUser')} width={420}>
      <div className="space-y-3 p-4">
        <Field label={t('settings.name')}><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Jane Doe" autoFocus /></Field>
        <Field label={t('auth.email')}><Input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="jane@company.com" /></Field>
        <Field label={t('settings.role')}>
          <Select value={roleId} onChange={(e) => setRoleId(e.target.value)} className="w-full">
            {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
          </Select>
        </Field>
        {inviteUrl ? (
          <div className="rounded-md border border-border bg-muted/50 p-3">
            <p className="mb-2 text-xs text-muted-foreground">{t('settings.inviteCopyHint')}</p>
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate font-mono text-[11px]">{inviteUrl}</span>
              <Button size="xs" variant="outline" onClick={() => { navigator.clipboard?.writeText(inviteUrl); toast(t('common.copy')); }}><Copy size={12} /></Button>
            </div>
          </div>
        ) : null}
        <div className="flex justify-end gap-2 pt-1">
          <Button variant="ghost" size="sm" onClick={onClose}>{inviteUrl ? t('common.close') : t('common.cancel')}</Button>
          {!inviteUrl && <Button size="sm" onClick={() => invite.mutate()} disabled={!email || !name || !roleId || invite.isPending}>{invite.isPending ? <Spinner /> : <Plus size={14} />} {t('settings.invite')}</Button>}
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

/* ────────────────────────────── Custom fields ────────────────────────────── */

interface CustomField { id: string; key: string; label?: string | null; type?: string | null; required?: boolean }
const ENTITY_TYPES = ['companies', 'contacts', 'deals', 'projects', 'tasks', 'invoices', 'quotes', 'employees', 'applicants'];
const FIELD_TYPES = ['text', 'number', 'date', 'select', 'multiselect', 'checkbox', 'url', 'user'];

function CustomFieldsPanel() {
  const t = useT();
  const qc = useQueryClient();
  const [entityType, setEntityType] = useState('companies');
  const fields = useQuery({ queryKey: ['customFields', entityType], queryFn: () => api.get<{ data: CustomField[] }>('/custom-fields' + qs({ entityType })) });
  const [form, setForm] = useState({ key: '', label: '', type: 'text' });
  const create = useMutation({
    mutationFn: () => api.post('/custom-fields', { entityType, key: form.key, label: form.label, type: form.type }),
    onSuccess: () => { setForm({ key: '', label: '', type: 'text' }); qc.invalidateQueries({ queryKey: ['customFields', entityType] }); toast(t('common.saved')); },
    onError: () => toast.error(t('settings.saveFailed')),
  });
  const rows = fields.data?.data ?? [];

  return (
    <div>
      <SectionHead title={t('settings.customFields')} desc={t('settings.customFieldsDesc')}
        actions={
          <Select value={entityType} onChange={(e) => setEntityType(e.target.value)} className="w-36">
            {ENTITY_TYPES.map((et) => <option key={et} value={et}>{et}</option>)}
          </Select>
        } />

      <Card className="mb-4 p-3">
        <form className="flex flex-wrap items-end gap-2" onSubmit={(e) => { e.preventDefault(); if (form.key && form.label) create.mutate(); }}>
          <Field label={t('projects.key')} className="w-32"><Input value={form.key} onChange={(e) => setForm((f) => ({ ...f, key: e.target.value }))} placeholder="budget" /></Field>
          <Field label={t('settings.fieldLabel')} className="w-40"><Input value={form.label} onChange={(e) => setForm((f) => ({ ...f, label: e.target.value }))} /></Field>
          <Field label={t('dashboards.type')} className="w-32">
            <Select value={form.type} onChange={(e) => setForm((f) => ({ ...f, type: e.target.value }))} className="w-full">
              {FIELD_TYPES.map((ft) => <option key={ft} value={ft}>{ft}</option>)}
            </Select>
          </Field>
          <Button type="submit" size="sm" disabled={!form.key || !form.label || create.isPending}><Plus size={14} /> {t('settings.addField')}</Button>
        </form>
      </Card>

      {fields.isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : rows.length === 0 ? (
        <EmptyState icon={<SlidersHorizontal size={18} />} title={t('settings.noCustomFields')} />
      ) : (
        <RowList>
          {rows.map((f) => (
            <div key={f.id} className="flex items-center gap-3 border-b border-border px-3 py-2.5 text-[13px] last:border-0">
              <span className="font-mono text-[11px] text-muted-foreground">{f.key}</span>
              <span className="flex-1">{f.label ?? '—'}</span>
              <Badge>{f.type ?? '—'}</Badge>
              {f.required && <Badge className="bg-warning/15 text-warning">{t('settings.required')}</Badge>}
            </div>
          ))}
        </RowList>
      )}
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
              <span>{tr.name ?? '—'}</span>
              <span className="tabular-nums text-muted-foreground">{Number(tr.ratePercent ?? 0)}%</span>
            </div>
          ))}
        </RowList>
      )}
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