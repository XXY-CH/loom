# Provider 与认证

状态：OpenAI API-key 与自定义 OpenAI-compatible 已接入 Pi Runtime；本轮加入内置 Anthropic API-key 连接。仅通过本地协议 fixture 验证，真实模型 endpoint 和账号登录未验收。OAuth 仍为实验模块，不提供正式登录承诺。

## 连接方式与产品承诺

| 方式 | 用户提供 | 计划状态 |
| --- | --- | --- |
| 内置 endpoint + API key | provider、key、模型 | 已接线 OpenAI / Anthropic；真实服务未验收 |
| 自定义 endpoint | base URL、协议、model ID、可选 key | 已接线 OpenAI-compatible；兼容性按服务验收 |
| Sign in with ChatGPT | 浏览器授权、符合条件的账号与 workspace | 正式目标；走官方本地/开源应用流程 |
| Claude 订阅 OAuth | Claude 订阅账号 | 当前受阻；不暴露可用登录入口 |
| Antigravity | 外部工具自己的授权与配置 | 后续可选工具；不能注册为模型 provider |

“内置 endpoint”只提供连接预设，不内置共享 API key、不代付费用。当前自定义 endpoint 支持 OpenAI Responses、Chat Completions；Anthropic Messages 只提供内置 endpoint，暂不支持自定义路由。支持程度按实际探测记录；URL 可访问不表示工具调用、图片、thinking 或 usage 都兼容。

## Profile 与模型选择

一个连接 profile 至少包含 `id`、`provider`、`protocol`、`baseUrl`、`authMethod`、`credentialRef`、model ID、能力与配置版本。一个 provider 可以有多条 profile，避免 pi-ai 的 provider ID 覆盖不同 endpoint/账号；映射方式在 Spike 验证。

每次阶段执行固定 profile 版本和模型。全局默认、项目默认、Run 覆盖按此顺序覆盖；按角色指定模型必须显式配置。遇到额度或错误不静默切账号、endpoint 或计费方式。变更连接只影响新调用，已有调用结果保留原始归属。

动态模型发现可用时以服务端为准，否则允许手填 ID 并标记未验证。连接检查分为配置检查、凭据检查、模型发现、一次真实文本/工具流，不能只用 HTTP 200 表示模型可用。

## OpenAI 订阅登录

采用官方 **Sign in with ChatGPT / ChatGPT plan usage**，不通过 Codex CLI，不读取或复制 `~/.codex/auth.json`，不使用其他应用的客户端身份。

当前官方路线适用于开源与本地托管应用；收费或远程托管产品需要另行确认接入条件。本仓库按用户授权发布；自有代码许可证尚未确定，不由 OAuth 接线自动授予其他权利。

实施要求：

- 使用 Loom 名称，生成并保存稳定 host ID；新账号动态注册，后续登录复用该账号/workspace 的 issued client ID。
- PKCE、state、nonce、loopback callback；验证 ID token 签名、issuer、audience、时效和 nonce，再绑定账号。
- 检查实际授予的 `chatgpt.tokens.use.direct` scope，安全保存并原子轮换 refresh token；并发刷新加锁。
- 使用该账号返回的模型列表和公共 `https://api.openai.com/v1/responses`；HTTP 请求 `store: false`、`stream: true`，按当前限制构造输入与 tools。
- 只有收到 `response.completed` 才报告模型请求完成；中途限额错误、流中断、response.incomplete 分别处理。

当前 preview 禁止部分 Responses 参数与 hosted tools；不能把 API key 的全部参数直接沿用到订阅路线。支持本地工具也不意味着支持所有 hosted tools。模型和额度由服务端决定，不能承诺与 Codex 原生客户端同额、无限量或包含某个固定模型。

pi-ai `1.3.0` 已有该 provider 和 OAuth，但固定源码中的登录每次动态注册、没有完成官方要求的 ID-token 身份验证。优先向上游补齐或以 Loom 自有 OAuthAuth 实现补齐，保留 pi-ai 推理层；未通过登录、刷新和完整推理验收前不标记支持。

## Claude 与 Antigravity

Anthropic 官方文档目前明确禁止第三方应用提供 Claude.ai 登录或代用户路由 Free/Pro/Max 订阅凭据。上游存在 Anthropic OAuth 代码不改变这个边界。Loom 正式支持用户自己的 Anthropic API key；若未来获得明确授权或官方 SDK 支持该用途，再更新 ADR 和验收。

按用户约束，Antigravity 仅可作为外部工具。`pi-antigravity` 实际采用直接 OAuth + 原生模型连接，不能原样移植为 provider。可参考工具结果、流处理和脱敏诊断；具体外部调用机制尚待核实，不假定存在可用 CLI/API。调用结果作为工具产物返回，不冒充 Loom 自己的模型回合。

## 凭据与费用

凭据只由本地服务解析，首选 OS credential store；需要文件回退时采用 owner-only 权限与原子写入。浏览器不持有 provider refresh token，不将 token 放入 URL、日志、模型上下文、产物或 Git。

OAuth 额度、API usage 和估算金额分开显示。订阅调用不显示为“零成本”；没有额度接口时显示未知。对失效授权进入 reconnect，对额度耗尽进入受控等待/失败，不自动改用付费 key。
