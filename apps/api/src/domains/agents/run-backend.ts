/**
 * What a run worker needs from the platform, as one interface.
 *
 * The worker is the process that executes model-authored code: it clones
 * the repository, drives the runtime and pushes the branch. Everything it
 * knows about a run arrives through this interface and nothing else, so the
 * process can live without DATABASE_URL, ENCRYPTION_KEY, AUTH_SECRET or any
 * other secret of the API's: a container that runs untrusted code holds
 * only what the one run in it needs - the model credential, the repository
 * token and the run's own API token - and each of those is scoped or
 * revoked when the run ends.
 *
 * Two implementations. `localRunBackend` (run-service.ts) calls the
 * services directly and is what the worker inside the API process uses.
 * `createHttpRunBackend` talks to `/api/v1/agent-worker/*` with a shared
 * secret and is what the standalone worker process uses. The worker loop
 * (workers/agent-runs.ts) is the same code over either.
 */
import type { RepoBinding } from './workspace';
import type { RuntimeOutcome } from './runtime';
import type { RunEventType } from './run-events';

export interface WorkerInfo {
  workerId: string;
  concurrency: number;
  running: number;
  runtimeAvailable: boolean;
  version: string;
}

/** The run row, reduced to what the worker acts on. */
export interface ClaimedRun {
  id: string;
  taskId: string;
  projectId: string;
  agentUserId: string;
  trigger: string;
  sessionId: string | null;
  branch: string | null;
  prUrl: string | null;
  commentId: string | null;
}

/** Everything the worker needs to prepare the checkout and drive the runtime. */
export interface RunBundle {
  run: ClaimedRun;
  runtime: 'claude_code' | 'codex';
  profile: {
    model: string | null;
    maxTurns: number;
    maxRunMinutes: number;
    maxBudgetUsd: number | null;
    completionCategory: string;
    instructions: string;
  };
  agent: { id: string; name: string; email: string };
  task: { id: string; number: number; title: string; description: string };
  project: { id: string; key: string; name: string };
  /** Slugs only: the connectors' secrets stay on the API, behind the gateway. */
  connectors: string[];
  /** The credential chain in order, decrypted for this run. Empty means the run cannot start. */
  credentials: { id: string; kind: 'api_key' | 'subscription'; secret: string }[];
  repo: RepoBinding | null;
  /** The task in ordi, for the pull request description. */
  taskUrl: string;
}

export interface StartInput {
  branch: string | null;
  reused: boolean;
  repoFullName: string | null;
  pullRequestTemplate: string | null;
}

/** The run is running: its identity, and what to tell the model. */
export interface RunStart {
  token: string;
  prompt: string;
  /** The brief again, for a session the runtime could not resume. */
  promptIfSessionLost: string;
  systemAppend: string;
}

export interface PublishOutcome {
  pushed: boolean;
  prUrl: string | null;
  commits: number | null;
  /** Why the push failed, already redacted and explained; null when it did not. */
  error: string | null;
}

/** What the worker reports at the end; the platform decides what it means for the task. */
export interface RunReport {
  outcome: RuntimeOutcome;
  usedCredentialId: string | null;
  aborted: 'timeout' | 'cancelled' | null;
  /** What publishing the branch did; null when nothing was attempted. */
  publish: PublishOutcome | null;
  branch: string | null;
}

export interface ParkInput {
  retryAt: string;
  reason: string;
  sessionId: string | null;
  branch: string | null;
}

export interface RunBackend {
  /** Where the runtime reaches ordi's MCP server and the connector gateway. */
  apiBase(): string;
  heartbeat(info: WorkerInfo): Promise<void>;
  /** Due runs for this worker, at most `limit`; stale runs of lost workers are recovered first. */
  claim(workerId: string, limit: number): Promise<ClaimedRun[]>;
  prepare(runId: string): Promise<RunBundle>;
  /** Mints the run token and builds the brief. Null when the run was cancelled meanwhile. */
  start(runId: string, input: StartInput): Promise<RunStart | null>;
  progress(runId: string, input: { sessionId?: string | null; branch?: string | null }): Promise<void>;
  touch(runId: string): Promise<void>;
  event(runId: string, type: RunEventType, payload: Record<string, unknown>): Promise<void>;
  cancelRequested(runId: string): Promise<boolean>;
  /** A fresh repository binding for the push: installation tokens live an hour. */
  repository(runId: string): Promise<RepoBinding | null>;
  park(runId: string, input: ParkInput): Promise<void>;
  finish(runId: string, report: RunReport): Promise<void>;
  /** The run crashed before it could report. */
  fail(runId: string, error: string): Promise<void>;
}
