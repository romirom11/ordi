/**
 * Unified CRM page: Clients (companies) and the deal Pipeline in one place.
 * Route: /crm and /crm/:tab. Also serves legacy /companies (→ clients) and
 * /deals (→ pipeline) so old links land on the right tab.
 */
import { useState } from 'react';
import { Plus, Users, KanbanSquare } from 'lucide-react';
import { useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { useT } from '../lib/i18n';
import { Button, PageHeader, Tabs } from '../components/ui';
import { ClientsTab } from '../components/crm/ClientsTab';
import { PipelineTab } from '../components/crm/PipelineTab';
import { NewClientDialog, NewDealDialog } from '../components/crm/dialogs';

type CrmTab = 'clients' | 'deals';

function normalizeTab(tab?: string): CrmTab {
  if (tab === 'deals' || tab === 'pipeline') return 'deals';
  return 'clients';
}

export function CrmPage({ tab }: { tab?: string }) {
  const t = useT();
  const navigate = useNavigate();
  const can = useCan();
  const active = normalizeTab(tab);

  const canWriteCrm = can('crm.write');
  const canWriteDeals = can('deals.write');

  const [newClient, setNewClient] = useState(false);
  const [newDeal, setNewDeal] = useState(false);

  const go = (next: CrmTab) => navigate(`/crm/${next}`);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PageHeader
        title={t('crm.title')}
        subtitle={t('crm.subtitleUnified')}
        actions={
          <div className="flex items-center gap-2">
            {canWriteCrm && (
              <Button variant="outline" size="sm" onClick={() => setNewClient(true)}>
                <Plus size={14} /> {t('crm.newClient')}
              </Button>
            )}
            {canWriteDeals && (
              <Button size="sm" onClick={() => setNewDeal(true)}>
                <Plus size={14} /> {t('crm.newDeal')}
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
            { key: 'clients', label: t('crm.tabClients'), icon: <Users size={15} /> },
            { key: 'deals', label: t('crm.tabPipeline'), icon: <KanbanSquare size={15} /> },
          ]}
        />
      </div>

      {active === 'clients'
        ? <ClientsTab onNewClient={() => setNewClient(true)} />
        : <PipelineTab />}

      <NewClientDialog
        open={newClient}
        onClose={() => setNewClient(false)}
        onCreated={(c) => navigate(`/companies/${c.id}`)}
      />
      <NewDealDialog open={newDeal} onClose={() => setNewDeal(false)} />
    </div>
  );
}
