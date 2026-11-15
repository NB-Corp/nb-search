# Upgrading

This page explains version rules, important protocol-evolution notes, and compatibility boundaries when upgrading from an older release to the current version.

## Version coverage

This page covers important compatibility boundaries for `@nb-corp/nb-search` as it evolves from `0.3.x` / `0.4.x` to `0.5.2`. Before upgrading or investigating compatibility, check the locally installed version and read the [CHANGELOG](/en/reference/changelog).

Update the CLI or project SDK from the official npm registry:

```bash
# Global CLI
npm install -g @nb-corp/nb-search
# Project SDK
npm install @nb-corp/nb-search
```

## Upgrade notes

### 0.5.1–0.5.2: Explicit Zhihu opt-in, multi-key rotation, and `keyUsage()`

- **Opt-in Zhihu adapter (`zhihu`)**: Adds `zhihu.search`, `zhihu.global`, and `zhihu.synthesis`, but does not inject any instance, credential slot, or Lane into the built-in default configuration. Upgrading does not affect existing default configuration. See [Web search sources: Explicitly enable Zhihu](/en/sources/web-search#zhihu) for the enablement method and free-quota gate.
- **Up to 32-key pool and `keyUsage()`**: Existing `NB_SEARCH_*_API_KEY` environment variables remain compatible with both a single key and a comma-separated multi-key list. The local SDK adds `runtime.keyUsage()` (`LocalNbSearchRuntime`); the remote client and MCP tool list remain unchanged.

### 0.5.0: Keyless default search, Defuddle direct fetch, and ordered URL routing

- **Default search source (`duckduckgo.search`)**: When `defaults.search_lane` is not explicitly configured, general search uses keyless `duckduckgo.search` by default. If an upstream host depends on the old behavior of returning `DEFAULT_NOT_CONFIGURED` when no default source exists, explicitly set `"defaults": { "search_lane": null }` in `config.json`.
- **Defuddle direct fetch and URL routing (`kiki-common-direct@1`)**: `direct.fetch` now uses Defuddle 0.19.3 + linkedom for static extraction and supports asynchronous jobs. Built-in URL routing sends known GitHub Raw/API, npm, and PyPI JSON targets strictly to `direct.fetch` (you can override or disable this through `fetch.routing`).
- **In-progress job fingerprint changes**: The `duckduckgo` (v2), `direct-http`, and the new `crawl`/`research` operations in the `tavily` adapter update operation fingerprints. Before upgrading, wait for in-progress jobs from the old version to finish; persisted old snapshots are not silently rebuilt.

### 0.4.0: Script provider/Lane

`0.4.0` added the `script` provider/Lane. It can reuse the existing CLI, SDK, and detached asynchronous job entry points without changing the existing API. Historical notes for the 0.2→0.3 upgrade still apply as written.

### 1. GMA protocol evolution and mode matching

In early development snapshots, the GMA (Grok Multi-Agent) adapter had a different structure from the current version:

- After the GMA adapter upgraded from Version 1 to Version 2, the new adapter could not deserialize old in-progress job snapshots. Before upgrading, make sure long-running old tasks have finished.
- The new version supports an explicit `options.api_mode`:
  - `chat_completions`: The endpoint appends `/chat/completions`.
  - `messages`: The endpoint appends `/messages` and uses the structured relay contract.
- **Endpoint-conflict protection**: If the configured Base URL already contains a suffix that does not match the mode (for example, putting Grok's `/responses` in a GMA endpoint), the system reports an error and disables the instance. It does not silently fall back.

### 2. Grok Responses independence

`grok.synthesis` and `grok.x-synthesis` are built on the independent Grok Responses API and call the `/v1/responses` endpoint directly. They are not interchangeable with the traditional Chat Completions interface. If you migrate an old configuration, credentials that supported only Chat Completions cannot be used automatically for the new Responses operations.

### 3. Configuration Schema evolution and search-layer migration

The current runtime uses **Configuration Schema Version 4** (`schema_version: "4"`).

- If you maintain credentials from an early search layer (such as `SEARCH_LAYER_CREDENTIALS` or `~/.openclaw/credentials/search.json`), use the CLI's explicit import feature (`nb-search --import-search-layer --dry-run`) to preview a mapping report. After confirming that there are no conflicts, apply it with `--apply`. This tool is not a general-purpose upgrader for arbitrary old versions; see the [CLI migration guide](/en/reference/cli) for the exact rules.
- Some private environment variables from early versions (such as `NB_SEARCH_GROK_MULTI_AGENT_API_KEY`) have been normalized in standard Schema v4. The default GMA slot environment variable is now unified with Grok as `NB_SEARCH_GROK_API_KEY`.

### 4. Concurrency control and state recovery

In the execution configuration, `max_concurrency` (default `8`) and `max_provider_calls` (default `64`) control concurrency and call budgets inside one query execution. They are not a global queue shared by multiple independent CLI processes.

- When multiple tasks or processes run and encounter a configuration-write conflict, wait for the preceding write or migration to finish.
- If an abnormal process termination reports unreleased state, do not blindly delete the `jobs` artifact directory, backup files, or unknown locks. Follow the CLI diagnostics to confirm configuration and credential consistency before recovering.
