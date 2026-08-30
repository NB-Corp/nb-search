import { NbSearchError } from './errors.ts';

export const RELAY_RESPONSE_MAX_BYTES = 1_048_576;
export const RELAY_CONTENT_MAX_BYTES = 262_144;

export function parseRelayChatContent(
  body: string,
  headers: Readonly<Record<string, string>> | undefined,
  provider: string,
): string {
  if (body.length === 0 || Buffer.byteLength(body, 'utf8') > RELAY_RESPONSE_MAX_BYTES) {
    throw relayMalformed(provider, Buffer.byteLength(body, 'utf8') > RELAY_RESPONSE_MAX_BYTES);
  }
  const trimmed = body.trim();
  const contentType = headerValue(headers, 'content-type')?.toLowerCase() ?? '';
  const content = contentType.includes('text/event-stream') || trimmed.startsWith('data:') || trimmed.startsWith('event:')
    ? parseSseContent(body, provider)
    : contentFromEnvelope(parseJson(body, provider));
  if (content === '' || Buffer.byteLength(content, 'utf8') > RELAY_CONTENT_MAX_BYTES) {
    throw relayMalformed(provider, Buffer.byteLength(content, 'utf8') > RELAY_CONTENT_MAX_BYTES);
  }
  return content;
}

export function parseRelayAssistantObject(content: string, provider: string): Record<string, unknown> {
  let normalized = content.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  if (normalized.startsWith('```')) {
    const opening = normalized.match(/^```(?:json)?[ \t]*(?:\r?\n)?/);
    if (opening !== null) {
      normalized = normalized.slice(opening[0].length).replace(/```\s*$/, '');
    }
  }
  normalized = normalized.trim();
  const start = normalized.indexOf('{');
  if (start < 0) throw relayMalformed(provider);
  const end = matchingJsonBrace(normalized, start);
  if (end < 0) throw relayMalformed(provider);
  const parsed = parseJson(normalized.slice(start, end + 1), provider);
  if (!isRecord(parsed)) throw relayMalformed(provider);
  return parsed;
}

function parseSseContent(body: string, provider: string): string {
  const events: string[][] = [];
  let current: string[] = [];
  const flush = (): void => { if (current.length > 0) events.push(current); current = []; };
  for (const rawLine of body.replace(/\r\n?/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line === '') { flush(); continue; }
    if (line.startsWith(':')) continue;
    if (line.startsWith('data:')) current.push(line.slice(5).replace(/^ /, ''));
  }
  flush();
  let content = '';
  let sawPayload = false;
  for (const lines of events) {
    const payload = lines.join('\n');
    if (payload === '[DONE]') break;
    let parsed: unknown;
    try { parsed = JSON.parse(payload) as unknown; } catch { continue; }
    sawPayload = true;
    const part = contentFromEnvelope(parsed, true);
    if (part === '') continue;
    content += part;
    if (Buffer.byteLength(content, 'utf8') > RELAY_CONTENT_MAX_BYTES) throw relayMalformed(provider, true);
  }
  if (!sawPayload || content === '') throw relayMalformed(provider);
  return content;
}

function contentFromEnvelope(value: unknown, sse = false): string {
  if (!isRecord(value) || !Array.isArray(value['choices']) || value['choices'].length === 0) return '';
  const choice = value['choices'].find(isRecord);
  if (choice === undefined) return '';
  if (sse) {
    const delta = isRecord(choice['delta']) ? coerceContent(choice['delta']['content']) : '';
    if (delta !== '') return delta;
  }
  const message = isRecord(choice['message']) ? coerceContent(choice['message']['content']) : '';
  if (message !== '') return message;
  return coerceContent(choice['text']);
}

function coerceContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return '';
  return value.flatMap((item): string[] => {
    if (typeof item === 'string') return [item];
    if (isRecord(item) && typeof item['text'] === 'string') return [item['text']];
    return [];
  }).join(' ');
}

function parseJson(value: string, provider: string): unknown {
  try { return JSON.parse(value) as unknown; } catch { throw relayMalformed(provider); }
}

function matchingJsonBrace(value: string, start: number): number {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{') depth += 1;
    else if (char === '}' && --depth === 0) return index;
  }
  return -1;
}

function relayMalformed(provider: string, overLimit = false): NbSearchError {
  return new NbSearchError(
    'PROVIDER_UNAVAILABLE',
    overLimit ? `${provider} response exceeded the relay content limit.` : `${provider} returned malformed relay content.`,
    !overLimit,
    provider,
  );
}

function headerValue(headers: Readonly<Record<string, string>> | undefined, name: string): string | undefined {
  if (headers === undefined) return undefined;
  const direct = headers[name];
  if (direct !== undefined) return direct;
  return Object.entries(headers).find(([key]) => key.toLowerCase() === name)?.[1];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
