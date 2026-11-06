import { describe, it, expect } from 'vitest';
import { invoicePaymentAccount, invoicePaymentDetails, invoicePayCurrency, equivalentAmount, paymentAccountsOf } from './payment-accounts';

const settings = {
  paymentAccounts: [
    { id: 'uah', name: 'PrivatBank UAH', currency: 'UAH', details: 'IBAN UA00 UAH' },
    { id: 'usd', name: 'USD', currency: 'USD', details: 'IBAN UA00 USD' },
    { id: 'usd2', name: 'USD second', currency: 'USD', details: 'IBAN UA00 USD-2' },
  ],
  paymentDetails: 'old single text',
};

describe('payment accounts', () => {
  it('pays in the invoice currency unless the client pays the equivalent', () => {
    expect(invoicePayCurrency({ currency: 'USD' })).toBe('USD');
    expect(invoicePayCurrency({ currency: 'USD', paymentCurrency: 'UAH' })).toBe('UAH');
  });

  it('takes the first account in the currency paid in by default', () => {
    expect(invoicePaymentAccount({ currency: 'USD' }, settings)?.id).toBe('usd');
    expect(invoicePaymentAccount({ currency: 'USD', paymentCurrency: 'UAH' }, settings)?.id).toBe('uah');
  });

  it('keeps a named account only while it takes the currency paid in', () => {
    expect(invoicePaymentAccount({ currency: 'USD', paymentAccountId: 'usd2' }, settings)?.id).toBe('usd2');
    expect(invoicePaymentAccount({ currency: 'EUR', paymentAccountId: 'usd2' }, settings)).toBeNull();
    expect(invoicePaymentAccount({ currency: 'USD', paymentAccountId: 'gone' }, settings)?.id).toBe('usd');
  });

  it('never prints another currency\'s details, and the old text only while no account exists', () => {
    expect(invoicePaymentDetails({ currency: 'EUR' }, settings)).toBeNull();
    expect(invoicePaymentDetails({ currency: 'EUR' }, { paymentDetails: ' old single text ' })).toBe('old single text');
    expect(invoicePaymentDetails({ currency: 'USD', paymentCurrency: 'UAH' }, settings)).toBe('IBAN UA00 UAH');
  });

  it('prints the details frozen on a sent invoice over the live ones', () => {
    expect(invoicePaymentDetails({ currency: 'USD', paymentDetails: 'IBAN as sent' }, settings)).toBe('IBAN as sent');
  });

  it('drops malformed accounts', () => {
    expect(paymentAccountsOf({ paymentAccounts: [{ id: 'x' } as never, settings.paymentAccounts[0]!] })).toHaveLength(1);
    expect(paymentAccountsOf(null)).toEqual([]);
  });

  it('converts to the currency paid in, rounded to cents', () => {
    expect(equivalentAmount(1000, '41.2345')).toBe(41234.5);
    expect(equivalentAmount(333.33, 41.27)).toBe(13756.53);
    expect(equivalentAmount(100, null)).toBeNull();
    expect(equivalentAmount(100, 0)).toBeNull();
  });
});
