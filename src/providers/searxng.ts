import { NbSearchError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import type { JsonTransport } from '../transport.ts';
import type { Hint, ProviderInstanceId, ProviderName, ProviderResult, ProviderSearchRequest, ProviderSearchResponse, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';

export interface SearxngProviderOptions {
  baseUrl: string;
  transport: JsonTransport;
  providerInstanceId?: ProviderInstanceId;
  clock?: () => Date;
}

export class SearxngSearchProvider implements SearchProvider {
  readonly name = 'searxng' as const;
  readonly provider_id = 'searxng' as const;
  readonly provider_instance_id: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;

  constructor(private readonly options: SearxngProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'searxng.default';
    this.endpoint = resolveSearxngUrl(options.baseUrl);
    this.redactions = [options.baseUrl, this.endpoint];
  }

  async search(request: ProviderSearchRequest): Promise<ProviderSearchResponse> {
    try {
      const url = new URL(this.endpoint);
      url.searchParams.set('q', request.query);
      url.searchParams.set('format', 'json');
      const response = await this.options.transport.send<unknown>({
        url: url.toString(),
        method: 'GET',
        response_type: 'json',
        signal: request.signal,
      });
      assertStatus(response.status, this.name, response.headers, this.options.clock);
      if (!isRecord(response.body) || !Array.isArray(response.body['results'])) throw malformed();
      const unresponsive = normalizeUnresponsive(response.body['unresponsive_engines']);
      if (response.body['unresponsive_engines'] !== undefined && !Array.isArray(response.body['unresponsive_engines'])) throw malformed();
      const distribution = new Map<string, number>();
      const results: ProviderResult[] = [];
      for (const item of response.body['results'].slice(0, 100)) {
        if (!isRecord(item) || typeof item['url'] !== 'string') continue;
        const itemUrl = item['url'].trim();
        if (normalizeUrl(itemUrl) === undefined) continue;
        const engines = engineNames(item);
        for (const engine of engines) distribution.set(engine, (distribution.get(engine) ?? 0) + 1);
        const attribution = engines.join(', ');
        const snippet = text(item['content']) || text(item['snippet']);
        results.push({
          title: text(item['title']),
          url: itemUrl,
          snippet: attribution === '' ? snippet : `[${attribution}]${snippet === '' ? '' : ` ${snippet}`}`,
          ...(attribution === '' ? {} : { metadata: { engine: attribution } }),
          ...(text(item['publishedDate']) === '' ? {} : { published_at: text(item['publishedDate']) }),
        });
        if (results.length >= request.limit) break;
      }
      if (results.length === 0 && unresponsive.length > 0) {
        throw new NbSearchError('PROVIDER_UNAVAILABLE', 'searxng search engines were unresponsive.', true, this.name, { data: { unresponsive_engines: unresponsive } });
      }
      const hints: Hint[] = unresponsive.length === 0 ? [] : [{
        code: 'SEARXNG_UNRESPONSIVE_ENGINES',
        message: 'Some SearXNG engines were unresponsive.',
        data: {
          unresponsive_engines: unresponsive,
          engine_distribution: Object.fromEntries([...distribution.entries()].sort(([left], [right]) => left.localeCompare(right))),
        },
      }];
      return { results, ...(hints.length === 0 ? {} : { hints }) };
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeError(error, this.name, this.redactions);
    }
  }
}

export function validateSearxngBaseUrl(value: string): void {
  resolveSearxngUrl(value);
}

export function resolveSearxngUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw invalidBaseUrl(); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.hostname === '' || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw invalidBaseUrl();
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/search') ? path : `${path}/search`;
  return url.toString();
}

function invalidBaseUrl(): NbSearchError {
  return new NbSearchError('CONFIGURATION_ERROR', 'SearXNG base URL must be an HTTP(S) URL without user info, query, or fragment.');
}

function engineNames(item: Record<string, unknown>): string[] {
  const direct = text(item['engine']);
  if (direct !== '') return [direct];
  return Array.isArray(item['engines']) ? [...new Set(item['engines'].map(text).filter(Boolean))] : [];
}

function normalizeUnresponsive(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): string[] => {
    if (typeof item === 'string') return item.trim() === '' ? [] : [item.trim()];
    if (!Array.isArray(item)) return [];
    const engine = text(item[0]);
    const reason = text(item[1]);
    return engine === '' ? [] : [`${engine}${reason === '' ? '' : `: ${reason}`}`];
  });
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): NbSearchError {
  return new NbSearchError('PROVIDER_UNAVAILABLE', 'searxng returned malformed search content.', false, 'searxng');
}

function assertStatus(status: number, provider: ProviderName, headers?: Readonly<Record<string, string>>, clock: () => Date = () => new Date()): void {
  if (status >= 200 && status < 300) return;
  const data = { status };
  if (status === 401 || status === 403) throw new NbSearchError('PROVIDER_AUTH', `${provider} authentication failed.`, false, provider, { data });
  if (status === 429) throw new NbSearchError('PROVIDER_RATE_LIMIT', `${provider} rate limit was reached.`, true, provider, { data, retryAfterMs: retryAfter(headers, clock) });
  const retryable = status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504;
  throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request failed (HTTP ${String(status)}).`, retryable, provider, { data });
}

function retryAfter(headers: Readonly<Record<string, string>> | undefined, clock: () => Date): number | undefined {
  const value = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock().getTime()) : undefined;
}

function safeError(error: unknown, provider: ProviderName, redactions: readonly string[]): NbSearchError {
  if (error instanceof NbSearchError) return new NbSearchError(error.code, redactText(error.message, redactions), error.retryable, provider, { cause: error, retryAfterMs: error.retryAfterMs, data: error.data });
  return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} provider failed.`, true, provider, { cause: error });
}
