import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { MODULE_KEYS, type ModuleKey } from '@ordi/shared';
import {
  Handshake, BookText, Clock, Receipt, Users, CalendarRange, LayoutGrid, type LucideIcon,
} from 'lucide-react';
import { api } from '../../lib/api';
import { Switch, Skeleton } from '../ui';
import { SectionHead, RowList } from './primitives';
import { Hint } from '../Hint';
import { toast } from '../overlays';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'settings.modules': 'Modules',
    'settings.modulesDesc': 'Turn workspace features on or off for everyone.',
    'settings.modulesHint': 'Disabled modules disappear from the menu for all users. No data is deleted.',
    'settings.moduleSaved': 'Modules updated',
    'settings.mod.crm': 'CRM',
    'settings.mod.crmDesc': 'Clients, contacts and the deal pipeline.',
    'settings.mod.kb': 'Knowledge base',
    'settings.mod.kbDesc': 'Shared documents and team wiki.',
    'settings.mod.time': 'Time',
    'settings.mod.timeDesc': 'Track time spent on tasks and projects.',
    'settings.mod.finance': 'Finance',
    'settings.mod.financeDesc': 'Invoices, quotes and payments.',
    'settings.mod.people': 'People',
    'settings.mod.peopleDesc': 'Employees, leave and compensation.',
    'settings.mod.resourcing': 'Resourcing',
    'settings.mod.resourcingDesc': 'Plan team capacity and allocation.',
    'settings.mod.dashboards': 'Dashboards',
    'settings.mod.dashboardsDesc': 'Reports and data visualisations.',
  },
  uk: {
    'settings.modules': 'Модулі',
    'settings.modulesDesc': 'Вмикайте або вимикайте функції робочого простору для всіх.',
    'settings.modulesHint': 'Вимкнені модулі зникають із меню для всіх користувачів. Дані не видаляються.',
    'settings.moduleSaved': 'Модулі оновлено',
    'settings.mod.crm': 'CRM',
    'settings.mod.crmDesc': 'Клієнти, контакти і воронка угод.',
    'settings.mod.kb': 'База знань',
    'settings.mod.kbDesc': 'Спільні документи та вікі команди.',
    'settings.mod.time': 'Час',
    'settings.mod.timeDesc': 'Облік робочого часу за задачами та проєктами.',
    'settings.mod.finance': 'Фінанси',
    'settings.mod.financeDesc': 'Рахунки, кошториси та платежі.',
    'settings.mod.people': 'Люди',
    'settings.mod.peopleDesc': 'Працівники, відпустки та компенсації.',
    'settings.mod.resourcing': 'Ресурси',
    'settings.mod.resourcingDesc': 'Планування завантаження команди.',
    'settings.mod.dashboards': 'Дашборди',
    'settings.mod.dashboardsDesc': 'Звіти та візуалізації по даних.',
  },
});

const MODULE_META: Record<ModuleKey, { icon: LucideIcon }> = {
  crm: { icon: Handshake },
  kb: { icon: BookText },
  time: { icon: Clock },
  finance: { icon: Receipt },
  people: { icon: Users },
  resourcing: { icon: CalendarRange },
  dashboards: { icon: LayoutGrid },
};

interface WorkspaceModules { modules?: Record<string, boolean | undefined> }

export function ModulesPanel() {
  const t = useT();
  const qc = useQueryClient();
  const ws = useQuery({ queryKey: ['workspace-settings'], queryFn: () => api.get<WorkspaceModules>('/settings/workspace') });
  const modules = ws.data?.modules ?? {};

  const patch = useMutation({
    mutationFn: (next: Record<ModuleKey, boolean>) => api.patch('/settings/workspace', { modules: next }),
    onSuccess: () => {
      // Sidebar reads ['workspace-settings'] — invalidate so nav hides/shows live.
      qc.invalidateQueries({ queryKey: ['workspace-settings'] });
      toast(t('settings.moduleSaved'));
    },
    onError: () => toast.error(t('settings.saveFailed')),
  });

  const toggle = (key: ModuleKey, enabled: boolean) => {
    // Send the full merged object so the intent is explicit and unambiguous.
    const next = Object.fromEntries(
      MODULE_KEYS.map((k) => [k, k === key ? enabled : modules[k] !== false]),
    ) as Record<ModuleKey, boolean>;
    patch.mutate(next);
  };

  return (
    <div>
      <SectionHead title={t('settings.modules')} desc={t('settings.modulesDesc')} />

      <Hint id="settings-modules" className="mb-4">{t('settings.modulesHint')}</Hint>

      {ws.isLoading ? (
        <div className="space-y-2">{[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
      ) : (
        <RowList>
          {MODULE_KEYS.map((key) => {
            const Icon = MODULE_META[key].icon;
            const enabled = modules[key] !== false;
            return (
              <div key={key} className="flex items-center gap-3 border-b border-border px-3 py-3 last:border-0">
                <div className="grid h-8 w-8 shrink-0 place-items-center rounded-md bg-muted text-muted-foreground">
                  <Icon size={16} />
                </div>
                <div className="min-w-0 flex-1">
                  <div className="text-[13px] font-medium">{t(`settings.mod.${key}`)}</div>
                  <div className="text-xs text-muted-foreground">{t(`settings.mod.${key}Desc`)}</div>
                </div>
                <Switch checked={enabled} onChange={(v) => toggle(key, v)} />
              </div>
            );
          })}
        </RowList>
      )}
    </div>
  );
}
