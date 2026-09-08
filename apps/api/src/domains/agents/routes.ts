/**
 * Agents domain routes (plan 2026-09-05-001). Credentials, agents and runs
 * sit behind agents.manage (runs are readable by task viewers); the connector
 * library behind integrations.manage. The gateway is mounted separately
 * because it authenticates run tokens on its own.
 */
import { Hono } from 'hono';
import { z } from 'zod';
import {
  MCP_LIBRARY, AGENT_RUNTIMES, EXECUTABLE_AGENT_RUNTIMES,
  agentCredentialInputSchema, updateAgentCredentialSchema, createAgentSchema, updateAgentSchema,
  customMcpConnectorInputSchema, libraryMcpConnectorInputSchema, updateMcpConnectorSchema, listAgentRunsQuerySchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { env } from '../../env';
import { err } from '../../lib/errors';
import * as credentials from './credentials';
import * as profiles from './profiles';
import * as connectors from './connectors';
import { startConnectorOAuth, completeConnectorOAuth, revokeConnectorOAuth, connectorCallbackUrl } from './connector-oauth';
import * as runs from './runs';
import { listWorkers } from '../../workers/agent-runs';
import { runtimeAdapter } from './runtime';

export function agentsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Workspace overview (runtimes, workers) ──
  app.get('/agents/overview', guard('agents.manage'), async (c) => {
    const claude = await runtimeAdapter('claude_code').available();
    return c.json({
      runtimes: AGENT_RUNTIMES.map((r) => ({ key: r, available: (EXECUTABLE_AGENT_RUNTIMES as readonly string[]).includes(r), installed: r === 'claude_code' ? claude.ok : false })),
      workers: await listWorkers(),
      workerEnabled: env.agentWorkerEnabled,
      connectorCallbackUrl: connectorCallbackUrl(),
    });
  });

  // ── Agents ──
  app.get('/agents', guard('agents.manage'), async (c) => c.json({ data: await profiles.listAgents() }));

  app.post('/agents', guard('agents.manage'), async (c) => {
    const actor = currentActor(c);
    if (!actor.access.permissions.has('users.manage')) throw err.forbidden('Creating an agent also needs users.manage', 'users.manage');
    const body = createAgentSchema.parse(await c.req.json());
    return c.json(await profiles.createAgent(actor, body), 201);
  });

  app.get('/agents/:id', guard('agents.manage'), async (c) => c.json(await profiles.getAgent(c.req.param('id'))));

  app.patch('/agents/:id', guard('agents.manage'), async (c) => {
    const body = updateAgentSchema.parse(await c.req.json());
    return c.json(await profiles.updateAgent(currentActor(c), c.req.param('id'), body));
  });

  app.post('/agents/:id/disable', guard('agents.manage'), async (c) => c.json(await profiles.setAgentActive(currentActor(c), c.req.param('id'), false)));
  app.post('/agents/:id/enable', guard('agents.manage'), async (c) => c.json(await profiles.setAgentActive(currentActor(c), c.req.param('id'), true)));

  // ── Credentials ──
  app.get('/agent-credentials', guard('agents.manage'), async (c) => c.json({ data: await credentials.listCredentials() }));

  app.post('/agent-credentials', guard('agents.manage'), async (c) => {
    const body = agentCredentialInputSchema.parse(await c.req.json());
    return c.json(await credentials.createCredential(currentActor(c), body), 201);
  });

  app.patch('/agent-credentials/:id', guard('agents.manage'), async (c) => {
    const body = updateAgentCredentialSchema.parse(await c.req.json());
    return c.json(await credentials.updateCredential(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/agent-credentials/:id', guard('agents.manage'), async (c) => {
    await credentials.revokeCredential(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/agent-credentials/:id/verify', guard('agents.manage'), async (c) =>
    c.json(await credentials.verifyCredential(currentActor(c), c.req.param('id'))));

  // ── Connector library ──
  app.get('/mcp-connectors/library', guard('integrations.manage'), (c) => c.json({ data: MCP_LIBRARY }));

  app.get('/mcp-connectors', guard('integrations.manage'), async (c) => c.json({ data: await connectors.listConnectors() }));

  app.post('/mcp-connectors/library', guard('integrations.manage'), async (c) => {
    const body = libraryMcpConnectorInputSchema.parse(await c.req.json());
    return c.json(await connectors.createLibraryConnector(currentActor(c), body), 201);
  });

  app.post('/mcp-connectors/custom', guard('integrations.manage'), async (c) => {
    const body = customMcpConnectorInputSchema.parse(await c.req.json());
    return c.json(await connectors.createCustomConnector(currentActor(c), body), 201);
  });

  // The browser lands here after consent. Registered before /:id so the
  // literal segment wins.
  app.get('/mcp-connectors/oauth/callback', guard('integrations.manage'), async (c) => {
    const q = z.object({ code: z.string().optional(), state: z.string().optional(), error: z.string().optional(), error_description: z.string().optional() }).parse(c.req.query());
    const back = `${env.appUrl.replace(/\/$/, '')}/settings/connectors`;
    if (q.error || !q.code || !q.state) {
      return c.redirect(`${back}?oauth=error&reason=${encodeURIComponent(q.error_description ?? q.error ?? 'missing code')}`);
    }
    try {
      const done = await completeConnectorOAuth(currentActor(c), q.code, q.state);
      return c.redirect(`${back}?oauth=connected&connector=${encodeURIComponent(done.slug)}`);
    } catch (e) {
      return c.redirect(`${back}?oauth=error&reason=${encodeURIComponent((e as Error).message)}`);
    }
  });

  app.get('/mcp-connectors/:id', guard('integrations.manage'), async (c) => c.json(await connectors.getConnector(c.req.param('id'))));

  app.patch('/mcp-connectors/:id', guard('integrations.manage'), async (c) => {
    const body = updateMcpConnectorSchema.parse(await c.req.json());
    return c.json(await connectors.updateConnector(currentActor(c), c.req.param('id'), body));
  });

  app.delete('/mcp-connectors/:id', guard('integrations.manage'), async (c) => {
    await connectors.deleteConnector(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  app.post('/mcp-connectors/:id/test', guard('integrations.manage'), async (c) =>
    c.json(await connectors.testConnector(currentActor(c), c.req.param('id'))));

  app.post('/mcp-connectors/:id/oauth/start', guard('integrations.manage'), async (c) =>
    c.json(await startConnectorOAuth(currentActor(c), c.req.param('id'))));

  app.post('/mcp-connectors/:id/oauth/revoke', guard('integrations.manage'), async (c) => {
    await revokeConnectorOAuth(currentActor(c), c.req.param('id'));
    return c.json({ ok: true });
  });

  // ── Runs (visibility follows the task, R50) ──
  app.get('/agent-runs', async (c) => {
    const q = listAgentRunsQuerySchema.parse(c.req.query());
    return c.json({ data: await runs.listRuns(currentActor(c), q) });
  });

  app.get('/agent-runs/:id', async (c) => c.json(await runs.getRun(currentActor(c), c.req.param('id'))));

  // No `after` means "the tail": the last page of the log, not the first.
  app.get('/agent-runs/:id/events', async (c) => {
    const after = Number(c.req.query('after') ?? 0);
    return c.json({ data: await runs.getRunEvents(currentActor(c), c.req.param('id'), Number.isFinite(after) ? after : 0) });
  });

  app.post('/agent-runs/:id/cancel', async (c) => c.json(await runs.cancelRun(currentActor(c), c.req.param('id'))));
  app.post('/agent-runs/:id/retry', async (c) => c.json(await runs.retryRun(currentActor(c), c.req.param('id')), 201));

  return app;
}
