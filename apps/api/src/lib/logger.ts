import { pino } from 'pino';
import { env } from '../env';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? (env.isProd ? 'info' : 'debug'),
  transport: env.isProd ? undefined : { target: 'pino/file', options: { destination: 1 } },
});
