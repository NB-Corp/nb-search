# Changelog

## 0.4.0 - 2026-09-08

### Added

- Added trusted local JavaScript and erasable TypeScript script lanes, configured through the standard SDK/CLI provider settings, with synchronous and detached asynchronous execution.
- Exported script module types and included a runnable, no-network example.
- Added `resolveProviderOperation` for offline host inspection of Exa, GMA and script operations, sharing validation, defaults and endpoint resolution with the actual adapters.

### Compatibility

- Existing search/fetch/capabilities calls and in-process provider registrations remain supported. Script modules run with host permissions and must cooperate with cancellation; they are not sandboxed or content-pinned.
- Cloud hosts can reuse SDK operation metadata instead of duplicating provider protocols. Unsupported offline endpoint resolution is reported explicitly.

## 0.3.1 - 2026-09-08

### Fixed

- GMA requests now use streaming for both chat and messages protocols, with complete SSE parsing and rejection of interrupted or failed responses.
- GMA research defaults to a 10-minute deadline unless a request or configuration explicitly supplies a timeout; ordinary search keeps its 30-second default.
- HTTP 524 is classified as retryable for callers with an explicit retry policy.

### Changed

- Added bilingual product landing pages and themed SVG assets.
- Clarified search and webpage reading in nb-search, with document conversion and resource export available through nb-extract. Existing fetch interfaces remain compatible.
- Published the official CLI, MCP and Skill entry points to npm, including the changes documented under 0.3.0.

## 0.3.0 - 2026-09-08

### Added

- Added the callable remote client SDK (`createNbSearchRemoteClient`) and HTTP protocol v1 client contract with strict response validation, bounded streams, non-retry policy, and URL-only fetch boundaries.
- Added formal CLI profiles, `--stdin` single UTF-8 JSON inputs, `--wait` budget execution, complete artifact reconstruction via `read --all`, default local follow-ups with explicit profile requirement for remote jobs (`get`, `read`, `cancel`), and standardized exit codes (`0`, `2`, `3`, `4`, `5`, `6`, `7`).
- Added official skill launcher support for package root and nested `skills/nb-search` structures.
- Added explicit offline migration tooling (`--import-search-layer --dry-run` and `--apply`) with separate protected credential storage (`secrets.json` and `remote-secrets.json`).
- Added GMA `messages` relay contract and strict HTTP 3xx redirect rejection to protect credentials from unintended forwarding.
- Added concurrent reader snapshot coordination, safe writer transaction markers, and lane purpose catalog guidance (`src/lane-guidance.ts` and `scripts/lane-guidance.mjs`).
- Added trusted in-process `http_transport` injection option to `createNbSearchRuntime` with root exports for `HttpRequest`, `HttpResponse`, `HttpTransport`, and `ResponseLimitError`.
- Added VitePress documentation site framework, continuous integration checks, and release readiness verification tooling.

### Changed

- Simplified local environment admission by removing redundant ACL/owner/mode checks and initialization barriers while preserving standard file creation modes and symlink/junction support.
- Updated default fetch quality rules to `min_content_chars: 0` and `blocked_markers: []`, and raised default synchronous `max_inline_bytes` to 16 MiB.
- Updated GMA adapter to version 2; in-flight version-1 jobs must complete before upgrade.
- Configuration schema `4` and result schema `3.0` remain unchanged; HTTP protocol `1` has its own version.
- Local readers no longer require a persistent global command lock; follow-up job commands default to the local connection.

## 0.2.0 - 2026-09-04

### Added

- Added the public `runtime.fetch` action union, default fetch chains, nine built-in fetch pipelines, and sync/async fetch job envelopes.
- Added schema-v4 configuration inputs and parsers for in-process hosts: `CanonicalConfigPatch`, `parseConfigPatch`, and `parseResolvedConfig`.
- Added provider registrations, fifteen built-in search lanes, typed query operations, presets, and explicit default-lane selection.
- Added capability descriptors for providers, configured provider instances, search lanes, fetch pipelines, defaults, readiness, redacted credential status, and the extensible `CapabilityIssueCode` type.
- Added packaged `SKILL.md`, `.env.example`, and runtime contract documentation, plus the optional Playwright peer dependency for browser rendering.

### Changed

- Replaced the 0.1 research-specific runtime methods with the generic `search` and `fetch` `run | get | read | cancel` action unions.
- Updated public envelopes and error codes to schema version `3.0`; configuration uses schema version `4`.
- A search call without an explicit selector now uses `defaults.search_lane` and returns `DEFAULT_NOT_CONFIGURED` when no default is configured.
- Credential slots are provider-scoped; a provider instance cannot consume a slot declared for another provider.
