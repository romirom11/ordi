/**
 * The agent run worker as a process of its own.
 *
 * Same image as the API, a different command, and a much smaller
 * environment: ORDI_API_URL and AGENT_WORKER_SECRET to reach the API,
 * AGENT_WORKER_CONCURRENCY and AGENT_WORK_DIR for the work itself. No
 * DATABASE_URL, no ENCRYPTION_KEY, no AUTH_SECRET, no S3, no SMTP - this is
 * the container that executes code the model wrote, and the split exists so
 * that it holds nothing worth taking beyond the run in front of it.
 */
import { env } from './env';
import { logger } from './lib/logger';
import { installGlobalHandlers } from './lib/sentry';
import { createHttpRunBackend } from './domains/agents/run-backend-http';
import { startAgentRunsWorker } from './workers/agent-runs';

installGlobalHandlers();

if (!env.agentWorkerSecret) throw new Error('AGENT_WORKER_SECRET is not set; the worker cannot authenticate to the API');
if (!env.agentWorkerApiUrl) throw new Error('ORDI_API_URL is not set; the worker does not know where the API is');
for (const name of ['DATABASE_URL', 'ENCRYPTION_KEY', 'AUTH_SECRET']) {
  // Not fatal, because a PaaS may inject them into every container of a
  // project - but the whole point of this process is not to have them.
  if (process.env[name]) logger.warn({ variable: name }, 'the agent worker does not need this variable; remove it from its environment');
}

const stop = startAgentRunsWorker(createHttpRunBackend({ apiUrl: env.agentWorkerApiUrl, secret: env.agentWorkerSecret }));

const shutdown = (signal: string) => {
  logger.info({ signal }, 'agent worker stopping');
  stop();
  // Runs in flight keep going until they report; the stale sweep re-queues
  // any this process takes down with it.
  setTimeout(() => process.exit(0), 500).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
