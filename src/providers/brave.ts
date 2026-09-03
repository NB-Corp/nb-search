import { z } from 'zod';

import { NbSearchError } from '../errors.ts';
import { resolveOperationUrl } from '../providers.ts';
import type { HttpTransport } from '../transport.ts';
import type { CredentialSlotId, ProviderInstanceId, ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { assertSearchStatus, malformedSearchResponse, normalizedText, SEARCH_RESPONSE_MAX_BYTES, searchProviderError } from './search-adapter.ts';

const braveEnvelopeSchema = z.object({
  web: z.object({ results: z.array(z.unknown()) }).passthrough().optional(),
}).passthrough();
const braveResultSchema = z.object({
  title: z.string().optional(),
  url: z.string(),
  description: z.string().optional(),
  age: z.string().optional(),
}).passthrough();

export interface BraveSearchProviderOptions {
  apiKey: string;
  transport: HttpTransport;
  baseUrl?: string;
  providerInstanceId?: ProviderInstanceId;
  credentialSlotId?: CredentialSlotId;
  clock?: () => Date;
}

export class BraveSearchProvider implements SearchProvider {
  readonly name = 'brave' as const;
  readonly provider_id = 'brave' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;

  constructor(private readonly options: BraveSearchProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'brave.default';
    this.credential_slot_id = options.credentialSlotId;
    this.endpoint = resolveOperationUrl(options.baseUrl ?? 'https://api.search.brave.com', '/res/v1/web/search');
    this.redactions = [options.apiKey, this.endpoint];
  }

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      validateBraveQuery(request.query);
      const endpoint = new URL(this.endpoint);
      endpoint.searchParams.set('q', request.query);
      endpoint.searchParams.set('count', String(Math.min(request.limit, 20)));
      const response = await this.options.transport.send<unknown>({
        url: endpoint.toString(),
        method: 'GET',
        headers: { Accept: 'application/json', 'X-Subscription-Token': this.options.apiKey },
        response_type: 'json',
        max_response_bytes: SEARCH_RESPONSE_MAX_BYTES,
        signal: request.signal,
      });
      assertSearchStatus(response.status, this.name, response.headers, this.options.clock);
      const parsed = braveEnvelopeSchema.safeParse(response.body);
      if (!parsed.success) throw malformedSearchResponse(this.name, parsed.error);
      return projectResults(parsed.data.web?.results ?? [], request.limit);
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw searchProviderError(error, this.name, this.redactions);
    }
  }
}

function validateBraveQuery(query: string): void {
  const characters = [...query].length;
  const words = query.trim().split(/\s+/u).length;
  if (characters <= 400 && words <= 50) return;
  throw new NbSearchError('INVALID_INPUT', 'Brave search query exceeds the upstream limit.', false, 'brave', {
    data: { characters, words, max_characters: 400, max_words: 50 },
  });
}

function projectResults(rows: readonly unknown[], limit: number): ProviderResult[] {
  const results: ProviderResult[] = [];
  for (const row of rows.slice(0, 100)) {
    const parsed = braveResultSchema.safeParse(row);
    if (!parsed.success) continue;
    const url = normalizedText(parsed.data.url);
    if (normalizeUrl(url) === undefined) continue;
    const published = normalizedText(parsed.data.age);
    results.push({
      title: normalizedText(parsed.data.title),
      url,
      snippet: normalizedText(parsed.data.description),
      ...(published === '' ? {} : { published_at: published }),
    });
    if (results.length >= limit) break;
  }
  return results;
}
