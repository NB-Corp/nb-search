// proxy-from-env 2.1.0, Rob Wu, MIT (LICENSES/proxy-from-env.txt).
// Captured-environment typed port mechanically recovered from accepted next.7 app-xlqMoSP5.mjs:3368–3410.
const DEFAULT_PORTS: Readonly<Record<string, number>> = { ftp: 21, gopher: 70, http: 80, https: 443, ws: 80, wss: 443 };
type ProxyUrl = Partial<Pick<URL, 'host' | 'protocol' | 'port'>>;
function parseUrl(value: string): URL | null {
  try { return new URL(value); } catch { return null; }
}
export function getProxyForUrl(url: string | ProxyUrl | null, env: NodeJS.ProcessEnv): string {
  const parsed = typeof url === 'string' ? parseUrl(url) : url;
  if (parsed === null || !parsed.host || !parsed.protocol) return '';
  const proto = parsed.protocol.split(':', 1)[0]!;
  if (!shouldProxy(parsed.host.replace(/:\d*$/, ''), Number.parseInt(parsed.port!) || DEFAULT_PORTS[proto] || 0, env)) return '';
  let proxy = getEnv(proto + '_proxy', env) || getEnv('all_proxy', env);
  if (proxy && !proxy.includes('://')) proxy = proto + '://' + proxy;
  return proxy;
}
function shouldProxy(hostname: string, port: number, env: NodeJS.ProcessEnv): boolean {
  const noProxy = getEnv('no_proxy', env).toLowerCase();
  if (!noProxy) return true;
  if (noProxy === '*') return false;
  return noProxy.split(/[,\s]/).every(proxy => {
    if (!proxy) return true;
    const parsed = proxy.match(/^(.+):(\d+)$/);
    let proxyHostname = parsed ? parsed[1]! : proxy;
    const proxyPort = parsed ? Number.parseInt(parsed[2]!) : 0;
    if (proxyPort && proxyPort !== port) return true;
    if (!/^[.*]/.test(proxyHostname)) return hostname !== proxyHostname;
    if (proxyHostname.charAt(0) === '*') proxyHostname = proxyHostname.slice(1);
    return !hostname.endsWith(proxyHostname);
  });
}
function getEnv(key: string, env: NodeJS.ProcessEnv): string {
  return env[key.toLowerCase()] || env[key.toUpperCase()] || '';
}
