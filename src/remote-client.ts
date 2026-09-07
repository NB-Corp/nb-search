import { randomUUID } from 'node:crypto';
import type { OperationContext } from './contracts.ts';
import type { NbSearchRuntime } from './runtime.ts';
import type { CapabilityEnvelope, FetchEnvelope, SearchEnvelope } from './types.ts';
import { HTTP_ERRORS, NbSearchRemoteError, parseRemoteInput, parseRemoteOutput, REMOTE_PROTOCOL_VERSION, type RemoteMethod } from './remote-protocol.ts';

export interface CreateNbSearchRemoteClientOptions { base_url: string; access_key: string; allow_loopback_http?: boolean; timeout_ms?: number; max_request_bytes?: number; max_response_bytes?: number }
export function normalizeRemoteBase(value: string, allowHttp = false): string {
  try { const url = new URL(value); if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:' && !(allowHttp && url.protocol === 'http:' && ['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname)))) throw new Error(); url.pathname = `${url.pathname.replace(/\/+$/, '')}/`; return url.href; } catch { throw new NbSearchRemoteError('CONFIGURATION_ERROR', 'configuration'); }
}
export function createNbSearchRemoteClient(options: CreateNbSearchRemoteClientOptions): NbSearchRuntime {
  options = { ...options };
  const base = normalizeRemoteBase(options.base_url, options.allow_loopback_http);
  if (typeof options.access_key !== 'string' || !options.access_key || /\s|[\x00-\x1f\x7f]/.test(options.access_key)) throw new NbSearchRemoteError('CONFIGURATION_ERROR', 'configuration');
  const timeout = bound(options.timeout_ms ?? 120000, 100, 3600000); const requestLimit = bound(options.max_request_bytes ?? 1024 * 1024, 1); const responseLimit = bound(options.max_response_bytes ?? 8 * 1024 * 1024, 1);
  async function call(method: RemoteMethod, input: unknown, context: OperationContext = {}) {
    const id = context.requestId ?? randomUUID();
    if (!/^[A-Za-z0-9._:-]{1,128}$/.test(id)) throw new NbSearchRemoteError('INVALID_INPUT', 'invalid-request-id');
    const parsed = parseRemoteInput(method, input, id); const body = JSON.stringify(parsed);
    if (Buffer.byteLength(body) > requestLimit) throw new NbSearchRemoteError('REQUEST_TOO_LARGE', id);
    if (context.signal?.aborted) throw new NbSearchRemoteError('CANCELLED', id);
    const deadline = new AbortController(); const timer = setTimeout(() => deadline.abort(), timeout);
    const signal = context.signal ? AbortSignal.any([context.signal, deadline.signal]) : deadline.signal;
    let response: Response | undefined;
    try {
      response = await fetch(`${base}v1/${method}`, { method: 'POST', headers: { authorization: `Bearer ${options.access_key}`, 'content-type': 'application/json', accept: 'application/json', 'x-nb-search-protocol': REMOTE_PROTOCOL_VERSION, 'x-request-id': id }, body, signal, redirect: 'manual', credentials: 'omit' });
      if (response.status >= 300 && response.status < 400) throw new NbSearchRemoteError('HTTP_ERROR', id, false, response.status);
      if (response.headers.get('x-nb-search-protocol') !== REMOTE_PROTOCOL_VERSION || response.headers.get('x-request-id') !== id || !/^application\/json(?:\s*;\s*charset\s*=\s*utf-8)?\s*$/i.test(response.headers.get('content-type') ?? '')) throw new NbSearchRemoteError('PROTOCOL_ERROR', id, false, response.status);
      const length = response.headers.get('content-length');
      if (length !== null && /^\d+$/.test(length) && Number(length) > responseLimit) throw new NbSearchRemoteError('RESPONSE_TOO_LARGE', id, false, response.status);
      const bytes = await boundedBody(response, responseLimit, id); let data: unknown;
      try { data = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new NbSearchRemoteError('PROTOCOL_ERROR', id, false, response.status); }
      if (response.status !== 200) {
        const mapping = HTTP_ERRORS[response.status];
        if (!mapping) throw new NbSearchRemoteError('HTTP_ERROR', id, false, response.status);
        const error = data && typeof data === 'object' && 'error' in data ? data.error : undefined;
        if (!error || typeof error !== 'object' || !('code' in error) || error.code !== mapping[0] || !('retryable' in error) || error.retryable !== mapping[1] || !('message' in error) || typeof error.message !== 'string' || Object.keys(error).some((key) => !['code', 'message', 'retryable', 'retry_after_ms'].includes(key))) throw new NbSearchRemoteError('PROTOCOL_ERROR', id, false, response.status);
        let retry: number | undefined;
        if ('retry_after_ms' in error) { if (!Number.isSafeInteger(error.retry_after_ms) || Number(error.retry_after_ms) < 0) throw new NbSearchRemoteError('PROTOCOL_ERROR', id, false, response.status); retry = Number(error.retry_after_ms); }
        const header = response.headers.get('retry-after');
        if (header !== null && [429, 503].includes(response.status)) { const delay = /^\d+$/.test(header) ? Number(header) * 1000 : /^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(header) ? Math.max(0, Date.parse(header) - Date.now()) : NaN; if (!Number.isSafeInteger(delay) || delay < 0) throw new NbSearchRemoteError('PROTOCOL_ERROR', id, false, response.status); retry = Math.max(retry ?? 0, delay); }
        throw new NbSearchRemoteError(mapping[0], id, mapping[1], response.status, retry);
      }
      return parseRemoteOutput(method, parsed, data, id);
    } catch (error) {
      if (context.signal?.aborted) throw new NbSearchRemoteError('CANCELLED', id);
      if (deadline.signal.aborted) throw new NbSearchRemoteError('DEADLINE_EXCEEDED', id, true);
      if (error instanceof NbSearchRemoteError) throw error;
      throw new NbSearchRemoteError('TRANSPORT_ERROR', id, true);
    } finally { clearTimeout(timer); if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {}); }
  }
  return { search: async (input, context) => await call('search', input, context) as SearchEnvelope, fetch: async (input, context) => await call('fetch', input, context) as FetchEnvelope, capabilities: async (input = {}, context) => await call('capabilities', input, context) as CapabilityEnvelope };
}
function bound(value: number, min: number, max = Number.MAX_SAFE_INTEGER): number { if (!Number.isSafeInteger(value) || value < min || value > max) throw new NbSearchRemoteError('CONFIGURATION_ERROR', 'configuration'); return value; }
async function boundedBody(response: Response, limit: number, id: string): Promise<Buffer> {
  if (!response.body) throw new NbSearchRemoteError('PROTOCOL_ERROR', id);
  const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
  try { for (;;) { const { done, value } = await reader.read(); if (done) break; size += value.byteLength; if (size > limit) throw new NbSearchRemoteError('RESPONSE_TOO_LARGE', id); chunks.push(value); } return Buffer.concat(chunks, size); } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
