// CR-02: pause an actual bundled CLI before a selected expired-job prune operation.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { resolve } from 'node:path';
import { syncBuiltinESMExports } from 'node:module';
const [jobDir, phase, paused, release, ...argv] = process.argv.slice(2);
let statCount = 0; let readCount = 0; let injected = false;
function pause() { if (injected) return; injected = true; fs.writeFileSync(paused, phase); while (!fs.existsSync(release)) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25); }
const stat = fsp.lstat; fsp.lstat = async function(path, ...args) { if (String(path) === jobDir && ++statCount === 2 && phase === 'safe-dir') pause(); return await stat(path, ...args); };
const read = fsp.readFile; fsp.readFile = async function(path, ...args) { if (String(path) === resolve(jobDir, 'job.json') && ++readCount === 2 && phase === 'read') pause(); return await read(path, ...args); };
const rm = fsp.rm; fsp.rm = async function(path, ...args) { if (String(path) === jobDir && phase === 'remove') pause(); return await rm(path, ...args); };
syncBuiltinESMExports();
const { runCli } = await import('../../dist/cli.mjs');
process.exitCode = await runCli(argv);
