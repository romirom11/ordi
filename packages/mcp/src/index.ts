#!/usr/bin/env node
/**
 * ordi MCP server over stdio (PRD §16). The agent authenticates with an API
 * token; its permissions equal the token's scope, so "the agent sees finance"
 * is resolved exactly like a human: by the owning user's role and the token
 * scope. Destructive ops (delete/cancel) are intentionally NOT exposed. All
 * actions are recorded in activity as actor=agent.
 *
 * Prefer the hosted variant when the client supports OAuth: point it at
 * <instance>/api/v1/mcp and it signs in through the browser – no token to
 * copy. This stdio entry stays for clients that only run local commands.
 */
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { OrdiClient } from './client';
import { buildServer } from './server';

const baseUrl = process.env.ORDI_API_URL ?? 'http://localhost:3000';
const token = process.env.ORDI_API_TOKEN ?? '';
if (!token) {
  console.error('ORDI_API_TOKEN is required');
  process.exit(1);
}

async function main() {
  const server = buildServer(new OrdiClient({ baseUrl, token }));
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('ordi MCP server running on stdio');
}
main().catch((e) => { console.error(e); process.exit(1); });
