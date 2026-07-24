/**
 * Ledger API (double-entry core, PRD §11 extension).
 * Reads need finance.read; chart-of-accounts writes need finance.settings;
 * manual entries / income documents need finance.write (house pattern).
 */
import { Hono } from 'hono';
import {
  accountInputSchema, accountUpdateSchema, ledgerTransactionInputSchema,
  ledgerTransactionsQuerySchema, incomeInputSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { page } from '../../lib/http';
import * as ledger from './ledger.service';

export function ledgerRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Chart of accounts ──
  app.get('/ledger/accounts', guard('finance.read'), async (c) =>
    c.json({ data: await ledger.listAccounts() }));

  app.post('/ledger/accounts', guard('finance.settings'), async (c) => {
    const body = accountInputSchema.parse(await c.req.json());
    const id = await ledger.createAccount(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.patch('/ledger/accounts/:id', guard('finance.settings'), async (c) => {
    const body = accountUpdateSchema.parse(await c.req.json());
    return c.json(await ledger.updateAccount(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/ledger/accounts/:id', guard('finance.settings'), async (c) => {
    await ledger.deleteAccount(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.get('/ledger/accounts/:id/balance', guard('finance.read'), async (c) =>
    c.json(await ledger.accountBalance(c.req.param('id'), { from: c.req.query('from'), to: c.req.query('to') })));

  // ── Journal ──
  app.get('/ledger/transactions', guard('finance.read'), async (c) => {
    const q = ledgerTransactionsQuerySchema.parse({
      accountId: c.req.query('accountId'), projectId: c.req.query('projectId'), sourceType: c.req.query('sourceType'),
      from: c.req.query('from'), to: c.req.query('to'), limit: c.req.query('limit'),
    });
    const rows = await ledger.listTransactions(q);
    return c.json(page(rows, q.limit, (r) => ({ date: r.date, id: r.id })));
  });

  app.post('/ledger/transactions', guard('finance.write'), async (c) => {
    const body = ledgerTransactionInputSchema.parse(await c.req.json());
    const id = await ledger.createManualTransaction(currentActor(c), body);
    return c.json({ id }, 201);
  });

  app.post('/ledger/transactions/:id/void', guard('finance.settings'), async (c) =>
    c.json(await ledger.voidTransaction(currentActor(c), c.req.param('id'))));

  // ── Manual income document (the ledger transaction IS the record) ──
  app.post('/income', guard('finance.write'), async (c) => {
    const body = incomeInputSchema.parse(await c.req.json());
    const id = await ledger.postIncome(currentActor(c), body);
    return c.json({ id }, 201);
  });

  return app;
}
