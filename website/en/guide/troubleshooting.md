# Troubleshooting

This page summarizes common `nb-search` error codes, their causes, and the corresponding fixes.

## CLI exit-code quick reference

| Exit code | Meaning | Description |
|---:|---|---|
| `0` | Success | The operation succeeded, including an offline doctor check, capability output, or an acknowledged cancellation request |
| `2` | Error | Invalid call parameters, configuration errors, network-transfer errors, protocol-validation failures, job failures, or a migration block |
| `3` | Partial success | The logical result is `partial`, or the migration report is partially complete |
| `4` | Empty result | Search or fetch completed successfully but matched no results |
| `5` | Wait timeout | The `--wait` budget was exhausted, or the underlying task reached its timeout threshold |
| `6` | Cancelled | The job was explicitly cancelled by the caller |
| `7` | Job in progress | The asynchronous job is still in `queued` or `running` state |

## Diagnose core error codes

### `DEFAULT_NOT_CONFIGURED`

- **Cause**: In version `0.5.0` and later, `defaults.search_lane = "duckduckgo.search"` is configured by default. This error occurs only when the configuration file or a host override explicitly clears `defaults.search_lane` (sets it to `null`) and the search call does not pass `--lane`, `--lanes`, or `--preset`.
- **Fix**: Pass an explicit `--lane <lane_id>` on the command line, or restore `"defaults": { "search_lane": "duckduckgo.search" }` (or another configured source such as `"tavily.search"`) in `config.json`.

### `CREDENTIAL_NOT_CONFIGURED` / `LANE_NOT_CONFIGURED`

- **Cause**: The environment-variable key required by the target Lane is missing or an empty string, or the Provider instance is disabled.
- **Fix**: Run `node scripts/nb-search.mjs capabilities` to inspect what is missing for the Lane, then set the corresponding `NB_SEARCH_*_API_KEY` in the environment or in a protected credential file.

### `ENDPOINT_NOT_CONFIGURED`

- **Cause**: A source that requires a custom base endpoint (such as `searxng.search`, `gma.research`, or `oac.synthesis`) was used without configuring its BASE_URL environment variable.
- **Fix**: Check that variables such as `NB_SEARCH_SEARXNG_BASE_URL` or `NB_SEARCH_GROK_MULTI_AGENT_BASE_URL` are set.

### `LANE_EXECUTION_UNSUPPORTED`

- **Cause**: The requested execution mode is not supported by the source. For example, a synchronous request was sent to the asynchronous-only `browser.render`, or an asynchronous request was sent to a custom query that supports only synchronous execution.
- **Fix**: Use the static capability catalog to select a supported `sync` or `async` `execution` mode.

### `FETCH_CHAIN_UNAVAILABLE`

- **Cause**: No Pipeline was specified, and the built-in default fetch chain cannot satisfy the current input source, or none of the Pipelines in the chain is ready.
- **Fix**: Specify the concrete Pipeline explicitly with `--pipeline`, or complete the `fetch_chain` configuration for the relevant input type.

### `FETCH_BLOCKED`

- **Cause**: The target URL violates the SSRF security policy, including a private IP, loopback address, cloud metadata address, or a redirect to a private-network address.
- **Fix**: Ensure that the target is a publicly resolvable public HTTP(S) address. SSRF protection is a hard policy and cannot be bypassed.

### `FETCH_BYTES_LIMIT`

- **Cause**: A fetch input source (local text or file) exceeds `execution.fetch.max_source_bytes`, or an HTTP response body exceeds `max_response_bytes`.
- **Handling**: Distinguish the input and response paths. An oversized local input is rejected before entering the Pipeline; an oversized third-party proxy-fetch API response fails as a transport error; the `direct.fetch` Pipeline may truncate an oversized response within bounds and return it. See [Content Fetching: Security Limits](/en/guide/fetch#security-limits-and-network-protection) for the exact mechanism. Optimize the target content or adjust configuration for the actual scenario; do not blindly increase the limit.

### `FETCH_CONTENT_TYPE_REJECTED`

- **Cause**: The response MIME type is not in the allowlist.
- **Fix**: Confirm that the target content type is `text/html`, `text/plain`, or `text/markdown`.

### `QUALITY_GATE_FAILED`

- **Cause**: The fetched body has fewer characters than the explicitly configured lower gate (`min_content_chars`), or it contains a blocking marker.
- **Fix**: Check whether the target site requires JavaScript rendering. If so, use `browser.render` asynchronously, or adjust `quality.min_content_chars` in the configuration.

### `OUTPUT_TOO_LARGE`

- **Cause**: In synchronous mode, the response envelope exceeds `execution.max_inline_bytes` (16 MiB by default).
- **Handling**: The system does not automatically truncate a synchronous envelope. In fetch pipelines, `direct.fetch` and `direct.local` support both `sync` and detached `async`; `browser.render` supports only `async`; the other six third-party cloud pipelines (`jina.reader`, `exa.contents`, `tavily.extract`, `firecrawl.scrape`, `wayback.fetch`, and `oac.fetch`) support only `sync`. When the limit is exceeded, fetch can reduce `max_content_chars` (or explicitly use `--execution async` on a pipeline that supports asynchronous execution), while search can reduce `max_results` or switch to `--execution async`. Rerunning a paid-source request may incur additional charges; check the budget first.

### `ENTRY_UNAVAILABLE`

- **Cause**: The build artifact `dist/cli.mjs` cannot be found when starting through `scripts/nb-search.mjs`.
- **Fix**: When running from source, first run `pnpm build` from the repository root. When bringing it in as a Skill dependency, make sure the entire `dist/` directory is present.

## Offline configuration validation and capability inspection

When diagnosing configuration or credential-binding problems, start with the offline diagnostic command:

```bash
node scripts/nb-search.mjs --doctor
```

This command validates only local configuration syntax and the presence of credential environment variables. It reports syntax and slot summaries, but it does not prove that runtime ports are ready and does not make an external network request to verify that credentials are actually usable.

To view source readiness and supported execution modes:

```bash
node scripts/nb-search.mjs capabilities
```

In the returned catalog, inspect each source's `availability` (`ready` or `unavailable`), `issues` list, and supported `execution_modes`. Even `ready` means only that local initialization completed; it does not indicate the upstream service's current network connectivity or quota health.
