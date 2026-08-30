import { NbSearchError } from './errors.ts';
import { redactText } from './redaction.ts';
import type { JsonTransport } from './transport.ts';
import type {
  CredentialSlotId, ProfileId, ProviderInstanceId, ProviderName, ProviderResult, ProviderSearchRequest,
  ProviderSearchResponse, SearchProvider, UpstreamAttempt, UpstreamAttemptState, UpstreamResultAttribution,
} from './types.ts';

export const EXA_SEARCH_URL = 'https://api.exa.ai/search';
export const TAVILY_SEARCH_URL = 'https://api.tavily.com/search';

export interface ProviderOptions {
  apiKey: string; transport: JsonTransport; baseUrl?: string;
  searchPath?: string;
  providerInstanceId?: ProviderInstanceId; credentialSlotId?: CredentialSlotId;
  clock?: () => Date;
}

export class ExaProvider implements SearchProvider {
  readonly name = 'exa' as const;
  readonly provider_id = 'exa' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: ProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'exa.default';
    this.credential_slot_id = options.credentialSlotId;
    this.endpoint = resolveSearchUrl(options.baseUrl ?? EXA_SEARCH_URL, options.searchPath);
    this.redactions = [options.apiKey, this.endpoint];
  }
  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const body: Record<string, unknown> = {
        query: request.query,
        numResults: request.limit,
        type: exaSearchType(request),
        contents: { highlights: { maxCharacters: 1200 } },
      };
      const publishedAfter = freshnessStart(request.freshness, this.options.clock ?? (() => new Date()));
      if (publishedAfter !== undefined) body['startPublishedDate'] = publishedAfter;
      const response = await this.options.transport.send<{ results?: unknown; resolvedSearchType?: unknown }>({
        url: this.endpoint, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-api-key': this.options.apiKey },
        body,
        signal: request.signal,
      });
      assertProviderStatus(response.status, this.name, response.headers, this.options.clock);
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
  readonly provider_id = 'tavily' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: ProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'tavily.default';
    this.credential_slot_id = options.credentialSlotId;
    this.endpoint = resolveSearchUrl(options.baseUrl ?? TAVILY_SEARCH_URL, options.searchPath);
    this.redactions = [options.apiKey, this.endpoint];
  }
  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const body: Record<string, unknown> = {
        api_key: this.options.apiKey, query: request.query, max_results: request.limit, include_answer: false,
      };
      const days = freshnessDays(request.freshness);
      if (days !== undefined) body['days'] = days;
      const response = await this.options.transport.send<{ results?: unknown }>({
        url: this.endpoint, method: 'POST', headers: { 'Content-Type': 'application/json' },
        body,
        signal: request.signal,
      });
      assertProviderStatus(response.status, this.name, response.headers, this.options.clock);
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

export interface SearchGatewayProviderOptions extends ProviderOptions {
  downstreamProfile?: string;
}

export class SearchGatewayProvider implements SearchProvider {
  readonly name = 'search-gateway' as const;
  readonly provider_id = 'search-gateway' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: SearchGatewayProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'search-gateway.aggregate';
    this.credential_slot_id = options.credentialSlotId;
    if (options.baseUrl === undefined) {
      throw new NbSearchError('CONFIGURATION_ERROR', 'Aggregate gateway endpoint is required.');
    }
    this.endpoint = resolveOperationUrl(options.baseUrl, '/v1/aggregate/search');
    this.redactions = [options.apiKey, this.endpoint];
  }
  async search(request: ProviderSearchRequest): Promise<ProviderSearchResponse> {
    try {
      const body = {
        query: request.query,
        profile: resolveDownstreamProfile(this.options.downstreamProfile, request.profile, request.intent),
        num: request.limit,
        ...(request.intent === undefined ? {} : { intent: request.intent }),
        ...(request.freshness === undefined ? {} : { freshness: request.freshness }),
      };
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint,
        method: 'POST',
        headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body,
        signal: request.signal,
      });
      assertProviderStatus(response.status, this.name, response.headers, this.options.clock);
      if (!isRecord(response.body)) return { results: [] };
      const rows = Array.isArray(response.body['results']) ? response.body['results'] : [];
      const gatewayRedactions = [this.options.apiKey, this.endpoint, request.query];
      const results = rows.flatMap((item): ProviderResult[] => projectGatewayResult(
        item, [this.options.apiKey, this.endpoint], gatewayRedactions,
      ));
      const normalizedAttempts = normalizeUpstreamAttempts(
        response.body['attempts'], gatewayRedactions,
      );
      return {
        results,
        ...(normalizedAttempts.items.length === 0 ? {} : { upstream_attempts: normalizedAttempts.items }),
        ...(normalizedAttempts.omitted === 0 ? {} : { upstream_attempts_omitted: normalizedAttempts.omitted }),
      };
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name, this.redactions);
    }
  }
}

function exaSearchType(request: ProviderSearchRequest): 'auto' | 'fast' | 'deep' {
  if (request.intent === 'status' || request.intent === 'news') return 'fast';
  if (request.intent === 'exploratory' && request.profile === 'deep') return 'deep';
  return 'auto';
}

function freshnessDays(value: ProviderSearchRequest['freshness']): number | undefined {
  if (value === 'pd') return 1;
  if (value === 'pw') return 7;
  if (value === 'pm') return 30;
  if (value === 'py') return 365;
  return undefined;
}

function freshnessStart(value: ProviderSearchRequest['freshness'], clock: () => Date): string | undefined {
  const days = freshnessDays(value);
  return days === undefined ? undefined : new Date(clock().getTime() - days * 86_400_000).toISOString();
}

export function resolveSearchUrl(value: string, explicitPath?: string): string {
  if (explicitPath !== undefined) return resolveOperationUrl(value, explicitPath);
  const url = validatedBaseUrl(value);
  const path = url.pathname.replace(/\/+$/, '');
  url.pathname = path.endsWith('/search') ? path : `${path}/search`;
  return url.toString();
}

export function resolveOperationUrl(value: string, operationPath: string): string {
  validateSearchPath(operationPath);
  const url = validatedBaseUrl(value);
  const basePath = url.pathname.replace(/\/+$/, '');
  url.pathname = basePath.endsWith(operationPath) ? basePath : `${basePath}${operationPath}`;
  return url.toString();
}

export function validateProviderBaseUrl(value: string): void { validatedBaseUrl(value); }

export function validateSearchPath(value: string): void {
  if (value.length < 2 || value.length > 512 || !value.startsWith('/') || value.startsWith('//')
    || value.endsWith('/') || value.includes('?') || value.includes('#') || value.includes('\\')) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Provider search_path is invalid.');
  }
  const segments = value.slice(1).split('/');
  if (segments.some((segment) => {
    let decoded = segment;
    try { decoded = decodeURIComponent(segment); } catch { return true; }
    return decoded === '' || decoded === '.' || decoded === '..' || decoded.includes('/') || decoded.includes('\\');
  })) {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Provider search_path is invalid.');
  }
}

function validatedBaseUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw new NbSearchError('CONFIGURATION_ERROR', 'Provider base URL must be an HTTP(S) URL.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== ''
    || url.search !== '' || url.hash !== '') {
    throw new NbSearchError('CONFIGURATION_ERROR', 'Provider base URL must be an HTTP(S) URL without user info, query, or fragment.');
  }
  return url;
}

function assertProviderStatus(
  status: number,
  provider: ProviderName,
  headers?: Readonly<Record<string, string>>,
  clock: () => Date = () => new Date(),
): void {
  if (status >= 200 && status < 300) return;
  if (status === 401 || status === 403) throw new NbSearchError('PROVIDER_AUTH', `${provider} authentication failed.`, false, provider);
  if (status === 429) {
    throw new NbSearchError('PROVIDER_RATE_LIMIT', `${provider} rate limit was reached.`, true, provider, {
      retryAfterMs: parseRetryAfter(headerValue(headers, 'retry-after'), clock),
    });
  }
  const retryable = status === 408 || status === 425 || status === 500 || status === 502 || status === 503 || status === 504;
  throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request failed (HTTP ${String(status)}).`, retryable, provider);
}

function safeProviderError(error: unknown, provider: ProviderName, redactions: readonly string[]): NbSearchError {
  if (error instanceof NbSearchError) {
    return new NbSearchError(error.code, redactText(error.message, redactions), error.retryable, provider, {
      cause: error, retryAfterMs: error.retryAfterMs,
    });
  }
  return new NbSearchError('PROVIDER_UNAVAILABLE', redactText(`${provider} provider failed.`, redactions), true, provider, { cause: error });
}

function resolveDownstreamProfile(
  configured: string | undefined,
  profile: ProfileId | undefined,
  intent: ProviderSearchRequest['intent'],
): string {
  if (configured !== undefined) return configured;
  if (intent === 'resource') return 'fast';
  if (intent === 'factual' || intent === 'tutorial') return 'answer';
  if (intent !== undefined) return 'deep';
  return profile === 'fast' ? 'fast' : 'deep';
}

function projectGatewayResult(
  value: unknown,
  urlRedactions: readonly string[],
  redactions: readonly string[],
): ProviderResult[] {
  if (!isRecord(value)) return [];
  const url = firstString(value, ['url', 'link']);
  if (url === '' || urlRedactions.some((item) => item !== '' && url.includes(item))) return [];
  const attribution = normalizeAttribution(selectAttributionInput(value), redactions);
  const published = firstString(value, ['published_at', 'published_date', 'publishedDate']);
  return [{
    title: redactText(stringValue(value['title']), redactions),
    url,
    snippet: redactText(firstString(value, ['snippet', 'content']), redactions),
    ...(published === '' ? {} : { published_at: redactText(published, redactions) }),
    ...(attribution.items.length === 0 ? {} : { upstream_attribution: attribution.items }),
    ...(attribution.omitted === 0 ? {} : { upstream_attribution_omitted: attribution.omitted }),
  }];
}

function selectAttributionInput(record: Record<string, unknown>): unknown {
  const providers = record['providers'];
  if (Array.isArray(providers) && providers.length > 0 && providers.every((item) => {
    if (typeof item !== 'string') return false;
    const provider = stringValue(item);
    return provider !== '' && provider.length <= 128;
  })) return providers;
  return typeof record['source'] === 'string' ? record['source'] : undefined;
}

function normalizeAttribution(value: unknown, redactions: readonly string[]): { items: UpstreamResultAttribution[]; omitted: number } {
  const values = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const all: UpstreamResultAttribution[] = [];
  for (const value of values) {
    const provider = safeBoundedString(value, 128, redactions);
    if (provider === undefined || seen.has(provider)) continue;
    seen.add(provider);
    all.push({ provider });
  }
  return { items: all.slice(0, 16), omitted: Math.max(0, all.length - 16) };
}

function normalizeUpstreamAttempts(value: unknown, redactions: readonly string[]): { items: UpstreamAttempt[]; omitted: number } {
  if (!Array.isArray(value)) return { items: [], omitted: 0 };
  const all = value.flatMap((item): UpstreamAttempt[] => {
    if (!isRecord(item)) return [];
    const error = normalizeUpstreamError(item['error'], item['error_type'], redactions);
    const status = boundedString(item['status'], 128)?.toLowerCase();
    const state = normalizeUpstreamState(status, error !== undefined);
    const capability = item['capability'] === 'search' ? 'retrieval' : isProviderCapability(item['capability']) ? item['capability'] : undefined;
    const attempt = positiveSafeInteger(item['attempt']);
    const role = safeBoundedString(item['role'], 128, redactions);
    const trigger = safeBoundedString(item['trigger'], 128, redactions);
    return [{
      provider: safeBoundedString(item['provider'], 128, redactions) ?? safeBoundedString(item['service'], 128, redactions) ?? 'unknown',
      state,
      duration_ms: nonnegativeSafeInteger(item['duration_ms']) ?? nonnegativeSafeInteger(item['elapsed_ms']) ?? 0,
      result_count: nonnegativeSafeInteger(item['result_count']) ?? 0,
      ...(attempt === undefined ? {} : { attempt }),
      ...(capability === undefined ? {} : { capability }),
      ...(role === undefined ? {} : { role }),
      ...(trigger === undefined ? {} : { trigger }),
      ...(error === undefined ? {} : { error }),
    }];
  });
  return { items: all.slice(0, 32), omitted: Math.max(0, all.length - 32) };
}

function normalizeUpstreamState(status: string | undefined, hasError: boolean): UpstreamAttemptState {
  if (status === undefined) return hasError ? 'failed' : 'succeeded';
  if (status === 'ok' || status === 'success' || status === 'succeeded') return 'succeeded';
  if (status === 'empty' || status === 'no_results') return 'empty';
  if (status === 'skipped') return 'skipped';
  if (status === 'failed' || status === 'error') return 'failed';
  if (status === 'timeout' || status === 'timed_out') return 'timed_out';
  if (status === 'cancelled' || status === 'canceled') return 'cancelled';
  return 'unknown';
}

function normalizeUpstreamError(
  value: unknown,
  errorType: unknown,
  redactions: readonly string[],
): UpstreamAttempt['error'] | undefined {
  const record = isRecord(value) ? value : undefined;
  const rawMessage = typeof value === 'string' ? value : record?.['message'];
  const message = boundedString(rawMessage, 2048);
  const code = safeBoundedString(record?.['code'] ?? errorType, 128, redactions);
  const retryable = typeof record?.['retryable'] === 'boolean' ? record['retryable'] : undefined;
  if (message === undefined && code === undefined && retryable === undefined) return undefined;
  const safeMessage = message === undefined ? undefined : redactText(message, redactions)
    .replace(/\bhttps?:\/\/[^\s,;\)\]\}]+/gi, '<redacted-provider-url>').slice(0, 512);
  return {
    ...(code === undefined ? {} : { code }),
    ...(safeMessage === undefined ? {} : { message: safeMessage }),
    ...(retryable === undefined ? {} : { retryable }),
  };
}

function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = stringValue(record[key]);
    if (value !== '') return value;
  }
  return '';
}
function boundedString(value: unknown, max: number): string | undefined {
  const text = stringValue(value);
  return text === '' ? undefined : text.slice(0, max);
}
function safeBoundedString(value: unknown, max: number, redactions: readonly string[]): string | undefined {
  const text = boundedString(value, Math.max(max, 2048));
  return text === undefined ? undefined : sanitizeGatewayText(text, redactions).slice(0, max);
}
function sanitizeGatewayText(value: string, redactions: readonly string[]): string {
  return redactText(value, redactions).replace(/\bhttps?:\/\/[^\s,;\)\]\}]+/gi, '<redacted-provider-url>');
}
function nonnegativeSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}
function positiveSafeInteger(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : undefined;
}
function isProviderCapability(value: unknown): value is 'retrieval' | 'answer' | 'research-light' | 'multi-agent-research' {
  return value === 'retrieval' || value === 'answer' || value === 'research-light' || value === 'multi-agent-research';
}
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value) }
function stringValue(value: unknown): string { return typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '' }
function numberValue(value: unknown): number | undefined { return typeof value === 'number' && Number.isFinite(value) ? value : undefined }
function joinedText(value: unknown): string { return Array.isArray(value) ? value.map(stringValue).filter(Boolean).join(' … ') : stringValue(value) }
function parseRetryAfter(value: string | undefined, clock: () => Date): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  if (!Number.isFinite(at)) return undefined;
  return Math.max(0, at - clock().getTime());
}
function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const found = Object.entries(headers).find(([key]) => key.toLowerCase() === name);
  return found?.[1];
}
