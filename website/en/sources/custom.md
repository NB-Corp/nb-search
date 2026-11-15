# Custom Sources and Script Lanes

Bind trusted JS/TS modules directly in static configuration so the standard CLI, MCP, and SDK can use the same custom Results lane. You can also continue to inject a complete `ProviderRegistration` through the SDK.

## Local scripts: available to the CLI and SDK

The built-in `script` adapter provides a `search` operation (`nb-search.results@1`), but it does not create or enable an instance or lane automatically:

```json
{
  "provider_instances": {
    "local-script": { "provider_id": "script", "enabled": true, "options": { "module": "./search.mjs", "params": { "label": "local" } } }
  },
  "lanes": {
    "local.search": { "provider_instance_id": "local-script", "operation_id": "search", "latency": "fast", "cost": "free" }
  }
}
```

```js
// search.mjs — no network needed
export async function execute(request, context) {
  context.signal.throwIfAborted();
  context.logger.info('Local search started'); // stderr, not stdout
  return [{ title: request.query, url: 'https://example.com/', snippet: context.options.label }];
}
```

Run `nb-search search "hello" --lane local.search`. Async calls use the existing `execution:"async"`, `idempotency_key`, and get/read/cancel contracts. The SDK can receive the same configuration structure directly through `config`; no `provider_registrations` field is required. A complete no-network example is included in `examples/script-lane/` in the package.

### Module contract

- `options.module`: a local `.js`, `.mjs`, `.ts`, or `.mts` file. Relative paths in the canonical configuration file are resolved from the configuration directory; relative paths in an SDK inline `config`/`overrides` are resolved from the cwd used to create the runtime, so SDK callers should prefer absolute paths. The normalized absolute path is stored in the detached snapshot; the worker does not resolve it again from cwd.
- `options.params`: an optional JSON object passed as `context.options`; it is copied independently for each call. Do not put secrets in `params`, because they are included in configuration and job snapshots.
- The named export `execute(request, context)` takes precedence. `search(query, context)` is also supported, with a `context` that additionally contains the complete `request`. Return `ProviderResult[]` or the corresponding Promise. Each result must include string `title` and `url` fields and may include standard fields such as `snippet`. Typed objects and fetch output are not accepted in the first release.
- `request` contains `query`, `limit`, optional `freshness`, `request_time_utc`, and `signal`. `context` contains `signal`, `options`, an optional single `credential` string, `transport: HttpTransport`, and `logger.info/warn/error`.
- When credentials are needed, bind them through existing `credential_slots` and the instance's `credential_slot_id`; `provider_id` must be `script`. Credentials from other slots are not placed in the context.
- Root-exported types are `ScriptRequest`, `ScriptContext`, `ScriptResults`, and `ScriptModule`. Use `import type` in TypeScript. Node ≥24.15 performs native type erasure: no TS loader is installed and tsconfig path mappings are not executed. Local imports must include their full extension; enums, parameter properties, syntax requiring code transformation, and TSX are unsupported. Ordinary dependencies follow Node package resolution rules based on the module location; install dependencies separately, and TypeScript source dependencies in `node_modules` remain subject to Node's own restrictions.

### Execution and trust boundary

Modules are lazy-imported; capabilities and configuration validation do not execute code. A missing module or missing export becomes a safe provider error only when the module is actually called. Node caches modules, so multiple queries can enter the same module concurrently; do not use shared mutable state to store request data. The snapshot freezes the path and parameters but not the script file contents; keep the module and its dependencies available and version-stable until the job ends.

**This is user-authorized local code, not a sandbox**: the module runs with the same permissions as the process and can read files, environment variables, and the network, or start programs. Passing one credential in `context` does not isolate access to other processes. Cancellation and timeouts require the module to cooperate with `AbortSignal`; a synchronous infinite loop blocks the process, and asynchronous side effects that do not cooperate are not guaranteed to stop. Do not write to `console.log`/stdout from a script, because that would corrupt CLI JSON; use the provided stderr logger. The SDK does not globally replace `console`. Logs automatically mask only the bound credentials and module path; arbitrary data printed by the module is not guaranteed to be safe.

Cloud hosts may install trusted modules themselves and map lanes through a deployment manifest/allowlist, but should not accept arbitrary module paths from tenant requests. `context.transport` is a reusable host transport, not an interceptor for all network I/O by the module. Explicit SDK `http_transport` injection still disables detached async; a normal runtime without injected transport supports script `sync`/`async`.

## SDK manual registration (existing contract)

The following rules apply only to code registrations injected through SDK `provider_registrations`; they do not restrict the built-in `script` adapter above. Manual registration declares a `ProviderRegistration` interface exported by the SDK:
1. **Unique identifier**: `provider_id` must not conflict with a built-in Provider or another custom Provider.
2. **Strict descriptor**:
   - `activation.credential` accepts `'required' | 'none'` (built-in types accept `'required' | 'optional' | 'none'`).
   - `activation.endpoint` accepts `'required' | 'optional' | 'none'`.
   - General search output must use `channel: 'results'` with the fixed schema `nb-search.results@1`; specialist structured search must use `channel: 'typed'` and declare a stable `schema_id`.
   - Fetch output must use `nb-search.fetch@1`.
3. **Execution-mode constraints**:
   - Custom query operations are synchronous only in the current version. Even when a descriptor declares `built_in_async: true`, the runtime does not expose asynchronous execution for it.
   - A custom fetch pipeline supports synchronous calls only when `sync` is included in its declaration.
4. **Configuration binding**:
   - `lanes` and `provider_instances` in configuration are Record maps (key-value objects, not arrays).
   - Declare the corresponding Provider instance in `provider_instances`, then bind the concrete lane to that instance and operation in `lanes`.

## Complete SDK registration example

The following example registers a minimal synchronous in-process search source. The code follows the real type system and passes strict type checking:

```typescript
import { createNbSearchRuntime, type ProviderRegistration } from '@nb-corp/nb-search';

const hostQueryRegistration: ProviderRegistration = {
  descriptor: {
    provider_id: 'host-query',
    adapter_version: 'host-1',
    query_operations: [
      {
        operation_id: 'lookup',
        output: {
          channel: 'results',
          schema_id: 'nb-search.results@1'
        },
        built_in_async: false
      }
    ],
    fetch_operations: [],
    activation: {
      credential: 'none',
      endpoint: 'none'
    },
    option_keys: []
  },
  create() {
    return {
      query: {
        lookup: {
          name: 'host-query',
          async execute(request) {
            return {
              channel: 'results',
              value: {
                results: [
                  {
                    title: 'Internal Docs',
                    url: 'https://wiki.example.test/doc/1',
                    snippet: request.query
                  }
                ]
              }
            };
          }
        }
      },
      fetch: {}
    };
  }
};

const runtime = await createNbSearchRuntime({
  provider_registrations: [hostQueryRegistration],
  config: {
    schema_version: '4',
    provider_instances: {
      'host-query.default': {
        provider_id: 'host-query',
        enabled: true,
        options: {}
      }
    },
    lanes: {
      'host.lookup': {
        provider_instance_id: 'host-query.default',
        operation_id: 'lookup',
        latency: 'fast',
        cost: 'free'
      }
    },
    defaults: {
      search_lane: 'host.lookup'
    }
  }
});

// Run the query
const response = await runtime.search({
  action: 'run',
  query: 'microservice architecture',
  execution: 'sync'
});
```

After registration, `host.lookup` can be called through `runtime.search` in the current host process. The standard CLI cannot reconstruct the closure registration shown here; when CLI and detached async support are required, prefer the script-module configuration at the beginning of this page. Manual registration remains suitable for custom typed output, fetch, or host-closure dependencies.
