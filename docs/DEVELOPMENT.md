# 本地开发与 M1 使用

目标 Node.js 24 LTS，npm。初次安装：

```sh
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run dev -- --help
```

## 实时 TUI

`npm run dev -- tui --cwd .` 启动实时 Git/worktree 浏览，无需模型凭据。`--once` 输出纯文本快照。绑定 `--db PATH --model ID` 后可通过 `i` 输入任务、`p` 恢复、`x` 取消；完整布局、快捷键和实时更新边界见 [TUI](TUI.md)。

## 运行 Spike

先建立可丢弃的测试目录。此 `run` 入口的内嵌 CodingTools 可以读写与执行命令；cwd 不是沙箱，`run` 不分配 Workflow/worktree 或检查开发完成门禁。需要这些能力时使用显式 `feature` 入口。

默认 OpenAI Responses 连接从本机环境读取 `OPENAI_API_KEY`；不要将 key 写入命令参数、仓库文件或报告。选择账号可用的 model ID：

```sh
npm run dev -- run --db /tmp/loom-spike/agent.sqlite --cwd /tmp/loom-fixture \
  --model YOUR_MODEL_ID --prompt 'Inspect this directory and describe its files.' \
  --request-id inspect-001
```

自定义兼容服务：

```sh
npm run dev -- run --db /tmp/loom-local/agent.sqlite --cwd /tmp/loom-fixture \
  --endpoint http://127.0.0.1:11434/v1 --protocol completions --model YOUR_MODEL_ID \
  --prompt 'Describe this directory.' --request-id inspect-001
```

自定义服务需要认证时增加 `--key-env MY_PROVIDER_KEY`，其值只从环境读取。请求重试使用原始 request ID 和输入；不要给同一 ID 换任务。数据库保存对话和工具记录，不保存 profile key。

## 内置 Anthropic API-key 连接

显式指定 provider，默认读取本机 `ANTHROPIC_API_KEY`：

```sh
npm run dev -- run --db /tmp/loom-anthropic/agent.sqlite --cwd /tmp/loom-fixture \
  --provider anthropic --model YOUR_MODEL_ID \
  --prompt 'Inspect this directory.' --request-id inspect-001
```

默认采用 Messages 协议，也可显式 `--protocol messages`。`--key-env NAME` 只选择该变量，不会在缺失时改用其他 key；不支持 Anthropic 自定义 endpoint 或订阅 OAuth。已有 OpenAI 命令无需改变参数，连接身份保持兼容。不同 provider/endpoint/model 的数据库不可混用。此连接已通过本地 fixture；真实工具流仍需实际验收。

## 状态与恢复

将 `run` 换为 `status` 可查看已提交记录数量与 submission 状态计数；换为 `resume` 可启动存储中未完成任务并等待 idle。存在 unanswered、queued 或 placed 时返回退出码 1，包含以前进程留下的失败。保持原 `--db`、`--cwd`、model 和连接参数；重开不能静默更换连接。`status` 也要求连接配置可解析，目前不是离线浏览器。

Idle 只表示 Runtime 无进行中的工作，不等于开发目标验收完成。失败或未知副作用应检查持久化记录；不要直接重发可能已经产生副作用的任务。Ctrl-C 请求取消 durable 工作，关闭操作保存恢复状态；测试已验证普通 close/cancel 会清理本进程持有的 shell；SIGKILL 或主动脱离进程组的后代仍可能继续运行。

遇到 `RECOVERY_REQUIRED` 时，先用 `status` 读取 `pendingOperationIds`，人工检查工作区副作用和旧 shell 状态，再提交完整、精确的 ID 集合：

```sh
npm run dev -- ack-recovery --db /tmp/loom-spike/agent.sqlite --cwd /tmp/loom-fixture \
  --model YOUR_MODEL_ID --operation-id ID1,ID2 --confirm-effects-reviewed
```

使用原连接参数，然后执行 `resume`。确认不代表取消、回滚或证明旧 shell 已停止。操作 journal 仅记录 UUID、状态与时间；异常退出时，即使命令已结束，只要尚未完成安全检查点，也会要求核对。保留 `.operations.sqlite` 及其 SQLite sidecar，不通过删除记录绕过门禁。

每个数据库由 Runtime 持有独占 lease，第二 opener 会失败。`.loom-lease.sqlite` sidecar 必须保留，不要在运行中删除、替换数据库或其路径。使用本地文件系统；此机制依赖系统 SQLite 文件锁。

## 预算占用的人工核对

feature/debug 运行带预算账本（`<db>.budget.sqlite`）。模型请求失败或进程被杀后，该次调用在账本中保持 unsettled 并阻塞后续派发；核对了 workflow intent（`feature --reconcile`）也不能绕过它。人工核对解锁的 CLI 入口为：

```sh
npm run dev -- feature --db /tmp/loom-spike/feature.sqlite --reconcile-budget
```

它只需 `--db`，不解析连接、不读 spec、不派发模型工作；连接类旗标（`--model`、`--profile`、`--profile-id`、`--provider`、`--endpoint`、`--protocol`、`--key-env`）与它组合一律显式拒绝——持久化账本本身标识数据库，核对不需要也不接受连接配置（`--catalog` 单独出现由共享的成对约束先行拒绝，与 `--profile-id` 成对时由 `--profile-id` 条目先行拒绝，清单内不可达的 `--catalog` 条目已删除且拒绝行为逐字不变）。输出核对前后的账本摘要（calls/tokens/pending/reconciled）。语义：把 unsettled 行标记为已核对——解除派发阻塞、不补造 token 数字、调用计数保留（该请求可能已到达 endpoint）；不把该调用采纳为成功。账本无 unsettled 行时明确报错，不静默成功。

同一核对语义的另一入口是服务侧 socket/HTTP 写方法 `reconcile-budget`（HTTP 形态 `POST /runs/:runId/reconcile-budget`；浏览器工作台 Run 详情在 `usage.pending>0` 且 Run 非 active 时以显式确认按钮触发，服务 TUI 以 `b` 键位经同一 socket 方法触发——门控、显式确认一步与错误口径一致），适用于服务托管的 Run：不必记数据库长路径，也不必为核对停服。见 [LOCAL_SERVICE](LOCAL_SERVICE.md)「全树预算」。

核对通过数据库 lease 取得独占：仍在持有该 Run Runtime 的进程（另一个 CLI feature 进程、或服务正在 dispatch 该 Run）会让核对以 `DATABASE_IN_USE` 拒绝（服务侧入口把该 code 前缀进错误消息透传，不排队、不自动重试），不绕过单进程所有权。服务托管 Run 的不停服流程是：CLI `feature --reconcile` 清 workflow 操作（workflow 人工核对仍仅 CLI）→ 工作台按钮、服务端点或服务 TUI `b` 键位核对预算 → 服务端显式 resume；停服务→CLI 离线核对→重启→显式 resume 的流程仍完整可用（两种形态均已由真实服务进程的集成测试端到端钉住）。已失败/阻塞的 Run 在其 run() 结束后 runner 已关闭、lease 已释放，服务进程本身不持有各 Run 的账本，此时两种入口都可合法成功——lease 是所有权的唯一裁判。CLI 侧打开服务托管的 Run（`--inspect`/`--reconcile`）须以与服务 start 完全一致的 profile id 经 `--profile`/`--profile-id` 进行，spec 文件直接回读 `dataRoot/runs/<runId>/request.json` 的 `.spec`（持久化 spec 是规范化后的定序形态，自写 JSON 键序不同会被严格比较拒绝）；Run 连接身份推导已在 CLI 与服务间统一（固定七键序 kind/protocol/modelId/baseUrl/keyEnv/contextWindow/maxTokens 的完整 SHA-256，catalog 条目 `id` 不参与——它是目录标签而非连接语义）。失败重试往往同时留下待核对的 workflow operation：先用 `--inspect`/`--reconcile` 清掉，再做预算核对，然后用原命令 resume。旧格式账本（无核对标记列）只读投影可直接读取，Runtime 重开账本时自动补列，无需手工迁移。一次性迁移如实记录：身份推导统一前遗留的本机 Run DB（旧 CLI 24hex 前缀或旧服务含 id 的 64hex）不再匹配新身份，重开以 `Run connection differs from its persisted runtime` 拒绝；分支未推送、无外部用户，新代码下创建/重开自洽。

## 模型缓存观察

`status` 和正常 `feature` 结果包含 `usage.models` 与 `usage.total`，读取 Pi 持久账本，重开后不清零。字段 `input` 是未缓存输入，`cacheRead`/`cacheWrite` 为缓存读写 token；`cacheReadPromptRatio` 为 `cacheRead / (input + cacheRead + cacheWrite)`，范围 0–1，分母为零则为 `null`。不要直接相加各模型百分比，应使用总 token 加权值。

这是 SDK 收到的用量，不是账单或实时在途消费。provider 缺失的缓存细分可能被 SDK 归零，零值不能证明真实零命中；崩溃前未提交到 Pi 的用量也可能缺失。真实命中率需要真实连接报告，本地 fixture 数字只验证接线。请求将稳定政策和目标置于前缀，保留各角色独立会话的持久缓存身份；不通过共享 reviewer 历史提升缓存。

## 当前边界

CLI 是 M1 实验入口，不是完整本地服务。已有 TUI，以及独立的 Workflow、worktree 生命周期和实验 OAuth API；Workflow 和 worktree 已通过显式 feature CLI 接入最小自动闭环，尚未接入 TUI 派发；OAuth 仍未接入模型连接。具体 spec、执行边界和恢复限制见 [FEATURE_AUTOMATION](FEATURE_AUTOMATION.md)。本地后台服务、可重建 Run catalog 与下述非敏感连接 catalog 已接线（Run catalog 是服务侧 Run 投影，连接 catalog 是客户端连接档案，二者不同）；浏览器工作台已接线（服务同源提供的 React 最小工作台，含连接、实时列表/详情、cancel/resume、diff/证据只读渲染与 start 派发表单，见 [LOCAL_SERVICE](LOCAL_SERVICE.md)「浏览器工作台」）。确定性测试不能替代真实模型服务和强制终止恢复验收。


## 可复用连接 profile

使用 `--profile /path/to/local.json` 替代 `--model`、`--provider`、`--endpoint`、`--protocol` 和 `--key-env`，适用于 run、feature、status、resume、ack-recovery 和绑定 Runtime 的 tui；两种配置方式不能混用。路径相对启动目录解析，没有隐式全局默认或自动账号切换。

```json
{
  "id": "local",
  "kind": "openai-compatible",
  "protocol": "openai-completions",
  "modelId": "YOUR_MODEL_ID",
  "baseUrl": "http://127.0.0.1:11434/v1"
}
```

```sh
npm run dev -- status --cwd . --db /tmp/loom.sqlite --profile /path/to/local.json
```

内置 provider 使用 `kind: "openai"` / `protocol: "openai-responses"`，或 `kind: "anthropic"` / `protocol: "anthropic-messages"`，不设置 baseUrl。需要自选凭据时添加 `keyEnv` 环境变量名；文件不允许明文 key/token 或额外字段。可选 `contextWindow`、`maxTokens` 沿用 provider 校验。连接字段与 token 限制绑定数据库身份（固定七键序 kind/protocol/modelId/baseUrl/keyEnv/contextWindow/maxTokens 的完整 SHA-256，CLI 与服务共用同一推导；profile 的 `id` 是 catalog 条目标签，不参与连接身份）；但 `id` 仍作为 Pi provider 会话标识 `loom:<id>` 参与重开校验，换 id 重开同一 Run DB 同样被拒。同名配置变更必须使用新数据库，JSON 字段顺序变化不影响身份。相同环境变量名下更换凭据不会改变身份，凭据值不进入 hash；此机制不证明账号或真实连接有效。

## 连接 catalog

非敏感 profile 可持久保存到本地连接 catalog，再用 `--profile-id ID` 显式选择。catalog 默认存于 `~/.loom/connections.json`，目录与文件均要求 owner-only 权限、拒绝符号链接，写入经临时文件原子替换；`--catalog DIR` 可覆盖目录（测试与隔离用，目录内仍为 `connections.json`）。catalog 只保存上节允许的非敏感字段，凭据仍由 `keyEnv` 指向的环境提供，不写入 catalog。

```sh
npm run dev -- connections add --profile /path/to/local.json --catalog DIR
npm run dev -- connections edit --profile /path/to/local.json --catalog DIR
npm run dev -- connections list --catalog DIR
npm run dev -- connections remove --id local --catalog DIR

npm run dev -- status --cwd . --db /tmp/loom.sqlite --profile-id local --catalog DIR
```

`connections add` 复用 profile 文件校验：明文凭据与未知字段拒绝入库；同 ID 且字段完全相同的重复 add 只做幂等确认，不同字段拒绝，与 profile 的数据库身份语义一致。`connections edit`（profile 文件定义条目 id，不带 `--id`）是显式的同 id 更新：未知 ID 报 `UNKNOWN_CONNECTION`（不做 upsert），字段完全相同的重复 edit 只做幂等确认且零写盘，字段不同则替换同 id 条目——add 的同 id 拒绝语义保持不变。`run`、`feature`、`debug`、`status`、`resume`、`ack-recovery` 和绑定 Runtime 的 `tui` 都接受 `--profile-id ID`，与 `--profile`、`--provider`、`--endpoint`、`--protocol`、`--key-env`、`--model` 互斥；未知 ID 明确报错退出，不回退到默认连接，也不提供全局/项目默认自动选择。`--profile-id` 在 CLI 客户端内解析为 ProviderProfile 对象，不生成临时 profile 文件；后台服务 TUI 的 `start` 仍接收 profile 文件路径，本轮不改服务 socket 协议（见 [LOCAL_SERVICE](LOCAL_SERVICE.md)）。

`connections` 子命令只接受 `--catalog` 与各自的选择器（`add --profile`、`edit --profile`、`remove --id`、`list` 无选择器）；其余 runtime flag 一律拒绝。runtime 命令中 `--catalog` 仅在与 `--profile-id` 成对出现时有效，`--id` 只属于 `connections remove`。

## 存储边界

连接 catalog（`connections.json`）与 OAuth 凭据存储（`~/.loom/auth/credentials-v1.json`）共用同一套本地存储规则：目录 `0o700`、文件 `0o600`，owner-only 权限、拒绝符号链接；写入经 `O_EXCL` 临时文件 fsync 后 rename 原子替换并同步目录；文件缺失按空库处理，无法解析的内容明确报 `STORAGE_INVALID` 并保留原数据，不静默重建。

属主校验在 Unix 上比对文件 uid 与 `process.getuid()`。在没有 `process.getuid` 的平台（如 Windows），该校验退化为仅检查权限位，不做 Windows ACL 校验；Windows 不是已验收平台，不在此宣称支持。

并发修改经 lock 目录（`connections.json.lock` / `credentials-v1.json.lock`）串行化：lock 被其他持有方占用时，连接 catalog 写操作报 `CATALOG_BUSY`，凭据存储写操作报 `AUTH_BUSY`，均失败关闭、不覆盖他人写入。持锁进程崩溃后 lock 目录会残留，后续写操作持续报 busy，需要人工确认无存活持有方后手动删除该 lock 目录；锁没有陈旧性检测，不会自动回收。
