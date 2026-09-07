import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';
import { parseConfigPatch } from '../src/config-schema.ts';
import { defaultConfiguration } from '../src/config-sources.ts';
import { fetchInputSchema, searchInputSchema } from '../src/contracts.ts';
import { profilesSchema } from '../src/cli-config.ts';

const root = fileURLToPath(new URL('..', import.meta.url));
const website = resolve(root, 'website');
async function pages() {
  const paths = [resolve(website, 'index.md')];
  for (const section of ['guide', 'sources', 'reference']) {
    for (const item of await readdir(resolve(website, section))) {
      if (item.endsWith('.md')) paths.push(resolve(website, section, item));
    }
  }
  return Promise.all(paths.map(async (path) => ({ path, text: await readFile(path, 'utf8') })));
}
function fences(text: string, language: string) {
  return [...text.matchAll(new RegExp('```' + language + '[^\\n]*\\n([\\s\\S]*?)```', 'g'))].map((match) => match[1]!);
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }

describe('website examples match the executable contract', () => {
  it('parses JSON and validates complete configuration, profile, and run examples with real schemas', async () => {
    let checked = 0;
    for (const page of await pages()) {
      for (const source of fences(page.text, 'json')) {
        const value: unknown = JSON.parse(source);
        if (!object(value)) continue;
        if (object(value['profiles'])) {
          expect(profilesSchema.safeParse(value).success, page.path).toBe(true); checked++;
        } else if (value['action'] === 'run') {
          const schema = Object.hasOwn(value, 'source') || Object.hasOwn(value, 'url') ? fetchInputSchema : searchInputSchema;
          expect(schema.safeParse(value).success, page.path).toBe(true); checked++;
        } else if (['schema_version', 'version', 'defaults', 'provider_instances', 'credential_slots', 'execution', 'fetch', 'lanes', 'presets'].some((key) => Object.hasOwn(value, key)) && !Object.hasOwn(value, 'values') && !Object.hasOwn(value, 'status')) {
          expect(() => parseConfigPatch(value, 'website example'), page.path).not.toThrow(); checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(2);
  });

  it('executes the documented offline quickstart with default quality gates', async () => {
    const directory = await mkdtemp(resolve(root, '.test-website-runtime-'));
    try {
      const page = await readFile(resolve(website, 'guide/quickstart.md'), 'utf8');
      const examples = fences(page, 'bash').flatMap((block) => block.split('\n').filter((line) => line.trim().startsWith('{')).map((line) => JSON.parse(line) as unknown));
      const inputs = examples.map((value) => fetchInputSchema.parse(value)).filter((input) => input.action === 'run' && input.source?.kind === 'inline_text');
      expect(inputs.length).toBeGreaterThan(0);
      const { createNbSearchRuntime } = await import('../src/index.ts');
      const runtime = createNbSearchRuntime({ env: { NB_SEARCH_HOME: directory } });
      for (const input of inputs) {
        expect(input.action === 'run' && input.pipeline).toBe('direct.local');
        expect(input.action === 'run' && (input.execution ?? 'sync')).toBe('sync');
        const result = await runtime.fetch(input);
        expect('status' in result && result.status, JSON.stringify(result)).toBe('succeeded');
        expect('documents' in result && result.documents.length).toBeGreaterThan(0);
      }
      expect(await readdir(directory)).toEqual([]);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('executes the standalone SDK offline tutorial against the packaged SDK', async () => {
    const directory = await mkdtemp(resolve(root, '.test-website-sdk-'));
    try {
      const page = await readFile(resolve(website, 'guide/integrations.md'), 'utf8');
      const examples = fences(page, 'typescript').filter((source) => source.includes("pipeline: 'direct.local'"));
      expect(examples).toHaveLength(1);
      const source = examples[0]!;
      expect(source).not.toMatch(/\.search\s*\(|createNbSearchRemoteClient/);
      const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } }).outputText;
      const assertions = `\nconst assert = (await import('node:assert/strict')).default;\nassert.equal(fetchResponse.action, 'run');\nassert.equal(fetchResponse.execution, 'sync');\nassert.equal(fetchResponse.status, 'succeeded', JSON.stringify(fetchResponse));\nassert.ok(fetchResponse.documents.length > 0);\n`;
      const script = resolve(directory, 'offline-example.mjs');
      await writeFile(script, compiled + assertions);
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)(process.execPath, [script], {
        cwd: directory,
        env: { NB_SEARCH_HOME: resolve(directory, 'home'), SystemRoot: process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] },
        timeout: 15_000,
        windowsHide: true,
      });
      expect(await readdir(directory)).toEqual(['offline-example.mjs']);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 20_000);

  it('documents real retention and logging defaults and names every built-in lane', async () => {
    const config = defaultConfiguration('/documentation-fixture');
    const configPage = await readFile(resolve(website, 'guide/configuration.md'), 'utf8');
    const rows = configPage.split('\n').filter((line) => line.startsWith('|'));
    const retention = rows.find((line) => line.includes('`NB_SEARCH_RETENTION_HOURS`'));
    const logging = rows.find((line) => line.includes('`NB_SEARCH_LOG_LEVEL`'));
    expect(retention).toBeDefined(); expect(logging).toBeDefined();
    expect(retention!.split('|')[3]).toContain(String(config.retention_hours));
    expect(logging!.split('|')[3]).toContain(config.log_level);
    const catalog = await readFile(resolve(website, 'sources/index.md'), 'utf8');
    for (const [id, lane] of Object.entries(config.lanes)) {
      const row = catalog.split('\n').find((line) => line.startsWith('|') && line.split('|')[1]?.includes('`' + id + '`'));
      expect(row, id).toBeDefined();
      expect(row, id).toMatch(new RegExp(lane.cost + '\\s*/\\s*' + lane.latency));
    }
  });

  it('uses receipt UUIDs for job follow-ups and places optional profiles before commands', async () => {
    let checked = 0;
    for (const page of await pages()) {
      for (const line of page.text.split('\n')) {
        if (!/^\s*(?:node|nb-search)\b/.test(line) || !/\b(?:search|fetch) (?:get|read|cancel)\b/.test(line)) continue;
        if (line.includes('--profile')) expect(line, page.path).toMatch(/--profile(?:\s+|=)\S+\s+(?:search|fetch)\s+(?:get|read|cancel)\b/);
        const id = line.match(/\b(?:get|read|cancel)\s+["']?([^\s"']+)/)?.[1];
        expect(id, page.path).toMatch(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|<[^>]+>|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*)$/i);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(1);
  });

  it('typechecks all complete TypeScript tutorials against the packaged SDK', async () => {
    const directory = await mkdtemp(resolve(root, '.test-website-types-'));
    try {
      const files: string[] = [];
      for (const page of await pages()) {
        for (const source of [...fences(page.text, 'typescript'), ...fences(page.text, 'ts')]) {
          if (!source.includes("from '@nb-corp/nb-search'") && !source.includes('from "@nb-corp/nb-search"')) continue;
          const path = resolve(directory, `example-${files.length}.mts`);
          await writeFile(path, source); files.push(path);
        }
      }
      expect(files.length).toBeGreaterThan(1);
      const program = ts.createProgram(files, { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, strict: true, noEmit: true, skipLibCheck: true, types: ['node'] });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      const messages = ts.formatDiagnostics(diagnostics, { getCurrentDirectory: () => root, getCanonicalFileName: (name) => name, getNewLine: () => '\n' });
      expect(messages).toBe('');
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30000);
});
