<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner-dark.svg">
  <img src="docs/assets/banner-light.svg" alt="nb-search — Give your agent a wider world." width="1200">
</picture>

**Search. Read. Research. One interface for your AI.**

[![Node.js](https://img.shields.io/badge/Node.js-24.15%2B-2d4b35?style=flat-square)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-2d4b35?style=flat-square)](LICENSE)
[![Documentation](https://img.shields.io/badge/docs-read_the_wiki-2d4b35?style=flat-square)](https://nb-corp.github.io/nb-search/)

[Quick start](#quick-start) · [Documentation](https://nb-corp.github.io/nb-search/) · [Sources](https://nb-corp.github.io/nb-search/sources/) · [Agent Skill](SKILL.md)

**English** · [简体中文](README.zh-CN.md)

</div>

Stop wiring a different tool for every source. **nb-search** gives agents and applications one TypeScript interface for web search, web reading and research—while you choose the providers.

Use it inside your app, from a terminal, as an MCP server, or through an agent Skill. Run locally with your credentials, or connect the same client interface to your own [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud) service.

<p align="center"><img src="docs/assets/workflow.svg" alt="Your agent or app → nb-search → search engines, documents and research providers" width="1200"></p>

## Why nb-search?

- **Bring more than one source.** Exa, Tavily, Brave, Grok, Jina, Firecrawl, GitHub and more. Combine search results or select a dedicated research operation. [Explore the catalog →](https://nb-corp.github.io/nb-search/sources/)
- **Research in parallel.** Send independent topics together. Use async jobs for long-running work, with status, cancellation and complete result retrieval.
- **Get usable output.** Structured results with source URLs, extracted documents, or typed research—not another wall of chat to reverse-engineer.
- **Keep your workflow.** SDK, CLI, MCP and Skill use the same runtime. Reuse your local provider configuration or connect a remote profile—without configuring every source in every assistant.

## Quick start

**Requires Node.js ≥ 24.15.** Install the CLI from the official npm registry:

```bash
npm install -g @nb-corp/nb-search@0.4.0 --registry=https://registry.npmjs.org
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

The command returns JSON. Extracted text is in `documents[].content`; `status` tells you whether extraction succeeded. This direct-fetch example needs no provider key.

For a source checkout, pnpm is needed only to install dependencies and build:

```bash
git clone https://github.com/NB-Corp/nb-search.git
cd nb-search
pnpm install --frozen-lockfile
pnpm build
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

The **0.5.0-next.4 source prerelease** searches the general web with DuckDuckGo by default, without registration, an API key or lane selection:

```bash
node scripts/nb-search.mjs search "NASA James Webb telescope"
```

DuckDuckGo's public HTML endpoint may issue a challenge or rate limit; these are reported as errors, not empty results. Wait before retrying, or explicitly choose another configured provider. `github.repositories` remains available for repository search. Configured defaults and explicit choices take precedence, including an explicitly removed default; failures never silently switch to a paid source. A *lane* is a named source operation. [Explore configuration →](https://nb-corp.github.io/nb-search/guide/configuration) Provider pricing and limits still apply.

This source prerelease also includes main-body Direct HTML extraction and configurable URL routing. Known GitHub raw text/repository JSON, npm metadata and PyPI JSON use Direct only by default; user rules can replace that list or restore your usual chain. Unmatched URLs still use the Direct-to-Jina default chain. Route decisions, actual attempts and content warnings are returned in receipts. [Routing configuration and host APIs →](docs/model-facing-lane-runtime.md#fetch) These changes are available from the source build/local prerelease package; the npm commands above still install the published 0.4.0.

## Multiple provider keys (local runtime)

Put up to 32 distinct keys, in priority order, in the existing credential environment variable, separated by commas: `NB_SEARCH_TAVILY_API_KEY="key-one,key-two"`. A single key remains valid. Custom `credential_slots.*.env` names use the same format. Keys are never included in config fingerprints or usage output. Configure scheduling per instance in `config.json` (schema version remains `"4"`):

```json
{
  "provider_instances": {
    "tavily.default": { "key_strategy": "priority", "balance_ttl_ms": 600000 }
  }
}
```

`key_strategy` defaults to `round-robin`; `priority` always selects the first available key, failing over in order. Both strategies quarantine 401/403 keys for the lifetime of the runtime, cool 429 keys using `Retry-After` (or 60 seconds), and retry 5xx/connection errors twice with bounded exponential backoff before moving to the next key. A 402 marks a key exhausted until its cache expires or a manual usage refresh restores it. State is in-memory and scoped to the provider instance/process (detached jobs each start a separate worker). The existing execution-level retry policy still applies after key-level attempts fail.

For supported providers, `createNbSearchRuntime().keyUsage({ provider_instance_id: 'tavily.default', refresh: true })` returns an array of key-indexed state and credit usage, with no key values. Omit `refresh` to use a 10-minute TTL cache (`balance_ttl_ms` accepts 60,000–86,400,000 milliseconds); avoid frequent forced refreshes because Tavily [limits usage checks to 10 per 10 minutes](https://docs.tavily.com/documentation/rate-limits#usage-endpoint-rate-limits). Search and fetch **never query balances before dispatch**; only this explicit method fetches them. Tavily's [key usage endpoint](https://docs.tavily.com/documentation/api-reference/endpoint/usage) reports key-level cycle usage/limit; Firecrawl's [team credit endpoint](https://docs.firecrawl.dev/api-reference/endpoint/credit-usage) reports **team-wide** remaining credits (the same balance can appear under multiple keys). Other providers return no usage entries, rather than claiming an unsupported balance API: Exa's [per-key historical spend API](https://exa.ai/docs/reference/team-management/get-api-key-usage) requires a separate team service key and does not report remaining balance. This method exists on the local SDK runtime only, not on remote, CLI or MCP transports.

## Search, fetch, inspect capabilities—and check key usage locally.

```bash
npm install @nb-corp/nb-search@0.4.0 --registry=https://registry.npmjs.org
```

```js
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const search = createNbSearchRuntime();
const page = await search.fetch({
  action: 'run',
  source: {
    kind: 'url',
    url: 'https://nodejs.org/en/about/releases/'
  },
  pipeline: 'direct.fetch'
});

if (page.action === 'run' && page.execution === 'sync' && page.status === 'succeeded' && page.documents.length > 0) {
  console.log(page.documents[0].content);
}
```

This example reads a public URL, so it needs network access but no provider key. Add `search.search()` for retrieval and `search.capabilities()` to inspect available operations. [SDK examples, MCP setup and remote clients →](https://nb-corp.github.io/nb-search/guide/integrations)

TypeScript consumers should use `skipLibCheck: true` with the current bundled declarations. [Compatibility details →](https://nb-corp.github.io/nb-search/guide/integrations)

## Bring your own script lane

Point a configured `script` provider at your trusted local JavaScript or erasable TypeScript module. Export `execute(request, context)` (or `search(query, context)`) and return a results array. The standard CLI and SDK support both sync and detached async jobs—no custom CLI wrapper or code-registration boilerplate required.

The runnable [local catalog example](examples/script-lane/config.json) needs no network or credentials. Set `NB_SEARCH_CONFIG` to that file, then run `nb-search search "Node" --lane local.search`. Relative module paths are resolved against the config file's directory; SDK inline config paths use the caller's working directory.

Scripts are trusted code with the same permissions as the runtime, not sandboxed plugins. Use `context.logger` for stderr diagnostics and honor `context.signal`; do not write to CLI stdout. [Module API, TypeScript limits and deployment guidance →](https://nb-corp.github.io/nb-search/sources/custom)

## Pick your entry point

| You want to… | Start here |
| --- | --- |
| Give an assistant search and research | [Official nb-search Skill](SKILL.md) |
| Convert web pages or files to Markdown | [nb-extract](https://github.com/NB-Corp/nb-extract) — web/file-to-Markdown document conversion entry point |
| Build an app or connect an MCP host | [Integration guide](https://nb-corp.github.io/nb-search/guide/integrations) |
| Share provider credentials with a team | [nb-search-cloud](https://github.com/NB-Corp/nb-search-cloud) — self-hosted users, keys and usage |

## Go deeper

[Configuration](https://nb-corp.github.io/nb-search/guide/configuration) · [Fetch](https://nb-corp.github.io/nb-search/guide/fetch) · [Async jobs](https://nb-corp.github.io/nb-search/guide/jobs) · [Troubleshooting](https://nb-corp.github.io/nb-search/guide/troubleshooting) · [Upgrading](https://nb-corp.github.io/nb-search/guide/upgrading)

Found a broken source, an integration gap, or a better example? [Open an issue](https://github.com/NB-Corp/nb-search/issues) or send a focused PR. Keep credentials out of reports.

[MIT](LICENSE) · Built by [NB-Corp](https://github.com/NB-Corp)
