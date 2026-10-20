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

## 模型缓存观察

`status` 和正常 `feature` 结果包含 `usage.models` 与 `usage.total`，读取 Pi 持久账本，重开后不清零。字段 `input` 是未缓存输入，`cacheRead`/`cacheWrite` 为缓存读写 token；`cacheReadPromptRatio` 为 `cacheRead / (input + cacheRead + cacheWrite)`，范围 0–1，分母为零则为 `null`。不要直接相加各模型百分比，应使用总 token 加权值。

这是 SDK 收到的用量，不是账单或实时在途消费。provider 缺失的缓存细分可能被 SDK 归零，零值不能证明真实零命中；崩溃前未提交到 Pi 的用量也可能缺失。真实命中率需要真实连接报告，本地 fixture 数字只验证接线。请求将稳定政策和目标置于前缀，保留各角色独立会话的持久缓存身份；不通过共享 reviewer 历史提升缓存。

## 当前边界

CLI 是 M1 实验入口，不是完整本地服务。已有 TUI，以及独立的 Workflow、worktree 生命周期和实验 OAuth API；Workflow 和 worktree 已通过显式 feature CLI 接入最小自动闭环，尚未接入 TUI 派发；OAuth 仍未接入模型连接。具体 spec、执行边界和恢复限制见 [FEATURE_AUTOMATION](FEATURE_AUTOMATION.md)。catalog、本地后台服务和 Web UI 尚未实现。确定性测试不能替代真实模型服务和强制终止恢复验收。
