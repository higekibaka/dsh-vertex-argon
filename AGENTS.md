# dsh-vertex-argon 维护与发版说明

维护或扩展 `dsh-vertex-argon` 时，请依次查阅以下与现行代码（v1.5.0）同步的工程文档：

1. [实现架构与模块边界](<docs/implementation/README.md>)：27 个生产模块的职责划分与插件边界。
2. [核心技术决定与协议合同](<docs/implementation/DECISIONS.md>)：双路由/双协议、Long Decode、服务层级、诊断关联、Inspector 与已淘汰方案边界。
3. [发版状态、测试清单与实测基准](<docs/implementation/STATUS.md>)：v1.5.0 模块清单、37 个离线测试文件与奥德赛七号长解码实测账本。

工程约束：
- **纯插件边界**：仅通过 DSH 公开的插件接口（`llm`、`storageDomain`、`typert`、`settings`、`tools` 及 Web Client Slots）实现功能，不修改 DSH 宿主源码或已安装 `app.asar`。
- **离线测试零网络**：所有 `test/*.test.mjs` 必须在 `test/offline-guard.mjs` 下通过，不得在单元测试中发起真实外网请求。
