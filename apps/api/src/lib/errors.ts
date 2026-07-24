import type { Context } from 'hono';
import { ZodError } from 'zod';
import { ERROR_STATUS, type ErrorCode } from '@ordi/shared';
import { logger } from './logger';

export class ApiException extends Error {
  code: ErrorCode;
  details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

export const err = {
  validation: (message = 'Validation failed', details?: unknown) => new ApiException('validation_error', message, details),
  unauthenticated: (message = 'Not authenticated') => new ApiException('unauthenticated', message),
  forbidden: (message = 'Forbidden', requiredPermission?: string) =>
    new ApiException('forbidden', message, requiredPermission ? { requiredPermission } : undefined),
  notFound: (message = 'Not found') => new ApiException('not_found', message),
  conflict: (message = 'Version conflict', current?: unknown) => new ApiException('version_conflict', message, current),
  domain: (message: string, details?: unknown) => new ApiException('domain_rule', message, details),
  rateLimited: (message = 'Too many requests') => new ApiException('rate_limited', message),
};

export function handleError(e: unknown, c: Context): Response {
  if (e instanceof ApiException) {
    const status = ERROR_STATUS[e.code];
    return c.json({ error: { code: e.code, message: e.message, details: e.details } }, status as 400);
  }
  if (e instanceof ZodError) {
    return c.json({ error: { code: 'validation_error', message: 'Validation failed', details: e.flatten() } }, 400);
  }
  logger.error({ err: e }, 'unhandled error');
  return c.json({ error: { code: 'internal_error', message: 'Internal server error' } }, 500);
}
