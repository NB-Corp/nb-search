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

For search, set a provider key and choose its lane:

```bash
# Supply NB_SEARCH_EXA_API_KEY through your environment.
nb-search search "Node.js release schedule" --lane exa.search
```

A *lane* is a named source operation, such as `exa.search` or `gma.research`. Choose one explicitly or [set your default](https://nb-corp.github.io/nb-search/guide/configuration). Provider usage follows that provider's pricing and limits.

## Three methods. Plenty of room to build.

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
