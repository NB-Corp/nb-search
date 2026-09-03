import { z } from 'zod';

import { resolveOperationUrl } from '../providers.ts';
import type { HttpTransport } from '../transport.ts';
import type { CredentialSlotId, ProviderInstanceId, ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { assertSearchStatus, malformedSearchResponse, normalizedText, SEARCH_RESPONSE_MAX_BYTES, searchProviderError } from './search-adapter.ts';

const firecrawlEnvelopeSchema = z.object({
  success: z.literal(true),
  data: z.object({ web: z.array(z.unknown()) }).passthrough(),
}).passthrough();
const firecrawlResultSchema = z.object({
  title: z.string().optional(),
  url: z.string(),
  description: z.string().optional(),
  snippet: z.string().optional(),
}).passthrough();

export interface FirecrawlSearchProviderOptions {
  apiKey: string;
  transport: HttpTransport;
  baseUrl?: string;
  providerInstanceId?: ProviderInstanceId;
  credentialSlotId?: CredentialSlotId;
  clock?: () => Date;
}

export class FirecrawlSearchProvider implements SearchProvider {
  readonly name = 'firecrawl' as const;
  readonly provider_id = 'firecrawl' as const;
  readonly provider_instance_id: string;
  readonly credential_slot_id?: string;
  readonly redactions: readonly string[];
  private readonly endpoint: string;
  private readonly authorization: string;

  constructor(private readonly options: FirecrawlSearchProviderOptions) {
    this.provider_instance_id = options.providerInstanceId ?? 'firecrawl.default';
    this.credential_slot_id = options.credentialSlotId;
    this.endpoint = resolveOperationUrl(options.baseUrl ?? 'https://api.firecrawl.dev', '/v2/search');
    this.authorization = `Bearer ${options.apiKey}`;
    this.redactions = [options.apiKey, this.authorization, this.endpoint];
  }

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const response = await this.options.transport.send<unknown>({
        url: this.endpoint,
        method: 'POST',
        headers: { Authorization: this.authorization, 'Content-Type': 'application/json' },
        body: { query: request.query, limit: request.limit, sources: ['web'] },
        response_type: 'json',
        max_response_bytes: SEARCH_RESPONSE_MAX_BYTES,
        signal: request.signal,
      });
      assertSearchStatus(response.status, this.name, response.headers, this.options.clock);
      const parsed = firecrawlEnvelopeSchema.safeParse(response.body);
      if (!parsed.success) throw malformedSearchResponse(this.name, parsed.error);
      return projectResults(parsed.data.data.web, request.limit);
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw searchProviderError(error, this.name, this.redactions);
    }
  }
}

function projectResults(rows: readonly unknown[], limit: number): ProviderResult[] {
  const results: ProviderResult[] = [];
  for (const row of rows.slice(0, 100)) {
    const parsed = firecrawlResultSchema.safeParse(row);
    if (!parsed.success) continue;
    const url = normalizedText(parsed.data.url);
    if (normalizeUrl(url) === undefined) continue;
    results.push({
      title: normalizedText(parsed.data.title),
      url,
      snippet: normalizedText(parsed.data.description ?? parsed.data.snippet),
    });
    if (results.length >= limit) break;
  }
  return results;
}
