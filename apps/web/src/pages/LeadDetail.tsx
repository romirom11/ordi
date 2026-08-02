import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, ChevronRight, Copy, ExternalLink, Target } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { Link, useNavigate } from '../lib/router';
import { useCan } from '../lib/auth';
import { usePageTitle } from '../lib/tabs';
import { useT } from '../lib/i18n';
import {
  Button, Card, RailChip, RailField, Select, Skeleton, Tooltip, fmtDate, fmtRelative,
} from '../components/ui';
import { toast } from '../components/overlays';
import {
  WRITABLE_LEAD_STATUSES, StatusPill, salesActivityTypeLabel,
  useContacts, useDealStages, useLead, useSalesActivities, useUsersLookup,
} from '../components/crm/shared';
import {
  EditableName, InlineEdit, NotesSection, OwnerRailValue, SectionHeader,
} from '../components/crm/detail';
import { FilesSection } from '../components/FilesSection';
import { SalesActivityPanel } from '../components/crm/SalesActivityPanel';
import { ContactDialog } from '../components/crm/dialogs';

const NEW_CONTACT = '__new__';

export function LeadDetailPage({ id }: { id: string }) {
  const t = useT();
  const can = useCan();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const leadQ = useLead(id);
  const activitiesQ = useSalesActivities({ leadId: id, status: 'planned' });
  const stagesQ = useDealStages();
  const usersQ = useUsersLookup();
  const [addingContact, setAddingContact] = useState(false);
  const lead = leadQ.data;
  const contactsQ = useContacts(lead?.companyId);
  usePageTitle(lead?.title);
  const canWrite = can('crm.write');
  /** A converted lead is a record of what happened, so it freezes. */
  const editable = canWrite && lead?.status !== 'converted';
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
        <div className="min-w-0 flex-1">
          <EditableName value={lead.title} editable={editable} size="sm" onSave={(title) => patch.mutate({ title })} />
        </div>
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
          {/*
            * Conversion is gated on `engaged`, and a button that simply is not
            * there teaches nobody why. Show it throughout the live part of the
            * lifecycle and say what is missing when it is not yet time.
            */}
          {canConvert && lead.status !== 'converted' && firstQualifiedStage && (
            <Tooltip label={lead.status === 'engaged' ? undefined : t('crm.convertNeedsEngaged')}>
              <Button
                size="sm"
                onClick={() => convert.mutate()}
                disabled={convert.isPending || lead.status !== 'engaged'}
              >
                <CheckCircle2 size={13} /> {t('crm.convertToDeal')}
              </Button>
            </Tooltip>
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
              <SectionHeader icon={<Target size={15} />} title={t('crm.qualification')} />
              <div className="grid gap-3 md:grid-cols-2">
                <QualificationCard title={t('crm.painSignal')} hint={t('crm.painSignalHint')} value={lead.painSignal} editable={editable} onSave={(painSignal) => patch.mutate({ painSignal })} />
                <QualificationCard title={t('crm.whyFit')} hint={t('crm.whyFitHint')} value={lead.whyFit} editable={editable} onSave={(whyFit) => patch.mutate({ whyFit })} />
                <QualificationCard title={t('crm.whyNow')} hint={t('crm.whyNowHint')} value={lead.whyNow} editable={editable} onSave={(whyNow) => patch.mutate({ whyNow })} />
                <QualificationCard title={t('crm.evidence')} hint={t('crm.evidenceHint')} value={lead.evidence} editable={editable} onSave={(evidence) => patch.mutate({ evidence })} />
              </div>
              {(editable || lead.caution) && (
                <div className="mt-3 flex gap-2 rounded-lg border border-warning/30 bg-warning/5 p-3">
                  <AlertTriangle size={15} className="mt-1.5 shrink-0 text-warning" />
                  <div className="min-w-0 flex-1">
                    <p className="px-2 text-[13px] font-medium">{t('crm.caution')}</p>
                    <InlineEdit multiline value={lead.caution} editable={editable} rows={2} placeholder={t('crm.cautionHint')} onSave={(caution) => patch.mutate({ caution })} />
                  </div>
                </div>
              )}
              {(editable || lead.opener) && (
                <Card className="mt-3 p-3">
                  <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-faint">{t('crm.opener')}</p>
                  <InlineEdit multiline value={lead.opener} editable={editable} rows={4} placeholder={t('crm.openerHint')} onSave={(opener) => patch.mutate({ opener })} />
                </Card>
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
                {editable ? (
                  <Select className="w-full border-0" value={lead.status} onChange={(event) => patch.mutate({ status: event.target.value })}>
                    {WRITABLE_LEAD_STATUSES.filter((status) => (
                      // nurture needs a return date, so it stays available only to a lead already in it
                      status !== 'nurture' || lead.status === 'nurture'
                    )).map((status) => (
                      <option key={status} value={status}>{t(`crm.status.${status}`)}</option>
                    ))}
                  </Select>
                ) : <RailChip disabled><StatusPill status={lead.status} /></RailChip>}
              </RailField>
              <RailField label={t('crm.company')}>
                <Link to={`/companies/${lead.companyId}`}><RailChip>{lead.companyName || lead.title}</RailChip></Link>
              </RailField>
              <RailField label={t('crm.contact')}>
                {editable ? (
                  <Select
                    className="w-full border-0"
                    value={lead.contactId ?? ''}
                    onChange={(event) => {
                      // A prospect with no contact cannot be reached, and the company
                      // may well have none yet – so the picker can create one.
                      if (event.target.value === NEW_CONTACT) { setAddingContact(true); return; }
                      patch.mutate({ contactId: event.target.value || null });
                    }}
                  >
                    <option value="">{t('crm.noContact')}</option>
                    <option value={NEW_CONTACT}>{t('crm.newContactOption')}</option>
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
              <RailField label={t('crm.owner')}>
                <OwnerRailValue
                  ownerId={lead.ownerId}
                  users={usersQ.data ?? []}
                  editable={editable}
                  onPick={(ownerId) => patch.mutate({ ownerId })}
                />
              </RailField>
              <RailField label={t('crm.product')}>
                <InlineEdit value={lead.product} editable={editable} placeholder={t('crm.productHint')} onSave={(product) => patch.mutate({ product })} />
              </RailField>
              <RailField label={t('crm.score')}>
                <InlineEdit value={lead.score} editable={editable} inputType="number" placeholder={t('crm.scoreHint')} onSave={(score) => patch.mutate({ score: score === null ? null : Number(score) })} />
              </RailField>
              <RailField label={t('crm.signal')}>
                <InlineEdit value={lead.signal} editable={editable} placeholder={t('crm.signalHint')} onSave={(signal) => patch.mutate({ signal })} />
              </RailField>
              <RailField label={t('crm.source')}>
                <InlineEdit value={lead.sourceTitle} editable={editable} placeholder={t('crm.sourceHint')} onSave={(sourceTitle) => patch.mutate({ sourceTitle })} />
              </RailField>
              <RailField label={t('crm.sourceLink')}>
                <InlineEdit value={lead.sourceUrl} editable={editable} inputType="url" placeholder="https://…" onSave={(sourceUrl) => patch.mutate({ sourceUrl })} />
              </RailField>
              <RailField label={t('crm.suggestedChannel')}>
                <InlineEdit value={lead.suggestedChannel} editable={editable} placeholder={t('crm.suggestedChannelHint')} onSave={(suggestedChannel) => patch.mutate({ suggestedChannel })} />
              </RailField>
              {lead.sourceCheckedAt && (
                <RailField label={t('crm.sourceChecked')}><RailChip disabled>{fmtDate(lead.sourceCheckedAt)}</RailChip></RailField>
              )}
              <RailField label={t('crm.created')}><RailChip disabled>{fmtDate(lead.createdAt)}</RailChip></RailField>
            </div>
          </div>
          {lead.status !== 'converted' && (
            <FilesSection entityType="lead" entityId={id} canWrite={canWrite} variant="rail" />
          )}
        </aside>
      </div>

      <ContactDialog
        open={addingContact}
        onClose={() => setAddingContact(false)}
        companyId={lead.companyId}
        onCreated={(contact) => patch.mutate({ contactId: contact.id })}
      />
    </div>
  );
}

function QualificationCard({ title, hint, value, editable, onSave }: {
  title: string;
  hint: string;
  value?: string | null;
  editable: boolean;
  onSave: (value: string | null) => void;
}) {
  return (
    <Card className="p-3">
      <p className="mb-1 px-2 text-xs font-semibold uppercase tracking-wide text-faint">{title}</p>
      <InlineEdit multiline value={value} editable={editable} placeholder={hint} onSave={onSave} />
    </Card>
  );
}
