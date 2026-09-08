/**
 * The Claude adapter over a fake `query` (plan 2026-09-05-001, R33-R35,
 * KTD3): the child env carries exactly one credential and none of the API's
 * secrets, SDK messages become run events, the structured report decides
 * between done and needs_input, rate limits surface as rate_limited, and an
 * abort ends the run as failed.
 */
import { describe, it, expect } from 'vitest';
import type { Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { buildRuntimeEnv, createClaudeCodeAdapter, type QueryFn, extractSlug } from '../domains/agents/runtime/claude-code';
import type { RuntimeEvent, RuntimeRunInput } from '../domains/agents/runtime/types';

function msg<T extends Partial<SDKMessage>>(m: T): SDKMessage {
  return { uuid: '00000000-0000-0000-0000-000000000000', session_id: 'sess-1', ...m } as unknown as SDKMessage;
}

function resultOk(extra: Record<string, unknown> = {}): SDKMessage {
  return msg({
    type: 'result', subtype: 'success', is_error: false, num_turns: 3, duration_ms: 1200, duration_api_ms: 900,
    total_cost_usd: 0.42, result: 'All done', stop_reason: 'end_turn',
    usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 },
    modelUsage: {}, permission_denials: [], ...extra,
  } as never);
}

function scripted(messages: SDKMessage[], seen?: { options?: Options; prompt?: string }): QueryFn {
  return ({ prompt, options }) => {
    if (seen) { seen.options = options; seen.prompt = prompt; }
    return (async function* () { for (const m of messages) yield m; })();
  };
}

function input(overrides: Partial<RuntimeRunInput> = {}): RuntimeRunInput & { events: RuntimeEvent[] } {
  const events: RuntimeEvent[] = [];
  return {
    prompt: 'Fix it', systemAppend: 'rules', cwd: '/tmp', configDir: '/tmp/cfg',
    credential: { kind: 'subscription', secret: 'sk-ant-oat01-secret' },
    mcpServers: { ordi: { type: 'http', url: 'http://localhost:3000/api/v1/mcp', headers: { Authorization: 'Bearer t' } } },
    maxTurns: 20, maxBudgetUsd: null, resume: null, allowedTools: ['Read'], disallowedTools: [],
    signal: new AbortController().signal,
    onEvent: (e) => { events.push(e); },
    events,
    ...overrides,
  };
}

describe('runtime env', () => {
  it('carries exactly one credential and none of the API secrets', () => {
    process.env.DATABASE_URL = 'postgres://secret';
    const sub = buildRuntimeEnv({ kind: 'subscription', secret: 'oat' }, '/cfg');
    expect(sub.CLAUDE_CODE_OAUTH_TOKEN).toBe('oat');
    expect(sub.ANTHROPIC_API_KEY).toBeUndefined();
    expect(sub.DATABASE_URL).toBeUndefined();
    expect(sub.ENCRYPTION_KEY).toBeUndefined();
    expect(sub.HOME).toBe('/cfg');
    expect(sub.CLAUDE_CONFIG_DIR).toBe('/cfg');
    const key = buildRuntimeEnv({ kind: 'api_key', secret: 'sk' }, '/cfg');
    expect(key.ANTHROPIC_API_KEY).toBe('sk');
    expect(key.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
  });
});

describe('claude adapter', () => {
  it('passes the harness options the plan requires and turns messages into events and a report', async () => {
    const seen: { options?: Options; prompt?: string } = {};
    const adapter = createClaudeCodeAdapter(scripted([
      msg({ type: 'system', subtype: 'init', model: 'claude-test', mcp_servers: [{ name: 'ordi', status: 'connected' }], tools: [], cwd: '/tmp', permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: 'x', slash_commands: [], output_style: 'default' } as never),
      msg({ type: 'assistant', parent_tool_use_id: null, message: { role: 'assistant', content: [{ type: 'text', text: 'Looking at the test' }, { type: 'tool_use', id: 'tu1', name: 'Read', input: { path: 'a.ts' } }] } } as never),
      msg({ type: 'user', parent_tool_use_id: null, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: 'file contents' }] }] } } as never),
      resultOk({ structured_output: { status: 'done', summary: 'Fixed the retry', prUrl: null, branch: 'fix/AGT-1', question: null } }),
    ], seen));
    const inp = input({ maxBudgetUsd: 3, resume: 'prev-session' });
    const outcome = await adapter.run(inp);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.sessionId).toBe('sess-1');
    expect(outcome.report?.summary).toBe('Fixed the retry');
    expect(outcome.usage).toMatchObject({ turns: 3, costUsd: 0.42, inputTokens: 100, outputTokens: 50 });
    expect(inp.events.map((e) => e.type)).toEqual(['init', 'assistant', 'tool_result']);
    expect(seen.prompt).toBe('Fix it');
    expect(seen.options).toMatchObject({
      permissionMode: 'dontAsk', strictMcpConfig: true, maxTurns: 20, maxBudgetUsd: 3, resume: 'prev-session', cwd: '/tmp',
      settingSources: ['project'], allowedTools: ['Read'],
    });
    expect((seen.options!.systemPrompt as { append: string }).append).toBe('rules');
    expect(seen.options!.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-ant-oat01-secret');
    expect((seen.options!.mcpServers as Record<string, unknown>).ordi).toBeDefined();
  });

  it('a needs_input report ends the run as needs_input with the question', async () => {
    const adapter = createClaudeCodeAdapter(scripted([
      resultOk({ structured_output: { status: 'needs_input', summary: 'Which API?', prUrl: null, branch: null, question: 'v1 or v2?' } }),
    ]));
    const outcome = await adapter.run(input());
    expect(outcome.status).toBe('needs_input');
    expect(outcome.report?.question).toBe('v1 or v2?');
  });

  it('a rejected rate limit event marks the run rate_limited with the reset time', async () => {
    const adapter = createClaudeCodeAdapter(scripted([
      msg({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1_800_000_000, rateLimitType: 'five_hour' } } as never),
      msg({ type: 'result', subtype: 'error_during_execution', is_error: true, num_turns: 1, duration_ms: 10, duration_api_ms: 5, total_cost_usd: 0, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null } as never),
    ]));
    const outcome = await adapter.run(input());
    expect(outcome.status).toBe('rate_limited');
    expect(outcome.retryAt).toBe(1_800_000_000 * 1000);
  });

  it('a usage-limit error text without an event still counts as rate limited', async () => {
    const adapter = createClaudeCodeAdapter(scripted([
      resultOk({ is_error: true, result: "You've hit your usage limit for this week" }),
    ]));
    expect((await adapter.run(input())).status).toBe('rate_limited');
  });

  it('max turns is a failure with the subtype as the error', async () => {
    const adapter = createClaudeCodeAdapter(scripted([
      msg({ type: 'result', subtype: 'error_max_turns', is_error: true, num_turns: 20, duration_ms: 10, duration_api_ms: 5, total_cost_usd: 1, usage: {}, modelUsage: {}, permission_denials: [], stop_reason: null } as never),
    ]));
    const outcome = await adapter.run(input());
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toBe('error_max_turns');
  });

  it('a thrown query is a failure, not a crash', async () => {
    const adapter = createClaudeCodeAdapter(() => { throw new Error('spawn ENOENT'); });
    const outcome = await adapter.run(input());
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('ENOENT');
  });

  it('suggestBranchSlug asks haiku for one turn without tools and validates the answer', async () => {
    const seen: { options?: Options; prompt?: string } = {};
    const adapter = createClaudeCodeAdapter(scripted([resultOk({ result: 'Show Remaining Leave Days\n' })], seen));
    const slug = await adapter.suggestBranchSlug({ title: 'Додати доступну кількість днів відпустки', description: 'щоб не брати більше, ніж є', credential: { kind: 'subscription', secret: 's' }, configDir: '/tmp/cfg' });
    expect(slug).toBe('show-remaining-leave-days');
    expect(seen.options).toMatchObject({ model: 'haiku', maxTurns: 1, tools: [], settingSources: [] });
    expect(seen.prompt).toContain('днів відпустки');
    expect(seen.options!.env!.CLAUDE_CODE_OAUTH_TOKEN).toBe('s');
    // Garbage, an error result or a throw all mean "no suggestion".
    expect(await createClaudeCodeAdapter(scripted([resultOk({ result: '???' })])).suggestBranchSlug({ title: 't', description: '', credential: { kind: 'api_key', secret: 'k' }, configDir: '/tmp' })).toBeNull();
    expect(await createClaudeCodeAdapter(scripted([resultOk({ is_error: true, result: 'nope' })])).suggestBranchSlug({ title: 't', description: '', credential: { kind: 'api_key', secret: 'k' }, configDir: '/tmp' })).toBeNull();
    expect(await createClaudeCodeAdapter(() => { throw new Error('down'); }).suggestBranchSlug({ title: 't', description: '', credential: { kind: 'api_key', secret: 'k' }, configDir: '/tmp' })).toBeNull();
  });

  it('extractSlug keeps only a usable kebab-case answer', () => {
    expect(extractSlug('`add-leave-balance`')).toBe('add-leave-balance');
    expect(extractSlug('Sure! Here it is:\nadd leave balance to profile')).toBe('sure-here-it-is');
    expect(extractSlug('1234')).toBeNull();
    expect(extractSlug('')).toBeNull();
    expect(extractSlug('a'.repeat(80))).toHaveLength(50);
  });

  it('verify reports the model and refuses on an auth error', async () => {
    const ok = createClaudeCodeAdapter(scripted([
      msg({ type: 'system', subtype: 'init', model: 'claude-test', mcp_servers: [], tools: [], cwd: '/tmp', permissionMode: 'dontAsk', apiKeySource: 'none', claude_code_version: 'x', slash_commands: [], output_style: 'default' } as never),
      resultOk({ result: 'OK' }),
    ]));
    expect(await ok.verify({ kind: 'api_key', secret: 'sk' }, { configDir: '/tmp' })).toEqual({ ok: true, error: null, model: 'claude-test' });
    const bad = createClaudeCodeAdapter(scripted([
      msg({ type: 'assistant', parent_tool_use_id: null, error: 'authentication_failed', message: { role: 'assistant', content: [] } } as never),
    ]));
    expect((await bad.verify({ kind: 'api_key', secret: 'sk' }, { configDir: '/tmp' })).ok).toBe(false);
  });
});
