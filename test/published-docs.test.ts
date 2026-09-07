import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { profilesSchema } from '../src/cli-config.ts';

describe('published complete JSON recipes', () => {
  const pkg = JSON.parse(readFileSync('package.json', 'utf8')) as { files: string[] };
  const documents = [...pkg.files.filter((path) => path.endsWith('.md')), 'skills/nb-search/SKILL.md'];
  it.each(documents)('%s has parseable complete json fences', (path) => {
    const content = readFileSync(path, 'utf8');
    for (const match of content.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)) expect(() => JSON.parse(match[1]!), `${path} at offset ${match.index}`).not.toThrow();
  });
  it('the remote profiles recipe passes the actual loader schema', () => {
    const content = readFileSync('docs/cli.md', 'utf8');
    const values = [...content.matchAll(/```json\s*\r?\n([\s\S]*?)```/g)].map((match) => JSON.parse(match[1]!) as Record<string, unknown>);
    const example = values.find((value) => Object.hasOwn(value, 'profiles'));
    expect(example).toBeDefined(); expect(profilesSchema.parse(example).profiles['cloud']?.token_env).toBe('NB_SEARCH_CLOUD_TOKEN');
  });
});
