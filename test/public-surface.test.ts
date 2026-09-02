import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import * as publicModule from '../src/index.ts';
import { NbSearchRuntimeImpl } from '../src/runtime.ts';

describe('public surface', () => {
  it('exposes exactly three runtime methods and no fetch-security seam', () => {
    const methods = Object.getOwnPropertyNames(NbSearchRuntimeImpl.prototype).filter((name) => name !== 'constructor').sort();
    expect(methods).toEqual(['capabilities', 'fetch', 'search']);
    for (const name of ['answer', 'deepStart', 'deepStatus', 'deepRead', 'deepList', 'deepCancel', 'researchStart', 'researchStatus', 'researchRead', 'researchList', 'researchCancel', 'listJobs']) expect((NbSearchRuntimeImpl.prototype as unknown as Record<string, unknown>)[name]).toBeUndefined();
    for (const name of ['createNodeDirectFetchIo', 'createTestOnlyNodeDirectFetchIo', 'nodeDirectFetchIo', 'DirectFetchProvider', 'ExaProvider', 'TavilyProvider']) expect((publicModule as Record<string, unknown>)[name]).toBeUndefined();
  });

  it('keeps removed contracts out of package exports and reader-facing command examples', async () => {
    const index = await readFile(new URL('../src/index.ts', import.meta.url), 'utf8');
    expect(index).not.toMatch(/\b(AnswerProvider|DeepProvider|ResearchLightProvider|MultiAgentResearchProvider|DirectFetchProvider)\b/);
    expect(index).not.toMatch(/create(?:TestOnly)?NodeDirectFetchIo|reassembleMultiAgent|deepStart|researchStart/);

    const publicFiles = ['../README.md', '../SKILL.md', '../docs/model-facing-lane-runtime.md', '../src/cli.ts', '../src/mcp-server.ts', '../src/runtime.ts'];
    const text = (await Promise.all(publicFiles.map(async (path) => await readFile(new URL(path, import.meta.url), 'utf8')))).join('\n');
    expect(text).not.toMatch(/runtime\.(?:answer|deep\w*|research\w*|listJobs)\b/);
    expect(text).not.toMatch(/nb-search\s+(?:answer|deep|research|list)\b/);
    expect(text).not.toMatch(/registerTool\(['"](?:answer|deep|research|list|tasks)['"]/);
    expect(text).not.toMatch(/\b(?:compact|external_results|answer_lane|deep_lane|sync_lane|async_lane|legacy_path)\b/);
  });

  it('publishes the skill and only root plus skill subpath', async () => {
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown>; files: string[] };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './SKILL.md']);
    expect(pkg.files).toEqual(['dist', 'README.md', 'SKILL.md']);
  });
});
