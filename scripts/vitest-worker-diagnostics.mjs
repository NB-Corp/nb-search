// Opt-in parent-side observation only: Vitest 4's unexpected-exit error omits
// the native child exit code. Do not wrap spawn, alter worker behavior or retry.
import { subscribe } from 'node:diagnostics_channel';
import { writeSync } from 'node:fs';

if (process.env.NB_SEARCH_TEST_DIAGNOSTICS === '1') {
  subscribe('child_process', ({ process: child }) => {
    child.once('spawn', () => {
      if (!child.spawnargs.some((arg) => /vitest[\\/]dist[\\/]workers[\\/]/.test(arg))) return;
      const emit = (event, detail = {}) => writeSync(2, `[vitest-worker] ${JSON.stringify({ event, pid: child.pid, ...detail })}\n`);
      emit('spawn');
      child.once('exit', (code, signal) => emit('exit', {
        code, signal, killed: child.killed,
        ...(typeof code === 'number' ? { code_hex: `0x${(code >>> 0).toString(16).padStart(8, '0')}` } : {}),
      }));
    });
  });
}
