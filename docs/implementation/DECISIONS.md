# Gemini 4 Adapter（dsh-vertex-argon）核心技术决定与协议合同（v2.3.2）

本文区分当前实现合同与历史实测；验证来源与本轮结果见 [STATUS.md](<STATUS.md>)。

## 1. 模型、凭据与服务层级

实现入口为 [adapter.js](<../../adapter.js>)、[google-connection.js](<../../google-connection.js>)、[index.js](<../../index.js>)。

### 双官方通道的八个模型 ID

- `MODEL = gemini-4-argon`，`GOOGLE_API_MODEL = gemini-4-argon-google`，`CARBON_MODEL = gemini-4-carbon`，`GOOGLE_API_CARBON_MODEL = gemini-4-carbon-google`，`HYDROGEN_MODEL = gemini-4-hydrogen`，`GOOGLE_API_HYDROGEN_MODEL = gemini-4-hydrogen-google`，`NEON_MODEL = gemini-4-neon`，`GOOGLE_API_NEON_MODEL = gemini-4-neon-google`；八者按路由配置独立注册，不覆盖原有模型。Gemini API 模型由 `isGoogleApiModel`（基于统一解析器 `resolveOfficialGemini4Model`，大小写不敏感且支持 `models/` 前缀）判定，`detectPiAiArgonRoutes` 仅匹配精确 `$` 结尾（排除 `-preview` 等非官方变体）；八个模型的上游基础 ID 统一由 `officialUpstreamModel` 映射（空值默认 `gemini-4-argon`，非空未知 ID 直接抛出 `UNKNOWN_MODEL`）；`ArgonAdapter.prepareCall` 与 `PiAiAdapter.prototype.prepareCall` 在双协议分支固定绑定 `(provider, model)`；Interactions 在缺省 `settings.upstreamModel` 时直接从 `options.model` 解析上游模型并拒绝冲突或未知模型。
- 官方通道只有两条：Vertex AI（`google-vertex`）与 Gemini API（`google-generative-ai`）。诊断 `route` 枚举不扩展，Inspector 直接按 `route` 显示通道名；云端 ID 查询也只覆盖这两个官方通道。
- GenerateContent 与 Interactions 使用同一份 `officialUpstreamModel` 映射；两条通道各自遵守自己的协议与服务层级设置，缓存随设置和路由变化失效。
- GenerateContent 历史在交给 pi-ai 前先过 `generateContentHistory(options, model)`：Interactions 来源的信封，以及跨模型（Argon ↔ Carbon ↔ Hydrogen ↔ Neon、Vertex ↔ Gemini API，或跨 provider）且内容含 `reasoning` / `tool-call` 块的历史，一律按 per-`toolCallId` FIFO 队列与位置后继未认领匹配降级为文本转录（剔除旧思考、已完成调用转 `[Previously executed tool ...]` 文本、对应结果转用户态文本、移除 `replayState`），未完成的调用直接报错；`createGoogleSignatureBridge` 与 `buildInteractionRequest` 同样以 per-`toolCallId` FIFO 队列隔离复用 `toolCallId` 的跨轮次降级与原生回放。判据取 `message.source` 与 `replayState.response` 的 provider/model 双向比对；只含纯文本的跨模型消息仍交由签名桥按 `!same` 剥离独立签名。同模型历史保留原生签名回放。

### 凭据解析与能力校验

- Google/Vertex 凭据优先级为 `credentials` → `launchEnvironment` → `process.env`。凭据服务自身抛错时直接失败，不能退回旧密钥。Gemini API Key（`GOOGLE_API_KEY` / `GEMINI_API_KEY` / 配置的 `apiKeyEnv`）与 Vertex Key（`GOOGLE_CLOUD_API_KEY` / ADC）各自独立解析，互不借用、互不泄漏。
- [service-level.js](<../../service-level.js>) 保持既有能力矩阵：Google 路由两种协议支持 `standard` / `flex` / `priority`；Vertex GenerateContent 支持 `standard` / `priority` 及 `vertexPaygoOnly`；Vertex Interactions 仅允许 `standard` 且不允许 PayGo-only。
- 不支持的组合发包前报 `ARGON_SERVICE_TIER_UNVERIFIED`，不暗中降级、升级或切换协议。离线矩阵校验不等于对应官方端点已获云端实测证明。
- 请求层级与观测层级分别保存；Vertex 用 `traffic-type`，Google 使用响应头。思考档位按 `supportsXhighReasoning(modelId)` 分集：Argon / Carbon 维持 `low` / `medium` / `high` 三档（`max` 收敛为 `high`），`xhigh` / `off` / `minimal` 仍在发包前拒绝；Hydrogen / Neon 放行 `low` / `medium` / `high` / `xhigh` 四档（`max` 收敛为 `xhigh`，并在 GenerateContent 出站前剥离顶层、`config` 及 `httpOptions.extraBody` 中的显式 `cachedContent` / `cached_content`），`off` / `minimal` 发包前拒绝。收敛、双字段（`reasoning` / `reasoningEffort`）显式合法性与互斥检查，以及原生 `PiAiAdapter` / `piProvider.stream` / `streamSimple` 补丁在全边界一致生效（[index.js](<../../index.js>) `agent/request` 钩子、[adapter.js](<../../adapter.js>)、`interaction-adapter.js` 与 `interactions-input.js` 共享 `resolveGemini4ReasoningLevel`）。

## 2. GenerateContent 长解码不变式

实现为 [generate-content.js](<../../generate-content.js>)；签名保真由 [google-signatures.js](<../../google-signatures.js>) 负责。

- `longDecode: true` 时，Vertex 使用 `v1beta1`，Gemini API 使用 `v1beta`；单跳输出上限 `65,536`，输出预算配置最高 `1,048,576`，所有尝试合计最多 32 跳。各跳沿用请求预算配置，不动态扣减跨重试剩余 Token，不额外承诺实际总用量封顶。
- 关闭 `longDecode` 只禁用多跳/检查点续传与仅思考自愈，零已交付初始重试和阶段超时独立保留。
- 正常 `CONTINUATION` 必须带有效的新 `continuationToken` 才继续，不能以旧 token 或缺失 token 假装进展。
- **首个检查点前逐块实时 `yield`，禁止为了恢复而全量缓存。** 有检查点后，只提交检查点确认的内容；流失败时丢弃未提交尾段，从已确认 token 续传，避免重复输出或拼接残片。
- “已交付分片”按实际 `yield` 计数，不按收到的原始帧、解析成功次数或文本长度判断。空内容/签名/用量帧若已经交付，也不能被当作零交付。
- 保留 `thoughtSignature` / `thought_signature`，包括无文本的独立 `Part`；自愈回放也不能丢失签名。

## 3. 四项流式韧性机制

### 3.1 内联错误与服务端等待建议

- HTTP `200` 的 SSE 出现顶层 `{ error }` 时，将其作为流内错误处理。`status` 仍记录实际 HTTP 状态，`streamErrorStatus` 记录流内服务错误，两者不能混为一谈。
- 从 `Retry-After`（秒数或 HTTP 日期）、Google `details` 的 `retryDelay` / 配额恢复延时，以及消息中的 `retry in/after` 提示读取等待建议；存在多个有效建议时采用较长者，增加 `200ms` 安全余量。
- 本地退避保持 `500ms` 起步、`10000ms` 上限、`0.1` 抖动率；有效服务端等待建议作为下限，不被本地上限截短。
- **解析后的服务端延时超过 `60000ms` 时立即失败**，即使有检查点也不进入长时间重试。
- 原始错误消息或任意 `details` 不进入脱敏诊断日志；诊断保留受限错误码与阶段，完整响应只在用户显式允许捕获后保存。

### 3.2 每跳独立的分阶段超时

| 阶段 | 默认等待上限 |
|---|---|
| `initial-ttft`：首包 | `180000ms` |
| `thinking`：思考流等待 | `180000ms` |
| `transition`：思考到可见输出的转换 | `180000ms` |
| `streaming`：可见文本/工具流滑动等待 | `120000ms` |

- 每跳创建独立 `AbortController`，超时终止当前上游工作；清理定时器、用户取消监听和旧迭代器，旧跳不能中止新跳。
- 等待连接、流迭代及帧 JSON 解析均需受约束；不能只给 `next()` 加时间限制而放任其他等待永久阻塞。
- 只累计等待上游工作所用时间，不在 `yield` 后让消费方处理/暂停时间消耗超时预算。看门狗仅在首次进入 `thinking` / `transition` 阶段、收到非空文本、具名 `functionCall`、本跳有界集合 `seenSignatures`（上限 8,192）中未见的新签名、新检查点或首次终止信号时刷新预算；空帧、空思考帧、空 `{ functionCall: {} }`、交替空帧与重复签名不续期。
- 用户取消立即停止，不进入自动恢复。阶段超时与用户取消必须区分；超时只能在满足安全重试条件时恢复。
- `meta.phaseTimeouts` / `phaseTimeouts` 的 `initialTtft`、`thinking`、`transition`、`streaming` 均以毫秒计，可在离线测试中缩短；这是内部参数，不是额外用户配置项，完整配置为 14 项。

### 3.3 零交付初始重试与检查点重连

- 可恢复故障且本跳 **零已 `yield` 分片** 时，没有 token 也允许从原请求安全重试，触发原因 `retry-initial`；初次尝试之外最多重试 3 次。
- 已交付任一分片且无 token 时禁止从头重试，即使分片没有可见文本；保留已经交付的内容并明确报告失败。
- 已有 token 时沿用检查点恢复：丢弃未提交尾段，触发 `checkpoint-reconnect` 或 `retry-same-checkpoint`；同一检查点无进展最多重试 3 次，新检查点才重置无进展计数。
- 不可恢复错误、超过服务端等待上限、用户取消或跳数耗尽均应停止；“尚未交付”不保证上游尚未执行或没有用量。

### 3.4 仅思考 STOP 一次自愈

- 条件：本跳观察到思考，没有可见回答或工具调用，未被安全规则阻止，结束原因是 `STOP`，且本逻辑请求尚未自愈过。
- 只允许一次 `thinking-dropout-heal`，不能把非 STOP 的正常终止或安全拦截改为无限续写。
- 有可用 continuation token 时优先续写；没有时在原请求内容后追加保留签名的 `model` 思考 `parts`，再追加以下 `user` 内容：

```text
Continue and provide the final response or tool call.
```

- 触发自愈的 STOP 不得先交给 SDK，避免宿主提前认为本轮已完成；仅控制完成信号，不回收或伪装已交付分片。
- 第二次仅思考 STOP 不再自愈，恢复尝试共用总跳数上限，并沿用请求的输出预算配置。

## 4. Interactions 状态、韧性机制、Tool Retrieval 与只读查询

- [interaction-state.js](<../../interaction-state.js>) 在 `create` 前写入 `stage: 'creating'`。若未获得云端 ID 就断网或退出，保留未知创建锁，禁止自动重复创建；用户可在 Operations 中确认释放本地锁。
- [interactions.js](<../../interactions.js>) 用已知 `interaction.id` 与 `lastEventId` 调用 `get(id, { stream: true, last_event_id })` 续读，避免重复提交已输出内容；兼容 `2026-05-20` 独立生命周期事件（`in_progress`、`requires_action`、`failed`、`cancelled`、`incomplete`、`budget_exceeded`）与回放流 `user_input` 步骤，已确认终态不被后续通知回退，未知非内容生命周期通知不触发远端取消。
- 同会话发起新提示词遇到历史已知 ID 锁时，[interaction-state.js](<../../interaction-state.js>) 先以有界超时执行单次非流式对账：若云端已 `failed` / `cancelled` 或返回 `404` 则移除死记录并放行；若云端已处于 `completed` / `requires_action` / `incomplete` / `budget_exceeded` 终态则保留原 `requestKey` 的未回放句柄同时解除对新提示词的排他阻塞；流内不可恢复错误同样先经非流式对账确认 `failed` / `cancelled` / `404` 后才释放句柄。
- [interaction-query.js](<../../interaction-query.js>) 只执行已知 ID 的单次 `GET`，使用所选路由的当前凭据。查询仍仅接受 `google-vertex` / `google-generative-ai` 两条官方通道。
- 查询不生成、不取消、不执行返回的工具。`query-response` 必须保留，用于读取 `query` 的临时分页结果。

### 4.1 非 2xx 安全错误提取与重试退避

- [interaction-transport.js](<../../interaction-transport.js>) 在 HTTP 非 2xx 分支通过 `readBoundedJson(response, 65536)` 尝试解析错误 JSON（读取失败或超限时静默兜底，绝不抛二次解析异常）。
- **安全防回显红线**：严禁将上游任意 `error.message` 原文拼入对外 `Error.message` 或脱敏诊断日志；只提取经 [diagnostics.js](<../../diagnostics.js>) 白名单校验并归一化为大写 `SNAKE_CASE` 的标准错误码（如 `INVALID_ARGUMENT`、`RESOURCE_EXHAUSTED`、`MODEL_NOT_FOUND` 等）挂至错误或 `cause.code` 供 `fetchErrorCodes()` 采集，并在固定文案中附带 HTTP 状态码与白名单错误码。
- 从 `error.details` 提取 `RetryInfo` / `retryDelay` 传入 `parseUpstreamRetryDelayMs({ headers, details })` 参与退避；仅当用户显式开启 `retainRawResponses: true` 时，[interaction-adapter.js](<../../interaction-adapter.js>) 通过受控响应仓 `observeResponse('interaction-error', hopIndex, parsedJson)` 保留完整错误对象。

### 4.2 流式分阶段滑动看门狗与无状态建连阶段重试

- 对齐 GenerateContent 阶段预算（`initialTtft: 180000`、`thinking: 180000`、`transition: 180000`、`streaming: 120000`，支持内部 `phaseTimeouts` 毫秒覆盖），流式 `create` 与流式 `get` 每跳持有独立 `AbortController`；仅在等待上游连接或 `iterator.next()` 期间计时（`yield` 给下游消费期间暂停计时）。
- 看门狗仅在首次进入 `thinking` / `transition` 阶段、收到非空文本、具名 `function_call` / `tool_search_call`、有界集合 `seenSignatures`（上限 8,192）未见的新签名、新 `event_id` 检查点或终态事件时刷新预算；超时抛出 `code: 'STREAM_PHASE_TIMEOUT'`、`recoverableStreamError: true`，严格区分用户 `options.signal` 取消。非流式 `get` 探针、`cancel`、`delete` 保持原有单次超时。
- 当 `store === false && !background` 时，`retry-initial`（至多 3 次，指数退避叠加服务端等待下限，后续尝试记为 `trigger: 'retry-initial'`、`usedContinuationToken: false`）严格限定在 **`create` 请求建立阶段** 抛出可恢复错误（如 HTTP `408`/`429`/`5xx` 或未建连的瞬态网络错误/建连超时，且 `parseUpstreamRetryDelayMs(err) <= 60000`）时触发；一旦已收到 HTTP `200 text/event-stream` 响应头进入流阶段，断流不再重发 `create` POST；`store: true` 或 `background: true` 下同样严禁重发，避免重复计费。
- [interaction-lifecycle.js](<../../interaction-lifecycle.js>) 的流内可恢复错误码白名单覆盖 `authentication`、`unavailable`、`service_unavailable`、`internal`、`deadline_exceeded`、`gateway_timeout`、`resource_exhausted`、`rate_limit_exceeded`、`too_many_requests`、`quota_exceeded`、`aborted`、`unknown`：命中时标记 `error.recoverableStreamError = true`、不设置 `remoteTerminalError = true`、`interactionExitReason()` 返回 `'read-interrupted'` 而非 `'protocol-error'`（`store: true` 下允许按游标 `GET` 续读重连，无状态或重连耗尽时均不误取消远端后台任务）。

### 4.3 `tool_choice: 'validated'` → `'auto'` 安全退避

- `buildInteractionRequest` 在调用方显式指定合法 `options.toolChoice`（`'auto'` / `'any'` / `'none'` / `'validated'` 或 `{ allowed_tools }`）时优先尊重；未显式指定且存在工具时默认使用 `'validated'`。
- 若未显式指定 `options.toolChoice`、默认使用了 `'validated'`、且首次 `create` 在远端未建单且零交付（`!interactionId && !emitted`）时直接返回 HTTP `400`（且白名单错误码非 `MODEL_NOT_FOUND`），自动构建回退请求将 `generation_config.tool_choice` 改为 `'auto'` 并同步剥离服务端 `{"type":"tool_search"}` 与所有工具上的 `defer_loading` / `short_description`，仅重试 1 次（诊断 hop 记 `trigger: 'retry-original'`、`usedContinuationToken: false`）。

### 4.4 服务端步骤、多模态块回放与 Tool Retrieval（`toolUpdate: 'addition-only'`）

- [interactions.js](<../../interactions.js>) 与 [interactions-input.js](<../../interactions-input.js>) 完整支持服务端步骤 `tool_search_call`、`tool_search_result`、`processing_call`、`processing_result` 及 `model_output.content` / `thought.summary` 中的 `image` / `audio` / `document` / `video` 多模态块：均计入 `MAX_BYTES` 上限、纳入 `captureSnapshot`/`restoreSnapshot` 游标回滚快照、按原始 `index` 顺序连同 `signature` 原样写入 `replaySteps`；服务端步骤不向宿主产出伪造 `tool-call`，非文本块不产出伪造 `text-delta`/`reasoning-delta`；切回 GenerateContent（`generateContentHistory`）时旧回合仍安全降级为纯文本转录。
- [adapter.js](<../../adapter.js>) 导出能力门控 `supportsInteractionsToolRetrieval({ model, route, protocol, mode, apiVersion })`：仅当 `mode !== 'off'`、`protocol === 'interactions'`、`route === 'google-generative-ai'`、`apiVersion !== 'v1'`（自定义网关 URL 显式锁定 `/v1/interactions` 非 `v1beta` 时同样回退为 `false`）且上游模型为官方 Gemini 4 四模型（`argon` / `carbon` / `hydrogen` / `neon`）时返回 `true`。此时 `getProfiles()`（缓存键纳入 `interactionsToolRetrieval`）与 `prepareCall()` 返回的模型元数据声明 `toolUpdate: 'addition-only'`，使宿主 `dsh-llm` 的 `projectToolUpdates` 原样保留 `tool.deferLoading === true`；Vertex AI 通道与显式 `/v1/interactions` 网关一律返回 `false`（不声明 `toolUpdate`，并剥离工具上的 `deferLoading` / `shortDescription`），避免向不支持通道或端点发送 `defer_loading` 触发上游 `400`。
- `interactionsToolRetrieval` 三档（[index.js](<../../index.js>) 第 14 项 `volatile` 配置，默认 `'explicit'`）：`'off'` 关闭；`'explicit'` 仅延迟显式 `deferLoading: true` 工具；`'auto'` 额外对未显式关闭的外部/MCP/插件长尾工具（总工具数 `>= 2`）自动标记 `defer_loading: true`。本适配器仅支持 DSH 本地 `function` 工具（含宿主桥接的 `mcp__*` 函数工具）与服务端 `{"type":"tool_search"}`（存在至少 1 个 `defer_loading: true` 工具时在 `tools` 首位注入，严禁附带 `name`/`description`/`parameters`，各工具仍发送完整 `parameters` schema）；若显式传入原生远端 `mcp_server` 工具或客户端模式 `execution: 'client'` 的 `tool_search`，均在发包前直接拒绝。
- 开启 `toolUpdate: 'addition-only'` 后，组装 `system_instruction` / `user_input` 时若 `system` / `developer` 消息含 `{ type: 'tool-addition', toolName }` 且命中本次请求的 `deferredToolNames` 集合，跳过写入 `[Tool availability update: tool-addition ...]` 文本（过滤后无剩余文本块则跳过整条消息），既保护提示词缓存前缀又避免诱发模型跳过 `tool_search` 直接调用延迟工具而报 `400 Server side tool call context must be circulated`。

## 5. 精简诊断、存储兼容与 Inspector

### 基本计数，不做价格或模态聚合

[diagnostics.js](<../../diagnostics.js>) 与 [diagnostic-store.js](<../../diagnostic-store.js>) 只保留请求级 11 项 `tokenUsage`：

```text
reportedInputTokens, reportedCacheTokens, outputTokens, thoughtsTokens, totalTokens,
billedOutputTokens, billedThoughtsTokens, billedToolTokens,
billedPromptTokens, billedCachedTokens, billedTotalTokens
```

每跳基本计数为 `promptTokens`、`cachedTokens`、`outputTokens`、`thoughtsTokens`、`totalTokens`。输入水位采用首轮原始输入口径，不能用续写后的 prompt 或累计输入冒充上下文长度；Interactions 仅在首个 `model_output` 关闭后开启下一个 `model_output` 续跳时关闭首跳水位窗口（同跳 `function_call` 不关闭），若首跳从未报告 `total_input_tokens` 则保持未知（`null`）且不向宿主交付伪造 `0` 或跨跳累计 `usage` 分片；跨跳累计字段保留上游各次尝试的观测用量，输出/思考/工具累计与已提交输出分开，不折算费用。

新记录严格校验字段；旧版本读取入口仅剔除已退役的 `usageDetails`、`regionClass`，补齐缺失基本计数的兼容默认值，其余未知字段仍按严格规则校验。**读时兼容、写时严格，不改写、不迁移旧磁盘记录。**

### 证据与界面边界

- [request-association.js](<../../request-association.js>) 通过请求标记、`attemptId` 与落盘序号绑定最终 `messageId` / `settlementSeq`；超出容量或关联不确定时宁可丢弃关联，也不串绑消息。
- [client.js](<../../client.js>) 的 Debug 始终读取请求列表，显示摘要、紧凑水位、11 列 hop 轨迹、原始响应和折叠的 `locator` / 完整 `record` JSON；不保留范围聚合服务的调用或权限依赖。
- Operations 保留云端只读查询与全局本地恢复锁管理，分别检查权限与生命周期，范围切换/卸载后不接纳旧异步结果。
- [inspector-service.js](<../../inspector-service.js>) 与 [inspector-tool.js](<../../inspector-tool.js>) 共享本地请求与证据接口；Agent 仅有 `list`、`detail`、`response`、`query`、`query-response` 五个只读动作，不含配置或锁修改能力。
- [response-store.js](<../../response-store.js>) 默认不捕获，显式开启后保留有界上游 JSON；内容可能包括正文、签名、未提交或重放帧。它既不是脱敏内容，也不是跨进程恢复检查点。关闭开关不清除旧记录。

## 6. 已淘汰方案边界

以下能力不重新引入：

- 公开价格快照与费用估算、模态诊断账本、范围概览聚合及对应 UI/工具动作；基本 Token 和原始响应能力仍保留。
- S3 跨进程 GenerateContent 半截流检查点：宿主重启后消息流不能可靠对齐。
- S4 自动协议切换：用户必须显式选择 `googleProtocol` / `vertexProtocol`。
- F05 隐式 Flash 辅助管理请求：不添加第二模型的隐式调用。
- D104 独立付费 JSON 命令与侧栏：只保留 [structured-output.js](<../../structured-output.js>) 的无状态协议转换能力。
