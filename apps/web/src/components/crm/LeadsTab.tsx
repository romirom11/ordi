import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Building2, CircleDot, Copy, ExternalLink, Search, Target, Trash2, UserCircle2, X } from 'lucide-react';
import { api, appOrigin, ApiError } from '../../lib/api';
import { useOpen } from '../../lib/router';
import { useTabs } from '../../lib/tabs';
import { useCan } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { Avatar, Button, EmptyState, Input, Select, Skeleton, fmtRelative } from '../ui';
import { ContextMenu, ConfirmDialog, toast, type ContextMenuEntry } from '../overlays';
import {
  LEAD_STATUSES, WRITABLE_LEAD_STATUSES, StatusPill, salesActivityTypeLabel,
  useLeads, useUserMap, useUsersLookup, type Lead,
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
  const canDelete = can('crm.delete');
  const tabs = useTabs();
  const [toDelete, setToDelete] = useState<Lead | null>(null);

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

  const refresh = () => {
    qc.invalidateQueries({ queryKey: ['leads'] });
    qc.invalidateQueries({ queryKey: ['sales-work'] });
    qc.invalidateQueries({ queryKey: ['sales-analytics'] });
  };

  const patchLead = useMutation({
    mutationFn: (vars: { lead: Lead; body: Record<string, unknown> }) =>
      api.patch(`/leads/${vars.lead.id}`, { ...vars.body, version: vars.lead.version }),
    onSuccess: () => { refresh(); toast(t('common.saved')); },
    onError: (error) => {
      refresh();
      if (error instanceof ApiError && (error.code === 'version_conflict' || error.status === 409)) toast.error(t('crm.conflict'));
      else toast.error(error instanceof ApiError ? error.message : t('common.saveFailed'));
    },
  });

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/leads/${id}`),
    onSuccess: () => { setToDelete(null); refresh(); toast(t('crm.leadDeleted')); },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t('common.saveFailed')),
  });

  /** Same right-click vocabulary as clients and deals; leads never had one. */
  const buildMenu = (lead: Lead): ContextMenuEntry[] => {
    const url = `/leads/${lead.id}`;
    const items: ContextMenuEntry[] = [
      { key: 'open', label: t('crm.openInNewTab'), icon: <ExternalLink size={14} />, onSelect: () => tabs?.openInNewTab(url) },
      { key: 'copy', label: t('crm.copyLink'), icon: <Copy size={14} />, onSelect: () => { navigator.clipboard?.writeText(`${appOrigin()}${url}`).then(() => toast(t('crm.linkCopied'))); } },
      { key: 'company', label: t('crm.openCompany'), icon: <Building2 size={14} />, onSelect: () => tabs?.openInNewTab(`/companies/${lead.companyId}`) },
    ];
    // A converted lead is a frozen record: navigation only. Nurture is absent
    // from the submenu because it needs a return date the menu cannot ask for.
    if (canWrite && lead.status !== 'converted') {
      items.push({
        key: 'status', label: t('crm.changeStatus'), icon: <CircleDot size={14} />,
        children: BULK_STATUSES.map((s) => ({
          key: s, label: <StatusPill status={s} />, disabled: s === lead.status,
          onSelect: () => { if (s !== lead.status) patchLead.mutate({ lead, body: { status: s } }); },
        })),
      });
      items.push({
        key: 'owner', label: t('crm.changeOwner'), icon: <UserCircle2 size={14} />,
        children: (usersQ.data ?? []).map((user) => ({
          key: user.id, label: user.name, disabled: user.id === lead.ownerId,
          onSelect: () => { if (user.id !== lead.ownerId) patchLead.mutate({ lead, body: { ownerId: user.id } }); },
        })),
      });
    }
    if (canDelete) {
      items.push({ type: 'separator' });
      items.push({ key: 'delete', label: t('common.delete'), icon: <Trash2 size={14} />, danger: true, onSelect: () => setToDelete(lead) });
    }
    return items;
  };

  const bulk = useMutation({
    mutationFn: (patch: BulkPatch) =>
      api.post<{ updated: number; errors: { id: string; message: string }[] }>('/leads/bulk', {
        ids: [...visibleSelected],
        ...patch,
      }),
    onSuccess: (result) => {
      refresh();
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
                <ContextMenu key={lead.id} items={buildMenu(lead)}>
                <div
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
                </ContextMenu>
              );
            })}
          </div>
        )}
      </div>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('crm.deleteLeadTitle')}
        body={toDelete ? t('crm.deleteLeadBody').replace('{name}', toDelete.title) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}
