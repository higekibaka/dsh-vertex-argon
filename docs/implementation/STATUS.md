# dsh-vertex-argon 发版状态与验证账本 (v1.5.1)

- **当前版本**：`1.5.1`
- **宿主兼容版本**：`dsh 0.2.1-rc.2`
- **状态**：代码清理、退订模块移除、文档重生与测试核验已完成，具备正式发版条件。

---

## 1. 生产文件清单（`package.json#files`）

发布包仅包含以下正式生产文件与文档（不含 `dev/`、`test/`、`docs/`、`releases/` 及已退役模块）：

- **入口与配置**：`index.js`, `client.js`, `runtime.js`, `cordis.patch.yml`, `icon.svg`, `locale/`
- **适配器与连接**：`adapter.js`, `google-connection.js`, `service-level.js`, `google-signatures.js`
- **GenerateContent 引擎**：`generate-content.js`
- **Interactions 引擎**：`interactions.js`, `interaction-adapter.js`, `interactions-input.js`, `interaction-image.js`, `interaction-transport.js`, `interaction-state.js`, `interaction-lifecycle.js`, `interaction-query.js`
- **结构化输出底层辅助**：`structured-output.js`, `bounded-json.js`
- **诊断、定价与 Inspector**：`diagnostics.js`, `diagnostic-store.js`, `usage-details.js`, `pricing.js`, `response-store.js`, `request-association.js`, `inspector-service.js`, `inspector-overview.js`, `inspector-tool.js`
- **发行元数据**：`README.md`, `CHANGELOG.md`, `LICENSE`

---

## 2. 自动化离线测试套件（`test/*.test.mjs`，共 37 个测试文件）

所有单元测试均在 `test/offline-guard.mjs` 零外网守卫下运行：

- **适配器、路由与协议策略**：`adapter.test.mjs`, `request-policy.test.mjs`, `service-level.test.mjs`, `plugin-lifecycle.test.mjs`, `offline-guard.test.mjs`
- **GenerateContent 与签名回放**：`generate-content-errors.test.mjs`, `signature-only.test.mjs`
- **Interactions 引擎与恢复**：`interaction-state.test.mjs`, `interaction-query.test.mjs`, `interactions-Request-and-SSE.test.mjs`（含 `interactions-input.test.mjs`, `interaction-image.test.mjs` 等）
- **结构化输出底层校验**：`structured-output.test.mjs`, `structured-output-adapter.test.mjs`
- **诊断、定价、关联与原始响应**：`diagnostics.test.mjs`, `diagnostic-store.test.mjs`, `diagnostic-cost.test.mjs`, `usage-details.test.mjs`, `pricing.test.mjs`, `response-store.test.mjs`, `request-association.test.mjs`
- **Inspector 服务、工具与前端视图**：`inspector-overview.test.mjs`, `inspector-service.test.mjs`, `inspector-tool.test.mjs`, `client-inspector-overview.test.mjs`, `client-inspector-View.test.mjs` 等 8 个前端组件测试（含 `client-json.test.mjs` 回归断言已退役命令不暴露）

---

## 3. 真实长解码实测基准（奥德赛七号全年舰长日志）

- **测试会话**：`session-73653d49-2d3a-4525-9891-32fd3ff62850`（消息 `b3acabdf-77c9-4b01-9883-ede0f11e5ce3`，`settlementSeq: 19`）
- **诊断记录 ID**：`f911d0c5-fe7a-43ca-b205-5d2202105a41`
- **模型与路由**：`google-vertex` / `gemini-4-argon` / `generate-content`（`v1beta1`, `thinkingLevel: "LOW"`, `configuredMaxTokens: 131072`）
- **实测结果**：
  - **Hop 1**：HTTP `200`，耗时 `961,781 ms`，接收 `1,291` 个流式块，输入 `52,737` tokens，输出达单跳满额 **`65,536` tokens**，返回 `finishReason: "CONTINUATION"` 并产出有效 `continuationToken`。
  - **Hop 2**：HTTP `200`，自动携带 `continuationToken` 续写，耗时 `476,132 ms`，输入 `118,274` tokens，输出 **`33,449` tokens**，返回 `finishReason: "STOP"`。
  - **单回合总输出**：**`98,985` tokens**（总耗时 `1,437,917 ms` ≈ 23 分 58 秒，`reconnectCount: 0`），完整输出 `[DAY 001 | 2186-01-01]` 至 `[DAY 365 | 2186-12-31]` 全年 365 天舰长日志及状态台账。
