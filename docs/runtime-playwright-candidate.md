# Playwright opt-in：实现与 macOS 验证

2026-09-15。结论：已完成一个独立、默认不挂载的实验 bundle，并跑通真实 Chromium 的基础路径；**取消验收仍不通过，因此不合入默认功能、不发布、不安装到日常 profile**。这不是通用安全浏览器。源码依据见[静态审计](runtime-playwright-optin-audit.md)，前置 alpha 迁移见[适配记录](runtime-alpha16-adaptation.md)。

## 候选改动

独立克隆 `/tmp/dscode-alpha16.c6NG8h/product`，分支 `candidate/dsh-alpha16`，新增提交 `edcc8c7bc73f5f6abc550f0c58026e42f2aa5797`，父提交 `5aa44f1a722f9c8982ff487a28b7677c213a2aef`。只新增 `experiments/playwright/` 下 8 个文件、370 行，其中运行入口与 policy 共 74 行，其余为 manifest、bundle patch、说明和测试。没有改默认 bundle/preset、launcher、bridge 或上游源码。

按照最小 Interface 的设计，单个插件共同拥有强制 policy 与上游 provider；Session/MCP/队列/浏览器资源仍由 DSH 实现，审批仍走原生服务，不复制生命周期。所有 SDK 包是精确 peer，使用现有 alpha runtime 的同一份实例。入口固定 headless + launch + isolated，无 attach、用户 profile、任意启动参数或系统权限授权选项。

实验允许 13 个已审阅动作；Node 任意代码、页面 evaluate、上传/drop、tabs 及未审阅/未来工具全部在真实执行层拒绝。也拒绝调用者提供的 `filename`、`paths`、`_meta`。直接导航仅允许显式配置的 HTTP(S) origin，拒绝 credentials 和 `blob:` 等其他 scheme；这不是完整网络限制，点击、脚本、重定向、子资源和下载不受它全面约束。原始 24-tool catalog 仍可见，不能说危险工具已从模型目录隐藏。

允许动作进入原生 ask；没有 answerer 时拒绝。不可覆盖的 guard 负责禁用能力，即使另一个 trusted policy 返回 allow，危险调用也不能执行。并未把“有审批”当作宿主/网络沙箱，也未验证实际 TUI 审批框展示目的 URL。

## 实际验证

环境：macOS arm64，已安装 Chrome `152.0.7977.83` 的可执行文件、全新隔离浏览器状态；显式 Node `22.19.0` / `24.19.0`。SDK 只从 source-built alpha 提取物 `/tmp/dscode-alpha16.c6NG8h/runtime` 解析，版本 DSH `0.1.6-alpha.1` / `0a15e36e7f82b6ed45af6fa9759f29b40dcd965d`，Playwright MCP `0.0.80`。没有使用日常浏览器数据、操作桌面、真实模型请求或 swoop。

两种 Node 的 policy 单测均 4/4；真实 Loader composition + 本地受控页面均完成以下 10 项检查，但 smoke 最终以 **exit 2** 报告取消 gate 未通过，而不是整体绿色：

1. 实际发现目录与静态推导的 24 个工具一致。
2. 普通调用及真实 Node PTC 内部调用都无法绕过 unsafe hard-deny；custom output path、私有 metadata、非允许导航被拒绝。
3. 无审批 answerer 时，导航失败且 fixture 没有收到请求。
4. 配置测试专用 one-shot answerer 后，能导航到随机 loopback 端口上的受控页。
5. fill → click → explicit snapshot 读到 `Hello dscode`，同一 Session 状态保留。
6. 截图进入 attachment authority，并通过现有 `createImageOutputProjector` 得到字节一致的 dscode viewer path；PNG 已检查。这不是完整 TUI 渲染/鼠标点击验收。
7. 两个 live Session 的 localStorage 和页面状态隔离；用第一个 Session 的已写 marker 作阳性对照，第二个仍为空。
8. text-only model route 收到明确 image-unavailable 文本，而不是误投递 image block。
9. 已取消的排队导航没有向 fixture 发请求。
10. Session dispose 与另一个仍活跃 Session 的 provider unload 都移除工具；每轮记录的 18 个 MCP/Chromium 子进程全部退出，末次补查无实验进程残留。

Node 22 证据目录：`/var/folders/f5/rv0zdz_15ljcbs0v40qtns8r0000gn/T/dscode-browser-smoke-zjBGct`。Node 24 最终目录：同一父目录下 `dscode-browser-smoke-V8hCGT`。每个目录有 `result.json`、完整 `catalog.json`、受控页截图和工作区输出；持久备份见下文。

两次前置失败保留：第一次把 click 返回的 snapshot 文件链接误当成 inline 页面内容；第二次用 deepStrictEqual 直接比较 Buffer 和 Uint8Array。分别改为显式调用 `browser_snapshot` 和按相同字节类型比较后通过。第一轮还发现环境中的裸 `node` 已变为 26.7.0，后续显式使用上述 22/24 路径；未把这个测试假设问题归因于 Node 兼容性。

## 取消 gate：已复现，尚未修复

fixture 收到 `/slow` 后暂不发送页面。测试取消该次工具调用，等待 400 ms：工具 promise 已返回 `Error: Controlled cancellation`。随后才释放带脚本的页面；脚本继续向 fixture 请求 `/after-cancel`。Node 22 和 24 均得到：

```json
{"returnedBeforeResponse":true,"pageEffectAfterCancel":true}
```

这是取消返回后仍有新页面活动的运行证据，不只是“无法撤销已经发生的点击”。上游普通取消只将 signal 传到 MCP 调用，navigate handler 未消费它；DSH 在资源 disposed 路径才主动关闭 transport。客户端取消结果不能代表浏览器已停稳。具体实现出处见[静态审计的生命周期分析](runtime-playwright-optin-audit.md#生命周期与需要补的验收)。

下一项最值得追的是 browser/MCP 所有者的取消停稳语义：取消后停止该次浏览器活动并等待确认，或明确关闭该 Session 的浏览器并使后续状态失效。需要同时验证排队调用、另一个 Session 不受影响、正常 dispose、取消期间 unload。没有在 bridge 层拼接进程 kill、伪造 disposed signal 或强制销毁整个 Agent；这些会改变现有所有权和 Session 行为。

## 包内容与保存状态

实验包为 private，`npm pack --ignore-scripts` 产出约 4.1 KB，仅包含 5 个 manifest/入口/policy/patch/README 文件；逐项比对 packed bytes 与候选源文件一致，没有 node_modules、测试、密钥或浏览器数据。这里只检查打包内容，尚未进行真正的 `dsh` profile 安装/激活 E2E。

本地持久备份位于主仓库 `.git/integration-backups/`：

- `dsh-alpha16-playwright-edcc8c7.bundle`：SHA-256 `12eb9dd06e41610fa22fa74b032582492850303c19ef3fc3d180aeec2db6e24c`。已用主仓库 `git bundle verify` 通过；包含此前 alpha 适配及此次实验提交，**需要已有 `db43b2465eaeb73648dbe236ba2b60b8f06fba00`，不是独立全仓库备份**。
- `playwright-optin-edcc8c7-evidence.tar.gz`：SHA-256 `b8e8b78aac7c986a84e05d91007f2268f2a14c51d1b722e5b01beb8bd861ec5c`。包含两种 Node 的结果/目录/截图、前置失败结果，以及实验 tarball。
- 实验 tarball SHA-256：`a41b9edaa1a982196c87a69cdb77e1bf79646bd57225a1a8013b026a45b79abf`。

主线只保存研究/验证记录，production runtime pin 仍是 `0.1.5-rc.2`。候选克隆保持 clean；没有 push、发布、日常安装更新或任何 computer-use 权限变更。完整 TUI 审批/图像展示、真实模型、child/resume、安装态 profile 和 Linux 验收仍待取消问题收敛后再推进。
