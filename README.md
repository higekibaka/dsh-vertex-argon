# dsh-vertex-argon

[![npm version](https://img.shields.io/npm/v/dsh-vertex-argon.svg)](https://www.npmjs.com/package/dsh-vertex-argon)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](https://opensource.org/licenses/MIT)

**Google Vertex AI & Gemini Developer API 的 `gemini-4-argon` 双通道适配插件（专用于 DeepSeek Harness / DSH）。**

解决 DSH 内置 `pi-ai` 适配器在调用 `gemini-4-argon` 时误发 `thinkingBudget` 导致 `HTTP 400` 报错、无法切换思考档位、无法显示思维链（思考摘要）以及多轮工具调用丢失签名的问题。

---

## ✨ 核心功能

- **🔍 双通道自动检测与聚合**
  自动扫描 DSH「设置 → 模型」中的配置，统一汇总到模型选择器的 **`Vertex Argon`** 分组下：
  - 检测到 `google-vertex` 配置了 `gemini-4-argon`（或默认状态）→ 显示 **`Gemini 4 Argon (Vertex AI)`**（模型 ID：`gemini-4-argon`，复用本地 Google Cloud ADC / 服务账号环境变量）。
  - 检测到 `google` 配置了 `gemini-4-argon` → 自动多显示一项 **`Gemini 4 Argon (Gemini API)`**（模型 ID：`gemini-4-argon-google`，自动复用已配置的 `GOOGLE_API_KEY`，请求云端时自动映射回 `models/gemini-4-argon`）。
- **🧠 原生三档思考控制（`LOW / MEDIUM / HIGH`）**
  严格遵循 [Google Cloud Gemini 4 Argon 官方规范](https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon)，发送离散 `thinkingLevel`（默认 `MEDIUM`），彻底剔除会触发 400 错误的 `thinkingBudget` 以及被模型忽略的采样参数（`temperature`、`topP`、`topK`）。
- **💡 思维链（思考摘要）与工具调用完整支持**
  - 请求固定携带 `includeThoughts: true`，实时流式解析 `thought: true` 思考内容块并在聊天界面展示思维链。
  - 完整保留 `functionCall` 的 `thoughtSignature` 加密签名，确保多步工具调用（如 `run_code`）结果回传时上下文不断裂。
- **🛡️ 原生分组兜底保护**
  同时为 DSH 内置的 `Google` 与 `Google Vertex AI` 路由注入 `Gemini 4` 运行时兼容补丁——即使在模型选择器中误选了原分组下的 `gemini-4-argon`，也会自动改发 `thinkingLevel` 而不再报 400 错误。
- **⚙️ 专属设置页面（设置 → Vertex Argon）**
  无需手改配置文件，在图形界面即可实时调整：
  - 在模型选择器中显示 / 隐藏 `Vertex Argon` 分组
  - 默认思考档位切换（`Low` / `Medium` / `High`）
  - 单次流式最大输出上限（`8,192` / `16,384` / `32,768` / `65,536`，官方单次流式上限为 `65,536`）
  - 共享上下文窗口上限（`262,144` / `524,288` / `1,048,576`，官方输入+思考+输出共享总窗口为 `1,048,576`）

---

## 🚀 快速安装

在任意 DSH 会话中直接发给 Agent 一句话即可自动完成安装与启用：

```text
请用 plugin_manager 的 install_bundle 安装 dsh-vertex-argon
```

> 若本机默认镜像源尚未同步新发布的版本，可指定官方源安装：
> `请用 plugin_manager 的 install_bundle 从 https://registry.npmjs.org/ 安装 dsh-vertex-argon`

---

## 🔑 凭据配置说明（二选一或同时使用）

### 方式一：通过 Google Vertex AI 使用（服务账号 JSON / ADC）

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 确保项目已绑定结算账户、已启用 **Vertex AI API**（`aiplatform.googleapis.com`），并为服务账号授予 **Vertex AI User**（`roles/aiplatform.user`）角色，下载 JSON 密钥文件。
2. 在系统用户环境变量中添加以下 3 项（Windows 可打开「编辑账户的环境变量 → 用户变量」新建，**变量值不要加引号**）：

| 变量名 | 示例值 | 说明 |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | `C:\Keys\vertex-sa.json` | 服务账号 JSON 密钥文件的完整本地路径 |
| `GOOGLE_CLOUD_PROJECT` | `my-gcp-project-id` | Google Cloud **项目 ID**（注意不是项目名称） |
| `GOOGLE_CLOUD_LOCATION` | `global` | 区域，推荐填 `global`（或 `us` / `eu`） |

3. **完全退出 DSH（包括系统托盘图标）并重新启动**，让进程继承新的环境变量。
4. 在聊天框下方的模型选择器中选择 **`Vertex Argon → Gemini 4 Argon (Vertex AI)`**。

### 方式二：通过 Google Gemini API 使用（AI Studio API Key）

1. 打开 DSH **设置 → 模型 → Google**，填入你的 `GOOGLE_API_KEY`。
2. 在该提供商下添加模型 ID：`gemini-4-argon`。
3. 本插件会自动检测到该配置，并在模型选择器的 **`Vertex Argon`** 分组下展示 **`Gemini 4 Argon (Gemini API)`**，直接选择即可使用。

---

## ❓ 常见问题与注意事项

1. **为什么有时候简单问题没有显示思维链文本？**
   插件已固定发送 `includeThoughts: true`，但 Google 云端会根据问题复杂度动态决定是否输出可读摘要：遇到推理或工具调用任务时会返回思考摘要，极简问答可能只返回 `thoughtSignature` 签名而不显示思考文本，属正常现象。
2. **Gemini 网页版会员包含这里的费用吗？**
   不包含。无论通过 Vertex AI 还是 Gemini API 调用，均按 Google Cloud / Google AI Studio 的 API 账单计费。
3. **兼容哪些 DSH 版本？**
   兼容 DSH `0.1.7-rc.2`、`0.2.0-rc.1`、`0.2.0-rc.2`。

---

## 📄 License

[MIT](./LICENSE) © hgk
