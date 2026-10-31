import { z } from 'zod';

export const FETCH_ROUTING_PACKAGE = { id: 'kiki-common-direct', version: '1', maintainer: 'Kiki', summary: 'Known GitHub raw text and repository JSON endpoints, npm metadata, and PyPI JSON; direct-only.' } as const;
export function canonicalFetchUrl(value: string): URL {
  const url = new URL(value);
  if (url.hostname.endsWith('.')) url.hostname = url.hostname.slice(0, -1);
  return url;
}
const idSchema = z.string().trim().min(1).max(256);
const originSchema = z.string().refine((value) => {
  try { const url = canonicalFetchUrl(value); return ['http:', 'https:'].includes(url.protocol) && url.username === '' && url.password === '' && url.pathname === '/' && url.search === '' && url.hash === ''; } catch { return false; }
}, 'origin must be a credential-free HTTP(S) origin without a path, query or fragment');
const pathGlobSchema = z.string().min(1).max(4096).refine((value) => value.startsWith('/') && !/[?{}\[\]\\]/.test(value) && !value.includes('***'), 'path glob must start with / and use only * or ** wildcards');
export const fetchRouteActionSchema = z.union([
  z.object({ pipelines: z.array(idSchema).min(1).max(64) }).strict().refine((value) => new Set(value.pipelines).size === value.pipelines.length, 'pipelines must be unique'),
  z.object({ use: z.literal('default') }).strict(),
]);
export const fetchRouteRuleSchema = z.object({
  id: idSchema, enabled: z.boolean().optional(),
  match: z.object({ origin: originSchema, path_globs: z.array(pathGlobSchema).min(1).max(128).optional(), representation: z.enum(['markdown', 'text']).optional() }).strict(),
  action: fetchRouteActionSchema,
}).strict();
export const fetchRoutingConfigSchema = z.object({ enabled: z.boolean().optional(), builtin_enabled: z.boolean().optional(), disabled_builtin_rules: z.array(idSchema).max(64).optional(), rules: z.array(fetchRouteRuleSchema).max(256).optional() }).strict().superRefine((value, context) => {
  const seen = new Set<string>();
  for (const [index, rule] of (value.rules ?? []).entries()) { if (seen.has(rule.id)) context.addIssue({ code: 'custom', path: ['rules', index, 'id'], message: 'rule ids must be unique' }); seen.add(rule.id); }
});
export type FetchRouteAction = z.infer<typeof fetchRouteActionSchema>;
export type FetchRouteRule = z.infer<typeof fetchRouteRuleSchema>;
export type FetchRoutingConfig = z.infer<typeof fetchRoutingConfigSchema>;
export const fetchRouteDecisionSchema = z.object({ origin: z.enum(['explicit', 'user', 'builtin', 'default']), rule_id: z.string().optional(), package_id: z.string().optional(), package_version: z.string().optional(), pipelines: z.array(z.string()).min(1), representation: z.enum(['markdown', 'text']), execution: z.enum(['sync', 'async']) }).strict();
export type FetchRouteDecision = z.infer<typeof fetchRouteDecisionSchema>;
export const fetchRoutingCapabilitySchema = z.object({ enabled: z.boolean(), builtin_enabled: z.boolean(), package: z.object({ id: z.string(), version: z.string(), maintainer: z.string(), summary: z.string() }), builtin_rules: z.array(fetchRouteRuleSchema), disabled_builtin_rules: z.array(z.string()), rules: z.array(fetchRouteRuleSchema) });
export type FetchRoutingCapability = z.infer<typeof fetchRoutingCapabilitySchema>;
const directRule = (id: string, origin: string, path_globs: string[]): FetchRouteRule => ({ id, match: { origin, path_globs }, action: { pipelines: ['direct.fetch'] } });
export const BUILTIN_FETCH_ROUTE_RULES: readonly FetchRouteRule[] = Object.freeze([
  directRule('github-raw-text', 'https://raw.githubusercontent.com', [
    ...['md', 'markdown', 'txt', 'rs', 'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'py', 'nix', 'json', 'plist', 'c', 'h', 'cpp', 'hpp', 'toml', 'yaml', 'yml', 'xml', 'sh', 'bash', 'css', 'html', 'htm', 'csv', 'sql', 'go', 'java', 'kt', 'rb', 'swift', 'vue', 'svelte', 'ini', 'cfg', 'conf', 'lock'].map((extension) => `/**/*.${extension}`),
    ...['README', 'LICENSE', 'COPYING', 'NOTICE', 'Makefile', 'Dockerfile', '.gitignore', '.gitattributes', '.editorconfig'].map((name) => `/**/${name}`),
  ]),
  directRule('github-repository-json', 'https://api.github.com', ['/repos/*/*', '/repos/*/*/contents', '/repos/*/*/contents/**', '/repos/*/*/readme', '/repos/*/*/releases', '/repos/*/*/releases/*', '/repos/*/*/releases/tags/*']),
  directRule('npm-metadata', 'https://registry.npmjs.org', ['/*', '/*/*', '/@*/*/*']),
  directRule('pypi-json', 'https://pypi.org', ['/pypi/*/json', '/pypi/*/*/json']),
].map((rule) => { Object.freeze(rule.match.path_globs); Object.freeze(rule.match); if ('pipelines' in rule.action) Object.freeze(rule.action.pipelines); Object.freeze(rule.action); return Object.freeze(rule); }));
export function pathMatchesGlob(path: string, glob: string): boolean {
  let pattern = '^';
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === '*') { if (glob[index + 1] === '*') { pattern += '.*'; index += 1; } else pattern += '[^/]*'; }
    else pattern += char.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
  }
  return new RegExp(`${pattern}$`).test(path);
}
export function selectFetchRoute(input: { url?: string; pipeline?: string; representation?: 'markdown' | 'text'; execution?: 'sync' | 'async' }, routing: FetchRoutingConfig | undefined, defaultPipelines: readonly string[]): FetchRouteDecision {
  const base = { representation: input.representation ?? 'markdown' as const, execution: input.execution ?? 'sync' as const };
  if (input.pipeline !== undefined) return { ...base, origin: 'explicit', pipelines: [input.pipeline] };
  if (input.url !== undefined && routing?.enabled !== false) {
    const url = canonicalFetchUrl(input.url);
    const matches = (rule: FetchRouteRule) => rule.enabled !== false && canonicalFetchUrl(rule.match.origin).origin === url.origin && (rule.match.representation === undefined || rule.match.representation === base.representation) && (rule.match.path_globs ?? ['/**']).some((glob) => pathMatchesGlob(url.pathname, glob));
    const user = routing?.rules?.find(matches);
    if (user !== undefined) return { ...base, origin: 'user', rule_id: user.id, pipelines: 'pipelines' in user.action ? [...user.action.pipelines] : [...defaultPipelines] };
    const builtin = routing?.builtin_enabled === false ? undefined : BUILTIN_FETCH_ROUTE_RULES.find((rule) => !routing?.disabled_builtin_rules?.includes(rule.id) && matches(rule) && !(rule.id === 'npm-metadata' && url.pathname.includes('/-/')));
    if (builtin !== undefined) return { ...base, origin: 'builtin', rule_id: builtin.id, package_id: FETCH_ROUTING_PACKAGE.id, package_version: FETCH_ROUTING_PACKAGE.version, pipelines: [...('pipelines' in builtin.action ? builtin.action.pipelines : defaultPipelines)] };
  }
  return { ...base, origin: 'default', pipelines: [...defaultPipelines] };
}
export function fetchRoutingCapability(config: FetchRoutingConfig | undefined): FetchRoutingCapability {
  return { enabled: config?.enabled !== false, builtin_enabled: config?.builtin_enabled !== false, package: FETCH_ROUTING_PACKAGE, builtin_rules: structuredClone([...BUILTIN_FETCH_ROUTE_RULES]), disabled_builtin_rules: [...config?.disabled_builtin_rules ?? []], rules: structuredClone(config?.rules ?? []) };
}
