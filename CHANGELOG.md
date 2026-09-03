# Changelog

## 0.2.0 - 2026-09-04

### Added

- Added the public `runtime.fetch` action union, default fetch chains, nine built-in fetch pipelines, and sync/async fetch job envelopes.
- Added schema-v4 configuration inputs and parsers for in-process hosts: `CanonicalConfigPatch`, `parseConfigPatch`, and `parseResolvedConfig`.
- Added provider registrations, fifteen built-in search lanes, typed query operations, presets, and explicit default-lane selection.
- Added capability descriptors for providers, configured provider instances, search lanes, fetch pipelines, defaults, readiness, and redacted credential status.
- Added the packaged `SKILL.md` export and optional Playwright peer dependency for browser rendering.

### Changed

- Replaced the 0.1 research-specific runtime methods with the generic `search` and `fetch` `run | get | read | cancel` action unions.
- Updated public envelopes and error codes to schema version `3.0`; configuration uses schema version `4`.
- A search call without an explicit selector now uses `defaults.search_lane` and returns `DEFAULT_NOT_CONFIGURED` when no default is configured.
