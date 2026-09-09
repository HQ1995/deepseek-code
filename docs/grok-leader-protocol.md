# Leader bridge protocol

This document is the maintenance contract between the `dscode` TUI and
`bridge/grok-leader`. The implementation and tests are authoritative:

- envelope codec: `bridge/grok-leader/src/codec.ts`
- envelope types: `bridge/grok-leader/src/protocol.ts`
- bridge behavior: `bridge/grok-leader/src/index.ts`
- captured TUI handshake: `bridge/grok-leader/tests/fixtures/grok-tui-messages.jsonl`

## Transport

- macOS and Linux use a Unix domain socket selected by `DSCODE_SOCKET`.
- Each frame is a 4-byte big-endian payload length followed by one UTF-8 JSON
  object. Payloads are capped at 64 MiB.
- The launcher starts `dsh --profile dscode`, waits for the socket, then
  connects the TUI. A sibling lock file records the leader PID.

## Envelope

The client sends `register`, `acp`, `ping`, `control`, or `disconnect`. The
leader replies with `registered`, `acp`, `pong`, `control_result`, or `error`.

Registration must be the first message and complete within 30 seconds:

| Error code | Meaning |
|---|---|
| `1` | first message was not `register` |
| `2` | client registered twice |
| `3` | registration timed out |

`registered` carries the protocol version, a compatible leader binary version,
and `ready: true`. Protocol mismatches fail before ACP traffic. Control commands
are currently unsupported and return a structured error.

## ACP lifecycle

ACP JSON-RPC objects travel as strings inside `acp` envelopes.

| Surface | Contract |
|---|---|
| `initialize`, `authenticate` | advertise models, commands, capabilities, and the bridge-owned auth stub |
| `session/new` | create a dsh agent for an absolute cwd and optional preset/model metadata |
| `session/prompt`, `session/update` | admit durable images, stream text/reasoning/tool activity/diffs, and project exact token/cache usage plus turn completion |
| `session/cancel` | cancel the active turn and reconcile queued prompts |
| `session/load`, `session/list`, `session/close` | resume, enumerate, and dispose durable dsh sessions |
| `session/set_model`, `session/set_mode` | switch model/effort and plan mode |
| `session/request_permission` | route tool approval to the owning TUI client |

The bridge also implements the `x.ai/*` surfaces required by this TUI:

- models and provider CRUD
- preset and slash-command discovery
- session list (durable titles and latest activity), info, history, fork,
  rename, and `/btw`
- queue edit, reorder, remove, clear, send-now, and steer
- prompt-complete, interjection, question, and lifecycle notifications
- exact model image-capability gating, durable image prompt admission, and
  image-bearing plugin command dispatch
- multiline dsh question headers/details and free-form answers
- preset-scoped manual `/compact` dispatch through dsh's command registry;
  presets without a compaction command fail closed
- `x.ai/goal` executes the preset-scoped native `/goal` command outside ordinary
  prompt admission, without fabricating model calls or prompt-complete events
- native goal, permission, and task state/control from the owning dsh services
- `x.ai/subagents` runs `/subagents` controls outside the parent's prompt queue:
  list, pending, queue, steer, edit, remove, steer-queued (one/all), clear, stop
- `x.ai/subagent/inbox` returns structured child/queue rows and applies the same
  native controls, with exact descendant/message IDs and stale-text checks.
- `x.ai/task/output` returns an owned job's non-consuming retained output;
  live snapshots also feed the existing Tasks log viewer. For native PTY sends,
  the observer reads retained terminal scrollback and freezes it at completion;
  it never calls the consumptive operation reader or marks the job reported.
- `x.ai/session/export` accepts an owned `sessionId` and a `prompt` containing
  exactly one text block with a `.zip` filename. Relative paths resolve against
  that session's cwd. The native exporter includes descendants and attachments;
  completion returns `{result: {kind: "success", text: "Session archive exported
  to …"}}`. Publication is atomic and refuses an existing file or symlink.
  Client disconnect aborts the stream. The TUI always selects its current root
  session, including when invoked from a child view. Export bypasses model calls.
- `x.ai/scheduler/list`, `create`, and `delete` use the official Schedule tools.
  Native changes feed Tasks reminders; delivery resumes with the owning session.

Extension notifications use the `_x.ai/*` wire spelling expected by the ACP
decoder. `session/update` remains the normal unprefixed ACP notification.

## Invariants

- `session/new` and `session/load` require an absolute cwd. ACP `mcpServers`
  accepts validated stdio and Streamable HTTP declarations; servers mount before
  the agent is published and are disposed with that session. Invalid declarations
  or startup failures reject the request. Profile MCPs may also come from DSH.
- A live session has one owning client. Another connected client cannot steal
  or inspect it.
- Unsupported CLI metadata is rejected instead of silently weakened.
  `sandbox=off` and `sandbox=none` are accepted because they match the external
  dsh leader's execution model.
- Interactive loads replay persisted updates with `isReplay`. Headless loads
  set `_meta.noReplay` so old assistant text does not contaminate the new JSON
  result; projection state and sequence high-water marks are still rebuilt.
- Goal hydration replays durable ID, revision, phase, and round counters and reads
  process-local activation; restore neither rearms continuation nor repeats
  completion celebration.
- Cancelling an underway armed goal leaves it paused/disarmed with exactly one
  revision increment. The bridge
  explicitly pauses active/armed goals before cancellation because native idle
  cancellation is a no-op; a dormant active/disarmed goal is not changed or revised.
  On the pinned DSH runtime, host `/goal pause` also aborts the live turn;
  model-initiated pause finishes its own turn.
- Activity updates carry `_meta.sessionRunning` from native agent status,
  independently of foreground prompt IDs; native goal rounds need no synthetic
  foreground prompt. `/auto` remains unsupported and cannot change permissions
  or invoke the model.
- A fresh profile may advertise no providers or models. Provider mutations
  broadcast the refreshed catalog, and model/effort selections persist both as
  the default for new sessions and as session-local durable events.
- Fresh profiles resolve new sessions to `standard`. A TUI picker selection
  stamped with `_meta.rememberAgentPreset: true`, or raw `/preset`, writes
  `agent-presets.default` for later new sessions. Unmarked per-session/headless
  overrides remain session-local. Resume and fork retain their durable session
  preset unless a still-blank session receives another manual selection.
- An explicit wire model id with no explicit provider resolves through the live
  catalog before any saved default route. A removed or renamed saved provider
  therefore cannot poison headless `--model <id>`.
- The resolved provider/model route is materialized in the parent dsh
  `AgentOptions` on create, resume, and fork, so native child/subagent sessions
  inherit the actual route rather than an unset model prompt variable.
- Custom-route discovery is stale-while-revalidate: initialization returns the
  persisted catalog immediately, then broadcasts any background refresh.
  Recognized OpenAI-compatible `/models` reasoning extensions are translated
  into pi-ai per-model capabilities. Effort choices then come only from that
  exact dsh metadata; stale unsupported values are omitted rather than guessed
  from provider or model names.
- Image uploads accept only dsh-supported raster media types and canonical
  base64. A batch is committed before the user message is appended; rejected
  batches publish no usable references. Image-bearing queued rows never combine.
- Model modalities fail closed: only an affirmative `acceptsImages: true` or
  `inputModalities` containing `image` enables image paste and model prompts.
  Text-only and unknown routes reject images before attachment storage.
- Cumulative token accounting keeps uncached input, cache reads, cache writes,
  and output disjoint; it is not current context pressure. Context `used` and
  `total` come from native projected next-request tokens and context-window
  capacity. Native breakdowns are approximate; missing pressure, capacity,
  breakdown, and auto-compaction threshold data remain explicitly unavailable.
  Only a true full cache hit displays `100%`; near-full ratios stay below 100.
- `x.ai/session/info.context.compactionCount` advances on each durable
  `compaction/end`, including replayed events after a session resume.
- Permission controls use native permission/plan services; an explicit mode
  takes precedence over the legacy YOLO bit. Task rows and terminal status come
  from native jobs/subagents, and cancellation goes through their owning services,
  not a fabricated shell exit code or success result.
- Child controls resolve only descendants of the owning session and require
  continuable mode. Queue/Steer use native `subagents.prompt` with fresh user RPC
  provenance. Edits retain message IDs and source; Stop retains pending input.
  Commands accept unique child/message ID prefixes and return `result.kind`
  (`success` or `error`) plus `result.text`, without completing the parent turn.
  A same-ID child continuation emits a fresh sequenced `subagent_spawned` with
  `resumed_from` equal to the child ID. The TUI reopens its terminal row once,
  preserving the in-memory transcript; stale duplicates cannot reopen it.
- Native children carry `nativeChildHistory: true` and a `nativeAttemptId`
  derived from the child session ID and native turn number. A finish must match
  that attempt; a late finish cannot end a subsequent turn. Completed children
  are rediscovered from native persistence when their parent is restored.
- `x.ai/subagent/history` accepts the owning `sessionId`, a descendant
  `childSessionId`, and an optional nonnegative `after` cursor. Responses contain
  `entries` (ACP updates with replay metadata or `turnEnded` boundaries),
  `nextSeq`, `totalSeq`, and `durable`. Pages cover at most 256 native events.
  `x.ai/subagent/history_changed` carries the parent ID, child ID and `nextSeq`;
  an open view fetches committed native events on notification. Closed finished
  views release transcript memory only after a successful durable read. Failed
  reads retain existing history and can be retried by reopening the view.
- Goal activation changes use native `goal/activation-changed` notifications;
  there is no periodic Goal reconciliation timer. New model selections append
  native `model/selection` events. For historical V0/V1/V2 logs the bridge adapts
  `dscode/model-selected` and `model/selected` before native migration, preserving
  original generations and native validation, locks and atomic publication.
- Only the `history` preset adds the five official history tools to `standard`:
  `session_search`, `session_event_search`, `session_trace`, `session_event_trace`,
  and `session_event_read`. They remain workspace-scoped even with explicit
  foreign session IDs; ordinary presets do not gain these tools globally.
- Unknown JSON-RPC methods return `-32601`; invalid parameters return `-32602`.
- Disconnect and plugin disposal cancel and flush only the sessions owned by
  that client, including agents created by requests still awaiting publication.
  Reconnection cancels idle exit even while an earlier teardown is flushing.

## Prompt queue

Queue snapshots carry an increasing `seq` and per-row identity/version. The TUI
accepts only newer snapshots. `x.ai/session/prompt_complete` precedes the queue
snapshot and carries the same `promptId` attribution as the prompt RPC result.

Send-now cancels the current turn and runs the selected row next; its completion
uses `cancelTrigger=send_now`. Steering merges text at the next native step
without cancellation. Queued steering leaves the row queued if no turn is active.
Combined rows are limited to plain text; image-bearing prompts remain separate.

Session-picker cold reads share at most four open logs. Each response owns its
projection snapshots so cache eviction cannot erase rows in a concurrent request.

For validation commands, see [Upgrade and release](upgrade-strategy.md#validation).

## Skill discovery and preset authoring

`x.ai/skills/list` requires an owned `sessionId`; discovery uses that agent scope
and cwd. `x.ai/commands/list` and ambient `available_commands_update` merge
user-invocable skills after native commands, preserving collision precedence.
The TUI inserts a native `/name` mention into the draft and DSH loads it through
its own user-invocation pre-step. No skill body is loaded by Rust.

`x.ai/presets` uses `{sessionId, action}` with `list` as default. `copy` takes
`from` and `id`; `read`/`edit` take `id`. Native copy/read APIs own the filesystem
operation. Only native `trust: user` entries produce `document.editPath` for the
external editor; shipped entries can be read or copied. Replies use the existing
session and modal nonce checks, so a dismissed or rebound session cannot open an
editor from a stale reply. Copies and file edits leave live compositions intact.

## Persistent terminal controls and runtime diagnostics

`x.ai/terminals` requires an owned `sessionId`. `action` defaults to `list`;
`terminalId` optionally selects a non-consuming preview of the latest 1000
retained lines. `interrupt` sends native SIGINT, while `close` awaits native
`terminals.kill()` before returning the remaining roster. All IDs are matched
against the exact Agent owner, including child isolation. Mutation requests reject
unknown/foreign IDs; list refreshes drop vanished selections without reading them. The TUI confirms close, preserves rows after errors, and uses the
existing session/modal nonce guards. Snapshot status describes shell liveness,
not inferred command idleness. Output paging clamps at its last wrapped page.

`x.ai/doctor` requires an owned `sessionId` and a semver `tuiVersion`, and returns
`{text}` for the existing doctor transcript. The bridge runs the shared read-only
installation helper off the event loop, then uses the native execution host to
resolve shipped LSP dependencies and inspect PTY registration. No tool, model,
server startup or package installation is triggered. The TUI drops results from
a rebound session. The launcher’s `doctor --runtime` path runs before installation
or startup validation, so broken tuples can still be diagnosed.

Preset copy success selects the submitted native id and clears any filter that
would hide it. Ordinary list refreshes preserve selection. Failed copies keep the
draft; shipped-file and duplicate-name protections remain in the native API.
