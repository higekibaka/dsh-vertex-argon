# dsh-vertex-argon 核心技术决定与协议合同（v1.6.2）

本文区分当前实现合同与历史实测；验证来源与本轮结果见 [STATUS.md](<STATUS.md>)。

## 1. 三模型、凭据与服务层级

实现入口为 [adapter.js](<../../adapter.js>)、[google-connection.js](<../../google-connection.js>)、[index.js](<../../index.js>)。

### 独立 Antigravity 模型

- `MODEL = gemini-4-argon`，`GOOGLE_API_MODEL = gemini-4-argon-google`，`PROXY_MODEL = gemini-4-argon-proxy`；三者独立注册，不覆盖原有模型。
- 代理启用条件是 `proxyEnabled === true || explicitRoutes.hasProxy === true`。`proxyEnabled` 默认 `false`；仅存在环境密钥不是启用条件。
- 代理的协议/诊断路由仍是 `google-generative-ai`，界面通过 `model` 区分 Antigravity。UI 可识别兼容输入 `route: antigravity-proxy` 的显示名，但不能据此扩展后端路由枚举或云端查询入口。
- `proxyBaseUrl` 默认 `http://127.0.0.1:8045/v1beta`；去除配置首尾空白，只接受 HTTP(S)，根路径补 `/v1beta`，非根路径移除末尾斜杠。
- `proxyApiKey` 去除首尾空白后优先使用；为空时只读取 `ANTIGRAVITY_API_KEY`。绝不借用 `GOOGLE_API_KEY`、`GEMINI_API_KEY`、Vertex Key 或 ADC；代理 Key 也不反向进入 Google/Vertex。设置中的 Key 保存在插件配置，密码框只遮挡显示；可留空改用 DSH 的 `ANTIGRAVITY_API_KEY` 凭据。
- 代理复用 `googleProtocol` / `googleServiceTier`，不增加协议自动选择；三个代理设置均为 `volatile`，模型配置缓存必须随设置和路由变化失效。私有环境传递标记在进入实际 SDK 环境前清除。
- 当选中 `PROXY_MODEL`（`gemini-4-argon-proxy`）时，根据解析后的推理等级（`low` / `medium` / `high`）将发往反代的上游模型 ID 映射为 `gemini-4-argon-low`、`gemini-4-argon-medium`、`gemini-4-argon-high`，使 DSH 推理档位与 `Antigravity Tools` 的三档模型卡片一一对应；官方 Vertex AI 与 Gemini API 直连路由维持发送 `gemini-4-argon`。

### 凭据解析与能力校验

- Google/Vertex 凭据优先级为 `credentials` → `launchEnvironment` → `process.env`。凭据服务自身抛错时直接失败，不能退回旧密钥；代理的设置优先和专属 Key 隔离另行遵守。
- [service-level.js](<../../service-level.js>) 保持既有能力矩阵：Google 路由两种协议支持 `standard` / `flex` / `priority`；Vertex GenerateContent 支持 `standard` / `priority` 及 `vertexPaygoOnly`；Vertex Interactions 仅允许 `standard` 且不允许 PayGo-only。
- 不支持的组合发包前报 `ARGON_SERVICE_TIER_UNVERIFIED`，不暗中降级、升级或切换协议。代理沿用矩阵不等于代理端点已获云端实测证明。
- 请求层级与观测层级分别保存；Vertex 用 `traffic-type`，Google 使用响应头。`max` 推理请求收敛为 `high`，可选择档位维持 `low` / `medium` / `high`。

## 2. GenerateContent 长解码不变式

实现为 [generate-content.js](<../../generate-content.js>)；签名保真由 [google-signatures.js](<../../google-signatures.js>) 负责。

- `longDecode: true` 时，Vertex 使用 `v1beta1`，Gemini API / 代理使用 `v1beta`；单跳输出上限 `65,536`，输出预算配置最高 `1,048,576`，所有尝试合计最多 32 跳。各跳沿用请求预算配置，不动态扣减跨重试剩余 Token，不额外承诺实际总用量封顶。
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
- `meta.phaseTimeouts` 的 `initialTtft`、`thinking`、`transition`、`streaming` 均以毫秒计，可在离线测试中缩短；这是内部参数，不是额外用户配置项，完整配置仍为 16 项。

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

## 4. Interactions 状态与只读查询

- [interaction-state.js](<../../interaction-state.js>) 在 `create` 前写入 `phase: creating`。若未获得云端 ID 就断网或退出，保留未知创建锁，禁止自动重复创建；用户可在 Operations 中确认释放本地锁。
- [interactions.js](<../../interactions.js>) 用已知 `interaction.id` 与 `lastEventId` 调用 `get(id, { stream: true, last_event_id })` 续读，避免重复提交已输出内容；兼容 `2026-05-20` 独立生命周期事件（`in_progress`、`requires_action`、`failed`、`cancelled`、`incomplete`、`budget_exceeded`）与回放流 `user_input` 步骤，已确认终态不被后续通知回退，未知非内容生命周期通知不触发远端取消。
- 同会话发起新提示词遇到历史已知 ID 锁时，[interaction-state.js](<../../interaction-state.js>) 先以有界超时执行单次非流式对账：若云端已 `failed` / `cancelled` 或返回 `404` 则移除死记录并放行；若云端已处于 `completed` / `requires_action` / `incomplete` / `budget_exceeded` 终态则保留原 `requestKey` 的未回放句柄同时解除对新提示词的排他阻塞；流内不可恢复错误同样先经非流式对账确认 `failed` / `cancelled` / `404` 后才释放句柄。
- [interaction-query.js](<../../interaction-query.js>) 只执行已知 ID 的单次 `GET`，使用所选路由的当前凭据。查询仍仅接受 `google-vertex` / `google-generative-ai`；不能因代理共享后者就默认替换为代理查询。
- 查询不生成、不取消、不执行返回的工具。`query-response` 必须保留，用于读取 `query` 的临时分页结果。

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
