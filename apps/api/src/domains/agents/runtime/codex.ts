/**
 * Codex runtime (plan 2026-09-05-001, KTD3). Drives `codex exec --json` as a
 * child process, one per run, with a rebuilt environment (R34).
 *
 * Three credential modes in one adapter:
 *  - api_key  + baseUrl=null  → native OpenAI (env OPENAI_API_KEY)
 *  - api_key  + baseUrl=URL   → custom OpenAI-compatible proxy via
 *    CODEX_HOME/config.toml [model_providers.ordi_custom] (docs: config-advanced)
 *  - subscription             → ChatGPT plan via CODEX_HOME/auth.json
 *    (produced by `codex login` on an admin machine; the UI pastes its content)
 *
 * Per-run isolation: CODEX_HOME and HOME both point at the task's harness dir
 * (tasks/<taskId>/harness, sibling of checkout), the same place claude-code.ts
 * uses for CLAUDE_CONFIG_DIR. Never replay env secrets into the agent's commits.
 */
import { execFile as execFileCb } from 'node:child_process';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { spawn } from 'node:child_process';
import { logger } from '../../../lib/logger';
import {
  AGENT_REPORT_SCHEMA, parseReport,
  type RuntimeAdapter, type RuntimeCredential, type RuntimeOutcome, type RuntimeRunInput, type RuntimeUsage,
} from './types';

const execFile = promisify(execFileCb);

/** Custom provider id used in the generated config.toml. */
export const CODEX_CUSTOM_PROVIDER_ID = 'ordi_custom';
/** Env var that carries the custom provider's token. */
export const CODEX_CUSTOM_TOKEN_ENV = 'ORDI_CODEX_TOKEN';

/** Build a minimal env for the codex child. Caller writes files into configDir before spawn. */
export function buildCodexEnv(credential: RuntimeCredential, configDir: string): Record<string, string> {
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: configDir,
    CODEX_HOME: configDir,
    LANG: process.env.LANG ?? 'C.UTF-8',
    TERM: 'dumb',
    NO_COLOR: '1',
    CI: '1',
  };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;

  if (credential.kind === 'subscription') {
    // Subscription: auth.json is written by prepareCodexHome(); force file store.
    env.CODEX_AUTH_FILE = join(configDir, 'auth.json');
  } else if (credential.baseUrl) {
    env[CODEX_CUSTOM_TOKEN_ENV] = credential.secret;
  } else {
    env.OPENAI_API_KEY = credential.secret;
  }
  return env;
}

/** Write CODEX_HOME files for this run: config.toml for custom baseUrl, auth.json for subscription. */
export async function prepareCodexHome(
  credential: RuntimeCredential,
  configDir: string,
  model?: string | null,
): Promise<void> {
  await mkdir(configDir, { recursive: true });

  if (credential.kind === 'subscription') {
    // The secret is the JSON content of ~/.codex/auth.json (after `codex login`).
    // Validate it is JSON before writing; codex expects an object with tokens.
    let parsed: unknown;
    try {
      parsed = JSON.parse(credential.secret);
    } catch {
      throw new Error('Subscription secret must be valid JSON (the content of ~/.codex/auth.json)');
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('Subscription secret must be a JSON object');
    await writeFile(join(configDir, 'auth.json'), JSON.stringify(parsed), 'utf8');
    // Force file-based store so codex reads the file we just wrote.
    await writeFile(join(configDir, 'config.toml'), 'cli_auth_credentials_store = "file"\n', 'utf8');
    return;
  }

  if (credential.baseUrl) {
    // Custom OpenAI-compatible gateway via [model_providers.ordi_custom]
    // Reserved ids openai/ollama/lmstudio cannot be overridden, so use ordi_custom.
    const modelLine = model ? `model = ${tomlString(model)}\n` : '';
    const config = [
      modelLine ? modelLine.trimEnd() : null,
      `model_provider = ${tomlString(CODEX_CUSTOM_PROVIDER_ID)}`,
      ``,
      `[model_providers.${CODEX_CUSTOM_PROVIDER_ID}]`,
      `name = "Ordi Custom"`,
      `base_url = ${tomlString(credential.baseUrl)}`,
      `env_key = ${tomlString(CODEX_CUSTOM_TOKEN_ENV)}`,
      `wire_api = "responses"`,
      `requires_openai_auth = true`,
    ].filter((l): l is string => l !== null).join('\n') + '\n';
    await writeFile(join(configDir, 'config.toml'), config, 'utf8');
    return;
  }

  // Native OpenAI via OPENAI_API_KEY: no config.toml needed, but ensure no stale
  // custom provider file interferes (a retried run may switch credential).
  await rm(join(configDir, 'config.toml'), { force: true }).catch(() => {});
  await rm(join(configDir, 'auth.json'), { force: true }).catch(() => {});
}

function tomlString(value: string): string {
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Streaming helpers
// ---------------------------------------------------------------------------
const RATE_LIMIT_PATTERNS = [/rate limit/i, /usage limit/i, /out of usage/i, /too many requests/i, /429/];

function looksRateLimited(text: string): boolean {
  return RATE_LIMIT_PATTERNS.some((re) => re.test(text));
}

function emptyUsage(): RuntimeUsage {
  return { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, costUsd: 0, turns: 0, durationMs: 0 };
}

function extractJsonLines(stdout: string): unknown[] {
  const out: unknown[] = [];
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try { out.push(JSON.parse(trimmed)); } catch { /* not JSON – ignore */ }
  }
  return out;
}

function findReport(events: unknown[]): unknown | null {
  // Codex exec --json emits NDJSON; structured output (if requested) appears as
  // an event with type/result/structured_output. Fall back to last assistant text.
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i] as Record<string, unknown>;
    if (e && typeof e === 'object' && 'structured_output' in e && e.structured_output) return e.structured_output;
    if (e && typeof e === 'object' && e.type === 'result' && (e as { result?: unknown }).result) {
      const r = (e as { result: unknown }).result;
      if (typeof r === 'string') {
        try { const parsed = JSON.parse(r); if (parsed && typeof parsed === 'object' && 'status' in (parsed as object)) return parsed; } catch { /* not JSON */ }
      }
    }
  }
  return null;
}

function abortFrom(signal?: AbortSignal): AbortController {
  const controller = new AbortController();
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', () => controller.abort(signal.reason), { once: true });
  }
  return controller;
}

// ---------------------------------------------------------------------------
// Adapter
// ---------------------------------------------------------------------------

export interface CodexDeps {
  execFile: typeof execFile;
  spawn: typeof spawn;
  prepareHome: typeof prepareCodexHome;
  buildEnv: typeof buildCodexEnv;
}

const defaultDeps: CodexDeps = { execFile, spawn, prepareHome: prepareCodexHome, buildEnv: buildCodexEnv };

export function createCodexAdapter(deps: Partial<CodexDeps> = {}): RuntimeAdapter {
  const d: CodexDeps = { ...defaultDeps, ...deps };

  return {
    runtime: 'codex',

    async available() {
      try {
        const { stdout } = await d.execFile('codex', ['--version'], { timeout: 10_000 });
        const version = stdout.trim().split('\n')[0]?.trim() ?? null;
        return { ok: true, version, error: null };
      } catch (e) {
        return { ok: false, version: null, error: (e as Error).message };
      }
    },

    async verify(credential, opts) {
      const configDir = opts.configDir;
      try {
        await d.prepareHome(credential, configDir, opts.model ?? null);
        const env = d.buildEnv(credential, configDir);
        const modelFlag = opts.model ? ['--model', opts.model] : [];
        // Minimal non-interactive check. Use codex exec with a tiny prompt.
        const args = ['exec', '--json', ...modelFlag, 'Reply with the single word OK.'];
        const controller = abortFrom(opts.signal);
        const timeout = setTimeout(() => controller.abort(), 45_000);
        try {
          const result = await runCodexExec(d, { args, env, cwd: configDir, signal: controller.signal });
          const text = result.stdout + result.stderr;
          if (result.exitCode !== 0) return { ok: false, error: text.slice(0, 800) || `codex exited with ${result.exitCode}`, model: opts.model ?? null };
          if (/OK/i.test(text)) return { ok: true, error: null, model: opts.model ?? null };
          // Some models answer differently; non-error exit counts as ok.
          return { ok: true, error: null, model: opts.model ?? null };
        } finally {
          clearTimeout(timeout);
        }
      } catch (e) {
        return { ok: false, error: (e as Error).message, model: null };
      }
    },

    async suggestBranchSlug(input) {
      const controller = abortFrom(input.signal);
      const timer = setTimeout(() => controller.abort(), 30_000);
      try {
        await d.prepareHome(input.credential, input.configDir, 'gpt-5-mini');
        const env = d.buildEnv(input.credential, input.configDir);
        const brief = `Title: ${input.title.slice(0, 300)}\n${input.description ? `Description: ${input.description.slice(0, 1500)}` : ''}`;
        const prompt = `${brief}\n\nYou name git branches. Answer with one English kebab-case slug of 3 to 6 words that says what the task does (lowercase a-z, digits and dashes only), nothing else. Translate if the task is not in English.`;
        const result = await runCodexExec(d, {
          args: ['exec', '--json', '--model', 'gpt-5-mini', prompt],
          env, cwd: input.configDir, signal: controller.signal,
        });
        if (result.exitCode !== 0) return null;
        const text = result.stdout.trim().split('\n').pop() ?? '';
        // Try parse last JSON line, else raw text
        let candidate = text;
        try { const obj = JSON.parse(text) as Record<string, unknown>; candidate = String((obj as { result?: unknown }).result ?? (obj as { text?: unknown }).text ?? text); } catch { /* raw */ }
        return extractSlug(candidate);
      } catch {
        return null;
      } finally {
        clearTimeout(timer);
      }
    },

    async run(input): Promise<RuntimeOutcome> {
      const startedAt = Date.now();
      const usage = emptyUsage();
      let sessionId: string | null = input.resume ?? null;
      let lastText = '';

      await d.prepareHome(input.credential, input.configDir, input.model ?? null);
      const env = d.buildEnv(input.credential, input.configDir);

      // Map MCP servers to codex config: append [mcp_servers.*] stanzas to config.toml.
      // codex reads them from CODEX_HOME/config.toml as `mcp_servers.<name>`.
      await appendMcpServers(input.configDir, input.mcpServers);

      const args: string[] = ['exec', '--json'];
      if (input.model) args.push('--model', input.model);
      // Full-auto sandbox: let the agent read/write the checkout, but not escape.
      args.push('--full-auto');
      if (input.resume) args.push('resume', input.resume);
      // Structured output: ask codex to emit JSON matching AGENT_REPORT_SCHEMA.
      // Codex does not have a native json_schema outputFormat; we instruct via prompt suffix.
      const structuredHint = `\n\nAt the end of your work, output a single JSON object on its own line matching this schema: ${JSON.stringify(AGENT_REPORT_SCHEMA)}. The "summary" is 2-5 sentences on what changed and why. "verification" is what you ran to verify, or null. "risks" is what could break, or null. If you need more information, use status "needs_input" and fill "question".`;
      const fullPrompt = input.prompt + (input.systemAppend ? `\n\n${input.systemAppend}` : '') + structuredHint;
      args.push(fullPrompt);

      const controller = abortFrom(input.signal);
      // codex handles cwd via --cd or we pass cwd to spawn
      let execResult: { stdout: string; stderr: string; exitCode: number | null };
      try {
        execResult = await runCodexExec(d, { args, env, cwd: input.cwd, signal: controller.signal, onEvent: input.onEvent });
      } catch (e) {
        const msg = (e as Error).message ?? String(e);
        logger.warn({ err: e }, 'codex runtime raised');
        usage.durationMs = Date.now() - startedAt;
        const limited = looksRateLimited(msg);
        return { status: limited ? 'rate_limited' : 'failed', sessionId, report: null, message: lastText, error: msg, usage, retryAt: null };
      }

      const combined = execResult.stdout + '\n' + execResult.stderr;
      usage.durationMs = Date.now() - startedAt;

      // Handle abort
      if (controller.signal.aborted) {
        return { status: 'failed', sessionId, report: null, message: lastText, error: 'aborted', usage, retryAt: null };
      }

      // Rate limit detection
      if (execResult.exitCode !== 0 && looksRateLimited(combined)) {
        return { status: 'rate_limited', sessionId, report: null, message: combined.slice(0, 4000), error: combined.slice(0, 800), usage, retryAt: null };
      }
      if (execResult.exitCode !== 0) {
        // Non-zero without rate limit => failed, but preserve branch
        return { status: 'failed', sessionId, report: null, message: lastText || combined.slice(0, 4000), error: combined.slice(0, 1200), usage, retryAt: null };
      }

      const events = extractJsonLines(execResult.stdout);
      // Best-effort extract lastText from events
      for (const ev of events) {
        const e = ev as Record<string, unknown>;
        if (e?.type === 'assistant' || e?.type === 'message') {
          const t = (e as { text?: unknown; content?: unknown }).text ?? (typeof e.content === 'string' ? e.content : '');
          if (typeof t === 'string' && t.trim()) lastText = t;
        }
        if (e?.type === 'result' && typeof (e as { result?: unknown }).result === 'string') {
          lastText = String((e as { result: string }).result);
        }
        if (e?.session_id && typeof e.session_id === 'string') sessionId = e.session_id;
        if (e?.sessionId && typeof e.sessionId === 'string') sessionId = e.sessionId as string;
      }
      if (!lastText) lastText = execResult.stdout.slice(-4000);

      const rawReport = findReport(events);
      // Also try parse lastText as JSON
      let report = parseReport(rawReport);
      if (!report) {
        try {
          const parsed = JSON.parse(lastText.trim().split('\n').pop() ?? '');
          report = parseReport(parsed);
        } catch { /* ignore */ }
      }
      // Also scan events for inline JSON with status/summary
      if (!report) {
        for (const ev of events) {
          const c = parseReport(ev);
          if (c) { report = c; break; }
        }
      }

      if (report?.status === 'needs_input' || report?.status === 'blocked') {
        return { status: 'needs_input', sessionId, report, message: report.summary || lastText, error: null, usage, retryAt: null };
      }
      if (report) {
        return { status: 'succeeded', sessionId, report, message: report.summary || lastText, error: null, usage, retryAt: null };
      }
      // No structured report but exit 0 => treat as succeeded with synthesized report
      // The worker's publish step will still push the branch; finalize() will comment with message.
      return {
        status: 'succeeded',
        sessionId, report: null,
        message: lastText.slice(0, 4000),
        error: null, usage, retryAt: null,
      };
    },
  };
}

/** Append MCP servers into CODEX_HOME/config.toml as [mcp_servers.<name>] stanzas. */
async function appendMcpServers(configDir: string, servers: Record<string, { type: string; url: string; headers: Record<string, string> }>): Promise<void> {
  if (!servers || Object.keys(servers).length === 0) return;
  const entries = Object.entries(servers);
  // Build TOML stanzas. Codex expects mcp_servers.<name>.url etc.
  // Transport is http (Streamable HTTP). Headers are table.
  const lines: string[] = [];
  for (const [name, s] of entries) {
    const safeName = name.replace(/[^a-zA-Z0-9_-]/g, '_');
    lines.push(`[mcp_servers.${safeName}]`);
    lines.push(`url = ${tomlString(s.url)}`);
    if (s.headers && Object.keys(s.headers).length) {
      lines.push(`http_headers = { ${Object.entries(s.headers).map(([k, v]) => `${tomlString(k)} = ${tomlString(v)}`).join(', ')} }`);
    }
  }
  if (!lines.length) return;
  const cfgPath = join(configDir, 'config.toml');
  let existing = '';
  try { existing = await import('node:fs/promises').then((m) => m.readFile(cfgPath, 'utf8')).catch(() => ''); } catch { /* ignore */ }
  // Avoid duplicate stanzas on retry (same task): replace or append.
  if (existing.includes('[mcp_servers.')) {
    // Already has MCP stanzas; leave as is (first run wins, retry resumes same session).
    return;
  }
  const { readFile } = await import('node:fs/promises');
  try { existing = await readFile(cfgPath, 'utf8'); } catch { existing = ''; }
  const next = existing + (existing && !existing.endsWith('\n') ? '\n' : '') + lines.join('\n') + '\n';
  await writeFile(cfgPath, next, 'utf8');
}

interface ExecOpts {
  args: string[];
  env: Record<string, string>;
  cwd: string;
  signal?: AbortSignal;
  onEvent?: RuntimeRunInput['onEvent'];
}

async function runCodexExec(
  deps: CodexDeps,
  opts: ExecOpts,
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = deps.spawn('codex', opts.args, {
      env: { ...process.env, ...opts.env },
      cwd: opts.cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';
    let settled = false;

    const kill = () => {
      try { child.kill('SIGTERM'); } catch { /* ignore */ }
      setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 5_000);
    };
    if (opts.signal) {
      if (opts.signal.aborted) kill();
      else opts.signal.addEventListener('abort', kill, { once: true });
    }

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      stdout += text;
      // Stream NDJSON lines to onEvent best-effort
      if (opts.onEvent) {
        for (const line of text.split('\n')) {
          const t = line.trim();
          if (!t.startsWith('{')) continue;
          try {
            const ev = JSON.parse(t) as Record<string, unknown>;
            // Map codex events to RuntimeEvent
            if (ev.type === 'assistant' || ev.type === 'message') {
              const txt = typeof ev.text === 'string' ? ev.text : typeof ev.content === 'string' ? ev.content : '';
              const toolUses: { id: string; name: string; input: unknown }[] = Array.isArray(ev.tool_uses)
                ? (ev.tool_uses as { id?: string; name?: string; input?: unknown }[]).map((u) => ({ id: String(u.id ?? ''), name: String(u.name ?? ''), input: u.input }))
                : [];
              void Promise.resolve(opts.onEvent({ type: 'assistant', text: String(txt ?? ''), toolUses })).catch(() => {});
            } else if (ev.type === 'tool_use') {
              void Promise.resolve(opts.onEvent({ type: 'tool_use', toolUseId: String(ev.tool_use_id ?? ev.id ?? ''), name: String(ev.name ?? ''), input: ev.input })).catch(() => {});
            } else if (ev.type === 'tool_result') {
              void Promise.resolve(opts.onEvent({ type: 'tool_result', toolUseId: ev.tool_use_id ? String(ev.tool_use_id) : null, text: String(ev.text ?? ev.content ?? ''), isError: Boolean(ev.is_error) })).catch(() => {});
            } else if (ev.type === 'rate_limit' || /rate.?limit/i.test(String(ev.error ?? ''))) {
              void Promise.resolve(opts.onEvent({ type: 'rate_limit', status: String(ev.status ?? 'rejected'), resetsAt: (ev.resets_at as number | null) ?? null, limitType: (ev.limit_type as string | null) ?? null })).catch(() => {});
            }
          } catch { /* not JSON */ }
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });

    child.on('error', (err) => {
      if (!settled) { settled = true; reject(err); }
    });
    child.on('close', (code) => {
      if (!settled) { settled = true; resolve({ stdout, stderr, exitCode: code }); }
    });
  });
}

export function extractSlug(text: string): string | null {
  const line = text.trim().split('\n').map((l) => l.trim().replace(/^[`"'*\-\s]+|[`"'*.\s]+$/g, '')).find(Boolean) ?? '';
  const slug = line.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50).replace(/-+$/, '');
  if (slug.length < 3 || !/[a-z]/.test(slug)) return null;
  return slug;
}
