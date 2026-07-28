import { useState } from 'react';
import { Search, Target } from 'lucide-react';
import { useNavigate } from '../../lib/router';
import { useT } from '../../lib/i18n';
import { EmptyState, Input, Select, Skeleton, fmtRelative } from '../ui';
import {
  LEAD_STATUSES, StatusPill, salesActivityTypeLabel,
  useLeads,
} from './shared';

export function LeadsTab() {
  const t = useT();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const leadsQ = useLeads({ q, status });
  const leads = leadsQ.data ?? [];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search size={14} className="absolute left-2.5 top-2 text-faint" />
          <Input className="pl-8" value={q} onChange={(event) => setQ(event.target.value)} placeholder={t('crm.searchLeads')} />
        </div>
        <Select value={status} onChange={(event) => setStatus(event.target.value)}>
          <option value="">{t('common.allStatuses')}</option>
          {LEAD_STATUSES.map((value) => <option key={value} value={value}>{t(`crm.status.${value}`)}</option>)}
        </Select>
      </div>
      <div className="flex-1 overflow-auto">
        {leadsQ.isLoading ? (
          <div className="space-y-2 p-4">{[0, 1, 2, 3].map((key) => <Skeleton key={key} className="h-14" />)}</div>
        ) : leads.length === 0 ? (
          <EmptyState
            icon={<Target size={20} />}
            title={q || status ? t('crm.noMatch') : t('crm.tabLeads')}
            hint={t('crm.leadsHint')}
          />
        ) : (
          <div className="min-w-[760px]">
            <div className="grid grid-cols-[minmax(220px,2fr)_minmax(160px,1.3fr)_120px_90px_minmax(180px,1.2fr)] border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint">
              <span>{t('crm.lead')}</span>
              <span>{t('crm.company')}</span>
              <span>{t('common.status')}</span>
              <span>{t('crm.score')}</span>
              <span>{t('crm.nextAction')}</span>
            </div>
            {leads.map((lead) => {
              const next = lead.nextActivity;
              return (
                <button
                  key={lead.id}
                  type="button"
                  onClick={() => navigate(`/leads/${lead.id}`)}
                  className="grid w-full grid-cols-[minmax(220px,2fr)_minmax(160px,1.3fr)_120px_90px_minmax(180px,1.2fr)] items-center border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted/50"
                >
                  <span className="min-w-0">
                    <span className="block truncate text-[13px] font-medium">{lead.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{lead.product || lead.signal || '—'}</span>
                  </span>
                  <span className="truncate text-[13px] text-muted-foreground">{lead.companyName || '—'}</span>
                  <StatusPill status={lead.status} />
                  <span className="text-[13px] tabular-nums">{lead.score ?? '—'}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">
                      {next?.subject || (next?.type ? salesActivityTypeLabel(t, next.type) : t('crm.noNextAction'))}
                    </span>
                    {next?.dueAt && <span className="block text-xs text-muted-foreground">{fmtRelative(next.dueAt)}</span>}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
