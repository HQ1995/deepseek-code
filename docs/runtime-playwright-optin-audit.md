# Playwright opt-in：最小接入边界核实

2026-09-15。范围：DSH `dsh-v0.1.6-alpha.1` / `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`，已安装的 `@playwright/mcp@0.0.80`，以及它精确依赖的 `playwright-core@1.63.0-alpha-2026-08-31`。本文件是只读源码/第一方资料审计，不以静态结论代替运行验证；随后完成的独立实验入口和真实浏览器结果见[候选验证记录](runtime-playwright-candidate.md)。[DSH provider][provider]、[上游包声明][pw-package]、[发布元数据][pw-dist]。

## 结论与阻塞点

可以做**仅供受控页面验证的、显式 opt-in 实验入口**，不应把原始 provider 直接宣传为安全浏览器。建议独立私有 bundle，共同拥有一个 fail-closed policy 和原生 launch-only provider；保持主线 runtime、默认 profile/preset 不变，复用 DSH 的 Session 资源、MCP 和审批生命周期，不另建浏览器服务层。[原生资源所有权][resources]、[MCP 挂载][mount]。

必须先补的边界：

- **默认有宿主代码执行工具。** `browser_run_code_unsafe` 属于 `core`；上游 `filteredTools()` 无条件包含所有 `core*` 且非 `skillOnly` 的工具，`capabilities: []` 也不会将它移除。其实现用 Node `vm` 执行传入代码，官方标记为 RCE-equivalent。必须硬拒绝，不只依赖提示词或“需要审批”。本版本没有 `allowedTools` / `blockedTools` 配置。[已发布核心源码][pw-core]：`lib/coreBundle.js` 67355–67412、68158–68170；[配置类型][pw-config]。
- **DSH 的 `tools.restrict()` 不能过滤这些 Session-scoped 工具。** 它只限制 global 工具，scope-local registrations 会在过滤后合并；传入 local 名称会报 unknown global tool。可用原生 `tools.guard()` 做不可被其他 allow 覆盖的执行拒绝；这不隐藏模型工具目录。普通允许动作使用 `tools/pre-execute` → `ask` → 原生 approval seam。[ToolRuntime][tools]；[scope 测试][tools-tests]。
- **launch 的隔离不是 OS/网络沙箱。** 它不使用当前登录浏览器，但仍可访问宿主可达的网站、loopback/LAN，且输出会写到工作目录。必须明确这是受控实验，不承诺任意不可信页面的隔离安全性。[provider][provider]、[MCP transport][transport]、[发布核心源码][pw-core]：`context.ts` 对应 65015–65062、65292–65332。

## 当前真正可配置的字段

DSH provider 的 launch 配置只有以下四项；没有透传任意 args/env/config 文件的接口。它会把父环境中所有 `PLAYWRIGHT_MCP_*` 名称覆盖为空，因此不能靠同名环境变量补出缺失功能。[Schema 与挂载][mount]、[provider 参数][provider]、[参数测试][provider-tests]。

| 字段 | 精确行为 |
| --- | --- |
| `mode: launch` | 必填；内部总是 `--browser chromium --isolated` |
| `headless` | 默认 `true`，为真时加 `--headless` |
| `executablePath` | 可选非空字符串，显式 Chromium 可执行路径；不给时由上游寻找安装 |
| `toolCallTimeoutMs` | 可选，至少 1 ms；省略时 DSH MCP 默认 60,000 ms |

Attach 分支另有必填 `endpoint`，支持 HTTP(S)/WS(S)，不属于这次实验入口。建议 launch-only API 根本不接受 attach 字段，而非依赖文档提醒。[Schema][mount]。

上游 MCP 自身有以下设置，**当前 DSH provider 均未暴露**：[配置类型][pw-config]、[官方 CLI 说明][pw-readme]。

| 目标 | 上游配置 / 参数 | 不能误解为 |
| --- | --- | --- |
| 请求来源限制 | `network.allowedOrigins` / `network.blockedOrigins`；`--allowed-origins` / `--blocked-origins`（CLI 以 `;` 分隔） | 不是安全边界；官方明确不覆盖重定向 |
| 禁 Service Worker | `browser.contextOptions.serviceWorkers: block`；`--block-service-workers` | 不是完整 egress 隔离 |
| 工作区文件 guardrail | `allowUnrestrictedFileAccess`，默认不打开；`file:` 导航默认被拒绝 | 不是 OS 文件沙箱；代码来源的路径不走同样限制 |
| 输出位置 | `outputDir` / `--output-dir`；默认可写 cwd 下 `.playwright-mcp`，否则临时目录 | `--isolated` 不保证零落盘 |
| Chromium sandbox | `browser.launchOptions.chromiumSandbox` / `--sandbox` | 不是 MCP Node 进程沙箱 |
| 可选工具组 | `capabilities` / `--caps` | 不能关掉 core 工具 |

平台差异也需保留：该版本 `--browser chromium` 映射为 `chrome-for-testing`。macOS 默认 `chromiumSandbox: true`；Linux 对 `chromium` / `chrome-for-testing` channel 默认 `false`。不能拿 macOS 的结果代替 Linux 安全配置验收。[发布核心源码][pw-core]：`mcp/config.ts` 对应 72291–72339。

`--allowed-hosts` 是 MCP HTTP listener 的 Host/DNS-rebinding 检查，不是目标网站 allowlist；DSH 此处是 stdio，不能靠它限制网页请求。[配置类型][pw-config]。

## 默认工具与最小 policy

源码 `filteredTools()` 的默认目录为以下 24 个名字（已在[独立运行验证](runtime-playwright-candidate.md)中与真实目录对照）；DSH 公开名前缀是 `mcp__playwright-mcp__`。[发布核心源码][pw-core]：`backend/tools.ts` 及各 tool 定义；[DSH 名称映射][mcp-tools]。

```text
browser_handle_dialog   browser_snapshot          browser_click
browser_drag            browser_hover             browser_select_option
browser_file_upload     browser_drop              browser_close
browser_resize          browser_console_messages  browser_evaluate
browser_find            browser_fill_form         browser_press_key
browser_type            browser_navigate          browser_navigate_back
browser_network_requests browser_network_request  browser_run_code_unsafe
browser_take_screenshot browser_tabs               browser_wait_for
```

本次不发现默认 `browser_install`；不要据旧版本列表假设它存在。未知/未来新增工具仍应默认拒绝。推荐从 navigate、snapshot/find、click/type/fill/select/key、wait、tabs、screenshot、close 的小 allowlist 开始；`unsafe`、`evaluate`、`file_upload`、`drop` 先硬拒绝，诊断工具按实际测试需要再加。`evaluate` 是页面 JS，不是同一个 server-JS 根因，但本实验不需要它。[发布核心源码][pw-core]：`backend/evaluate.ts` 66286–66340、`backend/runCode.ts` 67355–67412。

原始参数也要检查，不能只认工具名：

| 默认工具 | 会使用调用者路径的字段 |
| --- | --- |
| snapshot / console_messages / evaluate / network_requests / network_request | `filename` |
| take_screenshot | `filename`；不传时仍落盘，但还会返回 image block；传入时不返回该 image block |
| run_code_unsafe | `filename` 读取待执行代码 |
| file_upload / drop | `paths` 读取本地文件；drop 另有 MIME `data` |

以上均指带 `browser_` 前缀的全名。最小实验应拒绝外部 `filename` / `paths`，保留截图默认输出，并清楚说明 `.playwright-mcp` artifacts。还应拒绝 `_meta`：后端在 schema parse 外读取 `_meta.cwd` / `raw` / `json`，不应把这类私有参数当普通浏览器输入接受。[发布核心源码][pw-core]：`backend/backend.ts` 65810–65836、`files.ts` 64485–64550、`screenshot.ts` 67438–67485、`network.ts` 67030–67095。

`browser_tabs` 的 `action: new` 也能携带 `url`，必须与 `browser_navigate.url` 使用同一校验；`action: list` 也可能 `ensureTab()` 启动浏览器。建议只接受精确受控 origin + HTTP(S)，拒绝 credentials、其他 scheme、非预期参数；这仍不能约束点击/脚本/重定向/第三方子资源的所有网络流量。[发布核心源码][pw-core]：`backend/tabs.ts` 67548–67594。

## 复用审批，不复制权限系统

允许的实验浏览器调用可统一走 `tools/pre-execute` 的 `ask`，保留下游已有 deny/cancel，不将它改为 allow；`tools.guard()` 独立拒绝禁用能力，即使其他 policy 尝试 allow 也不能放行。这个 seam 同时适用于 Native / PTC 内部的真实工具调用，不应只拦 TUI 展示层。[ToolRuntime][tools]、[scope 单调 guard 测试][tools-tests]。

原生 ApprovalService 要求请求处于 open turn，会记录 asked/decided；缺少审批服务/Agent 会 fail closed；`approval.policy: never` 是**拒绝 ask**，不是自动同意。dscode 的 answerer 在确实收到 request 后又有 `record.yolo` 自动 allowed-once 分支，因此应保持原生 policy 语义，绝不能把危险能力的安全性寄托在 ask。[ApprovalService][approval]、[dscode adapter](../bridge/grok-leader/src/native-interactions.ts)。

现有 adapter 的 permission payload 直接传的是 call ID 和工具名，没有直接转发 `reason`/参数；TUI 是否从关联 tool update 展示目标 URL 必须实测。可将 URL/动作说明写入原生 reason 保留审计，但不要未经验证宣称审批框已明确展示目的站点。一次动作许可也不是页面后续所有副作用的逐项许可。[dscode adapter](../bridge/grok-leader/src/native-interactions.ts)。

## 生命周期与需要补的验收

可直接复用的原生保证：每个精确 live Agent activation 拥有一个 MCP 子进程；agent/created 等发现结束，调用按 Session 排队；provider reload 只影响以后 activation；不自动 reconnect 替换浏览器状态；dispose 先关 scope/transport，再等队列。Attach 的独占只在 provider 进程内有效，本次不开放。[MCP 挂载][mount]、[资源实现][resources]。

**普通 user cancel 与 Session dispose 不能混为一谈。** `kind: disposed` 会主动关闭资源；普通取消只把 signal 传给 MCP 调用。Playwright 服务端虽传递 signal，但本版本 navigate handler 不消费它，不能仅根据客户端 promise 返回 ABORTED 就断言后台动作已停止。[resources][resources]；[发布核心源码][pw-core]：`mcp/server.ts` 71912、`backend/navigate.ts` 66819–66834。MCP 进程收到 stdin close/SIGTERM 会尝试关闭浏览器并有 15 秒退出 watchdog；这是实现机制，不是已验证零残留。[发布核心源码][pw-core]：`mcp/watchdog.ts` 72672–72691。

建议验收依次为：

1. 先只发现实际 24-tool 目录；在没有浏览器操作时验证 unknown/unsafe/evaluate/upload/drop/私有参数硬拒绝，反向 allow 监听不能绕过。
2. 受控 loopback 页：navigate → snapshot → 输入/点击 → 读回；拒绝审批时页面无变化，Native/PTC 两种工具路径均受约束。
3. 截图不指定 filename，验证 image block → attachment → TUI viewer；测试无 image modality 的明确文本降级，并检查默认输出落盘位置。
4. 两个 Session 的页面/cookies 不串；子 Agent 不继承另一个 Session 的工具；dispose/new/resume 后独立状态符合设计。
5. 慢导航/排队动作分别 user cancel、Session dispose、host unload；观察服务端后续请求、页面变化、MCP/Chromium PID 和退出时间，不能只检查客户端状态。

上游已有 fixture 覆盖 discovery/取消创建/恢复/资源独占/排队/卸载；真实浏览器 e2e 仅 launch/attach 到 loopback、验证导航并 dispose，不覆盖上述慢动作取消与 dscode TUI/approval 组合。应复用这些测试语义，补最少的安装态验证。[生命周期 tests][lifecycle-tests]、[资源 tests][resource-tests]、[真实浏览器 test][upstream-test]、[真实 helper][upstream-helper]。

[provider]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-playwright-mcp/src/index.ts
[mount]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/src/mcp.ts
[resources]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/src/index.ts
[provider-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-playwright-mcp/tests/provider.spec.ts
[tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/tools/src/index.ts
[tools-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/core/tools/tests/scoped.spec.ts
[approval]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/interaction/user-approval/src/index.ts
[transport]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/mcp/mcp-client/src/transport.ts
[mcp-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/mcp/mcp-client/src/tools.ts
[pw-readme]: https://github.com/microsoft/playwright-mcp/blob/v0.0.80/README.md
[pw-config]: https://github.com/microsoft/playwright-mcp/blob/v0.0.80/config.d.ts
[pw-package]: https://github.com/microsoft/playwright-mcp/blob/v0.0.80/package.json
[pw-dist]: https://registry.npmjs.org/@playwright/mcp/0.0.80
[pw-core]: https://registry.npmjs.org/playwright-core/-/playwright-core-1.63.0-alpha-2026-08-31.tgz
[lifecycle-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/tests/mcp.spec.ts
[resource-tests]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/tests/resources.spec.ts
[upstream-test]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-playwright-mcp/tests/upstream.e2e.ts
[upstream-helper]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/tests/mcp-upstream.ts
