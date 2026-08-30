import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

describe('offline smoke environment', () => {
  it('uses only temporary canonical and legacy configuration selectors', async () => {
    const source = await readFile(resolve(import.meta.dirname, '../scripts/smoke.mjs'), 'utf8');
    expect(source).not.toContain('...process.env');
    expect(source).toMatch(/NB_SEARCH_CONFIG:\s*configPath/);
    expect(source).toMatch(/SEARCH_LAYER_CREDENTIALS:\s*legacyPath/);
    expect(source).toMatch(/await writeFile\(legacyPath, '\{\}'\)/);
    expect(source).toMatch(/createNbSearchRuntime\(\{ env \}\)/);
  });
});
