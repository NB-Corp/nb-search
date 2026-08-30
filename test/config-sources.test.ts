import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { resolveConfiguration } from '../src/config-sources.ts';

const roots: string[] = [];
afterEach(async () => await Promise.all(roots.splice(0).map(async (root) => rm(root, { recursive: true, force: true }))));

describe('configuration source pipeline', () => {
  it('proves each adjacent precedence edge with and without the higher source', async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, 'legacy.json');
    const canonicalPath = join(root, 'canonical.json');
    await writeFile(legacyPath, JSON.stringify({ exa: { apiKey: 'legacy', apiBase: 'https://legacy.example' } }));
    await writeFile(canonicalPath, JSON.stringify({
      provider_instances: { 'exa.default': { base_url: 'https://canonical.example' } },
      credential_slots: { 'exa.default': { provider_id: 'exa', env: 'CANONICAL_KEY' } },
    }));
    const base = { cwd: root, homeDirectory: root };
    const defaults = resolveConfiguration({ ...base, env: {} });
    expect(defaults.config.provider_instances['exa.default']?.base_url).toBe('https://api.exa.ai/search');

    const legacy = resolveConfiguration({ ...base, env: { SEARCH_LAYER_CREDENTIALS: legacyPath } });
    expect(legacy.config.provider_instances['exa.default']?.base_url).toBe('https://legacy.example');
    expect(legacy.secret_bindings.get('exa.default')?.value).toBe('legacy');

    const canonical = resolveConfiguration({
      ...base, env: { SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath, CANONICAL_KEY: 'canonical' },
    });
    expect(canonical.config.provider_instances['exa.default']?.base_url).toBe('https://canonical.example');
    expect(canonical.secret_bindings.get('exa.default')?.value).toBe('canonical');

    const environment = resolveConfiguration({
      ...base,
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath,
        CANONICAL_KEY: 'canonical', NB_SEARCH_EXA_API_KEY: 'environment', HOST_KEY: 'host', RUNTIME_KEY: 'runtime',
      },
    });
    expect(environment.config.credential_slots['exa.default']?.env).toBe('NB_SEARCH_EXA_API_KEY');
    expect(environment.secret_bindings.get('exa.default')?.value).toBe('environment');

    const host = resolveConfiguration({
      ...base,
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath,
        NB_SEARCH_EXA_API_KEY: 'environment', HOST_KEY: 'host', RUNTIME_KEY: 'runtime',
      },
      config: { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'HOST_KEY' } } },
    });
    expect(host.secret_bindings.get('exa.default')?.value).toBe('host');

    const runtime = resolveConfiguration({
      ...base,
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath, NB_SEARCH_CONFIG: canonicalPath,
        NB_SEARCH_EXA_API_KEY: 'environment', HOST_KEY: 'host', RUNTIME_KEY: 'runtime',
      },
      config: { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'HOST_KEY' } } },
      overrides: { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'RUNTIME_KEY' } } },
    });
    expect(runtime.secret_bindings.get('exa.default')?.value).toBe('runtime');
  });

  it('applies the fixed source order and keeps stable default instance and slot identities', async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, 'legacy.json');
    const canonicalPath = join(root, 'canonical.json');
    await writeFile(legacyPath, JSON.stringify({
      exa: { apiKey: 'legacy-secret', apiBase: 'https://legacy.example/v1' },
    }));
    await writeFile(canonicalPath, JSON.stringify({
      schema_version: '1',
      provider_instances: {
        'exa.default': {
          base_url: 'https://canonical.example/v1',
          options: { nested: { canonical: true }, values: ['canonical'] },
        },
      },
    }));
    const resolved = resolveConfiguration({
      env: {
        NB_SEARCH_HOME: root,
        NB_SEARCH_CONFIG: canonicalPath,
        SEARCH_LAYER_CREDENTIALS: legacyPath,
        EXA_API_KEY: 'alias-secret',
        NB_SEARCH_EXA_API_KEY: 'preferred-secret',
        NB_SEARCH_RETENTION_HOURS: '24',
      },
      config: {
        retention_hours: 48,
        provider_instances: {
          'exa.default': { base_url: 'https://host.example/v1', options: { nested: { host: true }, values: ['host'] } },
        },
      },
      overrides: {
        retention_hours: 96,
        provider_instances: { 'exa.default': { base_url: 'https://runtime.example/v1' } },
      },
      cwd: root,
      homeDirectory: root,
    });

    expect(resolved.config.retention_hours).toBe(96);
    expect(resolved.config.provider_instances['exa.default']).toMatchObject({
      provider_id: 'exa',
      credential_slot_id: 'exa.default',
      base_url: 'https://runtime.example/v1',
      options: { nested: { canonical: true, host: true }, values: ['host'] },
    });
    expect(resolved.config.credential_slots['exa.default']).toEqual({ provider_id: 'exa', env: 'NB_SEARCH_EXA_API_KEY' });
    expect(resolved.secret_bindings.get('exa.default')).toMatchObject({ value: 'preferred-secret' });
    expect(resolved.provenance).toContainEqual({ path: 'provider_instances.exa.default.base_url', source: 'runtime' });
    expect(JSON.stringify({ ...resolved, secret_bindings: undefined })).not.toContain('preferred-secret');
  });

  it('merges instances recursively, replaces arrays and atomic maps, and applies tombstones', async () => {
    const root = await temporaryRoot();
    const resolved = resolveConfiguration({
      env: {}, cwd: root, homeDirectory: root,
      config: {
        provider_instances: {
          'exa.default': { enabled: false, options: { nested: { a: 1 }, list: [1, 2] } },
          'exa.remove': {
            provider_id: 'exa', enabled: true, credential_slot_id: 'exa.remove', timeout_ms: 1000,
            retry: { max_attempts: 1, backoff_ms: 0, max_backoff_ms: 0 }, options: {},
          },
        },
        credential_slots: {
          'exa.remove': { provider_id: 'exa', env: 'REMOVE_KEY', worker_grant: 'old-grant' },
          'custom.atomic': { provider_id: 'exa', env: 'OLD_KEY', worker_grant: 'old-grant' },
        },
        profiles: {
          alternate: { stages: [{ kind: 'fallback', invocations: [{ provider_instance_id: 'exa.default', capability: 'retrieval', role: 'first', trigger: 'always' }] }] },
        },
      },
      overrides: {
        provider_instances: {
          'exa.default': { options: { nested: { b: 2 }, list: [3] } },
          'exa.remove': null,
        },
        credential_slots: {
          'exa.remove': null,
          'custom.atomic': { provider_id: 'exa', env: 'NEW_KEY' },
        },
        profiles: {
          alternate: { stages: [{ kind: 'parallel', invocations: [{ provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'replacement', trigger: 'always' }] }] },
        },
      },
    });

    expect(resolved.config.provider_instances['exa.default']).toMatchObject({
      enabled: false,
      options: { nested: { a: 1, b: 2 }, list: [3] },
    });
    expect(resolved.config.provider_instances['exa.remove']).toBeUndefined();
    expect(resolved.config.credential_slots['exa.remove']).toBeUndefined();
    expect(resolved.config.credential_slots['custom.atomic']).toEqual({ provider_id: 'exa', env: 'NEW_KEY' });
    expect(resolved.config.profiles['alternate']?.stages[0]?.invocations[0]).toMatchObject({
      provider_instance_id: 'tavily.default', role: 'replacement',
    });
  });

  it('derives bindings only from surviving active slots at their winning precedence', async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, 'legacy.json');
    await writeFile(legacyPath, JSON.stringify({ exa: { apiKey: 'legacy-secret-sentinel' } }));
    const base = {
      env: {
        SEARCH_LAYER_CREDENTIALS: legacyPath,
        NB_SEARCH_EXA_API_KEY: 'environment-secret-sentinel',
      },
      cwd: root,
      homeDirectory: root,
    };

    const grantOnly = resolveConfiguration({
      ...base,
      config: { credential_slots: { 'exa.default': { provider_id: 'exa', worker_grant: 'opaque-higher-slot' } } },
    });
    expect(grantOnly.config.credential_slots['exa.default']).toEqual({
      provider_id: 'exa', worker_grant: 'opaque-higher-slot',
    });
    expect(grantOnly.secret_bindings.has('exa.default')).toBe(false);

    const missingHigherEnv = resolveConfiguration({
      ...base,
      config: { credential_slots: { 'exa.default': { provider_id: 'exa', env: 'MISSING_HIGHER_KEY' } } },
    });
    expect(missingHigherEnv.secret_bindings.has('exa.default')).toBe(false);

    const disabled = resolveConfiguration({
      ...base,
      config: { provider_instances: { 'exa.default': { enabled: false } } },
    });
    expect(disabled.secret_bindings.has('exa.default')).toBe(false);

    const removed = resolveConfiguration({
      ...base,
      overrides: {
        provider_instances: { 'exa.default': null },
        credential_slots: { 'exa.default': null },
        profiles: {
          default: { stages: [{ kind: 'parallel', invocations: [{
            provider_instance_id: 'tavily.default', capability: 'retrieval', role: 'primary', trigger: 'always',
          }] }] },
        },
      },
    });
    expect(removed.config.credential_slots['exa.default']).toBeUndefined();
    expect(removed.secret_bindings.has('exa.default')).toBe(false);

    const publicState = JSON.stringify({
      diagnostics: grantOnly.diagnostics,
      config: grantOnly.config,
      bindings: [...grantOnly.secret_bindings.values()],
    });
    expect(publicState).not.toContain('legacy-secret-sentinel');
    expect(publicState).not.toContain('environment-secret-sentinel');
  });

  it('turns malformed legacy input into safe diagnostics while explicit invalid sources fail', async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, 'legacy.json');
    await writeFile(legacyPath, '{not-json');
    const resolved = resolveConfiguration({
      env: { SEARCH_LAYER_CREDENTIALS: legacyPath }, cwd: root, homeDirectory: root,
    });
    expect(resolved.diagnostics).toContainEqual(expect.objectContaining({ code: 'LEGACY_INVALID', path: legacyPath }));
    expect(JSON.stringify(resolved.diagnostics)).not.toContain('not-json');

    const canonicalPath = join(root, 'canonical.json');
    await writeFile(canonicalPath, JSON.stringify({ retention_hours: -1 }));
    expect(() => resolveConfiguration({
      env: { NB_SEARCH_CONFIG: canonicalPath }, cwd: root, homeDirectory: root,
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
    expect(() => resolveConfiguration({
      env: {}, cwd: root, homeDirectory: root, config: { log_level: 'verbose' as 'warn' },
    })).toThrow(expect.objectContaining({ code: 'CONFIGURATION_ERROR' }));
  });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'nb-search-config-'));
  roots.push(root);
  return root;
}
