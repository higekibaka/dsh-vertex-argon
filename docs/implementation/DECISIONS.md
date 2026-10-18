# dsh-vertex-argon 核心技术决定与协议合同 (v1.5.0)

本文档汇总 `dsh-vertex-argon` v1.5.0 当前生效的架构决定与已明确淘汰的历史方案。

---

## 1. 路由、凭据与服务层级合同

1. **凭据严格优先级与 Fail-Closed（`adapter.js`）**
   - 凭据按 `ctx.credentials` → `ctx.launchEnvironment` → `process.env` 顺序解析。
   - 若 `ctx.credentials.resolve()` 抛出异常，立即失败退出（Fail-Closed），**严禁**静默回退到环境变量中的旧 Key。
2. **服务层级与 PayGo 能力矩阵（`service-level.js`）**
   - `google-generative-ai`（`generate-content` 与 `interactions`）：支持 `standard`、`flex`、`priority`。
   - `google-vertex/generate-content`：支持 `standard`、`priority`（通过请求头 `X-Vertex-AI-LLM-Shared-Request-Type: priority`），支持 `vertexPaygoOnly`（注入 `X-Vertex-AI-LLM-Request-Type: shared`）。
   - `google-vertex/interactions`：仅验证 `standard`；若配置 `flex`、`priority` 或 `vertexPaygoOnly: true`，在发包前以 `ARGON_SERVICE_TIER_UNVERIFIED` 拒绝，绝不静默降级或升档计费。
3. **推理强度封顶（`index.js` / `adapter.js`）**
   - Argon 上游支持 `MINIMAL` / `LOW` / `MEDIUM` / `HIGH`；当宿主或预设传入 `reasoningEffort: "max"` 时，在 `agent/request` 钩子中统一收敛为 `"high"`。

---

## 2. GenerateContent 长解码与签名无损回放

1. **多跳 `continuationToken` 续写（`generate-content.js`）**
   - 开启 `longDecode: true` 时，Vertex 路由切换至 `v1beta1`（Gemini API 使用 `v1beta`），单跳请求 `maxOutputTokens` 上限为 `65,536`，跨跳总预算上限为 `1,048,576`（最多 `MAX_CONTINUATION_HOPS = 32` 跳）。
   - 当某跳返回 `finishReason === "CONTINUATION"` 且携带有效 `continuationToken` 时，保持原请求体不变（仅更新顶层 `continuationToken`）自动发起下一跳。
2. **流中断恢复与 HTTP 200 内联错误拦截（`generate-content.js`）**
   - 流意外中断但已收到非空 `continuationToken` 时，按指数退避 + 抖动（`500ms` 基准，`10000ms` 上限，`0.1` 抖动率）从最新检查点续传，同一检查点无进展最多重试 `MAX_RETRIES_WITHOUT_PROGRESS = 3` 次。
   - 若 HTTP 200 SSE 事件流内出现顶层 `{ error }` 对象，立即终止当前流并记入当前跳诊断；仅当状态码属于可重试集合（`408, 429, 500, 502, 503, 504`）且持有检查点时才触发续传。
3. **仅含签名的空 `Part` 无损回放（`google-signatures.js`）**
   - 上游在思维链或工具调用前后可能返回仅含 `thoughtSignature` / `thought_signature` 而无文本的 `Part`。插件将其编码为稳定载体并在后续多轮回放时原样还原，避免多轮签名校验失败。
4. **水位线与累计计费 Token 双轨分离（`diagnostics.js`）**
   - 向宿主会话上报的 `usage.input` 采用最后一跳的 `promptTokenCount`（代表当前上下文窗口真实水位线，避免触发虚假自动压缩）。
   - 诊断记录额外保留 `billedPromptTokens` 与 `billedTotalTokens`（累加每一跳的 `promptTokenCount`），供成本估算与审计使用。

---

## 3. Interactions 后台模式与恢复合同

1. **预写意图锁与未知创建保护（`interaction-state.js`）**
   - 在发起 `interactions.create` 前先落盘 `phase: "creating"`。若创建请求在收到服务端 `interaction.id` 前因网络中断或进程退出而失联，状态保持阻塞，禁止自动重发导致双倍计费，须由用户在 UI 中显式点击释放。
2. **基于 `last_event_id` 的流式断点续读（`interactions.js`）**
   - 已获得 `interaction.id` 与 `lastEventId` 的后台任务在重连时调用 `interactions.get(id, { stream: true, last_event_id })`，避免重复下发已输出的文本或工具调用块。

---

## 4. 诊断关联、公开定价与 Inspector 合同

1. **请求到消息的精确关联（`request-association.js`）**
   - 通过 WeakMap 跨 `LlmRuntime` 克隆传递请求标记，结合 `agent/assistant-stream` 的 `attemptId` 与 `session/event` 的落盘序号，将每条诊断记录精确关联至最终 `messageId` 与 `settlementSeq`；超过容量上限（256 个活跃 Agent / 64 个待决诊断）时宁可放弃关联（Fail-Closed）也绝不串绑到错误消息。
2. **公开价格快照与非账单声明（`pricing.js`）**
   - 价格快照 `argon-public-2026-10-18` 明确标示 `billingVerified: false`，区分促销期（2026-12-01 UTC 前）与常规定价，以及 Vertex `global` 与非 `global` 区域（`1.1x`）系数；缺失任何模态分项或未完成请求时，`estimatedUsd` 返回 `null` 并仅展示 `knownSubtotalUsd`。
3. **只读 Agent 工具 `argon_inspect`（`inspector-tool.js`）**
   - 默认 `deferLoading: true`，仅允许读取当前执行会话的诊断、原始响应分片或执行单次只读 Cloud Interaction `GET` 查询；不包含任何配置修改、后台锁释放或云端工具执行能力。

---

## 5. 已淘汰与不纳入发版的历史方案（严禁重新引入）

以下早期探索方案已确认淘汰并从代码库及发布包中移除：
- **S3 跨进程 GenerateContent 检查点存储（原 `generate-content-checkpoint.js`）**：因 DSH 宿主重启后会话消息流已重置，插件侧跨进程半截流拼接无法与宿主消息状态对齐，已取消并移除。
- **S4 自动协议路由策略（原 `protocol-policy.js`）**：协议切换改变工具回放、签名与计费行为，改为完全由用户按路由显式配置 `googleProtocol` / `vertexProtocol`。
- **F05 Flash 辅助管理会话（原 `management-policy.js` / `management-input.js`）**：不引入第二模型隐式请求，已取消并移除。
- **D104 独立付费 JSON 命令与侧栏（原 `structured-result-command.js`）**：独立命令会触发额外付费请求且与主对话流割裂，已退役移除；底层无状态的 `structured-output.js` 协议转换器保留。
