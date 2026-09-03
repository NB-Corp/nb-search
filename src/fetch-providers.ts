import { NbSearchError } from './errors.ts';
import { htmlToText, parsePublicUrl } from './fetch-security.ts';
import { resolveOperationUrl, validateProviderBaseUrl } from './providers.ts';
import { ResponseLimitError, type HttpTransport } from './transport.ts';
import type { FetchProvider, FetchProviderRequest, FetchProviderResult, FetchWarning, ProviderName } from './types.ts';

const WAYBACK_AVAILABLE_ENDPOINT = 'https://archive.org/wayback/available';

export interface RemoteFetchProviderOptions { apiKey?: string; transport: HttpTransport; baseUrl?: string }

export class JinaReaderFetchProvider implements FetchProvider {
  readonly name = 'jina-reader' as const;
  readonly redactions: readonly string[];
  private readonly baseUrl: string;
  constructor(private readonly options: RemoteFetchProviderOptions) {
    this.baseUrl = options.baseUrl ?? 'https://r.jina.ai';
    validateProviderBaseUrl(this.baseUrl);
    this.redactions = options.apiKey === undefined ? [this.baseUrl] : [options.apiKey, this.baseUrl];
  }
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      const response = await this.options.transport.send<string>({
        url: `${this.baseUrl.replace(/\/+$/, '')}/${fetchUrl(request)}`, method: 'GET',
        headers: { Accept: 'text/plain', ...(this.options.apiKey === undefined ? {} : { Authorization: `Bearer ${this.options.apiKey}` }) },
        response_type: 'text', max_response_bytes: request.max_response_bytes, signal: request.signal,
      });
      assertFetchStatus(response.status, this.name);
      if (typeof response.body !== 'string') throw malformed(this.name);
      return normalized(request, fetchUrl(request), response.body, response.headers?.['content-type'] ?? 'text/plain');
    } catch (error) { throw fetchProviderError(error, this.name); }
  }
}

export class TavilyExtractFetchProvider implements FetchProvider {
  readonly name = 'tavily' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: RemoteFetchProviderOptions & { apiKey: string }) {
    this.endpoint = options.baseUrl === undefined ? 'https://api.tavily.com/extract' : resolveOperationUrl(options.baseUrl, '/extract');
    this.redactions = [options.apiKey, this.endpoint];
  }
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint, method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: { urls: [fetchUrl(request)], format: 'text' }, response_type: 'json', max_response_bytes: request.max_response_bytes, signal: request.signal,
      });
      assertFetchStatus(response.status, this.name);
      if (!isRecord(response.body) || !Array.isArray(response.body['results'])) throw malformed(this.name);
      const item = response.body['results'].find(isRecord);
      if (item === undefined) { const failures = Array.isArray(response.body['failed_results']) ? response.body['failed_results'].length : 0; if (failures > 0) throw businessFailure(this.name, { failed_results: failures }); throw malformed(this.name); }
      return normalized(request, stringValue(item['url']) || fetchUrl(request), stringValue(item['raw_content']) || stringValue(item['content']), 'text/plain', stringValue(item['title']));
    } catch (error) { throw fetchProviderError(error, this.name); }
  }
}

export class ExaContentsFetchProvider implements FetchProvider {
  readonly name = 'exa' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: RemoteFetchProviderOptions & { apiKey: string }) {
    this.endpoint = options.baseUrl === undefined ? 'https://api.exa.ai/contents' : resolveOperationUrl(options.baseUrl, '/contents');
    this.redactions = [options.apiKey, this.endpoint];
  }
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint, method: 'POST', headers: { 'Content-Type': 'application/json', 'x-api-key': this.options.apiKey },
        body: { urls: [fetchUrl(request)], text: { maxCharacters: request.max_content_chars } }, response_type: 'json', max_response_bytes: request.max_response_bytes, signal: request.signal,
      });
      assertFetchStatus(response.status, this.name);
      if (!isRecord(response.body)) throw malformed(this.name);
      const failure = exaFailure(response.body['statuses']); if (failure !== undefined) { if (failure.http_status !== undefined) throw fetchHttpError(failure.http_status, this.name); throw businessFailure(this.name); }
      const results = Array.isArray(response.body['results']) ? response.body['results'] : [];
      const item = results.find(isRecord); if (item === undefined) throw malformed(this.name);
      return normalized(request, stringValue(item['url']) || fetchUrl(request), stringValue(item['text']), 'text/plain', stringValue(item['title']));
    } catch (error) { throw fetchProviderError(error, this.name); }
  }
}

export class FirecrawlScrapeFetchProvider implements FetchProvider {
  readonly name = 'firecrawl' as const;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  constructor(private readonly options: RemoteFetchProviderOptions & { apiKey: string }) {
    this.endpoint = options.baseUrl === undefined ? 'https://api.firecrawl.dev/v2/scrape' : resolveOperationUrl(options.baseUrl, '/v2/scrape');
    this.redactions = [options.apiKey, this.endpoint];
  }
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint, method: 'POST', headers: { Authorization: `Bearer ${this.options.apiKey}`, 'Content-Type': 'application/json' },
        body: { url: fetchUrl(request), formats: ['markdown'] }, response_type: 'json', max_response_bytes: request.max_response_bytes, signal: request.signal,
      });
      assertFetchStatus(response.status, this.name);
      if (!isRecord(response.body) || response.body['success'] !== true || !isRecord(response.body['data'])) throw businessFailure(this.name);
      const data = response.body['data']; const metadata = isRecord(data['metadata']) ? data['metadata'] : {};
      return normalized(request, stringValue(metadata['sourceURL']) || stringValue(metadata['url']) || fetchUrl(request), stringValue(data['markdown']), 'text/markdown', stringValue(metadata['title']));
    } catch (error) { throw fetchProviderError(error, this.name); }
  }
}

export class WaybackFetchProvider implements FetchProvider {
  readonly name = 'wayback' as const;
  readonly redactions = [WAYBACK_AVAILABLE_ENDPOINT];
  constructor(private readonly options: Pick<RemoteFetchProviderOptions, 'transport'>) {}
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      const sourceUrl = fetchUrl(request);
      const lookup = new URL(WAYBACK_AVAILABLE_ENDPOINT); lookup.searchParams.set('url', sourceUrl);
      const available = await this.options.transport.send<unknown>({ url: lookup.toString(), method: 'GET', headers: { Accept: 'application/json' }, response_type: 'json', max_response_bytes: request.max_response_bytes, signal: request.signal });
      assertFetchStatus(available.status, this.name);
      if (!isRecord(available.body)) throw malformed(this.name);
      const snapshots = isRecord(available.body['archived_snapshots']) ? available.body['archived_snapshots'] : undefined;
      const closest = snapshots !== undefined && isRecord(snapshots['closest']) ? snapshots['closest'] : undefined;
      const status = closest?.['status']; const snapshotUrl = closest?.['url']; const timestamp = stringValue(closest?.['timestamp']);
      if ((status !== '200' && status !== 200) || typeof snapshotUrl !== 'string' || snapshotUrl === '') throw fetchHttpError(404, this.name, { reason: 'snapshot_not_found' });
      if (timestamp === '') throw malformed(this.name);
      const snapshot = parsePublicUrl(snapshotUrl);
      const response = await this.options.transport.send<string>({ url: snapshot.toString(), method: 'GET', headers: { Accept: 'text/html,text/plain,text/markdown' }, response_type: 'text', max_response_bytes: request.max_response_bytes, signal: request.signal });
      assertFetchStatus(response.status, this.name);
      if (typeof response.body !== 'string') throw malformed(this.name);
      const contentType = response.headers?.['content-type'] ?? 'text/html'; const mediaType = contentType.split(';')[0]?.trim().toLowerCase();
      const projected: { content: string; title?: string } = mediaType === 'text/html' || mediaType === 'application/xhtml+xml' ? htmlToText(response.body) : { content: response.body };
      const archivedAt = archiveTimestamp(timestamp);
      const warning: FetchWarning = { code: 'WAYBACK_SNAPSHOT', message: 'The document was retrieved from an archived snapshot.', data: { snapshot_timestamp: timestamp, ...(archivedAt === undefined ? {} : { archived_at: archivedAt }) } };
      return normalized(request, snapshot.toString(), projected.content, contentType, projected.title ?? '', [warning]);
    } catch (error) { throw fetchProviderError(error, this.name); }
  }
}

function normalized(request: FetchProviderRequest, finalUrl: string, rawContent: string, contentType: string, rawTitle = '', initialWarnings: readonly FetchWarning[] = []): FetchProviderResult {
  const byteLength = Buffer.byteLength(rawContent, 'utf8'); const truncated = rawContent.length > request.max_content_chars; const content = truncated ? rawContent.slice(0, request.max_content_chars) : rawContent; const warnings: FetchWarning[] = [...initialWarnings]; const mediaType = contentType.split(';')[0]?.trim().toLowerCase() || 'text/plain';
  if (truncated) warnings.push({ code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'The content character limit was reached.', data: { max_content_chars: request.max_content_chars } });
  return { url: fetchUrl(request), final_url: finalUrl, ...(rawTitle === '' ? {} : { title: rawTitle }), content, content_type: mediaType, media_type: mediaType, representation: request.representation, format: 'text', byte_length: byteLength, truncated, warnings };
}
function fetchUrl(request: FetchProviderRequest): string { if (request.source.kind !== 'url') throw new NbSearchError('FETCH_PIPELINE_UNSUPPORTED', 'The remote fetch pipeline accepts URL input only.'); return request.source.url; }
function assertFetchStatus(status: number, provider: ProviderName): void { if (status < 200 || status >= 300) throw fetchHttpError(status, provider); }
function fetchHttpError(status: number, provider: ProviderName, data: Readonly<Record<string, unknown>> = {}): NbSearchError { return new NbSearchError('FETCH_HTTP_ERROR', `${provider} fetch failed with status ${String(status)}.`, status === 429 || status >= 500, provider, { data: { status, ...data } }); }
function businessFailure(provider: ProviderName, data?: Readonly<Record<string, unknown>>): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} did not return usable fetch content.`, false, provider, data === undefined ? undefined : { data }); }
function exaFailure(value: unknown): { http_status?: number } | undefined { if (!Array.isArray(value)) return undefined; for (const item of value) { if (!isRecord(item) || item['status'] !== 'error') continue; const error = isRecord(item['error']) ? item['error'] : {}; const status = error['httpStatusCode']; return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599 ? { http_status: status } : {}; } return undefined; }
function fetchProviderError(error: unknown, provider: ProviderName): NbSearchError {
  if (error instanceof NbSearchError) return error;
  if (error instanceof ResponseLimitError) return new NbSearchError('FETCH_BYTES_LIMIT', 'Fetch provider response exceeded the configured byte limit.', false, provider, { cause: error, data: { max_response_bytes: error.maximum } });
  return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} fetch failed.`, true, provider, { cause: error });
}
function malformed(provider: ProviderName): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} returned malformed fetch content.`, false, provider); }
function archiveTimestamp(value: string): string | undefined { const match = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})$/.exec(value); return match === null ? undefined : `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}Z`; }
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function stringValue(value: unknown): string { return typeof value === 'string' ? value : ''; }
