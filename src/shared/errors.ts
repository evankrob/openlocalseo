export const ERROR_CODES = [
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION_ERROR",
  "INSUFFICIENT_CREDITS",
  "SCAN_IN_PROGRESS",
  "COST_CEILING_EXCEEDED",
  "RATE_LIMITED",
  "UPSTREAM_UNAVAILABLE",
  "DATAFORSEO_AUTH_FAILED",
  "INTERNAL_ERROR",
] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export const ERROR_STATUS: Record<ErrorCode, number> = {
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  INSUFFICIENT_CREDITS: 402,
  SCAN_IN_PROGRESS: 409,
  COST_CEILING_EXCEEDED: 409,
  RATE_LIMITED: 429,
  UPSTREAM_UNAVAILABLE: 502,
  DATAFORSEO_AUTH_FAILED: 502,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }
}
