# Linux cancellation-fix acceptance — 2026-09-17

Target: product commit `f50525597c5303fe765bf8289f35be8564e18708` on
`wip/linux-cancellation-fix-20260917`, version `0.0.14-alpha.12`, pinned DSH
`fb2c4b9e698e30edb738bca4cf0618587db7d203` (`0.1.5-rc.2`) plus the combined
patch SHA-256
`5c893b2efa320965d19efa64d33fc24c8d72621fe7a259004533bb29d642a748`.
This revision merges the reviewed Linux scope-settlement correction into the
macOS backport carried by [current main](linux-acceptance-2026-09-16.md); that
earlier run's blocking early-cancellation failure is the subject here.

## Status

**Accepted for the executed gates.** The built-provider matrix that failed on
main now passes all 15 cases on Node 22.19.0 and 24.19.0, including every
immediate-disposal ordering. The Python-level owner suites, reaper/namespace
runs, release/runtime/gateway scripts, bridge regression, sandbox-root
project-isolation scenarios, SDK snapshots, snapshot corpus, managed-update E2E
and the full installed-product E2E all pass on the patched revision. This is a
local backport revision, not a published pin; distribution remains a separate
gate. The same merged revision also passes the macOS focused
subprocess/shell/terminal selection described below, and its full macOS source
suite failed only the four host artifacts the paired check itemizes.

## What changed

The combined patch adds the candidate's Linux owner and PTY settlement to the
pinned `subprocess-local` package. Production changes are confined to
`src/linux-scope.ts` and the PTY binding in `src/index.ts`:

- A requested termination observed before the launch request is consumed now
  resolves as cancellation, while genuine startup failures (ENOENT/EACCES and
  recorded launch errors) still reject.
- An active but empty scope owned by the terminated client settles instead of
  reporting a startup failure, and the leftover unit is released best-effort.
- A state observation invalidated by a termination signal is discarded and
  re-queried rather than treated as surviving processes.
- Direct-group SIGKILL requires acknowledged delivery or a proven absent PID,
  and `terminate()` joins direct settlement once before deciding the final
  scope kill. The PTY owner reports its independent settlement separately.

The patch also carries the macOS process-observation backport already present
on main, the upstream platform-selection and cancelled-start fixture
corrections, the authored `bash-startup-timeout` recorded session, and paired
README/i18n plus decision notes. No package manifest, dependency, lockfile,
public subprocess spec, CI runner or vendor source is touched by the Linux
half, and no bridge timeout workaround or command replay was added.

## Executed checks on swoop

Linux x86_64, systemd 255 with the running user manager, one worker per gate and
nice 15. The private root is `/home/hanqing/dscode-fix-linux.K9Q2WD`; caches and
Node 22.19.0 / 24.19.0 archives are reused from the earlier approved run, and
the host's global Node installation is untouched. No sudo, paid model, push or
release is involved.

- Setup reproduced the exact product revision and verified the patch digest
  against `sourcePatchSha256` before any build.
- The fresh official-source Linux runtime and plugin build passed with the
  combined patch checksum; the built CLI reports `0.1.5-rc.2`. Artifacts:
  `dscode-plugin.tgz` `ae7dc9eb…` and
  `dscode-runtime-linux-x86_64.tar.gz` `811ad2e7…`.
- Node 22.19.0 and 24.19.0 each passed the focused source owner and consumer
  selection: 165 passed / 1 skipped per Node, exit 0. The reaper/namespace
  sweep passed 451 cases with 14 platform or optional-tool skips on each Node,
  and the host-side real systemd containment cases ran rather than skipping.
- **The built-provider 15-case matrix passed on both Nodes** (`logs/built-*`,
  `built-*/PASS.json`): ordinary and PTY native cancel after readiness, five
  immediate disposals of each kind, immediate ordinary abort before target
  output, genuine pre-exec ENOENT/EACCES, and direct exit kept separate from
  escaped-descendant cleanup. Each case recorded its owned scope and ended with
  it collected; `/proc` identities and `systemctl show` prove real native
  selection. On main the same matrix failed 9 and 12 cases respectively.
- Node 22.19.0 and 24.19.0 each passed all 44 release/runtime/gateway script
  cases and all 931 bridge cases in 47 files, including the compiled-CLI cases.
- All 16 `test:docs` gates passed. The recorded-session corpus passed 131 cases
  with 2 `win32`-conditional skips and left the source tree byte-identical
  (`test:snapshot`, lib mode). Sandbox-root project isolation, SDK JSON-RPC
  snapshots and ACP snapshots are included.
- Managed-update E2E passed: install, explicit and startup repair of
  missing/corrupt native artifacts, legacy-overlay repair, composed profile,
  same-version no-op, corrupt-asset rejection and preservation of user files.
- Full TUI → DSH → bridge E2E passed on Node 24, run `3684347`, without
  scenario-only flags: real TUI and headless prompts, image submit/reject,
  worktree lifecycle, editor failure recovery, links/table copy, draft stash,
  display switching, durable resume/fork/rewind, goals/tasks/workflows,
  native history and skills, presets/LSP, archives, persistent shell, Python
  REPL, interruption and owner isolation.
- `scripts/check.sh` passed on Linux and the product clone stayed clean at
  `f5052559` with only its main worktree.

## Paired macOS check of the same merged revision

The merge was also built and exercised on Apple Silicon (macOS 26.5.2, Node
24.19.0) from a clean clone of the pinned DSH revision with the combined patch
applied; that worktree's tree hash is `dafcada7`, which is also what the swoop
product clone carries at `f5052559` and what its patched `source-tests`
checkout writes from the same patch. Both hosts therefore exercised one
identical source tree. The focused subprocess/shell/terminal selection passed
**448 tests with 17 platform skips in 22 files (3 skipped)**, exit 0:
`packages/subprocess/subprocess-local`,
`packages/subprocess/subprocess`, `packages/shell/bash-local` and
`packages/terminal/terminal-bash`. The 17 skips are the Linux-only
`linux-execve` (3), `native-containment` (4), `native-windows` (4) and
`windows-inspector` (2) cases plus the environment-conditional
`terminal-bash/local` cases (four: an `/dev/tty` read and three `pwsh`
cases whose interpreter is absent on this host).

The owner-core selection used on swoop (linux-scope, local,
native-containment, process-inspector, terminal, mac-process-table) passed
**162 tests with 4 Linux-only skips in 6 files (1 skipped)**, exit 0.

The **full macOS source suite** then ran on that same patched tree (`dafcada7`,
Node 24.19.0): **1,244 files — 1,228 passed, 12 skipped, 4 failed** and
**22,325 tests — 22,191 passed, 130 skipped, 4 failed**, exit 1. All four file
failures are host artifacts, separated by re-running exactly those four specs
against the pristine pin with the same `node_modules` (A/B, both trees after
`pnpm` resolves on `PATH`: 3 failed / 40 passed, the same three):

- `scripts/browser-bundled-externals.spec.ts`: the `vite build-html` step fails
  on this host's `/private/var/folders` temp path, identically on the pristine
  pin.
- `packages/shell/bash-local/tests/executor.spec.ts > defaults cwd to
  process.cwd()`: the `/tmp` versus `/private/tmp` spelling described below,
  identically on the pristine pin, passing from the physical path.
- `packages/experimental/webworker-runtime/tests/compile/transform-corpus.spec.ts`:
  two `UNEXPECTED BASELINE FAILURE`s read from the prebuilt `lib/`, identically
  on the pristine pin.
- `packages/client/ui-sidebar-documentpreview/tests/pdf-license-bundle.client.spec.ts`:
  `spawnSync pnpm ENOENT`; passes on both trees once `pnpm` resolves, which is
  how the other suite legs already run.

One earlier run of the focused selection executed from the `/tmp` symlink
path recorded a single failure,
`packages/shell/bash-local/tests/executor.spec.ts > defaults cwd to
process.cwd()`, because `bash`'s `pwd` printed the resolved
`/private/tmp` path while the child inherited the unresolved `/tmp`
spelling. It is an artifact of running the checkout through the symlink, not a
product defect; the same file passes from the physical path, and the original
failure is retained alongside the passing logs.

## Snapshot-gate environment notes

The recorded-session corpus is environment-sensitive in two ways that this run
had to satisfy before it could measure the product:

1. Building only the host face left `packages/*/lib/typert.host.js` present but
   the built CLI incomplete; the SDK snapshots then switched off the tsx source
   fallback and failed 18 cases on an inactive-context error. Running the full
   `pnpm run build:lib` (host and client faces) resolved it without any source
   change. This was a build-order defect of the first attempt, not a product
   regression.
2. The corpus expects project-root discovery to fall back to the scenario cwd,
   and the sandbox-root scenario deliberately places its workspace outside the
   temp root. On this host both the task root and the host home are Git
   repositories, so the first attempts discovered the task root (or inherited
   host home skills) instead. The passing run used a private temp root and a
   private home under `/tmp` and `/var/tmp`, both outside every repository; the
   product source, golden fixtures and normalizers were unchanged. The earlier
   Linux candidate run met the same class of issue and recorded the same kind
   of fixture correction.

## Evidence and audit

The post-run audit for this fixture ran as `audit-fix.mjs` against
`/home/hanqing/dscode-fix-linux.K9Q2WD` at `2026-09-17T18:43:00Z` (its own
`checkedAt`; `logs/post-run-audit.json`). It found no new user scopes and no
surviving processes owned by the test root, and all **six** process identities
recorded by this run's `built-*/PASS.json` are absent or replaced: ordinary
and PTY native cancel after readiness plus the direct-exit case on each Node.
Per-case scope collection and the final audit agree. No unrelated process or
scope was stopped, and inactive build and test artifacts remain in the private
root for reproduction.

The first collection archived the wrong audit: `collect-evidence-fix.sh`
still invoked `audit.mjs`, which hardcodes the previous run's root
`/home/hanqing/dscode-main-linux-acceptance.5LA3OP` and reads its
`matrix-*/results.json`. That report therefore covered the earlier run's four
identities (PIDs 408460, 408837, 408055, 408379), not this one's six. The
scoped `audit-fix.mjs` under the same invocation is clean, the retained copy
is `logs/post-run-audit-unscoped-5LA3OP.json`, and the script now calls
`audit-fix.mjs`. The re-collected archive below contains both reports; the
superseded `linux-fix-f5052559-evidence-preaudit.tar.gz`, SHA-256
`170abaf7…`, is the previously recorded artifact and also sits in
`/tmp/dscode-linux-fix.Ht7Km/`.

| Asset | SHA-256 |
| --- | --- |
| `product.bundle` | `26126729e8a521eda9f1df485cb2ebd86b443d99bf9dd9725d522c3edfe95f1d` |
| `dscode-plugin.tgz` | `ae7dc9eb8359221cc28b5a3b70a88f257ac3047ea3e5509d081847545bee1a58` |
| `dscode-runtime-linux-x86_64.tar.gz` | `811ad2e7f79c544ddcb8159246847ce34209e73eb5cbcbdc10828e14847272d0` |
| `dscode` | `4c083ffbbb138144eecec49640561f28a1e8e72d2926288d8f000bc3a34ecd31` |
| evidence archive | `777df810673c574915627bb071d60fe223b09fbcb54eddbea745d4c383fca5fd` |

Remote evidence includes `logs/built-{22,24}.19.0.log` and
`built-*/PASS.json`, `logs/fix-source-reaper-*`, `logs/fix-scripts-*`,
`logs/fix-bridge-*`, `logs/fix-docs.log`, `logs/fix-lib-build.*`,
`logs/fix-snapshot4.*` (with the superseded `fix-snapshot{,2,3}.*` retained as
initial failures), `logs/fix-update.log`, `fix-e2e/contracts-3684347/PASS.json`,
`logs/fix-check.log`, `logs/product-final-*` and `logs/post-run-audit.json`
(with the unscoped report retained as
`logs/post-run-audit-unscoped-5LA3OP.json`, and the superseded first archive
as `linux-fix-f5052559-evidence-preaudit.tar.gz`). Scripts, logs, matrix
results and product evidence are archived as
`linux-fix-f5052559-evidence.tar.gz`; the local copy is
`/tmp/dscode-linux-fix.Ht7Km/` and its hash matches the remote archive.
Bulky test homes, dependencies and build outputs are excluded.

Recovery copies are in the main repository's
`.git/integration-backups/linux-fix-f5052559.bundle` (verified with
`git bundle verify`; the bundle records a complete history for
`refs/heads/wip/linux-cancellation-fix-20260917` at `f5052559`) and
`.git/integration-backups/linux-fix-f5052559-evidence.tar.gz`. Local macOS
logs for the paired check are `mac-focused24-rerun.log` (448/17 pass, exit 0)
and `mac-owners6-24.log` (162/4 pass, exit 0) under
`/tmp/dscode-fix-merge.23286/`, next to the failing `mac-focused24.log` and
the initial `mac-owners24.log`; those logs, both combined patches and the
recovery bundle are archived together as
`.git/integration-backups/linux-fix-f5052559-mac-evidence.tar.gz`, SHA-256
`68733af9487579c3c765d973b2c3e1497e8d7173e8052e5ea47e69dd96b60309`.

## Coverage limits

This run validates the patched local backport revision, not a published
artifact. The full upstream Rust/DSH suites, graphical Kitty interaction,
physical Cmd-click, IME, host clipboard, live paid-model sessions and the
unmerged Browser/Inspector candidates are outside this pass. Distribution
still requires an official remotely fetchable source revision for the pin, as
recorded in [the Linux candidate](runtime-linux-candidate.md#remaining-adoption-gates).

The paired macOS host has since closed those three gaps. Its full source suite
ran with only the four host artifacts listed above failing; the packaged
release assets were rebuilt from this revision and record the pinned
`sourceCommit` and patch digest in `dscode-runtime.json`; and the installed
product E2E consumed those assets end to end — `PASS real TUI + dsh + bridge
E2E run 90442` and `PASS provider-manage e2e run 26084`, exit 0. Assets:
`dscode-runtime-macos-aarch64.tar.gz` (288,548,791 bytes) `58391a0d…` and
`dscode-plugin.tgz` (1,449,255 bytes) `5762ae6d…`; the evidence set is
archived as `.git/integration-backups/macos-full-e549786c-evidence.tar.gz`,
SHA-256 `071079eec1b21433f3c5c5636b9eb98cf680dc46af5c257d5b858f0a471df2f9`.
