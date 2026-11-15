# Content Fetching (Fetch)

`nb-search` primarily uses `fetch` to read the content of public web URLs after search. Existing entry points such as `fetch`, `direct.local`, and `browser.render` remain available for compatibility; the contract for controlled local files and inline inputs appears below. To process local files, HTML, PDF, or Office documents (including OCR) and save complete Markdown and assets, use the separate [nb-extract](https://github.com/NB-Corp/nb-extract) tool.

## Architectural distinction: Envelope and Document Schema

A fetch call returns an outer envelope with `schema_version: "3.0"`. Successfully extracted content is stored in the top-level `documents` array. Each document follows the fetch pipeline's `nb-search.fetch@1` operation contract.

## Input types and representations

### Input source (Source Kind)

- `url`: A public HTTP(S) address.
- `file`: A local file. Only relative paths are allowed, and the path must be inside a configured `file_scopes` authorization directory.
- `inline_text` / `inline_bytes`: A string or Base64-encoded data passed directly in memory.

### Output representation (Representation)

- `markdown` (default): Clean Markdown text. `direct.fetch` uses **Defuddle + linkedom** for static HTML extraction of body text, links, mathematical formulas, and code blocks (it does not execute page scripts or make additional network requests), preserves plain-text whitespace, formats JSON, and locally decodes Base64 UTF-8 responses from `api.github.com` `contents` / `readme` endpoints within the byte limit.
- `text`: Plain text.

## Ordered URL routing (`fetch.routing`) and fetch chains

For public `url` requests, the runtime determines the pipeline sequence to execute using the following fixed priority, and **strictly tries only the pipelines in the selected sequence**:

1. **Explicit `--pipeline <id>`**: When the caller names a pipeline, run only that pipeline.
2. **The first matching enabled user rule (`fetch.routing.rules`)**: Run the ordered `pipelines` declared by the rule, or restore the default chain with `"use": "default"`.
3. **The enabled built-in rule package (`kiki-common-direct@1`, enabled by default)**: Route known plain-text `raw.githubusercontent.com`, `api.github.com` repository metadata/directories/README/Release data, `registry.npmjs.org` package metadata, and `pypi.org` JSON to **`direct.fetch` only**. A failure is reported directly; Jina or commercial paid scrapers are never appended silently.
4. **The default `defaults.fetch_chain`**:
   - **Default chain for URL input**: Use keyless `direct.fetch` first (supports `sync` and detached `async`), then try the keyless or optionally keyed `jina.reader` (`sync`) if a fallback is needed.
   - **Default chain for local files and inline data**: Use only `direct.local` (no external egress, `egress: "none"`, and not part of URL routing).

You can customize domain and path glob rules in `config.json`. The routing decision and every attempt are recorded in the returned receipt's top-level `routing` and `lane_outcomes[].attempts` fields:

```json
{
  "schema_version": "4",
  "fetch": {
    "routing": {
      "rules": [
        {
          "id": "docs-direct-then-jina",
          "match": {
            "origin": "https://raw.githubusercontent.com",
            "path_globs": ["/**/*.md"]
          },
          "action": {
            "pipelines": ["direct.fetch", "jina.reader"]
          }
        },
        {
          "id": "npm-restore-default-chain",
          "match": {
            "origin": "https://registry.npmjs.org"
          },
          "action": {
            "use": "default"
          }
        }
      ]
    }
  }
}
```

### Error termination and failover boundaries (Fallback)

In a fetch chain, **fallback is not the same as a network retry**; it means trying the next pipeline in the chain in order. When the default chain tries multiple pipelines, a fallback service such as `jina.reader` may receive the target URL. To call exactly one pipeline, specify `--pipeline <id>` explicitly.

Not every failure triggers fallback:

- **Terminal errors**: A `404` or `410` status, SSRF blocking (`FETCH_BLOCKED`), a content type outside the allowlist (`FETCH_CONTENT_TYPE_REJECTED`), caller cancellation (`CANCELLED`), a timeout (`DEADLINE_EXCEEDED`), or an exceeded budget (`BUDGET_EXCEEDED`) terminates the entire fetch immediately; the next pipeline is not tried.
- **Fallback-triggering errors**: A failed quality gate (`QUALITY_GATE_FAILED`), response bytes over the limit (`FETCH_BYTES_LIMIT`), upstream authentication failure (`PROVIDER_AUTH`), rate limiting (`PROVIDER_RATE_LIMIT`), service unavailability (`PROVIDER_UNAVAILABLE`), an internal error (`INTERNAL`), or an HTTP error other than `404`/`410` records the current outcome and moves to the next candidate pipeline.

## Pipeline selection: default chain vs. explicit selection

The built-in default chain contains only `direct.fetch` and `jina.reader`. Other fetch pipelines—including `exa.contents`, `tavily.extract`, `firecrawl.scrape`, `wayback.fetch`, `browser.render`, `oac.fetch`, and local `direct.local`—are not enabled in the default URL chain. You can:

1. Specify `--pipeline <id>` when making the call.
2. Define your own default pipeline chain in the host configuration's `defaults.fetch_chain`.

Example of explicit selection:

```bash
# Fetch a historical Wayback snapshot of the page
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline wayback.fetch
```

## Security limits and network protection

The fetch system enforces the following security policies and boundary controls:

1. **URL validation and SSRF protection**:
   - General preflight (`parsePublicUrl`) checks URL syntax and the literal hostname/IP, rejecting URLs with usernames or passwords, invalid protocols, or literal private/loopback IP addresses.
   - Built-in direct fetching (`direct.fetch`) applies strict local-network protection: before connecting, it resolves DNS, validates every returned IP, and pins the connection. It repeats resolution and strict checks for every HTTP redirect, blocking redirects to private-network or metadata addresses.
   - Third-party proxy-fetch pipelines such as `jina.reader`, `exa.contents`, and `tavily.extract` send requests from their cloud services; this machine cannot control internal DNS resolution or redirects at the target site.
2. **Byte and character limit handling**:
   - During direct HTTP fetching, if a `direct.fetch` response exceeds `max_response_bytes`, the system may truncate it within bounds, records `FETCH_BYTES_LIMIT` in `warnings`, and sets `documents[].truncated: true`.
   - If the extracted body exceeds `max_content_chars`, the body is truncated and `FETCH_CONTENT_CHARS_LIMIT` is recorded in `warnings`.
   - If local `inline_text`, `inline_bytes`, or `file` input exceeds `max_source_bytes`, it is rejected before entering the pipeline with `FETCH_BYTES_LIMIT`.
   - If an API response from a third-party proxy-fetch pipeline (Jina, Exa, Tavily, Firecrawl, and others) exceeds the client's transport limit (`max_response_bytes`), that pipeline fails with `FETCH_BYTES_LIMIT`; the incomplete API response is not treated as successful content.
   - The default quality rules set no minimum body-length gate (`min_content_chars: 0`) and no default blocking markers (`blocked_markers: []`). If the host explicitly configures a custom quality gate, truncated content must still pass that gate and the final envelope inline-size limit (`max_inline_bytes`) before it can be returned as a success.
   - Even when the complete JSON Artifact is read with the CLI's `read --all`, that means only that the job artifact file was read in full; it does not mean that the fetched upstream web page was not truncated.
3. **MIME-type allowlist**: Non-text/HTML types are rejected with `FETCH_CONTENT_TYPE_REJECTED`.
4. **Envelope inline-size limit**: If the complete synchronous result envelope exceeds `execution.max_inline_bytes` (16 MiB by default), the system returns `OUTPUT_TOO_LARGE`.
