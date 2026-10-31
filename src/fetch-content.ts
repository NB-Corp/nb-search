import { Defuddle } from 'defuddle/node';
import { parseHTML } from 'linkedom';
import { NbSearchError } from './errors.ts';
import type { FetchRepresentation, FetchWarning } from './types.ts';

export async function extractHtml(value: string, finalUrl: string | undefined, representation: FetchRepresentation): Promise<{ content: string; title?: string }> {
  const { document } = parseHTML(/<html\b/i.test(value) ? value : `<html><head></head><body>${value}</body></html>`);
  if (document.querySelector('form input[type="password"], form#challenge-form, #cf-challenge-running, iframe[src*="challenges.cloudflare.com"]') !== null) throw new NbSearchError('FETCH_BLOCKED', 'The response requires authentication or a browser challenge.', false, undefined, { data: { reason: 'authentication_or_challenge' } });
  document.querySelectorAll('script,iframe,object,embed').forEach((node) => node.remove());
  const result = await Defuddle(document as unknown as Document, finalUrl, { markdown: representation === 'markdown', useAsync: false, includeReplies: 'extractors' });
  const content = representation === 'markdown' ? result.content : extractedHtmlText(result.content, finalUrl);
  if (content.trim() === '') throw new NbSearchError('QUALITY_GATE_FAILED', 'HTML has no extractable document body.', false, undefined, { data: { reason: 'empty' } });
  return { content, ...(result.title?.trim() ? { title: result.title.trim() } : {}) };
}
function extractedHtmlText(html: string, finalUrl: string | undefined): string {
  const { document } = parseHTML(`<html><body>${html}</body></html>`);
  for (const anchor of document.querySelectorAll('a[href]')) { const href = anchor.getAttribute('href')!; try { const url = new URL(href, finalUrl); if (['http:', 'https:'].includes(url.protocol)) anchor.append(` (${url.toString()})`); } catch {} }
  for (const node of document.querySelectorAll('p,div,section,article,li,h1,h2,h3,h4,h5,h6,tr,blockquote,pre,br')) { node.prepend('\n'); node.append('\n'); }
  return document.body.textContent?.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n').trim() ?? '';
}
export function projectJson(value: string, url: URL, truncated: boolean, maximumBytes: number, representation: FetchRepresentation): { content: string; warnings: FetchWarning[] } {
  if (truncated) return { content: value, warnings: [{ code: 'JSON_INCOMPLETE', message: 'The byte-limited response is incomplete JSON; fields and file content have not been decoded.' }] };
  let json: unknown;
  try { json = JSON.parse(value); } catch { throw new NbSearchError('QUALITY_GATE_FAILED', 'The response is not valid JSON.', false, undefined, { data: { reason: 'invalid_json' } }); }
  if (url.origin === 'https://api.github.com' && isRecord(json) && typeof json['message'] === 'string' && !('id' in json) && !('type' in json)) throw new NbSearchError('FETCH_HTTP_ERROR', 'GitHub returned an API error instead of repository information.', false, undefined, { data: { reason: 'api_error' } });
  const warnings: FetchWarning[] = [];
  if (url.origin === 'https://api.github.com' && /^\/repos\/[^/]+\/[^/]+\/(contents(?:\/.*)?|readme)$/.test(url.pathname)) {
    if (Array.isArray(json)) { if (json.length >= 1000) warnings.push({ code: 'GITHUB_DIRECTORY_LIMIT', message: 'GitHub directory responses have a 1000-entry limit; this directory may be incomplete.' }); }
    else if (isRecord(json) && json['type'] === 'file') {
      if (json['encoding'] !== 'base64' || typeof json['content'] !== 'string') {
        warnings.push({ code: 'GITHUB_CONTENT_UNAVAILABLE', message: 'This response does not contain decodable file content; use its download_url explicitly if appropriate. No additional download was made.' });
      } else {
        const encoded = json['content'].replace(/\s/g, '');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded) throw new NbSearchError('QUALITY_GATE_FAILED', 'GitHub file content is not valid base64.', false, undefined, { data: { reason: 'invalid_base64' } });
        if (bytes.length > maximumBytes) throw new NbSearchError('FETCH_BYTES_LIMIT', 'Decoded GitHub file content exceeds the source byte limit.');
        let text: string;
        try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'GitHub file content is not UTF-8 text.'); }
        if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'GitHub file content is binary, not readable text.');
        const metadata = { ...json }; delete metadata['content']; delete metadata['encoding'];
        const source = JSON.stringify(metadata, null, 2);
        const path = typeof json['path'] === 'string' ? json['path'] : '';
        const markdown = /\.(md|markdown)$/i.test(path);
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map((match) => match[0].length + 1)));
        return { content: representation === 'text' || markdown ? `${source}\n\n${text}` : `${source}\n\n${fence}\n${text}\n${fence}`, warnings };
      }
    }
  }
  return { content: JSON.stringify(json, null, 2), warnings };
}
function isRecord(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
