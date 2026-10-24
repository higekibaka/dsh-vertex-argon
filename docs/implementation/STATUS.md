# dsh-vertex-argon 发版状态与验证账本（v1.6.0）

- **用户工程版本**：`1.6.0`，不因文档同步另行变更版本。
- **声明兼容**：DSH `0.2.1-rc.2 || 0.2.1-rc.3`；Node.js `^22.19.0 || >=24.0.0`。以 [package.json](<../../package.json>) 为准。
- **本轮范围**：诊断减法、Antigravity 独立第三模型、GenerateContent 四项韧性机制；不自动安装插件或修改宿主/profile。
- **验证状态**：2026-10-25 最终合并后的离线测试与发布清单预检通过，详见下方实测记录。本轮未安装、未发布，未新增真实上游验证。

## 1. 生产文件边界

发布白名单以 [package.json](<../../package.json>) 的 `files` 为唯一来源，不用静态模块总数替代实际清单。现行职责如下：

| 分类 | 生产文件 |
|---|---|
| 入口与运行时 | [index.js](<../../index.js>)、[client.js](<../../client.js>)、[runtime.js](<../../runtime.js>) |
| 注册与资源 | [cordis.patch.yml](<../../cordis.patch.yml>)、[icon.svg](<../../icon.svg>)、[zh.json](<../../locale/zh.json>)、[en.json](<../../locale/en.json>) |
| 三模型与连接 | [adapter.js](<../../adapter.js>)、[google-connection.js](<../../google-connection.js>)、[service-level.js](<../../service-level.js>) |
| GenerateContent 与签名 | [generate-content.js](<../../generate-content.js>)、[google-signatures.js](<../../google-signatures.js>) |
| Interactions 引擎 | [interactions.js](<../../interactions.js>)、[interaction-adapter.js](<../../interaction-adapter.js>)、[interactions-input.js](<../../interactions-input.js>)、[interaction-image.js](<../../interaction-image.js>)、[interaction-transport.js](<../../interaction-transport.js>) |
| Interactions 状态与查询 | [interaction-state.js](<../../interaction-state.js>)、[interaction-lifecycle.js](<../../interaction-lifecycle.js>)、[interaction-query.js](<../../interaction-query.js>) |
| 结构化输出辅助 | [structured-output.js](<../../structured-output.js>)、[bounded-json.js](<../../bounded-json.js>) |
| 基本诊断与响应证据 | [diagnostics.js](<../../diagnostics.js>)、[diagnostic-store.js](<../../diagnostic-store.js>)、[response-store.js](<../../response-store.js>)、[request-association.js](<../../request-association.js>) |
| Inspector 服务与工具 | [inspector-service.js](<../../inspector-service.js>)、[inspector-tool.js](<../../inspector-tool.js>) |
| 发行文档 | [主文档](<../../README.md>)、[CHANGELOG.md](<../../CHANGELOG.md>)、[LICENSE](<../../LICENSE>) |

开发测试、工程文档与临时测试缓存不属于生产运行模块。已退役的定价、模态用量及范围概览模块不再发布。

## 2. 本轮离线验证清单

执行入口：`npm test`；必须在 [offline-guard.mjs](<../../test/offline-guard.mjs>) 下运行，并由 [host-loader.mjs](<../../test/host-loader.mjs>) 复用已有依赖。禁止真实外网，不安装依赖。以下为覆盖范围，实际执行结果见下方：

- **三路由与密钥隔离**：默认禁用代理、显式开启、第三模型 ID、根路径补版本、末斜杠、HTTP(S) 校验、配置热更新、密钥轮换、两协议请求实际地址与鉴权；代理与 Google/Vertex 之间不泄漏凭据。
- **流内错误与退避**：HTTP 200 错误帧、响应头/Google details/消息延时解析、`200ms` 余量、超过 `60s` 立即失败。
- **阶段超时**：首包/思考/转换 `180s`、可见流 `120s`；测试用毫秒覆盖验证阻塞连接、迭代、JSON 解析、逐跳清理、用户取消及消费方暂停。
- **安全重试与恢复**：零已交付无 token 的 `retry-initial` 至多 3 次重试，关闭 `longDecode` 仍有效；已交付无 token 不重试；已有检查点尾段回滚；首检查点前实时交付。
- **仅思考 STOP**：最多一次 `thinking-dropout-heal`；有 token 续写、无 token 回放思考及签名后追加指定续答请求；安全拦截不自愈。
- **诊断与存储**：请求级 11 Token 字段、每 hop 五 Token 字段；旧记录读兼容、新记录写严格，不重写旧磁盘；输入水位与累计用量分开。
- **Inspector**：Debug 请求列表/摘要/11 列轨迹/响应分页/完整 JSON；删除范围概览调用和权限依赖；Operations 权限、范围切换与异步竞态、全局锁释放确认；代理显示独立名称。
- **工具与云端查询**：只保留 `list`、`detail`、`response`、`query`、`query-response`；本地会话隔离；已知云端 ID 查询不生成、不取消、不执行工具，仍仅 Google/Vertex。
- **既有回归**：Interactions 后台状态与恢复、签名回放、结构化输出、真实宿主控制器与组件生命周期、发布白名单。

### 最终实测结果（2026-10-25，Asia/Shanghai）

- **环境**：Windows，Node.js `v24.12.0`；复用本机已安装依赖，未下载依赖。
- **完整测试**：`npm test` 退出码 `0`。37 个测试文件全部通过；失败、取消、跳过、待办均为 0。
- **离线边界**：测试脚本先加载 [offline-guard.mjs](<../../test/offline-guard.mjs>)，再加载 [host-loader.mjs](<../../test/host-loader.mjs>)；外网禁止，只允许测试自身创建的临时回环服务。Windows 受限子进程曾返回 `EPERM`，最终命令按用户确认获单次放行，守卫未变更。
- **重点覆盖**：流式恢复 113 项；代理路由 33 项、协议适配 20 项；客户端 110 项；发布去重 8 项。其余覆盖诊断存储兼容、只读工具、后台恢复、签名与结构化输出等既有功能。
- **发布清单预检**：`npm pack --dry-run --json --ignore-scripts --cache .tmp/npm-cache` 退出码 0，清单 32 个文件；不包含退休模块、测试、工程缓存或宣传视频。仅预检，未生成发布包、安装或发布。
- **差异检查**：`git diff --check` 退出码 0；保留用户原有版本/兼容范围改动及未跟踪的宣传视频内容。
- **工具定义开销**：同一真实宿主首轮组装测试的固定估算由 542 降至 503 tokens（减少 39）；这不是 Google CountTokens 测量。
- **验证限度**：本轮没有新增 live 上游请求，也未将本地改动安装进运行中的 Web GUI。SDK、组件和真实宿主控制器的离线回归不冒充云端或已安装页面验收。

## 3. 历史云端实测：奥德赛七号全年舰长日志

> 本节继承 v1.5.0 的历史记录，仅用于保留已知长解码证据。文档同步没有重新发起请求、没有逐篇重审输出，不作为 v1.6.0、Antigravity 或本轮恢复机制的新增 live 验证。

- **历史测试会话**：`session-73653d49-2d3a-4525-9891-32fd3ff62850`。
- **消息**：`b3acabdf-77c9-4b01-9883-ede0f11e5ce3`，`settlementSeq: 19`。
- **诊断记录 ID**：`f911d0c5-fe7a-43ca-b205-5d2202105a41`。
- **模型与路由**：`google-vertex` / `gemini-4-argon` / `generate-content`；`v1beta1`，`thinkingLevel: LOW`，`configuredMaxTokens: 131072`。
- **历史服务层级**：请求 `priority`，观测 `standard`，来源 `traffic-type`。

| 历史阶段 | HTTP / 耗时 | 输入 Token | 输出 Token | 结束原因 |
|---|---|---|---|---|
| Hop 1 | `200` / `961,781ms`，`1,291` 流式块 | `52,737` | `65,536` | `CONTINUATION`，有效 token |
| Hop 2 | `200` / `476,132ms` | `118,274` | `33,449` | `STOP` |

单回合输出 **98,985 tokens**，总耗时 **1,437,917ms**（约 23 分 58 秒），`hopCount: 2`、`continuationCount: 1`、`reconnectCount: 0`、`outcome: done`。输入水位 `52,737`，累计输入 `171,011`，累计总量 `269,996`。

历史记录描述完整输出 `DAY 001` 至 `DAY 365` 的全年日志与状态台账，并覆盖每周维护、月末报告和长期锚定事件。该内容结论来自原有账本，而非本轮独立复验。

## 4. npm 发布去重规则

- `.github/workflows/publish.yml` 仅由 `v*` 标签推送触发，标签必须与 `package.json` 的版本一致；main 推送、Release 发布及手动 dispatch 不再触发上传。
- 所有版本共用一个 concurrency 锁，`cancel-in-progress: false`；保留 OIDC Trusted Publishing、provenance 和现有最小权限，不新增 token。
- `.github/scripts/publish.mjs` 直接查询官方注册表。只有明确的 HTTP 404 才允许一次上传，网络、权限、服务端错误或异常响应均阻断上传；已公开版本须与当前提交的 `gitHead` 一致才跳过。
- 上传成功后继续持锁查询公开状态，最多 21 次、间隔 15 秒、每次请求超时 10 秒。暂存 E409 只进入同一只读查询流程，不重传，也不直接当作成功。
- 查询超时或来源不一致会明确失败；其他上传错误也不自动重试。先核查注册表、压缩包及来源证明，再决定是否需要人工处理；不要通过重传或删除版本来消除错误。已发布的 1.5.2、1.5.3 保持不变。
- 离线回归：`node --import ./test/offline-guard.mjs --test test/publish-workflow.test.mjs`。测试注入模拟注册表、上传与等待操作，不执行真实 npm 上传，也不访问外网；同时纳入现有 `npm test`。
- 此修复不改写旧标签中的历史工作流；不要重跑旧发布任务。只有包含修复的新提交及其后续版本标签使用新逻辑。
