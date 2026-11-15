# Quickstart

This guide shows how to prepare a local runtime, inspect the available capability catalog, and verify your first search and fetch operations.

::: info Version range
This documentation applies to `@nb-corp/nb-search` `0.5.0` and later (current version: `0.5.2`).
:::

## Requirements

- **Node.js**: `>=24.15.0`
- **Source build tool**: `pnpm@10.33.0` (required only when building from the source repository)

## Get and build

::: code-group

```bash [Global CLI]
npm install -g @nb-corp/nb-search
nb-search search "WebAssembly component model"
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```bash [Project SDK]
npm install @nb-corp/nb-search
```

```bash [Build from source]
git clone https://github.com/NB-Corp/nb-search.git
cd nb-search
pnpm install --frozen-lockfile
pnpm build
```

:::

The installed package and source build both provide the official launcher. When using the package as a Skill, keep the package root and the complete `SKILL.md`, `scripts/`, and `dist/` structure; copying only part of the directory causes the launcher to return `ENTRY_UNAVAILABLE`.

### Load the official Skill

A host agent or workflow environment can mount the npm package or source directory directly as a Skill:

- **Global npm install**: After running `npm install -g @nb-corp/nb-search`, use `$(npm root -g)/@nb-corp/nb-search/skills/nb-search` (or the package root, `$(npm root -g)/@nb-corp/nb-search`); for a project-local installation, use `node_modules/@nb-corp/nb-search/skills/nb-search`.
- **Source build**: Set the repository root as `<skill_dir>`.
- **Invocation contract**: The Skill dispatch script is fixed at `node "<skill_dir>/scripts/nb-search.mjs"`. The launcher locates and loads the packaged `dist/cli.mjs` automatically, so the host does not need any additional system PATH configuration.
- **Nested layout**: The package also includes a compatible `skills/nb-search` entry point for hosts with a particular layout. It is not an independently movable package and still depends on `scripts/` and the build output in the root directory. Preserve the relative paths to the package root.

### CLI debugging entry points

- When installed as an npm dependency: use `node node_modules/@nb-corp/nb-search/scripts/nb-search.mjs`, or invoke the local executable with `npx nb-search`.
- From a source checkout: run `node scripts/nb-search.mjs` from the repository root.

The rest of this guide uses `nb-search` for the entry command. When debugging from the source root, replace `nb-search` with `node scripts/nb-search.mjs`; when debugging in an application project, replace it with `npx nb-search`.

## Step 1: View the capabilities catalog

The `capabilities` command prints the list of Providers, Lanes, and Pipelines supported by the current runtime. It does not require any Provider keys and does not probe external services.

::: code-group

```bash [POSIX (Linux / macOS)]
nb-search capabilities
```

```powershell [Windows PowerShell]
nb-search capabilities
```

:::

The output is a JSON object that conforms to the global `3.0` Schema Envelope. Before any third-party keys are configured, most Lanes that require external credentials are marked as not ready, but the static catalog remains fully available.

::: tip Status note
`ready` in the output means only that the local configuration and runtime ports have been initialized. It does not indicate upstream Provider network connectivity, quota, or service health.
:::

## Step 2: Verify keyless fetching

Verify that the local runtime can use a public web page with body content, or test with `direct.local` inline content without accessing the network:

::: code-group

```bash [POSIX (public URL fetch)]
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```powershell [Windows PowerShell (public URL fetch)]
nb-search fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch
```

```bash [POSIX (offline local inline-data verification)]
nb-search fetch --stdin << 'EOF'
{"action":"run","source":{"kind":"inline_text","content":"Hello, nb-search local fetch verification.","media_type":"text/plain"},"pipeline":"direct.local"}
EOF
```

:::

After a successful fetch, the returned Envelope object has a top-level `schema_version: "3.0"` property, and the extracted documents are in the top-level `documents` array. The fetch operation contract for an individual pipeline follows `nb-search.fetch@1`.

## Step 3: Keyless search and BYOK multi-source search

In version `0.5.0` and later, general web search defaults to the keyless `duckduckgo.search` (and also includes the keyless `github.repositories` and `context7.docs`), so you can run your first search without configuring an API key:

```bash
nb-search search "VitePress sitemap generation"
nb-search search "react useOptimistic" --lane context7.docs
nb-search search "language:typescript model context protocol" --lane github.repositories
```

::: warning Keyless-source error boundary
If the public HTML endpoint for `duckduckgo.search` triggers human verification or `429` rate limiting, the CLI returns an explicit error code. It **never fakes an empty result and never silently switches to a paid API**. `DEFAULT_NOT_CONFIGURED` is returned only when the default source has been explicitly cleared (`"defaults": { "search_lane": null }`) and the command does not pass `--lane`.
:::

After adding your own commercial API keys (BYOK), you can select one high-precision engine or use `--lanes` for multi-source RRF deduplication and fusion:

::: code-group

```bash [POSIX (Linux / macOS)]
export NB_SEARCH_TAVILY_API_KEY="YOUR_API_KEY"
export NB_SEARCH_EXA_API_KEY="YOUR_API_KEY"
nb-search search "site:github.com node" --lanes exa.search,tavily.search
```

```powershell [Windows PowerShell]
$env:NB_SEARCH_TAVILY_API_KEY = "YOUR_API_KEY"
$env:NB_SEARCH_EXA_API_KEY = "YOUR_API_KEY"
nb-search search "site:github.com node" --lanes exa.search,tavily.search
```

:::

After execution, `stdout` returns an execution Envelope whose top level includes `schema_version: "3.0"`. Its `output` contains an `nb-search.results@1` object (or a single-source Typed Schema such as `context7.docs`). To change the default source, configure rotation for up to 32 keys, or set URL routing, see the [Configuration System Guide](/en/guide/configuration).
