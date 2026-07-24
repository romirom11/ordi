/**
 * Pure money math for invoices & quotes (PRD §11.3, §11.4). Server is the only
 * authority for totals; this module is the single implementation, unit-tested.
 * All amounts are handled in integer cents internally to avoid float drift.
 */

export interface LineItem {
  quantity: number;
  unitPrice: number;
  taxRatePercent?: number | null;
}

export interface DocumentTotalsInput {
  items: LineItem[];
  discountType?: 'none' | 'percent' | 'fixed';
  discountValue?: number;
  /** true => discount applied to subtotal before tax; false => after tax. */
  discountBeforeTax?: boolean;
}

export interface DocumentTotals {
  subtotal: number;
  discountAmount: number;
  taxTotal: number;
  total: number;
}

function toCents(n: number): number {
  return Math.round(n * 100);
}
function fromCents(c: number): number {
  return Math.round(c) / 100;
}

export function computeDocumentTotals(input: DocumentTotalsInput): DocumentTotals {
  const discountType = input.discountType ?? 'none';
  const discountValue = input.discountValue ?? 0;
  const discountBeforeTax = input.discountBeforeTax ?? true;

  let subtotalCents = 0;
  const perItemCents = input.items.map((it) => {
    const line = toCents(it.quantity * it.unitPrice);
    subtotalCents += line;
    return line;
  });

  // Discount as a fraction of the subtotal (applies proportionally to items for tax).
  let discountCents = 0;
  if (discountType === 'percent') {
    discountCents = Math.round((subtotalCents * discountValue) / 100);
  } else if (discountType === 'fixed') {
    discountCents = Math.min(toCents(discountValue), subtotalCents);
  }
  const discountFraction = subtotalCents > 0 ? discountCents / subtotalCents : 0;

  let taxCents = 0;
  input.items.forEach((it, i) => {
    const rate = it.taxRatePercent ?? 0;
    if (rate <= 0) return;
    const lineCents = perItemCents[i] ?? 0;
    const taxable = discountBeforeTax ? lineCents * (1 - discountFraction) : lineCents;
    taxCents += Math.round((taxable * rate) / 100);
  });

  let totalCents: number;
  if (discountBeforeTax) {
    totalCents = subtotalCents - discountCents + taxCents;
  } else {
    // discount applied after tax
    totalCents = subtotalCents + taxCents - discountCents;
  }

  return {
    subtotal: fromCents(subtotalCents),
    discountAmount: fromCents(discountCents),
    taxTotal: fromCents(taxCents),
    total: fromCents(Math.max(0, totalCents)),
  };
}

export function lineAmount(item: LineItem): number {
  return fromCents(toCents(item.quantity * item.unitPrice));
}

/** Recompute invoice paid state from payments + credit notes (PRD §11.4). */
export function computePaidState(params: {
  total: number;
  payments: number[];
  creditNotes?: number[];
}): { amountPaid: number; outstanding: number; isFullyPaid: boolean; isPartiallyPaid: boolean } {
  const totalCents = toCents(params.total);
  const paidCents = params.payments.reduce((s, p) => s + toCents(p), 0);
  const creditCents = (params.creditNotes ?? []).reduce((s, c) => s + toCents(c), 0);
  const settledCents = paidCents + creditCents;
  const outstandingCents = Math.max(0, totalCents - settledCents);
  return {
    amountPaid: fromCents(paidCents),
    outstanding: fromCents(outstandingCents),
    isFullyPaid: settledCents >= totalCents && totalCents > 0,
    isPartiallyPaid: settledCents > 0 && settledCents < totalCents,
  };
}

/** Overpayment guard (PRD §11.4): Σ payments + Σ credit_notes ≤ total. */
export function wouldOverpay(params: {
  total: number;
  existingPayments: number[];
  existingCreditNotes: number[];
  newAmount: number;
}): boolean {
  const settled = [...params.existingPayments, ...params.existingCreditNotes].reduce((s, v) => s + toCents(v), 0);
  return settled + toCents(params.newAmount) > toCents(params.total);
}
