# TUI：实时开发现场

## 目标与视觉设计

TUI 优先服务于可观察的开发过程：Agent 正在做什么、在哪个目录执行、改了哪些文件、还有哪些结果不确定。界面从真实 Git 与 Pi 事件构建，不按模型自述推断成功。

宽度达到 120 列时采用三栏：Worktrees 约 25%、Agent Activity 约 29%、Changes & Diff 使用剩余宽度。较窄终端按焦点切换单栏。标题与选中状态用青绿色，运行与脏状态用琥珀色，失败与冲突用红色；diff 增删分别使用绿、红。字符截断按终端单元格计算，支持中文与 emoji；非可信文本不能注入 ANSI、OSC 或额外控制行。`NO_COLOR=1` 保留结构并关闭配色。

顶部固定分支、ahead/behind、四种改动计数和刷新状态；底部固定 Runtime 状态与快捷键。查看另一个 worktree 不改变 Agent 的执行目录。Runtime 状态单独保留原执行路径；切换查看目录后，顶部并列显示 `Git viewing` 与 `Runtime executes`，不把执行目录称为已验证的 writer 所有权。普通 Git 观察器不显示 Runtime 执行标记。

## 启动

只观察仓库，不需要模型或凭据：

```sh
npm run dev -- tui --cwd .
npm run dev -- tui --cwd . --once
```

`--once` 输出无 ANSI 的单次快照，适合管道与诊断。交互模式要求真实 TTY。

附着到一个 Runtime，并可直接发送任务：

```sh
npm run dev -- tui --cwd /absolute/repo --db /tmp/loom/run.sqlite \
  --model YOUR_MODEL_ID
```

连接沿用现有 `--endpoint`、`--protocol`、`--key-env`；内置 Anthropic 使用 `--provider anthropic` 和本机 API key。添加 `--prompt TEXT --request-id ID` 可在启动时提交输入；已有恢复任务按 `p` 显式继续。TUI 独占该数据库，当前不能连接到另一个已经运行的 CLI 进程。

Feature Run 可在同一进程启动只读现场观察：

```sh
npm run dev -- feature --spec /absolute/spec.json --db /absolute/run/agent.sqlite \
  --model YOUR_EXISTING_MODEL --tui
```

这个入口复用 FeatureRunner 正在持有的 Runtime，不另开数据库连接；会实时显示 workflow Run、当前步骤、Pi 活动和 Git/worktree 状态。观察模式禁用消息输入、resume 与 cancel，阶段仍由 feature 驱动器推进；按 `q` 退出观察界面后驱动器继续到结束。

## 操作

| 按键 | 行为 |
| --- | --- |
| Tab | 切换 worktree、Agent 活动、文件面板 |
| ↑/↓、j/k | 选择工作树或文件；活动面板滚动历史 |
| Enter | 打开选中的 worktree，仅改变 Git 查看位置 |
| s | 切换 working / staged diff |
| PgUp/PgDn | 滚动 diff 或活动历史 |
| r | 请求刷新 Git |
| i、Enter、Esc | 输入消息、发送、放弃输入；执行期间也可输入，需要绑定 Runtime |
| p / x | 显式恢复 / 取消 Runtime 工作 |
| q | 普通 TUI 退出；`feature --tui` 只关闭观察面板，Feature Run 继续 |
| Ctrl-C | 普通 TUI 退出；`feature --tui` 请求取消并关闭宿主，失败时保留可核对状态 |

退出不会把 Runtime 留在后台运行。`x` 请求真正的取消；`q` 不等价于取消。恢复核对仍用 CLI `status` 与 `ack-recovery`，不能在界面中无条件跳过。

## 与控制层交互

按 `i` 输入自然语言，Enter 提交。输入被 Pi 持久接纳后清空草稿，此时即可继续发消息，无需等上一条回复结束。界面显示本次宿主观察的 pending 数量、request ID、接纳和结算状态；pending 不包含重开前的所有请求，持久状态用 `/status` 查询。后续消息由 Pi 决定排队和处理边界，不保证立刻打断当前工具。

接纳期间锁住草稿，防止重复 Enter；失败保留草稿和 request ID，直接重试沿用该 ID，编辑后使用新 ID。本次宿主最多观察 16 条未结算输入。长输入随尾部显示，Pi 事件与用户交互记录合并显示，最多 100 条。

| 输入 | 行为 |
| --- | --- |
| `/help` | 显示控制命令 |
| `/status` | 读取持久请求计数、恢复操作数和本次宿主 pending |
| `/workflow` | 读取同一 Harness 的流程状态、步骤与待答问题 |
| `/resume`、`/cancel` | 恢复、取消 Runtime，与 p / x 共用入口 |
| `//text` | 将 `/text` 作为普通消息发给模型 |

`/cancel`（或 `x`）调用时建立宿主屏障：撤销此前排队、接纳中及观察结算中的输入，拒绝新输入和 `/resume`，等待接纳调用结束后再取消 Pi。只有接纳屏障与 Runtime 取消都完成才返回成功，之后明确发送的新输入正常接纳。整个调用最多等待 2 秒；超时或失败会明确报错并保持封锁，使用 `/status` 核对后显式重试 `/cancel`。超时后的底层调用可能继续完成，但不会自动解除封锁；永久不返回的底层调用需要关闭并核对宿主，不能靠重复提交绕过。

撤销立即解除草稿锁并结清本次宿主 pending，不代表 Runtime 已取消成功；活动中的 `Host input withdrawn` 不会被迟到的结果覆盖。草稿保留原 request ID；直接重试保持幂等，若此前请求已在 Pi 取消结算，不会因此重新执行。编辑草稿后会生成新 request ID。普通接纳失败仍保留原 ID 供核对和重试。

控制命令由 Loom 处理，不发送给模型；未知命令保留草稿。`/workflow` 为只读入口，当前不能创建流程、回答流程问题或自动推进阶段。普通对话仍提交到 Pi root Agent；此交互控制层尚不是完整的多角色 orchestrator。

## 实时更新与事实边界

Git 使用真实 `status --porcelain=v2 -z`、`worktree list --porcelain -z` 和 diff。每轮完成后间隔 750ms 再采集，不重叠执行；包含外部编辑器、index 与 refs 的变化，不依赖 Agent 自报。Git 快照由多次读取组成，并非原子事务；每次显示采集时间，失败保留上次快照并标注 ERROR，超过 10 秒标注 STALE。

工作树计数 `S / W / ? / !` 分别对应 staged、working、untracked、冲突。最多采集 20 个可访问 worktree 的改动状态，四个并行；未采集或不可访问时显示 `status not observed`。不会自动 fetch、stage、commit、删除工作树或推断 Loom 的写入所有权。ahead/behind 只反映本地已知 refs。行数合计 staged 与 working 两层，不是独立行的去重计数；未知或超大未跟踪内容可能显示零行。

Agent 使用 Pi `watchEvents` 的初始快照与后续有界事件批次，显示生成、工具名、命令或路径、保留的输出及中断/返回状态。溢出后由新快照重建，暂存 token 不作为成功证据；idle、工具返回与 Workflow 验收分开显示。活动保留最近 100 条，每项最多保留 2000 字符，正文与输出展示尾部片段，可滚动历史。环境中已知凭据和常见内联凭据字段做尽力脱敏，不能据此承诺任意工具输出均无敏感内容。

## 用量与缓存

绑定 Runtime 后，每 750ms 读取 Pi 持久账本，与 workflow 状态一起刷新；普通对话没有 workflow 也会读取。Agent Activity 用三行展示未缓存输入/输出、缓存读写 token 和 `Prompt cache` 比例，120 列三栏布局可直接看到。比例为缓存读取 /（未缓存输入 + 缓存读取 + 缓存写入），无输入显示 unknown；读取失败清空旧数值并显示 `Usage unavailable`。

数值只包含已提交的 SDK 用量，不能显示在途消耗或作为账单。provider 未返回的缓存细分可能为零，不证明实际没有命中。本地 fixture 验证显示与持久化协议，真实命中率仍待真实连接验证。

## 当前完成范围

已完成实时观察、worktree 切换、diff 分层、键盘导航、任务输入及 Runtime 恢复/取消入口。Workflow 内核、worktree 生命周期和实验 OAuth 各有独立模块，尚未接入 TUI 的流程操作、创建/清理和登录页面。没有独立后台服务、完整屏幕 diff 编辑器或自动阶段执行。

验证覆盖终端尺寸、中文宽度、控制字符、真实 Git 修改与 worktree、外部修改刷新、事件投影和 SDK 工具事件；PTY 冒烟验证实际键盘、resize、实时 diff、退出与终端恢复。真实模型账号和不同终端模拟器的视觉验收仍待实际试用。
