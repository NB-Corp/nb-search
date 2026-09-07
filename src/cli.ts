#!/usr/bin/env node
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { capabilitiesInputSchema, fetchInputSchema, searchInputSchema } from './contracts.ts';
import { invalidInput, NbSearchError } from './errors.ts';
import { cliDoctor, cliPaths, initializeAdmissionStorage, jobBinding, loadCliConnection, type CliConnection } from './cli-config.ts';
import { outputExit, readAll, waitForJob } from './cli-job-reader.ts';
import { importSearchLayer } from './search-layer-import.ts';
import { NbSearchRemoteError } from './remote-protocol.ts';
import { PACKAGE_VERSION } from './version.ts';
import type { NbSearchRuntime } from './runtime.ts';
import type { FetchEnvelope, SearchEnvelope } from './types.ts';

export interface CliIo { stdout: { write(value: string): unknown }; stderr: { write(value: string): unknown }; stdin?: AsyncIterable<Uint8Array | string> }
export async function runCli(argv: readonly string[], io: CliIo = process, createRuntime?: () => NbSearchRuntime): Promise<number> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let waitExpired = false;
  try {
    if (!argv.length || (argv.length === 1 && ['--help', '-h'].includes(argv[0]!))) { io.stdout.write(HELP); return 0; }
    if (argv.length === 1 && argv[0] === '--version') { io.stdout.write(`${PACKAGE_VERSION}\n`); return 0; }
    const args = [...argv]; let profile: string | undefined;
    if (args[0] === '--profile' || args[0]?.startsWith('--profile=')) { const first = args.shift()!; profile = first.includes('=') ? first.slice(first.indexOf('=') + 1) : args.shift(); if (!profile || !/^[A-Za-z0-9_-]{1,64}$/.test(profile)) throw invalidInput('A valid profile name is required.'); }
    if (args[0] === '--doctor') { if (args.length !== 1) throw invalidInput('Doctor does not accept business arguments.'); const result = cliDoctor(profile); io.stdout.write(`${JSON.stringify(result)}\n`); return outputExit(result); }
    if (args[0] === '--import-search-layer') { if (profile) throw invalidInput('Migration does not accept a profile.'); const parsed = parse(args.slice(1), new Set(['source']), new Set(['dry-run', 'apply'])); if (parsed.positionals.length || Number(parsed.flags.has('dry-run')) + Number(parsed.flags.has('apply')) !== 1) throw invalidInput('Migration requires exactly one of --dry-run or --apply.'); const result = importSearchLayer({ apply: parsed.flags.has('apply'), ...(parsed.options['source'] ? { source: parsed.options['source'][0]! } : {}) }); io.stdout.write(`${JSON.stringify(result)}\n`); return outputExit(result); }
    const command = args.shift(); if (command !== 'search' && command !== 'fetch' && command !== 'capabilities') throw invalidInput('Unknown command. Expected search, fetch, or capabilities.');
    const action = command !== 'capabilities' && ['run', 'get', 'read', 'cancel'].includes(args[0] ?? '') ? args.shift()! : 'run';
    const allowed = command === 'capabilities' ? [] : action === 'read' ? ['cursor', 'page-size'] : action !== 'run' ? [] : command === 'search' ? ['query', 'lane', 'lanes', 'preset', 'execution', 'idempotency-key', 'freshness', 'max-results', 'timeout-ms'] : ['pipeline', 'representation', 'execution', 'idempotency-key', 'timeout-ms', 'max-content-chars'];
    const parsed = parse(args, new Set([...allowed, 'wait']), new Set(['stdin', 'all']));
    let input: unknown;
    if (parsed.flags.has('stdin')) { if (parsed.positionals.length || Object.keys(parsed.options).some((key) => key !== 'wait') || action !== 'run') throw invalidInput('Stdin JSON cannot be combined with request shorthands.'); input = await stdinJson(io.stdin ?? process.stdin); }
    else if (command === 'capabilities') { if (parsed.positionals.length) throw invalidInput('Capabilities accepts no positional arguments.'); input = {}; }
    else if (action !== 'run') { if (parsed.positionals.length !== 1) throw invalidInput('A single job ID is required.'); input = { action, job_id: parsed.positionals[0], ...fields(parsed.options) }; }
    else if (command === 'search') { const queries = [...parsed.positionals, ...(parsed.options['query'] ?? [])]; if (!queries.length) throw invalidInput('At least one query is required.'); const repeated = parsed.options['lane']; input = { action: 'run', query: queries.length === 1 ? queries[0] : queries, ...fields(parsed.options), ...(repeated ? repeated.length === 1 ? { lane: repeated[0] } : { lanes: repeated } : {}) }; }
    else { if (parsed.positionals.length !== 1) throw invalidInput('A single URL is required.'); input = { action: 'run', source: { kind: 'url', url: parsed.positionals[0] }, ...fields(parsed.options) }; }
    const validated = (command === 'search' ? searchInputSchema : command === 'fetch' ? fetchInputSchema : capabilitiesInputSchema).safeParse(input);
    if (!validated.success) throw invalidInput('The request does not match the command input schema.');
    const request = validated.data; const followup = 'action' in request && request.action !== 'run';
    const wait = parsed.options['wait'] ? integer(parsed.options['wait'][0]!) : undefined;
    if (wait !== undefined && (wait < 1 || wait > 3600000 || !('action' in request) || !(request.action === 'get' || request.action === 'run' && request.execution === 'async'))) throw invalidInput('--wait requires async run or get and a budget from 1 to 3600000 ms.');
    if (parsed.flags.has('all') && (!('action' in request) || request.action !== 'read' || request.cursor !== undefined || request.page_size !== undefined)) throw invalidInput('--all requires read without cursor or page-size.');
    if (!createRuntime && 'action' in request && request.action === 'run' && request.execution === 'async') initializeAdmissionStorage(cliPaths().home);
    const connection: CliConnection | undefined = createRuntime ? undefined : loadCliConnection(profile);
    const runtime = createRuntime ? createRuntime() : connection!.runtime;
    if (connection && followup && 'job_id' in request && command !== 'capabilities') jobBinding(connection, command, request.job_id);
    const controller = wait === undefined ? undefined : new AbortController(); const deadline = Date.now() + (wait ?? 0); if (controller) timer = setTimeout(() => { waitExpired = true; controller.abort(); }, wait);
    let output: unknown;
    if (command === 'capabilities') output = await runtime.capabilities();
    else if (parsed.flags.has('all') && 'job_id' in request) output = await readAll(runtime, command, request.job_id);
    else {
      const result = command === 'search' ? controller ? await runtime.search(searchInputSchema.parse(request), { signal: controller.signal }) : await runtime.search(searchInputSchema.parse(request)) : controller ? await runtime.fetch(fetchInputSchema.parse(request), { signal: controller.signal }) : await runtime.fetch(fetchInputSchema.parse(request));
      if (connection && 'job' in result && result.job) {
        try { jobBinding(connection, command, result.job.job_id, true); } catch { io.stdout.write(`${JSON.stringify(result)}\n`); throw new NbSearchError('CONFIGURATION_ERROR', 'The job started but its connection receipt could not be recorded. Preserve the receipt and use its original explicit profile.'); }
      }
      output = controller ? await waitForJob(runtime, command, result as SearchEnvelope | FetchEnvelope, deadline, controller.signal) : result;
    }
    io.stdout.write(`${JSON.stringify(output)}\n`); return outputExit(output);
  } catch (error) {
    const safe = waitExpired ? { code: 'DEADLINE_EXCEEDED', message: 'The CLI wait budget expired before an initial receipt was obtained. No cancellation was requested.', retryable: false } : error instanceof NbSearchRemoteError ? error.toJSON() : error instanceof NbSearchError ? { code: error.code, message: error.message, retryable: error.retryable } : { code: 'INTERNAL', message: 'The command failed. Check the invocation and local configuration.', retryable: false };
    io.stderr.write(`${JSON.stringify({ error: safe })}\n`); return safe.code === 'DEADLINE_EXCEEDED' ? 5 : safe.code === 'CANCELLED' ? 6 : 2;
  } finally { if (timer) clearTimeout(timer); }
}
function parse(args: string[], allowed: Set<string>, flagsAllowed: Set<string>) {
  const positionals: string[] = []; const options: Record<string, string[]> = {}; const flags = new Set<string>(); let ended = false;
  for (let i = 0; i < args.length; i++) { const arg = args[i]!; if (ended || !arg.startsWith('--')) { positionals.push(arg); continue; } if (arg === '--') { ended = true; continue; } const equal = arg.indexOf('='); const name = arg.slice(2, equal < 0 ? undefined : equal); if (flagsAllowed.has(name)) { if (equal >= 0 || flags.has(name)) throw invalidInput('A flag is duplicated or has an unexpected value.'); flags.add(name); continue; } if (!allowed.has(name)) throw invalidInput('Unknown option. Use --stdin for complete JSON or -- before option-like positional data.'); const value = equal >= 0 ? arg.slice(equal + 1) : args[++i]; if (value === undefined || equal < 0 && value.startsWith('--')) throw invalidInput('An option requires a value.'); if (options[name] && !['query', 'lane'].includes(name)) throw invalidInput('An option was repeated.'); (options[name] ??= []).push(value); }
  if (Number(!!options['lane']) + Number(!!options['lanes']) + Number(!!options['preset']) > 1) throw invalidInput('Lane selectors are mutually exclusive.');
  return { positionals, options, flags };
}
function fields(options: Record<string, string[]>): Record<string, unknown> { const result: Record<string, unknown> = {}; for (const [key, values] of Object.entries(options)) { if (['wait', 'query', 'lane'].includes(key)) continue; const value = values[0]!; result[key.replace(/-/g, '_')] = ['page-size', 'max-results', 'timeout-ms', 'max-content-chars'].includes(key) ? integer(value) : key === 'lanes' ? value.split(',') : value; } return result; }
function integer(value: string): number { if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw invalidInput('Numeric options must be decimal safe integers.'); return Number(value); }
async function stdinJson(stream: AsyncIterable<Uint8Array | string>): Promise<unknown> { const chunks: Buffer[] = []; let size = 0; for await (const chunk of stream) { const bytes = Buffer.from(chunk); size += bytes.length; if (size > 4 * 1024 * 1024) throw invalidInput('Stdin exceeds the 4 MiB limit.'); chunks.push(bytes); } try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)).replace(/^\uFEFF/, '')); } catch { throw invalidInput('Stdin must contain one complete UTF-8 JSON document.'); } }
const HELP = `nb-search ${PACKAGE_VERSION}\n\nUsage (global options precede command):\n  nb-search [--profile NAME] search [run] <query> [--lane ID|--lanes A,B|--preset NAME]\n  nb-search [--profile NAME] fetch [run] <url> [--pipeline ID]\n  nb-search [--profile NAME] capabilities\n  nb-search [--profile NAME] search|fetch --stdin [--wait MS]\n  nb-search [--profile NAME] search|fetch get JOB [--wait MS]\n  nb-search [--profile NAME] search|fetch read JOB [--all | --cursor CURSOR --page-size N]\n  nb-search [--profile NAME] search|fetch cancel JOB\n  nb-search [--profile NAME] --doctor\n  nb-search --import-search-layer [--source PATH] --dry-run|--apply\n\nAsync run: --execution async --idempotency-key KEY [--wait MS].\nUse --query=--leading-dashes, -- before positional data, or full --stdin JSON.\nLocal is the default; remote v1 fetch accepts URLs only. Waiting never cancels a job.\nExit: 0 success, 2 failed, 3 partial, 4 empty, 5 timeout, 6 cancelled, 7 pending.\n`;
if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runCli(process.argv.slice(2));
