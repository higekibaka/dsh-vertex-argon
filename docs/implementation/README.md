# dsh-vertex-argon 实现架构与模块边界 (v1.5.0)

本目录记录 `dsh-vertex-argon` v1.5.0 的现行实现架构、已生效的技术决定以及已淘汰方案边界，直接由现行源码生成并维护。

## 1. 插件定位与宿主契约

- **插件包名**：`dsh-vertex-argon`（Host 插件注册名：`local-vertex-argon`）
- **目标宿主版本**：`dsh 0.2.1-rc.2`（Node.js `^22.19.0 || >=24.0.0`）
- **Provider 与模型注册**：
  - Provider ID：`google-vertex-argon`（同时通过 `installGemini4PiAiPatch` 拦截原生 `google` / `google-vertex` 对 `gemini-4*` 的调用）
  - 模型：`gemini-4-argon`（`google-vertex` 路由）与 `gemini-4-argon-google`（`google-generative-ai` 路由）
- **存储域（Storage Domains）**：
  - `vertex_argon_diagnostics`：最近 200 条请求诊断摘要与分跳账本
  - `vertex_argon_responses`：用户显式开启 `retainRawResponses` 时的脱敏原始响应帧（上限 50 条）
  - `vertex_argon_interactions`：Interactions 后台模式（`background: true, store: true`）的持久化恢复状态

## 2. 生产模块清单（共 27 个根目录 JS 模块）

### 入口与运行时
- `index.js`：Host 入口，定义 13 项 `volatile` 配置项，挂载存储域、Typert 远程调用、请求关联监听器及延迟加载工具 `argon_inspect`。
- `client.js`：Web Client 入口，提供独立设置页（4 个分组）与 Argon Inspector（右侧栏 Tab、对话主视图 Tab、单条回复 Header 快捷入口）。
- `runtime.js`：统一从宿主运行时解析 `@deepseek-ai/*`、`@earendil-works/pi-ai`、`@google/genai` 与 `zod`。

### 路由、连接与服务层级
- `adapter.js`：`createArgonAdapter` 核心实现、凭据优先级解析（`credentials` → `launchEnvironment` → `process.env`）与 `pi-ai` 补丁。
- `google-connection.js`：创建 `GoogleGenAI` 实例与 Interactions HTTP/SSE 传输层。
- `service-level.js`：校验 `standard` / `flex` / `priority` 服务层级与 `vertexPaygoOnly` 能力矩阵，提取响应真实服务层级。

### GenerateContent 与长解码引擎
- `generate-content.js`：`GenerateContent` 流式执行器、`continuationToken` 多跳长解码（上限 262,144 输出 token）、流中断指数退避重试（上限 6 次）及 HTTP 200 内联错误帧拦截。
- `google-signatures.js`：无损提取并回放仅含 `thoughtSignature` / `thought_signature` 的空内容 `Part`。

### Interactions 引擎与后台恢复
- `interactions.js`：`Interactions` 流式状态机、后台轮询与 `last_event_id` 游标断点续读。
- `interaction-adapter.js`：将 `ArgonAdapter` 请求桥接至 `interactions.js` 并挂载诊断与原始响应记录。
- `interactions-input.js` / `interaction-image.js`：构建 `Interactions` 请求体、工具声明、多模态图片与历史消息。
- `interaction-transport.js`：封装 `create` / `get` / `cancel` 底层请求与 SSE 解析。
- `interaction-state.js` / `interaction-lifecycle.js`：管理 `creating` 预写锁、`in_progress` 恢复状态与轮询生命周期。
- `interaction-query.js`：提供只读 Cloud Interaction ID 单次 `GET` 查询校验与执行。

### 结构化输出辅助
- `structured-output.js` / `bounded-json.js`：基于 `ajv/dist/2020.js` 的严格 JSON Schema 校验、字节/深度/节点数边界保护与双协议 wire 格式转换。

### 诊断、模态用量、公开定价与 Inspector
- `diagnostics.js` / `diagnostic-store.js`：请求生命周期诊断追踪、水位线（Watermark）与累计计费 Token 双轨统计、环形缓冲与落盘。
- `usage-details.js` / `pricing.js`：模态 Token 拆解（文本/图片/音频/视频/文档）与基于 `argon-public-2026-10-18` 的非账单 USD 成本估算。
- `response-store.js`：可选的脱敏原始响应帧存储与按字符分页读取。
- `request-association.js`：跨 `LlmRuntime` 克隆追踪请求并精确绑定至最终落盘的 `messageId` 与 `settlementSeq`。
- `inspector-service.js` / `inspector-overview.js` / `inspector-tool.js`：Inspector 宿主查询服务、范围概览聚合器与 `argon_inspect` 只读 Agent 工具。
