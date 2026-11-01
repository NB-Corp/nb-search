// Recovered from guarded-fetch 0.1.5 upstream commit bacdd4336d2b4b2474da02fb0e0c6212578964be (Apache-2.0).
export { guardedFetch, type GuardedFetchOptions } from './guarded-fetch.ts';
export {
  guardedFetchJson,
  guardedFetchText,
  type GuardedFetchBodyOptions,
} from './guarded-fetch-helpers.ts';
export {
  isPermanentGuardedFetchError,
  isGuardedFetchError,
  OPAQUE_ERROR_MESSAGE,
  GuardedFetchError,
  GuardedFetchErrorCode,
} from './errors.ts';
export {
  assertUrlIsSafeToFetch,
  type AssertUrlSafeOptions,
  type ValidatedFetchTarget,
} from './assert-url-safe.ts';
export {
  HostnameUnsafeSubReason,
  setUrlBlockedHandler,
  URL_BLOCKED_LOG_MESSAGE,
  type UrlBlockedEvent,
  type UrlBlockedHandler,
  type UrlBlockedSubReason,
} from './url-blocked.ts';
export {
  createGuardedDispatcher,
  getSharedGuardedDispatcher,
} from './guarded-dispatcher.ts';
export {
  createGuardedLookup,
  type GuardedLookupOptions,
} from './guarded-lookup.ts';
export { isSafeIpAddress } from './ip-address.ts';
export { sanitizeRequestHeaders, type HeadersLike } from './sanitize-headers.ts';
export {
  readBodyAsJson,
  readBodyAsText,
  type ReadBodyOptions,
} from './read-body.ts';
export { BLOCKED_REQUEST_HEADERS } from './blocked-headers.ts';
