import { z } from 'zod';

import { NbSearchError } from '../errors.ts';
import { ResponseLimitError, type JsonTransport } from '../transport.ts';
import type { JsonValue, QueryExecutionRequest, QueryProvider, QueryProviderValue } from '../types.ts';
import { normalizeUrl } from '../url.ts';

export const DEFAULT_CONTEXT7_BASE_URL = 'https://context7.com';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const librarySchema = z.object({
  id: z.string().trim().min(1),
  title: z.string(),
  description: z.string(),
}).passthrough();
const librarySearchSchema = z.object({ results: z.array(librarySchema) }).passthrough();
const codeSnippetSchema = z.object({
  codeTitle: z.string(),
  codeDescription: z.string(),
  codeLanguage: z.string(),
  codeId: z.string(),
  codeList: z.array(z.object({ language: z.string(), code: z.string() }).passthrough()),
}).passthrough();
const infoSnippetSchema = z.object({
  pageId: z.string().optional(),
  breadcrumb: z.string().optional(),
  content: z.string(),
}).passthrough();
const contextSchema = z.object({
  codeSnippets: z.array(codeSnippetSchema),
  infoSnippets: z.array(infoSnippetSchema),
}).passthrough();

export interface Context7ProviderOptions {
  apiKey?: string;
  transport: JsonTransport;
  baseUrl?: string;
  clock?: () => Date;
}

export class Context7DocsProvider implements QueryProvider {
  readonly name = 'context7' as const;
  readonly redactions: readonly string[];
  private readonly baseUrl: string;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(private readonly options: Context7ProviderOptions) {
    this.baseUrl = resolveBaseUrl(options.baseUrl ?? DEFAULT_CONTEXT7_BASE_URL);
    const authorization = options.apiKey === undefined ? undefined : `Bearer ${options.apiKey}`;
    this.headers = {
      Accept: 'application/json',
      'X-Context7-Source': 'nb-search',
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    };
    this.redactions = options.apiKey === undefined ? [] : [options.apiKey, authorization!];
  }

  async execute(request: QueryExecutionRequest): Promise<QueryProviderValue> {
    try {
      const searchUrl = new URL('/api/v2/libs/search', this.baseUrl);
      searchUrl.searchParams.set('query', request.query);
      const searchResponse = await this.options.transport.send<unknown>({
        url: searchUrl.toString(), method: 'GET', headers: this.headers, response_type: 'json',
        max_response_bytes: MAX_RESPONSE_BYTES, signal: request.signal,
      });
      assertStatus(searchResponse.status, this.name, searchResponse.headers, this.options.clock);
      assertNoBusinessError(searchResponse.body, this.name);
      const searched = librarySearchSchema.safeParse(searchResponse.body);
      if (!searched.success) throw malformed(this.name);
      const selected = searched.data.results[0];
      if (selected === undefined) return typed({ library: null, content: '' });

      const contextUrl = new URL('/api/v2/context', this.baseUrl);
      contextUrl.searchParams.set('libraryId', selected.id);
      contextUrl.searchParams.set('query', request.query);
      contextUrl.searchParams.set('type', 'json');
      const contextResponse = await this.options.transport.send<unknown>({
        url: contextUrl.toString(), method: 'GET', headers: this.headers, response_type: 'json',
        max_response_bytes: MAX_RESPONSE_BYTES, signal: request.signal,
      });
      assertStatus(contextResponse.status, this.name, contextResponse.headers, this.options.clock);
      assertNoBusinessError(contextResponse.body, this.name);
      const parsed = contextSchema.safeParse(contextResponse.body);
      if (!parsed.success) throw malformed(this.name);
      const sources = projectSources(parsed.data);
      return typed({
        library: { id: selected.id, title: selected.title.trim(), description: selected.description.trim() },
        content: renderContext(parsed.data),
        ...(sources.length === 0 ? {} : { sources }),
      });
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name);
    }
  }
}

function renderContext(value: z.infer<typeof contextSchema>): string {
  const sections: string[] = [];
  for (const snippet of value.codeSnippets) {
    const heading = snippet.codeTitle.trim();
    const description = snippet.codeDescription.trim();
    const blocks = snippet.codeList.map((item) => `\`\`\`${item.language.trim()}\n${item.code.trim()}\n\`\`\``).join('\n\n');
    sections.push([heading === '' ? '' : `### ${heading}`, description, blocks].filter(Boolean).join('\n\n'));
  }
  for (const snippet of value.infoSnippets) {
    const heading = snippet.breadcrumb?.trim() ?? '';
    sections.push([heading === '' ? '' : `### ${heading}`, snippet.content.trim()].filter(Boolean).join('\n\n'));
  }
  return sections.filter(Boolean).join('\n\n---\n\n');
}

function projectSources(value: z.infer<typeof contextSchema>): Array<{ url: string; title?: string }> {
  const sources: Array<{ url: string; title?: string }> = [];
  const seen = new Set<string>();
  const add = (candidate: string | undefined, title: string | undefined): void => {
    if (candidate === undefined) return;
    const url = normalizeUrl(candidate);
    if (url === undefined || seen.has(url)) return;
    seen.add(url);
    const normalizedTitle = title?.replace(/\s+/gu, ' ').trim();
    sources.push({ url, ...(normalizedTitle === undefined || normalizedTitle === '' ? {} : { title: normalizedTitle }) });
  };
  for (const snippet of value.codeSnippets) add(snippet.codeId, snippet.codeTitle);
  for (const snippet of value.infoSnippets) add(snippet.pageId, snippet.breadcrumb);
  return sources;
}

function typed(data: JsonValue): QueryProviderValue { return { channel: 'typed', data }; }
function resolveBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new NbSearchError('CONFIGURATION_ERROR', 'Context7 base URL must be an HTTP(S) URL.'); }
  if ((url.protocol !== 'https:' && url.protocol !== 'http:') || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== '') throw new NbSearchError('CONFIGURATION_ERROR', 'Context7 base URL must be an HTTP(S) URL without user info, query, or fragment.');
  url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
function assertNoBusinessError(body: unknown, provider: string): void {
  if (!isRecord(body)) return;
  const error = typeof body['error'] === 'string' ? body['error'].trim() : '';
  if (error !== '') throw new NbSearchError('PROVIDER_UNAVAILABLE', `${provider} request was rejected by the upstream service.`, false, provider);
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
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined { return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function parseRetryAfter(value: string | undefined, clock: Date): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock.getTime()) : undefined;
}
