import { NbSearchError } from './errors.ts';
import { redactText } from './redaction.ts';
import type { JsonTransport } from './transport.ts';
import type { ProviderResult, ProviderSearchRequest, SearchProvider } from './types.ts';

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface ProviderOptions { apiKey: string; transport: JsonTransport; baseUrl?: string }

export class ExaProvider implements SearchProvider {
  readonly name = 'exa' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: ProviderOptions) {
    this.endpoint = resolveSearchUrl(options.baseUrl ?? EXA_SEARCH_URL);
    this.redactions = [options.apiKey, this.endpoint];
  }
  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const response = await this.options.transport.send<{ results?: unknown; resolvedSearchType?: unknown }>({
        url: this.endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.options.apiKey },
        body: { query: request.query, numResults: request.limit, type: 'auto', contents: { highlights: { maxCharacters: 1200 } } },
        signal: request.signal,
      });
      assertProviderStatus(response.status, this.name);
      const rows = Array.isArray(response.body.results) ? response.body.results : [];
      const resolvedType = stringValue(response.body.resolvedSearchType);
      return rows.flatMap((item): ProviderResult[] => {
        if (!isRecord(item) || stringValue(item['url']) === '') return [];
        return [{
          title: stringValue(item['title']), url: stringValue(item['url']),
          snippet: joinedText(item['highlights']) || stringValue(item['text']) || stringValue(item['summary']) || stringValue(item['snippet']),
          ...(stringValue(item['publishedDate']) === '' ? {} : { published_at: stringValue(item['publishedDate']) }),
          ...(numberValue(item['score']) === undefined ? {} : { score: numberValue(item['score']) }),
          ...(resolvedType === '' ? {} : { metadata: { resolved_search_type: resolvedType } }),
        }];
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name, this.redactions);
    }
  }
}

export class TavilyProvider implements SearchProvider {
  readonly name = 'tavily' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: ProviderOptions) {
    this.endpoint = resolveSearchUrl(options.baseUrl ?? TAVILY_SEARCH_URL);
    this.redactions = [options.apiKey, this.endpoint];
  }
  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const response = await this.options.transport.send<{ results?: unknown }>({
        url: this.endpoint, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: { api_key: this.options.apiKey, query: request.query, max_results: request.limit, include_answer: false },
        signal: request.signal,
      });
      assertProviderStatus(response.status, this.name);
      const rows = Array.isArray(response.body.results) ? response.body.results : [];
      return rows.flatMap((item): ProviderResult[] => {
        if (!isRecord(item) || stringValue(item['url']) === '') return [];
        return [{
          title: stringValue(item['title']), url: stringValue(item['url']), snippet: stringValue(item['content']),
          ...(stringValue(item['published_date']) === '' ? {} : { published_at: stringValue(item['published_date']) }),
          ...(numberValue(item['score']) === undefined ? {} : { score: numberValue(item['score']) }),
        }];
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name, this.redactions);
    }
  }
}

export function resolveSearchUrl(value: string): string {
  const url = new URL(value);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/search') ? path : `${path}/search`;
  return url.toString();
}

function assertProviderStatus(status: number, provider: 'exa' | 'tavily'): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new NbSearchError('PROVIDER_AUTH', `${provider} authentication failed.`, false, provider);
  if (status === 429) throw new NbSearchError('PROVIDER_RATE_LIMIT', `${provider} rate limit was reached.`, true, provider);
  const retryable = status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504;
  throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request failed (HTTP ${String(status)}).`, retryable, provider);
}

function safeProviderError(error: unknown, provider: 'exa' | 'tavily', redactions: readonly string[]): NbSearchError {
  if (error instanceof NbSearchError) {
    return new NbSearchError(error.code, redactText(error.message, redactions), error.retryable, provider, { cause: error });
  }
  return new NbSearchError('PROVIDER_UNAVAILABLE', redactText(`${provider} provider failed.`, redactions), true, provider, { cause: error });
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringValue(value: unknown): string { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '' }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function joinedText(value: unknown): string { return Array.isArray(value) ? value.map(stringValue).filter(Boolean).join(' … ') : stringValue(value) }
