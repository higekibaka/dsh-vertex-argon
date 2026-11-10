# Gemini 4 Adapter

![Gemini 4 Adapter](<icon.svg>)

**面向 [DeepSeek Harness](<https://github.com/deepseek-ai/deepseek-harness>) 的 Google 官方双通道（Vertex AI + Gemini Developer API）Gemini 4 适配器，原生支持 Argon 与 Carbon 四模型路由、GenerateContent / Interactions 双协议、65K+ 多跳长解码与请求级诊断。**

- **当前版本**：`2.0.0`（[CHANGELOG.md](<CHANGELOG.md>)）
- **npm 包名**：`dsh-vertex-argon`（保留既有包名、官方通道路由与本地存储域 ID，官方通道用户可直接原地升级；`2.0.0` 已移除 `1.6.x` 非官方反代通道）
- **运行要求**：DSH `>=0.2.0-rc.2`，Node.js `^22.19.0 || >=24.0.0`（见 [package.json](<package.json>)）

[快速开始](<#快速开始>) · [双官方通道与四模型](<#双官方通道与四模型>) · [长解码与流式恢复](<#generatecontent长解码与四项韧性机制>) · [配置速查](<#完整配置13-项>) · [诊断与工具](<#gemini-4-诊断与-argon_inspect-工具>) · [长解码实测参考](<#历史实测参考奥德赛七号全年舰长日志>)

---

## 核心特性

- **双官方通道 × 四模型路由**：同时接入 Google Cloud **Vertex AI**（`gemini-4-argon` / `gemini-4-carbon`）与 **Gemini Developer API**（`gemini-4-argon-google` / `gemini-4-carbon-google`），两通道凭据与网关严格隔离，绝不暗中互借或静默回退。
- **65K+ 多跳长解码与流自愈**：单跳上限 `65,536` tokens，最大输出预算可达 `1,048,576`（最多 32 跳）；首个检查点前实时流式输出，支持检查点尾段回滚续传、逐跳四阶段超时看门狗、零交付首包重试、仅思考结束单次续答自愈，以及 `MALFORMED_FUNCTION_CALL` 后 `VALIDATED` → `AUTO` 工具模式自动退避。
- **Interactions 协议与后台任务恢复**：支持前台流式及显式授权后的云端后台执行；内置 `creating` 预写防重计费锁、`last_event_id` 断点续读、`2026-05-20` 独立生命周期事件兼容，以及同会话新提示词触发的历史死锁非流式探针对账。
- **签名保真与跨模型安全降级**：完整保留并回放 `thoughtSignature` / `thought_signature`（含无文本独立签名块）；原生映射 `low` / `medium` / `high` 三档思考级别（宿主或子代理传入 `max` 时自动收敛为 `high`，永不下发 `thinkingBudget`）；在 Argon ↔ Carbon 或跨通道切换时自动将旧工具历史安全降级为文本记录并清洗污染块。
- **Gemini 4 诊断面板与只读工具**：在右侧栏、会话详情页与单条回复底部提供请求摘要、基础 Token 水位（严格区分首跳上下文水位与跨跳累计用量）、11 列逐跳轨迹、分页原始响应证据、云端 Interaction ID 只读查询与全局恢复锁管理，并向智能体提供延迟加载的只读工具 `argon_inspect`。

---

## 快速开始

### 1. 安装插件

在 DSH 对话中直接请求安装：

```text
请用 plugin_manager 的 install_bundle 安装 dsh-vertex-argon
```

或通过宿主 CLI 安装到桌面 Profile：

```sh
dsh plugin --profile desktop add dsh-vertex-argon
```

### 2. 声明模型入口

在 DSH「**设置 → 模型**」的原生 `Google` 或 `Google Vertex AI` 供应商下添加 `gemini-4-argon` 和/或 `gemini-4-carbon`，插件会自动识别并在模型选择器中暴露 **Gemini 4 Adapter** 分组下的对应模型。

### 3. 配置官方凭据

凭据统一按 DSH `credentials` → `launchEnvironment` → `process.env` 顺序解析；若凭据服务报错将直接失败，不会偷偷回退到旧环境变量。

- **Vertex AI（ADC 模式）**：配置 `GOOGLE_APPLICATION_CREDENTIALS`、`GOOGLE_CLOUD_PROJECT`（或 `GCLOUD_PROJECT`）与 `GOOGLE_CLOUD_LOCATION`。
- **Vertex AI（Express 模式）**：配置 `GOOGLE_CLOUD_API_KEY`。
- **Gemini Developer API**：配置 `GOOGLE_API_KEY` 或 `GEMINI_API_KEY`（或宿主模型设置中指定的 `apiKeyEnv`）。

---

## 双官方通道与四模型

底层 Provider ID 为 `google-vertex-argon`，模型选择器分组显示为 **Gemini 4 Adapter**（实现见 [adapter.js](<adapter.js>) 与 [google-connection.js](<google-connection.js>)）。

| 官方通道 | 模型 ID | 上游基础模型 | 协议/诊断 `route` | 协议与服务层级配置 |
|---|---|---|---|---|
| **Vertex AI** | `gemini-4-argon` | `gemini-4-argon` | `google-vertex` | `vertexProtocol` / `vertexServiceTier` |
| **Vertex AI** | `gemini-4-carbon` | `gemini-4-carbon` | `google-vertex` | `vertexProtocol` / `vertexServiceTier` |
| **Gemini API** | `gemini-4-argon-google` | `gemini-4-argon` | `google-generative-ai` | `googleProtocol` / `googleServiceTier` |
| **Gemini API** | `gemini-4-carbon-google` | `gemini-4-carbon` | `google-generative-ai` | `googleProtocol` / `googleServiceTier` |

### 跨模型切换与历史清洗规则

- **同模型连续对话**：完整保留原生 `thoughtSignature` / `thought_signature` 与 `functionCall` / `functionResponse` 签名回放。
- **跨模型或跨通道切换（如 Argon ↔ Carbon、Vertex ↔ Gemini API）**：出站前自动将含推理或工具调用的旧回合降级为纯文本记录（剔除旧思考块，将已完成工具调用转为角色安全的文本摘要，未完成调用直接拦截），避免因底层摘除跨模型签名而发出裸 `functionCall` 或孤立 `functionResponse`。
- **原生入口兼容保护**：插件同时为宿主原生 `google` 与 `google-vertex` 适配器中的 Gemini 4 模型注入 GenerateContent 思考档位映射、采样参数剥离与签名回放保护。

---

## GenerateContent：长解码与四项韧性机制

开启 `longDecode` 后，Vertex AI 使用 `v1beta1`，Gemini API 使用 `v1beta`（实现见 [generate-content.js](<generate-content.js>)，完整契约见 [协议合同](<docs/implementation/DECISIONS.md>)）。关闭 `longDecode` 仅停用跨跳续传与仅思考自愈，首包零交付重试和阶段看门狗依然生效。

1. **流内错误识别与服务端退避**：HTTP `200` 的 SSE 流中若出现顶层 `{ error }` 同样按流内故障处理。自动解析 `Retry-After`、Google `details` 中的 `retryDelay` / `quotaResetDelay` 及错误文本等待提示，叠加 `200ms` 余量后与指数退避取较大值；若服务端要求等待超过 `60s` 则立即失败，避免无意义长挂起。
2. **逐跳四阶段独立超时看门狗**：首包等待（`initial-ttft`）、思考流（`thinking`）、思考转正文/工具（`transition`）各 `180s`，可见正文或工具流滑动超时 `120s`。每跳持有独立 `AbortController`；仅真实生成进展会刷新超时预算，空心跳帧、空思考帧、无名工具块及重复签名均不会续命，且下游暂停消费不会消耗上游等待计时。
3. **首检查点前实时流式与检查点回滚恢复**：在取得首个 `32,768` token 检查点前实时向界面 `yield` 分片，零缓冲延迟；若在 `yield` 任何分片前遇可恢复中断，支持无 token 的 `retry-initial`（最多重试 3 次）。一旦取得 `continuationToken` 检查点，断流时自动丢弃未确认尾段并从最近检查点续传（同一检查点无进展最多重试 3 次）。
4. **仅思考结束（STOP）单次自愈**：当某一跳输出了思考内容却未产出任何可见文本或工具调用便以 `STOP` 结束（且非安全拦截）时，自动触发至多一次 `thinking-dropout-heal`——有检查点则直接续写，无检查点则携带原签名思考追加续答提示完成本轮输出。

---

## 完整配置：13 项

以下为 [index.js](<index.js>) 定义的全部实时生效配置（UI 设置面板见 [client.js](<client.js>)）：

| 分组 | 配置项 | 默认值 | 取值范围与说明 |
|---|---|---|---|
| 基础与生成 | `showInModelPicker` | `true` | 是否在会话模型选择器中显示 **Gemini 4 Adapter** 分组 |
| 基础与生成 | `reasoning` | `medium` | 默认思考档位：`low` / `medium` / `high` |
| 基础与生成 | `maxTokens` | `65536` | `1`–`1048576`；超过 `65,536` 需启用长解码（窗口 > 131K 时自动预留 131,072 历史空间） |
| 基础与生成 | `contextWindow` | `1048576` | `1`–`1048576`；供 DSH 本地预算与上下文压缩计算使用 |
| 基础与生成 | `longDecode` | `true` | 控制 > 65,536 输出上限、GenerateContent 检查点续传与仅思考自愈 |
| 协议与服务层级 | `googleProtocol` | `generate-content` | `generate-content` / `interactions`（仅作用于 Gemini API） |
| 协议与服务层级 | `vertexProtocol` | `generate-content` | `generate-content` / `interactions`（仅作用于 Vertex AI） |
| 协议与服务层级 | `googleServiceTier` | `standard` | `standard` / `flex` / `priority`（仅作用于 Gemini API） |
| 协议与服务层级 | `vertexServiceTier` | `standard` | `standard` / `flex` / `priority`（受下方能力矩阵约束） |
| 协议与服务层级 | `vertexPaygoOnly` | `false` | 仅为 Vertex AI GenerateContent 附加 PayGo 共享池请求头 |
| Interactions 后台模式 | `allowInteractionStorage` | `false` | 允许向 Google 发送 `store: true` 云端存储许可（后台模式前置条件） |
| Interactions 后台模式 | `interactionsBackground` | `false` | 启用 Interactions 云端后台执行与断点恢复 |
| 诊断与高级 | `retainRawResponses` | `false` | 允许本地留存解析后的上游 JSON 响应帧（关闭不影响既有记录） |

### 服务层级与 Vertex PayGo 能力矩阵

[service-level.js](<service-level.js>) 在发包前执行组合预检；不受支持的组合直接以 `ARGON_SERVICE_TIER_UNVERIFIED` 拒绝，绝不静默篡改用户所选层级或协议。

| 通道 `route` | 协议 | 支持的服务层级 | `vertexPaygoOnly` |
|---|---|---|---|
| `google-generative-ai` | `generate-content` | `standard` / `flex` / `priority` | 不适用 |
| `google-generative-ai` | `interactions` | `standard` / `flex` / `priority` | 不适用 |
| `google-vertex` | `generate-content` | `standard` / `priority` | 支持（`X-Vertex-AI-LLM-Request-Type: shared`） |
| `google-vertex` | `interactions` | 仅 `standard` | 不支持 |

---

## Gemini 4 诊断与 `argon_inspect` 工具

可通过右侧栏 **Gemini 4 诊断**、对话顶栏视图 **Gemini 4 详情** 或每条助手回复下方的详情图标打开面板。诊断记录经 [request-association.js](<request-association.js>) 精确绑定到最终 `messageId` 与 `settlementSeq`。

### Debug 面板：单请求全链路证据

- **请求摘要**：请求 ID、官方通道（`Vertex AI` / `Gemini API`）、协议、思考档位、结果状态、失败类别、总耗时、末跳结束原因与消息关联状态。
- **Token 水位**：清晰拆分单次上下文水位（`reportedInputTokens` / `reportedCacheTokens` / `outputTokens` / `thoughtsTokens` / `totalTokens`）与多跳累计观测计数（`billedPromptTokens` / `billedCachedTokens` / `billedOutputTokens` / `billedThoughtsTokens` / `billedToolTokens` / `billedTotalTokens`），不做虚构计费估算。
- **11 列 Step / Hop 轨迹明细**：逐跳展示 `hopIndex`、`trigger`、`status`、`streamErrorStatus`、`errorPhase`、`backoffDelayMs`、`chunkCount`、`hasCheckpoint`、`finishReason`、`errorCodes` 与 `durationMs`。
- **原始响应与完整 JSON**：开启留存授权后可按帧、按字符分页检视上游 JSON 片段，并查看完整的 `locator` 与脱敏诊断对象。

### Operations 面板：云端查询与恢复锁管理

- **按 ID 查询云端状态**：使用当前通道凭据对已知 Cloud Interaction ID 发起一次只读 `GET`，不会恢复生成、取消任务或执行云端返回的工具调用。
- **全局防重复创建保护**：集中展示本地后台任务的恢复状态；当历史后台创建结果未知（`creating` / `unknown`）时阻止重复扣费请求，支持用户在核实后手动确认解除本地拦截。

### 只读智能体工具 `argon_inspect`

由 [inspector-tool.js](<inspector-tool.js>) 注册（默认 `deferLoading: true`，不占用常规对话首轮上下文），仅读取当前会话诊断或执行显式只读查询：

| `action` | 说明 | 主要参数 |
|---|---|---|
| `list` | 列出当前会话保留的请求摘要 | `messageId?`、`limit?`（1–50） |
| `detail` | 分页读取单条请求的诊断详情与逐跳轨迹 | `requestId`、`offset?`、`limit?`（1–10） |
| `response` | 按帧与字符偏移分页读取本地留存的上游 JSON | `requestId`、`index?`、`offset?`、`length?` |
| `query` | 使用官方通道当前凭据单次只读查询云端 Interaction ID | `route`、`id` |
| `query-response` | 分页读取 `query` 返回的临时查询结果 | `queryId`、`offset?`、`length?` |

---

## 存储与隐私说明

- `vertex_argon_diagnostics`：保留最近 200 条脱敏结构化诊断记录，不含对话正文或密钥；读取旧版本历史记录时自动兼容剔除已退役字段，不改写旧磁盘文件。
- `vertex_argon_responses`：默认关闭；显式开启 `retainRawResponses` 后最多保留 20 条记录（总上限 64 MiB，单条上限 16 MiB / 16,384 帧）。留存内容为解析后的上游 JSON（可能含敏感正文、图片数据与签名），请按不可信数据审慎对待。
- `vertex_argon_interactions`：保存 Interactions 后台模式的预写创建锁与断点恢复游标。

---

## 历史实测参考：奥德赛七号全年舰长日志

> 以下数据采集自 `v1.5.0` 在 Vertex AI `gemini-4-argon` 上的真实长解码运行记录（诊断 ID：`f911d0c5-fe7a-43ca-b205-5d2202105a41`），用于展示跨 `65,536` 单跳上限的多跳续写表现；工程架构与离线回归详情见 [验证账本](<docs/implementation/STATUS.md>)。

任务要求单回合连续生成 `DAY 001` 至 `DAY 365` 的全年舰长日志，完整维持每日状态、每周维护、月末报告与第 100 / 200 / 215 / 300 / 365 天的锚定事件。

| 实测指标 | 记录值 |
|---|---|
| 通道 / 模型 / 协议 | `google-vertex` / `gemini-4-argon` / `generate-content`（`v1beta1`） |
| 思考档位 / 输出预算 | `LOW` / `131,072`（长解码开启） |
| 请求 / 观测服务层级 | `priority` → `standard`（来源：`traffic-type`） |
| Hop 1 | HTTP `200` · `961,781 ms` · `1,291` 块 · 输入 `52,737` / 输出 `65,536` · `CONTINUATION` |
| Hop 2 | HTTP `200` · `476,132 ms` · 输入 `118,274` / 输出 `33,449` · `STOP` |
| 单回合总输出 / 总耗时 | **98,985 tokens** / **1,437,917 ms**（约 23 分 58 秒） |
| 首跳输入水位 / 累计输入 / 累计总量 | `52,737` / `171,011` / `269,996` |
| 总跳数 / 异常重连次数 | `2` / `0` |

---

## 本地开发与离线测试

仓库内部架构说明见 [实现架构](<docs/implementation/README.md>)，协议边界见 [协议合同](<docs/implementation/DECISIONS.md>)，协作规范见 [AGENTS.md](<AGENTS.md>)。

```bash
# 标准离线测试（自动复用本机已有 DSH 依赖，全程拦截真实外网请求）
npm test

# 显式指定宿主目录运行
DSH_TEST_HOST_ROOT=/path/to/deepseek-harness npm test

# Windows 受限沙盒禁止子进程命名管道时，使用单进程聚合运行
node --experimental-transform-types --import ./test/offline-guard.mjs \
  --import ./test/host-loader.mjs --test --test-isolation=none test/*.test.mjs
```

测试套件先经 [offline-guard.mjs](<test/offline-guard.mjs>) 封锁除测试自建 IPv4 回环外的全部网络访问，再由 [host-loader.mjs](<test/host-loader.mjs>) 与 [host-internals.mjs](<test/host-internals.mjs>) 加载真实宿主模块与匹配版本的 React 进行端到端离线核验。

## 与 billion-context 配合提示

较早版本的代理网关可能重排消息或丢弃独立签名块（参考 [Issue #3159](<https://github.com/ranxianglei/billion-context/issues/3159>) / [PR #3167](<https://github.com/ranxianglei/billion-context/pull/3167>)、[Issue #3158](<https://github.com/ranxianglei/billion-context/issues/3158>) / [PR #3162](<https://github.com/ranxianglei/billion-context/pull/3162>)）。搭配自定义网关时请开启对应上游透传支持；本插件的双官方通道凭据隔离规则不受自定义 `baseURL` 影响。

## License

[MIT](<LICENSE>) © [hgk](<https://github.com/higekibaka>)

[![powered by dsh](<https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white>)](<https://github.com/deepseek-ai/deepseek-harness>)
