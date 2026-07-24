import { Hono } from 'hono';
import { getDb, schema, eq, and, isNull, asc, desc, inArray } from '@ordi/db';
import { ulid } from 'ulid';
import {
  publicQuoteDecisionSchema, intakeSubmitSchema, careersApplySchema,
  parseTaskRefs, type EventType,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { env } from '../../env';
import { err } from '../../lib/errors';
import { emit } from '../../core/events';
import { hmacSha256, encrypt, generateToken } from '../../lib/crypto';
import { writeActivity } from '../../core/activity';
import { verifyOAuthState, exchangeGithubCode, exchangeSlackCode } from '../integrations/oauth';

/**
 * Public (unauthenticated) surface (PRD §11.2/11.3/11.8, §8.6, §12.3, §13.1).
 * Mounted at app root `/` (the git webhook uses the full `/api/v1/...` path).
 * Unknown or expired tokens return 404 – existence is never leaked.
 */

// ── Simple in-memory rate limiter (per IP) for public form endpoints (PRD §8.6/§12.3). ──
const rateBuckets = new Map<string, number[]>();
function rateLimitOk(key: string, limit = 5, windowMs = 60_000): boolean {
  const now = Date.now();
  const hits = (rateBuckets.get(key) ?? []).filter((t) => now - t < windowMs);
  if (hits.length >= limit) {
    rateBuckets.set(key, hits);
    return false;
  }
  hits.push(now);
  rateBuckets.set(key, hits);
  return true;
}
function clientIp(c: { req: { header: (name: string) => string | undefined } }): string {
  const fwd = c.req.header('x-forwarded-for');
  if (fwd) return fwd.split(',')[0]!.trim();
  return c.req.header('x-real-ip') ?? 'unknown';
}

export function publicRoutes() {
  const app = new Hono<AppEnv>();

  // ── Public invoice page (PRD §11.3) ──
  app.get('/i/:token', async (c) => {
    const { db } = getDb();
    const token = c.req.param('token');
    const [inv] = await db.select().from(schema.invoices)
      .where(and(eq(schema.invoices.publicToken, token), isNull(schema.invoices.deletedAt)));
    if (!inv) throw err.notFound();

    let status = inv.status;
    let viewedAt = inv.viewedAt;
    if (!inv.viewedAt) {
      viewedAt = new Date();
      const patch: Record<string, unknown> = { viewedAt };
      if (inv.status === 'sent') { patch.status = 'viewed'; status = 'viewed'; }
      await db.update(schema.invoices).set(patch).where(eq(schema.invoices.id, inv.id));
      await emit({
        type: 'invoice.viewed', aggregateType: 'invoice', aggregateId: inv.id,
        payload: { ref: inv.number }, actorId: null, actorType: 'system',
      });
    }

    const items = await db.select({
      description: schema.invoiceItems.description,
      quantity: schema.invoiceItems.quantity,
      unitPrice: schema.invoiceItems.unitPrice,
      amount: schema.invoiceItems.amount,
      position: schema.invoiceItems.position,
    }).from(schema.invoiceItems)
      .where(eq(schema.invoiceItems.invoiceId, inv.id))
      .orderBy(asc(schema.invoiceItems.position));

    const [company] = await db.select({ name: schema.companies.name })
      .from(schema.companies).where(eq(schema.companies.id, inv.companyId));

    const [ws] = await db.select({
      name: schema.workspaceSettings.name,
      logo: schema.workspaceSettings.logo,
      invoiceSettings: schema.workspaceSettings.invoiceSettings,
    }).from(schema.workspaceSettings).where(eq(schema.workspaceSettings.id, 'workspace'));

    const outstanding = Number(inv.total) - Number(inv.amountPaid);
    return c.json({
      invoice: {
        number: inv.number, status, currency: inv.currency,
        issueDate: inv.issueDate, dueDate: inv.dueDate, language: inv.language,
        discountType: inv.discountType, discountValue: inv.discountValue,
        subtotal: inv.subtotal, taxTotal: inv.taxTotal, total: inv.total,
        notes: inv.notes, terms: inv.terms, viewedAt,
      },
      items,
      company: { name: company?.name ?? null, logo: null },
      workspace: { name: ws?.name ?? 'ordi', logo: ws?.logo ?? null },
      invoiceSettings: ws?.invoiceSettings ?? {},
      amountPaid: Number(inv.amountPaid),
      outstanding,
    });
  });

  // ── Invoice PDF (stub – the app downloads the real artifact) ──
  app.get('/i/:token/pdf', async (c) => {
    return c.json({ message: 'Use the app to download PDF' }, 501);
  });

  // ── Public quote page (PRD §11.2) ──
  app.get('/q/:token', async (c) => {
    const { db } = getDb();
    const token = c.req.param('token');
    const [q] = await db.select().from(schema.quotes)
      .where(and(eq(schema.quotes.publicToken, token), isNull(schema.quotes.deletedAt)));
    if (!q) throw err.notFound();

    let status = q.status;
    if (q.status === 'sent') {
      status = 'viewed';
      await db.update(schema.quotes).set({ status: 'viewed' }).where(eq(schema.quotes.id, q.id));
    }

    const items = await db.select({
      description: schema.quoteItems.description,
      quantity: schema.quoteItems.quantity,
      unitPrice: schema.quoteItems.unitPrice,
      amount: schema.quoteItems.amount,
      position: schema.quoteItems.position,
    }).from(schema.quoteItems)
      .where(eq(schema.quoteItems.quoteId, q.id))
      .orderBy(asc(schema.quoteItems.position));

    const [company] = await db.select({ name: schema.companies.name })
      .from(schema.companies).where(eq(schema.companies.id, q.companyId));

    return c.json({
      quote: {
        number: q.number, status, currency: q.currency,
        issueDate: q.issueDate, validUntil: q.validUntil, language: q.language,
        discountType: q.discountType, discountValue: q.discountValue,
        subtotal: q.subtotal, taxTotal: q.taxTotal, total: q.total,
        notes: q.notes, terms: q.terms, acceptedAt: q.acceptedAt,
      },
      items,
      company: { name: company?.name ?? null, logo: null },
    });
  });

  // ── Quote accept/decline (PRD §11.2) ──
  app.post('/q/:token/decision', async (c) => {
    const { db } = getDb();
    const token = c.req.param('token');
    const body = publicQuoteDecisionSchema.parse(await c.req.json());
    const [q] = await db.select().from(schema.quotes)
      .where(and(eq(schema.quotes.publicToken, token), isNull(schema.quotes.deletedAt)));
    if (!q) throw err.notFound();
    if (q.status !== 'sent' && q.status !== 'viewed') {
      throw err.domain('Quote is not open for a decision');
    }

    if (body.decision === 'accept') {
      await db.update(schema.quotes)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(eq(schema.quotes.id, q.id));
      await emit({
        type: 'quote.accepted', aggregateType: 'quote', aggregateId: q.id,
        payload: { ownerId: null, ref: q.number }, actorId: null, actorType: 'system',
      });
    } else {
      await db.update(schema.quotes)
        .set({ status: 'declined', declineComment: body.comment })
        .where(eq(schema.quotes.id, q.id));
      await emit({
        type: 'quote.declined', aggregateType: 'quote', aggregateId: q.id,
        payload: { ownerId: null, ref: q.number }, actorId: null, actorType: 'system',
      });
    }
    return c.json({ ok: true });
  });

  // ── Light client portal (PRD §11.8) ──
  app.get('/portal/:token', async (c) => {
    const { db } = getDb();
    const token = c.req.param('token');
    const [company] = await db.select().from(schema.companies)
      .where(and(eq(schema.companies.portalToken, token), isNull(schema.companies.deletedAt)));
    if (!company || !company.portalEnabled) throw err.notFound();

    const invoices = await db.select().from(schema.invoices)
      .where(and(eq(schema.invoices.companyId, company.id), isNull(schema.invoices.deletedAt)))
      .orderBy(desc(schema.invoices.issueDate));
    const quotes = await db.select().from(schema.quotes)
      .where(and(eq(schema.quotes.companyId, company.id), isNull(schema.quotes.deletedAt)))
      .orderBy(desc(schema.quotes.issueDate));

    return c.json({
      company: { name: company.name },
      invoices: invoices.map((i) => ({
        number: i.number, status: i.status, total: Number(i.total),
        amountPaid: Number(i.amountPaid), currency: i.currency,
        issueDate: i.issueDate, dueDate: i.dueDate, link: `/i/${i.publicToken}`,
      })),
      quotes: quotes.map((q) => ({
        number: q.number, status: q.status, total: Number(q.total),
        currency: q.currency, issueDate: q.issueDate, validUntil: q.validUntil,
        link: `/q/${q.publicToken}`,
      })),
    });
  });

  // ── Intake form (PRD §8.6) ──
  app.get('/intake/:token', async (c) => {
    const { db } = getDb();
    const [settings] = await db.select().from(schema.intakeSettings)
      .where(eq(schema.intakeSettings.formToken, c.req.param('token')));
    if (!settings || !settings.formEnabled) throw err.notFound();
    const [project] = await db.select({ name: schema.projects.name }).from(schema.projects)
      .where(and(eq(schema.projects.id, settings.projectId), isNull(schema.projects.deletedAt)));
    if (!project) throw err.notFound();
    return c.json({
      projectName: project.name,
      fields: [
        { name: 'requesterName', label: 'Your name', type: 'text', required: true },
        { name: 'requesterEmail', label: 'Email', type: 'email', required: false },
        { name: 'title', label: 'Subject', type: 'text', required: true },
        { name: 'description', label: 'Details', type: 'textarea', required: false },
      ],
    });
  });

  app.post('/intake/:token', async (c) => {
    const { db } = getDb();
    const [settings] = await db.select().from(schema.intakeSettings)
      .where(eq(schema.intakeSettings.formToken, c.req.param('token')));
    if (!settings || !settings.formEnabled) throw err.notFound();

    const body = intakeSubmitSchema.parse(await c.req.json());
    // Honeypot: bots fill the hidden field – silently accept, create nothing.
    if (body.honeypot && body.honeypot.trim() !== '') return c.json({ ok: true });
    if (!rateLimitOk(`intake:${clientIp(c)}`)) throw err.rateLimited();

    await db.insert(schema.intakeItems).values({
      id: ulid(),
      projectId: settings.projectId,
      source: 'form',
      requesterName: body.requesterName,
      requesterEmail: body.requesterEmail ?? null,
      title: body.title,
      description: body.description,
      status: 'pending',
    });
    return c.json({ ok: true });
  });

  // ── Careers public page + application (PRD §12.3) ──
  app.get('/careers/:token', async (c) => {
    const { db } = getDb();
    const [job] = await db.select().from(schema.jobOpenings)
      .where(and(eq(schema.jobOpenings.publicToken, c.req.param('token')), isNull(schema.jobOpenings.deletedAt)));
    if (!job || !job.publicEnabled) throw err.notFound();
    return c.json({ title: job.title, description: job.description });
  });

  app.post('/careers/:token', async (c) => {
    const { db } = getDb();
    const [job] = await db.select().from(schema.jobOpenings)
      .where(and(eq(schema.jobOpenings.publicToken, c.req.param('token')), isNull(schema.jobOpenings.deletedAt)));
    if (!job || !job.publicEnabled) throw err.notFound();

    const body = careersApplySchema.parse(await c.req.json());
    if (body.honeypot && body.honeypot.trim() !== '') return c.json({ ok: true });
    if (!rateLimitOk(`careers:${clientIp(c)}`)) throw err.rateLimited();

    const [stage] = await db.select({ id: schema.applicantStages.id })
      .from(schema.applicantStages).orderBy(asc(schema.applicantStages.position)).limit(1);
    if (!stage) throw err.domain('Applications are not open');

    await db.insert(schema.applicants).values({
      id: ulid(),
      jobOpeningId: job.id,
      name: body.name,
      email: body.email,
      coverText: body.coverText,
      resumeAttachmentId: body.resumeAttachmentId ?? null,
      stageId: stage.id,
      source: 'careers',
      createdFrom: 'form',
    });
    return c.json({ ok: true });
  });

  // ── GitHub OAuth callback (PRD §13.1) – public; GitHub redirects the browser here. ──
  app.get('/integrations/git/oauth/callback', async (c) => {
    const appUrl = env.appUrl.replace(/\/$/, '');
    try {
      const code = c.req.query('code');
      const state = verifyOAuthState(c.req.query('state'));
      if (!code || !state) return c.redirect(`${appUrl}/settings/integrations?git=error`);
      const { token } = await exchangeGithubCode(code);
      const { db } = getDb();
      const id = ulid();
      await db.insert(schema.gitConnections).values({
        id,
        provider: 'github',
        credentials: encrypt(JSON.stringify({ token, tokenType: 'oauth' })),
        webhookSecret: generateToken(),
        status: 'connected',
        createdBy: state.userId,
      });
      await writeActivity(db, {
        entityType: 'git_connection', entityId: id, action: 'created',
        after: { provider: 'github' }, actorId: state.userId, actorType: 'user',
      });
      return c.redirect(`${appUrl}/settings/integrations?git=connected`);
    } catch {
      return c.redirect(`${appUrl}/settings/integrations?git=error`);
    }
  });

  // ── Slack OAuth callback – public; Slack redirects the browser here. ──
  app.get('/integrations/slack/oauth/callback', async (c) => {
    const appUrl = env.appUrl.replace(/\/$/, '');
    try {
      const code = c.req.query('code');
      const state = verifyOAuthState(c.req.query('state'));
      if (!code || !state) return c.redirect(`${appUrl}/settings/integrations?slack=error`);
      const conn = await exchangeSlackCode(code);
      const { db } = getDb();
      // Single-row semantics: replace any existing connection on reconnect.
      await db.delete(schema.slackConnections);
      const id = ulid();
      await db.insert(schema.slackConnections).values({
        id,
        teamId: conn.teamId,
        teamName: conn.teamName,
        botToken: encrypt(conn.botToken),
        scope: conn.scope,
        createdBy: state.userId,
      });
      await writeActivity(db, {
        entityType: 'slack_connection', entityId: id, action: 'created',
        after: { teamId: conn.teamId, teamName: conn.teamName }, actorId: state.userId, actorType: 'user',
      });
      return c.redirect(`${appUrl}/settings/integrations?slack=connected`);
    } catch {
      return c.redirect(`${appUrl}/settings/integrations?slack=error`);
    }
  });

  // ── Incoming git webhook (PRD §13.1) – always 200 to avoid provider retries. ──
  app.post('/api/v1/integrations/git/:provider/webhook', async (c) => {
    try {
      const provider = c.req.param('provider');
      const raw = await c.req.text();
      const { db } = getDb();

      // Idempotency: dedup by provider delivery id.
      const deliveryId = c.req.header('x-github-delivery')
        ?? c.req.header('x-gitlab-event-uuid')
        ?? c.req.header('x-gitea-delivery')
        ?? null;
      if (deliveryId) {
        const inserted = await db.insert(schema.gitWebhookDeliveries)
          .values({ deliveryId, provider })
          .onConflictDoNothing()
          .returning({ deliveryId: schema.gitWebhookDeliveries.deliveryId });
        if (inserted.length === 0) return c.json({ ok: true }); // already processed
      }

      // Best-effort signature verification: find the connection whose secret matches.
      const sigHeader = c.req.header('x-hub-signature-256')
        ?? c.req.header('x-gitea-signature')
        ?? c.req.header('x-gitlab-token')
        ?? c.req.header('x-hub-signature')
        ?? '';
      const sig = sigHeader.replace(/^sha256=/, '');
      const connections = await db.select().from(schema.gitConnections)
        .where(eq(schema.gitConnections.provider, provider));
      let matched: (typeof connections)[number] | undefined;
      for (const conn of connections) {
        if (sig && hmacSha256(conn.webhookSecret, raw) === sig) { matched = conn; break; }
      }
      // No signature header: fall back to a single configured connection (best-effort).
      if (!matched && !sig && connections.length === 1) matched = connections[0];
      if (!matched) return c.json({ ok: true });

      let payload: any;
      try { payload = JSON.parse(raw); } catch { return c.json({ ok: true }); }

      // Resolve the repositories of this connection and the projects they are bound to.
      const repos = await db.select().from(schema.gitRepositories)
        .where(eq(schema.gitRepositories.connectionId, matched.id));
      const connRepoIds = repos.map((r) => r.id);
      if (connRepoIds.length === 0) return c.json({ ok: true });

      const bindings = await db.select().from(schema.projectRepositories)
        .where(inArray(schema.projectRepositories.repositoryId, connRepoIds));
      const boundProjectIds = [...new Set(bindings.map((b) => b.projectId))];
      if (boundProjectIds.length === 0) return c.json({ ok: true });

      const repoFullName: string | null =
        payload?.repository?.full_name
        ?? payload?.repository?.path_with_namespace
        ?? payload?.project?.path_with_namespace
        ?? null;
      const repoByName = repoFullName ? repos.find((r) => r.fullName === repoFullName) : undefined;
      const linkRepoId = repoByName?.id ?? repos[0]?.id ?? null;

      // Collect webhook "candidates": pieces of text that may reference tasks.
      interface Candidate {
        text: string;
        type: 'branch' | 'commit' | 'pr';
        event: EventType | null;
        state: string | null;
        title: string | null;
        url: string | null;
        externalRef: string;
        author: string | null;
      }
      const candidates: Candidate[] = [];

      // Branch (push events, github/gitlab/gitea share `ref`).
      const ref: string | null = typeof payload?.ref === 'string' ? payload.ref : null;
      if (ref && ref.startsWith('refs/heads/')) {
        const branch = ref.slice('refs/heads/'.length);
        const zero = '0000000000000000000000000000000000000000';
        const isCreate = payload?.created === true || payload?.before === zero;
        candidates.push({
          text: branch, type: 'branch',
          event: isCreate ? 'git.branch_created' : null,
          state: null, title: branch, url: null, externalRef: branch,
          author: payload?.pusher?.name ?? payload?.user_name ?? payload?.sender?.login ?? null,
        });
      }

      // Commits (push events).
      const commits = Array.isArray(payload?.commits) ? payload.commits : [];
      for (const cm of commits) {
        const msg: unknown = cm?.message;
        if (typeof msg === 'string' && msg) {
          const externalRef = String(cm?.id ?? cm?.sha ?? '').slice(0, 40) || msg.slice(0, 40);
          candidates.push({
            text: msg, type: 'commit', event: null, state: null,
            title: msg.split('\n')[0]?.slice(0, 200) ?? null,
            url: typeof cm?.url === 'string' ? cm.url : null,
            externalRef,
            author: cm?.author?.name ?? cm?.author?.username ?? null,
          });
        }
      }

      // Pull request (github / gitea).
      const pr = payload?.pull_request;
      if (pr && typeof pr === 'object') {
        const action: string = typeof payload?.action === 'string' ? payload.action : '';
        const merged = pr.merged === true || !!pr.merged_at;
        let event: EventType | null = null;
        let state: string = typeof pr.state === 'string' ? pr.state : 'open';
        if (action === 'opened' || action === 'reopened') { event = 'git.pr_opened'; state = 'open'; }
        else if (action === 'closed') {
          if (merged) { event = 'git.pr_merged'; state = 'merged'; }
          else { event = 'git.pr_closed'; state = 'closed'; }
        }
        candidates.push({
          text: `${pr.title ?? ''}\n${pr.body ?? ''}`, type: 'pr', event, state,
          title: typeof pr.title === 'string' ? pr.title : null,
          url: pr.html_url ?? pr.url ?? null,
          externalRef: String(pr.number ?? pr.id ?? ''),
          author: pr.user?.login ?? null,
        });
      }

      // Merge request (gitlab).
      if (payload?.object_kind === 'merge_request' && payload?.object_attributes) {
        const oa = payload.object_attributes;
        const gaction: string = typeof oa.action === 'string' ? oa.action : '';
        let event: EventType | null = null;
        let state: string = typeof oa.state === 'string' ? oa.state : 'opened';
        if (gaction === 'open' || gaction === 'reopen') { event = 'git.pr_opened'; state = 'open'; }
        else if (gaction === 'merge') { event = 'git.pr_merged'; state = 'merged'; }
        else if (gaction === 'close') { event = 'git.pr_closed'; state = 'closed'; }
        candidates.push({
          text: `${oa.title ?? ''}\n${oa.description ?? ''}`, type: 'pr', event, state,
          title: typeof oa.title === 'string' ? oa.title : null,
          url: typeof oa.url === 'string' ? oa.url : null,
          externalRef: String(oa.iid ?? oa.id ?? ''),
          author: payload?.user?.username ?? payload?.user?.name ?? null,
        });
      }

      // Resolve each task reference to a bound task and record the link + event.
      for (const cand of candidates) {
        for (const r of parseTaskRefs(cand.text)) {
          const [project] = await db.select({ id: schema.projects.id })
            .from(schema.projects)
            .where(and(
              eq(schema.projects.key, r.key),
              inArray(schema.projects.id, boundProjectIds),
              isNull(schema.projects.deletedAt),
            ));
          if (!project) continue;
          const [task] = await db.select({ id: schema.tasks.id })
            .from(schema.tasks)
            .where(and(
              eq(schema.tasks.projectId, project.id),
              eq(schema.tasks.number, r.number),
              isNull(schema.tasks.deletedAt),
            ));
          if (!task) continue;

          const [existing] = await db.select({ id: schema.gitLinks.id })
            .from(schema.gitLinks)
            .where(and(
              eq(schema.gitLinks.taskId, task.id),
              eq(schema.gitLinks.type, cand.type),
              eq(schema.gitLinks.externalRef, cand.externalRef),
            ));
          if (!existing) {
            await db.insert(schema.gitLinks).values({
              id: ulid(),
              taskId: task.id,
              repositoryId: linkRepoId,
              type: cand.type,
              externalRef: cand.externalRef,
              title: cand.title,
              url: cand.url,
              state: cand.state,
              author: cand.author,
            });
          } else if (cand.type === 'pr') {
            await db.update(schema.gitLinks)
              .set({ state: cand.state, title: cand.title, url: cand.url, updatedAt: new Date() })
              .where(eq(schema.gitLinks.id, existing.id));
          }

          if (cand.event) {
            await emit({
              type: cand.event, aggregateType: 'task', aggregateId: task.id,
              payload: { taskId: task.id, projectId: project.id, ref: `${r.key}-${r.number}`, assigneeIds: [] },
              actorId: null, actorType: 'integration',
            });
          }
        }
      }

      return c.json({ ok: true });
    } catch {
      return c.json({ ok: true });
    }
  });

  return app;
}
