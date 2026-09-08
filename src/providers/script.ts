import { isAbsolute, extname } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { NbSearchError } from '../errors.ts';
import { redactText } from '../redaction.ts';
import type { ProviderRegistration, ProviderFactoryContext } from '../provider-registry.ts';
import type { HttpTransport } from '../transport.ts';
import type { JsonValue, ProviderResult, QueryExecutionRequest } from '../types.ts';

/** Trusted local module API. Modules execute with the host process's permissions. */
export interface ScriptContext {
  signal: AbortSignal;
  options: Readonly<Record<string, JsonValue>>;
  credential?: string;
  transport: HttpTransport;
  logger: { info(message: string): void; warn(message: string): void; error(message: string): void };
}
export type ScriptRequest = QueryExecutionRequest;
export type ScriptResults = readonly ProviderResult[];
export interface ScriptModule {
  execute?: (request: ScriptRequest, context: ScriptContext) => ScriptResults | Promise<ScriptResults>;
  search?: (query: string, context: ScriptContext & { request: ScriptRequest }) => ScriptResults | Promise<ScriptResults>;
}

export const scriptRegistration: ProviderRegistration = {
  descriptor: { provider_id: 'script', adapter_version: '1', query_operations: [{ operation_id: 'search', output: { channel: 'results', schema_id: 'nb-search.results@1' }, built_in_async: true }], fetch_operations: [], activation: { credential: 'none', endpoint: 'none' }, option_keys: ['module', 'params'] },
  validate(_id, instance) {
    const module = instance.options['module']; const params = instance.options['params'];
    if (Object.keys(instance.options).some((key) => !['module', 'params'].includes(key)) || typeof module !== 'string' || !module.trim() || module.includes('\0') || !['.js', '.mjs', '.ts', '.mts'].includes(extname(module)) || (params !== undefined && !z.record(z.string(), z.json()).safeParse(params).success)) {
      throw new NbSearchError('CONFIGURATION_ERROR', 'Script options require a local .js/.mjs/.ts/.mts module path and optional params object.');
    }
  },
  create(factory) {
    const module = factory.instance.options['module'] as string;
    if (!isAbsolute(module)) throw new NbSearchError('CONFIGURATION_ERROR', 'Script module path must be resolved before provider creation.');
    const redactions = [module, ...(factory.credential === undefined ? [] : [factory.credential.value])];
    // Loading is deliberately lazy: capabilities/config validation never execute code.
    let loaded: Promise<ScriptModule> | undefined;
    return { fetch: {}, query: { search: { name: 'script', redactions, async execute(request) {
      try {
        request.signal.throwIfAborted();
        loaded ??= import(/* @vite-ignore */ pathToFileURL(module).href) as Promise<ScriptModule>;
        const script = await loaded;
        request.signal.throwIfAborted();
        const context = scriptContext(factory, request, redactions);
        const rows = typeof script.execute === 'function' ? await script.execute(request, context)
          : typeof script.search === 'function' ? await script.search(request.query, { ...context, request })
          : undefined;
        request.signal.throwIfAborted();
        if (!Array.isArray(rows) || rows.some((row) => row === null || typeof row !== 'object' || typeof row.title !== 'string' || typeof row.url !== 'string')) throw new Error('invalid results');
        return { channel: 'results' as const, value: { results: rows } };
      } catch (error) {
        if (request.signal.aborted) throw error;
        // User module errors can contain credentials, source text, or local paths.
        throw new NbSearchError('PROVIDER_UNAVAILABLE', 'Script module failed to load, execute, or return a results array.', false, 'script');
      }
    } } } };
  },
};
function scriptContext(factory: ProviderFactoryContext, request: ScriptRequest, redactions: readonly string[]): ScriptContext {
  const log = (message: string): void => { process.stderr.write(`[script] ${redactText(String(message), redactions)}\n`); };
  return { signal: request.signal, options: structuredClone((factory.instance.options['params'] ?? {}) as Record<string, JsonValue>), ...(factory.credential === undefined ? {} : { credential: factory.credential.value }), transport: factory.transports.http, logger: { info: log, warn: log, error: log } };
}
