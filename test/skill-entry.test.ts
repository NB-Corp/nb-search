import { spawn } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true })));
});

async function fixture(cli?: string) {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-skill-entry-'));
  roots.push(root);
  await mkdir(join(root, 'scripts'), { recursive: true });
  await mkdir(join(root, 'skills/nb-search/scripts'), { recursive: true });
  await copyFile(new URL('../scripts/nb-search.mjs', import.meta.url), join(root, 'scripts/nb-search.mjs'));
  await copyFile(new URL('../skills/nb-search/scripts/nb-search.mjs', import.meta.url), join(root, 'skills/nb-search/scripts/nb-search.mjs'));
  if (cli !== undefined) {
    await mkdir(join(root, 'dist'));
    await writeFile(join(root, 'dist/cli.mjs'), cli);
  }
  return root;
}

function invoke(entry: string, args: string[], stdin = ''): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [entry, ...args], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.on('error', (error: NodeJS.ErrnoException) => { if (error.code !== 'EPIPE') reject(error); });
    child.stdin.end(stdin);
  });
}

describe('packaged skill launcher', () => {
  it('keeps the package and installed skill instructions identical', async () => {
    const [packaged, installed] = await Promise.all([
      readFile(new URL('../SKILL.md', import.meta.url), 'utf8'),
      readFile(new URL('../skills/nb-search/SKILL.md', import.meta.url), 'utf8'),
    ]);
    expect(installed).toBe(packaged);
  });

  it('documents local-default job follow-ups and valid optional profiles', async () => {
    const text = await readFile(new URL('../SKILL.md', import.meta.url), 'utf8');
    const commands = text.split('\n').filter((line) => /^\s*node /.test(line) && /\b(?:search|fetch) (?:get|read|cancel)\b/.test(line));
    expect(commands.length).toBeGreaterThan(0);
    expect(commands.some((command) => !command.includes('--profile'))).toBe(true);
    for (const command of commands) {
      if (command.includes('--profile')) expect(command).toMatch(/--profile(?:\s+|=)\S+\s+(?:search|fetch)\s+(?:get|read|cancel)\b/);
      const id = command.match(/\b(?:get|read|cancel)\s+["']?([^\s"']+)/)?.[1];
      expect(id).toMatch(/^(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|<[^>]+>|\$[A-Za-z_][A-Za-z0-9_]*|\$env:[A-Za-z_][A-Za-z0-9_]*)$/i);
    }
    expect(text).not.toContain('output.documents');
  });

  it.each(['scripts/nb-search.mjs', 'skills/nb-search/scripts/nb-search.mjs'])('forwards argv and stdin unchanged through %s without a PATH executable', async (entry) => {
    const root = await fixture(`let input = ''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify({ args: process.argv.slice(2), input }) + '\\n');`);
    const args = ['--profile', 'local', 'search', '--stdin', '中文 "quoted" --help'];
    const input = '{"query":"搜索\\n😀","action":"run"}\n';
    const result = await invoke(join(root, entry), args, input);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe('');
    expect(JSON.parse(result.stdout)).toEqual({ args, input });
  });

  it('preserves stdout, stderr, and a nonzero CLI result code', async () => {
    const root = await fixture(`process.stdout.write('{"status":"partial"}\\n'); process.stderr.write('diagnostic\\n'); process.exitCode = 3;`);
    expect(await invoke(join(root, 'skills/nb-search/scripts/nb-search.mjs'), [])).toEqual({
      code: 3, stdout: '{"status":"partial"}\n', stderr: 'diagnostic\n',
    });
  });

  it('reports a missing build without installing or falling back to a PATH command', async () => {
    const root = await fixture();
    const result = await invoke(join(root, 'scripts/nb-search.mjs'), []);
    expect(result.code).toBe(2);
    expect(result.stdout).toBe('');
    expect(JSON.parse(result.stderr)).toMatchObject({ error: { code: 'ENTRY_UNAVAILABLE', retryable: false } });
    expect(result.stderr).not.toContain(root);
  });
});
