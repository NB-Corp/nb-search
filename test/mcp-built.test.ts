import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { getDefaultEnvironment, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, describe, expect, it } from 'vitest';

import type { NbSearchRuntime } from '../src/runtime.ts';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

describe('built generic MCP artifact', () => {
  it('supports initialize, ping, list, and calls over stdio with JSON-RPC-only stdout', async () => {
    const home = await mkdtemp(join(tmpdir(), 'nb-search-mcp-'));
    roots.push(home);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [resolve('dist/mcp.mjs')],
      cwd: process.cwd(),
      env: { ...getDefaultEnvironment(), NB_SEARCH_HOME: home, NB_SEARCH_LOG_LEVEL: 'warn' },
      stderr: 'pipe',
    });
    const client = new Client({ name: 'nb-search-black-box', version: '1.0.0' });
    try {
      await client.connect(transport);
      await expect(client.ping()).resolves.toEqual({});
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'search', 'research_start', 'research_status', 'research_read',
        'research_list', 'research_cancel', 'capabilities',
      ]);
      for (const tool of listed.tools) expect(tool.inputSchema['additionalProperties']).toBe(false);

      const result = await client.callTool({ name: 'capabilities', arguments: {} });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        mode: 'capabilities', diagnostics: { network_probe_performed: false },
      });
      const content = result.content as Array<{ type: string; text?: string }>;
      expect(JSON.parse(String(content[0]?.type === 'text' ? content[0].text : '')))
        .toEqual(result.structuredContent);

      const invalid = await client.callTool({ name: 'capabilities', arguments: { unknown: true } });
      expect(invalid.isError).toBe(true);
      expect(JSON.stringify(invalid)).toContain('INVALID_INPUT');
    } finally {
      await client.close();
    }
  });

  it('propagates standard MCP cancellation through the built server factory', async () => {
    const builtUrl = pathToFileURL(resolve('dist/mcp.mjs')).href;
    const built = await import(builtUrl) as {
      createNbSearchMcpServer(runtime: NbSearchRuntime): {
        connect(transport: InMemoryTransport): Promise<void>;
        close(): Promise<void>;
      };
    };
    let observedSignal: AbortSignal | undefined;
    const runtime = cancellingRuntime((signal) => { observedSignal = signal; });
    const server = built.createNbSearchMcpServer(runtime);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'nb-search-cancel-test', version: '1.0.0' });
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const controller = new AbortController();
    const pending = client.callTool({ name: 'search', arguments: { query: 'wait' } }, undefined, { signal: controller.signal });
    await waitFor(() => observedSignal !== undefined);
    controller.abort();
    await expect(pending).rejects.toThrow();
    await waitFor(() => observedSignal?.aborted === true);
    await client.close();
    await server.close();
  });
});

function cancellingRuntime(onSignal: (signal: AbortSignal | undefined) => void): NbSearchRuntime {
  const unused = async (): Promise<never> => { throw new Error('Unexpected runtime method.'); };
  return {
    async search(_input, context) {
      onSignal(context?.signal);
      return await new Promise((_, reject) => {
        const signal = context?.signal;
        if (signal?.aborted === true) reject(signal.reason);
        else signal?.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    },
    researchStart: unused,
    researchStatus: unused,
    researchRead: unused,
    researchList: unused,
    researchCancel: unused,
    capabilities: unused,
  };
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('Timed out waiting for MCP cancellation.');
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5));
  }
}
