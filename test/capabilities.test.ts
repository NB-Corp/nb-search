import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeComposition } from '../src/app.ts';
import type { JsonTransport } from '../src/transport.ts';
import { mockConfig, mockRegistration } from './helpers.ts';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
describe('static capabilities', () => {
  it('reports fetch inputs, chains, pipelines, and limits without secrets or roots', async () => { const root = await mkdtemp(join(tmpdir(), 'nb-search-capabilities-')); roots.push(root); let network = 0; const transport: JsonTransport = { async send<T>() { network += 1; throw new Error() as never; } }; const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, transport, config: { ...mockConfig(root), fetch: { file_scopes: [{ id: 'docs', root: join(root, 'private'), media_types: ['text/plain'] }] } }, provider_registrations: [mockRegistration()] }); const value = await app.runtime.capabilities(); expect(value.fetch.default_representation).toBe('markdown'); expect(value.fetch.chains).toContainEqual({ input_kind: 'url', representation: 'markdown', pipelines: ['mock.fetch'] }); expect(value.fetch.pipelines.find((item) => item.id === 'mock.fetch')).toMatchObject({ input_kinds: ['url'], representations: ['markdown', 'text'], egress: 'url', stages: [{ role: 'reader' }] }); expect(value.fetch.inputs.find((item) => item.kind === 'file')).toMatchObject({ enabled: true, scope_ids: ['docs'] }); expect(value.fetch.limits).toHaveProperty('max_source_bytes'); const text = JSON.stringify(value); expect(text).not.toContain(join(root, 'private')); expect(text).not.toMatch(/credential|heartbeat|retry/); expect(network).toBe(0); });
  it('reports custom operations as sync-only', async () => { const root = await mkdtemp(join(tmpdir(), 'nb-search-cap-modes-')); roots.push(root); const app = createRuntimeComposition({}, { cwd: root, homeDirectory: root, config: mockConfig(root), provider_registrations: [mockRegistration()] }); const value = await app.runtime.capabilities(); expect(value.search.lanes.find((lane) => lane.id === 'mock.results')?.execution_modes).toEqual(['sync']); expect(value.fetch.pipelines.find((pipeline) => pipeline.id === 'mock.fetch')?.execution_modes).toEqual(['sync']); });
});
