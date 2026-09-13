# Architecture refactor

Status: complete in the shared source after the user confirmed that the
performance task had finished. Node 22/24 builds and full suites, managed-update
and fresh full Mac acceptance pass. The authoritative requirement review
is [architecture-review.md](architecture-review.md).
Baseline: the verified macOS/performance worktree on
`34332fae64857c176e5055562a8d39efcc4808f3` (373 bridge tests, Mac E2E 35828).
Those uncommitted behavior fixes must survive this refactor.

## Objective and invariants

Turn the bridge's 6,033-line entrypoint and shared closure into modules with
explicit ownership, bounded interfaces and independently testable behavior.
The entrypoint must become composition, not a renamed or relocated monolith.
The three product layers remain: the selectively vendored Rust TUI, the DSH
bridge/plugin, and the managed installation/release tooling. Preserve their
existing wire protocol, capabilities, install layout and release provenance.

The refactor must preserve session ownership checks; prompt admission/FIFO/
steering and settlement order; durable flush-before-dispose; late async-result
guards; stream/replay dedup; reverse-request cancellation; provider credential
handling; native-runtime repair; and the preceding performance improvements.
No credentials move to the UI, no provider is removed, and no vendored runtime
fork or published release is implied.

## Work plan

1. **Model/provider ownership:** move catalog caches, discovery, provider
   mutations and credential-reference handling behind a module. Inject the
   actual optional DSH capabilities lazily; do not pass the whole bridge state.
2. **Transport lifecycle:** separate Unix socket/framing, registration,
   ACP request/reply and reverse-request lifetimes from feature handlers.
3. **Session and prompt lifecycle:** give accepted sessions, admission/queue
   state and teardown one owner; isolate persistence/preset/model integration.
4. **Feature projections and controls:** group coherent native features and
   their subscriptions/snapshots instead of placing every new feature in
   `apply()`. Preserve workflow child visibility and event ordering.
5. **Profile/package operations:** isolate bundle audit/install and package
   discovery from interactive session dispatch; review launcher/install seams
   for ownership and cycles without gratuitous rewrites of already deep modules.
6. **Composition and verification:** remove superseded wiring, document the
   resulting dependency direction, add a dependency gate, and re-review the
   architecture and product behavior.

Each step is part of the full objective; completing one module is not completion
of the goal. Dependency categories follow the codebase-design skill: pure
state/projection logic is tested directly, owned local transports through real
fixtures, and external DSH/provider capabilities through narrow test adapters.

## Completion evidence required

- Entry composition contains no provider mutation, socket protocol engine,
  prompt queue engine or feature-specific projection implementation.
- Stateful modules own their caches/subscriptions/pending work and disposal;
  no shared untyped dependency bag, reverse import into the entrypoint, or
  circular runtime import graph replaces the current closure coupling.
- Behavioral tests exercise the new module interfaces. Keep protocol/product
  integration tests; replace obsolete helper-only tests when fully superseded.
- TypeScript builds and bridge suites pass on Node 22.19 and 24.19 against the
  pinned SDK. Managed update E2E and full Mac TUI/runtime E2E pass with a freshly
  packaged bridge. Script and dependency gates pass. Linux execution is only
  claimed if actually run, not inferred from a green Mac test.
- Final review records invariant evidence, remaining platform coverage gaps,
  source-versus-installed state and any unresolved architectural work.

## Progress (historical checkpoints)

The checkpoints below record the state at the time of each review. Their
candidate-only and unapplied-patch statements are historical, superseded by
the integration status above and the final requirement review. Do not apply
any of the historical patches again.

- Baseline inventory: model/provider, connection, session/queue and native
  feature state shared `apply()` before this refactor.
- Model/provider module implemented: catalog/discovery/mutation state and lazy
  SDK capabilities are owned by `model-catalog.ts`; 14 interface tests cover
  credentials, malformed settings, late discovery and selection behavior.
- Transport module implemented: `leader-transport.ts` owns registration,
  sockets, reverse requests, timeouts and disconnect signals; 6 real-socket
  tests cover its interface. Initial complete Node 24 suite: 20 files/393 tests.
- Profile/package slice implemented: `profile-plugins.ts` owns locked audited
  mutations and drains accepted work before shutdown; `package-location.ts`
  centralizes package provenance and the existing launcher profile lock.
  Thirteen interface tests replace five obsolete parser/helper tests while the
  shipped composition and real protocol/plugin-management tests remain.
- Prompt/session ownership implemented: `prompt-queue.ts` owns FIFO, steering,
  admission, edits and settlement; `session-registry.ts` owns publication,
  reservations, accepted lifecycle operations, close/disconnect and shutdown.
  Reload deliberately remains a two-phase operation: failed preflight flush
  retains the exact usable owner, while explicit close always disposes even
  when flush fails. Module coverage: 13 queue and 11 registry tests.
- Output ownership implemented: `session-output.ts` owns stream revision and
  replay admission, counters/usage, wire sequence numbers and asynchronous image
  ordering. Its 13 interface tests include reproduced regressions for early
  promise rejection, replay/live overlap and delayed output's turn timestamp.
- Native task ownership implemented: `native-tasks.ts` owns job subscriptions,
  reminder/job/output snapshots and native controls. Thirteen interface tests
  cover scoped ownership, passive output, producer-confirmed cancellation,
  reminder replay and disposal. The old reminder parser-only test is replaced
  by controls exercised through this interface. The host still has one 500 ms
  heartbeat, not a second task polling timer.
- Child/workflow ownership implemented: `native-children.ts` owns native event
  subscriptions, live workflow state, child discovery, bounded history indexes,
  refresh coalescing, descendant-scoped input controls and interruption waits.
  Fourteen interface tests cover publication order, exact-turn settlement,
  owner withdrawal, history durability and construction/disposal failures.
- Native status ownership implemented: `native-session-status.ts` owns goal
  snapshots, native activity/context subscriptions, accepted goal commands and
  their cancellation/drain. Ten interface tests cover exact ownership, dormant
  goals, lazy projections, malformed native results, partial construction and
  reentrant disposal. Context reads also reject retired session identities.
- Session model ownership implemented: `session-models.ts` owns native model
  references, durable/legacy selection decoding, per-provider/model effort
  memory, sequential selection writes, discovery reconciliation and scoped
  catalog notifications. New/load/fork share a prepared model handle; the
  entrypoint no longer maintains or mutates those references/caches. Thirteen
  interface tests exercise native assembly/request coupling, selection history,
  failed writes, owner retirement, reentrant shutdown and optional capabilities.
- Session preset ownership implemented: `session-presets.ts` owns lazy roster
  resolution, grok-profile fallbacks, durable selection history, composition
  rollback, default writes and management views. New/load/fork use one prepared
  composition interface. Sixteen interface tests cover the selection policy,
  one-shot adoption, failure recovery, mutual exclusion, owner withdrawal and
  pending-write drain; two additional real-socket tests cover input admission
  during recompose and close-before-native-disposal ordering.
- Session lifecycle ownership implemented: `session-lifecycle.ts` owns native
  new/load/fork/rewind preparation, target-id reservations, one shared resource
  adopter, initialization admission, durable inspection and replay completion.
  It composes the existing registry/model/preset/queue/output owners rather than
  replacing them with another monolith. Fifteen interface tests cover factory
  failure, permission/default ordering, failed publication/projection cleanup,
  exact-owner retirement, closed clients, read handles and fork boundaries.
  Registry coverage is now 17 tests and queue coverage 14; two new real-socket
  tests exercise reversible reload admission and accepted model-write settlement.
- Native interaction ownership implemented: `native-interactions.ts` owns
  permission policy/CLI metadata validation, plan-mode controls, approval and
  user-question subscriptions, accepted human waits and cancellation. It takes
  exact-session admission and narrow native/transport capabilities, not a Cordis
  context or the shared closure. Sixteen interface tests cover one-shot grants,
  flat question projection, malformed replies, native abort, replacement owners,
  reversible reload, reentrant disposal and partial native mutation failures.
  Transport coverage is now eight real-socket tests: request-scoped abort removes
  listeners and pending entries without cancelling sibling requests. Two new
  protocol tests verify single native question cancellation and recovery after
  a permission write failure; existing reload/recompose tests now also verify
  permission notifications cannot bypass the input gate.
- Per-session operation ownership implemented: `session-work.ts` owns accepted
  native/read operations, cancellation generations and real completion drains.
  The registry suspends admission before reload cancellation and awaits model
  and native work before idle/flush/capture; irreversible close withdraws the
  record, cancels work and waits before final flush/native disposal. Each
  feature retains its native behavior and independent module-disposal owner.
  Goal, reminder, child/inbox, plugin/preset commands, btw, terminal and title
  controls use the session owner. Child projection/history reads and bound
  command/skill discovery, archive and reference reads join its drain too.
  Seven operation-interface tests and three new registry tests exercise the
  ordering; native feature tests cover late lookup/write prevention and abort
  cleanup. Four new protocol cases cover held goal/plugin commands, cancelled
  unknown-command fallback and late btw handle cleanup. Lifecycle coverage is
  now 16 tests and verifies initialization reads and exact native/client liveness.
- Shared prompt admission implemented: `prompt-content.ts` separates ACP block
  validation from native image batch admission. Three interface tests cover
  block order, batch-wide canonical encoding validation before storage and
  native-error classification. Queue and child controls use this module without
  importing the entrypoint; existing index algorithm/performance tests remain
  because those lower-level invariants are not superseded by ownership tests.
- Dependency gate implemented in `tests/architecture.spec.ts`: local-edge
  resolution, explicit computed imports, runtime cycles, type-only back edges,
  extracted-module dependencies and mutable-state regression checks. It checks
  the extracted modules, not completion of the remaining entrypoint work.
- Checkpoint verification (2026-09-13): TypeScript build passes; Node 22.19.0
  and 24.19.0 each pass 24 files/434 tests, including the 9 dependency checks.
  `scripts/check.sh` passes on Darwin arm64; script tests pass 13/14 with the
  Linux-only signal launcher test skipped on macOS.
- Fresh-package verification: managed update E2E passes at
  `/tmp/dscarch.zGRaLQ/update-stage3/update-PASS.json`; full Mac TUI/runtime
  E2E **78789** passes at `/tmp/dscmac-arch1/contracts-78789/PASS.json`.
  These use the staged architecture bridge, not the pre-refactor artifact.
  Logs and build/test checkpoints are under `/tmp/dscarch.zGRaLQ`.
- Output/task checkpoint: Node 22.19.0 and 24.19.0 each pass 26 files/462 tests;
  dependency checks now cover both new modules (11 checks total). The suite
  includes the concurrently developed asynchronous MCP adapter and its wiring;
  that performance change is preserved, not attributed to this refactor.
  Mac runtime E2E **5093** and managed update pass before the final timestamp
  fix. The immutable final package is
  `/tmp/dscarch.zGRaLQ/output-tasks-final.tgz` (SHA-256
  `c2d1354734e1c98bd618c93d07b598af77e9faba0a8dfdf88a9e05c347df32f8`).
  Its fresh-package verification passes: Mac E2E **19962** at
  `/tmp/dscmac-arch3/contracts-19962/PASS.json`, and managed update at
  `/tmp/dscarch.zGRaLQ/update-output-tasks-final/update-PASS.json`.
- Child/prompt checkpoint: TypeScript builds pass on both pinned Node versions;
  Node 22.19.0 and 24.19.0 each pass 28 files/481 tests. The dependency gate now
  has 13 checks, including the new module directions and feature-state
  regression checks. Logs: `/tmp/dscarch.zGRaLQ/children-node22.log` and
  `children-node24.log`. Immutable package:
  `/tmp/dscarch.zGRaLQ/children-final.tgz` (SHA-256
  `b7522c2df736bcad338fc1c42c4ebdd9957ba2973d4337ec06e99cd44d0da15a`).
  Managed update passed, but Mac E2E **61310 failed**: the restarted workflow
  list was empty. `/tmp/dscmac-arch4/contracts-61310/tui-7.log` records the load
  response at 06:56:44.470 followed by dropped replay updates at 06:56:44.506.
  The snapshot implementation waited for child restoration, but its caller
  acknowledged `session/load` without awaiting it. This checkpoint is not a
  passing product artifact despite its green bridge suite.
- Replay/status correction: three real-socket regressions reproduce premature
  responses on new/load/fork, then verify child-before-workflow-before-response.
  Load hydrates transcript and descendants concurrently and awaits both before
  closing the replay window. The intermediate corrected package passed Mac E2E
  **89887** (`/tmp/dscmac-arch5/contracts-89887/PASS.json`) and managed update
  (`/tmp/dscarch.zGRaLQ/update-status-replay/update-PASS.json`). Further lifecycle
  review fixes below require their own fresh-package verification.
- Lifecycle re-review checkpoint: targeted interface/protocol tests pass
  **5 files/287 tests**. TypeScript builds pass on both pinned Node versions;
  Node 22.19.0 and 24.19.0 each pass **29 files/502 tests**, including 14
  dependency checks. Logs: `/tmp/dscarch.zGRaLQ/lifecycle-review-node22.log`
  and `lifecycle-review-node24.log`.
  `scripts/check.sh` passes on Darwin arm64 and script tests pass **13/14**,
  with the Linux-only launcher signal test skipped. Immutable package:
  `/tmp/dscarch.zGRaLQ/lifecycle-review-final.tgz` (SHA-256
  `806076b62d9aee932ae331f38e94e1e22fefe0fa7e498abf7489f5f2ae871970`).
  Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-lifecycle-review/update-PASS.json`.
  Fresh-package Mac E2E **4046 passes** at
  `/tmp/dscmac-arch6/contracts-4046/PASS.json`; the process exited successfully.
  Full log: `/tmp/dscarch.zGRaLQ/e2e-lifecycle-review.log`. Final source and
  launcher directories match the tested stage. No Linux run is claimed.
- Session-model checkpoint: TypeScript builds pass on both pinned Node versions;
  the 233 protocol tests and 13 model-interface tests pass. The immutable package
  `/tmp/dscarch.zGRaLQ/session-models-final.tgz` (SHA-256
  `2fe05cf27102047d1fa96794f75fadf7f40951e79d8a7703996933487e4b79d5`)
  has all 56 compiled files byte-compared against the tested stage. Node 22/24
  each pass 30 files/517 tests; managed update passes under
  `/tmp/dscarch.zGRaLQ/update-session-models` and Mac E2E **35246** passes at
  `/tmp/dscmac-arch7/contracts-35246/PASS.json`. These precede the public type
  entry correction below, which requires a new final package/checkpoint.
- Final model/type checkpoint package:
  `/tmp/dscarch.zGRaLQ/session-models-reviewed.tgz` (SHA-256
  `9c3cf3f6d1558fbff60db564e9c050637e724b8a02c9892a8791940876c6faed`).
  Both Node suites pass **30 files/518 tests**, recorded in
  `/tmp/dscarch.zGRaLQ/session-models-reviewed-node{22,24}.log`.
  All 88 packaged source, compiled and launcher files match the tested stage.
  Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-session-models-reviewed/update-PASS.json`.
  Mac E2E **50826 passes** at `/tmp/dscmac-arch8/contracts-50826/PASS.json`;
  the process exited successfully. Full log:
  `/tmp/dscarch.zGRaLQ/e2e-session-models-reviewed.log`. Source/launcher files
  still match the tested stage at final review.
  Script gates pass (13 script tests plus one Linux-only skip;
  `scripts/check.sh` passes on Darwin arm64).
- Preset checkpoint: both pinned Node builds pass, and Node 22.19/24.19 each
  pass **31 files/537 tests**, including 17 architecture checks. Logs:
  `/tmp/dscarch.zGRaLQ/presets-node{22,24}.log`. Immutable package:
  `/tmp/dscarch.zGRaLQ/session-presets-final.tgz` (SHA-256
  `1827f7d15c6e8497c0a1fa34ae75ceb90562c5eed80ebc20e6fa9df2535d7f6c`).
  All 91 packaged source/compiled/launcher files match the tested stage.
  Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-presets-final/update-PASS.json`; full Mac E2E
  **74436** passes at `/tmp/dscmac-arch9/contracts-74436/PASS.json`, with terminal
  exit 0. Script checks pass on Darwin arm64 (13 script tests, one Linux-only skip).
- Final preset review removes a misplaced roster comment from the entrypoint
  and adopts the parallel task's package/lockfile changes without editing them.
  Those changes classify five DSH runtime packages as host peers instead of
  ordinary plugin dependencies. A fresh, empty staging directory produces
  `/tmp/dscarch.zGRaLQ/session-presets-reviewed.tgz` (SHA-256
  `2812f32860cbf219407a8b218cdd0c35cd4bd39567f7262e73834589bb03362c`).
  All 91 source/compiled/launcher files and manifest dependency declarations
  match the tested stage; none of the five host peers is bundled. Both Node
  suites again pass **31 files/537 tests** (`presets-reviewed-node{22,24}.log`).
  Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-presets-reviewed/update-PASS.json`. Final Mac E2E
  **92280** passes at `/tmp/dscmac-arch10/contracts-92280/PASS.json`, and the
  process exits 0. Full log: `/tmp/dscarch.zGRaLQ/e2e-presets-reviewed.log`.
  This includes native preset copy/read/edit/restart, workflow restoration,
  real TypeScript LSP, durable archives and persistent terminal controls.
  Source, tests, launcher files and package/lock manifests still match the
  tested stage at final review. The independent performance task also ran its
  own isolated TUI acceptance concurrently; this checkpoint's assertions and
  terminal success are recorded in the architecture run's own artifacts.
- Lifecycle checkpoint: both pinned Node builds pass. Node 22.19/24.19 each pass
  **32 files/558 tests**, including 18 architecture checks, recorded in
  `/tmp/dscarch.zGRaLQ/lifecycle-final-node{22,24}.log`. Immutable package:
  `/tmp/dscarch.zGRaLQ/session-lifecycle-final.tgz` (SHA-256
  `aae33e82ce39c6defa6139a05f60f972354674be3f0456d3b5969df3ea1dad78`).
  All 94 source/compiled/launcher files and manifest dependency declarations
  match the tested stage; the five host peers remain unbundled. Managed update
  passes at `/tmp/dscarch.zGRaLQ/update-lifecycle-final/update-PASS.json`.
  Script checks pass on Darwin arm64 (13 script tests, one Linux-only skip).
  Full Mac E2E **41616** passes at
  `/tmp/dscmac-arch11/contracts-41616/PASS.json`; the process exits 0.
  Log: `/tmp/dscarch.zGRaLQ/e2e-lifecycle-final.log`. This includes headless
  new/resume/fork, real TUI replay/workflow restoration, preset switching,
  native controls, LSP, archives and terminal ownership. Source, tests, launcher
  files and package/lock manifests still match the tested stage at final review.
- Native interaction checkpoint: Node 22.19 and 24.19 forced TypeScript builds
  pass, and each complete suite passes **33 files/579 tests**, including 19
  architecture checks. Logs:
  `/tmp/dscarch.zGRaLQ/interactions-final-node{22,24}.log`. Immutable package:
  `/tmp/dscarch.zGRaLQ/native-interactions-final.tgz` (SHA-256
  `d614345d9d45bc7710f9e2112b73e82d5e0a25afc76f6de46d8cd80d2e96dc29`).
  All 97 packaged source/compiled/launcher files match the tested stage,
  including the Node 22 rebuild; manifest dependencies agree and the five host
  peers remain unbundled. Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-interactions-final/update-PASS.json`.
  Script checks pass on Darwin arm64 (13 tests pass, one Linux-only skip).
  Full fresh-package Mac E2E **59716** passes at
  `/tmp/dscmac-arch12/contracts-59716/PASS.json`; the process exits 0.
  Log: `/tmp/dscarch.zGRaLQ/e2e-interactions-final.log`. The real TUI human
  question path, durable resume/fork, native controls, preset switching, LSP,
  archive and terminal checks all pass. Final source, test, launcher and
  package/lock files match the tested stage. This is source/package validation;
  no live installed profile, published release, commit or push was changed.
- Session-work checkpoint: forced Node 22.19/24.19 TypeScript builds pass and
  both complete suites pass **34 files/598 tests**, including 20 architecture
  checks (`/tmp/dscarch.zGRaLQ/work-final-node{22,24}.log`). Immutable package:
  `/tmp/dscarch.zGRaLQ/session-work-final.tgz` (SHA-256
  `0bd77ffb838124064f1ccb97ec68ea14d2aebd4ca824609f4e26aed7eaf81cff`).
  All 100 packaged source/compiled/launcher files match the tested stage;
  the Node 22 rebuild emits identical compiled bytes. Manifest declarations
  match and the five host peers remain unbundled. Managed update passes at
  `/tmp/dscarch.zGRaLQ/update-work-final/update-PASS.json`; Darwin script checks
  pass with 13 script tests and one Linux-only skip. The first Mac attempt
  **86540** failed the full-cell copy assertion (see interaction uncertainty
  below). The same package, TUI and unchanged test then pass the complete Mac
  E2E **90840**, with exit 0 and
  `/tmp/dscmac-arch14/contracts-90840/PASS.json`. Successful full log:
  `/tmp/dscarch.zGRaLQ/e2e-work-rerun.log`. Native controls, workflow replay,
  preset operations, LSP, archives and terminal ownership pass in that run.
  Final source, test, launcher, package/lock and compiled files match the
  tested stage. No live installed profile, commit, push or release was changed.
- Independent owner re-review while the performance task's shared-file scope
  is being coordinated: changes are limited to `session-registry.ts`,
  `prompt-queue.ts`, their interface tests and this log. MCP, the entrypoint,
  dependency manifests and startup/performance files are untouched in this
  checkpoint. Fourteen new tests cover reproduced cancellation, disposal and
  output-settlement failures; no interface was expanded to pass cleanup
  responsibility back to callers.
  - Reload attempts every cancellation hook and both model/native drains even
    if an earlier hook throws. Input stays suspended until accepted work
    settles; original errors remain observable, including multiple and
    synchronous settlement failures.
  - The registry publishes a per-record preflight borrow before callbacks may
    reenter close. Explicit close withdraws the record immediately, but waits
    for an in-flight reload idle/flush/capture phase before its final flush and
    native disposal. Successful reload releases its borrow before retiring
    itself, avoiding a self-wait; failure releases it without masking close's
    independent cleanup error. A reentrant close during capture cannot return
    a successful stale snapshot.
  - The prompt queue retires active/held rows even when native cancellation or
    notification throws. Its one-shot disposal promise is published before
    reentrant callbacks and waits for accepted preparation/output settlement
    before reporting cancellation failure. Output hydration or completion
    notification failure cannot strand running/steered ownership or stall the
    successor. A failed output flush does not emit successful completion.
    Re-review strengthened the two recovery cases to exercise send-now and
    reproduced a stale cancellation marker on the successor. The marker now
    retires with the original prompt even if output or notification fails;
    both cases pass without weakening their failure assertions.
  - Forced builds pass on Node 22.19 and 24.19; each full suite passes **34 files
    /612 tests**, including the 20 architecture checks. Logs:
    `/tmp/dscarch.zGRaLQ/owner-reviewed-node22.log` and
    `/tmp/dscarch.zGRaLQ/owner-reviewed-node24.log`. Immutable verification package
    `/tmp/dscarch.zGRaLQ/session-owner-reviewed.tgz`, SHA-256
    `9c11c54a5ea2d63a3bd451e4ba8f1680586c6cdec84a042b3ff38d1e8aaa06e7`:
    all 100 source/compiled/launcher files match the tested stage after both
    builds; the five host peers remain unbundled. Darwin script checks pass.
    Full Mac TUI and managed-update E2Es have **not** been rerun for this new
    package; preceding checkpoints do not prove these changes. No installed
    profile, commit, push or release was changed. Remaining extraction and
    final-package product verification below are still required.
- Session discovery is prepared, **not yet wired into the shared entrypoint**.
  The worktree now contains `session-discovery.ts`, 18 interface tests and its
  dependency gate. It owns cold read handles, pending reads, event subscription
  and persistence-instance-scoped indexes. Existing first-prompt LRU, revision
  reuse, four inspection lanes, request snapshots, cwd prefiltering and exact-id
  cross-cwd resume remain in use; `session-list.ts` was not modified. Closing
  cancels native listing/open/read/search where supported and still waits for
  actual completion and every late handle's uncancellable close. Queued/sibling
  inspections remain tracked even after their parent list rejects. Only an
  unavailable artifact may be skipped; handle-cleanup errors cannot be hidden
  by that policy. Search retains its request's index generation and invalidates
  old picker titles after a persistence remount without reading matching logs.
  These error/freshness distinctions were exercised with failing interface
  tests before correction. The current worktree's forced Node 24 build and
  3 focused files/55 tests pass (`/tmp/dsc-discovery.A1nfGU/worktree-targeted.log`).
- An integrated discovery **candidate** is separately verified at
  `/tmp/dsc-discovery.A1nfGU/bridge/grok-leader`. It moves legacy listing and
  cold inspection out of lifecycle, removes picker/search implementation from
  entry composition (1,347 to 1,217 lines), and joins discovery disposal into
  host quiescence. Five additional real-socket tests prove standalone reads
  hold host shutdown without a published session and a late returned handle
  closes without being read. One superseded lifecycle inspection-only test is
  replaced by the discovery interface tests; existing wire and index tests
  remain. Forced Node 22.19/24.19 builds and both full suites pass **35 files
  /635 tests**, including 21 architecture checks. Logs:
  `/tmp/dsc-discovery.A1nfGU/reviewed-node22.log` and
  `/tmp/dsc-discovery.A1nfGU/reviewed-node24.log`. The first full attempt had a
  missing `VERSION` caused by the isolated directory layout; correcting the
  fixture layout, not the assertions, restored CLI test collection.
  Candidate package `/tmp/dsc-discovery.A1nfGU/discovery-reviewed-candidate.tgz`,
  SHA-256 `c2238629c6868c00227e91e8321a8a32ce0e35611a5076cf55bd70aac8e0d5ec`:
  all 103 source/compiled/launcher files match the candidate after both builds,
  and the five host peers remain unbundled.
- Pending discovery integration is captured in
  `/tmp/dsc-discovery.A1nfGU/integration.patch`, with exact pre/post file hashes
  in `baseline-hashes.json` beside it. Its only remaining differences from the
  worktree are `src/index.ts`, `src/session-lifecycle.ts`, and the architecture,
  leader and lifecycle tests; `git apply --check` passes against the current
  worktree. **It has not been applied** while the other performance task's
  shared-file scope remains unconfirmed. MCP, startup, dependency and index
  performance files are unchanged. No current installed profile or release is
  updated; no full Mac or managed-update E2E has run for this candidate. The
  shared worktree therefore still has the discovery ownership gap below;
  candidate test results are not evidence that it is already fixed there.
- Session command ownership is prepared, **not yet wired into the shared
  entrypoint**. `session-commands.ts` now owns catalog/skill projection, native
  and builtin precedence, ambient refresh subscriptions/coalescing, turnless
  presentation and accepted command/read shutdown. Its 21 interface tests
  exercise the actual session-work owner, not private helper exports. Ordinary
  prompt and unknown-command-without-registry paths remain synchronous so a
  same-tick cancel cannot overtake queue admission. Native commands retain raw
  images and receive combined session/shutdown cancellation; accepted profile
  and preset transactions retain their own atomic mutation owners. Cancelled
  generations suppress late output and cannot fall back into model admission.
  Construction/disposal tests cover registration rollback, reentrancy, every
  unsubscribe and real completion even when a native operation ignores abort.
  The builtin refusal lookup now checks own properties: `/constructor` and
  `/__proto__` no longer resolve to inherited object properties. The exact
  shared-worktree source, without candidate wiring, passes a forced Node 24
  build and **3 files/61 tests** in `worktree-targeted.log` under
  `/tmp/dsc-commands.rowtvJ`.
- Combined discovery/command **candidate**, separate from the shared worktree:
  `/tmp/dsc-commands.rowtvJ/bridge/grok-leader`. Its entrypoint is 965 lines,
  versus the shared worktree's unchanged 1,347. Five additional socket tests
  cover initialize/unbound catalog shutdown while preset discovery is pending,
  stale skill-read refresh coalescing, and model admission for prototype-named
  unknown commands with and without a native registry. The two unknown-command
  tests initially expected `end_turn`; the existing turnless model mock correctly
  returns `cancelled` at idle. Their expectation now follows that established
  fixture contract, with exact model followups still asserted.
  Forced Node 22.19/24.19 builds and both full suites pass **36 files/662 tests**,
  including 22 architecture checks. Logs are `reviewed-node22.log` and
  `reviewed-node24.log` under `/tmp/dsc-commands.rowtvJ`.
  Immutable package `commands-reviewed-candidate.tgz` there has SHA-256
  `218f6f9ae96e55eee4a1d8f04a7724b98fc69b52b06cf2d0b2bb779ec9f4d37a`.
  All 106 source/compiled/launcher files were byte-compared with the candidate;
  the five host peers remain unbundled. No MCP, startup, manifest or lockfile
  was edited for this slice.
- The combined `/tmp/dsc-commands.rowtvJ/integration.patch` and adjacent
  `baseline-hashes.json` supersede the discovery-only patch; they are **not
  applied**. Apply only the combined patch after shared-file coordination and
  fresh baseline checks, not both patches. Its five changed existing files
  remain the entrypoint, lifecycle, and architecture/leader/lifecycle tests;
  the new module/interface-test files already match the shared worktree.
  `verify-candidate.mjs` there rechecks both file hashes, all candidate/worktree
  differences, packaged bytes and host-peer exclusion; it passes after both
  builds, as does `git apply --check`. Darwin `scripts/check.sh` passes.
  Full Mac TUI and managed-update E2Es have not run
  for this combined candidate, and the earlier product checks do not prove it.
  The installed profile and release are unchanged. The shared dependency gate
  now checks the new command module but deliberately does not pretend the
  unintegrated entrypoint extraction is already complete.
- Native execution ownership is prepared, **not yet wired into the shared
  entrypoint**. `native-execution.ts` owns runtime-diagnostic subprocess reads,
  execution-host availability checks, terminal roster/tail projection and
  accepted interrupt/close requests. Native DSH still owns PTYs and their
  process groups. The interface accepts only exact-session ownership, scoped
  terminal/subprocess/tool capabilities and a profile-directory getter; no
  Cordis context or shared entry closure is passed in. The installation-reader
  seam has the actual bounded Node subprocess adapter and a test adapter.
  Seventeen interface tests cover authorization, input readiness, native
  failures, missing dependencies, malformed findings, reentrant cancellation
  and real operation drains. Profile lookup is captured once per inspection;
  terminal IDs leave the module as ordinary wire strings, keeping native
  branded implementation types out of emitted declarations.
- Execution re-review corrected continuation after owner cancellation: a held
  installation/executable lookup may finish, but cannot perform the next
  lookup, project PTY state or read a terminal tail afterward. Native roster
  getters that reenter cancellation cannot be followed by a kill or signal.
  The original `execFile` Promise can reject on its error event before process
  close. Three process-adapter regressions reproduced early completion, then
  passed after attaching the drain to the child `close` event. A fourth test
  launches an actual diagnostic Node process and verifies process-close before
  module-drained ordering. `process-before-fix.log` under
  `/tmp/dsc-execution.zRqhET` retains the three failing regressions.
  Shared-worktree source passes a forced Node 24 build and **3 files/44 tests**
  (`worktree-reviewed.log` there). Two candidate-only socket tests cover close
  during executable discovery and host shutdown during an uncancellable native
  terminal kill, including parent flush/native disposal ordering. The first
  discovery test incorrectly used ordinary `session/cancel`; it now uses
  `session/close`, preserving the existing distinction between model-turn
  cancellation and session-operation withdrawal.
- Combined discovery/command/execution **candidate**:
  `/tmp/dsc-execution.zRqhET/bridge/grok-leader`, with an 884-line entrypoint.
  Forced Node 22.19/24.19 builds and both full suites pass **38 files/686 tests**,
  including 23 architecture checks. Logs are `reviewed-node22.log` and
  `reviewed-node24.log` in that checkpoint directory. Immutable package
  `execution-reviewed-candidate.tgz` has SHA-256
  `52d7b4f78558ade1dc1c27c9600cb77de3313db4cc70f51ecf5d01be741caef1`.
  `verify-candidate.mjs` verifies 109 packaged source/compiled/launcher files,
  the five unbundled host peers, exact shared-file baselines and patch
  applicability. The combined `integration.patch` there supersedes both earlier
  candidates' integration patches; apply only this latest combined patch after
  shared-file coordination and fresh verification. **It remains unapplied.**
  Only five existing files differ from the shared worktree: index, lifecycle
  and the architecture/leader/lifecycle tests. New module/interface tests are
  already present in the worktree; MCP, startup, manifest and lockfile were
  untouched for this slice. Darwin script checks pass. No full Mac TUI or
  managed-update E2E has run for this candidate, and no installed profile,
  commit, push or release was changed. Older checkpoints remain historical
  evidence, not proof that the current shared entrypoint is integrated.
- Session artifact ownership is prepared, **not yet wired into the shared
  entrypoint**. `session-artifacts.ts` owns attached-session archive/reference
  requests, manual/automatic title controls and session-info projection. The
  interface takes narrow native title/reference capabilities, an archive writer,
  exact-session admission and client cancellation; no host context or mutable
  registry is passed through. The existing `session-export.ts` still owns file
  policy, private staging, atomic no-overwrite publication and temporary cleanup.
  Its real-filesystem tests remain relevant and were not replaced by mocks.
  Sixteen artifact-interface tests cover validation, initialization reads versus
  title-write readiness, exact identity after native getters, late results,
  already-aborted clients, native errors and reentrant disposal. Accepted writes
  and reads drain to real completion; committed archives are not rolled back
  merely because the client departed before receiving the reply.
- Artifact re-review found that the old title refresh call omitted the native
  caller signal. Both reset spellings now receive session/module cancellation.
  Two new socket tests fail on the old worktree entry specifically because the
  refresh signal is absent, then pass on the candidate; see
  `/tmp/dsc-artifacts.pM7Iy0/title-before-wiring.log` and `wire-reviewed.log`.
  Those tests also verify that cancellation does not bypass the actual refresh
  completion, parent flush or native disposal. A third socket test covers the
  same accepted-read ordering for reference lookup. Native title normalization,
  provider policy and errors stay native; explicit title text passes unchanged.
  The exact shared-worktree source passes a forced Node 24 build and **3 files
  /41 tests** (`worktree-reviewed.log` in that checkpoint directory).
- Latest combined discovery/command/execution/artifact **candidate**:
  `/tmp/dsc-artifacts.pM7Iy0/bridge/grok-leader`, with an 821-line entrypoint;
  the shared worktree remains at 1,347 lines. Forced Node 22.19/24.19 builds and
  both full suites pass **39 files/706 tests**, including 24 architecture checks.
  Logs: `reviewed-node22.log` and `reviewed-node24.log` in that directory's
  checkpoint root. Immutable package `artifacts-reviewed-candidate.tgz` has
  SHA-256 `1723bb39eebb74b2c8097fc78e639fdae470c7dc8b4b1659ad7acd57be9399ab`.
  After both builds, `verify-candidate.mjs` verifies all 112 packaged source,
  compiled and launcher files, five unbundled host peers and exact shared-file
  baselines. The adjacent combined `integration.patch` supersedes all earlier
  integration patches and passes `git apply --check`; **it is not applied**.
  Only the same five existing files differ: index, lifecycle and the
  architecture/leader/lifecycle tests. The new module/interface tests are already
  in the worktree. MCP, startup, manifest and lockfile were untouched. Darwin
  script checks pass; no full Mac TUI or managed-update E2E has run for this
  candidate. No installed profile, commit, push or release was changed.
- Session input ownership is prepared, **not wired into the shared entrypoint**.
  `session-input.ts` owns prompt preparation/dispatch, steering and cancellation
  fan-out, retaining queue/command/native-agent ownership. Its 15 interface
  tests preserve synchronous ordinary-prompt admission, command-first routing,
  exact-owner guards, image capability checks and real accepted-storage drains.
  A backward-compatible queue preparation checkpoint is applied in the shared
  queue module, with three additional tests. Three late-image-storage regressions
  fail before the post-catalog/attachment-getter guards and pass afterward
  (`/tmp/dsc-input.nFdM7x/preparation-before-fix.log`). Cancellation now attempts
  human-wait cancellation and goal refresh even when native queue cancellation
  throws; the real-socket regression fails against the old shared entry and
  passes after candidate wiring (`cancel-before-wiring.log`, `targeted.log`).
- The combined input candidate at `/tmp/dsc-input.nFdM7x/bridge/grok-leader`
  has a 730-line entrypoint versus the shared entry's 1,347 lines. Forced Node
  22.19/24.19 builds and both full suites pass **40 files/726 tests**, including
  25 architecture checks. Focused candidate tests pass 4 files/322 tests;
  exact shared-source validation passes 3 files/63 tests. Immutable package
  `input-reviewed-candidate.tgz` has SHA-256
  `47d3710f7f0c8192a255815b45f5f927e38e6557ce753ebeaedd8a692922c28d`.
  `verify-candidate.mjs` checks all 115 packaged source/compiled/launcher files,
  five unbundled host peers and unchanged shared baselines. The adjacent
  combined `integration.patch` supersedes earlier patches, passes
  `git apply --check` and remains **unapplied** (the same five existing files).
  No MCP/startup/manifest/lockfile changes were made for this slice. This is
  source/candidate evidence, not full Mac or managed-update E2E, an installed
  profile, a commit or a release. Temporary `/btw` handles, remaining capability
  projections, host lifecycle and final product review still need work.
- One-shot aside ownership is prepared, **not wired into the shared entrypoint**.
  `native-asides.ts` owns accepted `/btw` requests and every published temporary
  run through native disposal. Its interface takes exact-session admission and
  narrow native capabilities; it does not acquire continuable-child, native
  provider, session-work or prompt-queue ownership. Pending starts remain the
  provider's responsibility until fulfillment. Provider preference, native
  request shape, text projection and empty-answer fallback are unchanged.
  Twenty interface tests cover readiness, reentrant native getters, pending
  starts, late handles/results, result/disposal errors, replacement owners,
  reentrant shutdown and sibling-run isolation.
- Aside re-review reproduced cancellation failing to initiate disposal while an
  already-returned run's result remained pending (two interface regressions in
  `/tmp/dsc-asides.airWpL/before-fix.log`). A real-socket close test also fails
  against the preceding candidate's in-entry implementation
  (`wire-before-wiring.log`). The new owner starts release on cancellation,
  shares exactly one native disposal and waits for that disposal before session
  retirement can flush/dispose the parent. Cancellation only interrupts the
  result wait; it is never reported as native cleanup completion. Late result
  rejections stay observed, and cleanup failures remain visible to the caller.
  The interface and socket regressions pass after candidate wiring. Exact
  shared src/bin/tests bytes match the validation stage: forced Node 24 build
  and 3 files/53 focused tests pass (`worktree-reviewed.log`).
- Latest combined **candidate**: `/tmp/dsc-asides.airWpL/bridge/grok-leader`,
  with a 674-line entrypoint versus the shared worktree's 1,347 lines. Forced
  Node 22.19/24.19 builds and both full suites pass **41 files/748 tests**,
  including 26 architecture checks (`reviewed-node22.log`, `reviewed-node24.log`).
  The focused candidate run passes 4 files/313 tests. Immutable package
  `asides-reviewed-candidate.tgz` has SHA-256
  `2263d597c2b1aec3c26199c60f46f2f58d846f5953309b5e4e9dbce067b8cc43`.
  After both builds, `verify-candidate.mjs` checks all 118 packaged source,
  compiled and launcher files, five unbundled host peers and exact shared-file
  baselines. Its combined `integration.patch` supersedes earlier patches and
  passes `git apply --check`, but is **not applied**. The same five existing
  files differ; the new aside module and interface tests are in the worktree.
  Shared MCP/startup/manifest/lockfile files were not edited for this slice.
  Darwin script checks and `git diff --check` pass. No full Mac TUI or managed
  update E2E has run for this candidate; no profile installation, commit, push
  or release was changed. Native capability/MCP projection and host lifecycle
  still contain implementation in the candidate entry, so it is not yet the
  final composition-only entrypoint.
- Host lifecycle ownership is prepared, **not wired into the shared entrypoint**.
  `leader-lifecycle.ts` owns the one 500 ms heartbeat, idle-exit generation/grace,
  start failure cleanup and one shared shutdown drain. It takes typed lifecycle
  capabilities and disposable owners, not a Cordis context or shared feature
  state. Admission still closes synchronously; session retirement, catalog,
  transport and every feature cleanup are independently attempted and all
  actual completions are joined. Fatal listener errors remain authoritative;
  ordinary cleanup failures retain the existing logged-error host contract.
  Sixteen interface tests cover reconnect during grace/drain, pending writes,
  missing exit capability, pre-start disposal, listener failures and reentrant
  cleanup. Two tests reproduce the previous late-published shutdown promise and
  synchronous-throw cleanup skipping (`/tmp/dsc-host.YghD9V/before-fix.log`);
  both pass after publication-before-callback and per-owner error collection.
  The candidate registers the host disposer before starting its listener.
- Native capability/MCP presentation is prepared in `native-capabilities.ts`.
  Thirteen interface tests preserve lazy scoped tool reads, service/tool joint
  availability, canonical capability order, MCP final-delimiter grouping,
  schema counts, wire shape and fresh views after preset/service changes.
  Native preset/agent/host service precedence remains a composition adapter;
  MCP connection/discovery/cache behavior and performance work are untouched.
- Latest combined **candidate**: `/tmp/dsc-host.YghD9V/bridge/grok-leader`,
  with a 543-line entrypoint composed of module wiring, protocol routing and
  event forwarding. The shared entrypoint is still 1,347 lines. The candidate
  gate also rejects timers, maps/sets and abort-controller construction in the
  entrypoint, in addition to explicit engine names and dependency/cycle checks.
  Forced Node 22.19/24.19 builds and both full suites pass **43 files/779 tests**,
  including 28 architecture checks (`reviewed-node22.log`, `reviewed-node24.log`).
  Five focused candidate files/325 tests pass; exact shared src/bin/tests bytes
  match a forced-build validation stage with 3 files/57 focused tests passing.
  Immutable package `host-reviewed-candidate.tgz` has SHA-256
  `99cab6505ba97378c9715e570818e6e2d879cefb754bd1cf6c65baaa3736fe56`.
  `verify-candidate.mjs` checks all 124 packaged source/compiled/launcher files,
  five unbundled host peers and exact baselines. The combined `integration.patch`
  supersedes earlier patches and passes `git apply --check`; **not applied**,
  with the same five existing files awaiting integration. Shared MCP/startup/
  manifest/lockfile files were not edited. Darwin script checks pass. Isolated
  managed-update E2E passes for this exact package, including startup/native
  repair, legacy overlay repair, composed profile, corrupt-asset rejection and
  preserved user files (`/tmp/dsc-host.YghD9V/update/update-PASS.json`). No real
  user profile, commit, push or published release changed.
- Full real Mac TUI + pinned runtime acceptance passes for that exact host
  candidate package: run **19481**, log `/tmp/dsc-host.YghD9V/macos-e2e.log`,
  runtime report `/tmp/dscmac15.SnoKqr/contracts-19481/PASS.json`. The unmodified
  full script includes headless/resume/fork, interactive paste/editor/selection,
  native runtime contracts, skills/preset/LSP, archive/attachments, persistent
  terminals, task isolation and doctor/direct terminal controls. It uses an
  isolated profile, local model fixture and private clipboard fixture, not a
  real credential or the user's daily installation. Wrapped-table copy and
  link-target assertions pass on this run; the earlier intermittent failure's
  cause is still unlocated, so this is a new pass, not evidence of a specific
  table-copy fix. No Linux execution or physical Cmd-click is claimed; Kitty
  image coverage remains skipped without its terminal fixture.
- Broader completion review found a remaining model-catalog ownership gap.
  Two additional tests in `/tmp/dsc-catalog-audit.dnQvQX/ownership-gap.log`
  demonstrate that catalog disposal completes before an already-started
  foreground credential write or background catalog-persistence write finishes.
  The tests run in a separate audit copy and **fail**; they are not part of the
  779 passing candidate tests and the gap is not fixed in this package. The
  host now joins a catalog disposal promise, but the catalog currently returns
  no such drain. Its accepted-operation ownership must be completed and reviewed
  without treating cancellation as completion or leaving partial credential/
  provider transactions. Unused entry imports also remain for final cleanup.
- The model-catalog ownership gap is fixed **in the isolated candidate only**.
  Its disposal now closes admission/publication immediately and joins accepted
  public work, background work and parallel native read branches. Parallel
  reads remain owned even when a sibling causes the outer refresh to reject
  early. Native callbacks can reenter disposal without escaping the drain.
  First-write checks deny new credential/configuration writes after shutdown
  during validation; four such regressions were reproduced before the checks
  (`/tmp/dsc-catalog.AWqxiv/first-write-before-fix.log`). Already-started
  credential/route-retry/cleanup sequences retain their native ordering and
  failure policy, including late native errors. No new cross-service rollback
  or fake abort-completion contract was introduced. Late catalog publication is
  suppressed; background discovery still does not block first-frame readiness.
  The catalog has 27 interface tests. Two additional real-socket regressions
  fail on the previous implementation and pass after the fix: explicit host
  shutdown waits for a foreground credential write and idle exit waits for
  background persistence (`wire-before-fix.log`, `targeted.log`).
- Latest reviewed candidate: `/tmp/dsc-catalog.AWqxiv/bridge/grok-leader`.
  Entry remains 543 lines; unused imports were removed while preserving the
  public content-block type and durable event augmentations through a compiled
  consumer test. Forced Node 22.19/24.19 builds and full suites pass **43
  files/794 tests**; 28 architecture checks are included. Focused tests pass
  4 files/333 tests. Release-script tests pass 12 with one Linux-only skip;
  Darwin script checks and `git diff --check` pass. Immutable package
  `catalog-reviewed-candidate.tgz` has SHA-256
  `64fa072a70469d7a0909eb5ead20002852cfa19194cb3469fdcec1260a00a806`.
  All 124 packaged source/compiled/launcher files match, and five native host
  peers remain unbundled. Managed-update E2E passes at
  `/tmp/dsc-catalog.AWqxiv/update/update-PASS.json`. Full real Mac acceptance
  passes for the same package, run **61580**, report
  `/tmp/dscmac16.YxRPj6/contracts-61580/PASS.json` and `macos-e2e.log` in the
  checkpoint root. The unchanged full-cell copy assertion passes again, without
  proving the cause of the earlier intermittent failure or claiming a TUI fix.
- The latest combined integration patch now covers **seven** existing files:
  entry/model-catalog/session-lifecycle source and architecture/leader/model-
  catalog/session-lifecycle tests. Baseline checks and `git apply --check` pass;
  it is **not applied**, and supersedes every earlier combined patch. Shared
  source, MCP, startup, manifest and lockfile were not edited for this slice.
  The final candidate requirement review is in
  [architecture-review.md](architecture-review.md). Scope confirmation from the
  concurrent performance task remains outstanding across multiple goal turns;
  unchanged hashes are not used to infer that it stopped. No live profile,
  commit, push or release was changed.

## Integrated ownership work

The user confirmed completion of the performance task. The latest candidate's
seven-file change is now applied once, with no baseline conflict. Entry
composition is 543 lines, and the model/provider drain and remaining prepared
module owners are active in the shared source. Existing performance changes,
MCP lazy loading and awaited mounting, launcher locking and the five host-peer
declarations are preserved.

Fresh verification is in `/tmp/dsc-integrated.nIgLrR`. Its source, tests,
presets and package/build wiring match 100 shared-worktree files byte for byte.
Forced Node 22.19/24.19 builds and both full suites pass 43 files/794 tests;
release-script tests pass 12 with one Linux-only skip, and Darwin script checks
pass. The fresh package passes managed-update E2E and full Mac acceptance, run
38320, with exit 0 and `/tmp/dscmac17.AsEMa8/contracts-38320/PASS.json`.
All 124 packaged source/compiled/launcher files match the tested build; its
SHA-256 is `64fa072a70469d7a0909eb5ead20002852cfa19194cb3469fdcec1260a00a806`.
The full wrapped-table-copy assertion passed unchanged; the earlier
intermittency's root cause is still unproven. No outstanding architecture
implementation remains in this goal. The final requirement review records
Linux, physical Cmd-click, Kitty and source-versus-installed boundaries.

## Checkpoint re-review (historical)

These findings explain the earlier repair decisions, not current completion
status. Any references below to unfinished extraction or shutdown wiring are
superseded by the integrated ownership work and final requirement review above.

- Per-session work review separates cancellation intent from actual native
  completion. It never races an abort result against still-running writes.
  Close cancels synchronously, but final flush and driver release wait for the
  accepted native promise; a failed reload reopens admission without reviving
  the old cancelled generation. Both native and model drains settle even if
  one fails first. Mutation checkpoints after async lookup prevent a late child
  message or reminder-list followup from starting; native errors are preserved
  through the child command's structured error response. Existing ordinary
  `session/cancel` semantics remain distinct: cancelling the held model prompt
  does not cancel an independent goal control. Partial permission mutation
  does cancel session work. Late btw handles are released before parent flush,
  their result rejection is observed, and result/cleanup errors are aggregated.
  Initialization projection reads remain allowed before user-input readiness;
  workflow refresh coalescing, bounded history caches and child-before-workflow
  replay ordering remain owned by the child module. Synchronous feature views
  keep their original ownership checks. Standalone discovery reads and host
  shutdown composition are still explicitly incomplete below.
- Interaction review distinguishes a transport reply from a still-valid human
  decision. Cancellation aborts the accepted request itself, so a resolved reply
  cannot become an approval after reload/close or after a failed reload restores
  the same record. Replies also recheck exact native ownership and input
  readiness. Native request abort only retires that reverse request; siblings
  remain pending, without a timeout imposed on human input. Host disposal owns
  accepted waits and attempts every unsubscribe callback. Plan capability is
  checked before either setter; the plan setter runs before the permission
  setter, and the bridge bypass bit is committed last. A partial native setter
  failure clears that bit, cancels active/queued input and human waits, and
  blocks root prompt/mode input until reload/close. Primary and cancellation failures
  remain observable. Native setters still own durable events and queued
  in-turn plan transitions; the bridge does not invent a parallel policy log.
- Lifecycle review separates read/event ownership from input admission. While
  reload waits for accepted model writes, native idle and durable flush, prompt,
  interject, goal/mode and new model writes cannot start. Failed preflight keeps
  the exact owner and restores admission; an explicit close remains irreversible
  and always releases the agent. A close winning during the new settle await
  prevents any later call into the disposed native driver. Initial child and
  transcript replay both finish before readiness and the lifecycle response;
  failed projection initialization retires partial publication instead of
  leaving an orphaned session. One-shot resource disposal preserves primary and
  cleanup errors and always attempts native release. Late creators whose client
  has closed skip permissions/default writes entirely. Native factory setup and
  asynchronous MCP mounting remain awaited before bridge publication.
- Queue review makes accepted content preparation and held rows count as busy.
  Cancellation advances the admission generation: an image/read finishing after
  cancellation cannot revive input, even when a failed reload restores the same
  owner. Following requests may still use the queue; disposal retains its
  stronger closed-owner rejection and drains accepted preparation.
- Preset review: a real-socket regression reproduced `x.ai/interject` bypassing
  the transition guard while ordinary prompts were blocked. Prompt, interject,
  goal, btw and plan-mode entry paths now share the preset readiness guard.
  Recomposition rechecks live ownership and native history before appending;
  accepted selection writes flush before an optional default write. Failure to
  persist the default cannot skip that flush. Failed rollback preserves both
  errors and denies further input until the inconsistent owner is closed.
  Cold-load/default adoption is deferred until native creation and permission
  validation succeed. Existing child/transcript replay-before-response awaits
  and concurrently developed asynchronous MCP startup wiring remain intact.
- Preserved the distinct reload and close contracts. The first unified-close
  implementation failed the existing reload-flush regression; it was replaced
  by a two-phase `reload()` and a destructive `close()`. A failed reload now
  retains the exact agent and a usable queue, and successful retirement still
  flushes before disposal. Unit and wire integration coverage both pass.
- Queue admission is checked again after asynchronous content preparation;
  pending input cannot revive a closed owner. Output hydration remains ahead
  of prompt completion and successor promotion. Disposal drains accepted
  preparation and settlements without taking over the native agent driver.
- Profile shutdown drains accepted locked mutations through post-install
  verification. Existing trust/audit/core-package safeguards and the shared
  launcher lock were preserved, not replaced by a separate install path.
- Corrected qualified-model requests retaining an explicit supported reasoning
  effort; tests through the catalog interface cover this path and late cache
  publication after disposal.
- Output re-review reproduced three ordering bugs before fixing them: a later
  rejected image promise was not observed until its predecessor finished;
  live events arriving during image hydration could skip the remaining replay
  prefix; and delayed output inherited the next turn's start timestamp. The
  fixes immediately observe rejection while keeping FIFO, reserve all replay
  positions before yielding while keeping image I/O sequential, and capture
  the accepting turn's timestamp. Event admission precedes counter folding, so
  replay/live overlap cannot double-count usage or messages.
- Task re-review keeps native producer ownership and non-consuming output reads;
  completion is never inferred from a cancellation request. Late cancellation
  and reminder results are rejected after owner replacement/disposal, and every
  registry unsubscribe is attempted even if another unsubscribe fails.
- Child/workflow re-review reproduced cold attachment publishing workflow
  membership before its child view. Initial workflow snapshots now wait for
  child restoration; live discovery retains its existing child-before-member
  gate and bounded retry policy. Interruption still requires the exact native
  terminal turn, not holder completion or an older attempt. Pending native input
  and interruption waits abort on disposal or owner withdrawal; history handles
  close after errors, and accepted reads drain before module disposal completes.
- Accepted-work re-review reproduced shutdown finishing before an operation
  that synchronously entered native code and then reentered disposal. Goal and
  child controls now register work before native invocation; the session
  registry also registers creators and retirements before callbacks can start
  shutdown. Reentrant close/dispose shares the original drain. Synchronous
  reverse-request cancellation or queue-disposal errors no longer bypass flush
  and agent disposal; every failure is retained after cleanup.
- Native task disposal now drains accepted cancellation/reminder requests,
  aborts owned reminder tool signals and releases every job subscription even
  after cleanup errors. The shared heartbeat aborts withdrawn reminder owners.
  Job cancellation still awaits native producer settlement (the existing
  five-second wait); disposal does not issue another kill or infer completion.
  Task interface coverage is 15 tests, child coverage 15 and registry coverage
  15. External descendant reads are not cancellable in the native interface, so
  their accepted work drains rather than pretending to cancel the underlying I/O.
- Session-model re-review keeps the native assembly snapshot coupled to its
  request route: a concurrent choice only affects the next assembly. Failed
  event append changes neither the runtime reference nor effort memory. Once
  appended, the choice is flushed even if saving the global default fails;
  both errors survive if both writes fail. Per-session serialization prevents
  overlapping choices from completing out of order without blocking other
  sessions. Retirement during a catalog wait cannot mutate a departed owner;
  retirement after commit drains the write/flush and suppresses late UI refresh.
  A real-socket close regression verifies that native Agent disposal waits for
  the accepted default write. Failed native creation or post-creation validation
  also disposes prepared model handles; model disposal releases native routing
  listeners, and global disposal drains unpublished preparations/handles.
- Declaration review reproduced missing native and legacy event types when a
  consumer imported only the emitted package entry. Source compilation had
  hidden the loss because it included every module augmentation. An explicit
  type-only export preserves the event vocabulary without exposing internal
  model handles or adding runtime work. The dependency suite now compiles a
  consumer against emitted declarations (16 checks); the three missing-property
  errors were reproduced before this correction and disappear afterward.
- No commit, push, published release or live user-profile installation was
  performed. The product version remains `0.0.14-alpha.12`; SDK/runtime pin
  remains `0.1.5-rc.2` / `fb2c4b9e698e30edb738bca4cf0618587db7d203`.
- Coverage limits remain explicit: no Linux execution for this checkpoint,
  physical Cmd-click is not covered by keyboard link tests, and Kitty image
  terminal coverage was skipped because no Kitty fixture was configured.
- Mac interaction uncertainty: the first session-work package run **86540**
  failed the wrapped-table copy assertion. Expected the complete long URL;
  tmux's buffer contained only the first rendered line. Evidence is retained
  at `/tmp/dscarch.zGRaLQ/e2e-work-final.log` and
  `/tmp/dscmac-arch13/frame-86540.txt`. A rerun of the exact same bridge package,
  TUI and unmodified test passed that specific step. Local TUI source uses
  processed-event timing for multi-click counting and synchronous clipboard
  delivery, but this does not establish the cause of this occurrence. No TUI
  or test assertion was changed, and the intermittent failure is not claimed
  fixed. It remains a final-product-review item, distinct from the verified
  session-operation ordering regressions.
