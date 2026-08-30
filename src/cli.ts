#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createNbSearchRuntime } from './index.ts';
import type { NbSearchRuntime } from './runtime.ts';
import { invalidInput, publicError } from './errors.ts';
import {
  FRESHNESS_VALUES, SEARCH_INTENTS, SEARCH_PROFILE_IDS,
  type Freshness, type JobState, type ResearchArtifact, type SearchIntent, type SearchProfileId,
} from './types.ts';

export interface CliIo { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown } }
export async function runCli(
  argv: readonly string[],
  io: CliIo = process,
  createRuntime: () => NbSearchRuntime = () => createNbSearchRuntime(),
): Promise<number> {
  try {
    if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) { io.stdout.write(HELP); return 0; }
    const runtime = createRuntime(); const command = argv[0]; let output: unknown;
    if (command === 'capabilities') { assertNoExtra(argv.slice(1)); output = await runtime.capabilities(); }
    else if (command === 'search') output = await runSearch(runtime, argv.slice(1));
    else if (command === 'research') output = await runResearch(runtime, argv.slice(1));
    else if (command?.startsWith('-')) throw invalidInput(`Unknown option: ${command}.`);
    else output = await runSearch(runtime, argv);
    io.stdout.write(`${JSON.stringify(output, null, 2)}\n`); return isFailure(output) ? 2 : 0;
  } catch (error) {
    io.stderr.write(`${JSON.stringify({ error: publicError(error, error instanceof Error ? error.message : 'The command failed.') })}\n`); return 2;
  }
}
async function runSearch(runtime: NbSearchRuntime, argv: readonly string[]): Promise<unknown> {
  const parsed = parse(argv, new Set(['--max-results', '--timeout-ms', '--profile', '--intent', '--freshness']));
  if (parsed.positionals.length !== 1) throw invalidInput('Search requires exactly one query argument.');
  return await runtime.search({ query: parsed.positionals[0]!,
    ...(parsed.options['--max-results'] === undefined ? {} : { max_results: integer(parsed.options['--max-results'], '--max-results') }),
    ...(parsed.options['--timeout-ms'] === undefined ? {} : { timeout_ms: integer(parsed.options['--timeout-ms'], '--timeout-ms') }),
    ...routingOptions(parsed.options) });
}
async function runResearch(runtime: NbSearchRuntime, argv: readonly string[]): Promise<unknown> {
  const action = argv[0];
  if (action === 'start') {
    const parsed = parse(argv.slice(1), new Set([
      '--max-sources', '--max-duration-ms', '--idempotency-key', '--profile', '--intent', '--freshness',
    ]));
    if (parsed.positionals.length !== 1) throw invalidInput('research start requires exactly one query argument.');
    return await runtime.researchStart({ query: parsed.positionals[0]!,
      ...(parsed.options['--max-sources'] === undefined ? {} : { max_sources: integer(parsed.options['--max-sources'], '--max-sources') }),
      ...(parsed.options['--max-duration-ms'] === undefined ? {} : { max_duration_ms: integer(parsed.options['--max-duration-ms'], '--max-duration-ms') }),
      ...(parsed.options['--idempotency-key'] === undefined ? {} : { idempotency_key: parsed.options['--idempotency-key'] }),
      ...routingOptions(parsed.options) });
  }
  if (action === 'status') return await runtime.researchStatus({ job_id: exactlyOne(argv.slice(1), 'research status requires one job_id.') });
  if (action === 'cancel') return await runtime.researchCancel({ job_id: exactlyOne(argv.slice(1), 'research cancel requires one job_id.') });
  if (action === 'read') {
    const parsed = parse(argv.slice(1), new Set(['--artifact', '--cursor', '--page-size']));
    if (parsed.positionals.length !== 1) throw invalidInput('research read requires one job_id.');
    const artifact = parsed.options['--artifact'];
    if (artifact !== undefined && artifact !== 'summary' && artifact !== 'report' && artifact !== 'sources') throw invalidInput('--artifact must be summary, report, or sources.');
    return await runtime.researchRead({ job_id: parsed.positionals[0]!, ...(artifact === undefined ? {} : { artifact: artifact as ResearchArtifact }),
      ...(parsed.options['--cursor'] === undefined ? {} : { cursor: parsed.options['--cursor'] }),
      ...(parsed.options['--page-size'] === undefined ? {} : { page_size: integer(parsed.options['--page-size'], '--page-size') }) });
  }
  if (action === 'list') {
    const parsed = parse(argv.slice(1), new Set(['--states', '--cursor', '--limit']));
    if (parsed.positionals.length !== 0) throw invalidInput('research list does not accept positional arguments.');
    const states = parsed.options['--states']?.split(',').filter(Boolean) as JobState[] | undefined;
    return await runtime.researchList({ ...(states === undefined ? {} : { states }),
      ...(parsed.options['--cursor'] === undefined ? {} : { cursor: parsed.options['--cursor'] }),
      ...(parsed.options['--limit'] === undefined ? {} : { limit: integer(parsed.options['--limit'], '--limit') }) });
  }
  throw invalidInput('research requires start, status, read, list, or cancel.');
}
function parse(argv: readonly string[], allowed: ReadonlySet<string>): { positionals: string[]; options: Record<string, string> } {
  const positionals: string[] = []; const options: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) { const item = argv[index]!;
    if (!item.startsWith('--')) { positionals.push(item); continue; }
    if (!allowed.has(item)) throw invalidInput(`Unknown option: ${item}.`);
    const value = argv[index + 1]; if (value === undefined || value.startsWith('--')) throw invalidInput(`${item} requires a value.`);
    options[item] = value; index += 1;
  } return { positionals, options };
}
function exactlyOne(values: readonly string[], message: string): string {
  const value = values[0];
  if (values.length !== 1 || value === undefined || value.startsWith('-')) throw invalidInput(message);
  return value;
}
function integer(value: string, name: string): number { const parsed = Number(value); if (!Number.isSafeInteger(parsed)) throw invalidInput(`${name} must be an integer.`); return parsed }
function assertNoExtra(values: readonly string[]): void { if (values.length > 0) throw invalidInput('capabilities does not accept arguments.') }
function routingOptions(options: Readonly<Record<string, string>>) {
  const profile = options['--profile'];
  const intent = options['--intent'];
  const freshness = options['--freshness'];
  if (profile !== undefined && !(SEARCH_PROFILE_IDS as readonly string[]).includes(profile)) {
    throw invalidInput('--profile must be default, fast, or deep.');
  }
  if (intent !== undefined && !(SEARCH_INTENTS as readonly string[]).includes(intent)) {
    throw invalidInput('--intent must be factual, status, comparison, tutorial, exploratory, news, or resource.');
  }
  if (freshness !== undefined && !(FRESHNESS_VALUES as readonly string[]).includes(freshness)) {
    throw invalidInput('--freshness must be pd, pw, pm, or py.');
  }
  return {
    ...(profile === undefined ? {} : { profile: profile as SearchProfileId }),
    ...(intent === undefined ? {} : { intent: intent as SearchIntent }),
    ...(freshness === undefined ? {} : { freshness: freshness as Freshness }),
  };
}
function isFailure(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return false;
  const envelope = value as { mode?: unknown; state?: unknown };
  return envelope.mode === 'search' && (envelope.state === 'failed' || envelope.state === 'timed_out' || envelope.state === 'cancelled');
}
const HELP = `nb-search 0.1.0\n\nUsage:\n  nb-search "<query>" [--max-results N] [--timeout-ms N] [--profile default|fast|deep] [--intent INTENT] [--freshness pd|pw|pm|py]\n  nb-search search "<query>" [--max-results N] [--timeout-ms N] [--profile default|fast|deep] [--intent INTENT] [--freshness pd|pw|pm|py]\n  nb-search research start "<query>" [--max-sources N] [--max-duration-ms N] [--idempotency-key KEY] [--profile default|fast|deep] [--intent INTENT] [--freshness pd|pw|pm|py]\n  nb-search research status <job_id>\n  nb-search research read <job_id> [--artifact summary|report|sources] [--cursor CURSOR] [--page-size N]\n  nb-search research list [--states state,state] [--cursor CURSOR] [--limit N]\n  nb-search research cancel <job_id>\n  nb-search capabilities\n`;
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
