/**
 * CRM → Analytics: the questions the board cannot answer at a glance – how the
 * lead funnel is shaped, how often leads become deals, how often deals are won
 * and why they are lost. All figures are a live snapshot (deals carry no
 * closed-at date), plus a 30-day lead-intake trend from createdAt.
 */
import { BarChart3, TrendingDown, TrendingUp } from 'lucide-react';
import { useCan } from '../../lib/auth';
import { useT } from '../../lib/i18n';
import { Card, EmptyState, Skeleton, cn, fmtMoney } from '../ui';
import {
  LEAD_STATUSES, useSalesAnalytics,
  type CurrencyTotal, type SalesAnalytics,
} from './shared';

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

function money(totals: CurrencyTotal[]): string {
  if (!totals.length) return fmtMoney(0, 'USD');
  return totals.map(({ currency, amount }) => fmtMoney(amount, currency)).join(' · ');
}

export function AnalyticsTab() {
  const t = useT();
  const can = useCan();
  const analyticsQ = useSalesAnalytics();

  if (analyticsQ.isLoading) {
    return <div className="space-y-3 p-6">{[0, 1, 2].map((key) => <Skeleton key={key} className="h-28" />)}</div>;
  }
  const data = analyticsQ.data;
  if (!data) return <EmptyState title={t('common.error')} />;

  const { leads } = data;
  const deals = can('deals.read') ? data.deals : null;
  if (leads.total === 0 && !deals?.stages.some((stage) => stage.count > 0)) {
    return (
      <EmptyState
        icon={<BarChart3 size={20} />}
        title={t('crm.analytics.noData')}
        hint={t('crm.analytics.noDataHint')}
      />
    );
  }

  const delta = leads.new30d - leads.prev30d;

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="mx-auto max-w-5xl space-y-8">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StatTile label={t('crm.analytics.totalLeads')} value={String(leads.total)} />
          <StatTile
            label={t('crm.analytics.new30d')}
            value={String(leads.new30d)}
            hint={(
              <span className={cn('flex items-center gap-1', delta > 0 ? 'text-success' : delta < 0 ? 'text-destructive' : 'text-faint')}>
                {delta > 0 ? <TrendingUp size={12} /> : delta < 0 ? <TrendingDown size={12} /> : null}
                {t('crm.analytics.vsPrev').replace('{n}', String(leads.prev30d))}
              </span>
            )}
          />
          <StatTile
            label={t('crm.analytics.conversion')}
            value={pct(leads.conversionRate)}
            hint={t('crm.analytics.conversionHint')}
          />
          {deals && (
            <StatTile
              label={t('crm.analytics.winRate')}
              value={pct(deals.winRate)}
              hint={t('crm.analytics.winRateHint')
                .replace('{won}', String(deals.wonCount))
                .replace('{lost}', String(deals.lostCount))}
            />
          )}
        </div>

        <section>
          <h2 className="mb-3 text-[13px] font-semibold">{t('crm.analytics.funnel')}</h2>
          <Card className="p-4">
            <BarList
              rows={LEAD_STATUSES
                .map((status) => ({ key: status, label: t(`crm.status.${status}`), count: leads.byStatus[status] ?? 0 }))
                .filter((row) => row.count > 0)}
            />
          </Card>
        </section>

        {deals && (
          <>
            <section>
              <h2 className="mb-3 text-[13px] font-semibold">{t('crm.analytics.pipeline')}</h2>
              <Card className="p-4">
                <PipelineStages deals={deals} />
              </Card>
              <div className="mt-3 grid gap-3 sm:grid-cols-3">
                <StatTile label={t('crm.analytics.openValue')} value={money(deals.openTotals)} small />
                <StatTile label={t('crm.analytics.weighted')} value={`≈ ${money(deals.weightedOpenTotals)}`} small />
                <StatTile label={t('crm.analytics.wonValue')} value={money(deals.wonTotals)} small />
              </div>
            </section>

            {deals.lostReasons.length > 0 && (
              <section>
                <h2 className="mb-3 text-[13px] font-semibold">{t('crm.analytics.lostReasons')}</h2>
                <Card className="p-4">
                  <BarList
                    tone="destructive"
                    rows={deals.lostReasons.map((row, index) => ({
                      key: row.reason ?? `none-${index}`,
                      label: row.reason || t('crm.analytics.noReason'),
                      count: row.count,
                    }))}
                  />
                </Card>
              </section>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function StatTile({ label, value, hint, small }: {
  label: string;
  value: string;
  hint?: React.ReactNode;
  small?: boolean;
}) {
  return (
    <Card className="p-3">
      <p className="text-[11px] font-semibold uppercase tracking-wide text-faint">{label}</p>
      <p className={cn('mt-1 font-semibold tabular-nums', small ? 'truncate text-[15px]' : 'text-xl')} title={value}>{value}</p>
      {hint && <p className="mt-0.5 text-[11px] text-muted-foreground">{hint}</p>}
    </Card>
  );
}

/** Horizontal count bars, scaled to the largest row. */
function BarList({ rows, tone = 'primary' }: {
  rows: Array<{ key: string; label: string; count: number }>;
  tone?: 'primary' | 'destructive';
}) {
  if (!rows.length) return null;
  const max = Math.max(...rows.map((row) => row.count));
  return (
    <div className="space-y-2">
      {rows.map((row) => (
        <div key={row.key} className="flex items-center gap-3 text-[13px]">
          <span className="w-40 shrink-0 truncate text-muted-foreground" title={row.label}>{row.label}</span>
          <div className="h-4 min-w-0 flex-1 rounded-sm bg-muted/60">
            <div
              className={cn('h-full rounded-sm', tone === 'destructive' ? 'bg-destructive/50' : 'bg-primary/50')}
              style={{ width: `${Math.max((row.count / max) * 100, 2)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-medium tabular-nums">{row.count}</span>
        </div>
      ))}
    </div>
  );
}

function PipelineStages({ deals }: { deals: NonNullable<SalesAnalytics['deals']> }) {
  const t = useT();
  const max = Math.max(...deals.stages.map((stage) => stage.count), 1);
  return (
    <div className="space-y-2">
      {deals.stages.map((stage) => (
        <div key={stage.id} className="flex items-center gap-3 text-[13px]">
          <span className="flex w-40 shrink-0 items-center gap-1.5 truncate text-muted-foreground" title={stage.name}>
            {stage.isWon && <span className="h-2 w-2 shrink-0 rounded-full bg-success" />}
            {stage.isLost && <span className="h-2 w-2 shrink-0 rounded-full bg-destructive" />}
            <span className="truncate">{stage.name}</span>
          </span>
          <div className="h-4 min-w-0 flex-1 rounded-sm bg-muted/60">
            <div
              className={cn(
                'h-full rounded-sm',
                stage.isWon ? 'bg-success/60' : stage.isLost ? 'bg-destructive/50' : 'bg-primary/50',
              )}
              style={{ width: `${Math.max((stage.count / max) * 100, stage.count ? 2 : 0)}%` }}
            />
          </div>
          <span className="w-10 shrink-0 text-right font-medium tabular-nums">{stage.count}</span>
          <span className="hidden w-40 shrink-0 truncate text-right text-xs text-muted-foreground sm:block" title={money(stage.totals)}>
            {stage.totals.length ? money(stage.totals) : '—'}
          </span>
        </div>
      ))}
      {deals.stages.every((stage) => stage.count === 0) && (
        <p className="text-[13px] text-muted-foreground">{t('deals.empty')}</p>
      )}
    </div>
  );
}
