import { NbSearchError } from './errors.ts';

export const RELAY_RESPONSE_MAX_BYTES = 1_048_576;
export const RELAY_CONTENT_MAX_BYTES = 262_144;

export function parseRelayMessagesContent(body: string, headers: Readonly<Record<string, string>> | undefined, provider: string): string {
  if (!body || Buffer.byteLength(body, 'utf8') > RELAY_RESPONSE_MAX_BYTES) throw relayMalformed(provider, !!body);
  if (isSse(body, headers)) return parseSseContent(body, provider, true);
  const envelope = parseJson(body, provider);
  if (!isRecord(envelope) || envelope['error'] != null || !Array.isArray(envelope['content'])) throw relayMalformed(provider);
  assertCompleteReason(envelope['stop_reason'], ['end_turn', 'stop_sequence'], provider);
  let content = '';
  for (const block of envelope['content']) {
    if (!isRecord(block)) throw relayMalformed(provider);
    if (block['type'] !== 'text') continue;
    if (typeof block['text'] !== 'string') throw relayMalformed(provider);
    content += block['text'];
    if (Buffer.byteLength(content, 'utf8') > RELAY_CONTENT_MAX_BYTES) throw relayMalformed(provider, true);
  }
  if (!content.trim()) throw relayMalformed(provider);
  return content;
}

export function parseRelayChatContent(
  body: string,
  headers: Readonly<Record<string, string>> | undefined,
  provider: string,
): string {
  if (body.length === 0 || Buffer.byteLength(body, 'utf8') > RELAY_RESPONSE_MAX_BYTES) {
    throw relayMalformed(provider, Buffer.byteLength(body, 'utf8') > RELAY_RESPONSE_MAX_BYTES);
  }
  let content: string;
  if (isSse(body, headers)) content = parseSseContent(body, provider);
  else {
    const envelope = parseJson(body, provider);
    if (!isRecord(envelope) || envelope['error'] != null) throw relayMalformed(provider);
    if (Array.isArray(envelope['choices'])) for (const choice of envelope['choices']) {
      if (isRecord(choice)) assertCompleteReason(choice['finish_reason'], ['stop'], provider);
    }
    content = contentFromEnvelope(envelope);
  }
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

function isSse(body: string, headers: Readonly<Record<string, string>> | undefined): boolean {
  return (headerValue(headers, 'content-type')?.toLowerCase().includes('text/event-stream') ?? false)
    || /^(?:data:|event:|:)/.test(body.trimStart());
}

// The transport consumes bounded bytes before decoding, so UTF-8 characters split
// across network chunks survive intact. Only complete SSE frames are dispatched.
function sseEvents(body: string, provider: string): Array<{ event: string; data: string }> {
  const events: Array<{ event: string; data: string }> = [];
  let event = ''; let data: string[] = [];
  const lines = body.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').split('\n');
  const tail = lines.pop()!;
  if (tail !== '' && !tail.startsWith(':')) throw relayMalformed(provider);
  for (const line of lines) {
    if (line === '') {
      if (data.length > 0 || event !== '') events.push({ event, data: data.join('\n') });
      event = ''; data = []; continue;
    }
    if (line.startsWith(':')) continue;
    const colon = line.indexOf(':');
    const field = colon < 0 ? line : line.slice(0, colon);
    const value = colon < 0 ? '' : line.slice(colon + 1).replace(/^ /, '');
    if (field === 'data') data.push(value);
    else if (field === 'event') event = value;
  }
  if (data.length > 0 || event !== '') throw relayMalformed(provider);
  return events;
}

function assertCompleteReason(reason: unknown, allowed: readonly string[], provider: string): void {
  if (reason !== undefined && reason !== null && !allowed.includes(String(reason))) throw relayMalformed(provider);
}

function parseSseContent(body: string, provider: string, messages = false): string {
  let content = ''; let finished = false; let stopped = false; let started = false;
  const blocks = new Map<number, string>();
  const append = (text: unknown): void => {
    if (typeof text !== 'string') throw relayMalformed(provider);
    content += text;
    if (Buffer.byteLength(content, 'utf8') > RELAY_CONTENT_MAX_BYTES) throw relayMalformed(provider, true);
  };
  for (const frame of sseEvents(body, provider)) {
    if (/error|incomplete|failed/i.test(frame.event)) throw relayMalformed(provider);
    if (frame.data === '' && (frame.event === 'ping' || frame.event === 'heartbeat')) continue;
    if (frame.data === '[DONE]') {
      if (messages || !stopped || finished) throw relayMalformed(provider);
      finished = true; continue;
    }
    const value = parseJson(frame.data, provider);
    if (!isRecord(value) || value['error'] != null || /error|incomplete|failed/i.test(String(value['type'] ?? ''))) throw relayMalformed(provider);
    if (value['type'] === 'ping' || value['type'] === 'heartbeat') continue;
    if (finished) throw relayMalformed(provider);
    if (!messages) {
      if (!Array.isArray(value['choices'])) throw relayMalformed(provider);
      for (const choice of value['choices']) {
        if (!isRecord(choice)) throw relayMalformed(provider);
        if (choice['index'] !== undefined && choice['index'] !== 0) continue;
        assertCompleteReason(choice['finish_reason'], ['stop'], provider);
        const text = contentFromEnvelope({ choices: [choice] }, true);
        if (stopped && text !== '') throw relayMalformed(provider);
        append(text);
        if (choice['finish_reason'] === 'stop') stopped = true;
      }
      continue;
    }
    const type = value['type'] ?? frame.event;
    if (frame.event !== '' && frame.event !== type) throw relayMalformed(provider);
    if (type === 'message_start') {
      if (started || !isRecord(value['message'])) throw relayMalformed(provider);
      started = true;
    } else if (type === 'content_block_start') {
      const index = value['index']; const block = value['content_block'];
      if (!started || stopped || typeof index !== 'number' || !Number.isSafeInteger(index) || index < 0 || blocks.has(index) || !isRecord(block) || typeof block['type'] !== 'string') throw relayMalformed(provider);
      blocks.set(index, block['type']);
      if (block['type'] === 'text') append(block['text']);
    } else if (type === 'content_block_delta') {
      const index = value['index']; const delta = value['delta'];
      if (stopped || typeof index !== 'number' || !blocks.has(index) || !isRecord(delta)) throw relayMalformed(provider);
      if (delta['type'] === 'text_delta') {
        if (blocks.get(index) !== 'text') throw relayMalformed(provider);
        append(delta['text']);
      }
    } else if (type === 'content_block_stop') {
      if (typeof value['index'] !== 'number' || !blocks.delete(value['index'])) throw relayMalformed(provider);
    } else if (type === 'message_delta') {
      if (!started || blocks.size !== 0 || !isRecord(value['delta'])) throw relayMalformed(provider);
      const reason = value['delta']['stop_reason'];
      assertCompleteReason(reason, ['end_turn', 'stop_sequence'], provider);
      if (reason === 'end_turn' || reason === 'stop_sequence') stopped = true;
    } else if (type === 'message_stop') {
      if (!started || !stopped || blocks.size !== 0) throw relayMalformed(provider);
      finished = true;
    }
  }
  if (!finished || !stopped || !content.trim()) throw relayMalformed(provider);
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
    if (isRecord(item) && (item['type'] === undefined || item['type'] === 'text' || item['type'] === 'output_text') && typeof item['text'] === 'string') return [item['text']];
    return [];
  }).join('');
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
