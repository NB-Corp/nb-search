// Subprocess tests must never fall through to a real provider, even on regression.
const originalFetch = globalThis.fetch;
globalThis.fetch = function(input, init) {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.hostname === 'api.exa.ai' && process.env.NB_SEARCH_TEST_VENDOR_URL) {
    const target = new URL(process.env.NB_SEARCH_TEST_VENDOR_URL);
    if (target.hostname !== '127.0.0.1') throw new Error('Invalid test vendor mapping.');
    target.pathname = url.pathname;
    return originalFetch(target, init);
  }
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new Error('Test blocked non-loopback network request.');
  return originalFetch(input, init);
};
