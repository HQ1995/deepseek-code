# Agent Note: Watch-capacity failures degrade hot reload instead of killing the surface

Status: implemented

English | [中文](2026-08-15-watch-capacity-degrades-hot-reload.zh.md)

## Problem

`dsh` launchers keep user patch layers live through a chokidar watcher. When the system's file-watch budget is exhausted — inotify instance/watch limits, or a tight per-process fd table — `fs.watch` fails with `EMFILE` / `ENOSPC` (`syscall: 'watch'`). chokidar 4 can emit that failure before its own error listener attaches, escaping as an unhandled rejection or an uncaught exception and killing the whole surface mid-session (observed as a raw EMFILE crash in `dsh tui` after the status line printed).

## Decision

A live-reload watcher is a convenience, not a boot requirement. A watch-capacity failure now degrades to "no hot reload this run" with one warning line, contained at all three escape routes:

- `watchUserPatches` (packages/boot/app-boot/src/index.ts): a routed watcher-startup failure classified by `isWatchCapacityError` returns a no-op disposer instead of failing the boot.
- `installFailLoud` (same file): a chokidar scan rejection that escaped as an unhandled rejection is swallowed with a warning; every other rejection remains fatal exactly as before.
- `installUncaughtWatchCapacityGuard` (same file, installed by the CLI launcher around the watcher setup window in apps/cli/src/profile-boot.ts): the uncaught-exception escape route is swallowed with a warning; every other uncaught exception rethrows and keeps the default fatal behavior.

The classifier is narrow: `code` `EMFILE` or `ENOSPC` with `syscall` `'watch'`, nothing else.

## Alternatives considered

**Fix the escape inside vendored HMR/chokidar.** Rejected: the escape is chokidar-internal and the vendored HMR pin stays upstream-identical; containment belongs at the launcher seam that owns boot liveness.

**Swallow all unhandled rejections during startup.** Rejected: fail-loud semantics for real plugin/load failures are load-bearing; the swallow is limited to the classified watcher-capacity failure.

**Probe watch capacity before registering.** Rejected: the failure arrives asynchronously and cannot be probed synchronously; the guards cover the same case without a second watcher allocation.

**Treat it as environment policy only (raise inotify limits).** Rejected as a codebase answer: budgets stay a deployment concern, but the surface must survive saturation either way.

## Consequences

On a healthy system nothing changes. On a saturated system, `cordis.patch.yml` edits no longer hot-reload for that run (restart to pick them up); previously the same condition killed the process. The warning line names the degradation, and every other failure path keeps its fatal behavior. Coverage lives in packages/boot/app-boot/tests/app-boot.spec.ts and user-patches.spec.ts.
