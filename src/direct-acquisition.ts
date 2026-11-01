// Mechanically recovered from accepted next.7 app-xlqMoSP5.mjs:3456–3530; type annotations restored.
import type { Dispatcher } from 'undici';
import { guardedFetch, isGuardedFetchError, type GuardedFetchOptions } from './vendor/guarded-fetch/index.ts';
import { NbSearchError } from './errors.ts';
import type { FetchProviderRequest, ProviderName } from './types.ts';
export type DirectFetchIo = Pick<GuardedFetchOptions, 'fetch' | 'dispatcher' | 'allowSyntheticDnsAddress'> & { createDispatcher?: () => Dispatcher };
export async function acquireDirect(url: URL, request: FetchProviderRequest, io: DirectFetchIo = {}, provider: ProviderName = 'direct-http') {
  const { createDispatcher, ...options } = io;
  const ownedDispatcher = createDispatcher?.();
  try {
    const response = await guardedFetch(url, {
      ...options, dispatcher: ownedDispatcher ?? options.dispatcher, signal: request.signal,
      timeoutMs: request.timeout_ms ?? 60_000, maxRedirects: request.max_redirects,
      headers: { Accept: 'text/html,text/plain,application/json,application/xml,text/xml,text/markdown,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'nb-search direct.fetch' },
    });
    const value = await boundedBody(response, request.max_response_bytes, request.signal);
    return { status: response.status, final_url: response.url || url.href, headers: Object.fromEntries(response.headers), ...value };
  } catch (error) {
    if (request.signal.aborted) throw request.signal.reason;
    if (isGuardedFetchError(error)) {
      const code = error.code === 'timeout' ? 'DEADLINE_EXCEEDED' : error.code === 'too_many_redirects' ? 'FETCH_HTTP_ERROR' : error.code === 'network_error' ? 'PROVIDER_UNAVAILABLE' : 'FETCH_BLOCKED';
      throw new NbSearchError(code, code === 'FETCH_BLOCKED' ? 'The URL or redirect target is not public HTTP(S).' : code === 'FETCH_HTTP_ERROR' ? 'The redirect limit was reached.' : 'Direct HTTP fetch failed.', code === 'PROVIDER_UNAVAILABLE', provider, { cause: error, data: code === 'FETCH_HTTP_ERROR' ? { max_redirects: request.max_redirects } : undefined });
    }
    throw error;
  } finally {
    await ownedDispatcher?.destroy().catch(() => undefined);
  }
}
async function boundedBody(response: Response, maximumBytes: number, signal: AbortSignal) {
  if (response.body === null) return { body: new Uint8Array(), truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  const abort = () => { reader.cancel(signal.reason); };
  signal.addEventListener('abort', abort, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const chunk = await reader.read();
      signal.throwIfAborted();
      if (chunk.done) break;
      const available = maximumBytes - bytes;
      chunks.push(chunk.value.subarray(0, available));
      bytes += Math.min(chunk.value.byteLength, available);
      if (chunk.value.byteLength > available) { truncated = true; await reader.cancel(); break; }
    }
    return { body: Buffer.concat(chunks, bytes), truncated };
  } finally {
    signal.removeEventListener('abort', abort);
    reader.releaseLock();
  }
}
