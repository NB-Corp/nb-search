import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import {
  capabilitiesInputSchema, researchCancelInputSchema, researchListInputSchema, researchReadInputSchema,
  researchStartInputSchema, researchStatusInputSchema, searchInputSchema,
} from './contracts.ts';
import { publicError } from './errors.ts';
import { createNbSearchRuntime } from './index.ts';
import type { NbSearchRuntime } from './runtime.ts';

export function createNbSearchMcpServer(runtime: NbSearchRuntime = createNbSearchRuntime()): McpServer {
  const server = new McpServer({ name: 'nb-search', version: '0.1.0' });
  (server as unknown as { createToolError(message: string): unknown }).createToolError = (message) => {
    const payload = { error: { code: 'INVALID_INPUT', message: cleanValidation(message), retryable: false } };
    return { ...result(payload), isError: true };
  };
  server.registerTool('search', { description: 'Run synchronous multi-provider search inside a maximum 45-second budget.', inputSchema: searchInputSchema },
    async (input, extra) => toolResult(() => runtime.search(searchInputSchema.parse(input), { signal: extra.signal }), true));
  server.registerTool('research_start', { description: 'Create or reuse a durable asynchronous research evidence job.', inputSchema: researchStartInputSchema },
    async (input, extra) => toolResult(() => runtime.researchStart(researchStartInputSchema.parse(input), { signal: extra.signal })));
  server.registerTool('research_status', { description: 'Read current durable research job status without waiting.', inputSchema: researchStatusInputSchema },
    async (input, extra) => toolResult(() => runtime.researchStatus(researchStatusInputSchema.parse(input), { signal: extra.signal })));
  server.registerTool('research_read', { description: 'Read a bounded page from a checkpoint or final research artifact.', inputSchema: researchReadInputSchema },
    async (input, extra) => toolResult(() => runtime.researchRead(researchReadInputSchema.parse(input), { signal: extra.signal })));
  server.registerTool('research_list', { description: 'List bounded durable research job summaries.', inputSchema: researchListInputSchema },
    async (input, extra) => toolResult(() => runtime.researchList(researchListInputSchema.parse(input), { signal: extra.signal })));
  server.registerTool('research_cancel', { description: 'Idempotently request cancellation of an active research job.', inputSchema: researchCancelInputSchema },
    async (input, extra) => toolResult(() => runtime.researchCancel(researchCancelInputSchema.parse(input), { signal: extra.signal })));
  server.registerTool('capabilities', { description: 'Report secret-free local capabilities without provider network probes.', inputSchema: capabilitiesInputSchema },
    async (input, extra) => toolResult(() => runtime.capabilities(capabilitiesInputSchema.parse(input), { signal: extra.signal })));
  return server;
}

function result(data: unknown) {
  const text = JSON.stringify(data);
  return { content: [{ type: 'text' as const, text }], structuredContent: data as Record<string, unknown> };
}
async function toolResult(produce: () => Promise<unknown>, search = false) {
  try {
    const data = await produce();
    const failed = search && isFailedSearch(data);
    return { ...result(data), ...(failed ? { isError: true } : {}) };
  } catch (error) {
    const payload = { error: publicError(error, 'The request failed.') };
    return { ...result(payload), isError: true };
  }
}
function isFailedSearch(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  const state = (value as { state?: unknown }).state;
  return state === 'failed' || state === 'timed_out' || state === 'cancelled';
}
function cleanValidation(value: string): string { return value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 500) }
