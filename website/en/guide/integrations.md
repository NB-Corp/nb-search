# Integration Methods

`nb-search` provides five common integration forms: the Node.js / TypeScript SDK, the CLI, an MCP `stdio` server, an Agent Skill, and a Remote HTTP protocol client. All forms share the same Schema v4 configuration and `3.0` result-envelope contract.

## 1. Node.js / TypeScript SDK

The SDK is suitable for embedding directly in a Node.js backend service or Agent host process. It requires Node.js `>=24.15.0`.

### Search, capability catalog, and key-quota inspection

```typescript
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = createNbSearchRuntime({
  config: {
    schema_version: '4',
    defaults: {
      search_lane: 'brave.search'
    }
  }
});

// 1. Run a synchronous search
const searchResponse = await runtime.search({
  action: 'run',
  query: 'node 24 LTS release notes',
  execution: 'sync'
});

// 2. Get static capability-catalog metadata (does not probe the network)
const catalog = await runtime.capabilities();

// 3. Inspect redacted multi-key health status and remaining quota (local SDK only)
const usage = await runtime.keyUsage();
```

### Read URL content

Reading web-page content is the primary fetch scenario for `nb-search`:

```typescript
const fetchResponse = await runtime.fetch({
  action: 'run',
  source: {
    kind: 'url',
    url: 'https://nodejs.org/en/about/releases/'
  },
  representation: 'markdown',
  execution: 'sync'
});

if (fetchResponse.action === 'run' && fetchResponse.execution === 'sync' && fetchResponse.status === 'succeeded' && fetchResponse.documents.length > 0) {
  console.log(fetchResponse.documents[0]!.content);
}
```

### Compatibility: offline, network-free content fetching

`direct.local` and its inline/file inputs remain available for cleaning and extracting authorized local text or HTML within the process without sending data over the network. To process local files, HTML, PDF, or Office documents (including OCR) and save complete Markdown and assets, use the separate [nb-extract](https://github.com/NB-Corp/nb-extract) tool:

```typescript
import { createNbSearchRuntime } from '@nb-corp/nb-search';

const runtime = await createNbSearchRuntime();

const fetchResponse = await runtime.fetch({
  action: 'run',
  source: {
    kind: 'inline_text',
    content: 'Hello, nb-search offline fetch.',
    media_type: 'text/plain'
  },
  pipeline: 'direct.local',
  execution: 'sync'
});

if (fetchResponse.action === 'run' && fetchResponse.execution === 'sync' && fetchResponse.status === 'succeeded' && fetchResponse.documents.length > 0) {
  const doc = fetchResponse.documents[0]!;
  console.log('Document fetched successfully, content:', doc.content);
}
```

The local SDK runtime (`LocalNbSearchRuntime`) exposes **four core methods**: `search`, `fetch`, `capabilities`, and the machine-local-only `keyUsage` (see [Multi-key rotation and local quota inspection](/en/guide/configuration#multi-key-rotation-and-local-quota-inspection-keyusage)). The general `NbSearchRuntime` and remote-client interfaces include the first three transport-independent methods.

### TypeScript consumer compatibility note

The verified SDK consumer build settings use `skipLibCheck: true`. In a TypeScript 6.0.2 environment, enabling complete third-party declaration checking (`skipLibCheck: false`) causes the compiler to report variance-check errors (TS2636) in the bundled Zod type declarations. Setting `skipLibCheck: true` skips only rechecking declaration files in external dependency packages; it does not lower the strict type-checking level for your application's own code. Projects that require exhaustive dependency-declaration checking should evaluate this compatibility characteristic before integration.

### Advanced host injection: Trusted HTTP Transport

For environments that need centralized auditing or proxying of host-process network traffic, `createNbSearchRuntime({ http_transport })` accepts an object implementing the root-exported `HttpTransport` interface (and also exports `HttpRequest`, `HttpResponse`, and `ResponseLimitError`). The underlying Provider adapters receive this custom transport and use it for their outbound HTTP requests. Note:

- Injecting a transport disables detached asynchronous jobs for the current runtime instance (they return `LANE_EXECUTION_UNSUPPORTED`); only synchronous (`sync`) execution is available.
- `direct.fetch`, `wayback.fetch`, `browser.render`, and custom Providers may use independent network channels and are not guaranteed to be globally controlled by this injected object. See the [model runtime specification](/en/reference/runtime) for the detailed advanced contract.

## 2. Command-line tool (CLI)

The CLI is suitable for scripted batch processing, local operations and debugging, or invocation as an independent child process.

```bash
# Run a search
node scripts/nb-search.mjs search "site:github.com vitest" --lane exa.search

# Fetch a page
node scripts/nb-search.mjs fetch "https://nodejs.org/en/about/releases/" --pipeline direct.fetch

# View the capability catalog
node scripts/nb-search.mjs capabilities
```

The CLI also accepts a complete JSON parameter object through standard input, which is useful for complex structured parameters or Agent-host dispatch:

```bash
echo '{"action":"run","query":"typescript","lane":"tavily.search","execution":"sync"}' | \
  node scripts/nb-search.mjs search --stdin
```

::: warning Stdin rules
When using `--stdin`, the input must be one complete UTF-8 JSON object and must not exceed 4 MiB. Do not mix positional arguments on the command line.
:::

## 3. MCP server (`stdio`) and Agent Skill

### MCP server (approximately 1.4k context tokens)

`nb-search` natively implements a Model Context Protocol (MCP) `stdio` service. It registers exactly **three structured tools**—`search`, `fetch`, and `capabilities`—which can save more than 90% of the tool-schema context overhead compared with mounting four or five vendor MCP servers at once.

Connect through `npx` in `Claude Code`, `Claude Desktop`, `Codex`, or `Cursor` (the `env` block can be omitted when using only keyless default sources):

```json
{
  "mcpServers": {
    "nb-search": {
      "command": "npx",
      "args": ["-y", "--package=@nb-corp/nb-search", "nb-search-mcp"],
      "env": {
        "NB_SEARCH_TAVILY_API_KEY": "YOUR_API_KEY",
        "NB_SEARCH_EXA_API_KEY": "YOUR_API_KEY"
      }
    }
  }
}
```

If you have built the source locally or installed dependencies, you can also run `node dist/mcp.mjs` directly. All MCP tool parameters use strict JSON Schema field names (`action: "run" | "get" | "read" | "cancel"`).

### Agent Skill (approximately 110 idle tokens)

In CLI-capable coding agents such as `Claude Code`, `Codex`, or `OpenCode`, mounting the built-in Agent Skill keeps idle context to approximately 110 tokens and loads the full protocol only when a retrieval task is triggered:

```bash
npm install -g @nb-corp/nb-search
# Point the host's Skill directory at skills/nb-search inside the global package (or at the package root).
echo "$(npm root -g)/@nb-corp/nb-search/skills/nb-search"
```

## 4. Remote protocol client (Remote Client)

The TypeScript remote client also runs in a Node.js environment (`createNbSearchRemoteClient` is a synchronous factory function and does not require `await`). If another language or service needs to integrate without a Node dependency, it can implement requests directly according to [HTTP Protocol v1](/en/reference/remote-protocol).

```typescript
import { createNbSearchRemoteClient } from '@nb-corp/nb-search';

const accessKey = process.env.NB_SEARCH_REMOTE_KEY;
if (!accessKey) {
  throw new Error('Missing NB_SEARCH_REMOTE_KEY environment variable');
}

// Create the client synchronously; no await is needed.
const client = createNbSearchRemoteClient({
  base_url: 'https://search.example.test/api/',
  access_key: accessKey
});

const result = await client.search({
  action: 'run',
  query: 'distributed systems',
  lane: 'searxng.search',
  execution: 'sync'
});
```

### Important remote-protocol constraints

- **URL-only fetching**: A remote client's `fetch` request supports only a public `url` input. The client rejects `inline_text`, `inline_bytes`, and `file` inputs before making a network request.
- **No silent redirects or retries**: The remote client treats 3xx status codes as protocol errors and never forwards authentication headers to a redirect target. The caller must handle network errors explicitly; the client does not retry implicitly.
- **Service boundary**: No public cloud-hosted service is provided officially. This remote-protocol specification is for communication with a self-hosted or internally deployed compatible gateway.
