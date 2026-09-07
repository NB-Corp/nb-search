// Test-only reader crash during the first captured canonical read, before any execution.
import fs from 'node:fs';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const [home, marker, release] = process.argv.slice(2);
const read = fs.readFileSync;
let reads = 0;
fs.readFileSync = function(path, ...args) {
  if (String(path) === resolve(home, 'config.json') && ++reads === 1) {
    fs.writeFileSync(marker, 'snapshot-capture');
    while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return read(path, ...args);
};
syncBuiltinESMExports();
const { loadCliConnection } = await import('../../src/cli-config.ts');
loadCliConnection('local', { ...process.env, NB_SEARCH_HOME: home });
