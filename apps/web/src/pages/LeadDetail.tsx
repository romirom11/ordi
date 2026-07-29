import { useMemo } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Copy, ExternalLink, Target } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { useT } from '../lib/i18n';
import {
  Badge, Button, Card, RailChip, RailField, Select, Skeleton, fmtDate, fmtRelative,
} from '../components/ui';
import { toast } from '../components/overlays';
import {
  LEAD_STATUSES, StatusPill, salesActivityTypeLabel,
  useContacts, useDealStages, useLead, useSalesActivities,
} from '../components/crm/shared';
import { FilesSection, NotesSection, SectionHeader } from '../components/crm/detail';
import { SalesActivityPanel } from '../components/crm/SalesActivityPanel';

export function LeadDetailPage({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const leadQ = useLead(id);
  const activitiesQ = useSalesActivities({ leadId: id, status: 'planned' });
  const stagesQ = useDealStages();
  const lead = leadQ.data;
  const contactsQ = useContacts(lead?.companyId);
  usePageTitle(lead?.title);
  const canWrite = can('crm.write');
  const canConvert = canWrite && can('deals.write');
  const next = activitiesQ.data?.[0];
  const firstQualifiedStage = useMemo(
    () => (stagesQ.data ?? []).find((stage) => !stage.isWon && !stage.isLost),
    [stagesQ.data],
  );

  const patch = useMutation({
    mutationFn: (body: Record<string, unknown>) => api.patch(`/leads/${id}`, { ...body, version: lead?.version }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['lead', id] });
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      toast(t('common.saved'));
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t('common.error')),
  });
  const convert = useMutation({
    mutationFn: () => api.post<{ dealId: string }>(`/leads/${id}/convert`, { stageId: firstQualifiedStage?.id }),
    onSuccess: (result) => {
      qc.invalidateQueries({ queryKey: ['leads'] });
      qc.invalidateQueries({ queryKey: ['deals'] });
      qc.invalidateQueries({ queryKey: ['sales-work'] });
      toast(t('crm.converted'));
      navigate(`/deals/${result.dealId}`);
    },
    onError: (error) => toast.error(error instanceof ApiError ? error.message : t('common.error')),
  });

  if (leadQ.isLoading) {
    return <div className="space-y-4 p-6"><Skeleton className="h-8 w-64" /><Skeleton className="h-40" /><Skeleton className="h-64" /></div>;
  }
  if (!lead) return <div className="p-6 text-sm text-muted-foreground">{t('common.error')}</div>;

  const copyOpener = async () => {
    if (!lead.opener) return;
    try {
      await navigator.clipboard.writeText(lead.opener);
      toast(t('crm.openerCopied'));
    } catch {
      toast.error(t('common.error'));
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex min-h-11 shrink-0 items-center gap-2 border-b border-border px-4 py-2">
        <Link to="/crm" className="hidden text-[13px] text-muted-foreground hover:text-foreground sm:block">{t('crm.title')}</Link>
        <ChevronRight size={12} className="hidden text-faint sm:block" />
        <Link to="/crm/leads" className="hidden text-[13px] text-muted-foreground hover:text-foreground sm:block">{t('crm.tabLeads')}</Link>
        <ChevronRight size={12} className="hidden text-faint sm:block" />
        <Target size={16} className="shrink-0 text-warning" />
        <span className="min-w-0 flex-1 truncate text-[13px] font-semibold">{lead.title}</span>
        <div className="flex shrink-0 items-center gap-2">
          {lead.opener && <Button size="sm" variant="outline" onClick={copyOpener}><Copy size={13} /> {t('crm.copyOpener')}</Button>}
          {lead.sourceUrl && (
            <a
              href={lead.sourceUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex h-7 select-none items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-border bg-card px-2.5 text-[13px] font-medium text-foreground transition-all duration-150 ease-smooth-out hover:border-border-strong hover:bg-muted active:scale-[0.98]"
            >
              <ExternalLink size={13} /> {t('crm.openSource')}
            </a>
          )}
          {canConvert && lead.status === 'engaged' && firstQualifiedStage && (
            <Button size="sm" onClick={() => convert.mutate()} disabled={convert.isPending}>
              <CheckCircle2 size={13} /> {t('crm.convertToDeal')}
            </Button>
          )}
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col min-[1050px]:flex-row">
        <main className="order-2 min-w-0 flex-1 overflow-auto min-[1050px]:order-1">
          <div className="space-y-7 px-6 py-6">
            <Card className={`p-4 ${next ? 'border-primary/30' : 'border-warning/40'}`}>
              <div className="flex items-start gap-3">
                {next ? <CheckCircle2 size={18} className="mt-0.5 text-primary" /> : <AlertTriangle size={18} className="mt-0.5 text-warning" />}
                <div className="min-w-0 flex-1">
                  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">{t('crm.nextAction')}</p>
                  <p className="mt-1 text-sm font-medium">
                    {next?.subject || (next?.type ? salesActivityTypeLabel(t, next.type) : t('crm.noNextAction'))}
                  </p>
                  {next?.dueAt && <p className="mt-0.5 text-xs text-muted-foreground">{fmtDate(next.dueAt)} · {fmtRelative(next.dueAt)}</p>}
                </div>
              </div>
            </Card>

            <section>
              <SectionHeader icon={<Target size={15} />} title={t('crm.research')} />
              <div className="grid gap-3 md:grid-cols-2">
                <ResearchCard title={t('crm.painSignal')} body={lead.painSignal} />
                <ResearchCard title={t('crm.whyFit')} body={lead.whyFit} />
                <ResearchCard title={t('crm.whyNow')} body={lead.whyNow} />
                <ResearchCard title={t('crm.evidence')} body={lead.evidence} />
              </div>
              {lead.caution && (
                <div className="mt-3 flex gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3 text-[13px]">
                  <AlertTriangle size={15} className="mt-0.5 shrink-0 text-warning" />
                  <div><p className="font-medium">{t('crm.caution')}</p><p className="mt-0.5 text-muted-foreground">{lead.caution}</p></div>
                </div>
              )}
              {lead.opener && (
                <Card className="mt-3 p-3">
                  <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.opener')}</p>
                  <p className="whitespace-pre-wrap text-[13px] leading-relaxed">{lead.opener}</p>
                </Card>
              )}
              {!!lead.secondarySources?.length && (
                <div className="mt-3">
                  <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.sources')}</p>
                  <div className="grid gap-2 md:grid-cols-2">
                    {lead.secondarySources.map((source, index) => (
                      <a
                        key={`${source.url}:${index}`}
                        href={source.url}
                        target="_blank"
                        rel="noreferrer"
                        className="rounded-lg border border-border p-3 transition-colors hover:border-border-strong hover:bg-muted/40"
                      >
                        <span className="flex items-center gap-1.5 text-[13px] font-medium">
                          <ExternalLink size={12} /> {source.title}
                        </span>
                        {source.supports && <span className="mt-1 block text-xs text-muted-foreground">{source.supports}</span>}
                      </a>
                    ))}
                  </div>
                </div>
              )}
            </section>

            {lead.status === 'converted' && lead.convertedDealId ? (
              <Card className="flex items-center justify-between gap-3 border-primary/30 p-4">
                <p className="text-[13px] text-muted-foreground">{t('crm.convertedHistoryMoved')}</p>
                <Link
                  to={`/deals/${lead.convertedDealId}`}
                  className="inline-flex shrink-0 items-center gap-1 text-[13px] font-medium text-primary hover:underline"
                >
                  {t('crm.deal')} <ChevronRight size={13} />
                </Link>
              </Card>
            ) : (
              <>
                <SalesActivityPanel
                  leadId={id}
                  companyId={lead.companyId}
                  contactId={lead.contactId}
                  canWrite={canWrite}
                />
                <NotesSection leadId={id} canWrite={canWrite} />
              </>
            )}
          </div>
        </main>

        <aside className="order-1 shrink-0 space-y-6 overflow-auto border-b border-border p-4 min-[1050px]:order-2 min-[1050px]:w-80 min-[1050px]:border-b-0 min-[1050px]:border-l">
          <div>
            <h2 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-faint">{t('crm.properties')}</h2>
            <div className="space-y-0.5">
              <RailField label={t('common.status')}>
                {canWrite && lead.status !== 'converted' ? (
                  <Select className="w-full border-0" value={lead.status} onChange={(event) => patch.mutate({ status: event.target.value })}>
                    {LEAD_STATUSES.filter((status) => (
                      status !== 'converted' && (status !== 'nurture' || lead.status === 'nurture')
                    )).map((status) => (
                      <option key={status} value={status}>{t(`crm.status.${status}`)}</option>
                    ))}
                  </Select>
                ) : <RailChip disabled><StatusPill status={lead.status} /></RailChip>}
              </RailField>
              <RailField label={t('crm.company')}>
                <Link to={`/companies/${lead.companyId}`}><RailChip>{lead.companyName || lead.title}</RailChip></Link>
              </RailField>
              <RailField label={t('crm.contacts')}>
                {canWrite && lead.status !== 'converted' ? (
                  <Select
                    className="w-full border-0"
                    value={lead.contactId ?? ''}
                    onChange={(event) => patch.mutate({ contactId: event.target.value || null })}
                  >
                    <option value="">{t('crm.noContact')}</option>
                    {(contactsQ.data ?? []).map((contact) => (
                      <option key={contact.id} value={contact.id}>
                        {[contact.firstName, contact.lastName].filter(Boolean).join(' ')}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <RailChip disabled empty={!lead.contact}>
                    {lead.contact
                      ? [lead.contact.firstName, lead.contact.lastName].filter(Boolean).join(' ')
                      : '—'}
                  </RailChip>
                )}
              </RailField>
              <RailField label={t('crm.product')}><RailChip disabled empty={!lead.product}>{lead.product || '—'}</RailChip></RailField>
              <RailField label={t('crm.score')}><RailChip disabled><Badge>{lead.score ?? '—'}</Badge></RailChip></RailField>
              <RailField label={t('crm.signal')}><RailChip disabled empty={!lead.signal}>{lead.signal || '—'}</RailChip></RailField>
              <RailField label={t('crm.source')}><RailChip disabled empty={!lead.sourceTitle}>{lead.sourceTitle || lead.sourceType || '—'}</RailChip></RailField>
              <RailField label={t('crm.sourceChecked')}><RailChip disabled empty={!lead.sourceCheckedAt}>{lead.sourceCheckedAt ? fmtDate(lead.sourceCheckedAt) : '—'}</RailChip></RailField>
              <RailField label={t('crm.suggestedChannel')}><RailChip disabled empty={!lead.suggestedChannel}>{lead.suggestedChannel || '—'}</RailChip></RailField>
              <RailField label={t('crm.created')}><RailChip disabled>{fmtDate(lead.createdAt)}</RailChip></RailField>
            </div>
          </div>
          {lead.status !== 'converted' && (
            <FilesSection entityType="lead" entityId={id} canWrite={canWrite} variant="rail" />
          )}
        </aside>
      </div>
    </div>
  );
}

function ResearchCard({ title, body }: { title: string; body?: string | null }) {
  return (
    <Card className="p-3">
      <p className="mb-1 text-xs font-semibold uppercase tracking-wide text-faint">{title}</p>
      <p className="text-[13px] leading-relaxed text-muted-foreground">{body || '—'}</p>
    </Card>
  );
}
