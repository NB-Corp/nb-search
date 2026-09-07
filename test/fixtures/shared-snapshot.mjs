import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [mode, payload, paused, release] = process.argv.slice(2);
const home = process.env.NB_SEARCH_HOME; const config = process.env.NB_SEARCH_CONFIG;
if (mode === 'commit') {
  const { configurationTargets, acquireConfigurationLocks, atomicJson, commitTargetRevisions, commitRevision } = await import('../../src/cli-storage.ts');
  const targets = configurationTargets(home, config); const unlock = acquireConfigurationLocks(targets); const values = JSON.parse(fs.readFileSync(payload, 'utf8'));
  atomicJson(targets.data[0], values.config); atomicJson(targets.data[1], values.secrets); commitTargetRevisions(targets); commitRevision(home); unlock();
} else {
  const read = fs.readFileSync; let reads = 0;
  fs.readFileSync = function(path, ...args) { const value = read(path, ...args); if (String(path) === config && ++reads === 1) { fs.writeFileSync(paused, 'captured'); while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); } return value; };
  syncBuiltinESMExports(); const { captureConfigPair } = await import('../../src/cli-storage.ts'); const pair = captureConfigPair(home, config); process.stdout.write(JSON.stringify({ reads, pair }));
}
