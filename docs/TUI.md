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

上述普通单进程模式退出不会把 Runtime 留在后台运行。`x` 请求真正的取消；`q` 不等价于取消。恢复核对仍用 CLI `status` 与 `ack-recovery`，不能在界面中无条件跳过。

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

已完成实时观察、worktree 切换、diff 分层、键盘导航、任务输入及 Runtime 恢复/取消入口。Workflow 内核、worktree 生命周期和实验 OAuth 各有独立模块，尚未接入 TUI 的流程操作、创建/清理和登录页面。服务模式与自动阶段执行现已接线，见下文；完整屏幕 diff 编辑器、OAuth 登录和 worktree 创建/清理界面尚未实现。

验证覆盖终端尺寸、中文宽度、控制字符、真实 Git 修改与 worktree、外部修改刷新、事件投影和 SDK 工具事件；PTY 冒烟验证实际键盘、resize、实时 diff、退出与终端恢复。真实模型账号和不同终端模拟器的视觉验收仍待实际试用。

## 后台服务工作台

先运行 `npm run service -- --data-root /absolute/loom-data`，再运行 `npm run service:tui -- --data-root /absolute/loom-data`。TUI 只访问 socket，不另开 Runtime 或数据库 owner；`q`/Ctrl-C 只断开界面，任务继续。`--once` 输出无 ANSI 的当前快照。

`n` 输入 `start "/absolute/spec.json" "/absolute/profile.json"`；`x` 取消，`p` 显式恢复，`b` 预算人工核对（选中 Run `usage.pending>0` 且非 active 才有入口）。`Tab` 切换 Run/步骤/证据或连接（面板打开时）/Git，`g` 切换 Git 内视图，`s` 切换 staged/working，`j/k` 选择或滚动，`r` 刷新，`e` 切换只读证据面板，`c` 切换连接面板。`b` 进入显式确认一步（确认前零请求，`Esc` 放弃零请求），`Enter` 经既有 socket `reconcile-budget` 方法恰发一次请求：成功渲染 before/after 账本摘要与「不采纳为成功、不补造 token、不证明未到达 endpoint」声明；结构化错误（含 `DATABASE_IN_USE: …` 前缀消息）原样显示、连接不断开、确认步保持武装供显式重试，失败关闭不排队不自动重试；换 Run/start 接受新 runId 后摘要与确认态经 revision 守卫清空，迟到响应不落地；落地摘要与结构化错误行均以 runId 守卫渲染，永不为另一 Run 显示。开草稿（`n`/`a`/`u`）即放弃武装——草稿打开期间 footer 确认提示被隐藏、草稿的 `Enter` 是提交键，隐藏的武装写状态不留存（落地摘要与在飞响应不受影响）。核对只针对预算账本，workflow operation 人工核对仍仅 CLI，resume/blocked 门禁不受键位影响。证据面板按条目渲染 `id/stepId/kind/attempt/valid` 与类型详情（command 的命令与退出码、review 的审查者与未解决项、artifact 的生产者），与 HTTP 工作台 evidence 视图同一信息集、同一 socket `evidence` 投影。面板内 `j/k`（及 ↑/↓/PgUp/PgDn）移动选中游标（带 `›` 标记）——游标在可见窗口内自由移动，触及窗口边缘后窗口随游标滚动一行（窗口跟随游标，`›` 标记恒随游标），游标钳制于末条（不越过），切换 Run 或重开面板复位到首条。选中 artifact 条目按 `Enter` 经既有 socket `artifact` 方法按需拉取一次正文并进入正文视图，再按 `Enter` 关闭回到列表——已加载正文缓存于面板打开期间，收起再展开不重复请求；正文视图头部如实渲染完整 `byteLength` 与 `truncated` 徽标（截断时 `truncated at 64 KiB`，与 HTTP 工作台同一 64KiB 读侧截断口径），正文逐行经既有 fitCells 终端清洁器（控制字符/ANSI 注入被过滤，窄屏按单元格拟合），面板内 `j/k` 滚动正文行。拉取的结构化错误（如 `Unknown evidence id`）仅在面板内降级提示（`enter` 重试），不占用全局 notice、不影响连接状态；迟到/换 Run 的正文响应经独立 revision 守卫永不落地。command/review 条目无查看入口。面板打开期间 evidence 请求随 750ms 刷新发出并受 revision 守卫，失败只在面板内降级提示，不影响 Run 列表/详情；切换 Run 时正文视图、缓存与选中一并清除。

`c` 连接面板与服务 `--catalog DIR` opt-in 下的连接 catalog 对接，纯消费既有四个 socket 方法（`connections`/`connections-add`/`connections-update`/`connections-remove`），与浏览器工作台增删改入口同一写路径、同一门控口径。面板可见期间随 750ms 刷新经只读 `connections` 方法拉取列表（面板关闭零连接流量），`j/k` 游标导航沿证据面板同一窗口跟随先例；catalog 未启用（或拉取失败）时面板内原样显示结构化提示（如 `Connection catalog is not enabled; start the service with --catalog DIR`），且管理键位零请求——门控机制与 web 表单的 `catalogEnabled` 同构：仅上一次 `connections` 拉取成功后 `a`/`u`/`d` 才生效，不匹配错误文案（`u` 另要求游标条目存在，空列表零状态零请求）。`a` 经共享草稿机制输入 `add "/absolute/profile.json"`（profile 来源是磁盘文件路径，TUI 内不组装 profile 字段；凭据仍只以 `keyEnv` 名出现），`Enter` 从磁盘加载非敏感 profile 并恰发一次 `connections-add`（幂等 `unchanged` 按成功呈现）；`u` 编辑游标条目：草稿输入 `edit "/absolute/profile.json"`（同一显式磁盘文件形态），提交草稿仅武装显式确认步（沿 `b`/`d` 先例：确认前零请求，footer 提示 `update connection <id>? · return confirm · esc abandon`），再按 `Enter` 才从磁盘加载非敏感 profile——加载失败（`INVALID_PROFILE: …` 前缀）面板内逐字显示且保持武装，profile.id 与武装条目不一致在客户端即提示且零 wire 请求（较 web 表单 mismatch 口径为 TUI 特有收紧：web 提示后仍发送 PUT 并显示服务 400），一致则恰发一次 `connections-update`（幂等 `unchanged` 按成功呈现，成功后刷新列表即结果渲染）；`d` 对游标条目武装删除确认（沿 `b` 核对键位先例：确认前零请求，`return` 确认、`Esc` 放弃，确认后恰一次 `connections-remove`）。结构化错误码消息（`UNKNOWN_CONNECTION`/`CATALOG_BUSY`/`CONNECTION_CONFLICT`/`INVALID_PROFILE` 前缀形态与未启用的 not-enabled 提示、以及 add/edit 草稿磁盘加载失败的 `INVALID_PROFILE: …` 前缀形态）在面板内逐字显示，确认态保持武装供显式重试、连接不断开；武装的核对/删除/编辑确认三方互斥（后武装者解除前者，`return`/`Esc` 恒有唯一归属），开任何草稿（`n`/`a`/`u`）同样放弃全部武装确认。面板与证据面板互斥占用下部区域（后开者关闭前者）；在飞 add/update/remove 各以独立 revision 守卫沿同一先例（周期列表刷新永不丢弃在飞结果），面板关闭/`stop()` 经 revision 守卫丢弃迟到响应；在飞 `connections-update` 期间 `u` 键零状态零请求（与 `d` 键在飞守卫对称），edit 草稿提交的武装点同设在飞守卫（宿主把打开的草稿当自由文本，`n`/`a` 草稿可改写为 `edit …` 经前缀路由提交，路径真实可达），旧响应成功落地不再静默清除新武装、失败落地不再串显旧错误；add 失败保留草稿、edit/remove 失败保持武装供重试。连接面板为服务级视图，切换 Run 不清空。步骤、预算和 Git/worktree/diff 每轮完成后间隔 750ms 更新；断线显示上次观察，重连不派发。初始化失败可显示无 workspace 的 `initialization_pending`，未知副作用保持 blocked。

此处预算用量来自持久 budget ledger，未提供 Pi cache 细分。运行配置与数据边界见 [LOCAL_SERVICE](LOCAL_SERVICE.md)。
