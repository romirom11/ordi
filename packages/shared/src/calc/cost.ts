/**
 * Cost rate & profitability math (PRD §11.10, §12.5). Management analytics
 * (cost rate + overhead), NOT payroll. Pure & unit-tested.
 */

export interface CompensationRecord {
  compType: 'monthly' | 'hourly' | 'contractor';
  amount: number;
  effectiveFrom: string; // ISO date
  effectiveTo?: string | null;
}

/** Pick the compensation record effective on a given date (versioned history). */
export function compensationAt(records: CompensationRecord[], onDate: string): CompensationRecord | null {
  const d = onDate.slice(0, 10);
  const eligible = records
    .filter((r) => r.effectiveFrom.slice(0, 10) <= d && (!r.effectiveTo || r.effectiveTo.slice(0, 10) >= d))
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return eligible[0] ?? null;
}

/**
 * Hourly cost rate from a compensation record + working hours/week.
 * monthly => amount / (weeksPerMonth * hoursPerWeek); hourly/contractor => amount.
 */
export function hourlyCostRate(comp: CompensationRecord, workingHoursPerWeek: number): number {
  if (comp.compType === 'monthly') {
    const monthlyHours = (workingHoursPerWeek * 52) / 12;
    return monthlyHours > 0 ? round2(comp.amount / monthlyHours) : 0;
  }
  return round2(comp.amount);
}

/** Company overhead spread onto working hours (PRD §12.5, optional). */
export function overheadPerHour(monthlyBase: number, workingHoursPerWeek: number): number {
  const monthlyHours = (workingHoursPerWeek * 52) / 12;
  return monthlyHours > 0 ? round2(monthlyBase / monthlyHours) : 0;
}

export interface ProfitabilityInput {
  /** Revenue: invoiced amount OR billable hours × client rate. */
  revenue: number;
  /** Cost of worked hours (Σ hours × cost_rate snapshot). */
  laborCost: number;
  /** Non-billable project expenses + billable expenses without markup. */
  expenseCost: number;
}

export interface Profitability {
  revenue: number;
  cost: number;
  margin: number;
  marginPercent: number;
}

export function computeProfitability(input: ProfitabilityInput): Profitability {
  const cost = round2(input.laborCost + input.expenseCost);
  const revenue = round2(input.revenue);
  const margin = round2(revenue - cost);
  const marginPercent = revenue > 0 ? round2((margin / revenue) * 100) : 0;
  return { revenue, cost, margin, marginPercent };
}

/** Utilization: billable hours / available hours (PRD §11.10). */
export function utilization(billableHours: number, availableHours: number): number {
  return availableHours > 0 ? round2((billableHours / availableHours) * 100) : 0;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
