# 本地服务与自动 Debug

## 数据与所有权

后台服务负责持有各 Run 的嵌入式 Pi Runtime；CLI/TUI 通过私有 Unix socket 通信。连接断开不等于取消。每个 Run 使用独立 worktree，原仓库不会自动 stage、commit 或 merge。

```text
dataRoot/
  loom.sock
  catalog.sqlite
  http-token
  runs/<runId>/
    request.json
    agent.sqlite
    agent.sqlite.budget.sqlite
```

`request.json` 保存显式 spec 和非敏感连接配置，凭据只保留 `keyEnv` 名称。`http-token` 仅在 `--http` 启动时生成：属主唯一、`0o600`，与 `loom.sock` 同属 dataRoot（目录本身 `0o700`）内的服务侧 owner-only 工件；客户端侧 `~/.loom` 存储规则见 [DEVELOPMENT](DEVELOPMENT.md)。Pi Run DB 是步骤、intent 和证据的事实来源；catalog 可删除后从 Run DB 重建，不能用 catalog 状态授权副作用。服务重启只重建观察，不自动重放未完成工作。未知操作必须先人工核对实际副作用；显式 resume 不能绕过它。

## 全树预算

Run spec 可声明 `budget: {"maxCalls":64,"maxTokens":1000000}`。预算在每次模型请求前持久接纳，涵盖 root、隔离 worker 的工具循环及压缩请求，不按角色各自重新计算。预算跨重开保持，不能通过省略参数或扩大配置重置。

调用次数在发出请求前占用；token 在取得完整 provider 报告后结算，包含 input、output、cacheRead 和 cacheWrite。累计报告 token 达限后拒绝下一次调用；单个已发请求仍可能越界。这不是金额预算或账单。未知在飞/中断的请求保留占用并阻止新调用，不把无报告当作零消耗；当前预算模式只接纳一个在飞模型请求。

未知预算占用提供显式人工核对解锁：`ModelBudget` 的 reconcile 语义把 unsettled 行标记为已核对——不再计入 `pending`（解除派发阻塞）、不补造 token 数字（无报告不当作零消耗）、调用计数保留（该请求可能已到达 endpoint），summary 与 RunSummary 的 `usage` 投影相应增报 `reconciled` 计数（加法字段，socket/HTTP 协议与既有字段语义零改动）。该计数现于服务 TUI 的 Usage 行与浏览器工作台 Run 详情的预算行渲染——与 `pending` 同级的账本事实分段，恒显示（0 也显示，可见性不随值漂移）；服务 TUI 现亦提供显式核对键位（`b`，见下），「先 web 后 TUI」两片先例的最后一片就此闭合。核对语义仍为两条路径，界面入口三处，语义完全一致（同一 lease → `<db>.budget.sqlite` → before/reconcile/after → release 模板，输出核对前后的账本摘要）：

- CLI 离线入口 `npm run dev -- feature --db PATH --reconcile-budget`（只需 `--db`，不解析连接、不读 spec、不派发任何模型工作；连接类旗标 `--model`/`--profile`/`--profile-id`/`--provider`/`--endpoint`/`--protocol`/`--key-env` 及成对的 `--catalog` 与之组合一律显式拒绝——裸 `--catalog` 由共享的成对约束先行拒绝，清单内不可达的 `--catalog` 条目已删除且拒绝行为逐字不变）。
- 服务侧写方法 `reconcile-budget`（ServiceRequest 带 runId 白名单的等价扩展，daemon 经既有 per-run 串行执行；HTTP 形态 `POST /runs/:runId/reconcile-budget`，仅 POST、token 门禁在前）。浏览器工作台 Run 详情在 `usage.pending>0` 且 Run 非 active 时提供「Reconcile budget」按钮（显式确认一步防误触），成功显示 before/after 摘要与「不采纳为成功、不证明未到达 endpoint」声明，结构化错误原样显示；服务 TUI 以同一 socket 方法提供 `b` 核对键位（门控、确认一步、摘要与错误口径与按钮完全一致，见「启动后台宿主与 TUI」节）。

这是服务进程对 Run 数据的首个受控写路径，边界扩展如实记录：写仅限 `<db>.budget.sqlite` 预算账本（经该 Run 的 database lease 串行取得），服务对 Run DB `agent.sqlite` 仍零写路径；理由是把核对并入服务存活期消除「记 `dataRoot/runs/<id>/agent.sqlite` 长路径 + 停服往返」的摩擦。核对仍要求该 Run 的数据库 lease 空闲：仍在持有该 Run Runtime 的进程（例如服务正在 dispatch 该 Run——在飞调用本身就是一条 pending 行，或另一个 CLI feature 进程在跑同一 `--db`）会让核对以 `DATABASE_IN_USE` 失败（服务侧把该结构化 code 前缀进错误消息原样透传，socket 与 HTTP 同一文案），不排队、不自动重试，不绕过单进程所有权——lease 是所有权的唯一裁判。对服务托管的 Run，推荐的不停服流程是：CLI `feature --reconcile` 清 workflow 操作（workflow 人工核对仍仅 CLI，本片不把 workflow 写路径搬进服务）→ 经工作台按钮、服务端点或服务 TUI `b` 键位核对预算账本 → 服务端显式 resume；停服务→CLI 离线核对→重启→显式 resume 的离线流程仍完整可用。已失败/阻塞的 Run 在其 run() 结束后 runner 已关闭、lease 已释放，服务进程本身不持有各 Run 的账本，此时服务存活期核对可合法成功。CLI 侧打开服务托管的 Run（`--inspect`/`--reconcile` 清操作）须以与服务 start 完全一致的 profile id 经 `--profile`/`--profile-id` 进行（Pi provider 会话标识 `loom:<id>` 参与重开校验），spec 文件直接回读 `dataRoot/runs/<runId>/request.json` 的 `.spec`（持久化 spec 为规范化定序形态，自写 JSON 键序不同会被严格比较拒绝）；Run 连接身份推导已在 CLI 与服务间统一（固定七键序的完整 SHA-256，排除 catalog 条目 `id`），该停服→核对→重启→resume 流程已由真实服务进程的集成测试端到端钉住。核对解锁与 `feature --reconcile` 哲学同构：它只解除预算阻塞，不把该调用采纳为成功，也不证明其未到达 endpoint；账本无 unsettled 行时核对明确报错而非静默成功。一次性迁移如实记录：身份推导统一前遗留的本机 Run DB（旧 CLI 24hex 前缀或旧服务含 id 的 64hex）不再匹配新身份，重开以 `Run connection differs from its persisted runtime` 拒绝。

## 自动 Debug 输入

继续使用现有 durable driver，spec 设置 `workflow: "debug"`，显式提供原故障复现 `reproduce`、根因假设检查 `hypothesis` 和完整 `regression` argv。命令由宿主执行，模型只提供领域分析和修复，不能自报可信验证。

```json
{
  "runId": "debug-001",
  "workflow": "debug",
  "goal": "修复明确描述的故障",
  "repositoryPath": "/absolute/project",
  "baseCommit": "完整 commit SHA",
  "worktreePath": "/absolute/debug-worktree",
  "reproduce": ["npm", "test", "--", "bug.test.ts"],
  "hypothesis": ["node", "scripts/check-cause.js"],
  "regression": ["npm", "test"],
  "budget": {"maxCalls":64,"maxTokens":1000000}
}
```

```sh
npm run dev -- debug --spec /absolute/debug.json --db /absolute/run/agent.sqlite --profile /absolute/profile.json
```

原复现必须正常退出且非零；通过、spawn 失败、信号中断、超时或运行时修改源文件都不能算已复现。`hypothesis` 成功表示显式根因检查通过。fix 后重跑原复现和回归，要求零退出，再做独立 review 与交付。历史诊断保留进度，旧内容的验证、审查和交付证据失效。验证失败和审查拒绝各最多返工两次；未知副作用不自动重试。

## 验收边界

本地 fixture 仅验证 Pi 协议接线与控制流，真实 Git/worktree、命令退出码、内容指纹和持久化各由宿主采集。真实模型 endpoint、工具流、断流恢复、缓存命中率和真实模型 TTY 仍需独立验收；不因服务或界面可运行而关闭这些缺口。cwd 和角色工具权限不构成 OS 沙箱。

## 启动后台宿主与 TUI

在两个终端分别运行（要求 Node 24）：

```sh
npm run service -- --data-root /absolute/loom-data
npm run service:tui -- --data-root /absolute/loom-data
# 无交互快照，不打开 Runtime，也不调用模型：
npm run service:tui -- --data-root /absolute/loom-data --once
```

服务在自己的终端持续运行；也可由用户进程管理器托管，当前不安装系统启动项。TUI 按 `n` 输入 `start "/absolute/spec.json" "/absolute/profile.json"`，显式发送新 Run。`x` 取消选中 Run，`p` 恢复；`q` 只断开界面。相同 runId/spec/profile 重复 start 只确认已有任务，不隐式恢复。初始化尚未完成的任务显示 `initialization_pending`，可显式 resume 再试；已有 worktree/DB 永久绑定仍会阻止绕过未知副作用。对 completed/cancelled 终态再次 cancel 为 no-op，不重开 Runtime。初始化未完成的取消仍需打开 Runtime，缺少连接配置/凭据时可能失败；不会因此自动派发工作。`c` 切换连接面板（见下），服务须以 `--catalog DIR` 启动才有可用条目。

界面每轮完成后间隔 750ms 更新 Run、步骤、预算及真实 Git/worktree/diff；`Tab` 切换 Run/步骤/Git，`g` 切换 Git 内面板，`s` 查看 staged/working，`j/k` 选择或滚动，`e` 切换只读证据面板。证据面板与 HTTP `GET /runs/:runId/evidence` 消费同一 socket `evidence` 投影，按条目列出 `id/stepId/kind/attempt/valid` 与类型详情（command 的命令与退出码、review 的审查者与未解决项、artifact 的生产者），与浏览器工作台 evidence 视图同一信息集。面板内 `j/k`（及 ↑/↓/PgUp/PgDn）移动选中游标（带 `›` 标记）——游标在可见窗口内自由移动，触及窗口边缘后窗口随游标滚动一行（窗口跟随游标，`›` 标记恒随游标），游标钳制于末条不越界，切换 Run 或重开面板复位到首条；选中 artifact 条目按 `Enter` 经同一 socket `artifact` 方法按需拉取一次正文并进入正文视图（再按 `Enter` 关闭），已加载正文在收起/展开间缓存不重复请求，头部如实渲染完整 `byteLength` 与 `truncated` 徽标（截断语义与 HTTP 端点完全一致：64KiB 读侧截断 + 内嵌标记），正文逐行经既有终端清洁器与窄屏拟合；结构化错误（如 `Unknown evidence id`）只在面板内降级提示并可重试，迟到/换 Run 响应经独立 revision 守卫永不落地；command/review 条目无查看入口（与浏览器工作台一致）。面板打开期间 evidence 请求才随刷新发出（面板关闭时零 evidence 流量），拉取受 revision 守卫——切换 Run 后旧响应不落地；拉取失败只在面板内降级提示，不占用全局 notice、不影响 Run 列表/详情刷新。面板打开时加入 `Tab` 焦点轮换。断线保留上次观察并标明不可用，重连不派发任务。服务界面中的 usage 来自持久预算账本，不等于 Pi cache token 细分；原 Runtime TUI 仍提供 cache 统计。Usage 行的 `pending`/`reconciled` 为同级账本事实分段恒显示（0 也显示；`reconciled` 即「全树预算」节人工核对解锁留下的已核对计数）。

预算核对键位 `b`：选中 Run 满足 `usage.pending>0` 且非 active（active 的 Run 不提供入口——dispatch 中在飞调用本身就是一条 pending 行且 lease 被持，请求必然失败关闭）时，`b` 进入显式确认一步（确认前零请求，footer 提示 `return confirm · esc abandon`，`Esc` 放弃同样零请求），再按 `Enter` 经既有 socket `reconcile-budget` 方法恰发一次请求；成功在状态列渲染 before/after 账本摘要（`Reconciled: pending X → Y · reconciled A → B`）与「不采纳为成功、不补造 token、不证明未到达 endpoint」声明（与工作台按钮同一口径），并随刷新更新 Usage 行。结构化错误（含服务侧前缀透传的 `DATABASE_IN_USE: …` 消息）原样显示于状态列（长消息按终端宽度截断，与其它服务侧字符串同一拟合规则，完整消息保持在界面状态里），连接不断开、确认步保持武装——`Enter` 显式重试、`Esc` 放弃，不排队、不自动重试（lease 是所有权的唯一裁判）。核对摘要与确认态以 revision 守卫键连到所属 Run：换 Run、start 接受新 runId 或列表刷新后 Run 消失即清空，迟到响应不落地；落地摘要与结构化错误行均以 runId 守卫渲染（错误落地时同样记录所属 Run），永不为另一 Run 显示。`b` 在 Git 面板焦点下同样可达；确认态不是输入草稿，武装期间其余键位照常工作（`Enter` 被确认占用、`Esc` 放弃），但开草稿（`n`/`a`）即放弃武装——草稿打开期间 footer 确认提示被隐藏、草稿的 `Enter` 是提交键，隐藏的武装写状态不留存；放弃只清确认态，落地摘要与在飞响应不受影响（迟到响应仍为其所属 Run 落地）。workflow operation 人工核对（`--inspect`/`--reconcile`）仍仅 CLI，键位只核对预算账本（见「全树预算」节）。

连接面板键位 `c`/`a`/`u`/`d`：`c` 开关只读连接面板（与证据面板互斥占用下部区域，后开者关闭前者），服务以 `--catalog DIR` 启动时面板可见期间随 750ms 刷新经既有 socket `connections` 方法拉取列表（面板关闭零连接流量），`j/k` 游标导航沿证据面板同一窗口跟随先例；未启用（或拉取失败）时面板内原样显示结构化提示（如 `Connection catalog is not enabled; start the service with --catalog DIR`），管理键位零请求——门控与 web 表单 `catalogEnabled` 同构：仅上一次 `connections` 拉取成功后 `a`/`u`/`d` 才生效，不匹配错误文案（面板关闭或门控关闭时三键均为零状态零请求 no-op；`u`/`d` 另要求游标条目存在——空列表无条目可编辑/可删，同样零状态零请求；`a` 的门控不要求条目存在，空列表+门控开时仍开 `add ` 草稿——零请求但有状态变化，非 no-op）。`a` 经共享草稿机制输入 `add "/absolute/profile.json"`（profile 来源是磁盘文件路径，TUI 内不组装 profile 字段，凭据仍只以 `keyEnv` 名出现），`Enter` 从磁盘加载非敏感 profile 后恰发一次 `connections-add`（幂等 `unchanged` 按成功呈现，与工作台「Save profile to catalog」按钮同一写路径）；`u` 编辑游标条目：经共享草稿机制输入 `edit "/absolute/profile.json"`（同一显式磁盘文件形态），`Enter` 提交草稿仅对游标条目武装显式确认步（沿 `b`/`d` 先例：确认前零请求，footer 提示 `update connection <id>? · return confirm · esc abandon`），再按 `Enter` 才从磁盘加载非敏感 profile——加载失败（`INVALID_PROFILE: …` 前缀形态）面板内逐字显示且确认态保持武装；profile.id 与武装条目不一致在客户端即面板内提示且零 wire 请求（较 web 表单的 mismatch 口径为 TUI 特有收紧：web 表单提示后仍发送 PUT 并显示服务 400，TUI 直接拦下不发）；一致则恰发一次 `connections-update`（幂等 `unchanged` 按成功呈现，与工作台「Update selected connection」按钮同一写路径），成功后刷新列表即结果渲染；`d` 对游标条目武装删除确认（沿 `b` 键先例：确认前零请求，`return` 确认、`Esc` 放弃，确认后恰一次 `connections-remove`，与工作台条目删除按钮同一写路径）。结构化错误码消息（`UNKNOWN_CONNECTION`/`CATALOG_BUSY`/`CONNECTION_CONFLICT`/`INVALID_PROFILE` 前缀形态、未启用的 not-enabled 提示，以及 add/edit 草稿磁盘加载失败在客户端即以前缀形态呈现的 `INVALID_PROFILE: …`）在面板内逐字显示，确认态保持武装供显式重试、连接不断开，add 失败保留草稿供编辑重试；武装核对、武装删除与武装编辑三方互斥（后武装者解除前者，`return`/`Esc` 恒有唯一归属），开任何草稿（`n`/`a`/`u`）同样放弃全部武装确认。在飞 update 以独立 revision 守卫沿 remove 复审先例（周期列表刷新永不丢弃在飞结果，成功与结构化错误均落地），且在飞 `connections-update` 期间 `u` 键为零状态零请求 no-op（与 `d` 键在飞 remove 守卫对称）、edit 草稿提交的武装点同设在飞守卫（宿主把打开的草稿当自由文本——任意可打印字符追加、退格删改，`n`/`a` 草稿可改写为 `edit …` 经前缀路由提交，该路径真实可达）——两道守卫合围使在飞期间无法重新开 edit 草稿/重新武装，旧响应成功落地不再静默清除新武装、失败落地不再串显旧错误（被拦截的草稿提交零状态变化、草稿保留，待在飞结束后可重新提交）；面板关闭或 TUI 停止（`q`/Ctrl-C 断开）经 revision 守卫丢弃迟到响应；连接面板为服务级视图，切换 Run 不清空。footer 键位行已加入 `c conns`/`u edit` 并重压缩至 120 列全键位可见。

## HTTP API 投影（M4 工作台后端）

加 `--http` 启动时，服务在同一 dataRoot 上额外开启一个只绑定 `127.0.0.1` 的 HTTP 投影；不加 `--http` 时行为与原服务完全一致，socket 协议、ServiceClient 与服务 TUI 均不变：

```sh
npm run service -- --data-root /absolute/loom-data --http
# stdout 追加一行（示例）：
# Loom service HTTP: http://127.0.0.1:54321 (token file: /absolute/loom-data/http-token)
```

端口为临时端口（每次启动变化，不与同机其他 dataRoot 实例冲突），由 stdout 公布；bearer token 每次启动重新随机生成，只写入 `dataRoot/http-token`（owner-only），stdout 只公布文件路径、不打印 token 值。所有端点都要求 `Authorization: Bearer <token>`，无或错误 token 一律 401，响应体不含任何 Run 数据：

- `GET /runs`：RunSummary 数组，与 socket `list` 同一投影、同一内容。
- `GET /connections`（opt-in，需以 `--catalog DIR` 启动）：只读连接 catalog 投影。返回 `result` 为非敏感 `ProviderProfile` 数组，与 socket `connections` 方法及 CLI `connections list` 同一排序源；条目复用同一套 owner-only/`O_NOFOLLOW` 存储校验与 `parseProviderProfile` 非敏感字段校验，凭据仍只以 `keyEnv` 环境变量名出现。契约要点：token 门禁在前（无/错 token 一律 401）；未启用 `--catalog` 时返回 400 结构化错误 `{ok:false,error:"Connection catalog is not enabled; start the service with --catalog DIR"}`（路由存在、能力未启用，不静默空列表）；读取按请求惰性求值——`open` 不校验目录，无效路径不阻止服务启动，既有 `STORAGE_INVALID`/`UNSAFE_STORAGE` 错误消息原样透传（400）；目录缺失返回 400 `Connection catalog directory does not exist: <path>`——只读投影绝不创建目录，这点与 CLI `connections list` 会在缺目录时创建 owner-only 存储不同（有意差异，避免 GET 产生文件系统副作用）。该保证是结构性的：读取走 `ConnectionCatalog.listReadOnly()` 只读加载路径（以 owner-only 校验就地检查目录、缺失抛 `STORAGE_INVALID`「does not exist」结构化错误，全程无 mkdir），即使目录在服务预检之后、读取之前被外部删除（竞态窗口），也只会得到同一「does not exist」结构化错误而非重建目录；未知子路由（如 `/connections/x`）404；静态资产永不遮蔽 `/connections` 及其子路径。写管理见下方三个写端点。
- `POST /connections`（opt-in，同一 `--catalog DIR`）：连接条目写管理之一。body 为一个非敏感 profile JSON 对象（字段规则完全由服务端 `parseProviderProfile` 判定，与 `POST /runs` 的 body 读取/排水/超时/128KB 上限同一先例）：复用 CLI `connections add` 的同一 `ConnectionCatalog.add` 写路径——幂等 add（同 id 同配置返回 `unchanged` 确认）、同 id 不同配置拒绝、跨实例锁、`O_EXCL` 临时文件 fsync 后 rename 原子写、`parseProviderProfile` 构造性非敏感保证（明文凭据/未知字段拒绝入库）、目录缺失时按需递归创建 owner-only 存储（与读路径的结构性无 mkdir 是有意分叉，写路径即 CLI 行为）。响应 `result` 为 `{id, status:"added"|"unchanged"}`。结构化错误以「code 前缀消息」原样透传（400）：`CONNECTION_CONFLICT: Connection "…" already exists with different settings; remove it first or use a new id.`、`INVALID_PROFILE: Invalid provider profile: …`、`CATALOG_BUSY: Connection catalog is locked; …`、`STORAGE_INVALID`/`UNSAFE_STORAGE`、以及未启用的 not-enabled 错误——前缀接线与 `reconcile-budget` 的 `DATABASE_IN_USE` 同一先例（socket/HTTP 错误通道只携带 message 字符串）。畸形 JSON body 为 HTTP 层 400 `Invalid JSON body`，非对象 body 为 400 `Connection body requires a profile object`。
- `DELETE /connections/:id`（opt-in，同一 `--catalog DIR`）：连接条目写管理之二。id 为单个 URL path segment、经百分号解码后必须为非空字符串（无法解码为 400 `Invalid connection id`）；**刻意不做 run-id 式 pattern 校验**——`parseProviderProfile` 对 id 只要求非空字符串，CLI 可存任意字符 id（含点/空格/Unicode/斜杠的 id 经 `%2F` 等编码形态可达），收紧形状会让 CLI 创建的合法条目在 HTTP 侧不可删，与服务/CLI 同一写路径的口径分叉。复用 CLI `connections remove` 的同一 `ConnectionCatalog.remove` 写路径（同锁、同原子写）。响应 `result` 为 `{id, status:"removed"}`；未知 id 为 400 `UNKNOWN_CONNECTION: Unknown connection id: <id>. Run connections list to inspect the catalog.`（只有 `Unknown Run` 映射 404）；子路由与其余动词 404；DELETE 携带的 body 同样被排水并施加超时/上限。
- `PUT /connections/:id`（opt-in，同一 `--catalog DIR`）：连接条目写管理之三——显式更新（edit 的落地形态）。id segment 契约与 `DELETE` 完全同一（单 path segment、百分号解码后非空、刻意不做 run-id 式 pattern，CLI 可存的任意字符 id 保持可更新，斜杠经 `%2F` 编码形态可达）；body 为一个非敏感 profile JSON 对象，其 `id` 必须与 path id 一致——不一致为 HTTP 层 400 `Connection body id must match the path id`（更新是显式的同 id 字段替换，绝不隐式改名或 upsert）。复用 CLI `connections edit` 的同一 `ConnectionCatalog.update` 写路径（同锁、同原子写、同 `parseProviderProfile` 非敏感构造）：未知 id 为 400 `UNKNOWN_CONNECTION: Unknown connection id: <id>. Run connections list to inspect the catalog.`（不静默创建）；canonical 完全相同为幂等 `unchanged` 且零写盘（不重写文件）；字段不同则替换同 id 条目返回 `updated`。响应 `result` 为 `{id, status:"updated"|"unchanged"}`；`add` 的 `CONNECTION_CONFLICT` 语义与文案零改动（`POST /connections` 仍拒绝同 id 变更）。畸形 body 的三种 400（`Invalid JSON body`/`Connection body requires a profile object`/`INVALID_PROFILE: …` 前缀）与 POST 同一形态；子路由与其余动词 404；PUT 携带的 body 同样受读取/超时/上限约束。
- `GET /runs/:runId`：单个 RunSummary；未知 runId 返回 404。
- `POST /runs`：body `{"spec":…,"profile":…}`，透传 start。同身份重复 start 只做幂等确认，同 runId 不同 spec/profile 以结构化错误拒绝，与 socket 语义完全一致。
- `POST /runs/:runId/cancel`、`POST /runs/:runId/resume`：透传取消/恢复；终态 cancel no-op、cancelled 不可 resume、blocked/未知操作的 resume 错误以 `{ok:false,error}` 原样透传，不做任何放宽。
- `POST /runs/:runId/reconcile-budget`：透传预算账本人工核对（socket `reconcile-budget` 写方法的 HTTP 形态，仅 POST、GET 落 404）。语义与 CLI 离线入口完全一致：lease → `<db>.budget.sqlite` → before/reconcile/after → release，响应 `result` 为 `{database, before, after}` 账本摘要；服务 dispatch 中该 Run（lease 被持）失败关闭，结构化 `DATABASE_IN_USE: …` 前缀消息原样透传（400）；账本无 unsettled 行明确报错；未知 runId 404。详见「全树预算」节。
- `GET /runs/:runId/diff`：只读 diff 投影。响应 `result` 为单个聚合对象 `{root, observedAt, files, diffs, truncatedFiles}`：`files` 是 run worktree 的改动文件元数据（与 TUI 文件面板同一 `readGitSnapshot` 来源），`diffs` 按文件与层逐一给出 `{path, originalPath?, mode:"working"|"staged", text}`——每个文件每层恰好一条，untracked 只在 working 层，staged-only 文件不含 working 条目（反之亦然）。每条 `text` 复用 `readGitDiff` 的 64KiB 预览截断（截断时文本内嵌 `… preview truncated (64 KiB)` 标记），聚合响应另以上限 50 个文件封顶，超出时 `truncatedFiles:true`；不承诺无界响应，文件级查看与完整文件索引经下方 `diff/file`、`diff/files` 端点（单条文本仍受同一 64KiB 截断约束）。观察不隐含所有权：不 stage、不 commit、不修改 worktree。未知 runId 404；`initialization_pending`（workspace 尚未绑定）或 Git 观察失败返回 400 结构化错误。
- `GET /runs/:runId/diff/file?path=&mode=working|staged`：单文件单层只读 diff。响应 `result` 为 `{root, observedAt, path, originalPath?, mode, text}`——与聚合端点同一 `readGitSnapshot` 观察、同一 `readGitDiff` 文本与 64KiB 截断标记，与聚合对应条目同源同义。`path` 必须命中当前快照的改动文件，`mode` 必须是该文件实际存在的层（untracked 仅 working；staged-only 文件无 working 层，反之亦然）；未知 path、非法 mode、层不适用、缺 `path`/`mode` 参数分别为 400 结构化错误（`Unknown diff file path` / `Invalid diff file mode` / `Diff mode does not apply to this file` / `diff file query requires path and mode`）。不承诺完整 diff 文本。
- `GET /runs/:runId/diff/files?after=&limit=`：分页返回完整改动文件索引（只解决 >50 文件在聚合中被截断的可见性，不解决全量文本）。契约：顺序与聚合 `files` 完全一致（同一 `git status --porcelain=v2` 输出序）；`after` 为上一页末条目的 `path`（快照内排他游标，不在当前快照中返回 400 `Unknown diff files cursor`，客户端应从首页重取；`after` 恰为末条目时返回空页）；`limit` 缺省 50、HTTP query 必须为纯十进制整数字面量且数值为 1–200（`5e1`、`0x10`、带符号 `+5`/`%2B5`、带空格 `%205`、空串等非纯十进制形态一律 400 `Invalid diff files limit`，不做 `Number()` 宽松解析；socket 直连的数字 limit 仍由服务层同一 1–200 边界校验把关）。响应 `result` 为 `{root, observedAt, total, files, nextAfter}`：`total` 为当前快照改动文件总数，`nextAfter` 为下一页游标（还有后续页时为当前页末条目的 `path`，否则 `null`）。未知 runId 404；pending run 与 Git 观察失败 400 结构化错误，与聚合 diff 相同。
- `GET /runs/:runId/evidence`：只读证据投影。以 SQLite `readOnly` 连接直读 Run DB（与 catalog 重建同一 `FeatureStore.inspectDatabase` 路径），返回 `Evidence[]`，字段只含用户 spec 与宿主采集的命令/指纹/路径信息，不含任何凭据。未知 runId 404；`agent.sqlite` 缺失或文档未初始化（`initialization_pending` 语义）返回 400 结构化错误。
- `GET /runs/:runId/artifact?evidence=<evidenceId>`：单条证据的 artifact 正文只读投影。与 `evidence` 端点同一 SQLite `readOnly` 连接、同一 `FeatureStore.inspectDatabase` 快照（列表与正文视图永远取自同一持久化状态），从快照 `state.artifacts` 取回正文，不触碰写路径。契约：只解析 `pi:feature/<id>` 引用且 `<id>` 必须与该证据条目的 `id` 一致、且必须在同快照中存在对应 artifact 正文——写入侧（`feature.ts`）在同一 store 更新内同时落 `{id,stepId,body}` 与证据（`id` 即 `randomUUID()` 操作 id），其他前缀、id 不一致、正文缺失均不猜测，一律 400 结构化错误（`Unsupported artifact reference` / `Artifact reference does not match evidence id` / `Artifact body missing from Run state`；未知 `evidenceId` 为 `Unknown evidence id`，空/非字符串值为 `Invalid artifact evidence id`，缺 `evidence` 参数为 HTTP 层 `artifact query requires evidence`——均 400）。响应 `result` 为 `{text, truncated, byteLength}`：`text` 受读侧防御性 64KiB 截断，截断时内嵌与 diff 投影同一措辞的 `… preview truncated (64 KiB)` 标记且 `truncated:true`；`byteLength` 恒为持久化正文的完整字节数（截断时大于 `text` 长度）。截断语义按真实可达口径理解：写入侧仅 worker 报告有 64KiB 上限（超出即拒绝写入），command 证据正文（collectCommand 输出 JSON）与 deliver 清单（内嵌完整 git diff）写入侧上限为 1MiB，对它们读侧 64KiB 截断是唯一统一边界、`truncated:true` 是真实可达状态而非纯防御分支。不做 MIME 推断、语法高亮、虚拟滚动或大 artifact 分页，不承诺完整正文。未知 runId 404；pending run 与 `evidence` 端点同一 400 结构化错误。
- `GET /events`：SSE 快照流。连接即发送初始 runs 快照，此后快照变化时推送新快照；实现为 750ms 非重叠快照轮询加整体 diff（与 TUI 刷新节奏一致），因此步骤落盘、状态与预算变化都会投影，但它是 RunSummary 快照投影，不是细粒度事件总线。

HTTP 层不新增任何语义：所有动作严格经 `LoomService.request` 透传，幂等 start、blocked resume、终态 cancel no-op 等门禁照旧；diff/evidence/artifact/diff-file/diff-files/connections 是 ServiceRequest 新增的只读方法，reconcile-budget 与 connections-add/connections-update/connections-remove 是 cancel/resume 之外新增的写动作，同样经 `LoomService.request` 透传——runId 方法共用同一入口守卫（runId 正则与守卫强度不变，白名单等价扩展），`connections`/`connections-add`/`connections-update`/`connections-remove` 为无 runId 的方法（与 `list` 同层，不触碰 runId 白名单）——不改 start/list/status/cancel/resume 语义，ServiceClient 与服务 TUI 不强制使用（服务 TUI 现以 `e` 证据面板消费 evidence 与 artifact 正文两个只读方法，与 HTTP 工作台同一投影；diff/diff-file/diff-files 仍由 HTTP 工作台消费，服务 TUI 的 Git/diff 面板走自身 worktree 观察器而非 socket diff 方法；连接面板 `c`/`a`/`u`/`d` 键位现消费 connections/connections-add/connections-update/connections-remove 四个方法（TUI edit 键位已随 2026-10-27 第二片落地，见「启动后台宿主与 TUI」节），与 HTTP 工作台增删/更新入口同一写路径与门控口径）。服务错误统一以 `{ok:false,error:"…"}` 结构化返回（未知 runId 为 404，其余为 400）；畸形 JSON body 返回 400，超过 128KB 的 body 拒绝（413），未知路由 404。请求 body 读取带 5 秒空闲超时：半发 body 停摆的连接收到 408 后被终止，客户端中断 body 时请求以 400 明确终止，均不再静默挂到 socket 死亡或 Node 默认 300 秒 requestTimeout。服务关闭（含 SIGTERM）时 `http-token` 文件随投影一起删除，与 `loom.sock` 的清理对称；投影单独 close 同样删除。

边界：仅绑定 loopback，不做 CORS，按同机本地工具对待；loopback 加 token 不构成公网安全边界，token 文件防的是同机其他本地用户，不是网络攻击者。

### `--catalog` 旗标语义（与 CLI 同名、语义不同）

服务入口的 `--catalog DIR` 是独立的 opt-in 启用旗标：加上后 `GET /connections`、`POST /connections`、`PUT /connections/:id`、`DELETE /connections/:id`（与 socket `connections`/`connections-add`/`connections-update`/`connections-remove` 方法）可用，指向的目录即连接 catalog 目录（目录内仍为 `connections.json`）。这与 CLI 中同名旗标语义不同——CLI runtime 命令里 `--catalog` 仅与 `--profile-id` 成对有效、单独出现即拒绝（见 [DEVELOPMENT](DEVELOPMENT.md)），`connections` 子命令则把它当作目录覆盖。服务侧访问 catalog 是有意的边界扩展，且分两层如实记录：

- **读取**（原扩展）：连接 catalog 原属客户端侧 `~/.loom` 存储，浏览器不可读；允许同机同用户的服务进程按只读契约读取，供工作台选择器预填表单。目录必须已存在且通过 owner-only 校验（缺失/越权为 400 结构化错误），读取路径结构性不含 mkdir（`listReadOnly()` 只读加载），目录在读取瞬间缺失同样返回「does not exist」结构化错误而不会重建。目录缺失与路径非目录两处 stat 预检文案均使用 `resolve()` 后的绝对路径拼写，与 `listReadOnly()` 竞态文案一致——`--catalog` 传相对路径（相对 `process.cwd()`）或含 `..` 的形态时，同一故障呈现的仍是同一绝对路径。
- **写入**（本片新增的显式论证边界修订，先例为 `reconcile-budget` 服务写 `<db>.budget.sqlite`）：同一 opt-in 旗标下允许 `connections-add`/`connections-update`/`connections-remove` 三个写方法，理由是写路径与 CLI 完全同一（`ConnectionCatalog.add/update/remove`：mkdir owner-only、跨实例锁、原子写、幂等 add、显式 update——未知 id 报 `UNKNOWN_CONNECTION` 不 upsert、canonical 相同幂等 `unchanged` 且零写盘、add 的同 id 变更拒绝）、构造性非敏感（`parseProviderProfile` 拒绝明文凭据与未知字段，凭据仍只以 `keyEnv` 名出现）、且门禁不弱于任何动作端点（loopback + bearer token，同机同用户前提）。读路径的无 mkdir 结构保证 **零回退**：写入按需创建 owner-only 目录即 CLI `connections add` 的既有行为，读方法仍走 `listReadOnly()`（用例 tests/service.test.ts 钉住）。与 CLI 的唯一差异是入口形态（HTTP/工作台 vs 子命令），存储语义零分叉；add 的同 id 变更仍拒绝（edit 是新的显式 `update` 写路径，不是对 add 冲突语义的放宽）。

## 浏览器工作台（M4 工作台前端）

`web/` 目录的 React + Vite 最小工作台消费上述 HTTP 投影，由服务自身同源提供，无需额外端口：

```sh
npm run build          # 产出 web/dist（tsc 构建 + vite build）
npm run service -- --data-root /absolute/loom-data --http
# stdout 公布 http://127.0.0.1:PORT 后，浏览器打开该地址
```

- 打开页面后输入 stdout 公布的服务地址与 bearer token（读 `dataRoot/http-token` 文件内容，stdout 只公布路径）；token 仅存浏览器 sessionStorage——同一 tab 内刷新可恢复连接与所选 Run 视图；关闭 tab 后即随会话销毁，重开需重新粘贴 token，不写 localStorage、不出现在日志。
- Run 列表经 `/events` SSE 快照流实时整帧更新：连接状态显示 live / reconnecting / connecting，断流后自动重连（约 1 秒退避）；重连不承诺补发断线期间的事件，以最新快照为准（服务端本为 750ms 快照轮询）。SSE 客户端用 fetch 流实现，因为 EventSource 无法携带 Authorization 头，且不为 `/events` 增加替代认证形态。
- Run 详情显示状态/步骤/预算与用量/阻塞原因/未知操作 ID（预算行把 `pending` 与 `reconciled` 渲染为同级账本事实分段，恒显示、0 也显示；`reconciled` 来自人工核对解锁）；`usage.pending>0` 且 Run 非 active 时出现「Reconcile budget」按钮——显式确认一步（确认前零请求，可「Keep pending」放弃），确认后发一次 `POST /runs/:runId/reconcile-budget`，成功渲染 before/after 摘要与「不采纳为成功、不补造 token、不证明未到达 endpoint」声明，结构化错误（如 `DATABASE_IN_USE: …`）原样显示并保留重试；active 的 Run 不出现按钮（服务 dispatch 中 lease 被持，请求必然失败关闭）；`Cancel`/`Resume` 透传动作端点，服务端结构化错误（如 "Cannot resume cancelled Run"）原样显示；diff 面板按每文件每层渲染，64KiB 截断与 50 文件封顶如实标注，并可按需加载完整改动文件索引（`diff/files` 分页，`nextAfter` 续页直至 `null`，突破 50 文件封顶获得全部改动文件可见性；游标失效的 400 结构化错误原样显示，可从首页重取，不自动静默重试），索引中任意文件可按需查看单文件单层 diff（`diff/file`，`path` 经 URL 编码、`mode` 为 working|staged，64KiB 截断与结构化错误同样原样显示）；evidence 面板只读列出 Run DB 证据，artifact 条目可按需查看正文（`artifact` 端点，`evidence` 参数经 URL 编码，点击才拉取一次、已加载正文在收起/展开间缓存不重复请求，`truncated` 徽标与 `byteLength` 如实显示，结构化错误原样显示、可收起后显式重试；command/review 条目无查看入口）。
- Start 派发表单（第二片）：`Start run…` 打开表单，在浏览器内组装 FeatureSpec（runId、goal、repositoryPath、baseCommit、worktreePath、workflow feature|debug 切换、可选 budget，feature 为 targeted/regression，debug 为 reproduce/hypothesis/regression）与非敏感 ProviderProfile（仅允许字段 id/kind/protocol/modelId/baseUrl/keyEnv/contextWindow/maxTokens；凭据不在表单出现，仍由 keyEnv 指向的服务侧环境变量提供），经既有 `POST /runs` 纯透传派发并显示结构化结果；argv 数组按每行一个参数输入（空行丢弃、行内空格保留），该契约由组件测试钉死。本地校验只拦空必填与 runId 形状，其余规则（spec 合法性、profile 字段集、同 runId 幂等/冲突）由服务端判定，结构化错误（如 "Invalid feature spec"、"Run request differs from persisted configuration"）以 400 原样显示；幂等重复 start 的确认响应按成功呈现。repositoryPath/baseCommit/worktreePath 为手填字段，不做仓库信息自动推导端点。
- 连接选择器与连接管理：表单打开时探测一次 `GET /connections`——服务以 `--catalog DIR` 启动且有条目时，下拉按 `id (modelId)` 列出条目，选中即预填全部 profile 字段（id/kind/protocol/modelId/baseUrl/keyEnv/contextWindow/maxTokens），字段仍可手工修改，修改值如实进入派发 body；未启用、加载失败或空列表时下拉不出现，保持纯手工路径（提示文案说明无可用条目）。选择器只填充表单状态：`POST /runs` body 仍由表单字段组装并纯透传，不新增派发语义。同一 opt-in 下表单提供连接写管理：「Save profile to catalog」以当前表单字段组装的同一 profile 恰发一次 `POST /connections`（与派发共用同一字段组装；重复保存同一配置得到幂等 `unchanged` 确认，同样按成功呈现）；「Update selected connection」对下拉最近选中（且仍存在于列表）的条目以表单当前字段恰发一次 `PUT /connections/:id`（URL 为选中条目 id、body 为表单组装 profile——选中即预填全部字段，改字段后即是同 id 显式更新；若把 Profile id 改得与选中条目不一致，表单内先出现提示且服务的结构化 400 原样显示，须换 id 另存或先删后增；幂等 `unchanged` 按成功呈现；未选中条目时入口禁用）；条目列表中每项「Remove…」按钮走显式确认一步（确认前零请求、可取消，沿「Reconcile budget」按钮先例），确认后恰发一次 `DELETE /connections/:id`（id 经 URL 编码）。成功后重读 `GET /connections` 刷新选择器列表（新条目即出现在下拉），结构化错误（`CONNECTION_CONFLICT`/`UNKNOWN_CONNECTION`/`CATALOG_BUSY`/`INVALID_PROFILE` 前缀消息与未启用 not-enabled 错误）原样显示；未启用 `--catalog` 时整个管理 UI 不出现。手工编辑的 catalog 条目若携带 union 外的 kind/protocol 或非正数/非整数数值（服务端 `parseProviderProfile` 校验必填字符串非空、可选字段类型——baseUrl/keyEnv 为字符串、contextWindow/maxTokens 为 number——并拒绝未知字段，但不校验 kind/protocol 的 union 成员与数值的正数/整数性），受控下拉可能显示为空、数值字段会被表单本地校验拦下，最终降级为服务端结构化错误显示，不产生错误数据。
- 静态资产不含任何 Run 数据、不经过 token 门禁（缺失文件与数据端点的 401/404 行为与无工作台时完全一致）；页面路由只用 hash（`#/runs/:id`），不占用服务的 URL path 空间。

边界：派发能力已进入工作台，但不以本片声称 M4「用户可从同一入口完成两种任务」验收完成——真实模型闭环、真实仓库上的 bug 修复前后行为仍缺（表单派发的任务在真实模型 endpoint 下未验收）；连接管理 UI 已交付增删改三动作（服务 `--catalog` opt-in 下的写端点 + 工作台入口；服务 TUI `c` 面板有 `a` 增/`u` 改/`d` 删键位——「先 web 后 TUI」的 TUI 侧缺口已闭合），但 **全局/项目默认自动选择未实现**，M3「连接管理 UI」不含该项；真实 entry 下成功 cancel 仍需 fixture runtime 注入（见 IMPLEMENTATION 冒烟记录），冒烟不冒充。`web/dist` 是构建产物不入库，服务未找到该目录时 HTTP 投影行为与之前完全一致。
