import { serve } from '@hono/node-server';
import { createApp } from './app';
import { env } from './env';
import { logger } from './lib/logger';
import { installGlobalHandlers } from './lib/sentry';
import { startWorkers } from './workers/index';
import { ensureBucketAtBoot } from './lib/s3';

installGlobalHandlers();
const app = createApp();

serve({ fetch: app.fetch, port: env.port }, (info) => {
  logger.info(`ordi API listening on http://localhost:${info.port}`);
});

// The attachments bucket is created by the API itself (no storage-side init
// container); it waits for a storage server that is still booting.
ensureBucketAtBoot().catch((e) => logger.error({ err: e }, 'storage bucket check crashed'));

if (env.workersEnabled) {
  startWorkers().catch((e) => logger.error({ err: e }, 'workers failed to start'));
}
