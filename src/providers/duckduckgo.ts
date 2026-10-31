import { NbSearchError } from '../errors.ts';
import { htmlToText } from '../fetch-security.ts';
import type { HttpTransport } from '../transport.ts';
import type { ProviderResult, ProviderSearchRequest, SearchProvider } from '../types.ts';
import { normalizeUrl } from '../url.ts';
import { assertSearchStatus, searchProviderError } from './search-adapter.ts';

const SEARCH_URL = 'https://html.duckduckgo.com/html/';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const RESULT_ANCHOR = /<a\b([^>]{0,2000})>([\s\S]{0,10000}?)<\/a>/gi;
const SNIPPET = /<(?:a|div)\b[^>]{0,2000}\bclass\s*=\s*(["'])[^"']*\bresult__snippet\b[^"']*\1[^>]*>([\s\S]{0,4000}?)<\/(?:a|div)>/i;

export class DuckDuckGoSearchProvider implements SearchProvider {
  readonly name = 'duckduckgo';
  readonly redactions: readonly string[] = [];

  constructor(private readonly transport: HttpTransport) {}

  async search(request: ProviderSearchRequest): Promise<readonly ProviderResult[]> {
    try {
      const url = new URL(SEARCH_URL);
      url.searchParams.set('q', request.query);
      if (request.freshness !== undefined) url.searchParams.set('df', { pd: 'd', pw: 'w', pm: 'm', py: 'y' }[request.freshness]);
      const response = await this.transport.send<string>({
        url: url.toString(), method: 'GET', response_type: 'text',
        headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 (compatible; nb-search/0.4)' },
        max_response_bytes: MAX_RESPONSE_BYTES, signal: request.signal,
      });
      if (response.status === 429) assertSearchStatus(response.status, this.name, response.headers);
      if (response.status < 200 || response.status >= 300) throw new NbSearchError('PROVIDER_UNAVAILABLE', `DuckDuckGo search failed (HTTP ${String(response.status)}).`, response.status >= 500, this.name, { data: { status: response.status } });
      if (response.status !== 200 || typeof response.body !== 'string' || /<(?:form|div|input)\b[^>]{0,2000}(?:anomaly-modal|challenge-form|captcha)|verify you are human/iu.test(response.body)) throw malformed();
      const matches = [...response.body.matchAll(RESULT_ANCHOR)].filter((match) => /\bresult__a\b|\bresult-link\b/i.test(attribute(match[1] ?? '', 'class') ?? ''));
      const noResults = /class\s*=\s*["'][^"']*\bno-results\b/iu.test(response.body);
      if (matches.length === 0 && !noResults) throw malformed();
      const results: ProviderResult[] = [];
      for (const [index, match] of matches.entries()) {
        const href = attribute(match[1] ?? '', 'href');
        const url = href === undefined ? undefined : resultUrl(href);
        if (url === undefined) continue;
        const title = htmlToText(match[2] ?? '').content;
        if (title === '') continue;
        const end = (match.index ?? 0) + match[0].length;
        const following = response.body.slice(end, Math.min(matches[index + 1]?.index ?? response.body.length, end + 10_000));
        const snippet = htmlToText(SNIPPET.exec(following)?.[2] ?? '').content.replace(/\s+([.,!?;:])/g, '$1');
        results.push({ title, url, ...(snippet === '' ? {} : { snippet }) });
        if (results.length >= request.limit) break;
      }
      if (results.length === 0 && !noResults) throw malformed();
      return results;
    } catch (error) {
      if (request.signal.aborted) throw error;
      throw searchProviderError(error, this.name, this.redactions);
    }
  }
}

function attribute(value: string, name: string): string | undefined {
  const match = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(["'])(.*?)\\1`, 'i').exec(value);
  return match?.[2]?.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"').replace(/&#(?:39|x27);/gi, "'");
}

function resultUrl(value: string): string | undefined {
  const url = normalizeUrl(value.startsWith('//') ? `https:${value}` : value);
  if (url === undefined) return undefined;
  const parsed = new URL(url);
  if ((parsed.hostname === 'duckduckgo.com' || parsed.hostname === 'www.duckduckgo.com') && (parsed.pathname === '/l/' || parsed.pathname === '/l')) {
    const target = parsed.searchParams.get('uddg');
    return target === null ? undefined : normalizeUrl(target);
  }
  return url;
}

function malformed(): NbSearchError { return new NbSearchError('PROVIDER_UNAVAILABLE', 'DuckDuckGo returned an unsupported or challenged search page.', false, 'duckduckgo'); }
