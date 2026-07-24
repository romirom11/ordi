/** Standard API error envelope (PRD §15.1). */

export type ErrorCode =
  | 'validation_error' // 400
  | 'unauthenticated' // 401
  | 'forbidden' // 403
  | 'not_found' // 404
  | 'version_conflict' // 409
  | 'domain_rule' // 422
  | 'rate_limited' // 429
  | 'internal_error'; // 500

export const ERROR_STATUS: Record<ErrorCode, number> = {
  validation_error: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  version_conflict: 409,
  domain_rule: 422,
  rate_limited: 429,
  internal_error: 500,
};

export interface ApiError {
  error: {
    code: ErrorCode;
    message: string;
    details?: unknown;
  };
}
