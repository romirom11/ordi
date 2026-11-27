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
  createExternalAgentSchema, updateExternalAgentSchema, issueExternalAgentTokenSchema,
  myAgentInputSchema, issueMyAgentTokenSchema,
} from '@ordi/shared';
import type { AppEnv } from '../../context';
import { requireAuth, currentActor } from '../../core/auth';
import { guard } from '../../core/rbac';
import { env } from '../../env';
import { err } from '../../lib/errors';
import * as credentials from './credentials';
import * as profiles from './profiles';
import * as external from './external';
import * as connectors from './connectors';
import { startConnectorOAuth, revokeConnectorOAuth, connectorCallbackUrl } from './connector-oauth';
import * as runs from './runs';
import { listWorkers } from './run-service';
import { runtimeAdapter } from './runtime';

export function agentsRoutes() {
  const app = new Hono<AppEnv>();
  app.use('*', requireAuth);

  // ── Workspace overview (runtimes, workers) ──
  app.get('/agents/overview', guard('agents.manage'), async (c) => {
    const [claude, codex] = await Promise.all([runtimeAdapter('claude_code').available(), runtimeAdapter('codex').available()]);
    const installed: Record<string, boolean> = { claude_code: claude.ok, codex: codex.ok };
    return c.json({
      runtimes: AGENT_RUNTIMES.map((r) => ({ key: r, available: (EXECUTABLE_AGENT_RUNTIMES as readonly string[]).includes(r), installed: installed[r] ?? false })),
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

  // ── External agents: run elsewhere, connect over MCP with their own token ──
  app.get('/external-agents', guard('agents.manage'), async (c) => c.json({ data: await external.listExternalAgents(currentActor(c)) }));

  // Every change needs a signed-in person: an agent or an API token setting
  // up agents (or minting their tokens) could keep itself alive forever.
  const person = (c: Parameters<typeof currentActor>[0]) => { const actor = currentActor(c); external.assertSignedInPerson(actor); return actor; };

  app.post('/external-agents', guard('agents.manage'), async (c) => {
    const actor = person(c);
    if (!actor.access.permissions.has('users.manage')) throw err.forbidden('Creating an agent also needs users.manage', 'users.manage');
    const body = createExternalAgentSchema.parse(await c.req.json());
    return c.json(await external.createExternalAgent(actor, body), 201);
  });

  app.patch('/external-agents/:id', guard('agents.manage'), async (c) => {
    const actor = person(c);
    const body = updateExternalAgentSchema.parse(await c.req.json());
    return c.json(await external.updateExternalAgent(actor, c.req.param('id'), body));
  });

  app.post('/external-agents/:id/disable', guard('agents.manage'), async (c) =>
    c.json(await external.setExternalAgentActive(person(c), c.req.param('id'), false)));
  app.post('/external-agents/:id/enable', guard('agents.manage'), async (c) =>
    c.json(await external.setExternalAgentActive(person(c), c.req.param('id'), true)));

  app.post('/external-agents/:id/tokens', guard('agents.manage'), async (c) => {
    const actor = person(c);
    const body = issueExternalAgentTokenSchema.parse(await c.req.json().catch(() => ({})));
    return c.json(await external.issueExternalAgentToken(actor, c.req.param('id'), body), 201);
  });

  app.delete('/external-agents/:id/tokens/:tokenId', guard('agents.manage'), async (c) =>
    c.json(await external.revokeExternalAgentToken(person(c), c.req.param('id'), c.req.param('tokenId'))));

  // ── A person's own agent: no permission needed beyond being signed in ──
  app.get('/my-agent', async (c) => c.json({ agent: await external.getMyAgent(currentActor(c)) }));
  app.post('/my-agent', async (c) => {
    const body = myAgentInputSchema.parse(await c.req.json());
    return c.json(await external.createMyAgent(currentActor(c), body.name), 201);
  });
  app.patch('/my-agent', async (c) => {
    const body = myAgentInputSchema.parse(await c.req.json());
    return c.json(await external.renameMyAgent(currentActor(c), body.name));
  });
  app.post('/my-agent/disable', async (c) => c.json(await external.setMyAgentActive(currentActor(c), false)));
  app.post('/my-agent/enable', async (c) => c.json(await external.setMyAgentActive(currentActor(c), true)));
  app.post('/my-agent/tokens', async (c) => {
    const body = issueMyAgentTokenSchema.parse(await c.req.json());
    return c.json(await external.issueMyAgentToken(currentActor(c), body), 201);
  });
  app.delete('/my-agent/tokens/:tokenId', async (c) =>
    c.json(await external.revokeMyAgentToken(currentActor(c), c.req.param('tokenId'))));

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
