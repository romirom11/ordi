/**
 * Profile → MCP & API → Connect a client: what to paste into each client.
 * Signing in through the browser (OAuth) is the normal way and needs only
 * ordi's address; a token is the fallback for a client that cannot open a
 * browser, sent as a bearer header – or, for a client without remote MCP
 * support at all, handed to the stdio server run from the ordi repository.
 */

export const MCP_CLIENTS = ['claude-code', 'claude-desktop', 'cursor', 'codex', 'other'] as const;
export type McpClient = (typeof MCP_CLIENTS)[number];

/** Product names: never translated, and the name a token for the client is given. */
export const CLIENT_NAMES: Record<Exclude<McpClient, 'other'>, string> = {
  'claude-code': 'Claude Code',
  'claude-desktop': 'Claude Desktop',
  cursor: 'Cursor',
  codex: 'Codex CLI',
};

export interface Setup {
  /** Where the snippet goes: a dictionary key, see McpPanel. */
  step: string;
  /** What to copy. */
  snippet: string;
}

/** The one thing to paste for a client that signs in through the browser. */
export function signInSetup(client: McpClient, mcpUrl: string): Setup {
  switch (client) {
    case 'claude-code':
      return { step: 'mcp.step.terminal', snippet: `claude mcp add --transport http ordi ${mcpUrl}` };
    case 'claude-desktop':
      return { step: 'mcp.step.desktop', snippet: mcpUrl };
    case 'cursor':
      return { step: 'mcp.step.cursor', snippet: JSON.stringify({ mcpServers: { ordi: { url: mcpUrl } } }, null, 2) };
    case 'codex':
      return { step: 'mcp.step.codex', snippet: `[mcp_servers.ordi]\nurl = "${mcpUrl}"` };
    case 'other':
      return { step: 'mcp.step.other', snippet: mcpUrl };
  }
}

/** A client given a token: over HTTP with a bearer header where it can, otherwise stdio. */
export function tokenSetup(client: McpClient, mcpUrl: string, origin: string, token: string): { main: Setup; stdio: Setup | null } {
  const auth = `Bearer ${token}`;
  const stdioEntry = {
    command: 'npx',
    args: ['tsx', 'packages/mcp/src/index.ts'],
    env: { ORDI_API_URL: origin, ORDI_API_TOKEN: token },
  };
  const stdioJson = JSON.stringify({ mcpServers: { ordi: stdioEntry } }, null, 2);
  switch (client) {
    case 'claude-code':
      return {
        main: { step: 'mcp.step.terminal', snippet: `claude mcp add --transport http ordi ${mcpUrl} --header "Authorization: ${auth}"` },
        stdio: { step: 'mcp.step.stdio', snippet: `claude mcp add ordi -e ORDI_API_URL=${origin} -e ORDI_API_TOKEN=${token} -- npx tsx packages/mcp/src/index.ts` },
      };
    case 'claude-desktop':
      // Its config file takes local (stdio) servers only.
      return { main: { step: 'mcp.step.desktopConfig', snippet: stdioJson }, stdio: null };
    case 'cursor':
      return {
        main: { step: 'mcp.step.cursor', snippet: JSON.stringify({ mcpServers: { ordi: { url: mcpUrl, headers: { Authorization: auth } } } }, null, 2) },
        stdio: { step: 'mcp.step.stdio', snippet: stdioJson },
      };
    case 'codex':
      return {
        main: { step: 'mcp.step.codex', snippet: `[mcp_servers.ordi]\nurl = "${mcpUrl}"\nhttp_headers = { Authorization = "${auth}" }` },
        stdio: {
          step: 'mcp.step.stdio',
          snippet: `[mcp_servers.ordi]\ncommand = "npx"\nargs = ["tsx", "packages/mcp/src/index.ts"]\nenv = { ORDI_API_URL = "${origin}", ORDI_API_TOKEN = "${token}" }`,
        },
      };
    case 'other':
      return {
        main: { step: 'mcp.step.otherToken', snippet: JSON.stringify({ mcpServers: { ordi: { type: 'http', url: mcpUrl, headers: { Authorization: auth } } } }, null, 2) },
        stdio: { step: 'mcp.step.stdio', snippet: stdioJson },
      };
  }
}
