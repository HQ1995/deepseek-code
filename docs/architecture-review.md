# Architecture review — integrated source

This is the pre-pull checkpoint. See [upstream-integration.md](upstream-integration.md)
for the subsequent integration of remote `f6524d4` and fresh validation.

Scope: all six work-plan items and invariants in
[architecture-refactor.md](architecture-refactor.md). This is a review of the
integrated shared source. The user confirmed that the performance task had
finished; its final baseline matched the candidate and the seven-file change
was applied once. No performance change was reverted.

Fresh integrated checkpoint: `/tmp/dsc-integrated.nIgLrR`.
The shared entrypoint is now 543 lines, down from the original 6,033-line
closure. This is composition and ownership separation, not a line-count gate.
Product/SDK/runtime pins remain `0.0.14-alpha.12`, `0.1.5-rc.2` and
`fb2c4b9e698e30edb738bca4cf0618587db7d203`.

## Requirement review

| Requirement | Integrated implementation and evidence | Review result |
| --- | --- | --- |
| Model/provider ownership | `model-catalog` owns catalog state, lazy native capabilities, discovery and accepted reads/writes. Its 27 interface tests and two new real-socket regressions cover shutdown through credential/route/cleanup work and background persistence. Credentials remain native; fresh endpoints do not receive resolved secrets. | Integrated; the host awaits catalog disposal. Interface and socket tests pass. |
| Transport lifecycle | `leader-transport` owns framing, registration, sockets and reverse requests; real-socket tests cover authorization, cancellation, disconnection and listener failure. `leader-lifecycle` owns the shared heartbeat, reconnect grace and host drain. | Integrated; socket and host lifecycle tests pass. |
| Sessions, prompts and persistence | Registry/lifecycle/model/preset/work/input/queue/output modules hold distinct native and bridge ownership. Interface and wire tests cover admission/FIFO/steering/settlement, reload recovery, flush-before-dispose, late handles, and stream/replay ordering. | Integrated; exact-owner and durable-order regressions pass. |
| Native features | Commands, discovery, artifacts, interactions, asides, children, tasks, execution, status and capability views own coherent behavior. Scoped interfaces replace the original shared implementation; native PTYs/child producers retain their actual completion semantics. | Integrated; no replacement feature-controller monolith. Interface tests pass. |
| Profile/package lifecycle | Existing profile/package/launcher owners remain separate from session dispatch. Profile mutation tests, launcher/update transaction tests, offline package closure tests and the fresh integrated package's isolated managed-update run pass. | Integrated; five host peers stay unbundled. No daily-profile installation. |
| Composition and verification | Entry code is module assembly, protocol routing and event forwarding. The 28-check architecture gate verifies declared dependencies, no runtime cycles or entry back-imports, public declaration consumption, and no timers/maps/sets/abort controllers constructed in entry code. | Integrated; dependency gates, Node 22/24 suites and fresh full Mac acceptance pass. |

## Latest model-catalog re-review

The previous candidate could complete shutdown while an accepted credential
write or background persistence write was still running. Both failures were
reproduced through the catalog interface and the real socket/host lifecycle.
The new disposal promise waits for public operations, background operations and
parallel native read branches, including branches surviving a sibling's
fail-fast rejection. Admission is recorded before callbacks can reenter shutdown.

Shutdown prevents the first write when it occurs during native validation;
four additional regressions cover add/update with and without a pasted key.
Once a write sequence has begun, shutdown waits for its existing credential,
route retry and unshared-credential cleanup sequence. It does not invent a
cross-service rollback or disguise a native failure as successful cancellation.
Late catalog publication is suppressed. Background discovery remains detached
from first-frame readiness; there is no new polling timer or network retry.

Evidence in `/tmp/dsc-catalog.AWqxiv`: `first-write-before-fix.log`,
`wire-before-fix.log` and `targeted.log`. The initial two interface failures are
retained at `/tmp/dsc-catalog-audit.dnQvQX/ownership-gap.log`.
Unused entry imports were removed; the public `ToolResultContentBlock` export
and durable event augmentations are checked through emitted declarations.

## Integrated verification

- Fresh forced Node 22.19/24.19 builds and both complete suites pass **43
  files/794 tests**, including all 28 architecture checks. Logs:
  `/tmp/dsc-integrated.nIgLrR/node22.log` and `node24.log`. Builds use an
  isolated pinned-SDK workspace; the checkout's existing dependencies were not
  replaced. All 100 source/test/preset and package/build-wiring files match the
  authoritative shared tree byte for byte. The prior focused review also
  passed 333 catalog/host/architecture/socket tests.
- Release-script tests: **12 passed, 1 Linux-only test skipped** on Darwin.
  `scripts/check.sh` passes. These are not Linux execution results.
- Fresh immutable `/tmp/dsc-integrated.nIgLrR/integrated-reviewed.tgz`: SHA-256
  `64fa072a70469d7a0909eb5ead20002852cfa19194cb3469fdcec1260a00a806`.
  Archive verification compares all 124 source/compiled/launcher files and
  verifies that five native host peers are not bundled into the bridge. It
  reproduces the reviewed candidate's exact archive hash. Verification script
  and result: `verify-integrated.mjs` and `verified.json` in that checkpoint.
- Isolated managed-update E2E passes for this package; report:
  `/tmp/dsc-integrated.nIgLrR/update/update-PASS.json`. It covers installed-launcher
  operation, native/startup repair, legacy overlay repair, composition,
  corrupt-asset rejection and preservation of user fixture files.
- Fresh full Mac TUI + pinned-runtime E2E passes for the integrated package,
  run **38320**, with script exit **0**. Log:
  `/tmp/dsc-integrated.nIgLrR/macos-e2e.log`; final report:
  `/tmp/dscmac17.AsEMa8/contracts-38320/PASS.json`. It covers 14 history
  isolation cases, native child/task controls, four real TypeScript LSP queries,
  archive CRC/logs/attachments, persistent Python REPL, interrupt/close/owner
  isolation, runtime doctor and actual process reaping (PID 59392). The unchanged
  full wrapped-cell copy assertion also passes (`table-copy-38320.json`).
- Integration changed exactly seven existing files: entry, model catalog,
  session lifecycle, and architecture/leader/model-catalog/session-lifecycle
  tests. It preserved the MCP/updater lazy imports, awaited MCP mounting,
  incremental workflows, bounded discovery caches and host-peer declarations.
  No old candidate patch should be applied again.

All six architecture work-plan items are integrated and verified. The final
review found no new blocking defect in the tested scope, and there is no
remaining implementation or shared-file coordination dependency for this goal.
The platform coverage gaps and intermittent observation below remain explicit;
successful source verification does not establish an installed or released build.
No commit, push, published release or daily-profile installation was performed.

## Coverage limits

Mac acceptance uses the real TUI and pinned runtime against a local model
fixture and an isolated profile/clipboard. It is not an external-provider or
physical-device test. Linux execution, physical Cmd-click and Kitty rendering
are not inferred from these results.

The earlier wrapped-table-copy failure remains an intermittent observation.
The unchanged full-cell assertion subsequently passed, including candidate runs
19481 and 61580 and integrated run 38320. Source review confirms a 300 ms
processed-event multi-click window and exact entry/range/line matching; the
fixture injects clicks 40 ms apart.
Those facts do not establish why that earlier run copied only its first rendered
line. No TUI timing change or weaker assertion was introduced to claim a fix.
