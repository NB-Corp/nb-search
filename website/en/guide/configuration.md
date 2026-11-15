# Configuration System

`nb-search` uses Configuration Schema Version 4 (`schema_version: "4"`). Configuration declares Provider instances, custom Lanes/Pipelines, credential-slot bindings, and default behavior.

## Configuration sources and merge priority

When the runtime resolves configuration, it merges sources strictly from lowest to highest priority. Higher-priority values override lower-priority values:

1. **Built-in default configuration** (Built-in structure)
2. **Local configuration file**: `$NB_SEARCH_HOME/config.json`, or the absolute or relative path specified by `NB_SEARCH_CONFIG` (if the variable is set but the target file does not exist, resolution fails immediately)
3. **Standard environment variables**: environment variables beginning with `NB_SEARCH_*`
4. **In-process configuration** (`config`)
5. **In-process overrides** (`overrides`)

When applying a patch:

- A field value of `null` explicitly deletes the field.
- Arrays are replaced as a whole; they are not merged by appending.

## Standard environment variables

Standard environment variables cover the runtime base environment and Provider credentials or endpoint configuration.

### Runtime base environment

| Environment variable | Description | Default |
|---|---|---|
| `NB_SEARCH_HOME` | Configuration and local state directory | `.nb-search` in the user's home directory (`~/.nb-search`) |
| `NB_SEARCH_CONFIG` | Explicit path to the configuration JSON file | None (reads `$NB_SEARCH_HOME/config.json` by default) |
| `NB_SEARCH_JOBS_ROOT` | Root directory for asynchronous job artifacts | `$NB_SEARCH_HOME/jobs` |
| `NB_SEARCH_RETENTION_HOURS` | Retention period for asynchronous artifacts, in hours | `72` |
| `NB_SEARCH_LOG_LEVEL` | Log level (`error`, `warn`, `info`, `debug`) | `warn` |

### Core Provider environment variables

Credentials are bound only when an environment variable is non-empty. An empty string means “not configured” and overrides a lower-priority credential. Any API key environment variable accepts either one key or up to **32 unique keys** separated by commas (for example, `NB_SEARCH_TAVILY_API_KEY="key-one,key-two"`).

::: code-group

```bash [General and aggregate search]
NB_SEARCH_EXA_API_KEY=""
NB_SEARCH_EXA_BASE_URL=""

NB_SEARCH_TAVILY_API_KEY=""
NB_SEARCH_TAVILY_BASE_URL=""

NB_SEARCH_BRAVE_API_KEY=""
NB_SEARCH_BRAVE_BASE_URL=""

NB_SEARCH_FIRECRAWL_API_KEY=""
NB_SEARCH_FIRECRAWL_BASE_URL=""

NB_SEARCH_SEARXNG_BASE_URL=""
```

```bash [Fetch and specialized sources]
NB_SEARCH_JINA_API_KEY=""
NB_SEARCH_JINA_BASE_URL=""

NB_SEARCH_GITHUB_TOKEN=""

NB_SEARCH_CONTEXT7_API_KEY=""

NB_SEARCH_ZHIPU_API_KEY=""
NB_SEARCH_ZHIPU_BASE_URL=""

NB_SEARCH_PARALLEL_API_KEY=""

# The built-in Zhihu source is opt-in. In addition to this variable, declare the instance, slot, and Lane explicitly in config.json.
NB_SEARCH_ZHIHU_API_KEY=""
```

```bash [Models and advanced synthesis sources]
NB_SEARCH_GROK_API_KEY=""
NB_SEARCH_GROK_BASE_URL=""
NB_SEARCH_GROK_MODEL=""

# The built-in GMA instance and slot (grok-multi-agent.default); the default slot environment variable points to NB_SEARCH_GROK_API_KEY.
NB_SEARCH_GROK_MULTI_AGENT_BASE_URL=""
NB_SEARCH_GROK_MULTI_AGENT_MODEL=""

# OpenAI-Compatible (OAC)
NB_SEARCH_OAC_API_KEY=""
NB_SEARCH_OAC_BASE_URL=""
NB_SEARCH_OAC_MODEL=""
```

:::

## Configuration file structure (`config.json`)

The following valid `config.json` example configures a default search source, a URL fetch chain, a local-file authorization scope, and a fetch byte limit:

```json
{
  "schema_version": "4",
  "defaults": {
    "search_lane": "tavily.search",
    "fetch_chain": [
      {
        "input_kind": "url",
        "representation": "markdown",
        "pipelines": ["direct.fetch", "jina.reader"]
      }
    ]
  },
  "fetch": {
    "file_scopes": [
      {
        "id": "workspace",
        "root": "/path/to/project/docs",
        "media_types": ["text/plain", "text/markdown"]
      }
    ]
  },
  "execution": {
    "fetch": {
      "max_source_bytes": 10485760
    }
  }
}
```

::: tip Field-name constraints

- The configuration Schema version field is named `schema_version` and is a string literal with the value `"4"`.
- The pipeline list in a fetch chain is named `pipelines` (an array), not `pipeline_ids`.
- The local-fetch source-size limit is declared in `execution.fetch.max_source_bytes`; each `file_scopes` entry supports only `id`, `root`, and optional `media_types`.
:::

## GMA custom credential-slot example

The built-in GMA instance is `grok-multi-agent.default`, and its default credential slot points to the `NB_SEARCH_GROK_API_KEY` environment variable, just like Grok. To bind GMA to a separate dedicated environment variable (such as `MY_GMA_KEY`) and specify the communication protocol, declare a separate credential slot in the configuration:

```json
{
  "schema_version": "4",
  "provider_instances": {
    "grok-multi-agent.default": {
      "provider_id": "grok-multi-agent",
      "enabled": true,
      "credential_slot_id": "gma.custom",
      "base_url": "https://relay.example.test/gma",
      "options": {
        "api_mode": "messages",
        "reasoning_effort": "high"
      }
    }
  },
  "credential_slots": {
    "gma.custom": {
      "provider_id": "grok-multi-agent",
      "env": "MY_GMA_KEY"
    }
  }
}
```

::: warning Slot constraint
When declaring `credential_slots`, the slot configuration object's `provider_id` must exactly match the `provider_id` of the `provider_instance` that references the slot (both are `"grok-multi-agent"` here). Otherwise, configuration validation fails.
:::

## Multi-key rotation and local quota inspection (`keyUsage()`)

The local runtime supports **up to 32 unique, non-empty keys** for any built-in or custom `credential_slots.*.env` setting (separated by English commas in priority order, for example, `NB_SEARCH_TAVILY_API_KEY="key-one,key-two"`). A single key remains fully compatible. Key plaintext is never written to `config_fingerprint`, job snapshots, or usage response bodies.

Configure the scheduling strategy and quota-cache period per Provider instance in `config.json` (the Schema version remains `"4"`):

```json
{
  "schema_version": "4",
  "provider_instances": {
    "tavily.default": {
      "key_strategy": "priority",
      "balance_ttl_ms": 600000
    }
  }
}
```

### Scheduling and failover rules

- **Rotation strategy (`key_strategy`)**: The default is `"round-robin"` (balanced rotation in order). With `"priority"`, the first available key is always preferred, and the runtime moves forward only when that key is limited or fails.
- **State machine and error recovery**:
  - `401` / `403`: quarantine the key for the lifetime of the current runtime instance;
  - `429`: cool the key down according to the `Retry-After` response header (60 seconds by default), then immediately switch to the next available key;
  - `402`: mark the key as quota-exhausted (`exhausted`) until the `balance_ttl_ms` cache expires or an explicit usage refresh restores it;
  - `5xx` and connection failures: perform at most 2 bounded exponential-backoff retries on the current key, then switch to the next key.
- **Process boundary**: Key cooldown and health state live in the current process memory (detached `async` jobs run in an independent worker subprocess). When all available keys have been tried and fail, the outer execution-level retry strategy (`execution.retry_count`) still applies under the original rules.

### Local SDK `keyUsage()` and provider metering differences

The local SDK runtime exposes `runtime.keyUsage({ provider_instance_id, refresh })`, which returns redacted key indexes, health status, and an upstream quota summary (`KeyUsage[]`, without key plaintext):

- **Caching and rate limits**: When `refresh` is omitted (or set to `false`), the runtime prefers the in-memory cache, which is valid for 10 minutes by default (`balance_ttl_ms` ranges from `60000` to `86400000` milliseconds). Tavily rate-limits its official `/usage` endpoint to at most 10 requests every 10 minutes. For routine monitoring, prefer cached reads and avoid passing `refresh: true` frequently.
- **Source behavior**:
  - **Tavily**: Calls the key-level `/usage` endpoint (retaining the `base_url` prefix) and returns usage and limits for the current billing period at key level. Ordinary `search`/`fetch` dispatches do not make an additional balance request.
  - **Firecrawl**: Calls `/v1/team/credit-usage` (retaining the `base_url` prefix) and returns the **team-wide** remaining credits. Multiple keys in the same team may show the same remaining balance. Ordinary requests do not pre-check the balance.
  - **Zhihu (`zhihu`)**: Calls `GET /api/v1/quota` and returns API-specific request counters in `KeyUsage.usage.meters`. When `allow_paid: false` (the default), dispatch also performs a free-quota gate check before the request; see [Explicitly enable the Zhihu source](/en/sources/web-search#zhihu).
  - **Exa and other sources**: Exa's historical usage endpoint requires a separate team-management key and does not return remaining available quota. Sources without a single-key remaining-quota endpoint do not return a usage entry from `keyUsage()`.
- **Protocol boundary**: `keyUsage()` is exposed only by the local SDK (`LocalNbSearchRuntime`), not by the CLI, MCP, or Remote HTTP protocol clients.

## Local and remote credential storage (`secrets.json` / `remote-secrets.json`)

To avoid writing plaintext keys to shell history or configuration files, the CLI provides protected file-based credential storage:

### 1. Local credential storage (`$NB_SEARCH_HOME/secrets.json`)

```json
{
  "schema_version": "1",
  "values": {
    "NB_SEARCH_TAVILY_API_KEY": "YOUR_TAVILY_KEY",
    "NB_SEARCH_BRAVE_API_KEY": "YOUR_BRAVE_KEY"
  }
}
```

- `secrets.json` fills values that are not set in the process environment. If the current shell already contains the variable (even as an empty string), the environment variable takes precedence.
- Only the CLI reads this file by default and passes its values to local child processes. The SDK and MCP do not automatically read the CLI's `secrets.json`.

### 2. Remote client credentials and configuration files (`profiles.json` / `remote-secrets.json`)

Configure remote service endpoints in `$NB_SEARCH_HOME/profiles.json`:

```json
{
  "schema_version": "1",
  "profiles": {
    "cloud": {
      "kind": "remote",
      "base_url": "https://search.example.test/api/",
      "token_env": "NB_SEARCH_CLOUD_TOKEN",
      "timeout_ms": 120000
    }
  }
}
```

Provide the remote service Access Key through the `NB_SEARCH_CLOUD_TOKEN` environment variable or the protected `$NB_SEARCH_HOME/remote-secrets.json` file:

```json
{
  "schema_version": "1",
  "values": {
    "NB_SEARCH_CLOUD_TOKEN": "YOUR_SERVICE_KEY"
  }
}
```

Remote configuration and local Provider credentials are completely separate: selecting a remote profile does not load local search-source keys.

### 3. File storage and safe recovery

- **Storage and link support**: Configuration files and directories use the operating system's standard creation permissions (files `0600`, directories `0700`). Ordinary configuration-file symlinks and parent-directory junctions are fully supported, with no restriction on same-name directories or near-matching ordinary filenames. The metadata leaf names (`.config-access.lock`, `.config-revision.json`, `.<basename>.nb-search.lock`, `.<basename>.nb-search-revision.json`) cannot be used as configuration or key files, and the metadata leaf itself cannot be redirected through a symlink. The system does not force permission changes on existing files or rewrite user data links.
- **Concurrent snapshots and transaction locks**: Concurrent local reads (`capabilities`, `search`, `fetch`, and `jobs`) do not need locks and run safely against versioned snapshots. Transaction locks and version markers are created only for configuration writes or migrations. When multiple homes share a custom configuration path, each real data target gets a dedicated adjacent lock (`.<basename>.nb-search.lock`) and revision file (`.<basename>.nb-search-revision.json`) to prevent cross-home overwrites.
- **Configuration writes and safe recovery**: Ordinary manual edits to configuration files take effect directly; you do not need to manage revision files manually. The CLI ensures atomic pairing and transaction coordination only while writing configuration or running a migration. If the CLI reports that configuration is busy or needs recovery (with a specific marker path), do not blindly delete a single lock file or the revision file. First confirm that the preceding write or migration process has stopped. Then use the backup files under the home directory (`.migration-*-backup.json`) to restore the complete configuration and credential pair, publish a new revision for the targets associated with the transaction, and remove the corresponding locks before resuming. Normal users do not need to create or manage any lock files manually.

## Offline configuration health check (`--doctor`)

The CLI provides a `--doctor` option to validate the current configuration format and credential slots while offline:

```bash
node scripts/nb-search.mjs --doctor
```

This command summarizes only local JSON syntax and the presence of credential environment variables. A valid keyless configuration also returns success. It does not build runtime ports or prove that upstream Providers are reachable. To check source availability and runtime-port readiness, use `capabilities`.
