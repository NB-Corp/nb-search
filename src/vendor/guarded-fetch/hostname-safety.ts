// Recovered from guarded-fetch 0.1.5 source map (Apache-2.0); NB Search synthetic-DNS addition where noted.
import type { LookupAddress } from 'node:dns';
import { lookup } from 'node:dns/promises';
import net from 'node:net';

import { isAddressUnsafeForServerSideFetch } from './ip-address.ts';
import {
  HostnameUnsafeSubReason,
  type HostnameUnsafeSubReason as HostnameUnsafeSubReasonType,
} from './url-blocked.ts';

/**
 * Normalizes a host or `https://host:port`-style value to a hostname for DNS
 * lookup. Kept package-local so guarded-fetch does not rely on monorepo helpers.
 */
export function parseHostnameForOutboundLookup(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) {
    return '';
  }
  try {
    if (trimmed.includes('://')) {
      return new URL(trimmed).hostname;
    }
    return new URL(`https://${trimmed}`).hostname;
  } catch {
    return trimmed.split(':')[0] ?? '';
  }
}

export type HostnameSafetyResult =
  | { safe: true }
  | { safe: false; subReason: HostnameUnsafeSubReasonType };

/**
 * Classifies whether `hostname` is safe for server-side outbound HTTP(S).
 * Uses the same OS resolver path that undici's connect-time lookup uses.
 */
export async function checkHostnameSafetyForServerSideFetch(
  hostname: string,
  targetUrl?: URL,
  allowSyntheticDnsAddress?: (address: string, target: URL) => boolean,
): Promise<HostnameSafetyResult> {
  const host = hostname.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');
  if (!host) {
    return { safe: false, subReason: HostnameUnsafeSubReason.INVALID };
  }
  if (host === 'localhost' || host.endsWith('.localhost')) {
    return { safe: false, subReason: HostnameUnsafeSubReason.LOCALHOST };
  }
  if (host.endsWith('.local')) {
    return { safe: false, subReason: HostnameUnsafeSubReason.LOCAL_DOMAIN };
  }

  if (net.isIP(host)) {
    return isAddressUnsafeForServerSideFetch(host)
      ? { safe: false, subReason: HostnameUnsafeSubReason.IP_LITERAL_UNSAFE }
      : { safe: true };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookup(host, { all: true, verbatim: true });
  } catch {
    return {
      safe: false,
      subReason: HostnameUnsafeSubReason.DNS_RESOLUTION_FAILED,
    };
  }

  if (addresses.length === 0) {
    return {
      safe: false,
      subReason: HostnameUnsafeSubReason.DNS_RESOLUTION_FAILED,
    };
  }

  if (
    addresses.some(({ address }) => isAddressUnsafeForServerSideFetch(address) && !allowSyntheticDnsAddress?.(address, targetUrl!))
  ) {
    return {
      safe: false,
      subReason: HostnameUnsafeSubReason.DNS_UNSAFE_ADDRESS,
    };
  }

  return { safe: true };
}
