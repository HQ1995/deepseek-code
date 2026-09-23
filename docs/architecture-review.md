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

## Module-depth pass — 2026-09-22

Scope: the bridge after the DSH 0.1.7-alpha.2 adoption. Since the integrated
review above, new features had accumulated in a few owners and the gate had
stopped tracking them:

- `model-catalog.ts` had grown to 1,108 lines mixing four concerns: the
  outbound capability probe, pure llm-pi-ai profile and form rules, wire-catalog
  identity, and the stateful owner. Its `refreshCatalog` was 183 lines.
- `tests/leader.spec.ts` had grown to 7,332 lines, 5,300 of them one describe.
- The dependency gate declared 24 of 42 modules; 18, including `projection`,
  `preset-catalog`, `mcp` and `workflows`, had no dependency budget. Nothing
  bounded module size.

### Changes

| Module | Owns | Seam |
| --- | --- | --- |
| `model-catalog` (1,108 → 502 lines) | Cached snapshots, accepted native reads, discovery scheduling, route writes and disposal | Unchanged `createModelCatalog` interface |
| `wire-catalog` (new, pure) | Wire ids, catalog assembly, selection resolution, effort acceptance | `assembleCatalog`, `resolveSelection` |
| `provider-profile` (new, pure) | llm-pi-ai section reads, form validation and normalization, profile merge, discovered-model persistence decision | Plain functions over settings data |
| `model-endpoint` (new) | The only outbound HTTP the catalog performs: bounded `/models` read and effort parsing | Injected `fetch` |
| `native-seams` (new, types) | Structural contracts for native llm, settings, credentials and default-model services | Shared by catalog, presets and composition |

The rewrite removes three copies of route-id validation, two copies of the
derived credential name and pasted-key handling, and in-place mutation of the
request form. `refreshCatalog` is now native gathering (`readProviderModels`,
`describeProvider`) followed by the pure `assembleCatalog`. Importers now use
the owning module directly; there are no re-export shims.
`sessionEventToUpdates` builds native and PTC tool cards through one pair of
constructors (`toolCallStarted`, `toolCallSettled`), making the shared card
vocabulary a single definition (134 → 85 lines).

`tests/leader.spec.ts` became `tests/support/leader-harness.ts` plus 14 socket
specs (handshake, models, prompts, queue, goals, native, sessions,
permissions, presets, commands, plugins, providers, provider-edits, host) and
`projection.spec.ts` beside `src/projection.ts`. `useLeaderHarness()` replaces
the per-describe setup; test bodies moved verbatim, except one test that read
the describe-scoped harness and now uses the `registry` returned by `start()`.

The gate now requires every module except the composition root to declare its
local dependencies, fails on a declaration that names no module, states
per module whether Cordis may appear as a type or a runtime dependency, and
bounds every source, launcher and test file at 800 lines.

### Evidence

Evidence root: `/Users/hqzhao/AI/dsh-alpha172/run-20260922`.

- Bridge suites against the source-built alpha.2 SDK, Node 24.19.0 and
  22.19.0: 66 files, 1,028 tests each (`logs/arch-final-bridge-node24.log`,
  `logs/arch-final-bridge-node22.log`). Added: 27 direct tests for the new pure
  modules and 23 gate checks.
- Test split: the 275 former `leader.spec.ts` tests keep an identical title
  multiset, all passing (`arch/leader-before.json`, `arch/leader-after.json`;
  generator `arch/split-leader-spec.py`).
- Differential checks of committed against refactored code:
  `endpointReasoningEfforts`, `endpointModelCapabilities` and
  `modelSelectionFromRequest` over 20,000 generated inputs each (13,036
  non-trivial effort maps); `createModelCatalog` refresh plus selection over
  1,500 randomized provider/metadata/default scenarios, 1,137 with qualified
  wire ids and 554 selection errors (`arch/catalog-differential-stats.json`);
  `sessionEventToUpdates` over 20,000 generated tool, PTC, delivery and todo
  events (`arch/projection-differential-stats.json`). All byte-identical,
  including warnings and error messages.
- The new gate checks were confirmed to fail on an undeclared module, an
  801-line file and a Cordis import in a pure module.
- A plugin repackaged from the refactored bridge passed the macOS provider UI
  E2E (run 47668) and the full installed TUI/headless E2E (run 48228, including
  the idle-wakeup chain). `scripts/check.sh` and `git diff --check` pass.

Linux was not rerun for this pass: it changes only platform-independent
TypeScript, and every gate above passed on macOS.

### Remaining candidates

Long functions outside this pass: prompt-queue `control` (180 lines), transport
`accept` (153), preset-catalog `nativeCatalog` (139), profile-plugins
`executeCommand` (124) and entry `dispatchRequest` (111). They own delicate
ordering (queue settlement, socket admission, plugin trust), so each should get
its own interface-first change with differential evidence.
This pass kept `endpointReasoningEfforts` behavior, including dropping an
explicit `wire_value: null` (the camelCase spelling already kept it). A
2026-09-23 fix makes a present snake_case key win, so `off` keeps its `null`
wire value, with a regression test in `tests/model-endpoint.spec.ts`.

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
