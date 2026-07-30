/**
 * CRM → Clients: full-width company table with per-client open-deal rollups,
 * search + status chips, staggered row entrance. Row click → company detail.
 */
import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Search, Building2, ExternalLink, Copy, CircleDot, Trash2 } from 'lucide-react';
import { useNavigate, useOpen } from '../../lib/router';
import { useTabs } from '../../lib/tabs';
import { useCan } from '../../lib/auth';
import { appOrigin, api, ApiError } from '../../lib/api';
import { useT } from '../../lib/i18n';
import { Avatar, Button, Checkbox, Input, EmptyState, Skeleton, Tooltip, cn, fmtMoney } from '../ui';
import { ContextMenu, ConfirmDialog, DropdownMenu, MenuItem, MenuLabel, toast, type ContextMenuEntry } from '../overlays';
import { BulkBar, RowCheckbox, bulkMessage, runBulk, useSelection } from '../bulk';
import {
  COMPANY_STATUSES, StatusPill, useAllDeals, useCompanies, useDealStages, useUserMap,
  type Company, type Deal, type Stage,
} from './shared';

function useDebounced<T>(value: T, delay = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return v;
}

interface Rollup { open: number; value: number; currency: string }

function rollupDeals(deals: Deal[], stages: Stage[]): Map<string, Rollup> {
  const openStage = new Set(stages.filter((s) => !s.isWon && !s.isLost).map((s) => s.id));
  const map = new Map<string, Rollup>();
  for (const d of deals) {
    if (!d.companyId || !openStage.has(d.stageId)) continue;
    const cur = map.get(d.companyId) ?? { open: 0, value: 0, currency: d.currency ?? 'USD' };
    cur.open += 1;
    cur.value += Number(d.amount ?? 0);
    map.set(d.companyId, cur);
  }
  return map;
}

export function ClientsTab({ onNewClient }: { onNewClient: () => void }) {
  const t = useT();
  const navigate = useNavigate();
  const open = useOpen();
  const tabs = useTabs();
  const can = useCan();
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const [toDelete, setToDelete] = useState<Company | null>(null);
  const debouncedQ = useDebounced(q);

  const companiesQ = useCompanies(debouncedQ, status);
  const dealsQ = useAllDeals();
  const stagesQ = useDealStages();

  const companies = companiesQ.data ?? [];

  const setCompanyStatus = useMutation({
    mutationFn: (v: { c: Company; status: string }) =>
      api.patch(`/companies/${v.c.id}`, { status: v.status, version: v.c.version }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['companies'] }); toast(t('crm.statusUpdated')); },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['companies'] });
      toast.error(e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409) ? t('crm.conflict') : (e instanceof ApiError ? e.message : t('common.saveFailed')));
    },
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/companies/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: ['companies'] }); toast(t('crm.clientDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const canDelete = can('crm.delete');
  const canWrite = can('crm.write');

  const sel = useSelection(companies);
  const [bulkDelete, setBulkDelete] = useState(false);
  const [bulkPending, setBulkPending] = useState(false);

  const finishBulk = (r: { ok: number; failed: number }) => {
    const m = bulkMessage(t, r);
    (m.error ? toast.error : toast)(m.text);
    qc.invalidateQueries({ queryKey: ['companies'] });
    sel.clear();
    setBulkPending(false);
  };

  const bulkStatus = async (next: string) => {
    setBulkPending(true);
    const targets = sel.items.filter((c) => c.status !== next);
    finishBulk(await runBulk(targets, (c) => api.patch(`/companies/${c.id}`, { status: next, version: c.version })));
  };

  const bulkRemove = async () => {
    setBulkPending(true);
    setBulkDelete(false);
    finishBulk(await runBulk(sel.items, (c) => api.del(`/companies/${c.id}`)));
  };

  const buildMenu = (c: Company): ContextMenuEntry[] => {
    const url = `/companies/${c.id}`;
    const items: ContextMenuEntry[] = [
      { key: 'open', label: t('crm.openInNewTab'), icon: <ExternalLink size={14} />, onSelect: () => tabs?.openInNewTab(url) },
      { key: 'copy', label: t('crm.copyLink'), icon: <Copy size={14} />, onSelect: () => { navigator.clipboard?.writeText(`${appOrigin()}${url}`).then(() => toast(t('crm.linkCopied'))); } },
    ];
    if (canWrite) {
      items.push({
        key: 'status', label: t('crm.changeStatus'), icon: <CircleDot size={14} />,
        children: COMPANY_STATUSES.map((s) => ({
          key: s, label: <StatusPill status={s} />, onSelect: () => c.status !== s && setCompanyStatus.mutate({ c, status: s }),
        })),
      });
    }
    if (canDelete) {
      items.push({ type: 'separator' });
      items.push({ key: 'delete', label: t('common.delete'), icon: <Trash2 size={14} />, danger: true, onSelect: () => setToDelete(c) });
    }
    return items;
  };
  const rollup = useMemo(
    () => rollupDeals(dealsQ.data?.deals ?? [], stagesQ.data ?? []),
    [dealsQ.data, stagesQ.data],
  );
  const userMap = useUserMap();

  const chips: { key: string; label: string }[] = [
    { key: '', label: t('common.all') },
    ...COMPANY_STATUSES.map((s) => ({ key: s, label: t(`crm.status.${s}`) })),
  ];

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {/* Compact toolbar: search · status chips · count */}
      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-6 py-3">
        <div className="relative w-56">
          <Search size={14} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-faint" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('crm.searchClients')} className="pl-8" />
        </div>
        <div className="flex items-center gap-1">
          {chips.map((c) => (
            <button
              key={c.key || 'all'}
              onClick={() => setStatus(c.key)}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium transition-colors duration-150',
                status === c.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {c.label}
            </button>
          ))}
        </div>
        {!companiesQ.isLoading && companies.length > 0 && (
          <span className="ml-auto text-xs tabular-nums text-faint">
            {t('crm.clientCount').replace('{n}', String(companies.length))}
          </span>
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto">
        {companiesQ.isLoading ? (
          <div className="space-y-px p-3">
            {[0, 1, 2, 3, 4, 5].map((i) => <Skeleton key={i} className="h-12 rounded-md" />)}
          </div>
        ) : companies.length === 0 ? (
          <EmptyState
            icon={<Building2 size={20} />}
            title={debouncedQ || status ? t('crm.noMatch') : t('crm.empty')}
            hint={debouncedQ || status ? t('crm.noMatchHint') : t('crm.emptyHint')}
            action={!debouncedQ && !status ? <Button size="sm" onClick={onNewClient}>{t('crm.newClient')}</Button> : undefined}
          />
        ) : (
          <div className="px-3 py-2">
            {/* Header row */}
            <div className="grid grid-cols-[20px_minmax(0,1fr)_130px_170px_40px] items-center gap-3 px-3 pb-1.5 text-[11px] font-medium uppercase tracking-wide text-faint">
              <span className="flex items-center" title={t('bulk.selectAll')}>
                <Checkbox checked={sel.allSelected} onChange={sel.toggleAll} />
              </span>
              <span>{t('common.name')}</span>
              <span>{t('common.status')}</span>
              <span className="text-right">{t('crm.colDeals')}</span>
              <span className="text-right">{t('crm.owner')}</span>
            </div>
            <div className="space-y-px">
              {companies.map((c, i) => {
                const r = rollup.get(c.id);
                const owner = c.ownerId ? userMap.get(c.ownerId) : undefined;
                return (
                  <ContextMenu key={c.id} items={buildMenu(c)}>
                  <div
                    onClick={(e) => open(`/companies/${c.id}`, e)}
                    onAuxClick={(e) => open(`/companies/${c.id}`, e)}
                    style={{ ['--i' as string]: Math.min(i, 10) }}
                    className={cn(
                      'row-enter group grid cursor-pointer grid-cols-[20px_minmax(0,1fr)_130px_170px_40px] items-center gap-3 rounded-md px-3 py-2 transition-colors duration-150 hover:bg-muted',
                      sel.has(c.id) && 'bg-primary/[0.06] hover:bg-primary/10',
                    )}
                  >
                    <RowCheckbox
                      checked={sel.has(c.id)}
                      onToggle={(shift) => sel.toggle(c.id, shift)}
                      className={cn('transition-opacity duration-150', !sel.has(c.id) && sel.size === 0 && 'opacity-0 group-hover:opacity-100')}
                    />
                    <div className="flex min-w-0 items-center gap-2.5">
                      <Avatar name={c.name} size={26} />
                      <div className="min-w-0">
                        <div className="truncate text-[13px] font-medium">{c.name}</div>
                        <div className="truncate text-xs text-faint">{c.domain || t('crm.noDomain')}</div>
                      </div>
                    </div>
                    <div><StatusPill status={c.status} /></div>
                    <div className="text-right">
                      {r ? (
                        <div className="flex items-center justify-end gap-2">
                          <span className="text-[13px] font-semibold tabular-nums">{fmtMoney(r.value, r.currency)}</span>
                          <span className="inline-flex h-5 min-w-[20px] items-center justify-center rounded bg-muted px-1 text-[11px] font-medium tabular-nums text-muted-foreground">
                            {r.open}
                          </span>
                        </div>
                      ) : (
                        <span className="text-xs text-faint">–</span>
                      )}
                    </div>
                    <div className="flex justify-end">
                      {owner ? (
                        <Tooltip label={owner.name} side="top">
                          <Avatar name={owner.name} src={owner.avatar} size={22} />
                        </Tooltip>
                      ) : (
                        <span className="grid h-[22px] w-[22px] place-items-center rounded-full border border-dashed border-border-strong text-[10px] text-faint">?</span>
                      )}
                    </div>
                  </div>
                  </ContextMenu>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <BulkBar count={sel.size} onClear={sel.clear}>
        {canWrite && (
          <DropdownMenu
            align="start"
            trigger={
              <Button size="xs" variant="outline" disabled={bulkPending}>
                <CircleDot size={13} /> {t('crm.changeStatus')}
              </Button>
            }
          >
            <MenuLabel>{t('crm.changeStatus')}</MenuLabel>
            {COMPANY_STATUSES.map((s) => (
              <MenuItem key={s} onSelect={() => bulkStatus(s)}><StatusPill status={s} /></MenuItem>
            ))}
          </DropdownMenu>
        )}
        {canDelete && (
          <Button size="xs" variant="outline" disabled={bulkPending} onClick={() => setBulkDelete(true)}>
            <Trash2 size={13} /> {t('common.delete')}
          </Button>
        )}
      </BulkBar>

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('crm.deleteClientTitle')}
        body={toDelete ? t('crm.deleteClientBody').replace('{name}', toDelete.name) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />

      <ConfirmDialog
        open={bulkDelete}
        onClose={() => setBulkDelete(false)}
        onConfirm={bulkRemove}
        title={t('crm.deleteClientTitle')}
        body={t('crm.deleteClientsBody').replace('{n}', String(sel.size))}
        confirmLabel={t('common.delete')}
        danger
        pending={bulkPending}
      />
    </div>
  );
}
