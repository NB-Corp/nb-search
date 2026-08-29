const TRACKING_KEYS = new Set(['fbclid', 'gclid', 'dclid', 'msclkid', 'igshid']);

export function normalizeUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    return undefined;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
  if (url.username.length > 0 || url.password.length > 0) return undefined;

  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if ((url.protocol === 'http:' && url.port === '80') || (url.protocol === 'https:' && url.port === '443')) {
    url.port = '';
  }
  const entries = [...url.searchParams.entries()]
    .filter(([key]) => !key.toLowerCase().startsWith('utm_') && !TRACKING_KEYS.has(key.toLowerCase()))
    .sort(([leftKey, leftValue], [rightKey, rightValue]) =>
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue),
    );
  url.search = '';
  for (const [key, item] of entries) url.searchParams.append(key, item);
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}
