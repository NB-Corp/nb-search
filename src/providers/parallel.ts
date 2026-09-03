import { NbSearchError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import type { JsonTransport } from '../transport.ts';
import type { CredentialSlotId, ProviderInstanceId, ProviderName, ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';

export const PARALLEL_SEARCH_URL = 'https://api.parallel.ai/v1/search';

export interface ParallelProviderOptions {
  apiKey: string;
  transport: JsonTransport;
  providerInstanceId?: ProviderInstanceId;
  credentialSlotId?: CredentialSlotId;
  clock?: () => Date;
}

export class ParallelSearchProvider implements SearchProvider {
  readonly name = 'parallel' as const;
  readonly provider_id = 'parallel' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];

  constructor(private readonly options: ParallelProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'parallel.default';
    this.credential_slot_id = options.credentialSlotId;
    this.redactions = [options.apiKey, PARALLEL_SEARCH_URL];
  }

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: PARALLEL_SEARCH_URL,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-API-Key': this.options.apiKey },
        body: {
          objective: request.query,
          search_queries: [request.query],
          mode: 'fast',
          advanced_settings: { max_results: Math.min(request.limit, 20) },
        },
        response_type: 'json',
        signal: request.signal,
      });
      assertStatus(response.status, this.name, response.headers, this.options.clock);
      if (!isRecord(response.body) || !Array.isArray(response.body['results'])) throw malformed();
      const results: ProviderResult[] = [];
      for (const item of response.body['results'].slice(0, 100)) {
        if (!isRecord(item) || typeof item['url'] !== 'string') continue;
        const url = item['url'].trim();
        if (normalizeUrl(url) === undefined) continue;
        const publishDate = text(item['publish_date']);
        results.push({
          title: text(item['title']),
          url,
          snippet: excerpts(item['excerpts']) || text(item['excerpt']) || text(item['snippet']),
          ...(publishDate === '' ? {} : { published_at: publishDate }),
        });
        if (results.length >= request.limit) break;
      }
      return results;
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeError(error, this.name, this.redactions);
    }
  }
}

function excerpts(value: unknown): string {
  return Array.isArray(value) ? value.map(text).filter(Boolean).join(' … ') : '';
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function malformed(): NbSearchError {
  return new NbSearchError('PROVIDER_UNAVAILABLE', 'parallel returned malformed search content.', false, 'parallel');
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
