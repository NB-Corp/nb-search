# Developer and Specialist Sources

In addition to general web search engines, `nb-search` provides specialist sources for software engineering and technical documentation.

## GitHub repository search (`github.repositories`)

- **Operation contract**: `github/repositories`; outputs `nb-search.results@1`; supports `sync` and `async`.
- **Metadata labels**: Cost `free`; latency `fast`.
- **Configuration and authentication**:
  - Optional environment variable: `NB_SEARCH_GITHUB_TOKEN`
  - Always calls the official endpoint: `https://api.github.com/search/repositories`

::: warning Anonymous rate limits
This source still works without a GitHub Token (keyless mode), but GitHub applies very low rate limits to unauthenticated IP requests. Configure a Token in normal environments to avoid rate-limit errors.
:::

### Query example

```bash
node scripts/nb-search.mjs search "language:typescript stars:>1000 web search" \
  --lane github.repositories
```

## Context7 documentation search (`context7.docs`)

- **Operation contract**: `context7/docs`; outputs `nb-search.docs-context@1`; supports `sync` and `async`.
- **Metadata labels**: Cost `cheap`; latency `medium`.
- **Configuration and authentication**:
  - Optional environment variable: `NB_SEARCH_CONTEXT7_API_KEY`
  - Default endpoint: `https://context7.com` (calls `/api/v2/libs/search` and `/api/v2/context`)

When no API Key is configured, the source uses its public free mode. It returns documentation-context slices suitable for a coding assistant consulting a library manual.

### Query example

```bash
node scripts/nb-search.mjs search "fastify register plugins hook lifecycle" \
  --lane context7.docs
```
