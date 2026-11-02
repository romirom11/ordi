/** Money for notification copy – Intl with a plain fallback for odd currency codes. */
export function formatMoney(amount: string | number | null, currency: string | null): string {
  const value = Number(amount ?? 0);
  const code = currency || 'USD';
  try {
    return new Intl.NumberFormat('en', { style: 'currency', currency: code }).format(value);
  } catch {
    return `${value.toFixed(2)} ${code}`;
  }
}
