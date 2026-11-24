# Gemini 4 Adapter（dsh-vertex-argon）维护与发版说明

维护前先读现有文档，再核对当前源码；不得仅据历史说明改实现。插件展示品牌名为 **Gemini 4 Adapter**，底层包名保持 `dsh-vertex-argon`，工程版本与宿主兼容（`>=0.2.0-rc.2`）均以 [package.json](<package.json>) 为准。依次查阅：

1. [实现架构](<docs/implementation/README.md>)：双官方通道八模型、模块边界、15 项配置与存储域。
2. [协议合同](<docs/implementation/DECISIONS.md>)：双通道凭据隔离、GenerateContent / Interactions 双协议韧性机制、Tool Retrieval 门控、Gemini Files API 显式文件切片、基本诊断与读取兼容。
3. [验证账本](<docs/implementation/STATUS.md>)：本轮验收范围、负责人实测补记区、明确标为历史的长解码记录。

## 工程边界

- **纯插件**：仅通过 DSH 公开的 `llm`、`storageDomain`、`typert`、`settings`、`tools` 与 Web Client Slots 实现；不修改宿主源码或已安装归档，不擅改 profile。
- **本地开发不等于安装**：保留本地工程，仅复用已有依赖；没有明确授权不安装插件、不下载依赖、不发真实上游请求。
- **离线零外网**：所有单元测试必须先加载 [offline-guard.mjs](<test/offline-guard.mjs>)，再加载 [host-loader.mjs](<test/host-loader.mjs>)。测试数与结论来自最终实际日志，不能预填。
- **并行写入有界**：按任务认领范围修改，先读取再编辑；他人正在实现的后端/UI 可读不可越界写。最终差异和测试由负责人统一核验。
- **严禁在审查循环中打 Tag 发包**：多轮代码审查与问题收敛一律针对本地工作区源码与离线单测进行，经总工 Triage 拍板定稿后，收尾只打一次 `v*` 标签触发一次正式 npm 发版，再升级桌面 Profile 做实机验收。

## 不得破坏的合同

- 只保留两条官方通道：Vertex AI（`gemini-4-argon` / `gemini-4-carbon` / `gemini-4-hydrogen` / `gemini-4-neon`，`route = google-vertex`）与 Gemini API（`gemini-4-argon-google` / `gemini-4-carbon-google` / `gemini-4-hydrogen-google` / `gemini-4-neon-google`，`route = google-generative-ai`）。思考档位按模型分集：`gemini-4-hydrogen*` 与 `gemini-4-neon*`（`supportsXhighReasoning`）支持 `low` / `medium` / `high` / `xhigh` 四档（官方默认 `high`，`max` 收敛为 `xhigh`，并在 GenerateContent 出站前剥离 `cachedContent` / `cached_content`；`minimal` 与 `off` 一律拒绝），Argon 与 Carbon 严格三档（`max` 收敛为 `high`），`xhigh` 必须当场在发包前以 `UNSUPPORTED_REASONING_EFFORT`（GenerateContent）或参数校验错误（Interactions）拒绝，绝不泄漏。上游基础模型 ID 统一由 `officialUpstreamModel` 决定；Gemini API Key 与 Vertex Key 各自独立解析，绝不互相回退或泄漏。
- GenerateContent 首检查点前实时交付；无 token 的初始重试以实际零已 `yield` 分片为前提。保留逐跳隔离超时、服务端等待建议、检查点尾段回滚和最多一次仅思考 STOP 自愈。
- Interactions 协议保留四项韧性与 Tool Retrieval 契约：非 2xx 仅提取受白名单校验的归一化错误码与 `RetryInfo` 延时，**严禁将上游 `error.message` 原文拼入对外错误或脱敏诊断**；流式采用每跳独立分阶段看门狗（`180s/180s/180s/120s`），流内瞬态错误码白名单覆盖 `service_unavailable` / `too_many_requests` / `rate_limit_exceeded` / `quota_exceeded` 等同源瞬态错误（识别为 `recoverableStreamError: true`、不置 `remoteTerminalError`、退出原因 `'read-interrupted'` 不误取消远端任务）；无状态 `retry-initial`（`store: false && !interactionsBackground`，至多 3 次）严格限定在 `create` 请求建立阶段（如 HTTP `408/429/5xx` 或建连超时）触发，收到 HTTP `200 text/event-stream` 响应头进入流阶段或处于 `store: true`/后台模式时严禁重发 `POST`；默认 `tool_choice: 'validated'` 遇远端未建单 HTTP `400`（非 `MODEL_NOT_FOUND`）时退避至 `'auto'` 并同步剥离 `tool_search` 与 `defer_loading` / `short_description` 重试 1 次；仅支持 DSH 本地 `function` 工具（含宿主桥接 `mcp__*` 函数）与服务端 `{"type": "tool_search"}`（发包前拒绝原生远端 `mcp_server` 与客户端 `execution: "client"` `tool_search`），服务端 Tool Retrieval（`interactionsToolRetrieval` + 宿主 `toolUpdate: 'addition-only'`）在 Gemini API + Interactions `v1beta` 下的四模型（Argon / Carbon / Hydrogen / Neon）生效，Vertex AI 与显式锁定 `/v1/interactions` 的自定义网关自动回退全量加载，且禁止将已延迟工具的 `tool-addition` 写入 `system_instruction`。
- Gemini Files API 文件切片（`allowGeminiFilesApi`，第 15 项 `volatile` 配置，默认 `false`）：仅向 **Gemini API 官方四模型（`*-google`）** 开放（Vertex AI 与非 Gemini API 通道一律拒绝，显式 `/v1/interactions` 同样门控；严禁接受 Vertex 保留环境变量名作 Developer API Key）。关闭时不注册延迟工具 `argon_slice_file`、不上传本地文件、不注入远端 URI；运行中撤销立即中止在途分块上传（`revokeConsent()`）并在双协议发包前动态停止注入。单句柄读取校验防 TOCTOU、分块上限严格 `<= 8 MiB`、在途并发上限 `4`、按 `(principalHash, endpointBase, sha256, mimeType)` 去重（48h 钳制）并按 `sliceId` 1:1 绑定、单会话最多 6 个活跃切片超窗卸载；会话日志仅持久化纯文本 JSON（不新增 `storageDomain`）。
- 诊断只保留基本 Token、请求摘要、hop 轨迹与响应证据；不要恢复费用估算、模态账本或范围概览模块。Inspector 维持 Debug / Operations；`query-response` 必须保留，云端 ID 查询只覆盖两条官方通道。
- 存储读兼容、写严格：仅在读取旧记录时剔除已退役字段，不重写旧磁盘数据。原始响应默认不捕获，显式开关关闭不清空既有记录。
- 历史实测必须标明历史来源，不改称本轮 live 验证；没有实测证据不得声明已发布、已安装或已全部通过。
