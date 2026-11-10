# Gemini 4 Adapter（dsh-vertex-argon）发版状态与验证账本（v2.0.0）

- **用户工程版本**：`2.0.0`（展示品牌名 **Gemini 4 Adapter**，底层包名保持 `dsh-vertex-argon`），以 [package.json](<../../package.json>) 为准。
- **声明兼容**：DSH `>=0.2.0-rc.2`；Node.js `^22.19.0 || >=24.0.0`。以 [package.json](<../../package.json>) 为准。
- **本轮范围**：移除非官方反代分支并聚焦双官方通道四模型（Argon + Carbon）、适配器边界 `max` → `high` 收敛、展示层品牌升级为 **Gemini 4 Adapter**（保持底层包名 `dsh-vertex-argon`、Provider ID `google-vertex-argon`、配置 ID `local-vertex-argon`、工具名 `argon_inspect` 及存储域不变）、版本号升级为 `2.0.0`，以及全面重写 [主文档](<../../README.md>) 与补齐 [CHANGELOG.md](<../../CHANGELOG.md>)。
- **验证状态**：2026-11-11 完成 `v2.0.0` 品牌重命名与文档重写后，重跑 36 个测试文件、642 项离线测试（641 通过、0 失败、1 跳过），`git diff --check` 退出码 0，`pnpm pack` 生成的 `dsh-vertex-argon-2.0.0.tgz` 预检白名单共 32 个文件严丝合缝。待用户最终确认后再推送 GitHub 标签触发发布或更新桌面安装。

## 1. 生产文件边界

发布白名单以 [package.json](<../../package.json>) 的 `files` 为唯一来源，不用静态模块总数替代实际清单。现行职责如下：

| 分类 | 生产文件 |
|---|---|
| 入口与运行时 | [index.js](<../../index.js>)、[client.js](<../../client.js>)、[runtime.js](<../../runtime.js>) |
| 注册与资源 | [cordis.patch.yml](<../../cordis.patch.yml>)、[icon.svg](<../../icon.svg>)、[zh.json](<../../locale/zh.json>)、[en.json](<../../locale/en.json>) |
| 模型注册与连接 | [adapter.js](<../../adapter.js>)、[google-connection.js](<../../google-connection.js>)、[service-level.js](<../../service-level.js>) |
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

- **双官方通道与密钥隔离**：四模型 ID（Argon / Carbon × Vertex / Gemini API）注册、配置热更新、密钥轮换、两协议请求实际地址与鉴权；Gemini API 与 Vertex 之间不泄漏凭据。
- **流内错误与退避**：HTTP 200 错误帧、响应头/Google details/消息延时解析、`200ms` 余量、超过 `60s` 立即失败。
- **阶段超时**：首包/思考/转换 `180s`、可见流 `120s`；测试用毫秒覆盖验证阻塞连接、迭代、JSON 解析、逐跳清理、用户取消及消费方暂停。
- **安全重试与恢复**：零已交付无 token 的 `retry-initial` 至多 3 次重试，关闭 `longDecode` 仍有效；已交付无 token 不重试；已有检查点尾段回滚；首检查点前实时交付。
- **仅思考 STOP**：最多一次 `thinking-dropout-heal`；有 token 续写、无 token 回放思考及签名后追加指定续答请求；安全拦截不自愈。
- **诊断与存储**：请求级 11 Token 字段、每 hop 五 Token 字段；旧记录读兼容、新记录写严格，不重写旧磁盘；输入水位与累计用量分开。
- **Inspector**：Debug 请求列表/摘要/11 列轨迹/响应分页/完整 JSON；删除范围概览调用和权限依赖；Operations 权限、范围切换与异步竞态、全局锁释放确认；按 `route` 显示官方通道名。
- **工具与云端查询**：只保留 `list`、`detail`、`response`、`query`、`query-response`；本地会话隔离；已知云端 ID 查询不生成、不取消、不执行工具，仍仅 Google/Vertex。
- **既有回归**：Interactions 后台状态与恢复、签名回放、结构化输出、真实宿主控制器与组件生命周期、发布白名单。

### 最终实测结果（2026-10-25，Asia/Shanghai）

- **环境**：Windows，Node.js `v24.12.0`；复用本机已安装依赖，未下载依赖。
- **完整测试**：`npm test` 退出码 `0`。37 个测试文件全部通过；失败、取消、跳过、待办均为 0。
- **离线边界**：测试脚本先加载 [offline-guard.mjs](<../../test/offline-guard.mjs>)，再加载 [host-loader.mjs](<../../test/host-loader.mjs>)；外网禁止，只允许测试自身创建的临时回环服务。Windows 受限子进程曾返回 `EPERM`，最终命令按用户确认获单次放行，守卫未变更。
- **重点覆盖**：流式恢复 113 项；反代路由 33 项（该通道已在 1.6.4 本轮删除）、协议适配 20 项；客户端 110 项；发布去重 8 项。其余覆盖诊断存储兼容、只读工具、后台恢复、签名与结构化输出等既有功能。
- **2026-10-26 协议与死锁修复补记**：新增并验证 2026-05-20 独立生命周期事件与终态守卫、同会话僵尸锁有界非流式对账（`failed`/`cancelled`/`404` 清理、未回放终态保留句柄并放行新提示词）、流内错误保守探针、Interactions `Retry-After` 退避与诊断记录、首跳输入水位采集窗口、GenerateContent 看门狗伪进展防护（有界签名集合去重、空思考/空工具帧拦截）、蛇形 `thought_signature` 兼容及 `0.2.1-rc.3` 宿主前端静态模块表引导边界兼容。逐文件离线回归共 37 个测试文件、667 项断言：36 个文件（666 项）全部通过；唯一失败项为 [publish-workflow.test.mjs:144](<../../test/publish-workflow.test.mjs#L144>) 的 CLI 子进程 `spawnSync` 在当前 `workspace-write` 沙盒下因管道限制返回 `EPERM`（与既有第 45 行说明一致）。
- **2026-10-28 / 2026-11-09 历史补记（反代通道，已在 1.6.4 本轮整体删除）**：当时新增过反代专用的 Flash 模型与推理档位 1:1 上游映射，并把 `generateContentHistory(options, model)` 的跨模型降级从「同通道」扩展到「跨模型」；随后又把反代与 `googleProtocol`、`vertexProtocol`、`googleServiceTier`、`vertexServiceTier` 解耦，固定走 `generate-content` 与 `standard`。同时把非长解码模式下的 `streamIdleTimeoutMs` 由 `300000ms` 调大至 `1200000ms`（`STREAM_READ_TIMEOUT_MS`，本轮保留）。当时还确认 `--test-isolation=none` 会把全部测试文件放进同一进程、共享 `globalThis.fetch` 替身而互相污染，因此历史回归按「每个测试文件单独一个 node 进程」执行。上述反代模型 ID、常量、函数、三项配置与设置卡片本轮全部删除；跨模型历史降级逻辑保留，改由 Argon ↔ Carbon、Vertex ↔ Gemini API 使用。
- **2026-11-11 反代分支删除（Gemini API + Vertex AI 双官方通道）**：删除整条 Antigravity 反代分支——`PROXY_MODEL` / `PROXY_FLASH_MODEL` / `PROXY_MODELS` / `PROXY_MODEL_NAMES` / `FLASH_UPSTREAM_MODEL` / `PROXY_API_KEY_ENV` / `DEFAULT_PROXY_BASE_URL`、`isProxyModel` / `proxyUpstreamBaseModel` / `resolveProxyUpstreamModel` / `normalizeProxyBaseUrl`、三项 `proxy*` 配置（配置由 16 项降为 **13 项**）、设置页反代卡片与中英文案、`__ANTIGRAVITY_API_KEY__` 传递标记，以及 `ArgonAdapter` / `interaction-adapter` 中的全部反代特判。保留：Argon/Carbon 四模型 ID、`officialUpstreamModel` 上游映射、`generateContentHistory` 的跨模型历史降级（改由 Argon ↔ Carbon、Vertex ↔ Gemini API 使用）、`google-connection` 的通用 `baseURL` 与官方 `apiKeyEnv` 支持。测试迁移：删除 `test/proxy-route.test.mjs`，把「官方通道凭据隔离」「显式 Key / 官方 `apiKeyEnv` 顺序 / 自定义网关 URL」「跨模型签名工具历史降级（Carbon ↔ Carbon、Argon → Carbon、Gemini Argon → Gemini Carbon）」以及「过期签名 codec 整轮文本降级、`[:thinking:]`/伪工具尾清洗、`MALFORMED_FUNCTION_CALL` 后 `VALIDATED` → `AUTO` 退避」共 8 项通用回归完整迁入 [adapter.test.mjs](<../../test/adapter.test.mjs>)；[client.test.mjs](<../../test/client.test.mjs>) 重置断言改为 13 次写并新增「设置页无 proxy* 残留」用例；[client-debug.test.mjs](<../../test/client-debug.test.mjs>) 改为按官方 `route` 断言通道名；[diagnostics.test.mjs](<../../test/diagnostics.test.mjs>) fixture 模型改为 `gemini-4-argon-google`。
- **本轮离线实测（2026-11-11，Asia/Shanghai）**：环境 Windows + Node.js `v24.12.0`，复用已有依赖，未联网、未安装。命令：`node --experimental-transform-types --import ./test/offline-guard.mjs --import ./test/host-loader.mjs --test --test-isolation=none test/*.test.mjs`。结果：**36 个测试文件，636 项测试，635 通过，0 失败，1 跳过**；跳过项为 [publish-workflow.test.mjs:144](<../../test/publish-workflow.test.mjs#L144>)（`workspace-write` 沙盒拒绝子进程 `EPERM`，测试显式 `skip` 并写明原因，不伪装通过）。为让该聚合命令真正可用，同期修正了测试间的全局状态污染：`adapter` / `generate-content-errors` / `protocol-adapter` 三个文件的模块级 `globalThis.fetch` 替身改为每个测试内安装与恢复，`gemini-gc-tier` 摘除自己安装的 SDK 原型补丁，`adapter` / `generate-content-errors` 在测试结束摘掉生产代码常驻的 ApiClient 补丁；修正前同一命令为 683 项、54 项失败。
- **2026-11-11 增补：适配器边界 `max` → `high` 收敛与 Gemini 4 Carbon 文案**：
  - **改动清单**：[adapter.js](<../../adapter.js>) 新增并导出 `narrowMaxReasoning(options)`（`reasoning` / `reasoningEffort` 大小写不敏感命中 `max` 时改写为 `high`），`gemini4StreamSimple` 先把 `max` 归一为 `high` 再查 `thinkingLevelMap`（`DEFAULT_THINKING_MAP.max` 仍为 `null`），`ArgonAdapter.prepareCall` 的 Interactions 与 GenerateContent 两个分支都套上收敛，使绕过 `agent/request` 直接调用 `adapter.stream` / `prepareCall().stream` 的路径（如顾问插件）同样收敛；[interaction-adapter.js](<../../interaction-adapter.js>) 与 [interactions-input.js](<../../interactions-input.js>) 同步归一 `options.reasoningEffort`。[package.json](<../../package.json>) `keywords` 在 `gemini-4-argon` 后增补 `gemini-4-carbon`，版本保持 `1.6.4`；[adapter.js](<../../adapter.js>) 四条写死 Argon 的错误消息改为涵盖 Gemini 4（含 Carbon）字样；[client.js](<../../client.js>) 中英 `subtitle` 点出 Argon / Carbon 双通道。[locale/zh.json](<../../locale/zh.json>) 与 [locale/en.json](<../../locale/en.json>) 的 `meta.description` 经核对已同时提及 Argon 与 Carbon，未改动。[DECISIONS.md](<DECISIONS.md>) 补述收敛生效的两处边界。
  - **新增用例**：[adapter.test.mjs](<../../test/adapter.test.mjs>) 新增 2 项（`narrowMaxReasoning` 单测；`gemini-4-carbon` / `gemini-4-carbon-google` 在默认档位 `low` 下经 `adapter.stream` 与 `prepareCall().stream` 传 `max` 均落 `HIGH`，`minimal` / `off` / `xhigh` 仍在发包前拒绝），并把原「`max` / `off` / `xhigh` 前置拒绝」用例修正为「`off` / `minimal` / `xhigh` 前置拒绝」；[protocol-adapter.test.mjs](<../../test/protocol-adapter.test.mjs>) 新增 1 项 Interactions 同路径断言（`generation_config.thinking_level` 为 `high`，路由 Vertex / Gemini API 均验证）。
  - **离线回归（逐文件单进程，权威口径）**：为避免 `--test-isolation=none` 单进程聚合时各文件的 `globalThis.fetch` 替身互相污染，本轮以 `Get-ChildItem test/*.test.mjs` 循环，每个文件单独执行 `node --experimental-transform-types --import ./test/offline-guard.mjs --import ./test/host-loader.mjs --test --test-isolation=none <file>`。结果：**36 个测试文件全部退出码 0**；补齐 3 项通用回归后合计 **642 项测试，641 通过，0 失败，1 跳过**。跳过项仍为 [publish-workflow.test.mjs:144](<../../test/publish-workflow.test.mjs#L144>) 的 CLI 子进程 `spawnSync` 在 `workspace-write` 沙盒下返回 `EPERM`（第 150 行显式 `skip` 并写明原因，不伪装通过）。
  - **聚合复核（补充口径）**：同轮单进程聚合命令 `node --experimental-transform-types --import ./test/offline-guard.mjs --import ./test/host-loader.mjs --test --test-isolation=none test/*.test.mjs` 同样退出码 0（**642 项、641 通过、0 失败、1 跳过**），未观察到跨文件替身污染。
  - **重新打包**：旧包先备份为 `O:\AI\dsh\.tmp\dsh-vertex-argon-1.6.4.backup.tgz`；用捆绑 pnpm 入口 `pnpm/bin/pnpm.cjs pack`（本工程无 lifecycle 脚本，未联网、未安装依赖）重新生成 [dsh-vertex-argon-1.6.4.tgz](<../../dsh-vertex-argon-1.6.4.tgz>)。`tar -tf` 核验清单 32 个文件，与 [package.json](<../../package.json>) 的 `files` 白名单完全一致，不含 `test/`、`docs/`、`promo-video/`、`.tmp/`；包内 `package.json` 版本仍为 `1.6.4`。
  - **桌面安装与哈希复核（1.6.4 阶段）**：按用户授权经 `plugin_manager`（`remove_bundle` → `install_bundle`）将新版 `dsh-vertex-argon-1.6.4.tgz` 热应用至桌面 profile（`applied`，零告警）；独立审查核验 `package.json#files` 展开的 31 个生产文件与 `C:\Users\38987\.dsh\profiles\desktop\node_modules\dsh-vertex-argon` 对应文件 SHA256 100% 一致，`package.json` JSON 语义完全一致。
- **2026-11-11 v2.0.0 品牌升级与文档重写补记（路线 A · Gemini 4 Adapter）**：
  - **改动范围**：将 [package.json](<../../package.json>) 版本由 `1.6.4` 升至 `2.0.0`（避免与 npm 已公开的旧 `1.6.4` 冲突，并体现移除反代通道的破坏性精简）；将 [zh.json](<../../locale/zh.json>)、[en.json](<../../locale/en.json>)、[adapter.js](<../../adapter.js>)、[client.js](<../../client.js>)、[interaction-adapter.js](<../../interaction-adapter.js>)、[interaction-state.js](<../../interaction-state.js>)、[inspector-tool.js](<../../inspector-tool.js>)、[index.js](<../../index.js>)、[diagnostic-store.js](<../../diagnostic-store.js>) 的展示标题与用户可见文案统一升级为 **Gemini 4 Adapter** / **Gemini 4 诊断**（底层 `dsh-vertex-argon`、`google-vertex-argon`、`local-vertex-argon`、`argon_inspect` 与 `vertex_argon_*` 存储域 100% 保持不变）；面向开源读者重写 [README.md](<../../README.md>)，并在 [CHANGELOG.md](<../../CHANGELOG.md>) 增补 `[2.0.0] - 2026-11-11` 章节。
  - **离线实测与预检**：Node.js `v24.21.0` 单进程聚合测试运行 36 个测试文件：**642 项测试，641 通过，0 失败，1 跳过**（跳过项仍为沙盒内 `publish-workflow.test.mjs:144` 子进程 `EPERM`）；`git diff --check` 退出码 0；捆绑 pnpm 预检打包 `O:\AI\dsh\.tmp\dsh-vertex-argon-2.0.0.tgz` 共 32 个归档条目，与 `package.json#files` 完全一致。
- **发布清单预检（上一轮，当时未生成发布包）**：`npm pack --dry-run --json --ignore-scripts --cache .tmp/npm-cache` 退出码 0，清单 32 个文件；不包含退休模块、测试、工程缓存或宣传视频。仅预检，未生成发布包、安装或发布。
- **差异检查**：`git diff --check` 退出码 0；保留用户原有版本/兼容范围改动及未跟踪的宣传视频内容。
- **工具定义开销**：同一真实宿主首轮组装测试的固定估算由 542 降至 503 tokens（减少 39）；这不是 Google CountTokens 测量。
- **验证限度**：本轮没有新增 live 上游请求，也未将本地改动安装进运行中的 Web GUI。SDK、组件和真实宿主控制器的离线回归不冒充云端或已安装页面验收。

## 3. 历史云端实测：奥德赛七号全年舰长日志

> 本节继承 v1.5.0 的历史记录，仅用于保留已知长解码证据。文档同步没有重新发起请求、没有逐篇重审输出，不作为 v1.6.0、Carbon 模型或本轮恢复机制的新增 live 验证。

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
