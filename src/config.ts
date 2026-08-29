import { homedir } from 'node:os';
import { resolve } from 'node:path';

import { NbSearchError } from './errors.ts';
import { ExaProvider, TavilyProvider } from './providers.ts';
import { FetchJsonTransport, type JsonTransport } from './transport.ts';
import type { SearchProvider } from './types.ts';

export interface AppConfiguration {
  home: string;
  jobs_root: string;
  retention_hours: number;
  log_level: 'error' | 'warn' | 'info' | 'debug';
  providers: SearchProvider[];
  provider_configured: Record<'exa' | 'tavily', boolean>;
}

export function loadConfiguration(env: NodeJS.ProcessEnv = process.env, transport: JsonTransport = new FetchJsonTransport()): AppConfiguration {
  const home = resolve(nonempty(env['NB_SEARCH_HOME']) ?? resolve(homedir(), '.nb-search'));
  const exaKey = nonempty(env['NB_SEARCH_EXA_API_KEY']) ?? nonempty(env['EXA_API_KEY']);
  const tavilyKey = nonempty(env['NB_SEARCH_TAVILY_API_KEY']) ?? nonempty(env['TAVILY_API_KEY']);
  const providers: SearchProvider[] = [];
  if (exaKey !== undefined) providers.push(new ExaProvider({ apiKey: exaKey, transport }));
  if (tavilyKey !== undefined) providers.push(new TavilyProvider({ apiKey: tavilyKey, transport }));
  return {
    home,
    jobs_root: resolve(home, 'jobs'),
    retention_hours: positiveNumber(env['NB_SEARCH_RETENTION_HOURS'], 72, 'NB_SEARCH_RETENTION_HOURS'),
    log_level: logLevel(env['NB_SEARCH_LOG_LEVEL']),
    providers,
    provider_configured: { exa: exaKey !== undefined, tavily: tavilyKey !== undefined },
  };
}

function nonempty(value: string | undefined): string | undefined { const item = value?.trim(); return item === '' ? undefined : item }
function positiveNumber(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new NbSearchError('CONFIGURATION_ERROR', `${name} must be a positive number.`);
  return parsed;
}
function logLevel(value: string | undefined): AppConfiguration['log_level'] {
  const level = value?.trim().toLowerCase() || 'warn';
  if (level === 'error' || level === 'warn' || level === 'info' || level === 'debug') return level;
  throw new NbSearchError('CONFIGURATION_ERROR', 'NB_SEARCH_LOG_LEVEL must be error, warn, info, or debug.');
}
