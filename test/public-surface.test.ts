import { exec } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import * as publicModule from '../src/index.ts';
import { NbSearchRuntimeImpl } from '../src/runtime.ts';

const execAsync = promisify(exec);

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

  it('publishes the public documents referenced by the README', async () => {
    const root = fileURLToPath(new URL('..', import.meta.url));
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { exports: Record<string, unknown>; files: string[]; repository: { url: string }; homepage: string; bugs: { url: string } };
    expect(Object.keys(pkg.exports).sort()).toEqual(['.', './SKILL.md']);
    expect(pkg.files).toEqual(['dist', 'README.md', 'CHANGELOG.md', 'SKILL.md', '.env.example', 'docs/model-facing-lane-runtime.md']);
    expect(pkg).toMatchObject({ repository: { url: 'git+https://github.com/NB-Corp/nb-search.git' }, homepage: 'https://github.com/NB-Corp/nb-search#readme', bugs: { url: 'https://github.com/NB-Corp/nb-search/issues' } });
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    const references = [...readme.matchAll(/`((?:\.env\.example|SKILL\.md|docs\/[^`\s]+))`/g)].map((match) => match[1]!);
    const { stdout } = await execAsync('npm pack --dry-run --json', { cwd: root, maxBuffer: 1024 * 1024 });
    const manifest = JSON.parse(stdout) as Array<{ files: Array<{ path: string }> }>;
    const packed = new Set(manifest[0]!.files.map((file) => file.path));
    expect(references.sort()).toEqual(['.env.example', 'SKILL.md', 'docs/model-facing-lane-runtime.md']);
    for (const reference of references) expect(packed.has(reference)).toBe(true);
  });
});
