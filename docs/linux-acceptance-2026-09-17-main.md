# Current-main Linux re-acceptance — 2026-09-17

Target: product commit `edb47f57ceec534344804d59e2648188e0cffdd2` (local main
after the cancellation fix), version `0.0.14-alpha.12`, pinned DSH
`fb2c4b9e698e30edb738bca4cf0618587db7d203` (`0.1.5-rc.2`) plus the combined
patch SHA-256
`5c893b2efa320965d19efa64d33fc24c8d72621fe7a259004533bb29d642a748`. The pin
and the patch digest are byte-identical to [the cancellation-fix
acceptance](linux-acceptance-2026-09-17.md), so this run re-executes that
acceptance's gates on the revision main carries today. Two production commits
landed on top of the merged fix after that run: `9bd0d4a0` (the picker's
session-list retention cap) and `c556e079` (the pinned-id point query in the
session lifecycle).

## Status

**Accepted for the executed gates on Linux.** The built-provider matrix passes
all 15 cases on Node 22.19.0 and 24.19.0, the owner and consumer suites pass on
both, and so do the reaper/namespace sweep, the release/runtime/gateway
scripts, the 935-case bridge suite, the recorded-session corpus, the
managed-update E2E and the full installed-product E2E. The post-run audit
found no leftover scope, process or worktree. Both new commits are
performance-shaped and were reviewed here without findings: a pinned session
id is answered by one stored id (`store.stat`) instead of a full store list,
and the picker raises the first-prompt cap monotonically to the resident set
plus the pass so a pass cannot evict entries it or a later pass must reuse.
This is a local revision, 42 commits ahead of `origin/main` `f6524d40`;
nothing is pushed and distribution remains its own gate.

## What changed since the accepted revision

- `9bd0d4a0` `perf(picker)`: `SessionListIndex.retainFirstPrompts(candidates)`
  raises the first-prompt cap to the resident set plus the pass before the
  pass opens logs, so nothing a pass or a later pass may reuse is evicted,
  including after a switch to another working directory. Revision semantics
  are unchanged — only eviction still clears a cached revision — and the
  non-positive, non-integer guard leaves a stray call a no-op.
- `c556e079` `perf(bridge)`: `persistedSessionIdInUse` answers with
  `store.stat(id)` instead of `(await store.list()).some(...)`, so testing
  one pinned id no longer walks every project and session directory, and an
  unrelated unreadable log can no longer fail the check for every pinned id.
  `scripts/bench-session-list.mjs` gained `pointQueryMs` so the gap stays
  measured.
- The remaining commits between the two acceptances are benchmarks
  (`e549786c`, `c7589a68`) and the macOS-side soak lane plus its
  documentation (`724020fe`, `154a5a54`, `0aeeebfb`, `53b7dab4`,
`edb47f57`). They do not touch the Linux runtime or plugin payload.

## Executed checks on swoop

Linux x86_64, systemd 255 with the running user manager, one worker per gate
and nice 15. The private root is `/home/hanqing/dscode-main-rerun.H9F3ZD`;
Node 22.19.0 / 24.19.0, the corepack and cargo caches and the upstream
`third_party/grok-build/target` build are reused from the earlier approved
roots, and the host's daily profile is untouched. No sudo, paid model, push or
release is involved.

- Setup cloned the product from a local bundle
  (`2217724d056e1919d7632f9dcc9fb4afb5e64db7170c2206e7b47a849f68c2a2`) and
  asserted the revision, all three `package.json` identities and the patch
  digest against `sourcePatchSha256` before any build
  (`logs/setup-env.txt`).
- The fresh official-source Linux runtime and plugin build passed with the
  combined patch checksum; the built CLI reports `0.1.5-rc.2`. Artifacts:
  `dscode-plugin.tgz` `aad2471a…`, `dscode-runtime-linux-x86_64.tar.gz`
  `013c0ba3…`, TUI binary `4c083ffb…`.
- **The built-provider 15-case matrix passed on both Nodes**
  (`logs/built-*`, `built-*/PASS.json`): ordinary and PTY native cancel after
  readiness, five immediate disposals of each kind, immediate ordinary abort
  before target output, genuine pre-exec ENOENT/EACCES, and direct exit kept
  separate from escaped-descendant cleanup. Every case records the owned PID,
  its `/proc` start time, the `dsh-subprocess-*` / `dsh-terminal-*` scope,
  `systemctl show` state, per-case milliseconds (59–325ms) and
  `remainingScopes: []`.
- Node 22.19.0 and 24.19.0 each passed the focused source owner and consumer
  selection: 165 passed / 1 skipped per Node, host-side Linux systemd
  containment cases included. Under `unshare --user --pid` the
  reaper/namespace sweep passed 451 cases per Node with 14 platform skips
  (absent `pwsh`, Windows Job objects, the macOS kernel table and the
  containment cases that need the host manager).
- Node 22.19.0 and 24.19.0 each passed all 44 release/runtime/gateway script
  cases, all 935 bridge cases in 47 files, and `scripts/check.sh` (bash
  syntax, Node script syntax, version sources agree, `dscode-linux-x86_64`
  prebuilt asset, sha256/uid helpers).
- Managed-update E2E passed: install, explicit and startup repair of a corrupt
  native asset, legacy overlay repair, composed profile, same-version no-op,
  corrupt-asset rejection, preserved user files and installed launcher. The
  full installed-product E2E passed as `PASS real TUI + dsh + bridge E2E run
  2845009`.
- `build:lib` then all 16 `test:docs` gates passed. The recorded-session
  corpus passed 131 cases with 2 `win32`-conditional skips, and the source
  tree is byte-identical before and after the run (`test:snapshot`, lib
  mode, isolated `TMPDIR`/`HOME`).

## Environment repair between the two passes

The first pass ran setup, build, the matrix and the product tests green, then
stopped after the source-owners gate: its `pnpm` dependency-status check
found the `source-tests` modules directory that had been copied from the
earlier approved root, tried to purge and reinstall it, and aborted with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY` because the run has no TTY. No
product file, patch or lockfile is involved; the tree itself was intact.

The repair was one `pnpm install --frozen-lockfile` with `CI=true` against
the shared store (exit 0 in 6.3s, `logs/fix-pnpm-install.log`), and the
gates from source-owners on were re-run by `rerun-resume.sh`
(`logs/rerun-resume-status.txt`). The re-run's logs and exit codes replace
the aborted attempt; the surviving record of the stop is
`logs/run-all-status.txt` (a START without its DONE line) together with
`logs/rerun-incident-note.txt`. Later runs should copy `source-tests`
without `node_modules` and let the standard install run once, or perform
this CI-mode install before the gates.

## Cleanup audit

The post-run audit (`logs/post-run-audit.json`) observed only
`init.scope`, no new user scopes, no residual process, and every PID the
matrix recorded stopped — each with the original cgroup and unit recorded
before termination. The product tree is clean at `edb47f57` with no extra
worktree, and `logs/artifact-sha256.txt` fixes the bundle, plugin, runtime
and TUI hashes. Scripts, logs, matrix results and product evidence are
archived as `linux-main-edb47f57-evidence.tar.gz`, SHA-256
`042b240c5454b4b43d1fc7f9097945e97c28e5c0011769ebe9312bee7319cd54`; the
local copy is `/tmp/linux-main-edb47f57-evidence.tar.gz` and its hash
matches the remote archive. Bulky test homes, dependencies and build outputs
are excluded.

## Coverage limits

This run validates a local revision, not a published artifact: main is 42
commits ahead of `origin/main` and nothing has been pushed, so the upstream
Rust/DSH suites, graphical Kitty interaction, physical Cmd-click, IME, host
clipboard, live paid-model sessions and the unmerged Browser/Inspector
candidates stay outside this pass, as they did for the
[earlier](linux-acceptance-2026-09-17.md) runs. The paired local macOS checks
for this revision are `scripts/check.sh` and the 44 script cases (43 passed,
1 skipped). The descriptor growth seen in the 120-turn soak is attributed in
[the performance notes](performance.md) to the Cordis HMR user-patch watcher
over `$DSH_HOME`, not to the skill provider, and is therefore not a product
defect this acceptance needs to carry.

## Re-run on `dfe46647` after the threshold was reopened

Two production commits landed after the cancellation-fix acceptance —
`9bd0d4a0` (picker) and `c556e079` (bridge) — so the threshold was explicitly
re-approved and re-executed, first at `edb47f57` (the pass above) and again at
`dfe46647ce2f2d809442c63ec61af393af5b0e86`, where main stands today. Nothing
between those two revisions is product code: the delta is documentation plus
`scripts/bench-session-list.mjs` (the per-pass `storeListMs` column).

**Accepted for the executed gates on Linux.** The run re-executed exactly the
approved threshold — the 15-case built-provider matrix, `scripts/check.sh`
and the script/bridge suites, each on Node 22.19.0 and 24.19.0 — in 131
seconds of gate time (setup 7s, build 51s, matrix 4s, tests 67s, check 2s).
Private root `/home/hanqing/dscode-main-dfe46647.Q7WM3D`; the toolchains,
caches and the upstream `third_party/grok-build/target` build are reused from
the earlier approved roots. No sudo, paid model, push or release is involved.

- Setup cloned the product from a local bundle
  (`9dcbc97fe1518ba94e6be2c8793d60d5ebb9582bedc33cf6ce38ef8929ca61e7`) and
  asserted revision, all three `package.json` identities and the patch digest
  `5c893b2e…` against `sourcePatchSha256` before any build, so this run
  consumed the same patch bytes as the accepted one.
- The build passed with the same CLI version `0.1.5-rc.2`, and its plugin
  tarball is byte-identical to the accepted run's artifact (`aad2471a…`,
  1450479 bytes); the runtime tarball is `0eaa6021…`.
- **The built-provider 15-case matrix passed on both Nodes**
  (`built-*/PASS.json`), each case recording its owned PID, `/proc` start
  time, `dsh-subprocess-*` / `dsh-terminal-*` scope, `systemctl show` state
  and milliseconds.
- Node 22.19.0 and 24.19.0 each passed all 44 release/runtime/gateway script
  cases (the same three files under `node --test`) and all 935 bridge cases in
  47 files — 931 passed with 4 macOS-conditional skips per Node. The same suite
  passes 935 of 935 locally on Darwin ARM64, which covers the four skipped
  cases. `scripts/check.sh` reported `PASS` on both Nodes with the version
  sources agreeing on `0.0.14-alpha.12`.
- The post-run audit found only `init.scope`, no new user scope, no residual
  process, and every one of the 6 recorded PIDs stopped with its original
  cgroup and unit recorded first. The product worktree is clean at
  `dfe46647`.
- Evidence: `linux-main-dfe46647-evidence.tar.gz`, SHA-256
  `2d2ffde23f228ad3dd5ba553b55c5516b7bc751fa168d9014cbb9161ac61ff5f`; the
  local copy is `/tmp/linux-main-dfe46647-evidence.tar.gz` and its hash
  matches the remote archive.

**Coverage limits.** This pass re-ran the approved threshold only. The focused
source owner/consumer selection, the `unshare --user --pid` reaper/namespace
sweep, `build:lib` with the 16 `test:docs` gates, the recorded-session
corpus, the managed-update E2E and the full installed-product E2E were not
re-executed: the delta since the accepted revision is documentation plus one
bench script, and the plugin payload hash is byte-identical to the accepted
run. As before, this validates a local revision, not a published artifact:
main is 44 commits ahead of `origin/main` `f6524d40` and nothing is pushed,
so distribution remains its own gate.
