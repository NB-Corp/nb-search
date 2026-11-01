// New local-only verification seam for the recovered fetch/dispatcher contract.
import { vi } from 'vitest';
import type { DirectFetchIo } from '../src/direct-acquisition.ts';

const state = vi.hoisted(() => ({ lookup: async (_host: string): Promise<string[]> => ['8.8.8.8'] }));
vi.mock('node:dns/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:dns/promises')>(),
  lookup: async (host: string) => (await state.lookup(host)).map(address => ({ address, family: address.includes(':') ? 6 : 4 })),
}));
export interface FixtureResponse { status: number; headers?: Readonly<Record<string, string>>; body?: Uint8Array | string }
export function fixtureDirectIo(options: {
  lookup?: (hostname: string) => Promise<string[]>;
  fetch: (url: URL, init: RequestInit | undefined) => FixtureResponse | Promise<FixtureResponse>;
}): DirectFetchIo {
  state.lookup = options.lookup ?? (async () => ['8.8.8.8']);
  return { async fetch(input, init) {
    const url = new URL(String(input));
    const value = await options.fetch(url, init);
    const response = new Response(value.body as BodyInit | undefined, { status: value.status, headers: value.headers });
    Object.defineProperty(response, 'url', { value: url.href });
    return response;
  } };
}
