/**
 * Which bank account an invoice is paid to, and how much the client sends when
 * they pay the equivalent in another currency.
 *
 * Settings → Invoices holds a list of payment accounts, one or more per
 * currency (a UAH account, a USD account, a EUR account…). An invoice either
 * names one (`paymentAccountId`) or takes the first account in the currency
 * the client pays in. That currency is the invoice's own, unless the invoice
 * says the client pays the equivalent in another one (`paymentCurrency`, at
 * the `exchangeRate` typed in when it was issued).
 *
 * A workspace that still has only the older single `paymentDetails` text (no
 * accounts yet) keeps printing that text on every invoice, as before.
 */

export interface PaymentAccount {
  id: string;
  name: string;
  currency: string;
  details: string;
}

export interface PaymentAccountSettings {
  paymentAccounts?: PaymentAccount[] | null;
  /** The single text the accounts replaced; read only while no account exists. */
  paymentDetails?: string | null;
}

export interface InvoicePaymentFields {
  currency: string;
  paymentAccountId?: string | null;
  /** The currency the client pays in when it is not the invoice's own. */
  paymentCurrency?: string | null;
  /** Units of `paymentCurrency` per one unit of `currency`. */
  exchangeRate?: string | number | null;
  /** The details frozen on the invoice when it was sent. */
  paymentDetails?: string | null;
}

/** The accounts stored in settings, dropping anything malformed. */
export function paymentAccountsOf(settings: PaymentAccountSettings | null | undefined): PaymentAccount[] {
  const raw = settings?.paymentAccounts;
  if (!Array.isArray(raw)) return [];
  return raw.filter((a): a is PaymentAccount =>
    !!a && typeof a.id === 'string' && typeof a.currency === 'string' && typeof a.details === 'string');
}

/** The currency the client actually transfers. */
export function invoicePayCurrency(inv: Pick<InvoicePaymentFields, 'currency' | 'paymentCurrency'>): string {
  return inv.paymentCurrency || inv.currency;
}

/**
 * The account an invoice is paid to: the one it names, when that still exists
 * in the right currency, else the first account in the currency paid in.
 */
export function invoicePaymentAccount(
  inv: Pick<InvoicePaymentFields, 'currency' | 'paymentCurrency' | 'paymentAccountId'>,
  settings: PaymentAccountSettings | null | undefined,
): PaymentAccount | null {
  const accounts = paymentAccountsOf(settings);
  const payCurrency = invoicePayCurrency(inv);
  const named = inv.paymentAccountId ? accounts.find((a) => a.id === inv.paymentAccountId) : undefined;
  if (named && named.currency === payCurrency) return named;
  return accounts.find((a) => a.currency === payCurrency) ?? null;
}

/**
 * The payment details printed on an invoice: the text frozen when it was sent,
 * else its account's details, else (no accounts configured at all) the older
 * single text. Null when nothing fits: a USD invoice is never printed with
 * the UAH account's IBAN.
 */
export function invoicePaymentDetails(
  inv: InvoicePaymentFields,
  settings: PaymentAccountSettings | null | undefined,
): string | null {
  const frozen = inv.paymentDetails?.trim();
  if (frozen) return frozen;
  if (paymentAccountsOf(settings).length === 0) return settings?.paymentDetails?.trim() || null;
  return invoicePaymentAccount(inv, settings)?.details.trim() || null;
}

/** `amount` in the currency the client pays in, rounded to cents; null when no conversion applies. */
export function equivalentAmount(amount: number, exchangeRate: string | number | null | undefined): number | null {
  const rate = Number(exchangeRate);
  if (!exchangeRate || !Number.isFinite(rate) || rate <= 0) return null;
  return Math.round(amount * rate * 100) / 100;
}
