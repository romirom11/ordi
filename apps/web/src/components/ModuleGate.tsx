/**
 * Workspace module gating. Disabling a module in Settings → Modules hides it
 * from the sidebar; this gate closes the remaining doors (direct URL, restored
 * tab, bookmarked link, command palette) with a calm explanation instead of a
 * page the workspace has switched off.
 */
import type { ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Lock, PowerOff } from 'lucide-react';
import type { ModuleKey, Permission } from '@ordi/shared';
import { api } from '../lib/api';
import { Button, EmptyState } from './ui';
import { Link } from '../lib/router';
import { useCan } from '../lib/auth';
import { useT, extendDict } from '../lib/i18n';

extendDict({
  en: {
    'modules.offTitle': 'This module is turned off',
    'modules.offHint': 'An administrator disabled it for the whole workspace. Existing data is kept and comes back the moment it is switched on again.',
    'modules.offAction': 'Open module settings',
    'modules.noAccessTitle': 'You do not have access to this section',
    'modules.noAccessHint': 'Your role is missing the permission this section needs. An administrator can grant it in Settings → Roles.',
  },
  uk: {
    'modules.offTitle': 'Цей модуль вимкнено',
    'modules.offHint': 'Адміністратор вимкнув його для всього воркспейсу. Дані збережено – вони повернуться одразу після повторного увімкнення.',
    'modules.offAction': 'Відкрити налаштування модулів',
    'modules.noAccessTitle': 'У вас немає доступу до цього розділу',
    'modules.noAccessHint': 'Вашій ролі не вистачає потрібного дозволу. Адміністратор може видати його в Налаштування → Ролі.',
  },
});

interface WorkspaceModules { modules?: Record<string, boolean | undefined> }

/** Shared with Shell/Settings through the same query key, so toggles apply live. */
export function useModules() {
  const q = useQuery<WorkspaceModules>({
    queryKey: ['workspace-settings'],
    queryFn: () => api.get<WorkspaceModules>('/settings/workspace').catch(() => ({})),
    staleTime: 5 * 60_000,
  });
  const modules = q.data?.modules;
  return {
    loading: q.isLoading,
    /** Missing key = enabled; only an explicit `false` turns a module off. */
    enabled: (key: ModuleKey) => modules?.[key] !== false,
  };
}

/**
 * `perm` closes the same doors for permissions that this gate already closed for
 * disabled modules. The sidebar hides a section the role cannot read, but the
 * direct URL, a restored tab and a bookmark went straight through and rendered a
 * page whose every request then failed with 403.
 */
export function ModuleGate({ module, perm, children }: {
  module: ModuleKey;
  perm?: Permission;
  children: ReactNode;
}) {
  const t = useT();
  const can = useCan();
  const { loading, enabled } = useModules();
  if (loading) return null;
  if (!enabled(module)) {
    return (
      <div className="page-enter px-6 py-10">
        <EmptyState
          icon={<PowerOff size={18} />}
          title={t('modules.offTitle')}
          hint={t('modules.offHint')}
          action={can('settings.manage')
            ? <Link to="/settings/modules"><Button size="sm" variant="outline">{t('modules.offAction')}</Button></Link>
            : undefined}
        />
      </div>
    );
  }
  if (perm && !can(perm)) return <NoAccessNotice />;
  return <>{children}</>;
}

/**
 * The same wall the route gate raises, for a surface that is reachable with the
 * page's own permission but holds something narrower – the Pipeline tab under
 * /crm/:tab, which passes crm.read and then needs deals.read of its own.
 */
export function NoAccessNotice() {
  const t = useT();
  return (
    <div className="page-enter px-6 py-10">
      <EmptyState
        icon={<Lock size={18} />}
        title={t('modules.noAccessTitle')}
        hint={t('modules.noAccessHint')}
      />
    </div>
  );
}
