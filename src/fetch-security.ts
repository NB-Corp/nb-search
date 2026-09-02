import { lookup } from 'node:dns/promises';
import { request as httpRequest, type RequestOptions } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { NbSearchError } from './errors.ts';
import type { FetchProvider, FetchProviderRequest, FetchProviderResult, FetchWarning } from './types.ts';

export interface DirectFetchIo {
  resolve(hostname: string): Promise<readonly string[]>;
  request(input: { url: URL; address: string; signal: AbortSignal; max_response_bytes: number }): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array; truncated: boolean }>;
}

export class DirectFetchProvider implements FetchProvider {
  readonly name = 'direct-http';
  constructor(private readonly io: DirectFetchIo = nodeDirectFetchIo) {}

  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    const original = parsePublicUrl(request.url);
    let current = original;
    for (let redirects = 0; ; redirects += 1) {
      const addresses = await this.io.resolve(current.hostname);
      if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) throw blocked('Target resolved to a non-public address.');
      const address = addresses[0]!;
      const response = await this.io.request({ url: current, address, signal: request.signal, max_response_bytes: request.max_response_bytes });
      const location = response.headers['location'];
      if (response.status >= 300 && response.status < 400 && location !== undefined) {
        if (redirects >= request.max_redirects) {
          return {
            url: request.url, final_url: current.toString(), content: '', content_type: mediaType(response.headers['content-type']) ?? 'text/plain',
            format: 'text', byte_length: response.body.byteLength, truncated: true,
            warnings: [{ code: 'FETCH_REDIRECT_LIMIT', message: 'The redirect limit was reached.', data: { max_redirects: request.max_redirects } }],
          };
        }
        current = parsePublicUrl(new URL(location, current).toString());
        continue;
      }
      if (response.status < 200 || response.status >= 300) throw new NbSearchError('PROVIDER_UNAVAILABLE', `HTTP fetch failed with status ${String(response.status)}.`, response.status >= 500, this.name);
      const contentType = mediaType(response.headers['content-type']);
      if (contentType === undefined || !TEXT_TYPES.has(contentType)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The response content type is not allowed.', false, this.name);
      const decoded = new TextDecoder('utf-8', { fatal: false }).decode(response.body);
      const projected = contentType === 'text/html' || contentType === 'application/xhtml+xml' ? htmlToText(decoded) : { content: normalizeText(decoded), title: undefined };
      const maximumChars = Math.min(request.max_content_chars, Number.MAX_SAFE_INTEGER);
      const charTruncated = projected.content.length > maximumChars;
      const content = charTruncated ? projected.content.slice(0, maximumChars) : projected.content;
      const warnings: FetchWarning[] = [];
      if (response.truncated) warnings.push({ code: 'FETCH_BYTES_LIMIT', message: 'The response byte limit was reached.', data: { max_response_bytes: request.max_response_bytes } });
      if (charTruncated) warnings.push({ code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'The content character limit was reached.', data: { max_content_chars: maximumChars } });
      return {
        url: request.url, final_url: current.toString(), ...(projected.title === undefined ? {} : { title: projected.title }),
        content, content_type: contentType, format: 'text', byte_length: response.body.byteLength,
        truncated: response.truncated || charTruncated, warnings,
      };
    }
  }
}

export interface TestOnlyNodeDirectFetchIoOptions {
  resolve(hostname: string): Promise<readonly string[]>;
  test_connect_address(url: URL, validatedAddress: string): string;
}
export function createTestOnlyNodeDirectFetchIo(options: TestOnlyNodeDirectFetchIoOptions): DirectFetchIo {
  return { resolve: options.resolve, async request(input) { return await requestWithNode(input, options.test_connect_address(input.url, input.address)); } };
}
export const nodeDirectFetchIo: DirectFetchIo = {
  async resolve(hostname) { return (await lookup(hostname, { all: true, verbatim: true })).map((item) => item.address); },
  async request(input) { return await requestWithNode(input, input.address); },
};
async function requestWithNode(input: { url: URL; address: string; signal: AbortSignal; max_response_bytes: number }, connectAddress: string): Promise<{ status: number; headers: Readonly<Record<string, string>>; body: Uint8Array; truncated: boolean }> {
  return await new Promise((resolve, reject) => {
    const requestOptions: RequestOptions = {
      protocol: input.url.protocol, host: connectAddress, port: input.url.port === '' ? undefined : Number(input.url.port),
      method: 'GET', path: `${input.url.pathname}${input.url.search}`,
      headers: { Host: input.url.host, Accept: 'text/html,text/plain,application/json,application/xml,text/xml,text/markdown,application/xhtml+xml', 'Accept-Encoding': 'identity', 'User-Agent': 'nb-search/0.1 direct.fetch' },
      ...(input.url.protocol === 'https:' ? { servername: input.url.hostname } : {}),
    };
    const perform = input.url.protocol === 'https:' ? httpsRequest : httpRequest;
    const client = perform(requestOptions, (response) => {
      const headers: Record<string, string> = {};
      for (const [key, value] of Object.entries(response.headers)) if (typeof value === 'string') headers[key.toLowerCase()] = value;
      else if (Array.isArray(value)) headers[key.toLowerCase()] = value.join(', ');
      const chunks: Buffer[] = [];
      let bytes = 0;
      let truncated = false;
      response.on('data', (chunk: Buffer) => {
        if (truncated) return;
        const remaining = input.max_response_bytes - bytes;
        if (chunk.byteLength > remaining) {
          if (remaining > 0) chunks.push(chunk.subarray(0, remaining));
          bytes += Math.max(0, remaining); truncated = true; response.destroy(); return;
        }
        chunks.push(chunk); bytes += chunk.byteLength;
      });
      const complete = (): void => resolve({ status: response.statusCode ?? 0, headers, body: Buffer.concat(chunks, bytes), truncated });
      response.once('end', complete);
      response.once('close', () => { if (truncated) complete(); });
      response.once('error', (error) => { if (!truncated) reject(error); });
    });
    const abort = (): void => { client.destroy(input.signal.reason instanceof Error ? input.signal.reason : new NbSearchError('CANCELLED', 'Fetch was cancelled.')); };
    input.signal.addEventListener('abort', abort, { once: true });
    client.once('error', reject);
    client.once('close', () => input.signal.removeEventListener('abort', abort));
    client.end();
  });
}

const TEXT_TYPES = new Set(['text/html', 'application/xhtml+xml', 'text/plain', 'text/markdown', 'text/x-markdown', 'application/json', 'application/ld+json', 'application/xml', 'text/xml', 'application/rss+xml', 'application/atom+xml']);
const METADATA_HOSTS = new Set(['localhost', 'localhost.localdomain', 'metadata', 'metadata.google.internal', 'instance-data', 'instance-data.ec2.internal']);

export function parsePublicUrl(value: string): URL {
  let url: URL;
  try { url = new URL(value); } catch { throw blocked('Fetch URL is invalid.'); }
  if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.hostname === '' || url.username !== '' || url.password !== '') throw blocked('Only credential-free HTTP(S) URLs are allowed.');
  const hostname = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (METADATA_HOSTS.has(hostname) || hostname.endsWith('.localhost') || hostname.endsWith('.local')) throw blocked('Target host is blocked.');
  if (isIP(hostname) !== 0 && !isPublicAddress(hostname)) throw blocked('Target address is not public.');
  return url;
}

export function isPublicAddress(address: string): boolean {
  const normalized = address.toLowerCase().split('%')[0]!;
  const family = isIP(normalized);
  if (family === 4) {
    const parts = normalized.split('.').map(Number);
    const a = parts[0]!; const b = parts[1]!; const c = parts[2]!;
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || b === 168 || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family !== 6 || normalized.startsWith('::ffff:')) return false;
  const groups = expandIpv6(normalized);
  const first = groups[0]!;
  if (groups.every((item) => item === 0) || groups.slice(0, 7).every((item) => item === 0) && groups[7] === 1) return false;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return false;
  if (first < 0x2000 || first > 0x3fff) return false;
  if (first === 0x2001 && (groups[1]! <= 0x01ff || groups[1] === 0x0db8)) return false;
  if (first === 0x2002 || (first === 0x3fff && groups[1]! < 0x1000)) return false;
  return true;
}

export function htmlToText(value: string): { content: string; title?: string } {
  const withoutHidden = value.replace(/<(script|style|noscript|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, ' ');
  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(withoutHidden);
  const title = titleMatch?.[1] === undefined ? undefined : normalizeText(decodeEntities(titleMatch[1]));
  const withBreaks = withoutHidden.replace(/<(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|tr|table|blockquote)\b[^>]*>/gi, '\n').replace(/<\/(?:p|div|section|article|header|footer|main|aside|nav|h[1-6]|li|tr|table|blockquote)>/gi, '\n').replace(/<br\s*\/?>/gi, '\n').replace(/<li\b[^>]*>/gi, '\n- ');
  const content = normalizeText(decodeEntities(withBreaks.replace(/<[^>]+>/g, ' ')));
  return { content, ...(title === undefined || title === '' ? {} : { title }) };
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
function blocked(message: string): NbSearchError { return new NbSearchError('FETCH_BLOCKED', message, false, 'direct-http') }
function expandIpv6(value: string): number[] {
  const [leftRaw, rightRaw] = value.split('::');
  const left = leftRaw === '' ? [] : leftRaw!.split(':').map((item) => Number.parseInt(item, 16));
  const right = rightRaw === undefined || rightRaw === '' ? [] : rightRaw.split(':').map((item) => Number.parseInt(item, 16));
  return rightRaw === undefined ? left : [...left, ...Array.from({ length: 8 - left.length - right.length }, () => 0), ...right];
}
