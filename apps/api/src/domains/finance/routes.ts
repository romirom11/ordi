import { Hono } from 'hono';
import {
  invoiceInputSchema, invoiceUpdateSchema, sendDocumentSchema, paymentInputSchema, creditNoteInputSchema,
  invoiceFromTimeSchema, quoteInputSchema, quoteUpdateSchema, recurringInvoiceInputSchema,
  recurringPaymentInputSchema, recurringPaymentUpdateSchema,
  expenseInputSchema, expenseCategoryInputSchema, taxRateInputSchema, reminderRuleInputSchema,
  emailTemplateInputSchema, numberSequenceInputSchema, profitabilityQuerySchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { page } from '../../lib/http';
import * as svc from './service';

/** Node Buffer → ArrayBuffer (a BodyInit Hono accepts) for PDF responses. */
function toArrayBuffer(b: Buffer): ArrayBuffer {
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

export function financeRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Invoices ──
  app.get('/invoices', guard('finance.read'), async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await svc.listInvoices({
      status: c.req.query('status'), companyId: c.req.query('companyId'), projectId: c.req.query('projectId'),
      from: c.req.query('from'), to: c.req.query('to'), q: c.req.query('q'), limit,
    });
    return c.json(page(rows, limit, (r) => ({ createdAt: r.createdAt })));
  });

  app.post('/invoices', guard('finance.write'), async (c) => {
    const body = invoiceInputSchema.parse(await c.req.json());
    const id = await svc.createInvoice(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.post('/invoices/from-time', guard('finance.write'), async (c) => {
    const body = invoiceFromTimeSchema.parse(await c.req.json());
    const id = await svc.invoiceFromTime(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/invoices/:id', guard('finance.read'), async (c) => c.json(await svc.getInvoice(c.req.param('id'))));

  app.patch('/invoices/:id', guard('finance.write'), async (c) => {
    const body = invoiceUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateInvoice(currentActor(c), c.req.param('id'), body));
  });

  app.post('/invoices/:id/send', guard('finance.send'), async (c) => {
    const body = sendDocumentSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await svc.sendInvoice(currentActor(c), c.req.param('id'), body));
  });

  app.post('/invoices/:id/cancel', guard('finance.write'), async (c) =>
    c.json(await svc.cancelInvoice(currentActor(c), c.req.param('id'))));

  app.post('/invoices/:id/duplicate', guard('finance.write'), async (c) => {
    const id = await svc.duplicateInvoice(currentActor(c), c.req.param('id'));
    return c.json({ id }, 201);
  });

  app.get('/invoices/:id/pdf', guard('finance.read'), async (c) => {
    const { buffer, number } = await svc.getInvoicePdfBuffer(c.req.param('id'));
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `inline; filename="${number}.pdf"`);
    return c.body(toArrayBuffer(buffer));
  });

  app.delete('/invoices/:id', guard('finance.delete'), async (c) => {
    await svc.softDeleteInvoice(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Payments ──
  app.get('/invoices/:id/payments', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listPayments(c.req.param('id')) }));

  app.post('/invoices/:id/payments', guard('finance.payments'), async (c) => {
    const body = paymentInputSchema.parse(await c.req.json());
    const id = await svc.recordPayment(currentActor(c), c.req.param('id'), body);
    return c.json({ id }, 201);
  });

  app.delete('/payments/:id', guard('finance.payments'), async (c) => {
    await svc.deletePayment(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Credit notes ──
  app.get('/invoices/:id/credit-notes', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listCreditNotes(c.req.param('id')) }));

  app.post('/invoices/:id/credit-notes', guard('finance.payments'), async (c) => {
    const body = creditNoteInputSchema.parse(await c.req.json());
    const id = await svc.createCreditNote(currentActor(c), c.req.param('id'), body);
    return c.json({ id }, 201);
  });

  // ── Quotes ──
  app.get('/quotes', guard('finance.read'), async (c) => {
    const limit = Number(c.req.query('limit') ?? 50);
    const rows = await svc.listQuotes({
      status: c.req.query('status'), companyId: c.req.query('companyId'), projectId: c.req.query('projectId'), limit,
    });
    return c.json(page(rows, limit, (r) => ({ createdAt: r.createdAt })));
  });

  app.post('/quotes', guard('finance.write'), async (c) => {
    const body = quoteInputSchema.parse(await c.req.json());
    const id = await svc.createQuote(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.get('/quotes/:id', guard('finance.read'), async (c) => c.json(await svc.getQuote(c.req.param('id'))));

  app.patch('/quotes/:id', guard('finance.write'), async (c) => {
    const body = quoteUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateQuote(currentActor(c), c.req.param('id'), body));
  });

  app.post('/quotes/:id/send', guard('finance.send'), async (c) => {
    const body = sendDocumentSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await svc.sendQuote(currentActor(c), c.req.param('id'), body));
  });

  app.post('/quotes/:id/convert', guard('finance.write'), async (c) => {
    const id = await svc.convertQuote(currentActor(c), c.req.param('id'));
    return c.json({ id }, 201);
  });

  app.get('/quotes/:id/pdf', guard('finance.read'), async (c) => {
    const { buffer, number } = await svc.getQuotePdfBuffer(c.req.param('id'));
    c.header('Content-Type', 'application/pdf');
    c.header('Content-Disposition', `inline; filename="${number}.pdf"`);
    return c.body(toArrayBuffer(buffer));
  });

  app.delete('/quotes/:id', guard('finance.delete'), async (c) => {
    await svc.softDeleteQuote(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Recurring invoices ──
  app.get('/recurring-invoices', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listRecurring() }));

  app.post('/recurring-invoices', guard('finance.write'), async (c) => {
    const body = recurringInvoiceInputSchema.parse(await c.req.json());
    const id = await svc.createRecurring(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/recurring-invoices/:id', guard('finance.write'), async (c) => {
    const body = recurringInvoiceInputSchema.partial().parse(await c.req.json());
    return c.json(await svc.updateRecurring(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/recurring-invoices/:id', guard('finance.write'), async (c) => {
    await svc.deleteRecurring(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Recurring payments / subscriptions ──
  app.get('/recurring-payments/summary', guard('finance.read'), async (c) =>
    c.json(await svc.recurringPaymentsSummary()));

  app.get('/recurring-payments', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listRecurringPayments({ active: c.req.query('active') }) }));

  app.post('/recurring-payments', guard('finance.write'), async (c) => {
    const body = recurringPaymentInputSchema.parse(await c.req.json());
    const id = await svc.createRecurringPayment(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/recurring-payments/:id', guard('finance.write'), async (c) => {
    const body = recurringPaymentUpdateSchema.parse(await c.req.json());
    return c.json(await svc.updateRecurringPayment(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/recurring-payments/:id', guard('finance.write'), async (c) => {
    await svc.deleteRecurringPayment(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Expenses ──
  app.get('/expenses', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listExpenses({ projectId: c.req.query('projectId'), companyId: c.req.query('companyId') }) }));

  app.post('/expenses', guard('finance.write'), async (c) => {
    const body = expenseInputSchema.parse(await c.req.json());
    const id = await svc.createExpense(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/expenses/:id', guard('finance.write'), async (c) => {
    const body = expenseInputSchema.partial().parse(await c.req.json());
    return c.json(await svc.updateExpense(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/expenses/:id', guard('finance.write'), async (c) => {
    await svc.deleteExpense(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Expense categories ──
  app.get('/expense-categories', guard('finance.read'), async (c) =>
    c.json({ data: await svc.listExpenseCategories() }));

  app.post('/expense-categories', guard('finance.settings'), async (c) => {
    const body = expenseCategoryInputSchema.parse(await c.req.json());
    const id = await svc.createExpenseCategory(body);
    return c.json({ id }, 201);
  });

  app.delete('/expense-categories/:id', guard('finance.settings'), async (c) => {
    await svc.deleteExpenseCategory(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Settings: tax rates ── (read allowed for finance.read so document creators see the picker)
  app.get('/tax-rates', guard('finance.read'), async (c) => c.json({ data: await svc.listTaxRates() }));

  app.post('/tax-rates', guard('finance.settings'), async (c) => {
    const body = taxRateInputSchema.parse(await c.req.json());
    const id = await svc.createTaxRate(body);
    return c.json({ id }, 201);
  });

  app.patch('/tax-rates/:id', guard('finance.settings'), async (c) => {
    const body = taxRateInputSchema.partial().parse(await c.req.json());
    await svc.updateTaxRate(c.req.param('id'), body);
    return c.json({ ok: true });
  });

  app.delete('/tax-rates/:id', guard('finance.settings'), async (c) => {
    await svc.deleteTaxRate(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Settings: reminder rules ──
  app.get('/reminder-rules', guard('finance.settings'), async (c) => c.json({ data: await svc.listReminderRules() }));

  app.post('/reminder-rules', guard('finance.settings'), async (c) => {
    const body = reminderRuleInputSchema.parse(await c.req.json());
    const id = await svc.createReminderRule(body);
    return c.json({ id }, 201);
  });

  app.patch('/reminder-rules/:id', guard('finance.settings'), async (c) => {
    const body = reminderRuleInputSchema.partial().parse(await c.req.json());
    await svc.updateReminderRule(c.req.param('id'), body);
    return c.json({ ok: true });
  });

  app.delete('/reminder-rules/:id', guard('finance.settings'), async (c) => {
    await svc.deleteReminderRule(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Settings: email templates ──
  app.get('/email-templates', guard('finance.settings'), async (c) => c.json({ data: await svc.listEmailTemplates() }));

  app.post('/email-templates', guard('finance.settings'), async (c) => {
    const body = emailTemplateInputSchema.parse(await c.req.json());
    const id = await svc.createEmailTemplate(body);
    return c.json({ id }, 201);
  });

  app.patch('/email-templates/:id', guard('finance.settings'), async (c) => {
    const body = emailTemplateInputSchema.partial().parse(await c.req.json());
    await svc.updateEmailTemplate(c.req.param('id'), body);
    return c.json({ ok: true });
  });

  app.delete('/email-templates/:id', guard('finance.settings'), async (c) => {
    await svc.deleteEmailTemplate(c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Settings: number sequences ──
  app.get('/number-sequences', guard('finance.settings'), async (c) => c.json({ data: await svc.listNumberSequences() }));

  app.patch('/number-sequences', guard('finance.settings'), async (c) => {
    const body = numberSequenceInputSchema.parse(await c.req.json());
    return c.json({ data: await svc.updateNumberSequence(body) });
  });

  // ── Finance dashboard ──
  app.get('/finance/dashboard', guard('finance.read'), async (c) =>
    c.json(await svc.financeDashboard({ from: c.req.query('from'), to: c.req.query('to') })));

  // ── Profitability (cost visibility) ──
  app.get('/finance/profitability', guard('finance.read_costs'), async (c) => {
    const q = profitabilityQuerySchema.parse({
      scope: c.req.query('scope'), from: c.req.query('from'), to: c.req.query('to'),
      projectId: c.req.query('projectId'), companyId: c.req.query('companyId'),
    });
    return c.json(await svc.profitability(q));
  });

  return app;
}
