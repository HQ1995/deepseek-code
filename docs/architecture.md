# Architecture

dscode has three layers: the vendored Rust TUI (`third_party/grok-build`), the
TypeScript bridge `bridge/grok-leader` (published as `@hqzhao95/dscode`), and
the managed install/release tooling. The TUI speaks the leader wire protocol
([grok-leader-protocol.md](grok-leader-protocol.md)) to the bridge, a DSH
plugin that drives the DSH runtime pinned at `0.1.7-rc.2`.

The TUI keeps core interaction only, with no per-plugin code. Features ride
generic rails: dsh's command registry (`session-commands`), the llm service's
provider and model catalogs (`model-catalog`), and display-only fields the TUI
relays verbatim (the provider `note` from `wire-catalog`). Plugin-specific code
is allowed only as an explicitly marked COMPAT SHIM with a retirement
condition. None is active in `bridge/grok-leader/src`: the one-time shim for
`/dsh login` and `/dsh code` retired when its plugin moved to the registry.

## Refactor contract

The 2026-09 refactor split the 6,033-line entry closure into owned modules;
`index.ts` is composition, not a relocated monolith. Its six requirements
remain the acceptance contract:

1. Model/provider: one owner for catalogs, discovery, provider mutations and
   credential references; DSH capabilities are injected lazily.
2. Transport: sockets, registration, ACP and reverse requests stay apart from
   feature handlers.
3. Sessions/prompts: one owner for sessions, admission/queue state and
   teardown; persistence, preset and model integration are isolated.
4. Features: native features own their subscriptions and snapshots, not
   `apply()`.
5. Profile/packages: bundle audit/install stays out of session dispatch.
6. Composition: no superseded wiring; the dependency direction is gated.

Invariants: session ownership checks; prompt admission, FIFO, steering and
settlement order; flush before dispose; late-result guards; stream/replay
dedup; reverse-request cancellation; workflow child visibility and event
order; credentials stay native, never in the UI; native-runtime repair; the
performance work; wire protocol, install layout and release provenance.
Stateful modules own their caches, subscriptions, pending work and disposal.

## Bridge modules

`src/` has 63 modules; `index.ts` is the composition root.

| Module | Owns |
| --- | --- |
| `index` | Composition: module assembly, native event forwarding; routing goes through `leader-routes` |
| `codec` | Frame codec: 4-byte big-endian length plus JSON payload, 64 MiB cap |
| `protocol` | Envelope types and wire mapping; ACP JSON-RPC strings inside `acp` frames |
| `acp` | Shared ACP request validation and JSON-RPC errors |
| `leader-routes` | ACP method registry: requests and notifications to their owners; unknown requests are METHOD_NOT_FOUND |
| `leader-transport` | Unix socket, registration, ACP request/reply and reverse-request lifetimes; no DSH |
| `leader-lifecycle` | Host heartbeat, no-client grace, shutdown that joins every owner's drain |
| `model-catalog` | Catalog snapshots, accepted native reads, discovery, route writes, disposal; no socket or Cordis |
| `wire-catalog` | Pure: wire ids, catalog assembly, selection resolution, effort acceptance, provider notes |
| `provider-roster` | Pure: roster rows, each provider's model list and display row, discovery request and rows, client replies |
| `provider-profile` | Pure llm-pi-ai rules: settings reads, `/provider` form validation, profile merge |
| `model-endpoint` | The catalog's only outbound HTTP: bounded `/models` probe, injected `fetch` |
| `native-provider` | The official DeepSeek Messages adapter as an explicit `/provider` route |
| `native-seams` | Types only: structural llm, settings, credentials and default-model contracts |
| `session-registry` | Sole owner of accepted sessions; a retiring id stays reserved until flush and disposal |
| `session-lifecycle` | Session records and new/load/fork/rewind/close flows over the registry |
| `session-work` | One session's accepted async work: admission generations, cancellation, real drains |
| `session-input` | Composer input validation, routing and cancellation; not a second queue |
| `prompt-queue` | Prompt admission, active turn, FIFO, edits and steering settlement |
| `queue-controls` | `x.ai/queue/*` row controls (interject, steer, remove, edit, holds, reorder, clear) over the queue's state |
| `prompt-content` | ACP prompt validation; commits images to durable storage in block order |
| `session-output` | Stream state: seq-based replay/live dedup, usage, decode speed, pending tool facts |
| `turn-notices` | Pure: xAI turn notices from native events and stream chunks (retry and typed failure states, tool calls being written, automatic compaction, plan mode) |
| `session-models` | Runtime model references, durable choice/effort memory, catalog fan-out |
| `session-presets` | Preset preparation, `/preset` switching, English copy for shipped presets |
| `preset-history` | Native projection of preset policy state (`dscodePresetHistory`) |
| `preset-catalog` | Native preset registry plus editable local bundles; legacy presets read-only |
| `team-presets` | Whether a preset mounts the native Agent Team tools |
| `session-migration` | Normalizes historical model-selection events before native migration |
| `session-discovery` | Session roster over native full-text query and projection cache |
| `session-list` | Session-picker metadata (first prompt, title, activity) and its index |
| `session-artifacts` | Title, references and archive RPCs: session admission, cancellation, drains |
| `session-export` | Atomic logical-log archive save; no partial ZIP, no overwrite |
| `session-commands` | Command advertisement and routing over dsh's command registry |
| `execution-world` | Where tools run: local, or the SSH workspace a profile configures |
| `mcp` | ACP MCP declarations to agent-scoped DSH MCP clients, loaded lazily |
| `native-children` | Workflow membership, child views and `/subagents` controls over native services |
| `child-controls` | Child overview, `/subagents` grammar and verbs, inbox views; native calls through ports |
| `child-history` | Append-only child tool/turn metadata index and its serialized, bounded log reads; no transcript copy |
| `workflows` | Read-only projection of tool-workflow durable records (`dscodeWorkflows`) |
| `native-tasks` | Task controls, reminder views from `ctx.schedule`, passive job-output snapshots; no own timer |
| `job-output` | Job-output snapshots and patches from the non-consuming native ring |
| `reminders` | Reminder input parsing, titles and display; validation and mutation stay in dsh-schedule |
| `session-controller` | `sessionController` for Schedule delivery into sessions open in dscode |
| `legacy-reminders` | Projection of rc.1 session-event reminders and their one-time notice |
| `native-session-status` | Goal, activity, plan-mode and context observations; reads never arm a goal |
| `native-interactions` | Permission modes and approvals, user questions and plan reviews, reverse-request admission |
| `native-execution` | Runtime doctor and persistent-terminal controls |
| `terminal-signal` | Retries a foreground-group signal once through the provider |
| `native-asides` | One-shot `/btw` asides, including late handles |
| `native-capabilities` | Read-only views of the current preset's native tools |
| `native-team` | `/team`: read-only roster and task board of the Agent Team |
| `projection` | Pure mapping of session events and tool metadata to TUI wire updates |
| `tool-titles` | Tool card titles read off argument shapes, never tool names |
| `tool-output` | Pure tool-card shapes: ToolKind, rawInput variants, fallback diffs, typed `rawOutput` |
| `image-output` | Resolves tool images through the attachment authority |
| `browser-actions` | Human wording for browser tool cards and approvals |
| `browser-control` | `/browser`: toggles the isolated browser row, edits its settings |
| `profile-plugins` | `/dsh` plugin commands: verb parsing, the profile lock, list/enable/disable/add/inspect/remove, version trust |
| `plugin-bundles` | Bundle patch analysis, isolated npm audit, install verification and rollback; no command parsing |
| `plugin-rows` | Switches bundles and rows through the DSH plugin manager and applies them to the live Loader, rolling back an enable that does not start |
| `plugin-status` | Read-only plugin views: the `/dsh plugins` table and outcome wording, inactive Loader rows for `/doctor`, bundles boot skipped and their one-time note |
| `package-location` | Package provenance; lazy updater resolution and profile lock |
| `guards` | Leaf value guards shared across the bridge; no imports |

## Dependency gate

`tests/architecture.spec.ts` gates the layering. Every module but `index.ts`
declares its local imports, type-only edges included, and each declared name
must exist. `src/` and `bin/` have no runtime import cycle, nothing imports
`index.ts`, and computed imports are enumerated. Cordis is type-only in
`session-models`, `session-presets`, `profile-plugins`, `image-output`, `mcp`
and `session-export`; a runtime dependency only in `native-tasks`,
`session-migration`, `terminal-signal` and `preset-catalog`; absent elsewhere. The entry builds no maps, sets, abort controllers or timers
and imports no `node:net`. `dsh-session-projection` and `zod` stay host peers.
Each `.ts`/`.mjs` file in `src/`, `bin/` and `tests/` is capped at 800 lines;
on 2026-09-24 none exceeds it (largest: `tests/leader-queue.spec.ts`, 763;
largest module: `src/model-catalog.ts`, 596).
`browser/`, `ssh/` and `shared/` are not scanned; their files are under 100.

## Remaining candidates

Since the 2026-09-24 split no module in `src/` exceeds 600 lines and no
function other than a module's factory exceeds 100; the longest are
`session-lifecycle.ts` `forkSession` (88), `projection.ts`
`sessionEventToUpdates` and `prompt-queue.ts` `runPrompt` (87 each). The
factories remain long because they own their module's state:
`createModelCatalog` (536), `createNativeChildren` (490), `index.ts` `apply`
(463), `attachPromptQueue` (449).

`leader-routes` is a registry so feature rows can later register their own
`x.ai/*` methods and become separately mountable, as DSH composes features
from rows; today only `index.ts` registers, and a duplicate registration
throws at mount.

## Harness and launcher invariants

- `dscode_prepare_test_runtime` (`scripts/test-environment.sh`) prepares the
  runtime for `e2e-tui-bridge.sh`, `e2e-provider-manage.sh` and
  `soak-product-loop.sh`. `scripts/test-runtime.mjs` owns artifact selection,
  missing-half builds, fresh extraction and the pin/layout checks listed in
  [upgrade-strategy.md](upgrade-strategy.md), and returns two NUL-delimited
  paths without `eval`. These source-pinned harnesses have no unpinned or
  global-CLI fallback. `scripts/dev-bridge-tests.sh` stays a separate runner;
  `e2e-product.sh` runs its bridge suite through it.
- Acceptance profiles set `[cli] auto_update = false` in a private
  `config.toml`: the `DSCODE_CONFIG` overlay allowlist excludes `cli`.
- `bin/launcher-files.mjs` (builtins only) owns shared file/link operations,
  so `bin/update.mjs` never imports the launcher. `bin/bootstrap.mjs` locks
  the profile only to recover an interrupted update. Lock-binding load
  failures fall back to other runtime locations; `flock` failures propagate.

## Coverage limits

Mac acceptance uses the real TUI and pinned runtime against a local model
fixture and an isolated profile/clipboard. It is not an external-provider or
physical-device test. Linux execution, physical Cmd-click and Kitty rendering
are not inferred from these results.

The earlier wrapped-table-copy failure remains an intermittent observation.
The unchanged full-cell assertion subsequently passed, including candidate runs
19481 and 61580 and integrated run 38320. Source review confirms a 300 ms
processed-event multi-click window and exact entry/range/line matching; the
fixture injects clicks 40 ms apart. Those facts do not establish why that
earlier run copied only its first rendered line. No TUI timing change or weaker
assertion was introduced to claim a fix.

## History

- Refactor contract: `git show 3cf5201acd:docs/architecture-refactor.md`
- 09-13/09-22 reviews: `git show 3cf5201acd:docs/architecture-review.md`
- Remote `f6524d4` merge: `git show 3cf5201acd:docs/upstream-integration.md`
- Post-merge failure fixes: `git show 3cf5201acd:docs/bugfix-review.md`
- E2E script, cache cleanup: `git show 3cf5201acd:docs/maintenance-review.md`
