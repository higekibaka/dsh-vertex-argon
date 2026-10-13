# dsh-vertex-argon

DeepSeek Harness (DSH) 专用的 **Gemini 4 Argon（Vertex AI & Gemini API 双通道）** 插件。

解决 DSH 内置 `pi-ai` 适配器对 `gemini-4-argon` 发送 `thinkingBudget` 导致 `HTTP 400`、无法切换思考档位、无法显示思维链（思考摘要）的问题。

## 核心特性

1. **双通道自动检测与聚合**
   - 检测到 `google-vertex` 配置了 `gemini-4-argon`（或默认状态）时，在 **Vertex Argon** 分组下显示 **`Gemini 4 Argon (Vertex AI)`**（模型 ID：`gemini-4-argon`）。
   - 检测到 `google`（Gemini Developer API）配置了 `gemini-4-argon` 时，自动在同一个 **Vertex Argon** 分组下多显示一项 **`Gemini 4 Argon (Gemini API)`**（模型 ID：`gemini-4-argon-google`），自动复用已配置的 `GOOGLE_API_KEY`。
2. **原生三档思考控制（`LOW / MEDIUM / HIGH`）**
   - 严格对齐 [Google Cloud Gemini 4 Argon 官方文档](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon)，发送离散 `thinkingLevel`（默认 `MEDIUM`），彻底不发送 `thinkingBudget`，并自动剔除被 Argon 忽略的采样参数（`temperature`、`topP`、`topK`）。
3. **思维链（思考摘要）与多轮工具调用签名回传**
   - 固定开启 `includeThoughts: true`，解析 `thought: true` 内容块并在界面展示思考过程。
   - 完整保留 `functionCall` 的 `thoughtSignature` 签名，确保多步工具调用（`run_code` 等）回传不丢上下文。
4. **原生分组兜底保护**
   - 同时为原生的 `Google` 与 `Google Vertex AI` 路由注入 `Gemini 4` `thinkingLevel` 兼容补丁，即使误选原分组下的 `gemini-4-argon` 也不会报 400 错误。
5. **专属设置页面（设置 → Vertex Argon）**
   - 实时控制模型选择器显隐、切换默认思考档位（`Low / Medium / High`）、调整单次流式最大输出上限（默认 `65,536`）与共享上下文窗口（默认 `1,048,576`）。

## 安装方法

### 从 npm 安装

在 DSH 会话中直接对 Agent 发送：

> `请用 plugin_manager 的 install_bundle 安装 dsh-vertex-argon`

或在 DSH **设置 → 插件** 中搜索/输入 `dsh-vertex-argon` 安装。

### 前置凭据配置（二选一或同时使用）

- **方式 A：Google Vertex AI（服务账号 JSON / ADC）**
  在系统用户环境变量中设置以下 3 项，设置后**完全退出 DSH（含系统托盘）并重开**：
  - `GOOGLE_APPLICATION_CREDENTIALS`：本地服务账号 JSON 密钥文件的完整路径（不加引号）
  - `GOOGLE_CLOUD_PROJECT`：Google Cloud 项目 ID
  - `GOOGLE_CLOUD_LOCATION`：`global`（或 `us` / `eu`）
- **方式 B：Google Gemini API（AI Studio API Key）**
  在 DSH **设置 → 模型 → Google** 中配置 `GOOGLE_API_KEY`，并添加模型 ID `gemini-4-argon`。插件会自动检测并在 **Vertex Argon** 分组下展示 `Gemini 4 Argon (Gemini API)`。

## License

MIT © hgk
