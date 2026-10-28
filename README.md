# Loom · 织机

把架构、实现、Debug 与验证织成一条可持续的开发流程。

## 项目目标

建立一个本地优先的 Agent 开发工作台：用户选择仓库、描述目标，Loom 在同一个入口完成规划、代码修改、验证、审查和交付准备，持续保存任务状态和证据。

**AgentRuntime 直接内嵌 `@earendil-works/pi-durable`，模型访问使用 `@earendil-works/pi-ai`。** Hermes、OpenCode、Codex CLI、Claude Code 不作为核心执行器。Antigravity 仅保留为可选外部工具，不能成为内嵌模型 provider；`pi-antigravity` 只作实现参考。

## 当前状态

2026-10-22：已建立 Node/TypeScript 项目，直接内嵌 Pi Harness、SQLite、CodingTools。显式 feature/debug Run 可自动派发隔离角色，在独立 worktree 修改代码，采集真实命令退出码与内容指纹，执行独立 review 和交付；支持有限返工、恢复和未知副作用阻塞。全树模型预算、可重建 Run catalog、私有 socket 后台宿主与服务 TUI 已接线。TUI 可显式启动/取消/恢复 Run，实时观察步骤、预算、Git/worktree 与 diff；关闭界面不取消后台任务。

2026-10-24：M4 工作台后端第一、二片已接线——后台服务支持 `--http` 开启仅绑定 127.0.0.1 的 token 门禁 HTTP 投影（runs 列表/状态、start/cancel/resume 透传、SSE 快照流、run worktree 的 staged/working diff 与 Run DB 证据只读投影），断开 HTTP/SSE 客户端不取消任务，服务关闭时清理 `http-token`。

2026-10-25：M4 前端三片已接线——`web/` 目录的 React + Vite 最小浏览器工作台由服务同源提供（连接表单 + Run 列表实时更新 + 详情/预算/阻塞原因 + cancel/resume + diff/证据只读），token 仅存 sessionStorage（仅保证同 tab 刷新恢复）；第二片加入 start 派发表单：feature/debug 两种任务在同一入口组装 spec 与非敏感 profile 后经 `POST /runs` 透传派发；第三片让 diff 视图按需消费文件级端点——分页文件索引突破聚合 50 文件封顶，任意文件可按层查看单文件 diff（64KiB 截断与结构化错误原样显示），服务端同步把 `diff/files` 的 `limit` query 收紧为纯十进制整数字面量。随后并入连接 catalog 只读投影：服务以 opt-in `--catalog DIR` 暴露仅 token 门禁的只读 `GET /connections`（未启用为 400 结构化错误，不创建目录），工作台 start 表单可下拉选择 catalog 条目预填 profile 字段（连接写管理当时仍经 CLI，edit 尚未实现）。派发能力已进入工作台，但真实模型闭环与真实仓库验收仍未开始，不据此声称「同一入口完成两种任务」完成。

2026-10-26：M4 证据 artifact 正文只读投影已接线——socket `artifact` 只读方法与 `GET /runs/:runId/artifact?evidence=` 端点复用 evidence 的 SQLite 只读快照路径投影单条证据的持久化正文（只解析 `pi:feature/<id>` 一致引用，防御性 64KiB 截断如实标记），工作台 evidence 面板为 artifact 条目提供按需查看；随后服务 TUI 证据面板同样接入按需正文视图（选中 artifact 条目按 `Enter` 经同一 socket 方法拉取一次，`truncated` 徽标与完整字节数如实渲染，与浏览器工作台同一截断口径）。预算账本的已核对（reconciled）计数现于服务 TUI Usage 行与工作台预算行恒显示（与 pending 同级分段，含 0）。随后统一 Run 连接身份推导（CLI 与服务共用排除 catalog id 的七键完整 SHA-256，停服→CLI 离线核对→重启→显式 resume 的服务托管核对流程已由真实服务集成测试端到端验证），预算离线核对命令并显式拒绝连接类旗标组合。预算人工核对随后接入服务侧：socket/HTTP `reconcile-budget` 写方法与工作台显式确认按钮（成功显示 before/after 摘要与「不采纳为成功、不证明未到达 endpoint」声明；服务 dispatch 中经 lease 失败关闭，`DATABASE_IN_USE` 结构化透传），服务 TUI 亦以 `b` 键位经同一 socket 方法提供核对入口（pending>0 且非 active 才有入口，显式确认一步，摘要/声明/错误口径与按钮一致；开草稿即放弃武装），不停服流程为「CLI 清 workflow 操作 + 工作台/TUI 核对 + resume」；workflow 人工核对仍仅 CLI。服务 TUI 证据面板随后升级为窗口跟随游标导航（游标在可见窗口内移动、触及边缘窗口滚动一行，`›` 标记恒随游标），核对错误行与摘要同以 runId 守卫渲染。真实模型闭环与真实仓库验收口径不变。

2026-10-26：M3 连接写管理接入服务与工作台——服务在既有 `--catalog DIR` opt-in 下暴露 token 门禁的 `POST /connections` 与 `DELETE /connections/:id`（socket `connections-add`/`connections-remove`），写路径与 CLI `connections add/remove` 完全同一（owner-only 存储、跨实例锁、原子写、幂等 add、同 id 变更拒绝、非敏感构造），结构化错误码前缀透传；读路径的只读无 mkdir 保证零回退。工作台 start 表单提供「Save profile to catalog」与条目删除（显式确认一步）入口，成功后刷新选择器，未启用时管理 UI 不出现；真实服务集成用例以零凭据子进程端到端钉住「HTTP 写 → CLI/直读同一落盘」。服务 TUI 随后以 `c` 连接面板补上同组键位：面板可见期间随刷新只读拉取列表（`j/k` 窗口跟随导航），`a` 以 `add <profile path>` 草稿从磁盘 profile 文件恰发一次 `connections-add`，`d` 对游标条目武装删除确认（确认前零请求），结构化错误面板内逐字显示、未启用时管理键位零请求（与 web `catalogEnabled` 门控同构）；零凭据真实服务集成用例端到端钉住「CLI 预置 → TUI 增 → 删 → 落盘三方一致」。edit 随后落地（见下一条），全局/项目默认自动选择仍未实现。

2026-10-27：M3 连接 catalog edit（显式更新）落地——`connections edit --profile PATH`（CLI 第四动作，沿 add 先例不带 `--id`）、服务 socket `connections-update` 写方法与 HTTP `PUT /connections/:id`（body.id 与 path id 不一致为 400 结构化错误）三入口共用同一 `ConnectionCatalog.update` 写路径：同 id 替换字段、未知 id 报 `UNKNOWN_CONNECTION` 不 upsert、canonical 相同幂等 `unchanged` 且零写盘；add 的 `CONNECTION_CONFLICT` 语义与文案零改动。工作台 start 表单对选中条目提供「Update selected connection」：以表单当前字段恰发一次 PUT，成功后重读 `/connections` 刷新选择器，幂等 unchanged 按成功呈现，结构化错误原样显示可重试；改 Profile id 与选中条目不一致时表单内先提示（须换 id 另存或先删后增）。真实服务集成用例（零凭据）钉住「PUT 更新 → CLI 子进程 list 与直读 connections.json 三方一致」。服务 TUI 随后以 `u` 键位补上 edit 入口（沿 `a` 先例的门控与共享草稿：`edit <profile path>` 草稿 → 对游标条目显式武装确认，确认前零请求；`return` 才从磁盘加载 profile 并恰发一次 `connections-update`，profile.id 与条目不一致在客户端零请求拦截，较 web 表单为 TUI 特有收紧；三方武装互斥、在飞结果独立 revision 守卫），并补上 edit 流在飞守卫：在飞 `connections-update` 期间 `u` 键与 edit 草稿提交的武装点均零状态零请求（后者针对宿主级 `n`/`a` 草稿改写为 `edit …` 的真实可达路径，为承重守卫），旧响应不再静默清除新武装或串显旧错误；连接面板键位文档的空列表 no-op 措辞同步修正为精确表述（`a` 在空列表+门控开时开草稿，零请求但非 no-op）。全局/项目默认自动选择仍未实现。仅本地回归验证，不构成真实 endpoint、OAuth 或真实浏览器视觉验收。

这些能力通过本地 Pi fixture 与真实临时 Git/worktree、命令和进程恢复验证。真实模型 endpoint、真实缓存命中率与 OAuth 仍未验收，不能据此声称完整 M1/M2 交付。服务与 debug 使用方式见 [本地服务指南](docs/LOCAL_SERVICE.md)。

M3 API-key/profile 切片已接线：新增内置 Anthropic 连接；TUI 实时显示持久 token/cache 统计，区分 Git 查看目录与 Runtime 执行目录。

默认持续沿用 Pi，不增加执行器切换。未知 Feature 操作现可经 `--inspect` 核对后，以 `--reconcile` 明确授权一次重试；不会将旧操作直接采纳为成功。`pi-durable` 上游当前为 experimental，已固定 `1.3.0` 并提交 lockfile。

## 启动实时工作台

终端 TUI：

```sh
npm ci
npm run dev -- tui --cwd .
```

无需模型凭据即可查看工作树、改动和 diff；绑定 Runtime 的方式见 [TUI 指南](docs/TUI.md)。

浏览器工作台（M4，只读观察 + cancel/resume + start 派发（可选 `--catalog DIR` 预填连接并管理增删改）+ 文件级 diff 查看 + 证据 artifact 正文按需查看）：

```sh
npm run build
npm run service -- --data-root /absolute/loom-data --http [--catalog /absolute/.loom]
# 按 stdout 公布的 http://127.0.0.1:PORT 打开浏览器，
# 粘贴 dataRoot/http-token 文件中的 bearer token
```

使用细节与边界见[本地服务指南](docs/LOCAL_SERVICE.md)。

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
- [后台服务、全树预算与自动 Debug](docs/LOCAL_SERVICE.md)
- [角色与流程演进](docs/ROLES_AND_EVOLUTION.md)
- [Git 与工作区生命周期](docs/WORKSPACES.md)
- [ADR 0001：薄控制层](docs/decisions/0001-thin-control-plane.md)
- [ADR 0002：内嵌 Runtime 与模型接入](docs/decisions/0002-embedded-pi-runtime.md)

Loom 为本地工作名，尚未进行商标、包名或域名核查。
