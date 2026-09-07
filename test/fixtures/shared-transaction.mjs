import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const [mode, source, paused, release] = process.argv.slice(2);
if (mode === 'cli') {
  const { runCli } = await import('../../dist/cli.mjs');
  process.exitCode = await runCli(process.argv.slice(3));
} else {
  let stopped = false;
  const pause = () => { if (stopped) return; stopped = true; fs.writeFileSync(paused, 'paused'); while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10); };
  if (mode === 'staging') { const open = fs.openSync; fs.openSync = function(path, ...args) { if (/\.migration-.*-config\.json$/.test(String(path))) pause(); return open(path, ...args); }; }
  if (mode === 'half') { const rename = fs.renameSync; fs.renameSync = function(from, to) { const result = rename(from, to); if (/\.migration-.*-secrets\.json$/.test(String(from))) pause(); return result; }; }
  syncBuiltinESMExports();
  try { const { importSearchLayer } = await import('../../src/search-layer-import.ts'); process.stdout.write(JSON.stringify(importSearchLayer({ source, apply: true }))); }
  catch (error) { process.stderr.write(error.message); process.exitCode = 2; }
}
