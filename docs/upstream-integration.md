# Upstream integration review — 2026-09-13

Subsequent failure-path findings and verification: [bugfix-review.md](bugfix-review.md).

This review supersedes the pre-pull validation in [architecture-review.md](architecture-review.md).
The user confirmed that the concurrent performance task had finished and asked
to integrate remote work, organize commits, and remove obsolete worktrees.
No push, release, version bump, or daily-profile installation is included.

## Integration decisions

- Preserve the completed local work as `6954720` (based on `34332fa`) and merge
  remote `f6524d4`, rather than restore an older snapshot over the completed
  architecture. Twelve paths required conflict resolution.
- Keep the 544-line composition entry and module ownership. Port remote model
  routing, acknowledged switches, command errors, question identity, MCP scope,
  job deltas, image projection and socket backpressure into their existing owners.
  Model catalog publication resolves native identity against the latest wire
  mapping, without rediscovery or cross-module cache mutation.
- Retain accepted-operation drain, replay-prefix reservation, child-before-workflow
  publication, bounded incremental workflow reads, lazy MCP imports, and late
  final job-output collection. Completed jobs without final output must still be
  observed; the upstream completed-without-output shortcut would lose that output.
- Preserve upstream journaled update recovery and atomic installation. A builtins-only
  `launcher-files.mjs` owns shared file/link operations, eliminating the updater's
  reverse import of the launcher. Healthy launches reuse the TUI version result
  inside the profile lock, while still validating actual runtime versions.
- The new stable bootstrap initially broke macOS native-addon self-repair: it
  loaded the damaged native lock binding before the launcher could replace it.
  A focused regression and actual installed-package run both reproduced this
  (`stable-unit-before.log`, `stable-repair-before.log`). Only pending transaction
  recovery takes the bootstrap lock; ordinary startup reaches the launcher's
  existing preflight/repair/lock sequence. The update E2E now exercises this
  through `profile/dscode.mjs`, not just the internal plugin entrypoint.
- Isolate the ambient-environment E2E probe from the harness's own
  `DSCODE_CONFIG` value. Its previous `env_overlay` assertion reported that
  intentional override as a leak; the real TUI correctly ignores `GROK_CONFIG`
  and accepts the explicit `DSCODE_CONFIG` alias.
- Keep the five performance host peers unbundled and integrate upstream's
  `dsh-scope`/`dsh-shell` peers. Product/SDK/runtime pins remain
  `0.0.14-alpha.12`, `0.1.5-rc.2`, and
  `fb2c4b9e698e30edb738bca4cf0618587db7d203`.

## Verification checkpoint

Checkpoint: `/tmp/dsc-merge.YC3roK`; short Unix-socket E2E directory:
`/tmp/dscmac19.7zBudY`. Build/test dependencies are isolated and pinned; the
checkout's existing `node_modules` was not replaced.

- Forced TypeScript builds pass on Node 22.19.0 and 24.19.0; each also passes all
  **46 files / 840 tests**, with no skips, including architecture ownership,
  real-socket regressions and the newly compiled CLI product tests. Logs:
  `node22-accepted.log` and `node24-accepted.log`.
- `scripts/check.sh` passes. Release-payload tests: 14 pass, one Linux-only
  test skipped on Darwin. This is not a local Linux execution result.
- Fresh `merged-final.tgz` matches 106 source/test/config files and 126 shipped
  source/compiled/launcher files, with seven specified host peers unbundled.
  SHA-256: `fc5ab7bbc01766c72b49abca48982343a2c887f51eb1152e582317e37f1fdb04`.
- Fresh macOS release TUI compiled from the merged Rust source:
  `700b1fc6ed2a32cd3eb2bd302bb4cf4dad2c1577c39be996dfe63b3fd2ab1ed2`.
- Actual installed-package managed-update E2E passes with this new TUI and
  archive: `update-final/update-PASS.json`. Includes native-addon corruption
  repair through the stable entrypoint, package composition, same-version no-op,
  corrupt-asset rejection and preserved fixture user files. Interrupted/atomic
  update recovery regressions also pass in the bridge suite.
- `scripts/check-rust.sh` passes on macOS: **2,160 tests** across pager-bin,
  shell-base, shell, tools, updater and pager, plus `cargo check`. Log:
  `rust-checks.log`. Vendored Rust changes match remote `f6524d4` exactly.
- New TUI + pinned runtime + final package Mac acceptance passes, run **68016**,
  script exit **0**. Report: `/tmp/dscmac19.7zBudY/contracts-68016/PASS.json`;
  log: `macos-accepted.log`. Covers 14 durable-history isolation cases, native
  children/tasks/questions, model and preset switching, replay, external editor,
  paste, full wrapped-cell copy, four real TypeScript LSP queries, archive CRC
  and descendant attachments, persistent Python REPL, interrupt/owner isolation,
  runtime doctor, and actual child-process reaping (PID 93903).

Re-review found no remaining blocking defect in this tested scope. Physical
Cmd-click and Kitty image rendering are not covered; Kitty was not configured.
Linux is not executed locally. The earlier single launcher test timeout under
concurrent compilation is retained in `stable-unit-after.log`; both unchanged
final full suites subsequently pass, including that test.

## Recovery and cleanup

The full-history bundle `.git/integration-backups/pre-pull-2026-09-13.bundle`
was verified before integration. It preserves local commit `6954720`, remote
`f6524d4`, and performance snapshot `e37c1c9`.
The latter is an older partial snapshot: its performance/manifest/launcher
changes are already present in the completed local commit; the 43 differing
files are later architecture work and its tests/docs. It is not a separate
feature to merge over the newer implementation.

Only the main checkout is registered as a worktree; dry-run pruning found no
stale registrations. No user worktree, stash, daily profile, shared runtime or
provider configuration is removed. The obsolete `wip/perf-snapshot-2026-09-13`
branch ref was deleted after verification; its full history remains in the
intentionally retained bundle. To restore just that ref:

```sh
git fetch .git/integration-backups/pre-pull-2026-09-13.bundle refs/heads/wip/perf-snapshot-2026-09-13:refs/heads/wip/perf-snapshot-2026-09-13
```
