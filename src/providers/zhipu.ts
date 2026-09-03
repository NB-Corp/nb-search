import { z } from 'zod';

import { NbSearchError } from '../errors.ts';
import { ResponseLimitError, type JsonTransport } from '../transport.ts';
import type { ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';

export const DEFAULT_ZHIPU_SEARCH_URL = 'https://open.bigmodel.cn/api/paas/v4/web_search';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const resultSchema = z.object({
  title: z.string().optional(),
  link: z.string().optional(),
  url: z.string().optional(),
  content: z.string().optional(),
  description: z.string().optional(),
  snippet: z.string().optional(),
  publish_date: z.string().optional(),
  published_date: z.string().optional(),
}).passthrough();
const responseSchema = z.object({ search_result: z.array(resultSchema) }).passthrough();

export interface ZhipuProviderOptions {
  apiKey: string;
  transport: JsonTransport;
  baseUrl?: string;
  clock?: () => Date;
}

export class ZhipuSearchProvider implements SearchProvider {
  readonly name = 'zhipu' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  private readonly authorization: string;

  constructor(private readonly options: ZhipuProviderOptions) {
    this.endpoint = resolveEndpoint(options.baseUrl);
    this.authorization = `Bearer ${options.apiKey}`;
    this.redactions = [options.apiKey, this.authorization];
  }

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint,
        method: 'POST',
        headers: { Authorization: this.authorization, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: { search_query: request.query, search_engine: 'search_std' },
        response_type: 'json',
        max_response_bytes: MAX_RESPONSE_BYTES,
        signal: request.signal,
      });
      assertStatus(response.status, this.name, response.headers, this.options.clock);
      assertNoBusinessError(response.body, this.name);
      const parsed = responseSchema.safeParse(response.body);
      if (!parsed.success) throw malformed(this.name);
      const results: ProviderResult[] = [];
      for (const item of parsed.data.search_result) {
        const url = normalizeUrl((item.link ?? item.url ?? '').trim());
        if (url === undefined) continue;
        const title = clean(item.title);
        const snippet = clean(item.content ?? item.description ?? item.snippet);
        const publishedAt = clean(item.publish_date ?? item.published_date);
        results.push({ title, url, ...(snippet === '' ? {} : { snippet }), ...(publishedAt === '' ? {} : { published_at: publishedAt }) });
        if (results.length >= request.limit) break;
      }
      return results;
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name);
    }
  }
}

function resolveEndpoint(baseUrl: string | undefined): string {
  if (baseUrl === undefined) return DEFAULT_ZHIPU_SEARCH_URL;
  let url: URL;
  try { url = new URL(baseUrl); } catch { throw new NbSearchError('CONFIGURATION_ERROR', 'Zhipu base URL must be an HTTP(S) URL.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new NbSearchError('CONFIGURATION_ERROR', 'Zhipu base URL must be an HTTP(S) URL without user info, query, or fragment.');
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/paas/v4/web_search') ? path : `${path}/paas/v4/web_search`;
  return url.toString();
}
function assertNoBusinessError(body: unknown, provider: string): void {
  if (!isRecord(body)) return;
  const error = clean(body['error'] ?? body['message']);
  const code = body['code'];
  if (error !== '' || (code !== undefined && code !== 0 && code !== 200 && code !== '0' && code !== '200')) throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request was rejected by the upstream service.`, false, provider);
}
function assertStatus(status: number, provider: string, headers?: Readonly<Record<string, string>>, clock: () => Date = () => new Date()): void {
  if (status >= 200 && status < 300) return;
  const data = { status };
  if (status === 401 || status === 403) throw new NbSearchError('PROVIDER_AUTH', `${provider} authentication failed.`, false, provider, { data });
  if (status === 429) throw new NbSearchError('PROVIDER_RATE_LIMIT', `${provider} rate limit was reached.`, true, provider, { data, retryAfterMs: parseRetryAfter(header(headers, 'retry-after'), clock()) });
  throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request failed (HTTP ${String(status)}).`, status >= 500, provider, { data });
}
function safeProviderError(error: unknown, provider: string): NbSearchError {
  if (error instanceof ResponseLimitError) return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} response exceeded the configured limit.`, false, provider, { cause: error });
  if (error instanceof NbSearchError) return new NbSearchError(error.code, error.message, error.retryable, provider, { cause: error, retryAfterMs: error.retryAfterMs, data: error.data });
  return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} provider connection failed.`, true, provider, { cause: error });
}
function malformed(provider: string): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} returned malformed content.`, false, provider); }
function clean(value: unknown): string { return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : ''; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined { return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function parseRetryAfter(value: string | undefined, clock: Date): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock.getTime()) : undefined;
}
