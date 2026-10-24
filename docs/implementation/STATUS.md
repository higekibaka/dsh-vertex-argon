# dsh-vertex-argon 发版状态与验证账本 (v1.5.2)

- **当前版本**：`1.5.2`
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

## 4. npm 发布去重规则

- `.github/workflows/publish.yml` 仅由 `v*` 标签推送触发，标签必须与 `package.json` 的版本一致；main 推送、Release 发布及手动 dispatch 不再触发上传。
- 所有版本共用一个 concurrency 锁，`cancel-in-progress: false`；保留 OIDC Trusted Publishing、provenance 和现有最小权限，不新增 token。
- `.github/scripts/publish.mjs` 直接查询官方注册表。只有明确的 HTTP 404 才允许一次上传，网络、权限、服务端错误或异常响应均阻断上传；已公开版本须与当前提交的 `gitHead` 一致才跳过。
- 上传成功后继续持锁查询公开状态，最多 21 次、间隔 15 秒、每次请求超时 10 秒。暂存 E409 只进入同一只读查询流程，不重传，也不直接当作成功。
- 查询超时或来源不一致会明确失败；其他上传错误也不自动重试。先核查注册表、压缩包及来源证明，再决定是否需要人工处理；不要通过重传或删除版本来消除错误。已发布的 1.5.2、1.5.3 保持不变。
- 离线回归：`node --import ./test/offline-guard.mjs --test test/publish-workflow.test.mjs`。测试注入模拟注册表、上传与等待操作，不执行真实 npm 上传，也不访问外网；同时纳入现有 `npm test`。
- 此修复不改写旧标签中的历史工作流；不要重跑旧发布任务。只有包含修复的新提交及其后续版本标签使用新逻辑。
