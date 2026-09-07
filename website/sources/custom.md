# 自定义源与扩展 (Custom Registrations)

如果内置的 15 个搜索源和 9 个抓取管道无法满足你的内部架构，`nb-search` 支持在进程内注入自定义 Provider。

## 安全与架构边界

为了避免任意代码执行风险，`nb-search` **禁止**在静态 `config.json` 配置文件中指定动态脚本路径或执行代码。所有自定义 Provider 必须通过 Node.js SDK 在初始化时显式传入。

## 注册契约与约束

自定义 Provider 必须通过 SDK 导出的 `ProviderRegistration` 接口进行声明：
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

注册完成后，`host.lookup` 即可在当前宿主进程内通过 `runtime.search` 发起调用。需要注意，内置的标准 CLI 二进制不会自动加载第三方自定义代码，宿主若需提供命令行工具，应基于自身封装的运行时入口进行调用。
