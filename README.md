# Loom · 织机

把架构、实现、Debug 与验证织成一条可持续的开发流程。

## 项目目标

建立一个本地优先的 Agent 开发工作台：用户选择仓库、描述目标，Loom 在同一个入口完成规划、代码修改、验证、审查和交付准备，持续保存任务状态和证据。

**AgentRuntime 直接内嵌 `@earendil-works/pi-durable`，模型访问使用 `@earendil-works/pi-ai`。** Hermes、OpenCode、Codex CLI、Claude Code 不作为核心执行器。Antigravity 仅保留为可选外部工具，不能成为内嵌模型 provider；`pi-antigravity` 只作实现参考。

## 当前状态

2026-10-20：已建立 Node/TypeScript 项目和 M1 CLI Spike，直接内嵌 Pi Harness、SQLite、CodingTools，支持 API-key / 自定义 endpoint、提交幂等、重开恢复、取消和数据库独占。新增实时 TUI、Git/worktree 观察，以及 Workflow、worktree 生命周期和实验 OAuth 模块。TUI 已接入 Runtime 事件、运行中后续输入和控制命令（`/help`、`/status`、`/workflow`）。显式 `feature --spec` 已接线最小自动闭环：隔离角色、worktree writer、真实命令、独立 review 和交付，已通过本地 Pi fixture 验证，支持最多两次审查返工和两次已知验证失败修复；尚无 TUI 流程派发。真实模型 endpoint 和 OAuth 账号尚未验收。运行方式与边界见 [开发指南](docs/DEVELOPMENT.md)。

本轮进入 M3 API-key 切片：新增内置 Anthropic 连接；TUI 实时显示持久 token/cache 统计，区分 Git 查看目录与 Runtime 执行目录。

默认持续沿用 Pi，不增加执行器切换。未知 Feature 操作现可经 `--inspect` 核对后，以 `--reconcile` 明确授权一次重试；不会将旧操作直接采纳为成功。`pi-durable` 上游当前为 experimental，已固定 `1.3.0` 并提交 lockfile。

## 启动实时工作台

```sh
npm ci
npm run dev -- tui --cwd .
```

无需模型凭据即可查看工作树、改动和 diff；绑定 Runtime 的方式见 [TUI 指南](docs/TUI.md)。

## 模型与认证目标

- 内置 provider 的默认 endpoint + 用户自己的 API key。
- 自定义 endpoint、协议、model ID 和凭据；本地无认证 endpoint 也可配置。
- OpenAI 官方 Sign in with ChatGPT，用符合条件的用户订阅额度；账号、模型、授权范围和额度以服务端返回为准。
- Anthropic API key 已接线（`--provider anthropic`），真实连接未验收；Claude 订阅 OAuth 保留为受阻需求，当前官方规则不允许第三方应用提供该登录方式。

内置 endpoint 指连接预设，不包含项目共享密钥，也不表示 Loom 代付模型费用。详见 [Provider 与认证](docs/PROVIDERS.md)。

## 阅读入口

- [产品目标与边界](docs/PRODUCT.md)
- [架构设计](docs/ARCHITECTURE.md)
- [实时 TUI 与快捷键](docs/TUI.md)
- [本地开发与运行](docs/DEVELOPMENT.md)
- [Provider 与认证](docs/PROVIDERS.md)
- [工作流规格](docs/WORKFLOWS.md)
- [最小 feature 自动闭环](docs/FEATURE_AUTOMATION.md)
- [角色与流程演进](docs/ROLES_AND_EVOLUTION.md)
- [Git 与工作区生命周期](docs/WORKSPACES.md)
- [ADR 0001：薄控制层](docs/decisions/0001-thin-control-plane.md)
- [ADR 0002：内嵌 Runtime 与模型接入](docs/decisions/0002-embedded-pi-runtime.md)

Loom 为本地工作名，尚未进行商标、包名或域名核查。
