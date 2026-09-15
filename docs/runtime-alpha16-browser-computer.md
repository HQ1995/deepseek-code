# DSH 0.1.6-alpha.1 browser / computer use 核实

2026-09-15；官方 tag `dsh-v0.1.6-alpha.1`，commit `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`。本文核实该 checkout 的源码、声明和官方上游文档。没有挂载、启用、启动这些后端，也没有截图、输入或操作真实浏览器/桌面；后续隔离产物检查见下文。文中“可接入”是静态结论，不代表 dscode 已经通过对应端到端测试。

后续进展：[Playwright opt-in 源码审计](runtime-playwright-optin-audit.md)与[独立候选实现/真实浏览器验证](runtime-playwright-candidate.md)已完成；基础路径跑通，但取消返回后仍有页面活动，暂不合入默认功能。本文保留此前静态核实范围，computer use 仍未启用。

## 已有能力与默认状态

确实存在 browser use 和 computer use。共享服务分别是 `@deepseek-ai/dsh-browser-use`、`@deepseek-ai/dsh-computer-use`；它们只登记一个 provider，不提供统一动作 API，也没有让模型切换后端的工具。实际后端是下列公开 experimental 包，版本均为 `0.1.6-alpha.1`。[Browser subsystem][browser]、[computer subsystem][computer]。

| 完整包名 | 固定依赖 / 运行方式 | 模型工具与用途 |
| --- | --- | --- |
| `@deepseek-ai/dsh-experimental-browser-use-playwright-mcp` | `@playwright/mcp@0.0.80`；Node 子进程 | `mcp__playwright-mcp__*`：页面 accessibility snapshot、导航、点击、填表、标签页、截图等。[包声明][pw-package]、[provider][pw]、[上游目录][pw-upstream] |
| `@deepseek-ai/dsh-experimental-browser-use-chrome-devtools-mcp` | `chrome-devtools-mcp@1.9.0`；Node 子进程 | `mcp__chrome-devtools-mcp__*`：页面操作、console/network、截图、性能分析；目录取决于实际发现的上游工具。[包声明][cd-package]、[provider][cd]、[上游目录][cd-tools] |
| `@deepseek-ai/dsh-experimental-browser-use-stagehand-native` | `@browserbasehq/stagehand@4.1.0`；Chromium + Worker + extension | 六个工具：`stagehand_navigate`、`stagehand_tabs`、`stagehand_screenshot`、`stagehand_act`、`stagehand_observe`、`stagehand_extract`；后三者调用独立模型。[包声明][sh-package]、[注册代码][sh-tools] |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-mcp` | 已安装的 `cua-driver` 可执行文件；默认参数 `[mcp]` | `mcp__cua-driver-mcp__*`，透传 driver 的桌面工具；DSH 没有固定其可执行文件版本。[provider][cu-mcp] |
| `@deepseek-ai/dsh-experimental-computer-use-cua-driver-native` | `@trycua/cua-driver@0.28.0`；运行于 DSH host 同一进程 | `cua_driver_native__*`，发现应用/窗口、读取窗口状态、截图和输入等，准确目录来自 SDK。[包声明][cu-package]、[注册代码][cu-native-code] |

本 tag 没有名为 browser/computer 的官方 bundle 或 shipped preset。对 `packages/bundle`、`packages/preset`、CLI composition 的搜索没有这些服务/provider 的挂载；五个 provider manifest 均无 `dsh.bundle`。官方也要求 experimental 包不得进入默认产品依赖和组合。[experimental 规则][experimental]。因此普通升级不会自动打开这些能力；`@deepseek-ai/dsh-experimental-browser-use-runtime` 是内部公共运行支撑包，不是可选择的第四个浏览器后端。

后续隔离产物检查发现一个 dscode 包装层差异：现有 [release builder](../scripts/build-release-payload.mjs) 会安装所有该平台可用的已发布 DSH tarball，而不只取默认 profile 的依赖闭包。因此本轮 alpha 候选 runtime 中实际包含上述五个 provider 和 browser runtime；“已在磁盘上”不等于“已挂载或已启用”。opt-in 时应先核实目标 profile 的解析路径，不必盲目重复安装。候选压缩包为 317,768,257 bytes，之前 `5922e6a2` 候选为 288,554,054 bytes；这个总量比较不能把全部增长归因于 browser/computer。按实际需要收窄 runtime 打包范围值得另做验证，不与本次最小接口迁移混在一起。

## 官方启用方式

这是 profile/preset 的 composition 选择，不是现成的 `enableBrowserUse` 用户设置。先把共享服务和选定 provider 作为依赖装进目标 profile，再在 profile 的 `cordis.patch.yml` 或自有 preset 中挂载。只有声明 `dsh.bundle` 的包才会因 `dsh plugin ... add` 自动成为组合层；单独安装上表的 provider 不会启用它。[官方安装说明][profile]。

例如，在已经完成 alpha 升级的隔离 dscode profile 中，Playwright 的 profile patch 可写为以下结构（示例未应用）：

```yaml
- insert:
    - id: browser-use
      name: '@deepseek-ai/dsh-browser-use'
    - id: browser-use-playwright
      name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp'
      config:
        mode: launch
        headless: true
```

依赖管理的官方形式是 `dsh plugin --profile <name> add <package>@0.1.6-alpha.1 ...`；仍需核实该 profile 能解析全部 peer dependencies。持久 patch 位于 `$DSH_HOME/profiles/<name>/cordis.patch.yml`；全局 `$DSH_HOME/cordis.patch.yml` 会影响所有 profile，不适合默认承载本次 opt-in。也可由自有 bundle 发布同样的插入层。[加载顺序][profile]。

Browser MCP 必须在创建/恢复 Agent 前挂载，加载后不会接管已运行 Session；应重启目标 dscode 并新建/恢复会话。MCP 的 `mode` 必填；launch 默认 headless，使用独立浏览器状态；attach 用 `endpoint` 指向 HTTP(S)/WS(S) 调试端点。同一 provider 实例只允许一个 Session 占用 attached browser；busy 的 MCP activation 本轮生命周期不会自动重试。跨 DSH 进程仍可能同时操作该浏览器。Session 重载不会从历史日志恢复 cookies/页面。[共享配置及生命周期][browser-runtime]。

三个 browser provider 都限定 Chromium 系列；Chrome DevTools 上游正式支持 Chrome/Chrome for Testing，其他 Chromium 不保证。Stagehand attach 使用 `cdpEndpoint` 和可选 `extensionId`，要求兼容 extension；其 launch 会开专用临时 profile 和 CDP 端口。[CD 上游要求][cd-upstream]、[Stagehand 启用说明][sh]。

## macOS computer use 的前提

Cua Driver 有 Windows、macOS、Linux 后端，但行为依赖 OS、窗口系统和应用。官方 0.28.0 的行为账本包含 macOS、Windows、X11、Sway 等不同覆盖；不能将 Linux 支持等同于任意 Wayland compositor，也不能把返回成功等同于目标应用已完成动作。[固定版本行为账本][cu-actions]；[当前官方平台说明][cu-platform]仅用于交叉核对，不替代固定版本证据。

macOS 需要 Accessibility 与 Screen Recording 权限，并有可用图形会话。TCC 授权属于负责启动进程的 app identity。MCP 默认可由已安装的 `CuaDriver.app` daemon 持有权限；`mcp --direct` 与 native 方式使用启动宿主的权限责任链。Native 安装须保留 npm optional dependencies，以取得对应平台的原生二进制。插件不会安装权限 app，也不会授予权限；它直接调用 `CuaDriver.create(undefined)`，原生崩溃可以带走 DSH host。[Cua 0.28.0 启动/权限说明][cu-upstream]、[native 要求][cu-native]。

截图和输入可能正常，而 headless macOS Node host 的 cursor overlay 返回 `facility_unavailable`。背景输入也不是对所有应用和动作通用：例如官方 macOS Electron 账本中背景 scroll/drag 拒绝；AppKit/SwiftUI 的覆盖各有缺口。应先取得新窗口 snapshot，再用对应 element token/截图坐标操作并读回验证。一个 provider 注册不等于桌面锁：它不为各 Session 预留窗口或串行化完整工作流；取消无法撤销已送出的输入。[native 限制][cu-native]、[行为账本][cu-actions]。

## dscode TUI、sandbox 与费用

**不依赖官方 Web UI。** Provider 注入的是 `tools`、`agents`、`systemPrompt` 等 harness 服务，普通工具结果进入 Session log。dscode 已有 [MCP 接入](../bridge/grok-leader/src/mcp.ts)、[工具图片投影](../bridge/grok-leader/src/image-output.ts)：处理 `tool/result` 和 `tool/ptc-dispatch` 中的图片，通过 attachment store 生成 `dscodeImages` viewer path。因而存在 TUI 接入路径，但本次没有验证这些后端的工具目录、截图或实际输入在 TUI 上成功。

图片还要求 attachment store 和当前模型声明 `inputModalities` 包含 `image`；否则 MCP adapter 返回 image-unavailable 文本，原始值留给程序调用者。文本 accessibility snapshot 不因此消失，但不能宣称任意 DeepSeek 路由都能看截图。[图片准入代码][mcp-tools]。

**普通执行流水线不等于自动受 shell sandbox/逐次审批约束。** 检查的 provider、MCP tool adapter 和 stdio transport 没有调用 `approval.request` 或 `sandbox.confine`：MCP SDK 直接启动经环境清理的子进程；Stagehand 自行启动 Chromium；native CU 同进程调用 SDK。dscode 的 [native approval 桥](../bridge/grok-leader/src/native-interactions.ts)只响应已发起的 `approval/request`，没有额外拦截这些工具。不能把 dscode 的 workspace/read-only shell 权限承诺套到桌面、浏览器或其调试进程上。[MCP transport][mcp-transport]、[tool adapter][mcp-tools]、[Stagehand launch][sh-launch]、[native CU][cu-native-code]。

Cua 自己另有 native authorization/OS permission 检查；0.28.0 的 `standard` 是普通自动化的 promptless 默认，bounded 模式等属于 driver 配置，不是 DSH 的 approval policy。DSH native adapter 未传入自定义授权 host。[Cua 权限模式][cu-upstream]。Playwright 上游工具文档还列出可在 server 进程运行 JavaScript 的 `browser_run_code_unsafe`；本次没有实际发现工具目录，后续 opt-in 应核实是否暴露及其限制，不应将“浏览器工具”理解为纯网页访问权限。[Playwright 目录][pw-upstream]。

费用/凭据只作源码层面的结论：Playwright、Chrome DevTools 和两个本地 Cua adapter 没有额外模型 API key 配置；这不承诺整条工作流免费，DSH 主模型及目标网站仍可能有各自费用/登录要求。Stagehand 则**必须**提供独立 `modelName`/`apiKey`（即使只导航），支持 SDK 所列 OpenAI、Anthropic、Google、Groq、Cerebras 模型，明确不支持 DeepSeek endpoint、`baseURL`、复用 DSH credentials 或 per-call 模型切换；额外推理不进入 DSH Session usage。此 adapter 使用本地浏览器，并未配置 Browserbase Cloud 账号/计费参数。[Stagehand 配置/实现][sh-native]、[限制说明][sh]。

Chrome DevTools adapter 显式传 `--no-usage-statistics`，但没有传 `--no-performance-crux`；1.9.0 官方说明性能工具可能把 trace URL 发往 Google CrUX。故不能把“禁用 usage statistics”概括成“完全无额外网络请求”。[adapter 参数][cd]、[上游网络行为][cd-upstream]。

## 对此次升级的建议

- **最小升级默认不加。** 保持正式 profile 的能力范围；不把这些 experimental 包并入普通 bridge dependency 或标准 preset。
- **优先 opt-in：Playwright launch。** 值得用隔离 profile、独立浏览器和受控页面核实工具目录、操作后读回、Session 生命周期、图片路由和权限范围。Chrome DevTools 可作为需要网络/console/性能诊断时的另一选择，一次只挂一个 browser provider。
- **computer use 单独推进。** 先核实 driver 版本、宿主权限和单工作流协调；MCP 可将原生执行及权限宿主与 leader 分离，native 安装简单但与 leader 共进程。官方 DSH native live test 仅发现工具、执行 `check_permissions(prompt:false)` 和清理，明确不截图/输入，不能拿它证明桌面动作可用。[已有测试范围][cu-test]。
- **Stagehand 暂缓进入最小升级。** 待用户需要自然语言浏览器操作，且独立模型凭据、usage 展示和取消行为有明确产品方案，再作为独立 opt-in。

以上是接入优先级建议；本次只新增本文，没有改生产代码、pin、profile、OS 权限，也没有 commit/push。

[browser]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/docs/subsystems/browser-use.md
[computer]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/docs/subsystems/computer-use.md
[experimental]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/AGENTS.md
[profile]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/docs/user/develop/basic/publish.md
[pw-package]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-playwright-mcp/package.json
[pw]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-playwright-mcp/src/index.ts
[pw-upstream]: https://github.com/microsoft/playwright-mcp/blob/v0.0.80/README.md
[cd-package]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-chrome-devtools-mcp/package.json
[cd]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-chrome-devtools-mcp/src/index.ts
[cd-upstream]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.9.0/README.md
[cd-tools]: https://github.com/ChromeDevTools/chrome-devtools-mcp/blob/chrome-devtools-mcp-v1.9.0/docs/tool-reference.md
[browser-runtime]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-runtime/src/mcp.ts
[sh-package]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-stagehand-native/package.json
[sh]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-stagehand-native/README.md
[sh-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-stagehand-native/src/index.ts
[sh-native]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-stagehand-native/src/native.ts
[sh-launch]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/browser-use-stagehand-native/src/launch.ts
[cu-mcp]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/computer-use-cua-driver-mcp/src/index.ts
[cu-package]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/computer-use-cua-driver-native/package.json
[cu-native]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/computer-use-cua-driver-native/README.md
[cu-native-code]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/computer-use-cua-driver-native/src/index.ts
[cu-upstream]: https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/libs/cua-driver/README.md
[cu-actions]: https://github.com/trycua/cua/blob/cua-driver-rs-v0.28.0/libs/cua-driver/docs/action-support.md
[cu-platform]: https://cua.ai/docs/reference/cua-driver/platform-support
[cu-test]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/experimental/computer-use-cua-driver-native/tests/native.e2e.ts
[mcp-tools]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/mcp/mcp-client/src/tools.ts
[mcp-transport]: https://github.com/deepseek-ai/deepseek-harness/blob/dsh-v0.1.6-alpha.1/packages/mcp/mcp-client/src/transport.ts
