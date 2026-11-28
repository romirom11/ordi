import { describe, it, expect } from 'vitest';
import { MCP_CLIENTS, signInSetup, tokenSetup } from './mcpClients';

const URL = 'https://ordi.example.com/api/v1/mcp';
const ORIGIN = 'https://ordi.example.com';

describe('signInSetup', () => {
  it('gives every client one thing to paste, holding ordi’s address and no token', () => {
    for (const client of MCP_CLIENTS) {
      const { snippet } = signInSetup(client, URL);
      expect(snippet).toContain(URL);
      expect(snippet).not.toMatch(/Bearer|TOKEN/);
    }
  });

  it('is a command for Claude Code and config for Cursor and Codex', () => {
    expect(signInSetup('claude-code', URL).snippet).toBe(`claude mcp add --transport http ordi ${URL}`);
    expect(JSON.parse(signInSetup('cursor', URL).snippet)).toEqual({ mcpServers: { ordi: { url: URL } } });
    expect(signInSetup('codex', URL).snippet).toBe(`[mcp_servers.ordi]\nurl = "${URL}"`);
  });
});

describe('tokenSetup', () => {
  it('sends the token as a bearer header where the client connects over HTTP', () => {
    expect(tokenSetup('claude-code', URL, ORIGIN, 'ordi_x').main.snippet).toContain('--header "Authorization: Bearer ordi_x"');
    expect(JSON.parse(tokenSetup('cursor', URL, ORIGIN, 'ordi_x').main.snippet).mcpServers.ordi.headers).toEqual({ Authorization: 'Bearer ordi_x' });
    expect(tokenSetup('codex', URL, ORIGIN, 'ordi_x').main.snippet).toContain('http_headers = { Authorization = "Bearer ordi_x" }');
  });

  it('runs the stdio server for Claude Desktop, whose config takes nothing else', () => {
    const { main, stdio } = tokenSetup('claude-desktop', URL, ORIGIN, 'ordi_x');
    expect(JSON.parse(main.snippet).mcpServers.ordi.env).toEqual({ ORDI_API_URL: ORIGIN, ORDI_API_TOKEN: 'ordi_x' });
    expect(stdio).toBeNull();
  });

  it('offers stdio as the fallback for every other client', () => {
    for (const client of MCP_CLIENTS.filter((c) => c !== 'claude-desktop')) {
      expect(tokenSetup(client, URL, ORIGIN, 'ordi_x').stdio?.snippet).toContain('ORDI_API_TOKEN');
    }
  });
});
