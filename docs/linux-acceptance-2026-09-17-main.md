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

## Threshold reopened (2026-09-18)

The first product commit after the `dfe46647` run — `aefb700b`
`perf(telemetry)`, which resolves the traces exporter's blocking OTLP HTTP
client on first export instead of inside startup — reopens the threshold
again. The delta is `xai-grok-telemetry` only (`src/otlp_http.rs`,
`src/otel_layer/mod.rs`, plus the new `tests/otel_traces_export.rs`), no
DSH, bridge or script code, and the change is measured in
[the performance notes](performance.md): the `connect finished` → `app_init`
window drops from 193-242ms to 107-116ms over interleaved before/after
launches, with the export path covered end to end by the new wire test.

It still links into the shipped binary, so `dfe46647` remains the last
accepted Linux revision and a fresh swoop run of the same threshold — the
15-case built-provider matrix, `scripts/check.sh` and the script/bridge
suites on Node 22.19.0 and 24.19.0 — is required at the revision that
contains it before this document can call Linux accepted again.

## Re-run on `243e2616` (2026-09-18)

The owner re-approved the threshold and the run was re-executed at
`243e26164c849c31d06c4c7356355be661859e46`, the head main carries after the
telemetry delta. Pin and patch digest are unchanged
(`fb2c4b9e698e30edb738bca4cf0618587db7d203` and
`5c893b2efa320965d19efa64d33fc24c8d72621fe7a259004533bb29d642a748`), and the
shipped-code delta since accepted `dfe46647` is exactly one commit — the
telemetry crate: the traces exporter's HTTP client is now built on first
export instead of inside startup. The rest of the range is the two
`bench-*-compile-cache.mjs` harnesses and documentation.

**Accepted for the executed gates on Linux.** The run re-executed the
approved threshold — the 15-case built-provider matrix, `scripts/check.sh`
and the script/bridge suites, each on Node 22.19.0 and 24.19.0 — in 134
seconds of gate time (setup 8s, build 50s, matrix 4s, tests 70s, check 2s),
plus a supplementary Linux compile and test of the changed crate that the
JS-level gates never reach. Private root
`/home/hanqing/dscode-main-243e2616.3tYNh9`; toolchains, caches and the
upstream `third_party/grok-build/target` build are reused from the earlier
approved roots. No sudo, paid model, push or release is involved.

- Setup cloned the product from a local bundle
  (`b1ffc8d8eac3cd0b9622b03101c42faa6eb1e380e467c29e44c57faa3c9165ff`) and
  asserted the revision, the `package.json` identities (source commit,
  source patch digest and version) and the patch digest against
  `sourcePatchSha256` before any build (`logs/setup-env.txt`).
- **The built-provider 15-case matrix passed on both Nodes**
  (`logs/built-*`, `built-*/PASS.json`): ordinary and PTY native cancel after
  readiness, five immediate disposals of each kind, immediate ordinary abort
  before target output, genuine pre-exec ENOENT/EACCES, and direct exit kept
  separate from escaped-descendant cleanup.
- Both Nodes passed all 44 release/runtime/gateway script cases, the 935
  bridge cases in 47 files (931 passed, 4 macOS-conditional skips) and
  `scripts/check.sh` with the version sources agreeing on
  `0.0.14-alpha.12`.
- The changed crate was compiled and tested on Linux in that host's warm
  release target (`logs/tui-crate-test.log`, cargo/rustc 1.94.0, 23m09s at
  nice 15): 227 unit tests, all 11 integration binaries — including the new
  `otel_traces_export`, which asserts the deferred client still posts the
  span to a loopback collector — and the doctests all pass, exit 0. This is
  supplementary to the threshold: the JS-level gates never compile the
  vendored tree, so without it the compiled form of the delta would be
  untested on Linux.
- Artifacts: `dscode-plugin.tgz` `aad2471a…` — byte-identical to the
  accepted `dfe46647` run, so the shipped plugin payload is unchanged —
  `dscode-runtime-linux-x86_64.tar.gz` `6678514b…` and
  `dscode-consumer.json` `3ac92597…` (`logs/artifact-sha256.txt`).
- The post-run audit (`logs/post-run-audit.json`) found `newScopes: []`,
  `residualProcesses: []` and all 6 recorded matrix PIDs stopped, each with
  its `/proc` start time preserved for the check. The product worktree is
  clean at `243e2616` with no extra worktree.
- Evidence: `linux-main-243e2616-evidence.tar.gz`, SHA-256
  `364889b70640a96a7e6a954afa6e54a9167ca7fb9c970a6d14a5c427c507dd66`; the
  local copy is `.git/integration-backups/linux-main-243e2616-evidence.tar.gz`
  and its hash matches the remote archive.

**Coverage limits.** This pass re-ran the approved threshold plus the crate
check above. The focused source owner/consumer selection, the
`unshare --user --pid` reaper/namespace sweep, `build:lib` with the 16
`test:docs` gates, the recorded-session corpus, the managed-update E2E and
the full installed-product E2E were not re-executed: the delta since the
accepted revision is one crate inside the vendored tree plus documentation
and bench harnesses, and the plugin payload hash is byte-identical to the
accepted run. As before, this validates a local revision, not a published
artifact: main is 52 commits ahead of `origin/main` `f6524d40` and nothing
is pushed, so distribution remains its own gate.

## Re-run on `6736f162` (2026-09-19)

The owner approved another re-execution and the run was carried out at
`6736f162f14703c61f4807bc6437a8f7877549ba`, the head main carries after the
startup-cost delta. Pin and patch digest are unchanged
(`fb2c4b9e698e30edb738bca4cf0618587db7d203` and
`5c893b2efa320965d19efa64d33fc24c8d72621fe7a259004533bb29d642a748`), and the
shipped-code delta since accepted `243e2616` is exactly one commit: the
startup perf commit takes the auth budget and the tmux probes out of the
launch window — the OTLP provider now seeds `last_token` from a new
in-memory `cached_snapshot()` instead of the disk-reconciling
`snapshot()` (the export path and its 401 retry still call `snapshot()`,
and the accepted `aefb700b` deferral of the OTLP HTTP client is
untouched), and the tmux wait loop replaces its fixed 15ms poll tick with a
1ms start that doubles to a 15ms cap. Two test-side expectations in the
pager-render crate were corrected alongside, and the telemetry crate gained
the unit test that pins the new seed path. The rest of the range is
`0cfd45fb`, a documentation commit, so everything the owner asked about
(`9bd0d4a0`, `c556e079`, `53b7dab4`, `f5052559`) is inside the
previously accepted runs.

**Accepted for the executed gates on Linux.** The run re-executed the
approved threshold — the 15-case built-provider matrix, `scripts/check.sh`
and the script/bridge suites, each on Node 22.19.0 and 24.19.0 — in 135
seconds of gate time (setup 14s, build 50s, matrix 4s, tests 66s, check 1s),
plus a supplementary Linux compile and test of the changed crates that the
JS-level gates never reach. Private root
`/home/hanqing/dscode-main-6736f162.Q2hF0m`; toolchains, caches and the
upstream `third_party/grok-build/target` build are reused from the earlier
approved roots. No sudo, paid model, push or release is involved.

- Setup cloned the product from a local bundle
  (`d34680a61ed9162187cae1c8372481bf8bb4bebdcbf63f323f86d64894ab3ea8`) and
  asserted the revision, the `package.json` identities (source commit,
  source patch digest and version) and the patch digest against
  `sourcePatchSha256` before any build (`logs/setup-env.txt`).
- **The built-provider 15-case matrix passed on both Nodes**
  (`logs/built-*`, `built-*/PASS.json`): ordinary and PTY native cancel after
  readiness, five immediate disposals of each kind — the lane whose failure
  at the pre-fix revision blocked the first acceptance — immediate ordinary
  abort before target output, genuine pre-exec ENOENT/EACCES, and direct exit
  kept separate from escaped-descendant cleanup. Every case records the owned
  PID, its `/proc` start time, the `dsh-subprocess-*` / `dsh-terminal-*`
  scope, `systemctl show` state, per-case milliseconds (50–334ms) and
  `remainingScopes: []`.
- Both Nodes passed all 44 release/runtime/gateway script cases, the 935
  bridge cases in 47 files (931 passed, 4 macOS-conditional skips) and
  `scripts/check.sh` with the version sources agreeing on
  `0.0.14-alpha.12`.
- The changed crates were compiled and tested on Linux in that host's warm
  release target (`logs/tui-*.log`, cargo/rustc 1.94.0, 1h37m at nice 15,
  every gate exit 0): pager-render 1106 passed / 0 failed / 2 ignored,
  including the tmux-probe backoff cases, auth 1, shell
  `credential_provider` 17, telemetry 228 unit tests — the one above 227 at
  the accepted run is the new seed-path test — all 11 integration binaries
  and the doctests. This is supplementary to the threshold: the JS-level
  gates never compile the vendored tree, so without it the compiled form of
  the delta would be untested on Linux.
- Artifacts: `dscode-plugin.tgz` `aad2471a…` — byte-identical to the
  accepted `dfe46647`/`243e2616` runs, so the shipped plugin payload is
  unchanged — `dscode-runtime-linux-x86_64.tar.gz` `08a31516…` (bytes
  differ from `243e2616`'s `6678514b…`, but the tar listing is identical:
  34,501 entries, `diff` 0 lines, and the embedded `dscode-runtime.json`
  still reports `0.1.5-rc.2`, pin `fb2c4b9e…` and patch `5c893b2e…`) and
  `dscode-consumer.json` `3ac92597…` (`logs/artifact-sha256.txt`).
- The post-run audit (`logs/post-run-audit.json`) found `newScopes: []`,
  `residualProcesses: []` and all 6 recorded matrix PIDs stopped, each with
  its `/proc` start time, cgroup and unit preserved for the check. The
  product worktree is clean at `6736f162` with no extra worktree.
- Evidence: `linux-main-6736f162-evidence.tar.gz`, SHA-256
  `5d9d71ca3814bce310aabbed603766940ed0e45c048d852f778d671830e6efa5`; the
  local copy is
  `.git/integration-backups/linux-main-6736f162-evidence.tar.gz` and its
  hash matches the remote archive.

**Coverage limits.** This pass re-ran the approved threshold plus the crate
check above. The focused source owner/consumer selection, the
`unshare --user --pid` reaper/namespace sweep, `build:lib` with the 16
`test:docs` gates, the recorded-session corpus, the managed-update E2E and
the full installed-product E2E were not re-executed: the delta since the
accepted revision is one startup-perf commit inside the vendored tree plus a
documentation commit, and the artifact listing is identical to the accepted
run. As before, this validates a local revision, not a published artifact:
main is 54 commits ahead of `origin/main` `f6524d40` and nothing is
pushed, so distribution remains its own gate. `6736f162` is now the last
accepted Linux revision.
