import type { ProviderName, PublicError, PublicErrorCode } from './types.ts';

export class NbSearchError extends Error {
  constructor(
    readonly code: PublicErrorCode,
    message: string,
    readonly retryable = false,
    readonly provider?: ProviderName,
    options?: ErrorOptions & { retryAfterMs?: number },
  ) {
    super(message, options);
    this.name = new.target.name;
    this.retryAfterMs = options?.retryAfterMs;
  }

  readonly retryAfterMs?: number;

  toPublic(): PublicError {
    return { code: this.code, message: this.message, retryable: this.retryable,
      ...(this.provider === undefined ? {} : { provider: this.provider }),
      ...(this.retryAfterMs === undefined ? {} : { retry_after_ms: this.retryAfterMs }) };
  }
}

export function publicError(error: unknown, fallback = 'The operation failed.'): PublicError {
  return error instanceof NbSearchError
    ? error.toPublic()
    : { code: 'INTERNAL', message: fallback, retryable: false };
}

export function invalidInput(message: string): NbSearchError {
  return new NbSearchError('INVALID_INPUT', message);
}

export function isRetryableProviderError(error: unknown): boolean {
  return error instanceof NbSearchError && error.retryable;
}
