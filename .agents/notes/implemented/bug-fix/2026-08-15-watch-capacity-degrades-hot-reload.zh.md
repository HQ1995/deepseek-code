# Agent Note: 文件监听配额耗尽时降级热重载，而不是杀死界面

Status: implemented

[English](2026-08-15-watch-capacity-degrades-hot-reload.md) | 中文

## Problem

`dsh` 启动器通过 chokidar 监听器让用户 patch 层保持热更新。当系统文件监听预算耗尽——inotify 实例/监听上限,或进程 fd 表过低——`fs.watch` 以 `EMFILE` / `ENOSPC`(`syscall: 'watch'`)失败。chokidar 4 可能在挂上自己的错误监听器之前就发出该失败,以未处理 rejection 或未捕获异常逃逸,导致整个界面中途崩溃(在 `dsh tui` 中表现为状态栏打印后的裸 EMFILE 崩溃)。

## Decision

热重载监听是便利设施,不是启动的必要条件。监听配额失败现在降级为"本次运行不热重载"并输出一行警告,在三条逃逸路径上全部被容纳:

- `watchUserPatches`(packages/boot/app-boot/src/index.ts):被路由回来的监听启动失败,经 `isWatchCapacityError` 分类后返回 no-op disposer,不再导致启动失败。
- `installFailLoud`(同文件):以未处理 rejection 逃逸的 chokidar 扫描失败被吞掉并告警;其余 rejection 保持原有的致命行为。
- `installUncaughtWatchCapacityGuard`(同文件,由 CLI 启动器在监听建立窗口内安装,见 apps/cli/src/profile-boot.ts):未捕获异常逃逸路径被吞掉并告警;其余未捕获异常重新抛出,保持默认致命行为。

分类器很窄:仅 `code` 为 `EMFILE` 或 `ENOSPC` 且 `syscall` 为 `'watch'`。

## Alternatives considered

**在 vendored HMR/chokidar 内部修逃逸。** 拒绝:逃逸点在 chokidar 内部,vendored HMR 保持与上游一致;容纳处理放在掌控启动存活的 launcher 边界。

**启动期吞掉所有未处理 rejection。** 拒绝:真实插件/加载失败的 fail-loud 语义有承重作用;吞掉范围只限于被分类的监听配额失败。

**注册前探测监听容量。** 拒绝:失败是异步到达的,无法同步探测;防护覆盖同一情形且不会多分配一个 watcher。

**只当环境政策处理(调高 inotify 上限)。** 作为代码答案拒绝:预算是部署侧的事,但界面必须在饱和时也能存活。

## Consequences

健康系统上无任何变化。饱和系统上,该次运行的 `cordis.patch.yml` 编辑不再热更新(重启生效);此前同样条件会杀死进程。警告行会指明降级发生,其余失败路径保持致命行为。覆盖位于 packages/boot/app-boot/tests/app-boot.spec.ts 与 user-patches.spec.ts。
