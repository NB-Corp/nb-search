// Fake-fixture diagnostics only. Keep worker lifecycle and fatal stderr after admission exits.
import fs from 'node:fs';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { resolve } from 'node:path';
const directory = process.env.NB_TEST_WORKER_TRACE_DIR;
if (directory) {
  fs.mkdirSync(directory, { recursive: true });
  const event = (value) => { try { fs.appendFileSync(resolve(directory, 'lifecycle.ndjson'), JSON.stringify({ at: new Date().toISOString(), pid: process.pid, ...value }) + '\n'); } catch { /* Fixture cleanup must not change a worker exit. */ } };
  if (/[/\\]worker\.mjs$/.test(process.argv[1] ?? '')) {
    event({ event: 'worker-entry', argv: process.argv.slice(1) });
    process.on('exit', (code) => event({ event: 'worker-exit', code }));
    process.on('uncaughtExceptionMonitor', (error, origin) => event({ event: 'worker-uncaught', origin, stack: error.stack }));
  }
  const spawn = childProcess.spawn;
  childProcess.spawn = function(command, args, options) {
    if (!options?.detached || !args?.some((arg) => /[/\\]worker\.mjs$/.test(arg))) return spawn(command, args, options);
    const fd = fs.openSync(resolve(directory, `${args[1]}.stderr.log`), 'a');
    try {
      const child = spawn(command, args, { ...options, stdio: ['ignore', fd, fd] });
      event({ event: 'worker-spawn', worker_pid: child.pid, args });
      child.on('error', (error) => event({ event: 'worker-spawn-error', worker_pid: child.pid, message: error.message }));
      return child;
    } finally { fs.closeSync(fd); }
  };
  syncBuiltinESMExports();
}
