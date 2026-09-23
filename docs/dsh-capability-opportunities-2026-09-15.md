# DSH alpha.1：下一批值得接入的能力

## 范围与证据等级

2026-09-15，比较产品主线固定的 `0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203` 与源码 `dsh-v0.1.6-alpha.1` / `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`。本文是固定版本源码、官方 README 与当前产品实现的静态审计；没有安装新包、调用真实模型、连接远端、运行浏览器/桌面或执行下列能力的新验收测试。不能把上游测试文件存在当作本产品验证通过。[上游差异][compare]；[产品固定版本](../bridge/grok-leader/package.json)。

主线仍是 rc.2；`candidate/dsh-capabilities` 已完成基础适配及下列能力的候选实现与分层验收。早期 Playwright 取消后页面继续请求的问题已在候选 `7310a64` 修复，物理 TUI 呈现、Linux 浏览器生命周期/sandbox、子代理继承和外部真实模型验收仍是合入门槛。本文的静态审计不代表重新执行了这些验收，也不建议据此扩大默认功能；已接的 goals、history、LSP、terminal、workflow/PTC、子代理控制不重复计为待补能力。当前状态以[候选实现与验收摘要](dsh-capability-candidate.md)为准；[适配记录](runtime-alpha16-adaptation.md)和[早期 Playwright 候选](runtime-playwright-candidate.md)保留历史过程。

本轮另经官方 GitHub/npm API 实时复核：最新发布仍为 `0.1.6-alpha.1`，npm `alpha` 指向它，`next` 仍为 rc.2、`latest` 仍为 rc.1。官方 master 仍为 `0d1f50007f9bca3f52b06e1c3074fa14d5fb0720`，不能把其额外改动算进已发布 alpha。[发布 API][release-api]；[npm 元数据][npm]；[master][master]。

## 建议顺序

以下按主线接入价值排序，列出最小范围与验收要求；不表示候选分支尚未实现。候选已有 MCP resources、SSH headless、图片 offload、native Messages/Files 和 Teams 的实现与验收，具体覆盖和剩余限制见[候选摘要](dsh-capability-candidate.md)。

| 顺序 | 能力 | 为什么值得 | 最小增量 / 就绪度 |
|---|---|---|---|
| 1 | MCP resources 与 URI templates | 让只提供文档、schema、知识资源的 MCP server 也有用，不局限于 tools | 低成本；alpha base 已挂载，补产品可见性与作用域验收 |
| 2 | POSIX SSH 执行后端 | macOS 保留界面、模型、会话，swoop 提供 Linux 文件、命令与沙箱 | 产品收益最大；中高成本，先独立 headless/custom profile |
| 3 | 图片超限持久 offload | 多图/截图长任务不因图片预算直接中断，回放与计量一致 | 低到中成本；alpha base 已挂载，补可见状态与恢复验收 |
| 4 | 原生 DeepSeek Messages route | 原生 reasoning/replay、Files、计量形成完整链路 | 中成本；显式 opt-in，不改通用 gateway 默认 |
| 5 | Agent Teams | 长任务有持久成员、消息和带冲突检查的任务板 | 中高成本；实验性且旧版已有，先独立 team preset |

成本和顺序是结合当前产品接入情况的工程判断，不是上游性能承诺。

## 1. MCP resources：最有效的第一步

新增 `dsh-mcp-resources` 提供 `list_mcp_resources`、`list_mcp_resource_templates`、`read_mcp_resource`。它按调用 Agent 的 scope 选择显式命名的 server，支持分页；有 server 就有共享资源工具，即使 server 没有 tools 或 instructions。无 server 时不增加工具、PTC binding 或 prompt。alpha 的 base/sdk-minimal 已挂载，无需再插入重复 plugin。[资源说明与实现][resources]；[base composition][base]。

当前产品 MCP 面板投影仍以 tools 为中心；prompt 输入的 `resource_link` 被转成文字，并不是取回资源内容。最小工作是让“0 tools、有 resources”的 server 在产品中可理解，核实工具目录/调用投影是否自然透传，不另建文档抓取系统。[MCP 桥接](../bridge/grok-leader/src/mcp.ts)；[prompt 输入](../bridge/grok-leader/src/prompt-content.ts)。

验收建议：受控 resource-only server；列表、模板展开和读取；分页；两个 Session 的 server 隔离；无 server 时工具消失；取消/断线和卸载；native/PTC 两条调用路径。资源是外部数据而非新指令；读取不代表订阅更新。上游暂不支持 subscriptions；binary 保留在 canonical result，但不会自动变成模型图片/音频；资源工具也没有独立文本大小限制。还需注意 `tools.restrict()` 不覆盖调用者自身 scope 注册的资源工具，不能仅靠过滤目录宣称阻止资源读取。[限制及结果投影][resources]。

## 2. SSH：与 macOS + swoop 最匹配的新能力

新增四个配套包：`dsh-ssh`、`dsh-fs-ssh`、`dsh-subprocess-ssh`、`dsh-sandbox-ssh`。Harness、模型请求与 Session 存储留在本机，远端提供 filesystem、普通进程、terminal 和 file-effect sandbox；不是“在 Bash 中拼 ssh 命令”。仅支持 Linux/macOS endpoint，需要既有 OpenSSH alias、严格 known-host、非交互认证，禁用 agent forwarding；远端 helper/runtime 需预先安装，helper/PTC bootstrap 校验配置的 digest。[SSH 家族][ssh]；[连接与部署][ssh-connection]。

建议先做名为 remote 的隔离配置，限定一个测试目录、一个已知主机，验证 read/write/进程/取消/断网清理与权限拒绝，再考虑 TUI 路径呈现。产品目前会直接使用本机文件路径处理图片及附件，所以不能把远端路径字符串直接交给本机 open/read。上游也明确只支持 headless 或遵守 provider-owned paths 的 custom composition，Web workspace UI 仍有本机路径假设；没有自动 provisioning、重连或重放，断线后无法确认远端最终结果。[SSH 限制][ssh-connection]；[产品图片路径](../bridge/grok-leader/src/image-output.ts)。

这是能力评估，不是本轮远端执行授权；不复用以前 swoop 上某轮测试的“通过”来覆盖新 SSH 后端。

## 3. 图片 offload：补上行为解释与验收

新增 `dsh-compaction-image-offload` 把超出当前模型图片预算的最旧图片 occurrence 记成持久 `image/offload` 事件，再重试且不消耗 provider retry budget。token 计量、resume、回放使用同一选择；alpha base 已挂载，重点不在再装包。[offload 说明与实现][offload]；[base composition][base]。

值得补的用户体验是说明“旧图还在附件里，但本次模型已不再看它”；提供重新读取的可理解路径。必须验收：多图超限、Files 故障触发 inline 小预算、模型切换、resume、compaction、重新读取与 token 投影。上游选择是永久的：切回大预算不会自动恢复旧图；临时 Files 故障也可能造成持久 offload。首次 offload 至少经过一次失败尝试，不是预先计算后零失败切换。[持久语义及限制][offload]。

“Files”不是 PDF/Word 文档理解新入口：此 DeepSeek adapter 的 Files 管理用于 request images；产品 prompt 仍只接 text/resource_link/image。PDF/Office 需独立的文档提取/视觉设计，不能用此变化承诺已经支持。[原生 adapter][deepseek]；[prompt 输入](../bridge/grok-leader/src/prompt-content.ts)。

## 4. 原生 Messages：有价值，但保持 provider 中立

此轮真正新增的是 native `deepseek-official` 的 Messages 协议实现与默认协议切换；Chat Completions 仍可显式选。Messages 使用不同 API root、`/v1/messages`、content blocks/reasoning 签名回放和 Files 路径；不能把已有 Chat gateway 的 baseURL 原样当作自动兼容。[原生协议配置][deepseek]；[adapter/config 源码][deepseek-src]。

当前产品 `/provider` 是 `llm-pi-ai` namespace 的通用路由管理，虽已支持 `anthropic-messages`，不等于使用原生 `deepseek-official` adapter。产品明确默认禁用 native DeepSeek。若追，先增加显式原生路线选择及端点校验，保留 gateway 通路和现有凭据归属；对 native route 做 text/tool/reasoning/images、取消、resume、计量与自定义端点 E2E。候选中 `session-log-deepseek` 的关闭开关也须保留，不能在接协议时顺带上传会话事件。[产品 provider 管理](../bridge/grok-leader/src/model-catalog.ts)；[产品 composition](../bridge/grok-leader/cordis.patch.yml)；[候选隐私控制](runtime-alpha16-adaptation.md#native-deepseek-session-event-contribution)。

不要把现有能力重新包装成升级收益：Files 图片复用、上传取消和 `systemPromptUpdate: in-history` 在 rc.2 已存在。后者可能保留动态 prompt 变化前的历史前缀，但实际 cache 命中仍取决于 gateway/model 支持、schema 和图片表示，不保证降低费用；产品已经显示 cache usage。应当作为新 route 的性能验收项，而不是再实现缓存层。[rc.2 原生 adapter][old-deepseek]；[当前 cache 投影](../bridge/grok-leader/src/projection.ts)。

## 5. Teams：适合持续协作，不是代码冲突解决器

`experimental-agent-team` 与 tool 包已有持久队列、成员状态、任务 CAS revision、依赖关系、scope overlap 提示和等待/中断；rc.2 已有主体实现，本轮主要有 maxMembers 默认 8→16 等维护更新，并非 0.1.6 才出现。对于用户常见的研究、实现、review 并行任务，持久任务板比单纯子代理列表多了真实价值。[Team 功能及限制][teams]；[版本差异][compare]。

产品已有子代理生命周期和历史投影，不能直接视为完整 Teams UI。最小方案是 opt-in team preset + 简洁任务/消息投影，先验证重启恢复、排队去重、任务 stale revision、取消、费用上限和 teardown。不添加 worktree 管理：官方只支持一进程一共享 checkout，无 worktree/merge/文件锁；writeScopes 仅警告，任务 owner 不随 idle/中断自动释放，也不支持多进程 exactly-once。[Teams][teams]；[现有子代理桥](../bridge/grok-leader/src/native-children.ts)。

## 暂缓默认启用的实验能力

- **Auto review**：真新增，但每个受支持调用增加一次额外模型请求，允许后以 Full access 执行；不提供文件 sandbox，outer `run_code` 与 PTC direct Node effects 不经过 inner-tool review。依赖 Web 集成，可能误判，不适合替代本产品确定性的权限/审批，也不能替代浏览器自身的取消与资源回收。[Auto review][auto-review]。
- **Inspector**：是从 private 变为实验性公开，并非本轮新实现。能查 Cordis 树、Host/Client 调试与 fetch，但需 webServer；上游默认抓取包括未脱敏的凭据/header/body，CDP loopback socket 没有 token 且允许任意代码执行。候选已实现独立 opt-in Host Inspector，默认关闭 fetch 抓取，并完成隔离验收；仍不应进入正常 dscode 默认或认为它是现有 `/doctor` 的零成本增强。[Inspector][inspector]；[候选状态](dsh-capability-candidate.md)；[现有诊断](../bridge/grok-leader/src/native-execution.ts)。

## 下一小步

下一步是在准备合入时整合 candidate 与 main 的独有提交，并针对整合后的代码回归已有 MCP resource-only、SSH headless、图片 offload、native Messages/Files 和 Teams 验收。保留 SSH 交互 TUI 暂停的既定范围；浏览器扩大支持前完成候选摘要列出的剩余门槛。已有实现与验收不重复列为待开发插件，候选通过也不等于当前主线已经具备这些能力。

性能线可另追 master 的可选 native 依赖延迟加载和 Typert schema 首次使用再构造；两者不在当前 alpha，尚未测得 dscode 加速。上游新增 headless stdin/resume/JSON 也不必平行造入口：现有 Rust headless 已有会话继续和 JSON/streaming 输出，应先对照语义缺口。[已有 headless](../third_party/grok-build/crates/codegen/xai-grok-pager/src/headless.rs)；[性能变化及发布边界](dsh-upstream-refresh-2026-09-15.md)。

[release-api]: https://api.github.com/repos/deepseek-ai/deepseek-harness/releases/tags/dsh-v0.1.6-alpha.1
[npm]: https://registry.npmjs.org/@deepseek-ai%2Fdsh
[master]: https://github.com/deepseek-ai/deepseek-harness/commit/0d1f50007f9bca3f52b06e1c3074fa14d5fb0720

[compare]: https://github.com/deepseek-ai/deepseek-harness/compare/fb2c4b9e698e30edb738bca4cf0618587db7d203...0a15e36e7f82b6ed45af6fa9759f29b40dcd965d
[base]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/bundle/base/cordis.patch.yml
[resources]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/mcp/mcp-resources/README.md
[ssh]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/ssh/README.md
[ssh-connection]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/ssh/ssh/README.md
[offload]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/compaction/compaction-image-offload/README.md
[deepseek]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/llm/llm-deepseek/README.md
[deepseek-src]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/llm/llm-deepseek/src/config.ts
[old-deepseek]: https://github.com/deepseek-ai/deepseek-harness/blob/fb2c4b9e698e30edb738bca4cf0618587db7d203/packages/llm/llm-deepseek/README.md
[teams]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/experimental/agent-team/README.md
[auto-review]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/experimental/auto-review/README.md
[inspector]: https://github.com/deepseek-ai/deepseek-harness/blob/0a15e36e7f82b6ed45af6fa9759f29b40dcd965d/packages/experimental/inspector/README.md
