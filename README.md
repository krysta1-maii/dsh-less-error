# dsh-less-error

从 dsh-llm-pi-ai-oauth 抽出的独立 Host 小插件。它处理 pi-ai 流中被归为 PI_AI_ERROR 的明确临时故障，让 DSH 原有的重试机制能够识别；不包含 OAuth 登录、模型目录、设置页、fast mode、结构化错误采集或 provider 副本。

当前版本为 **0.2.0**，目标宿主为 **DSH 0.2.2-rc.3**（上游 commit 38a6a5c965aa99ab525161efb7cc5cf1fe62fced），运行时需要 Node.js 24.9.0 或更高版本。插件没有普通运行依赖，只有 Cordis 与 DSH LLM 服务的 peer 声明。

## 适用范围

插件监听所有 provider 的流，但只修改终止原因属于 error、且原错误码仍为 PI_AI_ERROR 的 chunk。DSH 已经能识别的 HTTP 401/403/429/5xx、限流、超时和常见断线不会被改写；已有 AUTH、RATE_LIMIT、SERVER、TRANSPORT、ABORTED 等分类也保持原样。

openai-codex 使用原插件的精确白名单：

| 原始消息 | 新错误码 |
|---|---|
| 精确的 WebSocket error | TRANSPORT |
| 精确的 No response body | TRANSPORT |
| WebSocket closed 1000/1001/1006/1012，可带空格分隔的关闭原因 | TRANSPORT |
| WebSocket closed 1011/1013，可带空格分隔的关闭原因 | SERVER |
| 精确的 Our servers are currently overloaded. Please try again later.，可带 Codex error: 前缀 | SERVER |

其他 provider（包括 Kimi/Moonshot、Anthropic 及各类网关）使用一组过载和容量不足文案规则。消息包含 overloaded（包括 overloaded_error、engine_overloaded_error）、server_busy、servers are currently busy、currently experiencing high demand 或 model is at capacity 时，错误码改为 SERVER。例如 Kimi 的 The engine is currently overloaded, please try again later 会进入宿主的服务端错误重试。

其他 provider 不会套用 Codex 的 WebSocket 和 No response body 规则。Service unavailable、Internal error、额度提示等较模糊或用途不同的文本仍保持 PI_AI_ERROR，不因本插件而重试。

修改采用浅拷贝，原始 chunk、消息、请求 ID、HTTP 状态、providerRetryAfterMs 与 replay state 均保留。正常完成、取消和模型文本不会进入修复分支。WebSocket 1000 在协议上表示正常关闭；这里只处理 pi-ai 在未收到响应完成信号时产生的终止错误。新的分类只表示允许按策略重试，不保证故障一定是暂态。

## 工作原理

[入口](<lib/index.js>)监听 DSH 的 llm/stream waterfall，把下游流交给[修复层](<lib/transport-errors.js>)，并传入当前 options.provider。该公共扩展点同时覆盖 direct stream 与 prepared call，因此无需注册或替换现有 PiAiAdapter。

本插件不实现重试循环。宿主默认组合中的 @deepseek-ai/dsh-llm-retry 在后续请求失败阶段执行重试；默认普通策略包括 TRANSPORT 和 SERVER，最多额外重试 5 次。具体次数、退避与取消仍由 provider 的重试策略和宿主插件决定。

## 安装

本包包含自挂载的 [cordis.patch.yml](<cordis.patch.yml>)。可通过 DSH 的「设置 → 插件 → 添加插件」输入本目录路径，或运行：

```bash
dsh plugin --profile <profile> add /absolute/path/to/dsh-less-error
```

安装后重启对应 DSH 实例。不要再向 profile 的 cordis.patch.yml 手工添加同一插件，否则可能重复注册监听器。原 dsh-llm-pi-ai-oauth 已停用时，不会与本插件叠加同一路由的修复。

## 检查

```bash
npm run check
npm test
npm pack --dry-run
```

测试全部离线运行，不读取 OAuth 凭据，也不发起真实网络或模型请求。工作区测试不能替代真实 Kimi/Codex 断线、服务过载及自动重试的在线验收。
