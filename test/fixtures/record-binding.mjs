// Test-only immutable receipt publication process. No business runtime or provider construction.
import { jobBinding } from '../../src/cli-config.ts';
const [home, id, identity] = process.argv.slice(2);
try { jobBinding({ home, identity, runtime: {} }, 'search', id, true); process.stdout.write('ok'); }
catch { process.stderr.write('binding-conflict-or-storage-error'); process.exitCode = 2; }
