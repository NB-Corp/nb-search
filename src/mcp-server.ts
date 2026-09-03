import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { CallToolRequestSchema, ListToolsRequestSchema, type Tool } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { capabilitiesInputSchema, fetchActionInputSchema, fetchInputSchema, searchInputSchema } from './contracts.ts';
import { publicError } from './errors.ts';
import { createNbSearchRuntime } from './index.ts';
import type { NbSearchRuntime } from './runtime.ts';

const searchJsonSchema = { ...z.toJSONSchema(searchInputSchema, { target: 'draft-7', io: 'input' }), type: 'object' } as Tool['inputSchema'];
const fetchJsonSchema = { ...z.toJSONSchema(fetchActionInputSchema, { target: 'draft-7', io: 'input' }), type: 'object' } as Tool['inputSchema'];
const capabilitiesJsonSchema = z.toJSONSchema(capabilitiesInputSchema, { target: 'draft-7', io: 'input' }) as Tool['inputSchema'];

export function createNbSearchMcpServer(runtime: NbSearchRuntime = createNbSearchRuntime()): Server {
  const server = new Server({ name: 'nb-search', version: '0.1.0' }, { capabilities: { tools: {} } });
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
    { name: 'search', description: 'Run or manage a query operation. Use action run/get/read/cancel. Results operations may use lanes or preset; typed operations require one lane. Execution defaults to sync; async requires idempotency_key.', inputSchema: searchJsonSchema },
    { name: 'fetch', description: 'Run or manage a source-to-document pipeline. Use action run/get/read/cancel; run accepts URL, inline text, inline bytes, or a scoped file and defaults to markdown.', inputSchema: fetchJsonSchema },
    { name: 'capabilities', description: 'Return the static search lane and fetch pipeline catalog and limits without network probes.', inputSchema: capabilitiesJsonSchema },
  ] }));
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const input = request.params.arguments ?? {};
    if (request.params.name === 'search') return await toolResult(() => runtime.search(searchInputSchema.parse(input), { signal: extra.signal }));
    if (request.params.name === 'fetch') return await toolResult(() => runtime.fetch(fetchInputSchema.parse(input), { signal: extra.signal }));
    if (request.params.name === 'capabilities') return await toolResult(() => runtime.capabilities(capabilitiesInputSchema.parse(input), { signal: extra.signal }));
    return { ...result({ error: { code: 'INVALID_INPUT', message: `Unknown tool: ${clean(request.params.name)}.`, retryable: false } }), isError: true };
  });
  return server;
}
function result(data: unknown) { return { content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: data as Record<string, unknown> }; }
async function toolResult(produce: () => Promise<unknown>) { try { const data = await produce(); return { ...result(data), ...(isFailure(data) ? { isError: true } : {}) }; } catch (error) { const safe = error instanceof z.ZodError ? { code: 'INVALID_INPUT' as const, message: clean(error.message), retryable: false } : publicError(error, 'The request failed.'); return { ...result({ error: safe }), isError: true }; } }
function isFailure(value: unknown): boolean { if (value === null || typeof value !== 'object') return true; const item = value as { status?: unknown; state?: unknown }; return item.status === 'failed' || item.state === 'failed'; }
function clean(value: string): string { return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500); }
