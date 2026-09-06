/**
 * Claude Code through the Agent SDK (plan 2026-09-05-001, KTD3). The SDK
 * bundles the runtime, so nothing else is installed; `query()` is injected so
 * tests drive the adapter without a model.
 *
 * The child process gets a rebuilt environment (R34): PATH, a per-run HOME
 * and CLAUDE_CONFIG_DIR, exactly one credential, and MCP timeouts. Never the
 * API's own secrets.
 */
import { USAGE_LIMIT_ERROR_PREFIXES, query as sdkQuery, type Options, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { logger } from '../../../lib/logger';
import {
  AGENT_REPORT_SCHEMA, parseReport,
  type RuntimeAdapter, type RuntimeCredential, type RuntimeOutcome, type RuntimeRunInput, type RuntimeUsage,
} from './types';

export type QueryFn = (params: { prompt: string; options?: Options }) => AsyncIterable<SDKMessage>;

/** Env for the harness: only what it needs to run and to authenticate (R34). */
export function buildRuntimeEnv(credential: RuntimeCredential, configDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: configDir,
    CLAUDE_CONFIG_DIR: configDir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
    // MCP servers are local HTTP: connect fast, but give long tool calls room.
    MCP_TIMEOUT: process.env.MCP_TIMEOUT ?? '30000',
    MCP_TOOL_TIMEOUT: process.env.MCP_TOOL_TIMEOUT ?? String(10 * 60_000),
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    DISABLE_AUTOUPDATER: '1',
    DISABLE_TELEMETRY: '1',
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  // Precedence: an API key outranks the subscription token, so exactly one is set.
  if (credential.kind === 'api_key') env.ANTHROPIC_API_KEY = credential.secret;
  else env.CLAUDE_CODE_OAUTH_TOKEN = credential.secret;
  return env;
}

const RATE_LIMIT_PATTERNS = [/rate limit/i, /usage limit/i, /out of usage/i, /too many requests/i, /429/];

function looksRateLimited(text: string): boolean {
  if (USAGE_LIMIT_ERROR_PREFIXES.some((p) => text.startsWith(p))) return true;
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

function emptyUsage(): RuntimeUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, turns: 0, durationMs: 0 };
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b) => b && typeof b === 'object' && (b as { type?: string }).type === 'text')
    .map((b) => String((b as { text?: string }).text ?? ''))
    .join('\n');
}

export function createClaudeCodeAdapter(queryFn: QueryFn = sdkQuery as unknown as QueryFn): RuntimeAdapter {
  return {
    runtime: 'claude_code',

    async available() {
      try {
        // The SDK resolves its bundled binary at import time; a missing
        // optional dependency surfaces as a module resolution error here.
        const mod = await import('@anthropic-ai/claude-agent-sdk');
        return { ok: typeof mod.query === 'function', version: null, error: null };
      } catch (e) {
        return { ok: false, version: null, error: (e as Error).message };
      }
    },

    async verify(credential, opts) {
      const env = buildRuntimeEnv(credential, opts.configDir);
      let model: string | null = null;
      try {
        for await (const message of queryFn({
          prompt: 'Reply with the single word OK.',
          options: {
            env, cwd: opts.configDir, model: opts.model ?? undefined,
            maxTurns: 1, tools: [], mcpServers: {}, strictMcpConfig: true,
            permissionMode: 'dontAsk', settingSources: [],
            systemPrompt: { type: 'custom', prompt: 'You are a connectivity check. Answer with OK.' },
            abortController: abortFrom(opts.signal),
          },
        })) {
          if (message.type === 'system' && message.subtype === 'init') model = message.model;
          if (message.type === 'assistant' && message.error) {
            return { ok: false, error: `Claude answered with ${message.error}`, model };
          }
          if (message.type === 'result') {
            if (message.is_error) return { ok: false, error: message.subtype === 'success' ? message.result : message.subtype, model };
            return { ok: true, error: null, model };
          }
        }
        return { ok: false, error: 'No result from the runtime', model };
      } catch (e) {
        return { ok: false, error: (e as Error).message, model };
      }
    },

    async run(input): Promise<RuntimeOutcome> {
      const env = buildRuntimeEnv(input.credential, input.configDir);
      const usage = emptyUsage();
      let sessionId: string | null = input.resume ?? null;
      let rateLimited = false;
      let retryAt: number | null = null;
      let lastText = '';
      let outcome: RuntimeOutcome | null = null;
      const startedAt = Date.now();

      const options: Options = {
        env,
        cwd: input.cwd,
        model: input.model ?? undefined,
        systemPrompt: { type: 'preset', preset: 'claude_code', append: input.systemAppend },
        mcpServers: input.mcpServers,
        strictMcpConfig: true,
        settingSources: [],
        permissionMode: 'dontAsk',
        allowedTools: input.allowedTools,
        disallowedTools: input.disallowedTools,
        maxTurns: input.maxTurns,
        maxBudgetUsd: input.maxBudgetUsd ?? undefined,
        resume: input.resume ?? undefined,
        outputFormat: { type: 'json_schema', schema: AGENT_REPORT_SCHEMA as unknown as Record<string, unknown> },
        abortController: abortFrom(input.signal),
        hooks: {
          PreToolUse: [{
            hooks: [async (hookInput) => {
              if (hookInput.hook_event_name === 'PreToolUse') {
                await input.onEvent({ type: 'tool_use', toolUseId: hookInput.tool_use_id, name: hookInput.tool_name, input: hookInput.tool_input });
              }
              return { continue: true };
            }],
          }],
        },
      };

      try {
        for await (const message of queryFn({ prompt: input.prompt, options })) {
          switch (message.type) {
            case 'system': {
              if (message.subtype === 'init') {
                sessionId = message.session_id;
                await input.onEvent({ type: 'init', sessionId: message.session_id, model: message.model, mcpServers: message.mcp_servers });
              }
              break;
            }
            case 'assistant': {
              sessionId = message.session_id ?? sessionId;
              const content = (message.message as { content?: unknown }).content;
              const text = textOf(content);
              const toolUses = Array.isArray(content)
                ? content.filter((b: any) => b?.type === 'tool_use').map((b: any) => ({ id: String(b.id), name: String(b.name), input: b.input }))
                : [];
              if (text) lastText = text;
              if (message.error === 'rate_limit') rateLimited = true;
              await input.onEvent({ type: 'assistant', text, toolUses });
              break;
            }
            case 'user': {
              const content = (message.message as { content?: unknown }).content;
              if (Array.isArray(content)) {
                for (const block of content as any[]) {
                  if (block?.type !== 'tool_result') continue;
                  await input.onEvent({
                    type: 'tool_result', toolUseId: block.tool_use_id ?? null,
                    text: textOf(block.content).slice(0, 4000), isError: Boolean(block.is_error),
                  });
                }
              }
              break;
            }
            case 'rate_limit_event': {
              const info = message.rate_limit_info;
              await input.onEvent({ type: 'rate_limit', status: info.status, resetsAt: info.resetsAt ?? null, limitType: info.rateLimitType ?? null });
              if (info.status === 'rejected') {
                rateLimited = true;
                retryAt = info.resetsAt ? info.resetsAt * (info.resetsAt < 1e12 ? 1000 : 1) : null;
              }
              break;
            }
            case 'result': {
              usage.turns = message.num_turns;
              usage.durationMs = message.duration_ms;
              usage.costUsd = message.total_cost_usd;
              const u = message.usage as { input_tokens?: number; output_tokens?: number; cache_read_input_tokens?: number };
              usage.inputTokens = u?.input_tokens ?? 0;
              usage.outputTokens = u?.output_tokens ?? 0;
              usage.cacheReadInputTokens = u?.cache_read_input_tokens ?? 0;
              sessionId = message.session_id ?? sessionId;
              if (message.subtype === 'success') {
                const report = parseReport((message as { structured_output?: unknown }).structured_output);
                const text = message.result || lastText;
                if (message.is_error || (rateLimited && !report)) {
                  const limited = rateLimited || looksRateLimited(text);
                  outcome = { status: limited ? 'rate_limited' : 'failed', sessionId, report, message: text, error: text, usage, retryAt };
                } else if (report?.status === 'needs_input' || report?.status === 'blocked') {
                  outcome = { status: 'needs_input', sessionId, report, message: text, error: null, usage, retryAt: null };
                } else {
                  outcome = { status: 'succeeded', sessionId, report, message: text, error: null, usage, retryAt: null };
                }
              } else {
                const reason = message.subtype;
                outcome = {
                  status: rateLimited ? 'rate_limited' : 'failed', sessionId, report: null,
                  message: lastText, error: reason, usage, retryAt,
                };
              }
              break;
            }
            default:
              break;
          }
        }
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        logger.warn({ err: e }, 'claude runtime raised');
        usage.durationMs = Date.now() - startedAt;
        const limited = rateLimited || looksRateLimited(msg);
        return { status: limited ? 'rate_limited' : 'failed', sessionId, report: null, message: lastText, error: msg, usage, retryAt };
      }
      if (!outcome) {
        usage.durationMs = Date.now() - startedAt;
        return { status: input.signal.aborted ? 'failed' : 'failed', sessionId, report: null, message: lastText, error: input.signal.aborted ? 'aborted' : 'The runtime ended without a result', usage, retryAt };
      }
      return outcome;
    },
  };
}

function abortFrom(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort();
    else signal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  return controller;
}
