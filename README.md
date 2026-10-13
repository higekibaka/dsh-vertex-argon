<div align="center">
  <img src="./icon.svg" width="76" height="76" alt="Vertex Argon Icon" />
  <h1>dsh-vertex-argon</h1>
  <p><strong>Google Vertex AI &amp; Gemini API Dual-Route Gemini 4 Argon Plugin for <a href="https://github.com/deepseek-ai/deepseek-harness">DeepSeek Harness</a> (DSH)</strong></p>
  <p>
    <a href="https://www.npmjs.com/package/dsh-vertex-argon"><img src="https://img.shields.io/npm/v/dsh-vertex-argon?style=flat-square&color=2563eb" alt="npm version" /></a>
    <a href="https://github.com/deepseek-ai/deepseek-harness"><img src="https://img.shields.io/badge/DSH-0.1.7--rc.2%20%7C%200.2.0--rc.2-4f46e5?style=flat-square" alt="DSH compatibility" /></a>
    <a href="https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/gemini/4-argon"><img src="https://img.shields.io/badge/Thinking%20Levels-LOW%20%7C%20MEDIUM%20%7C%20HIGH-0ea5e9?style=flat-square" alt="Thinking Levels" /></a>
    <a href="./LICENSE"><img src="https://img.shields.io/badge/License-MIT-10b981?style=flat-square" alt="License" /></a>
  </p>
</div>

---

`dsh-vertex-argon` 为 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (DSH) 提供完整的 **Gemini 4 Argon** 接入支持，自动聚合 **Google Vertex AI**（服务账号 / ADC）与 **Google Gemini Developer API**（AI Studio API Key）双通道，修复内置 `pi-ai` 适配器误传 `thinkingBudget` 导致的 `HTTP 400` 报错，完整打通原生三档思考、思维链（Thought Summaries）与带签名的多轮工具调用。

Current release: **[1.1.3](https://github.com/higekibaka/dsh-vertex-argon)** · [npm](https://www.npmjs.com/package/dsh-vertex-argon)

---

## ✨ 为什么需要这个插件？

| 能力维度 | DSH 内置 `google` / `google-vertex` 旧适配器 | `dsh-vertex-argon` 插件通道 |
|---|---|---|
| **思考控制参数** | 误判为旧模型并发送 `thinkingBudget: -1`，触发云端 `HTTP 400` | 原生发送 `thinkingLevel: "LOW" \| "MEDIUM" \| "HIGH"`，绝不传 `thinkingBudget` |
| **思维链（思考摘要）** | 手动新增模型默认无 `reasoning` 标记，不请求摘要 | 固定开启 `includeThoughts: true`，流式解析 `thought: true` 实时展示思维链 |
| **多轮工具调用回传** | 路由切换或签名不对齐时易丢失上下文 | 保持 `provider` / `model` 与 `thoughtSignature` 签名全链路一致 |
| **采样参数净化** | 可能携带被 Argon 拒绝或忽略的采样字段 | 自动剥离 `temperature`、`topP`、`topK` 等无效采样参数 |
| **通道管理与设置** | 需手改 `cordis.patch.yml` 并反复排查校验报错 | 自动检测双通道 + 内置 **设置 → Vertex Argon** 图形化实时调节页面 |

---

## 🔄 工作原理与架构流向

```mermaid
flowchart TD
    U["DSH 模型配置扫描"] --> D{"自动检测 gemini-4-argon"}
    D -->|"检测到 google-vertex 或默认"| V["Vertex Argon → Gemini 4 Argon (Vertex AI)<br/>复用 GOOGLE_APPLICATION_CREDENTIALS"]
    D -->|"检测到 google (Gemini API)"| G["Vertex Argon → Gemini 4 Argon (Gemini API)<br/>复用 GOOGLE_API_KEY"]
    V --> P["onPayload 请求级净化与注入"]
    G --> P
    P --> T["注入 thinkingLevel: LOW / MEDIUM / HIGH 与 includeThoughts: true<br/>剔除 thinkingBudget 与 temperature / topP / topK"]
    T --> S["Google GenAI Stream 响应"]
    S --> R1["thought: true → DSH 思维链面板"]
    S --> R2["functionCall + thoughtSignature → 原生工具卡片与多轮签名回放"]
```

除提供独立的 **Vertex Argon** 分组外，插件在启动时还会为内置 `PiAiAdapter` 注入 `installGemini4PiAiPatch` 运行时兜底——即便用户在模型选择器中误点了原 `Google` 或 `Google Vertex AI` 分组下的 `gemini-4-argon`，也会被自动改写为合法的 `thinkingLevel` 请求。

---

## 🚀 安装方法

### 方式 1：在 DSH 对话框中一键安装（推荐）

直接向当前 DSH 会话发送：

```text
请用 plugin_manager 的 install_bundle 安装 dsh-vertex-argon
```

> 若本机默认配置了尚未同步新包的镜像源，可发送：
> `请用 plugin_manager 的 install_bundle 从 https://registry.npmjs.org/ 安装 dsh-vertex-argon`

### 方式 2：使用 DSH CLI 安装

```sh
dsh plugin --profile web add dsh-vertex-argon
```

---

## 🔑 双通道凭据配置（二选一或同时配置）

### 通道 A：Google Vertex AI（服务账号 JSON / ADC）

1. 在 [Google Cloud 控制台](https://console.cloud.google.com/) 确认项目已绑定结算账户、已启用 **Vertex AI API**（`aiplatform.googleapis.com`），并为服务账号授予 **Vertex AI User**（`roles/aiplatform.user`）角色，下载 JSON 密钥文件。
2. 在系统用户环境变量中设置以下 3 项（Windows 打开「编辑账户的环境变量 → 用户变量」新建，**变量值不要加引号**）：

| 环境变量名 | 填写示例 | 说明 |
|---|---|---|
| `GOOGLE_APPLICATION_CREDENTIALS` | `C:\Keys\vertex-sa.json` | 服务账号 JSON 密钥文件的完整本地路径 |
| `GOOGLE_CLOUD_PROJECT` | `my-gcp-project-id` | Google Cloud **项目 ID**（注意不是项目名称） |
| `GOOGLE_CLOUD_LOCATION` | `global` | 调用区域，推荐 `global`（或 `us` / `eu`） |

3. **完全退出 DSH（含右下角系统托盘图标）并重新启动**，使进程继承新的环境变量。
4. 在会话模型选择器中选择 **`Vertex Argon → Gemini 4 Argon (Vertex AI)`**。

### 通道 B：Google Gemini API（AI Studio API Key）

1. 打开 DSH **设置 → 模型 → Google**，配置你的 `GOOGLE_API_KEY`。
2. 在 `Google` 提供商下添加模型 ID：`gemini-4-argon`。
3. 插件会自动检测到该配置，并在模型选择器的 **`Vertex Argon`** 分组下多显示一项 **`Gemini 4 Argon (Gemini API)`**，点击即可直接调用。

---

## ⚙️ 设置页面与配置项（Configuration）

打开左下角 **设置 → Vertex Argon**，无需修改 YAML 或重启应用，即可实时调整以下配置（对应 `local-vertex-argon` Profile 条目）：

| 配置字段 | 默认值 | 可选范围 / 预设 | 说明 |
|---|---|---|---|
| `showInModelPicker` | `true` | `true` / `false` | 是否在会话模型选择器中显示 `Vertex Argon` 分组（隐藏不影响已打开会话） |
| `reasoning` | `medium` | `low` / `medium` / `high` | 默认思考档位，分别映射为原生 `LOW` / `MEDIUM` / `HIGH` |
| `maxTokens` | `65536` | `1` – `65536` | 单次流式请求最大输出上限（含思考与正文 token，官方单次流式上限为 `65,536`） |
| `contextWindow` | `1048576` | `1` – `1048576` | 输入、思考与输出共享的总上下文窗口（官方上限为 `1,048,576`） |

---

## ❓ 常见问题

- **为什么极简问题有时候不显示思维链文本？**
  插件已固定发送 `includeThoughts: true`，但 Google 云端会根据问题复杂度动态决定是否吐出可读摘要：遇到推理或工具调用任务时会返回思考摘要文本，极简问答可能仅返回 `thoughtSignature` 签名而不产出摘要文本，属官方正常机制。
- **Gemini 网页版订阅（Gemini Advanced）包含这里的费用吗？**
  不包含。无论是 Vertex AI 还是 Gemini Developer API，均按对应平台的 API 用量计费。

---

## 📄 License

[MIT](./LICENSE) © [hgk](https://github.com/higekibaka)
