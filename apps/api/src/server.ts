import { serve } from '@hono/node-server';
import { createApp } from './app';
import { env } from './env';
import { logger } from './lib/logger';
import { startWorkers } from './workers/index';

const app = createApp();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  logger.info(`ordi API listening on http://localhost:${info.port}`);
});

if (env.workersEnabled) {
  startWorkers().catch((e) => logger.error({ err: e }, 'workers failed to start'));
}
