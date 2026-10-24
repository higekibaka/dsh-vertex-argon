# dsh-vertex-argon

![Vertex Argon](<icon.svg>)

**为 [DeepSeek Harness](<https://github.com/deepseek-ai/deepseek-harness>) 提供 Vertex AI、Gemini API、Antigravity 三路由，以及 GenerateContent / Interactions 双协议接入。**

工程版本 **1.6.0**；兼容 **DSH 0.2.1-rc.2 / 0.2.1-rc.3**，Node.js `^22.19.0 || >=24.0.0`。版本与依赖以 [package.json](<package.json>) 为准；历史变更见 [CHANGELOG.md](<CHANGELOG.md>)。本文说明本地工程，不代表已安装、已发布或已完成本轮云端实测。

[三路由与凭据](<#三路由与凭据>) · [完整配置](<#完整配置16-项>) · [流式恢复](<#generatecontent四项韧性机制>) · [Inspector](<#argon-inspectordebug-与-operations>) · [历史实测](<#历史实测奥德赛七号全年舰长日志>)

## 核心能力

- **独立第三模型**：Antigravity 使用 `gemini-4-argon-proxy`，独立地址与专属密钥，不覆盖 Gemini API 模型。
- **GenerateContent 长解码**：单跳输出上限 `65,536`，输出预算配置最高 `1,048,576`，所有尝试共用 32 跳上限；支持检查点恢复、阶段超时、安全首包重试和仅思考结束自愈。
- **Interactions 后台恢复**：显式启用后台与存储后，用 `creating` 预写锁防止未知创建被自动重发，以 `last_event_id` 续读已知任务。
- **签名保真**：保留并回放仅含 `thoughtSignature` / `thought_signature` 的空 `Part`；思考档位为 `low` / `medium` / `high`，宿主传入 `max` 时收敛为 `high`。
- **聚焦请求诊断**：只展示请求摘要、基本 Token 水位、逐跳轨迹、原始响应和完整 JSON，不再提供费用估算、模态用量或范围概览。

## 三路由与凭据

Provider ID 保持 `google-vertex-argon`，模型位于 **Vertex Argon** 分组。实现见 [adapter.js](<adapter.js>) 与 [google-connection.js](<google-connection.js>)。

| 接入通道 | 独立模型 ID | 协议/诊断 `route` | 协议与服务层级配置 |
|---|---|---|---|
| Vertex AI | `gemini-4-argon` | `google-vertex` | `vertexProtocol` / `vertexServiceTier` |
| Gemini Developer API | `gemini-4-argon-google` | `google-generative-ai` | `googleProtocol` / `googleServiceTier` |
| Antigravity Proxy | `gemini-4-argon-proxy` | `google-generative-ai` | 复用 `googleProtocol` / `googleServiceTier` |

这里的“三路由”指三个独立模型与连接目标，**并未新增第三种诊断 `route` 值**。Inspector 根据独立 `model` 显示 **Antigravity Proxy**。代理启用条件为 `proxyEnabled === true || explicitRoutes.hasProxy === true`；默认关闭，仅配置密钥不会自动开启。

### Vertex AI

- ADC 模式使用 `GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）与 `GOOGLE_CLOUD_LOCATION`。
- Vertex Express 模式使用 `GOOGLE_CLOUD_API_KEY`。
- Google/Vertex 凭据按 DSH `credentials` → `launchEnvironment` → `process.env` 解析；凭据服务抛错时立即失败，不偷偷回退到旧环境密钥。

### Gemini API

使用 `GOOGLE_API_KEY` 或 `GEMINI_API_KEY`；其连接地址与凭据不会因启用 Antigravity 而改变。

### Antigravity Proxy

在 **设置 → Vertex Argon → Antigravity Proxy** 中启用独立模型，配置地址与专属密钥：

- `proxyBaseUrl` 默认 `http://127.0.0.1:8045/v1beta`；只接受 `http` / `https`。仅有根路径时补 `/v1beta`，非根路径去掉末尾斜杠。
- `proxyApiKey` 先去除首尾空白；有值时使用设置值，否则只读取 `ANTIGRAVITY_API_KEY`。
- **绝不回退到 Google/Vertex 密钥，也不把代理密钥送往 Google/Vertex。** 缺少专属密钥时应明确失败。
- 地址和密钥使用草稿输入，失焦或点击保存后提交，重置恢复默认值。填写的 Key 保存在插件配置中，密码框仅遮挡显示；也可留空并使用 DSH 凭据中的 `ANTIGRAVITY_API_KEY`，避免直接填写配置。设置实时更新时，模型列表缓存随之失效。
- 代理沿用 Google 协议与服务层级配置；具体端点是否支持所选能力仍取决于代理实现，不是新增的云端验证结论。

## 完整配置：16 项

以下为 [index.js](<index.js>) 中的全部 `volatile` 配置。保存后实时更新；界面由 [client.js](<client.js>) 提供。

| 分组 | 字段 | 默认值 | 范围与说明 |
|---|---|---|---|
| 基础与生成 | `showInModelPicker` | `true` | 是否在模型选择器显示插件模型 |
| 基础与生成 | `reasoning` | `medium` | `low` / `medium` / `high` |
| 基础与生成 | `maxTokens` | `65536` | `1`–`1048576`；超过单跳预算需启用长解码 |
| 基础与生成 | `contextWindow` | `1048576` | `1`–`1048576` |
| 基础与生成 | `longDecode` | `true` | GenerateContent 多跳/检查点续传和仅思考自愈；关闭不禁用零交付初始重试 |
| 协议与服务层级 | `googleProtocol` | `generate-content` | `generate-content` / `interactions`；Gemini API 与代理共用 |
| 协议与服务层级 | `vertexProtocol` | `generate-content` | `generate-content` / `interactions` |
| 协议与服务层级 | `googleServiceTier` | `standard` | `standard` / `flex` / `priority`；Gemini API 与代理共用 |
| 协议与服务层级 | `vertexServiceTier` | `standard` | `standard` / `flex` / `priority`；实际允许组合见下表 |
| 协议与服务层级 | `vertexPaygoOnly` | `false` | 仅 Vertex GenerateContent 的共享池请求 |
| Antigravity Proxy | `proxyEnabled` | `false` | 启用独立代理模型；显式路由也可开启 |
| Antigravity Proxy | `proxyBaseUrl` | `http://127.0.0.1:8045/v1beta` | HTTP(S) 代理地址，按上述规则规范化 |
| Antigravity Proxy | `proxyApiKey` | 空字符串 | 去除首尾空白后优先使用；空值只回退 `ANTIGRAVITY_API_KEY` |
| Interactions 后台模式 | `interactionsBackground` | `false` | 启用后台执行，须同时允许云端存储 |
| Interactions 后台模式 | `allowInteractionStorage` | `false` | 允许发送 `store: true`，用于后台恢复 |
| 诊断与高级 | `retainRawResponses` | `false` | 显式允许捕获新的上游 JSON 响应；关闭不清空旧记录 |

### 服务层级与 Vertex PayGo

[service-level.js](<service-level.js>) 在发包前校验能力矩阵；未支持的组合以 `ARGON_SERVICE_TIER_UNVERIFIED` 拒绝，不自动切换协议或层级。

| `route` | 协议 | 服务层级 | `vertexPaygoOnly` |
|---|---|---|---|
| `google-generative-ai`（含代理） | `generate-content` | `standard` / `flex` / `priority` | 不适用 |
| `google-generative-ai`（含代理） | `interactions` | `standard` / `flex` / `priority` | 不适用 |
| `google-vertex` | `generate-content` | `standard` / `priority` | 支持 |
| `google-vertex` | `interactions` | 仅 `standard` | 不支持 |

Vertex GenerateContent 通过 `X-Vertex-AI-LLM-Shared-Request-Type: priority` 指定优先层级，通过 `X-Vertex-AI-LLM-Request-Type: shared` 指定 PayGo 共享池。请求值与响应观测值分别保留，不把请求值当作实际执行回执。

## GenerateContent：四项韧性机制

实现见 [generate-content.js](<generate-content.js>)；精确边界见 [协议合同](<docs/implementation/DECISIONS.md>)。开启 `longDecode` 后，Vertex 使用 `v1beta1`，Gemini API / Antigravity 使用 `v1beta`。关闭长解码仅禁用多跳/检查点续传与仅思考自愈，零交付初始重试和阶段超时仍可用。

1. **流内错误与服务端等待建议**：HTTP `200` 的 SSE 也可能包含顶层 `{ error }`。插件单独记录流内状态，解析 `Retry-After`、Google `details` 中的重试/配额恢复延时以及消息中的等待提示，取有效建议并加 `200ms` 余量，与本地退避共同决定等待；解析后的延时超过 `60s` 立即失败，不长期占用重试。
2. **每跳独立的阶段超时**：首包、思考、思考到可见输出的转换阶段各 `180s`，可见文本或工具流的滑动等待为 `120s`。每跳使用独立 `AbortController`；上游阻塞可终止，不把用户主动取消当作可恢复故障，也不让上一跳定时器影响下一跳。消费方暂停读取不消耗上游等待预算。
3. **首包安全重试与检查点恢复**：可恢复故障发生时，若本跳尚未向调用方 `yield` 任何分片，即使没有 `continuationToken` 也可 `retry-initial`，初次尝试之外最多重试 3 次；已有分片交付但没有检查点时不得整段重试。有检查点则丢弃未提交尾段并从检查点重连，同一检查点无进展也最多重试 3 次。**首个检查点之前实时 `yield`，不把整段输出全部缓存到检查点。**
4. **仅思考 STOP 自愈**：一跳只有思考、没有可见回答或工具调用，却以 `STOP` 结束时，最多追加一次 `thinking-dropout-heal`。有可用 token 则用 token 续写；没有则保留原思考与签名，追加 `model` 思考内容及 `user` 消息 `Continue and provide the final response or tool call.`。被安全规则阻止的回答不因此绕过限制；第二次仅思考结束不再循环。

正常 `CONTINUATION` 仍需携带有效的新 token 才进入下一跳。重试、自愈与正常续写共用总跳数上限，沿用请求的输出预算配置；不额外承诺跨重试实际总用量封顶。

## Argon Inspector：Debug 与 Operations

从右侧栏 **Argon**、对话主视图 **Argon Inspector** 或单条回复顶部图标进入。诊断通过 [request-association.js](<request-association.js>) 绑定到最终 `messageId` 与 `settlementSeq`；未确认的关联不会猜测绑定。

### Debug：围绕一条请求看证据

- 范围可选 **This Conversation**、**Selected Answer**、**All Recent**；通过 `listRequests` 取得请求列表，不依赖范围聚合服务。
- **请求摘要**：请求 ID、路由、协议、思考档位、结果、失败类别、耗时、最终结束原因与关联状态。Antigravity 依据 `model` 单独显示。
- **紧凑 Token 水位**：`In / Cache / Out / Think / Total`；多跳时附 `Billed In / Billed Total`。这是计数，不是费用。
- **逐跳轨迹**：`hopIndex`、`trigger`、`status`、`streamErrorStatus`、`errorPhase`、`backoffDelayMs`、`chunkCount`、`hasCheckpoint`、`finishReason`、`errorCodes`、`durationMs` 共 11 列。
- **原始响应**：显示捕获状态，通过 `ResponsePage` 按帧、按字符分页读取。
- **完整 JSON**：折叠展示 `locator` 与 `record`，保留排障所需的原始诊断字段。

请求级 `tokenUsage` 只保留 11 个基本字段：

```text
reportedInputTokens, reportedCacheTokens, outputTokens, thoughtsTokens, totalTokens,
billedOutputTokens, billedThoughtsTokens, billedToolTokens,
billedPromptTokens, billedCachedTokens, billedTotalTokens
```

每跳仅保留五项 Token 计数：`promptTokens`、`cachedTokens`、`outputTokens`、`thoughtsTokens`、`totalTokens`。输入水位与跨跳累计用量分开：前者用于宿主上下文判断，后者保留各次上游尝试的观测计数，不混作上下文长度或价格。未知用量可为 `null`。

### Operations：显式操作、独立权限

- **云端 Interaction ID 查询**：使用所选路由的当前凭据执行单次只读 `GET`，不恢复生成、不取消任务、不执行返回的工具调用。查询路由仍只有 **Gemini API / Vertex AI**，本轮不新增代理云 ID 查询。
- **后台恢复锁管理**：查看全局本地恢复状态；未知 `creating` 状态只能在用户明确确认后释放。释放本地锁不等于取消远端任务。
- 会话诊断、原始响应、云端查询、查询结果读取和全局锁管理各自检查权限；切换范围或卸载组件后，过期异步结果不得回写新视图。

### 只读 Agent 工具 `argon_inspect`

实现见 [inspector-tool.js](<inspector-tool.js>)，默认延迟加载。本地诊断只限当前执行会话；工具不能改配置或释放锁。

| `action` | 作用 | 关键参数 |
|---|---|---|
| `list` | 列出当前会话请求摘要 | `messageId?`、`limit?`（1–50） |
| `detail` | 分页读取完整诊断与逐跳记录 | `requestId`、`offset?`、`limit?`（1–10） |
| `response` | 分页读取已捕获上游 JSON 帧 | `requestId`、`index?`、`offset?`、`length?` |
| `query` | 对已知云端 ID 发起一次只读查询 | `route`、`id` |
| `query-response` | 读取 `query` 返回的临时结果 | `queryId`、`offset?`、`length?` |

`query-response` 是读取云端查询结果所必需的动作，不能因诊断精简而删除。

## 存储与隐私

- `vertex_argon_diagnostics`：最近 200 条结构化请求诊断；不保存正文或密钥。新写入严格限定字段，读取旧记录时仅兼容剔除已退役的 `usageDetails` / `regionClass`，**不迁移、不重写旧磁盘记录**。
- `vertex_argon_responses`：默认不捕获。显式开启后最多保留 20 条响应记录、总计 64 MiB、单条 16 MiB；关闭仅停止新的捕获。上游 JSON 可能包含正文、签名、未提交尾段或重放内容，不是脱敏正文、HTTP 原始字节或恢复检查点。
- `vertex_argon_interactions`：后台任务的创建锁与恢复游标。

诊断与捕获实现见 [diagnostics.js](<diagnostics.js>)、[diagnostic-store.js](<diagnostic-store.js>)、[response-store.js](<response-store.js>)。原始响应一律视为不可信数据。

## 历史实测：奥德赛七号全年舰长日志

> 以下是 **v1.5.0 历史云端实测**，保留用于说明长解码已有依据；**不是 v1.6.0 本轮新增 live 验证，也不能证明 Antigravity 或新增恢复分支已在云端验证**。本轮验证状态见 [验证账本](<docs/implementation/STATUS.md>)。

历史任务要求单回合连续输出 `DAY 001` 至 `DAY 365` 的全年日志，保持每日状态、每周维护、月末报告以及第 100/200/215/300/365 天的长期事件。原记录记载全年日志与状态台账完成；本文未重新运行或逐篇复核内容。

诊断 ID：`f911d0c5-fe7a-43ca-b205-5d2202105a41`。

| 历史指标 | 记录值 |
|---|---|
| 路由 / 模型 / 协议 | `google-vertex` / `gemini-4-argon` / `generate-content`，`v1beta1` |
| 思考 / 输出预算 | `LOW` / `131072`，开启长解码 |
| 请求 / 观测服务层级 | `priority` → `standard`，来源 `traffic-type` |
| 第一跳 | HTTP `200`；`961,781 ms`；`1,291` 块；输入 `52,737`，输出 `65,536`；`CONTINUATION` |
| 第二跳 | HTTP `200`；`476,132 ms`；输入 `118,274`，输出 `33,449`；`STOP` |
| 单回合输出 / 总耗时 | **98,985 tokens** / **1,437,917 ms**（约 23 分 58 秒） |
| 输入水位 / 累计输入 / 累计总量 | `52,737` / `171,011` / `269,996` |
| 跳数 / 重连次数 | `2` / `0` |

## 安装与本地开发

安装是单独的用户操作，不是查看或修改本地工程的必要步骤。需要安装已发布版本时，可在 DSH 中明确请求：

```text
请用 plugin_manager 的 install_bundle 安装 dsh-vertex-argon
```

也可使用宿主 CLI：

```sh
dsh plugin --profile desktop add dsh-vertex-argon
```

本仓开发只复用已有依赖，不修改宿主源码、已安装归档或 profile；不为了验证本地变更自动安装。架构边界见 [实现架构](<docs/implementation/README.md>)，维护约束见 [AGENTS.md](<AGENTS.md>)。

### 离线测试

```bash
npm test
# 显式指定已有宿主依赖：
DSH_TEST_HOST_ROOT=/path/to/deepseek-harness npm test
```

[offline-guard.mjs](<test/offline-guard.mjs>) 必须先于 [host-loader.mjs](<test/host-loader.mjs>) 加载；测试仅允许自身创建的临时 IPv4 回环服务，不调用真实上游。加载器先按 Node 正常规则解析，再使用显式宿主根、相邻源码树、desktop profile 或已有桌面依赖；普通 Node 必要时只读解出已有 ASAR 的包到仓库缓存，校验路径、归档边界及完整性，不联网下载。

[host-internals.mjs](<test/host-internals.mjs>) 复用真实宿主工厂和匹配版本的 React/ReactDOM，不替换为模拟实现。测试数量与通过结果由最终实际运行得出，统一记录到 [验证账本](<docs/implementation/STATUS.md>)，不预填固定测试总数。

## 与 billion-context 配合使用

旧代理版本可能修改消息顺序或丢弃独立签名，相关历史问题见 [Issue #3159](<https://github.com/ranxianglei/billion-context/issues/3159>) / [PR #3167](<https://github.com/ranxianglei/billion-context/pull/3167>)、[Issue #3158](<https://github.com/ranxianglei/billion-context/issues/3158>) / [PR #3162](<https://github.com/ranxianglei/billion-context/pull/3162>)。可按代理自身文档对目标上游配置透传；这不改变本插件三路由的密钥隔离规则。

## License

[MIT](<LICENSE>) © [hgk](<https://github.com/higekibaka>)

[![powered by dsh](<https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white>)](<https://github.com/deepseek-ai/deepseek-harness>)
