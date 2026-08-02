/**
 * Sales analytics: the numbers a seller (or their lead) cannot read off the
 * board – lead funnel counts, lead → deal conversion, win rate, pipeline value
 * by stage and the reasons deals are lost.
 *
 * Everything here is a live snapshot of the base tables plus createdAt-based
 * intake trends. Deals carry no closed-at timestamp, so won/lost figures are
 * all-time state, not "closed this month" – better an honest total than a
 * period metric quietly computed from the wrong column.
 */
import { getDb, schema, sql, eq, and, isNull, desc, asc } from '@ordi/db';
import { LEAD_STATUSES } from '@ordi/shared';

const DAY_MS = 86_400_000;

interface CurrencyTotal {
  currency: string;
  amount: number;
}

export interface SalesAnalytics {
  leads: {
    /** Live (non-deleted) leads, terminal statuses included. */
    total: number;
    byStatus: Record<string, number>;
    new30d: number;
    prev30d: number;
    resolved: { converted: number; disqualified: number; noResponse: number };
    /** converted / all leads that reached an end state; null before any did. */
    conversionRate: number | null;
  };
  /** null when the caller cannot read deals. */
  deals: {
    stages: Array<{
      id: string;
      name: string;
      position: number;
      probability: number;
      isWon: boolean;
      isLost: boolean;
      count: number;
      totals: CurrencyTotal[];
    }>;
    openCount: number;
    wonCount: number;
    lostCount: number;
    /** won / (won + lost); null until a deal has closed either way. */
    winRate: number | null;
    openTotals: CurrencyTotal[];
    weightedOpenTotals: CurrencyTotal[];
    wonTotals: CurrencyTotal[];
    lostReasons: Array<{ reason: string | null; count: number }>;
  } | null;
}

function sortTotals(map: Map<string, number>): CurrencyTotal[] {
  return [...map.entries()]
    .map(([currency, amount]) => ({ currency, amount }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

function addTo(map: Map<string, number>, currency: string, amount: number): void {
  if (!amount) return;
  map.set(currency, (map.get(currency) ?? 0) + amount);
}

export async function salesAnalytics(params: { includeDeals: boolean; now?: Date }): Promise<SalesAnalytics> {
  const { db } = getDb();
  const now = params.now ?? new Date();
  // Raw fragments take the params as strings: the driver refuses a bare Date there.
  const d30 = new Date(now.getTime() - 30 * DAY_MS).toISOString();
  const d60 = new Date(now.getTime() - 60 * DAY_MS).toISOString();

  const [statusRows, [trend]] = await Promise.all([
    db.select({ status: schema.leads.status, count: sql<number>`count(*)::int` })
      .from(schema.leads)
      .where(isNull(schema.leads.deletedAt))
      .groupBy(schema.leads.status),
    db.select({
      new30d: sql<number>`count(*) filter (where ${schema.leads.createdAt} >= ${d30}::timestamptz)::int`,
      prev30d: sql<number>`
        count(*) filter (
          where ${schema.leads.createdAt} >= ${d60}::timestamptz
            and ${schema.leads.createdAt} < ${d30}::timestamptz
        )::int
      `,
    }).from(schema.leads).where(and(
      isNull(schema.leads.deletedAt),
      sql`${schema.leads.createdAt} >= ${d60}::timestamptz`,
    )),
  ]);

  const byStatus: Record<string, number> = Object.fromEntries(LEAD_STATUSES.map((status) => [status, 0]));
  let total = 0;
  for (const row of statusRows) {
    byStatus[row.status] = Number(row.count);
    total += Number(row.count);
  }
  const resolved = {
    converted: byStatus['converted'] ?? 0,
    disqualified: byStatus['disqualified'] ?? 0,
    noResponse: byStatus['no_response'] ?? 0,
  };
  const resolvedTotal = resolved.converted + resolved.disqualified + resolved.noResponse;

  const leads: SalesAnalytics['leads'] = {
    total,
    byStatus,
    new30d: Number(trend?.new30d ?? 0),
    prev30d: Number(trend?.prev30d ?? 0),
    resolved,
    conversionRate: resolvedTotal ? resolved.converted / resolvedTotal : null,
  };

  if (!params.includeDeals) return { leads, deals: null };

  const [stageRows, dealRows, lostReasonRows] = await Promise.all([
    db.select().from(schema.dealStages).orderBy(asc(schema.dealStages.position)),
    db.select({
      stageId: schema.deals.stageId,
      currency: schema.deals.currency,
      count: sql<number>`count(*)::int`,
      amount: sql<number>`coalesce(sum(${schema.deals.amount}), 0)::float`,
    }).from(schema.deals)
      .where(isNull(schema.deals.deletedAt))
      .groupBy(schema.deals.stageId, schema.deals.currency),
    db.select({
      reason: schema.deals.lostReason,
      count: sql<number>`count(*)::int`,
    }).from(schema.deals)
      .innerJoin(schema.dealStages, eq(schema.deals.stageId, schema.dealStages.id))
      .where(and(isNull(schema.deals.deletedAt), eq(schema.dealStages.isLost, true)))
      .groupBy(schema.deals.lostReason)
      .orderBy(desc(sql`count(*)`), asc(schema.deals.lostReason))
      .limit(8),
  ]);

  const byStage = new Map<string, { count: number; totals: Map<string, number> }>();
  for (const row of dealRows) {
    const entry = byStage.get(row.stageId) ?? { count: 0, totals: new Map<string, number>() };
    entry.count += Number(row.count);
    addTo(entry.totals, row.currency, Number(row.amount));
    byStage.set(row.stageId, entry);
  }

  let openCount = 0;
  let wonCount = 0;
  let lostCount = 0;
  const openTotals = new Map<string, number>();
  const weightedOpenTotals = new Map<string, number>();
  const wonTotals = new Map<string, number>();

  const stages = stageRows.map((stage) => {
    const entry = byStage.get(stage.id) ?? { count: 0, totals: new Map<string, number>() };
    if (stage.isWon) {
      wonCount += entry.count;
      for (const [currency, amount] of entry.totals) addTo(wonTotals, currency, amount);
    } else if (stage.isLost) {
      lostCount += entry.count;
    } else {
      openCount += entry.count;
      for (const [currency, amount] of entry.totals) {
        addTo(openTotals, currency, amount);
        addTo(weightedOpenTotals, currency, amount * (stage.probability / 100));
      }
    }
    return {
      id: stage.id,
      name: stage.name,
      position: stage.position,
      probability: stage.probability,
      isWon: stage.isWon,
      isLost: stage.isLost,
      count: entry.count,
      totals: sortTotals(entry.totals),
    };
  });

  const closedCount = wonCount + lostCount;
  return {
    leads,
    deals: {
      stages,
      openCount,
      wonCount,
      lostCount,
      winRate: closedCount ? wonCount / closedCount : null,
      openTotals: sortTotals(openTotals),
      weightedOpenTotals: sortTotals(weightedOpenTotals),
      wonTotals: sortTotals(wonTotals),
      lostReasons: lostReasonRows.map((row) => ({ reason: row.reason, count: Number(row.count) })),
    },
  };
}
