# 架构设计

状态：M1 Runtime/Provider/CLI 已实现，本地 M2 feature 自动闭环与实时 TUI 观察已接线；真实模型 endpoint 尚未验收，服务端与 Web 仍是后续设计。实际验收边界见 [开发指南](DEVELOPMENT.md)，运行时选择依据见 [ADR 0002](decisions/0002-embedded-pi-runtime.md)。

## 分层与数据流

```text
TUI / CLI / 本地 Web（后续）
      │ 本地 API、提交 requestId、订阅已提交事件
Loom application service
      ├─ Project / Workspace：规则、工作树、写范围与锁
      ├─ Workflow：feature / debug、输入输出契约、验证与交付门禁
      ├─ Runtime bridge → 内嵌 pi-durable Harness
      │                    ├─ conversation / durable task / document
      │                    ├─ 工具 → 文件、命令、Git、验证、可选外部工具
      │                    └─ pi-ai → 连接 profile → 模型服务
      └─ Evidence / Artifacts：diff、验证、审查、内容指纹
```

自然语言理解、开放式规划和代码判断由 Agent 完成；程序校验计划类型、依赖、范围和预算。控制层只接受符合契约的状态转移，Agent 的完成自述不能直接将 Run 标记为 completed。

## 复用与自建

| 交给 Pi 的能力 | Loom 负责的产品语义 |
| --- | --- |
| Harness、conversation、模型轮次和工具任务 | 开发目标、计划版本、阶段依赖和验收 |
| durable task、checkpoint、恢复和取消 | 工作区核对、副作用处置、暂停和交付条件 |
| SQLite transcript、typed document、事务 | 证据定义、跨任务索引和产物保留 |
| pi-ai 模型协议与凭据接口 | 连接 profile、认证策略、账号选择和预算 |
| 工具、extension、hook、执行环境 | 仓库规则、工具权限、Git、测试和审查 |

`src/runtime/` 是对上游 API 的窄封装，统一 open / submit / observe / abort / close 等宿主操作；这些是 Loom 拟定接口，不是假定存在同名 Pi API。不实现通用多 CLI 执行器框架。

当前 TUI 直接连接同进程 Runtime，使用 Pi `watchEvents`，Git 以有界非重叠轮询采集；没有跨进程服务订阅。见 [TUI](TUI.md)。

## Workflow 的持久化

首选通过 Pi `defineTask` 定义带版本的 `loom.feature`、`loom.debug`，通过 `defineDoc` 保存 Run、Step 和证据引用，使用同一 Harness commit 原子更新阶段与子任务。先以 Spike 验证这个组合，避免独立调度器重复维护同一运行状态。

每个 Run 对应一个 Harness 存储，根 conversation 提供任务交互，按需创建受控子 conversation。审核者使用独立输入与工具范围；不直接 fork 完整实现者上下文。角色是 profile，不要求每个阶段创建 Agent。

Run 记录 project、base revision、工作树基线、workflow/plan/runtime 版本、连接 profile 版本、预算和终止原因。Step 记录依赖、attempt、conversation/task ID、输入产物、状态与时间。不得在这些文档里保存凭据。

## 存储所有权

建议用户数据根为 `~/.local/share/loom/`（允许覆盖）：

```text
catalog.sqlite                 # 项目、连接的非敏感元数据、Run 索引、工作区租约
runs/<run-id>/agent.sqlite      # Pi 状态 + Loom Run/Step 文档，运行事实来源
runs/<run-id>/artifacts/        # diff、完整命令结果、验证与审查产物
```

一个本地服务进程独占 Harness 数据库；Pi 本身没有跨进程存储锁，Loom 必须阻止两个服务同时打开。CLI 和 Web 都连接同一服务。catalog 中 Run 状态只是可重建投影，以 run 存储为准；跨库操作用稳定 ID、outbox/回读与启动核对，不能声称跨库原子事务。凭据由独立 CredentialStore 管理。

## 工作区和副作用

读取并保存原有脏改动，写任务按需创建独立 worktree。同一写范围单 owner；通过服务端租约与启动核对管理，不能仅凭超时抢占仍在执行的命令。

Pi 将非 `replay: safe` 的中断工具返回为 interrupted，不保证文件或外部操作只执行一次。Loom 要保存 operation ID、意图与结果引用，恢复后核对效果；未知副作用进入 waiting_input/blocked。普通 shell、发布、提交和外部工具不能笼统标为 replay-safe。

内嵌运行不等于必须与 API 服务共用进程：需要时可放入 Loom 自己的 worker 进程，仍使用 SDK。`cwd` 不是沙箱；读写和命令范围由 ExecutionEnv/工具实现约束，恶意代码隔离需要额外操作系统边界。

## 验证与交互

验证保存命令、cwd、时间、退出码、stdout/stderr 引用、base/head revision 与工作树内容指纹（含相关未跟踪文件）。模型引用的结果必须能回查到程序采集的证据。测试通过、场景通过与外部可达分别验证。

界面通过持久化记录重建状态；实时 token 增量只作为临时显示，不能作为成功证据。SSE 断线后使用游标或重新读取快照恢复，具体订阅 API 在 Spike 固定。

暂停表示停止派发新阶段，并等待当前操作安全结束；不能暗示能冻结任意 shell。取消需终止所属任务和子进程树并核对工作区；不假定 Pi 的取消自动覆盖所有外部进程。全树预算与并发由 Loom 管理，上游 usage 用于结算；不保证中断能避免已经发出的服务端费用。

## 最小 feature 驱动的实际接线

显式 FeatureSpec → `FeatureRunner` → 原有 `transitionWorkflow` 确定性门禁 → 独立 ownerless Pi conversation / 宿主命令采集 → 同 Harness document 证据与交付。scout/contract/plan/implement/review 各建 conversation，继承相同 model/thinking/cwd；仅 implementer 获 read/write/edit，其余只 read，均不提供 bash。review 只接受当前 revision、独立 conversation 的严格结论；模型报告不具有宿主 Evidence 身份。

每阶段先持久化 intent，再执行外部动作，最后同事务提交产物和完成。崩溃未知 intent 阻塞，不盲目重放；已完成阶段可恢复。单 writer 租约之外，工作树 Git 元数据中持久绑定 canonical Runtime DB，避免崩溃后更换数据库越过恢复门禁。已有绑定不匹配/损坏或 Run 文档缺失需人工核对，不自动抢占。该文件工具边界不是 OS 沙箱；真实 endpoint 与端到端交互验收仍独立于本地 fixture。
