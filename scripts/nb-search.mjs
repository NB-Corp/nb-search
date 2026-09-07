#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('../dist/cli.mjs', import.meta.url));

function unavailable() {
  process.stderr.write(`${JSON.stringify({ error: {
    code: 'ENTRY_UNAVAILABLE',
    message: 'The packaged nb-search CLI is unavailable. Install a built package or run pnpm build in the source package.',
    retryable: false,
  } })}\n`);
  process.exitCode = 2;
}

if (!existsSync(entry)) {
  unavailable();
} else {
  const child = spawn(process.execPath, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
    windowsHide: true,
  });
  const interrupt = () => child.kill('SIGINT');
  const terminate = () => child.kill('SIGTERM');
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', terminate);
  child.once('error', unavailable);
  child.once('close', (code, signal) => {
    process.off('SIGINT', interrupt);
    process.off('SIGTERM', terminate);
    process.exitCode = code ?? (signal === 'SIGINT' ? 130 : signal === 'SIGTERM' ? 143 : 2);
  });
}
