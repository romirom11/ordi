/**
 * The currency codes the pickers offer. Not a contract: the API validates any
 * ISO 4217 code, so a record can legitimately carry a code that is not listed
 * here (an older entry, an import, a workspace billing in something else).
 * Anything rendering a stored value goes through `currencyOptions` so opening
 * such a record never silently rewrites its currency.
 */

/** Offered on records: expenses, income, subscriptions, companies, deals. */
export const CURRENCIES = ['USD', 'EUR', 'UAH'];

/**
 * The workspace base currency stays a wide list: it is picked once in Settings
 * and seeds every record picker, and self-hosted workspaces bill in more than
 * the three codes above.
 */
export const WORKSPACE_CURRENCIES = [
  'USD', 'EUR', 'GBP', 'UAH', 'CAD', 'AUD', 'CHF', 'JPY', 'PLN', 'SEK', 'NOK', 'INR', 'BRL', 'SGD',
];

/** The picker list with `current` kept in front when it is not part of it. */
export function currencyOptions(current?: string | null, list: string[] = CURRENCIES): string[] {
  return current && !list.includes(current) ? [current, ...list] : list;
}
