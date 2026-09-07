// Test-only process fault harness. Never packaged or used by the CLI.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const [home, source, boundary, marker, release] = process.argv.slice(2);
const rename = fs.renameSync;
const unlink = fs.unlinkSync;
const pause = (point) => {
  if (boundary === `fault-${point}`) throw new Error('Injected publication failure.');
  if (boundary !== point) return;
  fs.writeFileSync(marker, point);
  while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
};
fs.renameSync = function(from, to) {
  const phase = String(to) === resolve(home, 'secrets.json') ? 'secrets' : String(to) === resolve(home, 'config.json') ? 'config' : String(to) === resolve(home, '.config-revision.json') ? 'revision' : '';
  pause(`before-${phase}`); const result = rename(from, to); pause(`after-${phase}`); return result;
};
fs.unlinkSync = function(path) { if (String(path) === resolve(home, '.config-access.lock')) pause('before-unlock'); return unlink(path); };
syncBuiltinESMExports();
const { importSearchLayer } = await import('../../src/search-layer-import.ts');
const result = importSearchLayer({ source, apply: true, env: { ...process.env, NB_SEARCH_HOME: home } });
process.stdout.write(JSON.stringify(result));
