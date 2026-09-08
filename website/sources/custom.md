# 自定义源与脚本 Lane

可以直接在静态配置中绑定可信的 JS/TS 模块，让标准 CLI、MCP 与 SDK 使用同一个自定义 results lane；也可以继续通过 SDK 注入完整 `ProviderRegistration`。

## 本地脚本：CLI 与 SDK 都可用

内置适配器 `script` 提供 `search` 操作（`nb-search.results@1`），但不会自动创建或启用实例/lane：

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

使用 `nb-search search "hello" --lane local.search`；async 使用既有 `execution:"async"`、`idempotency_key`、get/read/cancel 合同。SDK 的 `config` 直接传同一配置结构即可，无需 `provider_registrations`。完整无网络样例在包内 `examples/script-lane/`。

### 模块合同

- `options.module`：本地 `.js`、`.mjs`、`.ts` 或 `.mts` 文件。canonical 配置文件中的相对路径以配置目录为基准；SDK inline `config`/`overrides` 中相对路径以创建 runtime 时的 cwd 为基准，建议 SDK 使用绝对路径。规范化后的绝对路径写入 detached snapshot，worker 不重新依赖 cwd。
- `options.params`：可选 JSON 对象；传为 `context.options`，每次调用独立复制。不要把密钥放入 params，它会进入配置和任务快照。
- 命名导出 `execute(request, context)` 优先；也支持 `search(query, context)`，其 context 额外含完整 `request`。返回 `ProviderResult[]` 或对应 Promise，必需字符串 `title`、`url`，可含 `snippet` 等标准结果字段。首版不接受 typed 对象或 fetch 输出。
- request 含 `query`、`limit`、可选 `freshness`、`request_time_utc`、`signal`；context 含 `signal`、`options`、可选单个 `credential` 字符串、`transport: HttpTransport` 和 `logger.info/warn/error`。
- 如需凭据，通过既有 `credential_slots` / 实例 `credential_slot_id` 绑定，`provider_id` 必须为 `script`。不会把其他 slot 的凭据放入 context。
- 根导出类型：`ScriptRequest`、`ScriptContext`、`ScriptResults`、`ScriptModule`。TS 使用 `import type`。Node ≥24.15 原生擦除类型，不安装 TS loader、不执行 tsconfig paths 映射；本地 import 需完整扩展名，enum、参数属性、需代码转换的语法及 TSX 不支持。普通依赖按模块位置遵循 Node 包解析规则；依赖需自行安装，TS 源码依赖位于 node_modules 时遵循 Node 自身限制。

### 执行与信任边界

模块 lazy import，capabilities 和配置校验不执行代码；模块不存在或无导出会在实际调用时报安全的 provider 错误。模块由 Node 缓存，多个 query 可同时进入同一模块；不要用共享可变状态存储请求内容。snapshot 固定路径和参数，不冻结脚本文件内容；作业结束前需保持模块与依赖可用且版本稳定。

**这是用户授权的本地代码，不是沙箱**：模块与进程同权限，可自行读文件、环境变量、网络或启动程序。context 只传一个凭据不代表隔离其他进程权限。取消/超时要求模块配合 AbortSignal；同步死循环会阻塞进程，异步不合作的副作用也不保证被终止。禁止脚本写 `console.log`/stdout 破坏 CLI JSON，请用提供的 stderr logger；SDK 不会全局替换 console。日志只自动遮蔽所绑定凭据及模块路径，不保证任意自行输出安全。

云端只能由部署者安装可信模块并用部署 manifest/allowlist 映射 lane，不应接受 tenant 请求提供任意模块路径。`context.transport` 是可复用宿主 transport，不是对模块所有网络 IO 的拦截。显式 SDK `http_transport` 注入仍禁用 detached async；普通无注入 runtime 的脚本支持 sync/async。

## SDK 手动注册（保留原合同）

以下规则仅适用于 SDK `provider_registrations` 注入的代码注册，不限制上面的内置 script adapter。手动注册通过 SDK 导出的 `ProviderRegistration` 接口声明：
1. **唯一标识**：`provider_id` 不能与内置 Provider 或其他自定义 Provider 冲突。
2. **严格描述符**：
   - `activation.credential` 支持 `'required' | 'none'`（内置类型支持 `'required' | 'optional' | 'none'`）。
   - `activation.endpoint` 支持 `'required' | 'optional' | 'none'`。
   - 通用搜索输出通道必须为 `channel: 'results'` 且 Schema 固定为 `nb-search.results@1`；专用结构化搜索必须为 `channel: 'typed'` 并声明稳定的 `schema_id`。
   - 抓取输出必须为 `nb-search.fetch@1`。
3. **执行模式约束**：
   - 自定义查询操作在当前版本中仅支持同步执行（Sync-only）。即使在描述符中声明了 `built_in_async: true`，运行时也不会为其暴露异步执行能力。
   - 自定义抓取管道只有在声明中包含 `sync` 时才具备同步调用能力。
4. **配置绑定**：
   - 配置中的 `lanes` 与 `provider_instances` 均为 Record 映射对象（键值对结构，非数组）。
   - 必须在 `provider_instances` 中声明对应 Provider 实例，然后在 `lanes` 中将具体的 Lane 绑定到该实例和操作上。

## SDK 注册完整示例

以下示例注册了一个最简的同步内部搜索源，该代码遵循真实类型系统并可通过严格类型检查：

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
                    url: 'https://wiki.internal/doc/1',
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

// 执行查询
const response = await runtime.search({
  action: 'run',
  query: 'microservice architecture',
  execution: 'sync'
});
```

注册完成后，`host.lookup` 即可在当前宿主进程内通过 `runtime.search` 发起调用。标准 CLI 无法重建这里的闭包 registration；若需要 CLI 与 detached async，优先使用本文开头的 script 模块配置。完整手动 registration 仍可用于自定义 typed 输出、fetch 或宿主闭包依赖。
