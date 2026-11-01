// Mechanically recovered from accepted next.7 app-xlqMoSP5.mjs:3412–3454; type annotations restored.
import { isIP } from 'node:net';
import { Agent, ProxyAgent } from 'undici';
import ipaddr from 'ipaddr.js';
import { createGuardedDispatcher } from './vendor/guarded-fetch/index.ts';
import { getProxyForUrl } from './vendor/proxy-from-env.ts';
import type { DirectFetchIo } from './direct-acquisition.ts';

const syntheticRange = ipaddr.parseCIDR('198.18.0.0/15');
export function directFetchIoForEnvironment(env: NodeJS.ProcessEnv): DirectFetchIo {
  const captured = Object.freeze(Object.fromEntries([
    'http_proxy', 'HTTP_PROXY', 'https_proxy', 'HTTPS_PROXY',
    'all_proxy', 'ALL_PROXY', 'no_proxy', 'NO_PROXY',
  ].map(name => [name, env[name]])));
  const selectedProxy = (target: URL): string | undefined => {
    const configured = getProxyForUrl(target, captured);
    if (configured === '') return undefined;
    let proxy: URL;
    try { proxy = new URL(configured); } catch { return; }
    if (proxy.protocol === 'socks5h:') proxy.protocol = 'socks5:';
    return ['http:', 'https:', 'socks5:', 'socks:'].includes(proxy.protocol) ? proxy.href : undefined;
  };
  if (!Object.values(captured).some(value => value !== undefined && value !== '')) return {};
  return {
    createDispatcher() {
      return new Agent({ factory(origin) {
        const proxy = selectedProxy(new URL(String(origin)));
        return proxy === undefined ? createGuardedDispatcher() : new ProxyAgent(proxy);
      } });
    },
    allowSyntheticDnsAddress(address, target) {
      return selectedProxy(target) !== undefined && isIP(address) === 4 && ipaddr.parse(address).match(syntheticRange);
    },
  };
}
