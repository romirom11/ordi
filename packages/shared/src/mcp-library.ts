/**
 * Curated MCP connector library (plan 2026-09-05-001, R18). Entries are data:
 * the API turns one into an `mcp_connectors` row after the admin fills the
 * required secrets, and nothing here is executed by itself. Commands are
 * pinned so a library stdio connector never resolves to a moving target.
 */
export interface McpLibrarySecretField {
  /** Key under which the value is stored – a header name for http, an env name for stdio. */
  key: string;
  label: string;
  /** `header` becomes an upstream request header, `env` a child-process variable. */
  as: 'header' | 'env';
  /** Optional template: `Bearer {value}` – the stored secret is substituted for `{value}`. */
  template?: string;
  required: boolean;
  help?: string;
}

export interface McpLibraryEntry {
  key: string;
  name: string;
  description: string;
  docsUrl: string;
  transport: 'http' | 'sse' | 'stdio';
  /** For http/sse connectors. */
  url?: string;
  /** For stdio connectors: pinned command and arguments. */
  command?: string;
  args?: string[];
  /** `oauth` means the server authenticates through the MCP OAuth flow ordi runs itself. */
  auth: 'none' | 'secrets' | 'oauth';
  secrets: McpLibrarySecretField[];
}

export const MCP_LIBRARY: readonly McpLibraryEntry[] = [
  {
    key: 'github',
    name: 'GitHub',
    description: 'Issues, pull requests, code search and repository metadata.',
    docsUrl: 'https://github.com/github/github-mcp-server',
    transport: 'http',
    url: 'https://api.githubcopilot.com/mcp/',
    auth: 'secrets',
    secrets: [{
      key: 'Authorization', label: 'Personal access token', as: 'header', template: 'Bearer {value}', required: true,
      help: 'A fine-grained token with the repositories the agent may touch.',
    }],
  },
  {
    key: 'context7',
    name: 'Context7',
    description: 'Up-to-date library documentation and code examples.',
    docsUrl: 'https://github.com/upstash/context7',
    transport: 'http',
    url: 'https://mcp.context7.com/mcp',
    auth: 'secrets',
    secrets: [{ key: 'CONTEXT7_API_KEY', label: 'API key', as: 'header', required: false }],
  },
  {
    key: 'playwright',
    name: 'Playwright',
    description: 'Drive a headless browser: open pages, click, fill forms, take screenshots.',
    docsUrl: 'https://github.com/microsoft/playwright-mcp',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@playwright/mcp@0.0.41', '--headless'],
    auth: 'none',
    secrets: [],
  },
  {
    key: 'sentry',
    name: 'Sentry',
    description: 'Issues, events and stack traces from your Sentry organisation.',
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    transport: 'http',
    url: 'https://mcp.sentry.dev/mcp',
    auth: 'oauth',
    secrets: [],
  },
  {
    key: 'notion',
    name: 'Notion',
    description: 'Search and read Notion pages and databases.',
    docsUrl: 'https://developers.notion.com/docs/mcp',
    transport: 'http',
    url: 'https://mcp.notion.com/mcp',
    auth: 'oauth',
    secrets: [],
  },
  {
    key: 'linear',
    name: 'Linear',
    description: 'Issues, projects and cycles in Linear.',
    docsUrl: 'https://linear.app/docs/mcp',
    transport: 'http',
    url: 'https://mcp.linear.app/mcp',
    auth: 'oauth',
    secrets: [],
  },
  {
    key: 'slack',
    name: 'Slack',
    description: 'Read channels and post messages in your Slack workspace.',
    docsUrl: 'https://docs.slack.dev/ai/mcp-server',
    transport: 'http',
    url: 'https://mcp.slack.com/mcp',
    auth: 'oauth',
    secrets: [],
  },
  {
    key: 'figma',
    name: 'Figma',
    description: 'Design context from Figma files and components.',
    docsUrl: 'https://help.figma.com/hc/en-us/articles/32132100833559',
    transport: 'http',
    url: 'https://mcp.figma.com/mcp',
    auth: 'oauth',
    secrets: [],
  },
  {
    key: 'postgres',
    name: 'PostgreSQL',
    description: 'Read-only SQL against a Postgres database.',
    docsUrl: 'https://github.com/crystaldba/postgres-mcp',
    transport: 'stdio',
    command: 'npx',
    args: ['-y', '@modelcontextprotocol/server-postgres@0.6.2'],
    auth: 'secrets',
    secrets: [{
      key: 'DATABASE_URI', label: 'Connection string', as: 'env', required: true,
      help: 'Use a read-only database user.',
    }],
  },
];

export function findMcpLibraryEntry(key: string): McpLibraryEntry | undefined {
  return MCP_LIBRARY.find((e) => e.key === key);
}
