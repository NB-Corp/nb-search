#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Console } from 'node:console';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createNbSearchMcpServer } from './mcp-server.ts';

export { createNbSearchMcpServer } from './mcp-server.ts';

export async function runMcp(): Promise<void> {
  Object.defineProperty(globalThis, 'console', {
    configurable: true,
    value: new Console({ stdout: process.stderr, stderr: process.stderr }),
  });
  await createNbSearchMcpServer().connect(new StdioServerTransport());
}
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await runMcp();
