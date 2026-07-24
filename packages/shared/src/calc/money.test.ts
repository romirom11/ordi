import { describe, it, expect } from 'vitest';
import { computeDocumentTotals, computePaidState, wouldOverpay } from './money';

describe('computeDocumentTotals', () => {
  it('sums line items', () => {
    const t = computeDocumentTotals({ items: [{ quantity: 2, unitPrice: 100 }, { quantity: 1, unitPrice: 50 }] });
    expect(t.subtotal).toBe(250);
    expect(t.taxTotal).toBe(0);
    expect(t.total).toBe(250);
  });

  it('applies per-item tax', () => {
    const t = computeDocumentTotals({ items: [{ quantity: 1, unitPrice: 100, taxRatePercent: 20 }] });
    expect(t.subtotal).toBe(100);
    expect(t.taxTotal).toBe(20);
    expect(t.total).toBe(120);
  });

  it('applies percent discount before tax', () => {
    const t = computeDocumentTotals({
      items: [{ quantity: 1, unitPrice: 100, taxRatePercent: 20 }],
      discountType: 'percent', discountValue: 10, discountBeforeTax: true,
    });
    expect(t.discountAmount).toBe(10);
    // taxable = 90 => tax 18 => total 100 - 10 + 18 = 108
    expect(t.taxTotal).toBe(18);
    expect(t.total).toBe(108);
  });

  it('applies fixed discount after tax', () => {
    const t = computeDocumentTotals({
      items: [{ quantity: 1, unitPrice: 100, taxRatePercent: 20 }],
      discountType: 'fixed', discountValue: 30, discountBeforeTax: false,
    });
    // subtotal 100 + tax 20 - 30 = 90
    expect(t.total).toBe(90);
  });

  it('caps fixed discount at subtotal', () => {
    const t = computeDocumentTotals({ items: [{ quantity: 1, unitPrice: 50 }], discountType: 'fixed', discountValue: 999 });
    expect(t.discountAmount).toBe(50);
    expect(t.total).toBe(0);
  });

  it('avoids float drift', () => {
    const t = computeDocumentTotals({ items: [{ quantity: 3, unitPrice: 0.1 }] });
    expect(t.total).toBe(0.3);
  });
});

describe('computePaidState', () => {
  it('computes partial payment', () => {
    const s = computePaidState({ total: 100, payments: [40] });
    expect(s.amountPaid).toBe(40);
    expect(s.outstanding).toBe(60);
    expect(s.isPartiallyPaid).toBe(true);
    expect(s.isFullyPaid).toBe(false);
  });

  it('counts credit notes toward settlement', () => {
    const s = computePaidState({ total: 100, payments: [70], creditNotes: [30] });
    expect(s.isFullyPaid).toBe(true);
    expect(s.outstanding).toBe(0);
  });
});

describe('wouldOverpay', () => {
  it('blocks overpayment', () => {
    expect(wouldOverpay({ total: 100, existingPayments: [80], existingCreditNotes: [], newAmount: 30 })).toBe(true);
    expect(wouldOverpay({ total: 100, existingPayments: [80], existingCreditNotes: [], newAmount: 20 })).toBe(false);
  });
});
