import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Target, UserCircle2, X } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useOpen } from '../../lib/router';
import { useCan } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { Avatar, Button, EmptyState, Input, Select, Skeleton, fmtRelative } from '../ui';
import { toast } from '../overlays';
import {
  LEAD_STATUSES, WRITABLE_LEAD_STATUSES, StatusPill, salesActivityTypeLabel,
  useLeads, useUserMap, useUsersLookup,
} from './shared';

/**
 * The header and the rows are separate elements, so one template shared between
 * them is what keeps a column added to one from misaligning the other. The
 * select column leads only when the viewer can write; both templates stay here
 * so they cannot drift apart.
 */
const LEAD_COLUMNS = 'grid-cols-[minmax(200px,2fr)_minmax(150px,1.2fr)_120px_70px_minmax(160px,1.1fr)_110px]';
const LEAD_COLUMNS_SELECTABLE = 'grid-cols-[28px_minmax(200px,2fr)_minmax(150px,1.2fr)_120px_70px_minmax(160px,1.1fr)_110px]';

/** Bulk moves skip nurture: it needs a return date chosen per lead. */
const BULK_STATUSES = WRITABLE_LEAD_STATUSES.filter((status) => status !== 'nurture');

interface BulkPatch { ownerId?: string | null; status?: string }

export function LeadsTab() {
  const t = useT();
  const can = useCan();
  const open = useOpen();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const leadsQ = useLeads({ q, status });
  // Who is on the hook for each lead – the table had no way to tell, so a team
  // could not see whose pipeline was whose without opening every record.
  const userById = useUserMap();
  const usersQ = useUsersLookup();
  const leads = leadsQ.data?.leads ?? [];
  const canWrite = can('crm.write');

  const [selected, setSelected] = useState<Set<string>>(new Set());
  // Filters change what the checkboxes point at – keep only ids still visible.
  const visibleSelected = useMemo(
    () => new Set(leads.filter((lead) => selected.has(lead.id)).map((lead) => lead.id)),
    [leads, selected],
  );
  const allSelected = leads.length > 0 && visibleSelected.size === leads.length;

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const bulk = useMutation({
    mutationFn: (patch: BulkPatch) =>
      api.post<{ updated: number; errors: { id: string; message: string }[] }>('/leads/bulk', {
        ids: [...visibleSelected],
        ...patch,
      }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      qc.invalidateQueries({ queryKey: ['sales-analytics'] });
      if (result.errors.length) {
        toast.error(t('crm.bulkPartial')
          .replace('{updated}', String(result.updated))
          .replace('{failed}', String(result.errors.length)));
      } else {
        toast(t('crm.bulkUpdated').replace('{n}', String(result.updated)));
      }
      setSelected(new Set());
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t('common.saveFailed')),
  });

  const columns = canWrite ? LEAD_COLUMNS_SELECTABLE : LEAD_COLUMNS;

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
      {visibleSelected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-primary/[0.04] px-4 py-2">
          <span className="text-[13px] font-medium tabular-nums">
            {t('crm.selectedCount').replace('{n}', String(visibleSelected.size))}
          </span>
          <span className="flex items-center gap-1.5">
            <UserCircle2 size={14} className="text-muted-foreground" />
            <Select
              value=""
              disabled={bulk.isPending}
              onChange={(event) => { if (event.target.value) bulk.mutate({ ownerId: event.target.value }); }}
            >
              <option value="">{t('crm.changeOwner')}</option>
              {(usersQ.data ?? []).map((user) => <option key={user.id} value={user.id}>{user.name}</option>)}
            </Select>
          </span>
          <Select
            value=""
            disabled={bulk.isPending}
            onChange={(event) => { if (event.target.value) bulk.mutate({ status: event.target.value }); }}
          >
            <option value="">{t('crm.changeStatus')}</option>
            {BULK_STATUSES.map((value) => <option key={value} value={value}>{t(`crm.status.${value}`)}</option>)}
          </Select>
          <Button size="xs" variant="ghost" onClick={() => setSelected(new Set())}>
            <X size={12} /> {t('crm.clearSelection')}
          </Button>
        </div>
      )}
      {leadsQ.data?.truncated && (
        // A table that silently stops at the cap looks complete when it is not.
        <p className="border-b border-border px-4 py-2 text-xs text-warning">{t('crm.leadsTruncated')}</p>
      )}
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
          <div className="min-w-[842px]">
            <div className={`grid ${columns} items-center border-b border-border px-4 py-2 text-[11px] font-semibold uppercase tracking-wide text-faint`}>
              {canWrite && (
                <input
                  type="checkbox"
                  aria-label={t('crm.selectAll')}
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(leads.map((lead) => lead.id)))}
                />
              )}
              <span>{t('crm.lead')}</span>
              <span>{t('crm.company')}</span>
              <span>{t('common.status')}</span>
              <span>{t('crm.score')}</span>
              <span>{t('crm.nextAction')}</span>
              <span>{t('crm.owner')}</span>
            </div>
            {leads.map((lead, i) => {
              const next = lead.nextActivity;
              return (
                // The whole row still opens the lead, as it did before the
                // select column existed; only the checkbox itself opts out.
                <div
                  key={lead.id}
                  style={{ ['--i' as string]: Math.min(i, 10) }}
                  onClick={(e) => { if (!(e.target as HTMLElement).closest('input')) open(`/leads/${lead.id}`, e); }}
                  onAuxClick={(e) => { if (!(e.target as HTMLElement).closest('input')) open(`/leads/${lead.id}`, e); }}
                  className={`row-enter grid w-full cursor-pointer ${columns} items-center border-b border-border px-4 py-2.5 text-left transition-colors hover:bg-muted/50`}
                >
                  {canWrite && (
                    <input
                      type="checkbox"
                      aria-label={t('crm.selectLead')}
                      checked={visibleSelected.has(lead.id)}
                      onChange={() => toggle(lead.id)}
                    />
                  )}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); open(`/leads/${lead.id}`, e); }}
                    onAuxClick={(e) => { e.stopPropagation(); open(`/leads/${lead.id}`, e); }}
                    className="min-w-0 text-left"
                  >
                    <span className="block truncate text-[13px] font-medium">{lead.title}</span>
                    <span className="block truncate text-xs text-muted-foreground">{lead.product || lead.signal || '—'}</span>
                  </button>
                  <span className="truncate text-[13px] text-muted-foreground">{lead.companyName || '—'}</span>
                  <StatusPill status={lead.status} />
                  <span className="text-[13px] tabular-nums">{lead.score ?? '—'}</span>
                  <span className="min-w-0">
                    <span className="block truncate text-[13px]">
                      {next?.subject || (next?.type ? salesActivityTypeLabel(t, next.type) : t('crm.noNextAction'))}
                    </span>
                    {next?.dueAt && <span className="block text-xs text-muted-foreground">{fmtRelative(next.dueAt)}</span>}
                  </span>
                  <span className="flex min-w-0 items-center gap-1.5">
                    {lead.ownerId && userById.get(lead.ownerId) ? (
                      <>
                        <Avatar name={userById.get(lead.ownerId)!.name} src={userById.get(lead.ownerId)!.avatar} size={18} />
                        <span className="truncate text-xs text-muted-foreground">{userById.get(lead.ownerId)!.name}</span>
                      </>
                    ) : <span className="text-xs text-faint">{t('crm.noOwner')}</span>}
                  </span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
