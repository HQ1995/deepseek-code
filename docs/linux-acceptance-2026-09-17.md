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
gate.

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

The independent post-run audit at `2026-09-17T12:03:48Z` found no new user
scopes and no surviving processes owned by the test root; all four recorded
process identities were absent. Per-case scope collection and the final audit
agree. No unrelated process or scope was stopped, and inactive build and test
artifacts remain in the private root for reproduction.

| Asset | SHA-256 |
| --- | --- |
| `product.bundle` | `26126729e8a521eda9f1df485cb2ebd86b443d99bf9dd9725d522c3edfe95f1d` |
| `dscode-plugin.tgz` | `ae7dc9eb8359221cc28b5a3b70a88f257ac3047ea3e5509d081847545bee1a58` |
| `dscode-runtime-linux-x86_64.tar.gz` | `811ad2e7f79c544ddcb8159246847ce34209e73eb5cbcbdc10828e14847272d0` |
| `dscode` | `4c083ffbbb138144eecec49640561f28a1e8e72d2926288d8f000bc3a34ecd31` |
| evidence archive | `170abaf72ed87631080e491edf5a075ec8f61a34ea3f30525f730374d287d67c` |

Remote evidence includes `logs/built-{22,24}.19.0.log` and
`built-*/PASS.json`, `logs/fix-source-reaper-*`, `logs/fix-scripts-*`,
`logs/fix-bridge-*`, `logs/fix-docs.log`, `logs/fix-lib-build.*`,
`logs/fix-snapshot4.*` (with the superseded `fix-snapshot{,2,3}.*` retained as
initial failures), `logs/fix-update.log`, `fix-e2e/contracts-3684347/PASS.json`,
`logs/fix-check.log`, `logs/product-final-*` and `logs/post-run-audit.json`.
Scripts, logs, matrix results and product evidence are archived as
`linux-fix-f5052559-evidence.tar.gz`; the local copy is
`/tmp/dscode-linux-fix.Ht7Km/` and its hash matches the remote archive.
Bulky test homes, dependencies and build outputs are excluded.

## Coverage limits

This run validates the patched local backport revision, not a published
artifact. The full upstream Rust/DSH suites, graphical Kitty interaction,
physical Cmd-click, IME, host clipboard, live paid-model sessions and the
unmerged Browser/Inspector candidates are outside this pass. Distribution
still requires an official remotely fetchable source revision for the pin, as
recorded in [the Linux candidate](runtime-linux-candidate.md#remaining-adoption-gates).
