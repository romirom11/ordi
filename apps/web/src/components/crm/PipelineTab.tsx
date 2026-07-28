/**
 * CRM → Pipeline: kanban board by deal stage with HTML5 drag-and-drop.
 * Dropping a card onto a stage calls POST /deals/:id/move; a lost stage prompts
 * for a reason first. Won/Lost columns are tinted; headers show sum + weighted.
 */
import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CalendarClock, ExternalLink, ArrowRightLeft, FolderKanban, Trash2 } from 'lucide-react';
import { api, ApiError } from '../../lib/api';
import { useNavigate } from '../../lib/router';
import { useTabs } from '../../lib/tabs';
import { useCan } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { Avatar, EmptyState, Skeleton, Tooltip, cn, fmtMoney, fmtDate } from '../ui';
import { ContextMenu, ConfirmDialog, toast, type ContextMenuEntry } from '../overlays';
import { LostReasonDialog } from './dialogs';
import {
  useAllDeals, useCompanies, useDealStages, useProjectsLookup,
  useUsersLookup, salesActivityTypeLabel, type Deal, type Stage,
} from './shared';

export function PipelineTab() {
  const t = useT();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const tabs = useTabs();
  const can = useCan();
  const canDelete = can('deals.delete');
  const canWrite = can('deals.write');

  const stagesQ = useDealStages();
  const dealsQ = useAllDeals();
  const companiesQ = useCompanies();
  const usersQ = useUsersLookup();
  const projectsQ = useProjectsLookup();

  const stages = stagesQ.data ?? [];
  const allDeals = dealsQ.data ?? [];
  const companyMap = useMemo(() => new Map((companiesQ.data ?? []).map((c) => [c.id, c])), [companiesQ.data]);
  const userMap = useMemo(() => new Map((usersQ.data ?? []).map((u) => [u.id, u])), [usersQ.data]);
  const projectMap = useMemo(() => new Map((projectsQ.data ?? []).map((p) => [p.id, p])), [projectsQ.data]);
  const nextByDeal = useMemo(() => {
    const map = new Map<string, NonNullable<Deal['nextActivity']>>();
    for (const deal of allDeals) if (deal.nextActivity) map.set(deal.id, deal.nextActivity);
    return map;
  }, [allDeals]);

  // Filter by linked project: '' = all, 'none' = unlinked, otherwise a project id.
  // Chips appear only once at least one deal is linked – zero setup, zero noise.
  const [projectFilter, setProjectFilter] = useState('');
  const linkedProjectIds = useMemo(
    () => [...new Set(allDeals.map((d) => d.projectId).filter((x): x is string => !!x))],
    [allDeals],
  );
  const deals = useMemo(() => {
    if (!projectFilter) return allDeals;
    if (projectFilter === 'none') return allDeals.filter((d) => !d.projectId);
    return allDeals.filter((d) => d.projectId === projectFilter);
  }, [allDeals, projectFilter]);

  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [overStage, setOverStage] = useState<string | null>(null);
  const [lostFor, setLostFor] = useState<{ deal: Deal; stageId: string } | null>(null);
  const [toDelete, setToDelete] = useState<Deal | null>(null);

  const del = useMutation({
    mutationFn: (id: string) => api.del(`/deals/${id}`),
    onSuccess: () => { setToDelete(null); qc.invalidateQueries({ queryKey: ['deals'] }); toast(t('crm.dealDeleted')); },
    onError: (e) => toast.error(e instanceof ApiError ? e.message : t('common.saveFailed')),
  });

  const dealMenu = (d: Deal): ContextMenuEntry[] => {
    const items: ContextMenuEntry[] = [
      { key: 'openDeal', label: t('crm.openDealNewTab'), icon: <ExternalLink size={14} />, onSelect: () => tabs?.openInNewTab(`/deals/${d.id}`) },
    ];
    if (canWrite) {
      items.push({
        key: 'move', label: t('crm.moveToStage'), icon: <ArrowRightLeft size={14} />,
        children: stages.map((s) => ({
          key: s.id, label: s.name, disabled: s.id === d.stageId,
          onSelect: () => {
            if (s.id === d.stageId) return;
            if (s.isLost) { setLostFor({ deal: d, stageId: s.id }); return; }
            move.mutate({ id: d.id, stageId: s.id, version: d.version });
          },
        })),
      });
    }
    if (d.companyId) {
      items.push({ key: 'open', label: t('crm.openCompany'), icon: <ExternalLink size={14} />, onSelect: () => tabs?.openInNewTab(`/companies/${d.companyId}`) });
    }
    if (canDelete) {
      if (items.length) items.push({ type: 'separator' });
      items.push({ key: 'delete', label: t('common.delete'), icon: <Trash2 size={14} />, danger: true, onSelect: () => setToDelete(d) });
    }
    return items;
  };

  const move = useMutation({
    mutationFn: (v: { id: string; stageId: string; lostReason?: string; version?: number }) =>
      api.post(`/deals/${v.id}/move`, { stageId: v.stageId, lostReason: v.lostReason, version: v.version }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['deals'] }); toast(t('crm.moved')); },
    onError: (e) => {
      qc.invalidateQueries({ queryKey: ['deals'] });
      if (e instanceof ApiError && (e.code === 'version_conflict' || e.status === 409)) toast.error(t('crm.conflict'));
      else toast.error(e instanceof ApiError ? e.message : t('deals.moveFailed'));
    },
  });

  const doDrop = (stage: Stage) => {
    setOverStage(null);
    const id = draggingId;
    setDraggingId(null);
    if (!id) return;
    const deal = deals.find((d) => d.id === id);
    if (!deal || deal.stageId === stage.id) return;
    if (stage.isLost) { setLostFor({ deal, stageId: stage.id }); return; }
    move.mutate({ id: deal.id, stageId: stage.id, version: deal.version });
  };

  const loading = stagesQ.isLoading || dealsQ.isLoading;

  if (loading) {
    return (
      <div className="flex gap-3 overflow-x-auto p-6">
        {[0, 1, 2, 3, 4].map((i) => <Skeleton key={i} className="h-72 w-72 shrink-0 rounded-lg" />)}
      </div>
    );
  }
  if (stages.length === 0) {
    return <EmptyState icon={<CalendarClock size={20} />} title={t('deals.noStages')} hint={t('deals.noStagesHint')} />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {linkedProjectIds.length > 0 && (
        <div className="flex flex-wrap items-center gap-1 px-4 pt-3">
          {[
            { key: '', label: t('common.all') },
            ...linkedProjectIds.map((pid) => ({ key: pid, label: projectMap.get(pid)?.name ?? '…' })),
            { key: 'none', label: t('crm.noProject') },
          ].map((chip) => (
            <button
              key={chip.key || 'all'}
              onClick={() => setProjectFilter(chip.key)}
              className={cn(
                'h-7 rounded-md px-2.5 text-xs font-medium transition-colors duration-150',
                projectFilter === chip.key ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted/60 hover:text-foreground',
              )}
            >
              {chip.label}
            </button>
          ))}
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-x-auto">
      <div className="flex h-full gap-3 p-4">
        {stages.map((stage) => {
          const list = deals.filter((d) => d.stageId === stage.id).sort((a, b) => {
            const aDue = nextByDeal.get(a.id)?.dueAt;
            const bDue = nextByDeal.get(b.id)?.dueAt;
            if (!aDue && bDue) return -1;
            if (aDue && !bDue) return 1;
            return (aDue ? new Date(aDue).getTime() : 0) - (bDue ? new Date(bDue).getTime() : 0);
          });
          const totalsByCurrency = new Map<string, number>();
          for (const deal of list) {
            const currency = deal.currency ?? 'USD';
            totalsByCurrency.set(currency, (totalsByCurrency.get(currency) ?? 0) + Number(deal.amount ?? 0));
          }
          if (totalsByCurrency.size === 0) totalsByCurrency.set('USD', 0);
          const totals = [...totalsByCurrency.entries()].sort(([a], [b]) => a.localeCompare(b));
          const totalLabel = totals.map(([currency, amount]) => fmtMoney(amount, currency)).join(' · ');
          const weightedLabel = totals
            .map(([currency, amount]) => fmtMoney(amount * (stage.probability / 100), currency))
            .join(' · ');
          const isOver = overStage === stage.id;
          return (
            <div
              key={stage.id}
              onDragOver={(e) => { e.preventDefault(); if (overStage !== stage.id) setOverStage(stage.id); }}
              onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOverStage((s) => (s === stage.id ? null : s)); }}
              onDrop={(e) => { e.preventDefault(); doDrop(stage); }}
              className={cn(
                'flex w-72 shrink-0 flex-col rounded-lg border transition-colors duration-150',
                isOver && draggingId ? 'border-primary/60 bg-primary/5' : 'border-border',
                stage.isWon && !isOver && 'bg-success/[0.06]',
                stage.isLost && !isOver && 'bg-destructive/[0.05]',
                !stage.isWon && !stage.isLost && !isOver && 'bg-muted/20',
              )}
            >
              {/* Header */}
              <div className="border-b border-border/70 px-3 py-2.5">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[13px] font-medium">
                    {stage.isWon && <span className="h-2 w-2 rounded-full bg-success" />}
                    {stage.isLost && <span className="h-2 w-2 rounded-full bg-destructive" />}
                    {stage.name}
                  </span>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-[11px] font-medium tabular-nums text-muted-foreground">{list.length}</span>
                </div>
                <div className="mt-1 flex items-center justify-between text-xs">
                  <span className="truncate font-semibold tabular-nums" title={totalLabel}>{totalLabel}</span>
                  {!stage.isWon && !stage.isLost && (
                    <Tooltip label={t('crm.weightedShort')}>
                      <span className="max-w-28 truncate tabular-nums text-faint" title={weightedLabel}>≈ {weightedLabel}</span>
                    </Tooltip>
                  )}
                </div>
              </div>

              {/* Cards */}
              <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-2">
                {list.length === 0 ? (
                  <div className={cn(
                    'grid place-items-center rounded-md border border-dashed py-8 text-center text-xs text-faint transition-colors',
                    isOver && draggingId ? 'border-primary/50 text-primary' : 'border-border/70',
                  )}>
                    {isOver && draggingId ? t('crm.dropHere') : t('deals.empty')}
                  </div>
                ) : list.map((d) => {
                  const company = d.companyId ? companyMap.get(d.companyId) : undefined;
                  const owner = d.ownerId ? userMap.get(d.ownerId) : undefined;
                  const project = d.projectId ? projectMap.get(d.projectId) : undefined;
                  const next = nextByDeal.get(d.id);
                  return (
                    <ContextMenu key={d.id} items={dealMenu(d)}>
                    <div
                      draggable
                      onDragStart={(e) => { setDraggingId(d.id); e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', d.id); }}
                      onDragEnd={() => { setDraggingId(null); setOverStage(null); }}
                      onClick={() => navigate(`/deals/${d.id}`)}
                      className={cn(
                        'anim-fade-in group cursor-grab rounded-lg border border-border bg-card p-2.5 shadow-sm transition-all duration-150',
                        'hover:border-border-strong hover:shadow-pop active:cursor-grabbing',
                        draggingId === d.id && 'opacity-40',
                      )}
                    >
                      <p className="text-[13px] font-medium leading-snug">{d.title}</p>
                      {company && (
                        <div className="mt-1.5 flex items-center gap-1.5 text-xs text-muted-foreground">
                          <Avatar name={company.name} size={14} />
                          <span className="truncate">{company.name}</span>
                        </div>
                      )}
                      {project && (
                        <div className="mt-1 flex items-center gap-1 text-[11px] text-faint">
                          <FolderKanban size={11} />
                          <span className="truncate">{project.name}</span>
                          {project.key && <span className="shrink-0 font-mono text-[10px]">{project.key}</span>}
                        </div>
                      )}
                      <div className={cn(
                        'mt-2 flex items-center gap-1 text-[11px]',
                        next?.dueAt && new Date(next.dueAt).getTime() < Date.now() ? 'text-destructive' : 'text-muted-foreground',
                      )}>
                        <CalendarClock size={11} />
                        <span className="truncate">
                          {next
                            ? `${next.subject || salesActivityTypeLabel(t, next.type)}${next.dueAt ? ` · ${fmtDate(next.dueAt)}` : ''}`
                            : t('crm.noNextAction')}
                        </span>
                      </div>
                      <div className="mt-2 flex items-center justify-between">
                        <span className="text-[13px] font-semibold tabular-nums">
                          {d.amount != null ? fmtMoney(d.amount, d.currency ?? 'USD') : '–'}
                        </span>
                        <div className="flex items-center gap-2">
                          {d.expectedCloseDate && (
                            <span className="flex items-center gap-1 text-[11px] text-faint">
                              <CalendarClock size={11} /> {fmtDate(d.expectedCloseDate)}
                            </span>
                          )}
                          {owner && <Avatar name={owner.name} src={owner.avatar} size={18} />}
                        </div>
                      </div>
                    </div>
                    </ContextMenu>
                  );
                })}
              </div>
            </div>
          );
        })}
      </div>
      </div>

      <LostReasonDialog
        open={!!lostFor}
        pending={move.isPending}
        onClose={() => setLostFor(null)}
        onConfirm={(reason) => {
          if (!lostFor) return;
          move.mutate({ id: lostFor.deal.id, stageId: lostFor.stageId, lostReason: reason || undefined, version: lostFor.deal.version });
          setLostFor(null);
        }}
      />

      <ConfirmDialog
        open={!!toDelete}
        onClose={() => setToDelete(null)}
        onConfirm={() => toDelete && del.mutate(toDelete.id)}
        title={t('crm.deleteDealTitle')}
        body={toDelete ? t('crm.deleteDealBody').replace('{name}', toDelete.title) : ''}
        confirmLabel={t('common.delete')}
        danger
        pending={del.isPending}
      />
    </div>
  );
}
