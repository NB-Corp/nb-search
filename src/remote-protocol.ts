import { capabilitiesInputSchema, fetchInputSchema, searchInputSchema } from './contracts.ts';
import { capabilityEnvelopeSchema, fetchEnvelopeSchema, searchEnvelopeSchema } from './response-schemas.ts';

export const REMOTE_PROTOCOL_VERSION = '1' as const;
export type RemoteErrorCode = 'INVALID_INPUT' | 'CONFIGURATION_ERROR' | 'PROTOCOL_ERROR' | 'RESPONSE_TOO_LARGE' | 'REQUEST_TOO_LARGE' | 'TRANSPORT_ERROR' | 'DEADLINE_EXCEEDED' | 'CANCELLED' | 'INVALID_REQUEST' | 'UNAUTHENTICATED' | 'FORBIDDEN' | 'NOT_FOUND' | 'CONFLICT' | 'UNSUPPORTED_MEDIA_TYPE' | 'PROTOCOL_UNSUPPORTED' | 'RATE_LIMITED' | 'INTERNAL' | 'UNAVAILABLE' | 'HTTP_ERROR';
export class NbSearchRemoteError extends Error {
  constructor(readonly code: RemoteErrorCode, readonly request_id: string, readonly retryable = false, readonly status?: number, readonly retry_after_ms?: number) { super(`Remote request failed (${code}).`); this.name = 'NbSearchRemoteError'; }
  toJSON() { return { code: this.code, message: this.message, retryable: this.retryable, request_id: this.request_id, ...(this.status === undefined ? {} : { status: this.status }), ...(this.retry_after_ms === undefined ? {} : { retry_after_ms: this.retry_after_ms }) }; }
}
export type RemoteMethod = 'search' | 'fetch' | 'capabilities';
export function parseRemoteInput(method: RemoteMethod, input: unknown, requestId: string) {
  const parsed = (method === 'search' ? searchInputSchema : method === 'fetch' ? fetchInputSchema : capabilitiesInputSchema).safeParse(input);
  if (!parsed.success) throw new NbSearchRemoteError('INVALID_INPUT', requestId);
  if (method === 'fetch' && 'action' in parsed.data && parsed.data.action === 'run' && 'source' in parsed.data && parsed.data.source.kind !== 'url') throw new NbSearchRemoteError('INVALID_INPUT', requestId);
  return parsed.data;
}
export function parseRemoteOutput(method: RemoteMethod, input: ReturnType<typeof parseRemoteInput>, output: unknown, requestId: string): unknown {
  const parsed = (method === 'search' ? searchEnvelopeSchema : method === 'fetch' ? fetchEnvelopeSchema : capabilityEnvelopeSchema).safeParse(output);
  if (!parsed.success) throw new NbSearchRemoteError('PROTOCOL_ERROR', requestId);
  const value = parsed.data;
  if ('action' in input) {
    if (!('action' in value) || value.action !== input.action || ('job_id' in input && (!('job_id' in value) || value.job_id !== input.job_id)) || (input.action === 'run' && (!('execution' in value) || value.execution !== (input.execution ?? 'sync')))) throw new NbSearchRemoteError('PROTOCOL_ERROR', requestId);
  } else if (capabilityEnvelopeSchema.parse(value).fetch.inputs.some((item) => item.kind !== 'url' && item.enabled)) throw new NbSearchRemoteError('PROTOCOL_ERROR', requestId);
  return value;
}
export const HTTP_ERRORS: Readonly<Record<number, readonly [RemoteErrorCode, boolean]>> = { 400: ['INVALID_REQUEST', false], 401: ['UNAUTHENTICATED', false], 403: ['FORBIDDEN', false], 404: ['NOT_FOUND', false], 409: ['CONFLICT', false], 413: ['REQUEST_TOO_LARGE', false], 415: ['UNSUPPORTED_MEDIA_TYPE', false], 426: ['PROTOCOL_UNSUPPORTED', false], 429: ['RATE_LIMITED', true], 500: ['INTERNAL', true], 502: ['UNAVAILABLE', true], 503: ['UNAVAILABLE', true], 504: ['UNAVAILABLE', true] };
// Remote admission comparison, deliberately separate from local job snapshots.
export function remoteIdempotencyContent(method: 'search' | 'fetch', input: unknown): string {
  const parsed = parseRemoteInput(method, input, 'normalization');
  if (!('action' in parsed) || parsed.action !== 'run' || parsed.execution !== 'async') throw new NbSearchRemoteError('INVALID_INPUT', 'normalization');
  const { idempotency_key: _key, ...rest } = parsed;
  const value = 'query' in rest ? { ...rest, query: Array.isArray(rest.query) ? rest.query : [rest.query] } : { ...rest, representation: rest.representation ?? 'markdown' };
  return canonical(value);
}
function canonical(value: unknown): string { if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`; if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`; return JSON.stringify(value); }
