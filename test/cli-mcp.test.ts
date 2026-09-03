import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.ts';
import { createNbSearchMcpServer } from '../src/mcp-server.ts';
import type { NbSearchRuntime } from '../src/runtime.ts';
import type { CapabilityEnvelope, FetchEnvelope, SearchEnvelope } from '../src/types.ts';

const selection = { source: 'lane' as const, lanes: ['exa.search'], requested: 'exa.search' };

describe('three-capability CLI', () => {
  it('routes run/get/read/cancel plus fetch and capabilities directly to the runtime', async () => {
    const runtime = fakeRuntime();
    const jobId = '00000000-0000-4000-8000-000000000000';
    const calls = [
      ['search', 'query', '--lane', 'exa.search'],
      ['search', 'run', 'one', '--query', 'two', '--lanes', 'exa.search,tavily.search', '--execution', 'async', '--idempotency-key', 'key'],
      ['search', 'get', jobId],
      ['search', 'read', jobId, '--cursor', 'cursor', '--page-size', '2'],
      ['search', 'cancel', jobId],
      ['fetch', 'https://example.com', '--pipeline', 'direct.fetch'],
      ['capabilities'],
    ] as const;
    for (const argv of calls) expect(await runCli(argv, captureIo(), () => runtime)).toBe(0);
    expect(runtime.search).toHaveBeenNthCalledWith(1, { action: 'run', query: 'query', lane: 'exa.search' });
    expect(runtime.search).toHaveBeenNthCalledWith(2, { action: 'run', query: ['one', 'two'], lanes: ['exa.search', 'tavily.search'], execution: 'async', idempotency_key: 'key' });
    expect(runtime.search).toHaveBeenNthCalledWith(3, { action: 'get', job_id: jobId });
    expect(runtime.search).toHaveBeenNthCalledWith(4, { action: 'read', job_id: jobId, cursor: 'cursor', page_size: 2 });
    expect(runtime.search).toHaveBeenNthCalledWith(5, { action: 'cancel', job_id: jobId });
    expect(runtime.fetch).toHaveBeenCalledWith({ action: 'run', source: { kind: 'url', url: 'https://example.com' }, pipeline: 'direct.fetch' });
    expect(runtime.capabilities).toHaveBeenCalledWith();
  });

  it('has only three top-level commands and gives removed names ordinary unknown-command errors', async () => {
    const runtime = fakeRuntime();
    for (const command of ['answer', 'deep', 'research', 'list']) {
      const io = captureIo();
      expect(await runCli([command], io, () => runtime)).toBe(2);
      expect(JSON.parse(io.stderr.value)).toMatchObject({ error: { code: 'INVALID_INPUT', message: `Unknown command: ${command}.` } });
    }
    const help = captureIo();
    expect(await runCli(['--help'], help, () => runtime)).toBe(0);
    expect(help.stdout.value).toContain('nb-search search');
    expect(help.stdout.value).toContain('nb-search fetch');
    expect(help.stdout.value).toContain('nb-search capabilities');
    expect(help.stdout.value).not.toMatch(/nb-search (answer|deep|research|list)\b/);
  });
});

describe('three-tool MCP server', () => {
  it('lists exactly search/fetch/capabilities with strict schemas and dispatches explicit actions', async () => {
    const runtime = fakeRuntime();
    const server = createNbSearchMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual(['search', 'fetch', 'capabilities']);
      const searchTool = listed.tools.find((tool) => tool.name === 'search')!;
      const branches = searchTool.inputSchema['oneOf'] as Array<{ properties: Record<string, { const?: string }>; required: string[]; additionalProperties: boolean }>;
      expect(branches).toHaveLength(4);
      const byAction = Object.fromEntries(branches.map((branch) => [branch.properties['action']?.const, branch]));
      expect(byAction['run']?.required).toEqual(['action', 'query']); expect(byAction['run']?.additionalProperties).toBe(false); expect(byAction['run']?.properties).not.toHaveProperty('job_id');
      expect(byAction['get']?.required).toEqual(['action', 'job_id']); expect(byAction['get']?.additionalProperties).toBe(false); expect(byAction['get']?.properties).not.toHaveProperty('query');
      expect(byAction['read']?.required).toEqual(['action', 'job_id']); expect(byAction['read']?.properties).toHaveProperty('cursor'); expect(byAction['read']?.properties).toHaveProperty('page_size');
      expect(byAction['cancel']?.required).toEqual(['action', 'job_id']); expect(byAction['cancel']?.properties).not.toHaveProperty('cursor');
      const fetchTool = listed.tools.find((tool) => tool.name === 'fetch')!; const fetchBranches = fetchTool.inputSchema['oneOf'] as Array<{ properties: Record<string, { const?: string }>; additionalProperties: boolean }>;
      expect(fetchBranches).toHaveLength(4); expect(fetchBranches.every((branch) => branch.additionalProperties === false)).toBe(true); expect(listed.tools.find((tool) => tool.name === 'capabilities')?.inputSchema['additionalProperties']).toBe(false);
      const result = await client.callTool({ name: 'search', arguments: { action: 'run', query: 'q', lane: 'exa.search' } });
      expect(result.isError).not.toBe(true);
      expect(runtime.search).toHaveBeenCalledWith({ action: 'run', query: 'q', lane: 'exa.search' }, { signal: expect.any(AbortSignal) });
      const invalid = await client.callTool({ name: 'search', arguments: { action: 'status', job_id: crypto.randomUUID() } });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain('INVALID_INPUT');
      const forbidden = await client.callTool({ name: 'search', arguments: { action: 'get', job_id: crypto.randomUUID(), query: 'not allowed' } });
      expect(forbidden.isError).toBe(true);
      expect(JSON.stringify(forbidden)).toContain('INVALID_INPUT');
      expect(runtime.search).toHaveBeenCalledTimes(1);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

function fakeRuntime(): NbSearchRuntime & { search: ReturnType<typeof vi.fn>; fetch: ReturnType<typeof vi.fn>; capabilities: ReturnType<typeof vi.fn> } {
  const search = vi.fn(async (input): Promise<SearchEnvelope> => {
    if (input.action === 'get') return { schema_version: '3.0', action: 'get', job_id: input.job_id, state: 'queued', cancel_requested: false, created_at: '2026-01-01T00:00:00.000Z', updated_at: '2026-01-01T00:00:00.000Z', poll_after_ms: 1000 };
    if (input.action === 'read') return { schema_version: '3.0', action: 'read', job_id: input.job_id, state: 'queued', chunks: [] };
    if (input.action === 'cancel') return { schema_version: '3.0', action: 'cancel', job_id: input.job_id, state: 'cancelled', cancel_requested: true };
    if (input.execution === 'async') return { schema_version: '3.0', action: 'run', execution: 'async', selection, status: 'queued', channel: 'results', schema_id: 'nb-search.results@1', job: { job_id: crypto.randomUUID(), state: 'queued', created_at: '2026-01-01T00:00:00.000Z' }, reused: false, poll_after_ms: 1000, hints: [] };
    return { schema_version: '3.0', action: 'run', execution: 'sync', selection, status: 'empty', output: { channel: 'results', schema_id: 'nb-search.results@1', status: 'empty', lanes: ['exa.search'], results: [], lane_outcomes: [], merge_summary: { input_rows: 0, canonical_dedup: 0, independent_evidence_groups: 0, result_count: 0 }, hints: [] }, hints: [] };
  });
  const fetch = vi.fn(async (): Promise<FetchEnvelope> => ({ schema_version: '3.0', mode: 'fetch', action: 'run', execution: 'sync', selection: { source: 'pipeline', pipeline: 'direct.fetch' }, status: 'succeeded', lane_outcomes: [], documents: [], hints: [] }));
  const capabilities = vi.fn(async (): Promise<CapabilityEnvelope> => ({ schema_version: '3.0', revision: 'r', search: { lanes: [], presets: [], limits: { max_queries: 64, max_results: 100, max_timeout_ms: 3_600_000, max_inline_bytes: 1024 } }, fetch: { default_representation: 'markdown', inputs: [], chains: [], pipelines: [], limits: { max_source_bytes: 1024, max_response_bytes: 1024, max_content_chars: 256, max_redirects: 5, max_timeout_ms: 120_000, max_inline_bytes: 1024 } }, jobs: { result_ttl_seconds: 3600, cancel_supported: true } }));
  return { search, fetch, capabilities };
}

function captureIo() {
  const stdout = { value: '', write(value: string) { this.value += value; } };
  const stderr = { value: '', write(value: string) { this.value += value; } };
  return { stdout, stderr };
}
