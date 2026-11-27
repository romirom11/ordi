/**
 * Every tool goes out with a title and read/write hints, taken from the one
 * table in @ordi/shared (MCP_TOOLS). Clients show the title to people and use
 * the hints to decide what needs a confirmation; the Claude directory refuses
 * a server whose tools lack them.
 *
 * The hints are attached as each tool registers, the same way buildServer
 * wraps the client: one place, no per-call boilerplate in the catalog.
 */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import { MCP_TOOLS, type McpToolMeta } from '@ordi/shared';

export function toolAnnotations(meta: McpToolMeta): ToolAnnotations {
  const readOnly = meta.kind === 'read';
  return {
    title: meta.title,
    readOnlyHint: readOnly,
    destructiveHint: meta.kind === 'destructive',
    idempotentHint: readOnly || meta.idempotent === true,
    openWorldHint: meta.openWorld === true,
  };
}

/**
 * From here on, every server.tool() registration carries its annotations. A
 * tool missing from MCP_TOOLS is refused at startup rather than served bare.
 */
export function annotateTools(server: McpServer): void {
  const register = server.tool.bind(server) as (name: string, ...rest: unknown[]) => RegisteredTool;
  server.tool = ((name: string, ...rest: unknown[]) => {
    const meta = (MCP_TOOLS as Record<string, McpToolMeta>)[name];
    if (!meta) throw new Error(`MCP tool "${name}" has no entry in MCP_TOOLS (packages/shared/src/mcp-tools.ts)`);
    const tool = register(name, ...rest);
    tool.update({ title: meta.title, annotations: toolAnnotations(meta) });
    return tool;
  }) as McpServer['tool'];
}
