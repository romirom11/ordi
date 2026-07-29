/**
 * Sales workspace: daily Work, unqualified Leads, qualified Pipeline and the
 * stable Companies directory.
 * Route: /crm and /crm/:tab. Also serves legacy /companies (→ clients) and
 * /deals (→ pipeline) so old links land on the right tab.
 */
import { useState } from 'react';
import { Building2, KanbanSquare, ListTodo, Plus, Target, Workflow } from 'lucide-react';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Button, PageHeader, Tabs } from '../components/ui';
import { ClientsTab } from '../components/crm/ClientsTab';
import { PipelineTab } from '../components/crm/PipelineTab';
import { WorkTab } from '../components/crm/WorkTab';
import { LeadsTab } from '../components/crm/LeadsTab';
import { NewClientDialog, NewDealDialog, NewLeadDialog } from '../components/crm/dialogs';
import { PlaybooksTab } from '../components/crm/PlaybooksTab';

type CrmTab = 'work' | 'leads' | 'deals' | 'companies' | 'playbooks';

function normalizeTab(tab?: string): CrmTab {
  if (tab === 'deals' || tab === 'pipeline') return 'deals';
  if (tab === 'clients' || tab === 'companies') return 'companies';
  if (tab === 'leads') return 'leads';
  if (tab === 'playbooks') return 'playbooks';
  return 'work';
}

export function CrmPage({ tab }: { tab?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const can = useCan();
  const active = normalizeTab(tab);

  const canWriteCrm = can('crm.write');
  const canWriteDeals = can('deals.write');

  const [newClient, setNewClient] = useState(false);
  const [newLead, setNewLead] = useState(false);
  const [newDeal, setNewDeal] = useState(false);

  const go = (next: CrmTab) => navigate(`/crm/${next}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('crm.title')}
        subtitle={
          active === 'work' ? t('crm.workHint')
            : active === 'leads' ? t('crm.leadsHint')
              : active === 'deals' ? t('deals.subtitle')
                : active === 'playbooks' ? t('crm.playbooksHint')
                : t('crm.subtitle')
        }
        actions={
          <div className="flex items-center gap-2">
            {active === 'leads' && canWriteCrm && (
              <Button size="sm" onClick={() => setNewLead(true)}>
                <Plus size={14} /> {t('crm.newLead')}
              </Button>
            )}
            {active === 'deals' && canWriteDeals && (
              <Button size="sm" onClick={() => setNewDeal(true)}>
                <Plus size={14} /> {t('crm.newDeal')}
              </Button>
            )}
            {active === 'companies' && canWriteCrm && (
              <Button size="sm" onClick={() => setNewClient(true)}>
                <Plus size={14} /> {t('crm.newClient')}
              </Button>
            )}
          </div>
        }
      />

      <div className="border-b border-border px-4">
        <Tabs<CrmTab>
          value={active}
          onChange={go}
          tabs={[
            { key: 'work', label: t('crm.tabWork'), icon: <ListTodo size={15} /> },
            { key: 'leads', label: t('crm.tabLeads'), icon: <Target size={15} /> },
            { key: 'deals', label: t('crm.tabPipeline'), icon: <KanbanSquare size={15} /> },
            { key: 'companies', label: t('crm.tabCompanies'), icon: <Building2 size={15} /> },
            { key: 'playbooks', label: t('crm.tabPlaybooks'), icon: <Workflow size={15} /> },
          ]}
        />
      </div>

      {active === 'work' && <WorkTab />}
      {active === 'leads' && <LeadsTab />}
      {active === 'deals' && <PipelineTab />}
      {active === 'companies' && <ClientsTab onNewClient={() => setNewClient(true)} />}
      {active === 'playbooks' && <PlaybooksTab />}

      <NewClientDialog
        open={newClient}
        onClose={() => setNewClient(false)}
        onCreated={(c) => navigate(`/companies/${c.id}`)}
      />
      <NewLeadDialog
        open={newLead}
        onClose={() => setNewLead(false)}
        onCreated={(lead) => navigate(`/leads/${lead.id}`)}
      />
      <NewDealDialog open={newDeal} onClose={() => setNewDeal(false)} />
    </div>
  );
}
