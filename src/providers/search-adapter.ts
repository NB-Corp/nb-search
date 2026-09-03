import { NbSearchError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import { ResponseLimitError } from '../transport.ts';
import type { ProviderName } from '../types.ts';

export const SEARCH_RESPONSE_MAX_BYTES = 1_048_576;

export function assertSearchStatus(
  status: number,
  provider: ProviderName,
  headers?: Readonly<Record<string, string>>,
  clock: () => Date = () => new Date(),
): void {
  if (status >= 200 && status < 300) return;
  const data = { status };
  if (status === 401 || status === 403) {
    throw new NbSearchError('PROVIDER_AUTH', `${provider} authentication failed.`, false, provider, { data });
  }
  if (status === 429) {
    throw new NbSearchError('PROVIDER_RATE_LIMIT', `${provider} rate limit was reached.`, true, provider, {
      retryAfterMs: parseRetryAfter(headerValue(headers, 'retry-after'), clock),
      data,
    });
  }
  throw new NbSearchError(
    'PROVIDER_UNAVAILABLE',
    `${provider} request failed (HTTP ${String(status)}).`,
    status >= 500 && status <= 599,
    provider,
    { data },
  );
}

export function searchProviderError(
  error: unknown,
  provider: ProviderName,
  redactions: readonly string[],
): NbSearchError {
  if (error instanceof ResponseLimitError) {
    return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} response exceeded the configured limit.`, false, provider, {
      cause: error,
      data: { max_response_bytes: error.maximum },
    });
  }
  if (error instanceof NbSearchError) {
    return new NbSearchError(error.code, redactText(error.message, redactions), error.retryable, provider, {
      cause: error,
      retryAfterMs: error.retryAfterMs,
      data: error.data,
    });
  }
  return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} provider failed.`, true, provider, { cause: error });
}

export function malformedSearchResponse(provider: ProviderName, cause?: unknown): NbSearchError {
  return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} returned malformed search content.`, false, provider, { cause });
}

export function normalizedText(value: string | undefined): string {
  return value?.replace(/\s+/gu, ' ').trim() ?? '';
}

function parseRetryAfter(value: string | undefined, clock: () => Date): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock().getTime()) : undefined;
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1];
}
