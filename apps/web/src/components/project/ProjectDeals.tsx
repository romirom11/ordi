/**
 * Leads sold into this project. A delivery project collects the deals of one
 * client; a product project (a SaaS, say) collects leads from many companies
 * at once, which is what this view is really for – the pipeline can filter by
 * project, but until now the project could not show its own pipeline.
 *
 * Two separate permissions gate it, and they are not the same:
 *   deals.read – whether the section exists at all
 *   crm.read   – whether each row may name the client it came from
 * Both matter here because a project is reachable through project membership
 * alone (a guest added to a product project has no CRM permissions), so
 * neither list may ride on "can open the project".
 */
import { useQuery } from '@tanstack/react-query';
import { Handshake } from 'lucide-react';
import { api, qs } from '../../lib/api';
import { useCan } from '../../lib/auth';
import { EmptySection, Skeleton, cn, fmtMoney } from '../ui';
import { DealRows } from '../crm/DealRows';
import { useDealStages, type Company, type Deal } from '../crm/shared';
import { useUsersLookup } from '../../lib/queries';
import { useT, extendDict } from '../../lib/i18n';

extendDict({
  en: {
    'projects.leads': 'Leads',
    'projects.noLeads': 'No leads for this project yet',
    'projects.leadsOpen': 'open',
  },
  uk: {
    'projects.leads': 'Ліди',
    'projects.noLeads': 'Для цього проєкту ще немає лідів',
    'projects.leadsOpen': 'у роботі',
  },
});

/**
 * The gate is a wrapper, not a branch inside the body: hooks cannot be
 * conditional, so a viewer without deals.read would still fire the stage and
 * deal lookups and collect 403s in the audit log before rendering nothing.
 */
export function ProjectDeals({ projectId }: { projectId: string }) {
  const can = useCan();
  if (!can('deals.read')) return null;
  return <ProjectDealsList projectId={projectId} canReadCrm={can('crm.read')} />;
}

function ProjectDealsList({ projectId, canReadCrm }: { projectId: string; canReadCrm: boolean }) {
  const t = useT();

  const stagesQ = useDealStages();
  const usersQ = useUsersLookup();

  const dealsQ = useQuery<Deal[]>({
    queryKey: ['deals', 'project', projectId],
    queryFn: () => api.get<{ data: Deal[] }>(`/deals${qs({ projectId })}`).then((r) => r.data),
  });

  // Only fetched when the viewer may see clients at all; without it the rows
  // simply omit the column rather than showing an id or an error.
  const companiesQ = useQuery<Company[]>({
    queryKey: ['companies', '', ''],
    queryFn: () => api.get<{ data: Company[] }>(`/companies${qs({ limit: 200 })}`).then((r) => r.data),
    enabled: canReadCrm,
    staleTime: 5 * 60_000,
  });

  const deals = dealsQ.data ?? [];
  const stages = stagesQ.data ?? [];
  const stageMap = new Map(stages.map((s) => [s.id, s]));
  const companyNames = canReadCrm
    ? new Map((companiesQ.data ?? []).map((c) => [c.id, c.name]))
    : undefined;

  let open = 0;
  let currency = 'USD';
  for (const d of deals) {
    const stage = d.stageId ? stageMap.get(d.stageId) : undefined;
    if (stage?.isWon || stage?.isLost) continue;
    open += Number(d.amount ?? 0);
    currency = d.currency ?? currency;
  }

  return (
    <section>
      <div className="mb-2 flex items-center justify-between gap-3">
        <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wider text-faint">
          {t('projects.leads')}
          {deals.length > 0 && <span className="text-faint">{deals.length}</span>}
        </h2>
        {open > 0 && (
          <span className={cn('text-[13px] text-muted-foreground tabular-nums')}>
            {fmtMoney(open, currency)} <span className="text-faint">{t('projects.leadsOpen')}</span>
          </span>
        )}
      </div>
      {dealsQ.isLoading ? (
        <div className="space-y-1">{[0, 1].map((i) => <Skeleton key={i} className="h-11 rounded-md" />)}</div>
      ) : deals.length === 0 ? (
        <EmptySection icon={<Handshake size={14} />} title={t('projects.noLeads')} />
      ) : (
        <DealRows deals={deals} stages={stages} users={usersQ.data ?? []} companyNames={companyNames} />
      )}
    </section>
  );
}
