/** Receivables aging buckets (PRD §11.9): 0-30 / 31-60 / 61-90 / 90+. */

export interface AgingRow {
  currency: string;
  bucket_0_30: number;
  bucket_31_60: number;
  bucket_61_90: number;
  bucket_90_plus: number;
  total: number;
}

export interface OpenInvoice {
  currency: string;
  outstanding: number;
  dueDate: string; // ISO
}

export function computeAging(invoices: OpenInvoice[], asOf: string): AgingRow[] {
  const asOfMs = Date.parse(asOf.slice(0, 10));
  const byCurrency = new Map<string, AgingRow>();
  for (const inv of invoices) {
    if (inv.outstanding <= 0) continue;
    const row = byCurrency.get(inv.currency) ?? {
      currency: inv.currency,
      bucket_0_30: 0, bucket_31_60: 0, bucket_61_90: 0, bucket_90_plus: 0, total: 0,
    };
    const daysOverdue = Math.floor((asOfMs - Date.parse(inv.dueDate.slice(0, 10))) / 86400000);
    if (daysOverdue <= 30) row.bucket_0_30 += inv.outstanding;
    else if (daysOverdue <= 60) row.bucket_31_60 += inv.outstanding;
    else if (daysOverdue <= 90) row.bucket_61_90 += inv.outstanding;
    else row.bucket_90_plus += inv.outstanding;
    row.total += inv.outstanding;
    byCurrency.set(inv.currency, row);
  }
  return [...byCurrency.values()].map((r) => ({
    ...r,
    bucket_0_30: round2(r.bucket_0_30),
    bucket_31_60: round2(r.bucket_31_60),
    bucket_61_90: round2(r.bucket_61_90),
    bucket_90_plus: round2(r.bucket_90_plus),
    total: round2(r.total),
  }));
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
