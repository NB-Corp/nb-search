import { createHash } from 'node:crypto';
import type { AppConfiguration } from './config.ts';

const PRIORITY = { error: 0, warn: 1, info: 2, debug: 3 } as const;
export class Logger {
  constructor(private readonly level: AppConfiguration['log_level'], private readonly output: Pick<NodeJS.WriteStream, 'write'> = process.stderr) {}
  write(level: keyof typeof PRIORITY, event: string, fields: Readonly<Record<string, unknown>> = {}): void {
    if (PRIORITY[level] > PRIORITY[this.level]) return;
    this.output.write(`${JSON.stringify({ level, event, ...fields })}\n`);
  }
}
export function queryFingerprint(query: string): string { return createHash('sha256').update(query.trim()).digest('hex').slice(0, 16) }
