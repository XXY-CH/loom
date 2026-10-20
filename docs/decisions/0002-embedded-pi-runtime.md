# ADR 0002：内嵌 Pi Runtime 与独立模型连接

日期：2026-10-20。
状态：accepted。内嵌 Runtime 已实现并有本地恢复回归，真实 endpoint 与订阅认证仍未验收；具体边界见 实施记录（本地开发记录，不随公开源码发布）。

## 背景

初版以多种 coding CLI 的执行器适配为入口。用户修正目标：直接内嵌 pi-durable，支持自选 endpoint、内置 endpoint + API key，以及可行的订阅认证；Antigravity 只能作为外部工具。

## 决策

- 用 `@earendil-works/pi-durable` 作为唯一核心 AgentRuntime，通过 `@earendil-works/pi-ai` 访问模型。Hermes、OpenCode、Codex CLI、Claude Code 不作为核心执行后端。
- 后续实现默认持续沿用 Pi，不在每个里程碑重新选择 Runtime；改变这一决策需明确的用户要求或经核实的阻塞证据。
- 保留 ADR 0001 的薄控制层原则，将 Loom workflow 尽可能实现为 Pi durable task/document，不重复实现通用恢复调度器。
- Runtime、模型 provider、认证和外部工具为不同边界。切模型不切开发工作流；子 conversation 根据工具和上下文范围配置，不绑定外部 coding CLI。
- OpenAI 订阅采用官方 Sign in with ChatGPT 本地/开源应用路线。Claude API key 纳入计划，Claude 订阅 OAuth 因当前官方限制保留为受阻需求。
- Antigravity 只能通过可选外部工具接入。pi-antigravity 的直接 OAuth/provider 实现仅作参考，不复制为内嵌 provider。

## 影响与取舍

可以复用模型循环、工具任务、存储和恢复能力，把工程投入放在真实开发闭环。代价是依赖 experimental 上游：固定版本、封装窄接口，并验证升级与恢复。

Pi 的持久化不保证 shell 或外部副作用 exactly-once，也不提供工作区隔离、全树产品预算或 Loom 验收。完成条件仍由 Loom 程序根据证据判断。

## 替代方案

直接调用 coding CLI 会重复适配输入、事件与恢复，偏离内嵌目标；从零构建 durable runtime 会扩大范围。两者均不作为当前主线。

## 来源与后续

见 Pi 与认证调研（本地开发记录，不随公开源码发布）。本 ADR 修订旧文档中的 executor-adapter 方向；内嵌 Pi 的本地运行与恢复证据见实施记录，真实 endpoint 验收仍待完成。官方认证条件变化需单独更新记录。
