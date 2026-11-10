# Gemini 4 Adapter（dsh-vertex-argon）维护与发版说明

维护前先读现有文档，再核对当前源码；不得仅据历史说明改实现。插件展示品牌名为 **Gemini 4 Adapter**，底层包名保持 `dsh-vertex-argon`，工程版本为 `2.0.0`，宿主兼容 `>=0.2.0-rc.2`，以 [package.json](<package.json>) 为准。依次查阅：

1. [实现架构](<docs/implementation/README.md>)：双官方通道四模型、模块边界、13 项配置与存储域。
2. [协议合同](<docs/implementation/DECISIONS.md>)：双通道凭据隔离、GenerateContent 四项韧性机制、基本诊断与读取兼容。
3. [验证账本](<docs/implementation/STATUS.md>)：本轮验收范围、负责人实测补记区、明确标为历史的长解码记录。

## 工程边界

- **纯插件**：仅通过 DSH 公开的 `llm`、`storageDomain`、`typert`、`settings`、`tools` 与 Web Client Slots 实现；不修改宿主源码或已安装归档，不擅改 profile。
- **本地开发不等于安装**：保留本地工程，仅复用已有依赖；没有明确授权不安装插件、不下载依赖、不发真实上游请求。
- **离线零外网**：所有单元测试必须先加载 [offline-guard.mjs](<test/offline-guard.mjs>)，再加载 [host-loader.mjs](<test/host-loader.mjs>)。测试数与结论来自最终实际日志，不能预填。
- **并行写入有界**：按任务认领范围修改，先读取再编辑；他人正在实现的后端/UI 可读不可越界写。最终差异和测试由负责人统一核验。

## 不得破坏的合同

- 只保留两条官方通道：Vertex AI（`gemini-4-argon` / `gemini-4-carbon`，`route = google-vertex`）与 Gemini API（`gemini-4-argon-google` / `gemini-4-carbon-google`，`route = google-generative-ai`）。上游基础模型 ID 统一由 `officialUpstreamModel` 决定；Gemini API Key 与 Vertex Key 各自独立解析，绝不互相回退或泄漏。
- GenerateContent 首检查点前实时交付；无 token 的初始重试以实际零已 `yield` 分片为前提。保留逐跳隔离超时、服务端等待建议、检查点尾段回滚和最多一次仅思考 STOP 自愈。
- 诊断只保留基本 Token、请求摘要、hop 轨迹与响应证据；不要恢复费用估算、模态账本或范围概览模块。Inspector 维持 Debug / Operations；`query-response` 必须保留，云端 ID 查询只覆盖两条官方通道。
- 存储读兼容、写严格：仅在读取旧记录时剔除已退役字段，不重写旧磁盘数据。原始响应默认不捕获，显式开关关闭不清空既有记录。
- 历史实测必须标明历史来源，不改称本轮 live 验证；没有实测证据不得声明已发布、已安装或已全部通过。
