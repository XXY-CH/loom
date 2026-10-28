# 最小 feature 自动闭环

## 范围与契约

基线 `c58224b`。先复审 P1 并最小修复接线前 P2；随后实现 M2 的本地 feature 切片，不扩展 OAuth、UI、多执行器或模型配置。真实 endpoint 验收仍是 M1 硬缺口，不用 fixture 替代。

显式 RunSpec 固定 runId、目标、完整 base commit、独立 worktree 路径，以及用户认可的 targeted/regression argv。CLI 启动后由确定性驱动器依次执行现有 feature 模板：scout、contract、plan、implement、targeted_verify、review、regression、deliver。领域解释和代码判断由新建 Pi conversation 完成；不 fork 实现者历史。reviewer 只有读取工具，不能写入；命令由宿主运行并采集退出码，模型自报测试成功不形成命令证据。

运行事实与完整产物保存在拥有 Runtime 的 Pi document，证据引用使用宿主生成的身份。每个外部操作执行前持久化 intent，完成后才提交证据和阶段结果；进程退出留下的未知 intent 必须阻塞，不能自动重发工具、命令或 worker。已完成阶段可从持久化状态继续，重复启动不能重做已完成实现。单一 worktree writer 租约独立于 Runtime DB；Git-owned 持久绑定将工作树固定到 canonical DB，崩溃后也不能换 DB 绕过未知 intent。绑定存在但 Run 文档丢失时拒绝重新初始化；不按 PID 或超时抢占。

## 验收标准

- 一次性 Git fixture 自动创建 worktree，由本地 fixture provider 经真实 Pi CodingTools 修改文件，执行真实命令、独立 review、回归和交付；不通过测试直接手动设置完成状态。
- 保存实际 HEAD、tracked/untracked 内容与模式指纹、argv、cwd、退出码、stdout/stderr、worker conversation 身份和交付产物；旧 revision 的验证不得复用。
- 失败命令/无效 review/内容变化阻止交付；成功的多 revision 重验不耗尽失败预算。所有重试有界，未知副作用没有自动重试。
- 重复启动、并发 writer、取消、正常重开和进程崩溃有真实 fixture 证据。外部文件或 worker JSON 不能直接注入 Evidence。
- 每个可运行子里程碑执行定向/全量测试、typecheck、lint、build、diff check；独立复核后本地 commit，实施记录区分已验证与缺口。

## 边界

当前也支持自动 debug；原始非零复现、根因检查、修复后重验及后台服务入口见 [LOCAL_SERVICE](LOCAL_SERVICE.md)。正常退出的已知命令失败与明确的 review 拒绝按文末有界策略返工，保留失败产物；其他失败仍阻塞，不扩展为通用失败重试。cwd 与工具权限不是操作系统沙箱，不能运行不可信仓库；Git 指纹不包含 ignored 文件，拒绝无法可靠覆盖的特殊文件/子模块。没有真实模型连接与 TTY 验收时不声称完整 M1/M2 交付。

## 本地运行

使用现有连接参数，不自动选择新模型。先将以下显式 spec 保存到工作树之外（路径和完整 commit 替换为本地值）：

```json
{
  "runId": "feature-001",
  "goal": "实现明确功能，并满足指定命令",
  "repositoryPath": "/absolute/project",
  "baseCommit": "完整的 Git commit SHA",
  "worktreePath": "/absolute/feature-worktree",
  "targeted": ["npm", "test", "--", "specific.test.ts"],
  "regression": ["npm", "test"]
}
```

```sh
npm run dev -- feature --spec /absolute/spec.json --db /absolute/run/agent.sqlite --model YOUR_EXISTING_MODEL
```

添加 `--tui` 会在同一进程打开只读实时面板，观察当前 workflow 步骤、Pi 活动及 Git/worktree。它共享 FeatureRunner 的 Runtime，不尝试第二次取得数据库所有权，也不提供用户输入、resume 或 cancel；`q` 只关闭观察面板，Feature Run 继续执行；Ctrl-C 请求取消并退出。

`--inspect` 打印持久 Run、步骤、证据索引、artifact 索引、未决 operation、阻塞原因和人工核对记录，并采集 `currentWorkspace`；不派发 worker、命令、Run 或取消操作，要求既有数据库与 worktree。此输出可帮助人工核对副作用；检查本身不会解除未知 operation，也不能将步骤标为成功或删除 Git-owned 绑定。

自定义连接沿用 `--endpoint`、`--protocol`、`--key-env`；示例不读取或展示凭据。数据库必须位于 worktree 外，拒绝数据库 symlink；工作树与 DB 的绑定不能自行删除。完成后修改源码会重新打开 targeted/review/regression/deliver；已完成的实现不重放。相同 DB/spec 重开可从已提交阶段继续；未知 intent、无法安全归类的命令失败和返工额度耗尽会阻塞；未知 intent 的人工核对入口见下文。

宿主命令上限 30 秒、总输出 1 MiB，worker 单阶段等待上限 30 秒、报告 64 KiB，驱动每次启动最多 32 轮（含工作区刷新），覆盖初始 8 阶段、两次审查返工及两次验证修复。命令 argv 是显式授权的宿主操作，不是沙箱。worker 的 durable admission 取消等待上限 2 秒，超时明确失败并保留屏障，迟到完成后允许显式重试取消；取消等待当前驱动和子进程清理后持久化取消；重开后已有未知 intent 不允许用取消清除。SIGKILL 可能留下子进程，必须人工检查实际副作用；系统不会声称已自动回收。交付 manifest 保存在 Pi document，包含实际 tracked diff、全工作区指纹、产物/证据引用；未跟踪文件在 worktree 保留，不自动提交或合并。

## 有界审查返工

基线 `054250c`。保持现有内嵌 Runtime、固定 feature 模板和连接配置，接通 `review → implement → targeted_verify → review` 的局部循环。Reviewer 的明确拒绝是已知结果，保存意见并交给新的实现 conversation；最多自动返工两次，计数跨重启保留。耗尽后保留产物并 blocked，不继续交付。未知实现副作用继续保留 intent，不自动重试。

验收：一次性 Git/worktree 中真实修改两轮文件、重跑命令并由新的独立 reviewer 通过；持续拒绝有界停止；阶段边界重开保持计数且不重放完成实现；旧验证失效；无效 review 不交付。模型仅用本地 Pi fixture。局部抽出审查协议解析，不增加通用重试框架、执行器或配置项。

## 人工核对后授权重试

默认持续使用内嵌 Pi Runtime；不增加执行器选择或更换模型。对未知 operation 增加独立的 `--reconcile` 入口：要求原 spec/DB/连接、单一 operation ID、从 inspect 获取的当前完整 workspace identity，以及 `--confirm-effects-reviewed`。确认表示操作者已核对副作用、停止遗留进程并授权一次新的尝试；不表示回滚或证明旧操作成功。

入口只保存人工核对记录并重开原步骤，不启动 worker 或命令。操作 ID 或当前内容指纹不匹配时拒绝；已取消 Run 保持终态。更新内容身份、旧证据失效、重开步骤、记录核对与清除未知 intent 在同一 Pi transaction 完成；不清空审查/失败预算，不提供“采纳成功”按钮。之后显式再次运行 feature，重新取得宿主验证证据和独立审查。

```sh
# 先检查 operation、产物和 currentWorkspace，并人工核对/停止遗留进程。
npm run dev -- feature --spec /absolute/spec.json --db /absolute/run/agent.sqlite --model YOUR_EXISTING_MODEL --inspect
# 用本次 inspect 的真实 ID 和完整 currentWorkspace JSON 替换下面的占位值。
npm run dev -- feature --spec /absolute/spec.json --db /absolute/run/agent.sqlite --model YOUR_EXISTING_MODEL --reconcile --operation-id OPERATION_ID --expected-workspace 'CURRENT_WORKSPACE_JSON' --confirm-effects-reviewed
# 核对只解锁；随后用原来的 feature 命令显式启动新尝试。
```

验收：真实临时 Git/worktree 中发生副作用后中断、重开仍阻塞；错误 ID/旧指纹无法解锁；明确核对只解除对应 intent；再次重开后完成必需验证、审查和交付；重复核对与活动运行竞态不能重放操作。保留 Runtime shell journal 的独立核对门禁，不跨数据库伪造原子提交。模型仅用本地 fixture，真实 endpoint/TTY 继续单独验收。

## 验证失败后的有界局部修复（基线 af84942）

本子里程碑只接通宿主 targeted/regression 命令正常退出且非零、工作区前后未变化的已知失败。保存实际退出码和输出，最多两次重新派发隔离 implementer，额度跨阶段与重启共享；原 review 返工额度仍单独计算。修复输入为宿主保存的最近失败命令与输出，输出内容只是诊断数据，不能控制调度或声明可信证据。随后必须重跑 targeted、独立 review、regression 和交付门禁。

验收使用一次性真实 Git/worktree、真实失败命令及本地 Pi fixture 写文件：定向失败后修复成功；回归失败后旧验证和审查失效；失败提交/重新实现之间重启不丢预算、不重复旧命令；额度耗尽不交付；审查返工与验证修复组合不耗尽驱动转移额度；spawn 错误、超时、取消、未知副作用及验证中内容变化均不进入自动修复。不新增通用重试框架、连接配置或 UI，不改变稳定提示前缀与角色隔离。M1 真实 endpoint/TTY 仍单独验收。
