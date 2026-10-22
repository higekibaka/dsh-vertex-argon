# dsh-vertex-argon 实现架构与模块边界 (v1.5.2)

本目录记录 `dsh-vertex-argon` v1.5.2 的现行实现架构、已生效的技术决定以及已淘汰方案边界，直接由现行源码生成并维护。

## 1. 插件定位与宿主契约

- **插件包名**：`dsh-vertex-argon`（Host 插件注册名：`local-vertex-argon`）
- **目标宿主版本**：`dsh 0.2.1-rc.2`（Node.js `^22.19.0 || >=24.0.0`）
- **Provider 与模型注册**：
  - Provider ID：`google-vertex-argon`（同时通过 `installGemini4PiAiPatch` 拦截原生 `google` / `google-vertex` 对 `gemini-4*` 的调用）
  - 模型：`gemini-4-argon`（`google-vertex` 路由）与 `gemini-4-argon-google`（`google-generative-ai` 路由）
- **存储域（Storage Domains）**：
  - `vertex_argon_diagnostics`：最近 200 条请求诊断摘要与分跳账本
  - `vertex_argon_responses`：用户显式开启 `retainRawResponses` 时捕获的上游 JSON 响应（最多 20 条响应记录、总量 64 MiB、单条 16 MiB）；关闭仅停止新请求捕获，不清空已有记录
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
- [generate-content.js](<../../generate-content.js>)：`GenerateContent` 流式执行器、`continuationToken` 多跳长解码（总预算上限 1,048,576 输出 token、最多 32 跳）、流中断指数退避重试（同一检查点无进展最多 3 次）及 HTTP 200 内联错误帧拦截。
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
- [diagnostics.js](<../../diagnostics.js>) / [diagnostic-store.js](<../../diagnostic-store.js>)：请求生命周期诊断追踪、第一跳 prompt 输入水位与跨跳累计计费 Token 双轨统计、环形缓冲与落盘。
- `usage-details.js` / `pricing.js`：模态 Token 拆解（文本/图片/音频/视频/文档）与基于 `argon-public-2026-10-18` 的非账单 USD 成本估算。
- [response-store.js](<../../response-store.js>)：可选的上游 JSON 响应帧存储与按字符分页读取；帧可包含正文、签名及未提交或重放内容，不是已脱敏正文、HTTP 原始字节或恢复检查点。
- `request-association.js`：跨 `LlmRuntime` 克隆追踪请求并精确绑定至最终落盘的 `messageId` 与 `settlementSeq`。
- `inspector-service.js` / `inspector-overview.js` / `inspector-tool.js`：Inspector 宿主查询服务、范围概览聚合器与 `argon_inspect` 只读 Agent 工具。

## 3. 离线测试依赖边界

37 个测试文件统一由 `npm test` 执行；[offline-guard.mjs](<../../test/offline-guard.mjs>) 在 [host-loader.mjs](<../../test/host-loader.mjs>) 之前加载，禁止外网调用。加载器先保留 Node 正常解析，再按显式 `DSH_TEST_HOST_ROOT`、相邻源码树、desktop profile、桌面版已解包依赖回退；只使用已存在路径，不安装依赖。最后可只读复用本机 ASAR，普通 Node 按需将包缓存到仓库 `.tmp/test-host/<归档指纹>/node_modules`；路径和链接必须安全、文件偏移必须位于归档范围，提供的 SHA-256 摘要必须匹配，完整包通过原子重命名供并发进程复用。测试缓存不属于生产模块或发布文件，绝不修改宿主源码、profile 或 ASAR。

[host-internals.mjs](<../../test/host-internals.mjs>) 为侧栏、会话视图、配置表单和 `AssistantStreamAttempt` 测试提供真实模块路径选择。发行版缺少独立源码时，只对真实工厂/ESM 产物附加内部符号导出；Web 基座直接取自已安装的静态模块表，不启动页面。SSR 与目标工厂共用同版本、同实例的真实 React，优先使用源码树或本地安装，本机最后回退到已有的 `O:/AI/kt/outdoor-gear-landing/node_modules`（React/ReactDOM 19.2.8），不写该项目。测试断言和被测控制器实现均保持不变。
