# Upstream follow-up assessment — 2026-09-14

Initial read-only source assessment against local `28fd39fa23348fbd2ded735a7fb02524b02ee673`.
Implementation progress is recorded separately below; the assessment itself is
not runtime validation. Recommendations distinguish missing code from
already-covered behavior and changes belonging to other product surfaces.

Recommended order for dscode: take the small theme/settings UI fixes when next
touching the TUI; design prompt-ack recovery as a separate protocol change;
prepare history-read compatibility without changing the SDK pin. Linux runtime
cancellation fixes belong in the next independently validated DSH candidate.
None requires a wholesale grok-build sync or an immediate DSH master bump.

## Execution: first UI slice

Theme alias search and settings radio double-click are implemented as selective
ports from `37949780c1`. Aliases have one definition shared by parsing and search;
canonical insertion, the local theme catalog and terminal color gates stay intact.
In particular, this does not add `terminal` or `transparent`. Double-click uses
the shared 300ms window and existing Enter commit path. Keyboard focus changes,
outside-choice clicks and reopening the picker clear the gesture; preview and
Esc revert remain separate from persistence.

Expanding the Rust gate also exposed old xAI-only fixtures and branding
assertions. Non-preview picker tests now exercise the supported follow-up
behavior setting; removed privacy settings are explicitly checked to remain
absent. Toast/tip assertions use dscode's existing text. Production catalog or
account-policy behavior was not changed to satisfy those tests.

Validation on macOS arm64 (TUI on Node 24.19.0):

- Rust theme/settings/focused-open tests: 402 passed, 2 existing ignores.
  The expanded pager/render product-contract selection also passed: 1,536 pager
  and 161 renderer tests (1,697 total), with the same 2 existing ignores. This
  runs the last Cargo test stanza of `scripts/check-rust.sh` using `--release`,
  not the entire Rust script. The ignored cases are `picker_visual_smoke_debug`
  (manual output inspection) and `theme::groknight::tests::test_groknight_theme`
  (pre-existing expected accent-value drift); neither ignore was added here.
- Rebuilt the release TUI, version `0.0.14-alpha.12 (28fd39f)`, SHA-256
  `c4e2a6a4055dd7c73487d55538a81e07d4a260b654ba66862d779187ce9211f3`.
- Real TUI-to-DSH acceptance passed with `DSCODE_E2E_NEXT_SIX_ONLY=1`:
  `/tmp/dsc-follow-work.nYBS9C/ui/contracts-53912/PASS.json`. This includes the new
  alias/preview/revert/double-click checks, the existing six-feature acceptance,
  archives, terminal sessions, Python REPL, doctor and owner-isolated interrupt.
  It is not the full goals/history/provider suite. Graphical Kitty was not
  configured; macOS physical Cmd-click remains outside the tmux test.
- Script contracts on each of Node 22.19.0 and 24.19.0: 37 passed, 1 Linux-only skip;
  `scripts/check.sh`, changed-file
  Rust formatting and `git diff --check` passed. Full-workspace formatting still
  reports pre-existing differences outside this slice; no unrelated formatting
  changes were applied.
- The isolated plugin archive's 132 source/compiled/bin/preset files match this
  checkout. No bridge code, DSH pin, package version or daily profile changed.

## Execution: prompt-specific cancellation foundation

The bridge now implements the owned `x.ai/session/cancel_prompt` request; see
[the protocol contract](grok-leader-protocol.md#prompt-queue). The queue owns
preparing, queued, active and steering states; session input only tracks native
command dispatch before queue handoff. This follows the codebase-design skill's
single-owner boundary and adds only a routing case to the shared entry point.

Targeted cancellation retires one preparation/row without clearing its siblings.
A waiting cancelled row cannot let later input overtake earlier preparation.
Actual image IO and native commands stay in their shutdown drains; late results
cannot revive admission. Commands receive a per-prompt abort signal, while
accepted atomic profile operations retain their completion semantics. Duplicate
active prompt IDs are rejected. Steering and already-settling prompts report
that independent retraction is unavailable; late unknown IDs never cancel a new
turn. Only the active owner also cancels its human request and pauses its goal.

This deliberately uses a new request, not legacy cancellation metadata. An old
bridge fails with method-not-found instead of silently clearing its entire queue.
The legacy whole-session cancel path is unchanged. No TUI/headless watchdog or
automatic retry is enabled by this foundation commit.

Review caught and corrected two edge cases: extra preparation awaits initially
changed very-short-turn completion/promotion ordering; reentrant cancellation
during steering acknowledgment needed exact row ownership before native dispatch.
Existing socket-order tests remain unchanged and pass. The queue test helper now
flushes an event-loop turn rather than assuming a fixed number of microtasks.

Validation on macOS arm64:

- Pinned-SDK TypeScript build passed. Full bridge suites on Node 22.19.0 and
  24.19.0 each passed all 46 files / 866 tests, including compiled CLI tests.
  New cases cover cancellation before preparation, FIFO, image lookup, command
  fallback, disposal, steering, failed native cancellation and late IDs.
- Real Unix-socket tests exercise the new request, including prompt/cancel frames
  in one write and preserving a queued successor after active cancellation.
  These socket tests use the existing mock native agent, not a real model.
- Repacked isolated plugin SHA-256:
  `c838cbc3985eb105da08038c92b5697ed31c4e774317cd4c18bcc19fdc378ba9`.
  Its 132 source/compiled/bin/preset files match this checkout/build; the five
  runtime host peers remain unbundled.
- Real installed TUI/DSH regression passed with `DSCODE_E2E_NEXT_SIX_ONLY=1`:
  `/tmp/dsc-follow-work.nYBS9C/ack/e2e/contracts-76497/PASS.json`. This validates
  the existing product loop and interruption isolation against the new package;
  it does not yet exercise the new endpoint through TUI timeout recovery.
  Full goals/history/provider acceptance and graphical Kitty were not run in
  this slice. The Rust TUI itself is unchanged from the verified UI build above.
- `scripts/check.sh` and `git diff --check` passed. No SDK pin, package version,
  daily profile, remote branch or release changed.

## Execution: TUI/headless first-ack recovery

The clients now use the prompt-specific cancellation foundation above. A small
shared module owns receipt matching, bounded deadlines and the cancellation
request; TUI dispatch owns composer recovery. This keeps the codebase-design
single-owner boundary without changing the pinned SDK or the legacy cancel path.

The default TUI notice/hard deadline is 10/120s, tunable with the bounded
`DSCODE_PROMPT_ACK_TIMEOUT_SECS` setting. Matching queue receipt, live named
updates, terminal notifications and RPC completion disarm the watch. Replay or
another session/prompt does not; acknowledged model work is not time-limited.
Headless now supplies its own prompt ID and reports `prompt_ack_timeout` with a
nonzero exit. Cancellation and timeout-path log flush have bounded waits.

TUI restores recoverable text/chips/images without overwriting newer images,
queue edits or interaction-owned input. A newer plain-text draft stays below
the recovered prompt. Committed scrollback remains intact, hidden child views
are included, and reconnect retains its own recovery. Late prompt IDs cannot
replace recovered input or finish a newer turn. Recovery neither drains queued
input nor resends the uncertain request. Warnings explicitly preserve the
possibility of earlier execution, including old/unresponsive bridges.

Validation on macOS arm64:

- Final-source expanded release Rust selection: 1,775 pager + 161 renderer
  tests passed (1,936 total), including 13 first-ack tests and headless,
  turn/rewind and queue/adoption coverage. The same 2 pre-existing ignores
  documented above remain. This is not the entire `check-rust.sh` script.
- Built release TUI `0.0.14-alpha.12 (1e6531d)`, SHA-256
  `38b0eae22994cf53636c91f069e57f2a823eac6379897bcd7908d136b704042c`.
  The embedded revision names its parent checkout; this hash identifies the
  tested watchdog build.
- The preserved pre-watch binary reproduced the missing-ack hang past the
  fixture's 15s limit, with one prompt and no targeted cancellation:
  `/tmp/dsc-follow-work.nYBS9C/ack/baseline-watch2/`.
- `scripts/e2e-prompt-ack.mjs` passed all 10 compiled-client cases on each of
  Node 22.19.0 and 24.19.0. Artifacts:
  `/tmp/dsc-follow-work.nYBS9C/ack/watch-final-node22/PASS.json` and
  `/tmp/dsc-follow-work.nYBS9C/ack/watch-final-node24/PASS.json`.
  These cover lost receipts with unrelated/replay noise, old leaders, silent
  cancellation, queue/live-update/terminal receipt followed by a longer turn,
  TUI draft recovery, old-leader warnings and late responses. Exact requests
  prove no automatic resend and no legacy whole-session cancellation. The
  fixture tests transport/client behavior, not native model cancellation.
- Real installed TUI/DSH product regression passed using the unchanged verified
  bridge archive with `DSCODE_E2E_NEXT_SIX_ONLY=1`:
  `/tmp/dsc-follow-work.nYBS9C/ack/watch-real/contracts-1262/PASS.json`.
  This covers theme/settings, skills, viewer/navigation, presets, real LSP,
  archives, terminal/Python, doctor and owner-isolated interruption. It does not
  simulate a lost receipt through the real native agent. Full goals/history/
  provider acceptance and graphical Kitty were not run for this slice.
- `scripts/check.sh`, new-module/headless Rust formatting and
  `git diff --check` passed. Existing unrelated formatting differences were
  preserved. No daily profile, package version, DSH pin, remote or release changed.

This completes only the first-ack client slice. History migration follows below;
the independently validated Linux/systemd runtime candidate remains pending.

## Execution: history state migration

Live preset selection/locking no longer reads arbitrary Session history. Its
host-only `dscodePresetHistory` definition folds only the current valid preset
and the existing model-visible-history lock. Native `sessionProjections` owns
restoration, incremental updates and cache lifetime; the bridge now declares
that service dependency before opening its socket. Cold load/fork folds the
source it already owns through the same policy. Missing policy state fails
closed, and the pre/post-recomposition checks and rollback/drain behavior remain.
The different native preset selector's turn-boundary policy was not substituted
for dscode's existing user/assistant/tool-result history gate.

Reminder snapshots now read the native Schedule host state, which includes both
active reminders and previously used IDs. This avoids a first-snapshot full-log
scan when that projection exists, without resurrecting inherited reminders or
losing deleted-ID notifications. The existing `ownEvents` fallback remains only
for absence of the optional Schedule projection; it is not claimed migrated.

The codebase-design skill kept policy behind a small interface, with its pure
definition separate from bridge composition. The native registry is reused;
no parallel event cache or new history-reader wrapper was introduced. The
projection package is an exact-version host peer/dev dependency, not bundled.
Zod is also declared as a host peer/dev dependency for the persisted-state
schema: review caught that bundling a duplicate would increase this archive
from 1.44 MB to 2.61 MB, despite the pinned runtime already supplying it.
DSH remains pinned.

Validation on macOS arm64:

- Pinned-SDK TypeScript build and frozen/offline lockfile validation passed.
  Full suites on Node 22.19.0 and 24.19.0 each passed 47 files / 876 tests,
  including the compiled CLI. The dependency gate explicitly accounts for the
  new pure module and checks the built type entry's projection augmentation.
- Native Session/SessionProjectionRegistry tests verify live, resumed and
  inherited-fork parity, a rewind prefix before conversation history, remount
  invalidation, persisted state and the unchanged wire shape. A warmed
  projection processed 1,000 unrelated live events with
  zero `snapshotEvents` or `eventAt` calls; this is an operation-count check,
  not an end-to-end latency or memory benchmark. Preset control tests forbid
  raw history reads and retain retirement/recomposition race coverage.
- Isolated plugin SHA-256
  `be48eb7bccc0ffb676ea77d91daf65dac8c5519543dfed19f16b06ff27e759fa`;
  all 135 source/compiled/bin/preset files matched the checkout/build. The prior
  five runtime peers, the new projection peer and Zod remain unbundled. The
  final archive is 1,442,880 bytes, only 1,600 bytes above the baseline.
- Full real installed TUI/DSH E2E passed without scenario-only flags, run 53103:
  `/tmp/dsc-follow-work.nYBS9C/history/peer/full.log`, with contracts at
  `/tmp/dsc-follow-work.nYBS9C/history/final/contracts-53103/PASS.json`.
  The outer scenarios cover isolated installation, persistent headless fork,
  resume, streaming, editor/paste/copy and live UI-mode switching; the runtime
  contracts include goals, native children/workflows, live/restarted reminders,
  permission controls, native history queries, theme/settings,
  presets/LSP, archives, terminal/Python and owner-isolated interruption.
  The `/compact` route is checked on empty history, not a nonempty compaction.
  Interactive root rewind remains unit/protocol-tested, not exercised by this
  installed run. Graphical Kitty, physical Cmd-click and Linux were not
  exercised. TUI is unchanged from the
  verified watchdog hash above; the runtime run uses Node 24.19.0.
- Script tests passed 37 cases with one Linux-only skip; `scripts/check.sh` and
  `git diff --check` passed. No daily profile, version,
  runtime pin, remote branch or release changed.

Seven production reader calls still require migration: lifecycle reload/fork/
rewind (3), child history/interruption (2), incremental workflow indexing (1),
and missing-Schedule fallback (1). The architecture gate permits exactly these
references and rejects growth. The assessment's original count included a
`snapshotEvents` interface declaration: the starting implementation actually
had 11 snapshot calls plus one `ownEvents` call; five preset calls are now gone.

Next: explicit storage snapshots for full-history lifecycle operations, with
the reload borrow held across awaited capture; bounded reads for requested
history; then workflow/optional-Schedule state seeding. The pinned query engine
was inspected: `readEvent` calls its full-log corpus loader before selecting a
window, so replacing live bounded pages with that method would not preserve
their cost bound. Neither this SDK observation nor a green state migration
completes the remaining reader work or the Linux/systemd validation gate.

## DSH

Local runtime/SDK pin: `0.1.5-rc.2` at
`fb2c4b9e698e30edb738bca4cf0618587db7d203` in
[the plugin manifest](../bridge/grok-leader/package.json).
The official master checked today is
[`c291e7961a515f6d7af9304e7fd1d257929aef26`](https://github.com/deepseek-ai/deepseek-harness/commit/c291e7961a515f6d7af9304e7fd1d257929aef26)
(2026-09-10), 139 reachable commits ahead of that pin, including merge commits.
The newest published prerelease remains
[`dsh-v0.1.5-rc.2`](https://github.com/deepseek-ai/deepseek-harness/releases/tag/dsh-v0.1.5-rc.2).
Identical version strings do not make master interchangeable with the pinned
runtime: retain exact source provenance and release-shaped validation.

### Worth following, in order

1. **Linux subprocess cancellation and teardown settlement — next runtime update gate.**
   [`b79a227cec`](https://github.com/deepseek-ai/deepseek-harness/commit/b79a227cec941405c9b368524446145298e9d48d)
   preserves the actual requested cancellation outcome when a subprocess/PTY
   exits before its bootstrap consumes the request; genuine recorded startup
   failures still win.
   [`aaa02a3970`](https://github.com/deepseek-ai/deepseek-harness/commit/aaa02a39709893ea45ac220aa87194d8522325fe)
   additionally settles an otherwise perpetually active but empty systemd scope
   after termination was requested and its launcher exited. Unknown process
   counts remain unknown, not falsely successful cleanup. Both mechanisms are
   absent from the pinned `linux-scope.ts` inspected through the official API.
   This belongs to DSH's runtime owner, not a bridge timeout workaround. It is
   relevant to our native shell/terminal jobs on **Linux with user systemd**, not
   evidence of a macOS bug or speedup. Before adoption: ordinary and PTY early
   cancellation, genuine startup failure, process reaping, and shutdown tests on
   a real user-systemd Linux host; retain macOS regression coverage separately.

2. **Session-history API direction — prepare a small local migration, not an urgent SDK bump.**
   Upstream now deprecates `eventAt`, `snapshotEvents`, and `ownEvents`; its
   [policy and current implementation](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)
   explicitly retain old callers and the complete in-memory log for now.
   The initial source inventory found synchronous readers, principally
   [preset guards](../bridge/grok-leader/src/session-presets.ts),
   [load/fork/rewind](../bridge/grok-leader/src/session-lifecycle.ts),
   [children](../bridge/grok-leader/src/native-children.ts), and
   [the incremental workflow index](../bridge/grok-leader/src/workflows.ts).
   Avoid adding new synchronous-history dependencies. Migrate ordinary state
   checks to maintained projections first; use bounded asynchronous history
   reads for requested content, with explicit full-history reads only where
   fork/replay really requires them. Existing bounded workflow reads and cold
   persistence handles are useful foundations, not a completed migration.
   Verify live/resumed parity, cancellation/drain ownership, fork inheritance,
   and large-history behavior. No present API removal or measured memory gain is
   claimed; a wholesale rewrite now would exceed this upstream change.

3. **DeepSeek image-token estimator v41 — focused correctness gain for the native provider.**
   [`a64dc3a690`](https://github.com/deepseek-ai/deepseek-harness/commit/a64dc3a690cf31a1bc87bd23dec15ab988301820),
   with the follow-up
   [`f24bc3c832`](https://github.com/deepseek-ai/deepseek-harness/commit/f24bc3c83228f35ba65968beaa04ec0ca322d39c),
   changes the estimator's 384-token cap/384-square floor to 1024/544-square,
   removes the old aspect-ratio clamp/alignment padding, and updates pricing
   tests. The pinned source still has the old constants. This can improve image
   request/context estimates when using `dsh-llm-deepseek`; it is not a global
   pricing correction for every OpenAI-compatible provider, and our fresh
   [profile disables the native DeepSeek route by default](../bridge/grok-leader/cordis.patch.yml).
   Adopt in the runtime/provider package, not a duplicate bridge calculator.
   Validate small/screenshot/extreme-aspect images **after request resizing**,
   offloaded images, context budgeting, and actual reported provider usage.
   Source/test evidence is confirmed; no live billing comparison was performed.

4. **Disposable image variants separated from durable attachments — useful maintenance follow-up.**
   [`d911a7b422`](https://github.com/deepseek-ai/deepseek-harness/commit/d911a7b422bcec506f8687a102215ced97950c2a)
   moves generated request variants from `attachments/v1/request-images` into
   `cache/attachments/request-images` under the resolved DSH home, while original
   attachments remain in `attachments/v1`. Its tests clear/rebuild that cache
   without losing originals and respect an explicitly configured home. The
   pinned runtime still uses the old variant location. This separates cleanable
   data from history and is relevant to our
   [image output](../bridge/grok-leader/src/image-output.ts) and
   [session archive](../bridge/grok-leader/src/session-export.ts) consumers.
   This is **not** a new compression algorithm or demonstrated performance win.
   Before adoption: old-session display/export, cache miss/regeneration,
   configured-home isolation, and concurrent image requests. Do not delete old
   directories or durable attachments as part of merely changing the pin.

### Defer or do not port

- **Plugin manifest metadata:** current upstream
  [public types](https://github.com/deepseek-ai/deepseek-harness/blob/c291e7961a515f6d7af9304e7fd1d257929aef26/packages/util/package-manifest/src/types.ts)
  add optional `dsh.manifestVersion: 1` and `engines.dsh`, while declaring host
  compatibility informational until a reader enforces it. Follow the final
  schema when updating metadata, not the intermediate commit's removed tags/
  discovery categories. Our exact `testedVersion`/`sourceCommit` and runtime
  validation must remain authoritative. No compatibility fix requires adding
  these declarations immediately.
- **Command identity/catalog changes:**
  [`ca827aa2ad`](https://github.com/deepseek-ai/deepseek-harness/commit/ca827aa2ad05f69554690fce26f1926eb3437c12)
  refreshes generated API catalogs and fixes a type-only export identity; it
  does not implement TUI command hot-refresh. Our
  [command owner](../bridge/grok-leader/src/session-commands.ts) already handles
  `commands/change` and `skills/change`, coalesces invalidated reads, and has
  [regression tests](../bridge/grok-leader/tests/session-commands.spec.ts).
  Upstream's optional definition IDs primarily serve its Web composer identity
  and presentation; do not replace our working command lifecycle for that.
- **Electron boot/bundling/macOS notarization, Web composer/sidebar, Python SDK
  wheel deployment:** different delivery surfaces. Our bundle explicitly mounts
  no Host/HTTP/browser layer and ships a Node CLI/runtime plus Rust TUI; do not
  count desktop packaging or browser benchmark changes as dscode startup gains.
  The Python deploy fix changes `build-exe-for-python-sdk.ts` deployment flags,
  not the persistent Python REPL used by our TUI.

DSH conclusion: prioritize runtime cancellation correctness and history-read
compatibility preparation; carry estimator/cache fixes into a provenance-pinned
runtime candidate when warranted. Do not wholesale replace `rc.2` with master
because their version strings happen to match. This assessment inspected
official commit patches and both pinned/current source for the key mechanisms;
it is not an exhaustive audit of all 139 commits or a runtime validation result.

## grok-build

The official main still points to
[`37949780c144e37df692e3d669051a21fec24f20`](https://github.com/xai-org/grok-build/commit/37949780c144e37df692e3d669051a21fec24f20)
(2026-09-09; shell manifest 1.0.24). Local full baseline is `19d42e35`/1.0.6,
but [the divergence ledger](../third_party/grok-build/TUI-DIVERGENCE.md) records
many selective ports through `75810042`/1.0.24 already. The final snapshot was
compared against `75810042` using a temporary bare Git repository: 684 changed
files, not the 300-file-truncated GitHub compare API inventory. This is source
inspection, not an upstream build or proof every other change is irrelevant.

### Worth following

1. **Prompt acceptance watchdog — highest reliability value, medium integration risk.**
   Upstream adds a separate
   [acknowledgment watch](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/app/prompt_ack.rs)
   rather than a maximum model-turn duration: a matching queue entry, session
   update or turn end disarms it. Default notice/deadline are 10/120 seconds.
   Its [TUI recovery](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/app/dispatch/prompt_ack.rs)
   restores a restorable prompt, protects a newer draft, ends the local busy
   state and rejects late acknowledgments; reconnect is handled separately.
   [Headless recovery](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/headless/prompt_ack.rs)
   returns an explicit error. Our source has no corresponding watch.
   This could make an alive-but-unresponsive leader recoverable; no current
   local hang was reproduced in this assessment.

   **Do not port the timer alone.** Upstream sends a prompt-specific rewind
   cancel. Our [input cancellation](../bridge/grok-leader/src/session-input.ts)
   currently reads only session ownership, pauses the goal and invokes
   [whole-queue cancellation](../bridge/grok-leader/src/prompt-queue.ts).
   Blindly sending the new timeout notification would not preserve upstream's
   prompt-specific semantics and could discard unrelated accepted rows.
   First specify acknowledgment/admission and late-cancel ownership for DSH;
   never automatically resend a possibly accepted prompt. Tests must cover a
   silent leader, a slow but acknowledged turn, queued input, images/newer
   drafts, reconnect, late reply, cancellation races and headless exit.
   Keep environment namespace isolation and avoid importing xAI telemetry.

2. **Theme alias search — small, low-risk usability fix.**
   The [theme picker](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/slash/commands/theme.rs)
   now searches canonical names plus aliases (`transparent`, `dark`, `system`),
   but inserts the canonical choice. Our picker searches display names only.
   This is a focused port, with fuzzy-ranking and preview/commit/cancel tests;
   do not replace the theme subsystem or add backend dependencies for it.

3. **Settings radio double-click — useful for macOS mouse interaction.**
   Upstream [picker input](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/views/settings_modal/input.rs)
   lets a timely second click on the same focused choice commit through the
   existing Enter path; keyboard movement, another row or a stale click resets
   the gesture. It preserves the preview action instead of committing a
   different radio. Our same-row click is explicitly a no-op. The matching
   [tests](https://github.com/xai-org/grok-build/blob/37949780c144e37df692e3d669051a21fec24f20/crates/codegen/xai-grok-pager/src/views/settings_modal/tests.rs)
   cover focus changes, expiry, preview and deep-link chooser closure. A small
   port should retain those checks and add a real TUI mouse acceptance case.

### Already covered or poor direct fit

- CRLF paste, editor terminal handoff, table-source copying, wrapped OSC8 links,
  image placement/aspect ratio, writer backpressure, turn navigation and Esc
  behavior are already selectively ported in the local ledger. A baseline
  number of 1.0.6 does **not** make them new work.
- Latest MCP startup ownership and settings/prefetch refactors primarily own
  the Grok Rust agent and xAI settings/auth. The local
  [leader startup](../third_party/grok-build/crates/codegen/xai-grok-pager/src/acp/mod.rs)
  launches external DSH, whose catalog/MCP/session owners remain in the bridge
  and SDK. Do not claim startup gains without showing the changed code runs
  on that path and measuring the full product loop.
- SVG rejection/history repair and full Bash UI output modify the upstream
  Rust sampler/session/tool-dispatch path. Our history and shell execution are
  DSH-owned. They may inspire separate behavior tests, not direct runtime ports.
- The `/resume` unused-home-session fix targets a newer optimistic-home owner
  not present in our current lifecycle. Do not introduce that whole mechanism
  merely to import its cleanup fix.
- Memory v2, agent-host/workspaced, Grok hooks, cloud dashboard and voice wiring
  would add or replace backend capabilities, not just improve the current TUI.
  They are outside a minimal compatibility/bugfix update.

## Validation boundary

Only this research note was added; product sources, pins, installed profiles
and Git history were not changed. No tests or benchmarks were run for a new
candidate. The cited upstream tests are source evidence, not locally verified
passes. Follow-up implementation should use selective ports plus the existing
Node 22/24, Rust, managed-update and macOS product gates, with a real Linux run
for the systemd-specific fixes.
