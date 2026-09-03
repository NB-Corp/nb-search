import { open, realpath, stat, type FileHandle } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { NbSearchError } from './errors.ts';
import { htmlToText } from './fetch-security.ts';
import type { FetchFileScope, FetchProvider, FetchProviderRequest, FetchProviderResult } from './types.ts';

const TEXT_MEDIA_TYPES = ['text/html', 'text/plain', 'text/markdown'] as const;
interface FileIdentity { dev: number; ino: number; size: number; isFile(): boolean }
interface OpenFile { stat(): Promise<FileIdentity>; read(buffer: Uint8Array, offset: number, length: number, position: number | null): Promise<{ bytesRead: number }>; close(): Promise<void> }
export interface LocalFetchFileIo { realpath(path: string): Promise<string>; stat(path: string): Promise<FileIdentity>; open(path: string): Promise<OpenFile> }
const nodeFileIo: LocalFetchFileIo = { realpath, stat, async open(path) { return await open(path, 'r') as FileHandle; } };
export class LocalFetchProvider implements FetchProvider {
  readonly name = 'local-reader';
  constructor(private readonly fileIo: LocalFetchFileIo = nodeFileIo) {}
  async fetch(request: FetchProviderRequest): Promise<FetchProviderResult> {
    const acquired = await acquireLocalSource(request, this.fileIo);
    const baseUrl = request.source.kind === 'inline_text' ? request.source.base_url : undefined;
    const converted = acquired.media_type === 'text/html' ? htmlToDocument(acquired.content, baseUrl, request.representation) : { content: acquired.content };
    const truncated = converted.content.length > request.max_content_chars;
    const content = truncated ? converted.content.slice(0, request.max_content_chars) : converted.content;
    return {
      ...(acquired.title === undefined ? {} : { title: acquired.title }), content, content_type: acquired.media_type, media_type: acquired.media_type,
      representation: request.representation, format: 'text', byte_length: acquired.byte_length, truncated,
      warnings: truncated ? [{ code: 'FETCH_CONTENT_CHARS_LIMIT', message: 'The content character limit was reached.', data: { max_content_chars: request.max_content_chars } }] : [],
    };
  }
}
export async function validateLocalSource(source: FetchProviderRequest['source'], scopes: readonly FetchFileScope[], maxBytes: number): Promise<void> {
  if (source.kind === 'url') return;
  if (source.kind === 'inline_text') { assertSize(Buffer.byteLength(source.content, 'utf8'), maxBytes); return; }
  if (source.kind === 'inline_bytes') { const bytes = decodeBase64(source.content_base64); assertSize(bytes.length, maxBytes); assertTextMediaType(source.media_type); assertTextBytes(bytes); return; }
  await readScopedFile(source.scope, source.path, scopes, maxBytes, nodeFileIo);
}
async function acquireLocalSource(request: FetchProviderRequest, fileIo: LocalFetchFileIo): Promise<{ content: string; media_type: string; byte_length: number; title?: string }> {
  const source = request.source;
  if (source.kind === 'url') throw new NbSearchError('FETCH_PIPELINE_UNSUPPORTED', 'The local pipeline does not accept URL input.');
  if (source.kind === 'inline_text') { const byteLength = Buffer.byteLength(source.content, 'utf8'); assertSize(byteLength, request.max_source_bytes); return { content: source.content, media_type: source.media_type, byte_length: byteLength }; }
  if (source.kind === 'inline_bytes') { const bytes = decodeBase64(source.content_base64); assertSize(bytes.length, request.max_source_bytes); assertTextMediaType(source.media_type); return { content: decodeText(bytes), media_type: normalizeMediaType(source.media_type), byte_length: bytes.length, ...(source.filename === undefined ? {} : { title: source.filename }) }; }
  const file = await readScopedFile(source.scope, source.path, request.file_scopes, request.max_source_bytes, fileIo); const mediaType = mediaTypeForFile(source.path, file.bytes); if (file.scope.media_types !== undefined && !file.scope.media_types.includes(mediaType)) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The file media type is not allowed by its scope.'); return { content: decodeText(file.bytes), media_type: mediaType, byte_length: file.bytes.length, title: source.path.replace(/\\/g, '/').split('/').at(-1)! };
}
async function readScopedFile(scopeId: string, path: string, scopes: readonly FetchFileScope[], maxBytes: number, fileIo: LocalFetchFileIo): Promise<{ bytes: Buffer; scope: FetchFileScope }> {
  const scope = scopes.find((item) => item.id === scopeId); if (scope === undefined) throw new NbSearchError('FETCH_SCOPE_NOT_FOUND', `File scope ${scopeId} is not configured.`);
  if (isAbsolute(path)) throw blockedFile(); let root: string; try { root = await fileIo.realpath(resolve(scope.root)); } catch (error) { throw new NbSearchError('FETCH_FILE_BLOCKED', 'The file scope root is unavailable.', false, undefined, { cause: error }); } const candidate = resolve(root, path); assertContained(root, candidate);
  let handle: OpenFile; try { handle = await fileIo.open(candidate); } catch (error) { throw new NbSearchError('FETCH_FILE_BLOCKED', 'The requested file is unavailable.', false, undefined, { cause: error }); }
  try {
    const opened = await handle.stat(); if (!opened.isFile()) throw blockedFile(); assertSize(opened.size, maxBytes);
    let canonical: string; try { canonical = await fileIo.realpath(candidate); } catch (error) { throw new NbSearchError('FETCH_FILE_BLOCKED', 'The requested file identity is unavailable.', false, undefined, { cause: error }); } assertContained(root, canonical);
    const current = await fileIo.stat(canonical); if (!current.isFile() || current.dev !== opened.dev || current.ino !== opened.ino) throw blockedFile();
    return { bytes: await readBounded(handle, maxBytes), scope };
  } finally { await handle.close(); }
}
async function readBounded(handle: OpenFile, maximum: number): Promise<Buffer> { const chunks: Buffer[] = []; let total = 0; for (;;) { const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum - total + 1)); const { bytesRead } = await handle.read(buffer, 0, buffer.length, null); if (bytesRead === 0) return Buffer.concat(chunks, total); total += bytesRead; if (total > maximum) throw new NbSearchError('FETCH_BYTES_LIMIT', 'Fetch source exceeded the configured byte limit.', false, undefined, { data: { max_source_bytes: maximum } }); chunks.push(buffer.subarray(0, bytesRead)); } }
function assertContained(root: string, candidate: string): void { const rel = relative(root, candidate); if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw blockedFile(); }
function htmlToDocument(value: string, baseUrl: string | undefined, representation: 'markdown' | 'text'): { content: string; title?: string } { const linked = value.replace(/<a\b[^>]*\bhref\s*=\s*(["'])(.*?)\1[^>]*>([\s\S]*?)<\/a\s*>/gi, (_match, _quote: string, href: string, body: string) => { const text = htmlToText(body).content; let resolved = href; if (baseUrl !== undefined) try { resolved = new URL(href, baseUrl).toString(); } catch {} const protocol = /^([a-z][a-z0-9+.-]*):/i.exec(resolved)?.[1]?.toLowerCase(); if (protocol !== undefined && protocol !== 'http' && protocol !== 'https') return text; return representation === 'markdown' ? `[${text}](${resolved})` : `${text} (${resolved})`; }); return htmlToText(linked); }
function mediaTypeForFile(path: string, bytes: Uint8Array): string { assertTextBytes(bytes); const extension = extname(path).toLowerCase(); const mediaType = extension === '.html' || extension === '.htm' ? 'text/html' : extension === '.md' || extension === '.markdown' ? 'text/markdown' : extension === '.txt' ? 'text/plain' : undefined; if (mediaType === undefined) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The file media type is not supported.'); const prefix = decodeText(bytes.subarray(0, Math.min(bytes.length, 1024))).trimStart().toLowerCase(); const looksHtml = /^<!doctype html\b|^<html\b|^<(?:html|head|body|title|article|main|section|div|p|h[1-6]|table|ul|ol)\b/.test(prefix); if ((mediaType === 'text/html') !== looksHtml && (looksHtml || mediaType === 'text/html')) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The file extension and content media type do not match.'); return mediaType; }
function decodeBase64(value: string): Buffer { const bytes = Buffer.from(value, 'base64'); if (bytes.toString('base64') !== value) throw new NbSearchError('INVALID_INPUT', 'content_base64 is not canonical base64.'); return bytes; }
function assertTextBytes(bytes: Uint8Array): void { decodeText(bytes); }
function decodeText(bytes: Uint8Array): string { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch (error) { throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The source is not valid UTF-8 text.', false, undefined, { cause: error }); } }
function assertTextMediaType(value: string): void { if (!TEXT_MEDIA_TYPES.includes(normalizeMediaType(value) as typeof TEXT_MEDIA_TYPES[number])) throw new NbSearchError('FETCH_CONTENT_TYPE_REJECTED', 'The source media type is not supported.'); }
function normalizeMediaType(value: string): string { return value.split(';')[0]!.trim().toLowerCase(); }
function assertSize(size: number, maximum: number): void { if (size > maximum) throw new NbSearchError('FETCH_BYTES_LIMIT', 'Fetch source exceeded the configured byte limit.', false, undefined, { data: { max_source_bytes: maximum } }); }
function blockedFile(): NbSearchError { return new NbSearchError('FETCH_FILE_BLOCKED', 'The requested file resolves outside its configured scope.'); }
