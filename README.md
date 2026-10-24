# river.ai provider for DeepSeek Harness

把 river.ai 的 chat/completions 接口接成 DeepSeek Harness 的 `river` provider。一个插件同时管多个 key, 请求在账号之间轮转, 429 冷却, 401 停用。

## 安装

```bash
dsh plugin --profile web add github:ExSchwi/dsh-river-provider#v0.2.4
```

装完重启 `dsh web`。插件注册的 provider id 是 `river`, 显示名 `river.ai`。

第一步的 key 来自凭据引用 `RIVERAI_API_KEY`, 写在 `dsh` 的 `.credentials.yaml` 里或同名环境变量里。第二个账号往上从 `accounts` 配置。

## 用法

在模型选择器里选 `river.ai` 下的模型, 或直接写 provider 与模型 id:

```yaml
- id: agent-default-model
  config:
    provider: river
    model: deepseek-ai/DeepSeek-V4.1-Flash-1017
    reasoningEffort: high
```

仓库内置四个模型的真实上限与档位 (`src/capabilities.ts`):

| 模型 id | 上下文 | 输出上限 | 推理档位 |
| --- | --- | --- | --- |
| `deepseek-ai/DeepSeek-V4.1-Flash-1017` | 1,048,576 | 384,000 | off / high / max |
| `deepseek-ai/DeepSeek-V4.1-Flash` | 1,048,576 | 384,000 | off / high / max |
| `zai-org/GLM-5.3-Flash` | 1,048,576 | 128,000 | low / high / max |
| `nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-NVFP4` | 1,048,576 | 128,000 | 无 |

推理档位只列 river 每个模型真正接受的值: 选中 `off` 时不发 `reasoning_effort` 字段, 选中其它值原样发送。GLM 不提供 `off`, 因为它的接口要求每次都带档位。Nemotron 的文档没有档位表, 所以列表为空, 也不发该字段。

模型 id 一个字符都不改写, 改了 river 就认不出来。显示名同样来自 river 的模型 id, 插件不生成别名。

## 设置界面

插件自带两个界面, 都走 `river` Remote 命名空间读写:

- 设置 → 模型 → `river.ai` 卡片: 接口地址和当前账号在这里改, 上下文窗口与输出预算也是。下面逐模型列出推理强度, 再往下是账号表和设置页的开关。
- 设置 → `river.ai` 页: 账号表与粘贴 key 在这, 模型可见性和模型路由也在这。页面顶部复用卡片里的容量与档位控件。

`showSettingsSection` 控制第二项, 默认 `true`。关掉之后只留卡片, 账号管理仍在卡片里。

页面第一次加载就会注册, 不等 Remote 返回: 一个看不见的开关没法打开, 而 Remote 挂掉时页面正好是唯一能报告原因的地方。Host 返回 `false` 之后入口才撤掉。

插件的挂载状态写在页面元素上, 排查时不必开控制台:

```js
document.documentElement.dataset.dshRiver            // 'mounted'
document.documentElement.dataset.dshRiverCard        // 'registered'
document.documentElement.dataset.dshRiverSection     // 'registered' | 'withdrawn'
document.documentElement.dataset.dshRiverRemote      // 'mounted' | 'failed: ...'
window.__dshRiver.state()                            // 当前快照与错误
```

`window.__dshRiver` 只暴露 `state()`、`refresh()`、`edit(field, value)`, 不读写任何凭据。

## 配置

写在 `cordis.patch.yml` 的 `llm-river` 段, 或者在上面的界面里改。界面写的就是这一段的字段。

| 字段 | 默认值 | 作用 |
| --- | --- | --- |
| `apiBase` | `https://api.river.ai/v1` | 接口地址 |
| `apiKeyEnv` | `RIVERAI_API_KEY` | 第一个账号的凭据引用 |
| `apiKey` | 无 | 第一个账号的字面量 key, 优先用引用 |
| `accounts` | `[]` | 额外账号, 每项 `{label, apiKeyEnv, apiKey}` |
| `activeAccount` | 空 | 固定一个账号, 留空按健康度轮转 |
| `modelAccountRules` | `[]` | 把匹配的模型固定到某个账号, 支持 glob |
| `requestTimeoutMs` | `900000` | 整个请求的预算, river 文档写单次响应最长 15 分钟 |
| `streamIdleTimeoutMs` | `600000` | 流中间最长静默, river 文档写 prefill 最长 10 分钟 |
| `maxOutputTokens` | 无 | 全局输出上限, 留空用模型自己的上限 |
| `contextWindowLimit` | 无 | 上报给模型的上下文窗口, 留空用 1,048,576 |
| `defaultReasoningEffort` | `{}` | 按模型 id 或 glob 指定档位, `auto` 表示不干预 |
| `visibleModels` | `[]` | 只显示这些模型, 留空显示全部 |
| `modelVisibility` | `{}` | 单模型开关, 优先于 `visibleModels` |
| `showSettingsSection` | `true` | 是否在设置导航里放 `river.ai` 页 |

`contextWindowLimit` 要大于 `maxOutputTokens` 加上压缩余量, 否则压力压缩算不出空间, 会直接拒绝运行。river 的 1,048,576 对 384,000 这个比例余量很薄, 同时压住两者是测试过的配置。

## 多账号轮转

请求先看 `modelAccountRules`, 再看 `activeAccount`, 都没有就在可用账号里轮转。

- 429: 该账号进入冷却, 直到 `Retry-After` 或响应里给出的重置时间。
- 401 / 403: 该账号停用, 不再参与轮转。
- 单次请求最多换 16 个账号 (`MAX_ACCOUNT_ROTATIONS`), 换完仍不可用就整体失败。
- 全部账号都不可用时, 错误码取最具体的一个: 全 401 报 `INVALID_CREDENTIAL`, 有窗口标记报 `RATE_LIMIT`, 否则报 `THROTTLED`。
- 冷却短于 900 秒时, 等待时间随错误一起交给 DSH 的重试层 (`providerRetryAfterMs`), 超过就放弃这次重试。

冷却状态按 `apiBase` 共享, 换接口地址等于换一套健康记录。

## 已知限制

- 不做 web search: river 没有对应的检索后端, 插件不改写 `searchProvider`。
- 流式响应中断后重试会重新计费已经发出去的 token, 这是 river 按输出计费的直接结果, 插件无法避免, 只能在 `streamIdleTimeoutMs` 内判定中断。
- 档位写错会在发请求前报配置错误, 不会被静默改成相邻档位; 想批量改就用 `defaultReasoningEffort` 的 glob。
- 插件只上报 river 文档给出的模型上限。文档和线上不一致时以线上为准, 上限会被服务端拒绝而不是本地截断。

## 开发

```bash
npm run typecheck             # tsc --noEmit
npm test                      # 74 个离线测试, 不联网
npm run build                 # tsc 出 host, tsdown 出 client, 再跑 check:dist
```

`check:dist` 逐个用 `node --check` 校验 `lib/*.js`, 再断言 client 产物带 loader 包装和两处槽注册。构建产物解析不过时这一步直接失败, 不必等到启动。

`tests/render.test.ts` 用 `react-dom/server` 真渲染卡片和设置页, 渲染期崩溃不会被当成"什么都没发生"。

两个联网工具不进 `npm test`:

```bash
RIVERAI_API_KEY=rv_... node --import tsx tools/live-smoke.ts        # 协议、用量、错误码
RIVERAI_API_KEY=rv_... RIVERAI2_API_KEY=rv_... node --import tsx tools/live-accounts.ts  # 双账号轮转
```

## 许可证

MIT, 见 `LICENSE`。
