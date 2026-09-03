import { z } from 'zod';

import { NbSearchError } from '../errors.ts';
import { ResponseLimitError, type JsonTransport } from '../transport.ts';
import type { ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';

export const GITHUB_REPOSITORY_SEARCH_URL = 'https://api.github.com/search/repositories';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const itemSchema = z.object({
  full_name: z.string(),
  html_url: z.string(),
  description: z.string().nullable(),
  updated_at: z.string(),
}).passthrough();
const responseSchema = z.object({ items: z.array(itemSchema) }).passthrough();

export interface GitHubProviderOptions {
  token?: string;
  transport: JsonTransport;
  clock?: () => Date;
}

export class GitHubRepositoriesProvider implements SearchProvider {
  readonly name = 'github' as const;
  readonly redactions: readonly string[];
  private readonly headers: Readonly<Record<string, string>>;

  constructor(private readonly options: GitHubProviderOptions) {
    const authorization = options.token === undefined ? undefined : `Bearer ${options.token}`;
    this.headers = {
      Accept: 'application/vnd.github+json',
      ...(authorization === undefined ? {} : { Authorization: authorization }),
    };
    this.redactions = options.token === undefined ? [] : [options.token, authorization!];
  }

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const url = new URL(GITHUB_REPOSITORY_SEARCH_URL);
      url.searchParams.set('q', request.query);
      const response = await this.options.transport.send<unknown>({
        url: url.toString(), method: 'GET', headers: this.headers, response_type: 'json',
        max_response_bytes: MAX_RESPONSE_BYTES, signal: request.signal,
      });
      assertStatus(response.status, this.name, response.headers, this.options.clock);
      const parsed = responseSchema.safeParse(response.body);
      if (!parsed.success) throw malformed(this.name);
      const results: ProviderResult[] = [];
      for (const item of parsed.data.items) {
        const normalized = normalizeUrl(item.html_url);
        if (normalized === undefined) continue;
        const snippet = item.description?.replace(/\s+/gu, ' ').trim() ?? '';
        const publishedAt = item.updated_at.trim();
        results.push({
          title: item.full_name.replace(/\s+/gu, ' ').trim(),
          url: normalized,
          ...(snippet === '' ? {} : { snippet }),
          ...(publishedAt === '' ? {} : { published_at: publishedAt }),
        });
        if (results.length >= request.limit) break;
      }
      return results;
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw safeProviderError(error, this.name);
    }
  }
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
function header(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined { return Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)?.[1]; }
function parseRetryAfter(value: string | undefined, clock: Date): number | undefined {
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const at = Date.parse(value);
  return Number.isFinite(at) ? Math.max(0, at - clock.getTime()) : undefined;
}
