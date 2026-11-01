// Direct acquisition changes mechanically recovered from accepted next.7 app-xlqMoSP5.mjs:3626–3755.
import { isIP } from 'node:net';
import { NbSearchError } from './errors.ts';
import { canonicalFetchUrl } from './fetch-routing-contracts.ts';
import { extractHtml, projectJson } from './fetch-content.ts';
import { acquireDirect, type DirectFetchIo } from './direct-acquisition.ts';
import { isSafeIpAddress } from './vendor/guarded-fetch/index.ts';
import type { FetchProvider, FetchProviderRequest, FetchProviderResult, FetchWarning, ProviderName } from './types.ts';
export type { DirectFetchIo } from './direct-acquisition.ts';
export { isSafeIpAddress as isPublicAddress } from './vendor/guarded-fetch/index.ts';

export class DirectFetchProvider implements FetchProvider {
  constructor(private readonly io: DirectFetchIo = {}, readonly name: ProviderName = 'direct-http') {}
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    try {
      if (request.source.kind !== 'url') throw new NbSearchError('FETCH_PIPELINE_UNSUPPORTED', 'The direct HTTP pipeline accepts URL input only.');
      const response = await acquireDirect(parsePublicUrl(request.source.url, this.name), request, this.io, this.name);
      if (response.status < 200 || response.status >= 300) throw new NbSearchError('FETCH_HTTP_ERROR', `HTTP fetch failed with status ${String(response.status)}.`, response.status >= 500, this.name, { data: { status: response.status } });
      const contentType = mediaType(response.headers['content-type']);
      if (contentType === undefined || !TEXT_TYPES.has(contentType)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The response content type is not allowed.', false, this.name);
      let decoded: string;
      try { decoded = new TextDecoder('utf-8', { fatal: !response.truncated }).decode(response.body); } catch { throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The response is not valid UTF-8 text.', false, this.name); }
      if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(decoded)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The response contains binary data.', false, this.name);
      const current = new URL(response.final_url);
      const json = contentType === 'application/json' || contentType === 'application/ld+json' ? projectJson(decoded, current, response.truncated, request.max_source_bytes, request.representation) : undefined;
      const projected: { content: string; title?: string } = contentType === 'text/html' || contentType === 'application/xhtml+xml' ? await extractHtml(decoded, current.toString(), request.representation) : json ?? { content: decoded.replace(/\r\n?/g, '\n') };
      const maximumChars = Math.min(request.max_content_chars, Number.MAX_SAFE_INTEGER);
      const charTruncated = projected.content.length > maximumChars;
      const content = charTruncated ? projected.content.slice(0, maximumChars) : projected.content;
      const warnings: FetchWarning[] = [...json?.warnings ?? []];
      if (response.headers['link']?.includes('rel="next"')) warnings.push({ code: 'FETCH_PAGINATED', message: 'Only this response page was fetched; more pages are available.' });
      if (decoded.startsWith('version https://git-lfs.github.com/spec/v1\n')) warnings.push({ code: 'GIT_LFS_POINTER', message: 'This is a Git LFS pointer, not the referenced file content. No additional download was made.' });
      if (content.trim() === '') warnings.push({ code: 'EMPTY_CONTENT', message: 'The response contains no readable text.' });
      if (response.truncated) warnings.push({ code: 'FETCH_BYTES_LIMIT', message: 'The response byte limit was reached.', data: { max_response_bytes: request.max_response_bytes } });
      if (charTruncated) warnings.push({ code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'The content character limit was reached.', data: { max_content_chars: maximumChars } });
      return { url: request.source.url, final_url: response.final_url, title: projected.title, content, content_type: contentType, media_type: contentType, representation: request.representation, format: 'text', byte_length: response.body.byteLength, truncated: response.truncated || charTruncated, warnings };
    } catch (error) {
      if (error instanceof NbSearchError || request.signal.aborted) throw error;
      throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Direct HTTP fetch failed.', true, this.name, { cause: error });
    }
  }
}
const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/json', 'application/ld+json', 'application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml']);
export function parsePublicUrl(value: string, provider: ProviderName = 'direct-http'): URL {
  let url: URL;
  try { url = canonicalFetchUrl(value); } catch { throw blocked('Fetch URL is invalid.', provider); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.password !== '') throw blocked('Only credential-free HTTP(S) URLs are allowed.', provider);
  if (isIP(url.hostname.replace(/^\[|\]$/g, '')) !== 0 && !isSafeIpAddress(url.hostname.replace(/^\[|\]$/g, ''))) throw blocked('Target address is not public.', provider);
  return url;
}
export function htmlToText(value: string): { content: string; title?: string } {
  const withoutHidden = value.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutHidden);
  const title = titleMatch?.[1] === undefined ? undefined : normalizeText(decodeEntities(titleMatch[1]));
  return { content: normalizeText(decodeEntities(withoutHidden.replace(/<(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|tr|table|blockquote)\b[^>]*>/gi, '\n').replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ').replace(/<[^>]+>/g, ' '))), ...(title === undefined || title === '' ? {} : { title }) };
}
function normalizeText(value: string): string { return value.replace(/\r\n?/g, '\n').replace(/[\t\f\v ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim() }
function decodeEntities(value: string): string {
  const named: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_match, entity: string) => {
    if (entity.startsWith('#')) {
      const point = Number.parseInt(entity.startsWith('#x') ? entity.slice(2) : entity.slice(1), entity.startsWith('#x') ? 16 : 10);
      return point <= 0x10ffff && (point < 0xd800 || point > 0xdfff) ? String.fromCodePoint(point) : '�';
    }
    return named[entity.toLowerCase()] ?? '';
  });
}
function mediaType(value: string | undefined): string | undefined { const item = value?.split(';')[0]?.trim().toLowerCase(); return item === '' ? undefined : item }
function blocked(message: string, provider: ProviderName): NbSearchError { return new NbSearchError('FETCH_BLOCKED', message, false, provider) }
