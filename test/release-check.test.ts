import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const releaseCheck = await import(new URL('../scripts/release-check.mjs', import.meta.url).href);
const releaseSource = readFileSync(new URL('../scripts/release-check.mjs', import.meta.url), 'utf8');

describe('release-check helpers', () => {
  it('parses only the one-record npm pack JSON contract', () => {
    expect(releaseCheck.parsePackJson('[{"name":"@nb-corp/nb-search","version":"0.3.0"}]')).toMatchObject({ name: '@nb-corp/nb-search', version: '0.3.0' });
    expect(() => releaseCheck.parsePackJson('warning\n[]')).toThrow(/valid JSON|unexpected JSON/);
    expect(() => releaseCheck.parsePackJson('[]')).toThrow(/unexpected JSON/);
  });

  it('rejects private, source, and test material while requiring public entry files', () => {
    const required = [...releaseCheck.REQUIRED_FILES];
    expect(releaseCheck.assertManifestSafe(required)).toEqual(required);
    for (const forbidden of ['.env.local', 'secrets.json', 'profiles.json', 'tasks/old.json', 'test/fixture.ts', 'node_modules/foo.js', 'website/index.html', 'dist/.test-fixture.mjs']) {
      expect(() => releaseCheck.assertManifestSafe([...required, forbidden])).toThrow();
    }
  });

  it('creates an isolated environment without inherited provider credentials', () => {
    const env = releaseCheck.controlledEnv('/scratch/work', '/scratch/home');
    expect(env).toMatchObject({ CI: '1', NODE_ENV: 'test', NB_SEARCH_HOME: '/scratch/home', NB_SEARCH_CONFIG: join('/scratch/home', 'config.json') });
    expect(env).not.toHaveProperty('NB_SEARCH_EXA_API_KEY');
    expect(env).not.toHaveProperty(['NPM', 'TOKEN'].join('_'));
    expect(env.npm_config_userconfig).toBe(join('/scratch/work', 'npmrc'));
  });

  it('does not manipulate PowerShell or filesystem ACLs', () => {
    expect(releaseCheck).not.toHaveProperty('assertUnixPermissions'); expect(releaseSource).not.toMatch(/powershell\.exe|Get-Acl|Set-Acl|icacls|WINDOWS_ACL_SCRIPT|secureWindowsPath|assertUnixPermissions/i);
  });
});
