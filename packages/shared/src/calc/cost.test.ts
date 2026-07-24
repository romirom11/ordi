import { describe, it, expect } from 'vitest';
import { compensationAt, hourlyCostRate, overheadPerHour, computeProfitability, utilization } from './cost';

describe('compensationAt (versioned history)', () => {
  const records = [
    { compType: 'monthly' as const, amount: 3000, effectiveFrom: '2024-01-01', effectiveTo: '2024-06-30' },
    { compType: 'monthly' as const, amount: 4000, effectiveFrom: '2024-07-01', effectiveTo: null },
  ];
  it('picks record effective at date (past period correctness)', () => {
    expect(compensationAt(records, '2024-03-15')?.amount).toBe(3000);
    expect(compensationAt(records, '2024-09-15')?.amount).toBe(4000);
  });
});

describe('hourlyCostRate', () => {
  it('spreads monthly comp across working hours', () => {
    // 40h/week => 173.33h/month => 4000/173.33 ≈ 23.08
    expect(hourlyCostRate({ compType: 'monthly', amount: 4000, effectiveFrom: '2024-01-01' }, 40)).toBeCloseTo(23.08, 1);
  });
  it('uses direct rate for contractor', () => {
    expect(hourlyCostRate({ compType: 'contractor', amount: 50, effectiveFrom: '2024-01-01' }, 40)).toBe(50);
  });
});

describe('overheadPerHour', () => {
  it('spreads monthly overhead base', () => {
    expect(overheadPerHour(2000, 40)).toBeCloseTo(11.54, 1);
  });
});

describe('computeProfitability', () => {
  it('computes margin and percent', () => {
    const p = computeProfitability({ revenue: 1000, laborCost: 400, expenseCost: 100 });
    expect(p.cost).toBe(500);
    expect(p.margin).toBe(500);
    expect(p.marginPercent).toBe(50);
  });
  it('internal project (no revenue) is pure cost', () => {
    const p = computeProfitability({ revenue: 0, laborCost: 300, expenseCost: 0 });
    expect(p.revenue).toBe(0);
    expect(p.margin).toBe(-300);
    expect(p.marginPercent).toBe(0);
  });
});

describe('utilization', () => {
  it('billable / available', () => {
    expect(utilization(30, 40)).toBe(75);
    expect(utilization(0, 0)).toBe(0);
  });
});
