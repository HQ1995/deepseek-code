# Leader bridge protocol

This document is the maintenance contract between the `dscode` TUI and
`bridge/grok-leader`. The implementation and tests are authoritative:

- envelope codec: `bridge/grok-leader/src/codec.ts`
- envelope types: `bridge/grok-leader/src/protocol.ts`
- bridge behavior: `bridge/grok-leader/src/index.ts`
- captured TUI handshake: `bridge/grok-leader/tests/fixtures/grok-tui-messages.jsonl`

## Transport

- macOS and Linux use a Unix domain socket selected by `DSCODE_SOCKET`, or
  derived from the canonical profile path and TUI build when no override is set.
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

`registered` carries the protocol version, the loaded bridge's actual package
version, and `ready: true`. The TUI accepts its matching bridge version (also
without a development TUI's trailing `-dev`); a different version fails with an
update/profile diagnostic and does not evict another session's external leader.
Protocol mismatches fail before ACP traffic. Control commands are currently
unsupported and return a structured error.

## ACP lifecycle

ACP JSON-RPC objects travel as strings inside `acp` envelopes.

Tool-result updates use ACP status `completed` or `failed`, including nested
PTC calls and replay. `error` is not an accepted tool status: the TUI decoder
drops the entire frame, not just its status. Error metadata remains a separate
field on the failed result.

A `tool_call` is titled by its tool name unless its arguments say what it does:
a browser action reads `Browser: <action>`, a call whose arguments carry
`questions: [{question}]` reads `Ask: <question>` (`Ask N questions` for
several), and an execute call that runs `code` rather than a shell `command`
(PTC's `run_code`) reads `code: <first non-empty line>`, which the TUI shows as
`Run code: …`. Its result keeps no Bash-shaped `rawOutput`. Such a card keeps
its tool name in `_meta['x.ai/tool'].name`, which headless output reads before
the title.

| Surface | Contract |
|---|---|
| `initialize`, `authenticate` | advertise models, commands, capabilities, the execution world, and the bridge-owned auth stub |
| `session/new` | create a dsh agent for an absolute cwd and optional preset/model metadata; a remote world confines the cwd to its workspace |
| `session/prompt`, `session/update` | admit durable images, stream text/reasoning/tool activity/diffs, and project exact token/cache usage plus turn completion |
| `session/cancel` | cancel the active turn and reconcile queued prompts |
| `session/load`, `session/list`, `session/close` | resume, enumerate, and dispose durable dsh sessions |
| `session/set_model`, `session/set_mode` | switch model/effort and plan mode |
| `session/request_permission` | wait for the owning client's answer; disconnect/cancel cancels the request without inventing a user rejection. The tool call carries the planned arguments as `rawInput` (`{variant: 'MCPTool', tool_name, tool_input}` for MCP tools) and, for browser tools, a `title` phrase; `_meta.dscodeAlwaysAsks` marks prompts the client must neither auto-approve nor offer always-approve on. A reject whose response carries `_meta.followup_message` resolves as a rejection, then steers that text into the running turn like `x.ai/interject` (broadcast as an `x.ai/session/interjection` without an id); with no turn running it queues as the next prompt |

`initialize` `_meta.dscodeExecutionWorld` says where tools run: `{kind: 'local'}`,
or `{kind: 'ssh', host, workspace}` for a profile whose SSH adapter owns the
filesystem, subprocess, sandbox and PTC providers. In a remote world, session
paths are not host paths. The TUI then opens sessions at the remote workspace,
and it must not link, open, read, preview or complete session paths on this
computer, nor load local project configuration. The bridge refuses a
`session/new` or `session/load` cwd outside the workspace and ACP stdio MCP
servers, and writes relative `.zip` exports under the home directory on this
computer. While the SSH adapter is not connected (it failed to start or lost
its connection), `session/new`, `session/load` and turn-starting prompts fail
with `-32602` naming the reason and the restart; slash commands still run.

The bridge also implements the `x.ai/*` surfaces required by this TUI:

- models and provider CRUD
- preset and slash-command discovery
- session list (durable titles and latest activity), info, history, fork,
  rename, and `/btw`; `x.ai/session/delete` (the dashboard's delete) fails with
  an internal error saying DSH keeps sessions, since DSH has no session delete
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
- `x.ai/scheduler/list`, `create`, and `delete` call the Host Schedule service
  (`ctx.schedule`); `create` titles a reminder with its first line. The bridge
  provides `sessionController.resolveAgent`, which answers at once, only for
  sessions a TUI has open and ready here. A reminder that falls due while its
  session is closed or busy is retried when the session becomes ready: opening,
  a rolled-back reload and a finished preset change each call the patched
  Schedule `requestDelivery`.
  `schedule/changed` feeds the Tasks pane (`scheduled_task_created`;
  `scheduled_task_deleted` with reason `completed` or `deleted`, both with
  `_meta.nativeSchedule`). Lists include ended reminders until deleted. A failed
  Schedule read is logged and never fails a session open. rc.1 session-event
  reminders are not migrated: each open sends one `image_dropped` system note
  naming them (`_meta.legacySchedule`).
- When the leader's start skipped profile bundles, the first session opened in
  that leader (new, loaded or forked) gets one `image_dropped` system note, after
  its response, naming each bundle, its reason and the leader log path. Later
  sessions of the same leader get none.

Extension notifications use the `_x.ai/*` wire spelling expected by the ACP
decoder. `session/update` remains the normal unprefixed ACP notification.

## Turn activity notices

These ride `_x.ai/session_notification`, as `image_dropped` notes do, with the
session output's `eventSeq` and `promptId` stamps. They feed TUI renderers that
already exist; nothing here adds a TUI code path.

- A DSH `llm/retry` (a scheduled model-request retry) sends `retry_state`
  `{type: 'retrying', attempt, max_retries, reason}`, live only; `max_retries`
  is 0 for an unbounded policy. `is_rate_limited` is never sent: that flag is
  xAI's upsell. The TUI clears the state at the retried attempt's first
  streamed update, a later failure or the turn's end.
- A `turn/end` whose reason is an error sends `retry_state`
  `{type: 'failed', error_type, message}` live and on replay, before the prompt
  RPC rejects. `error_type` follows the native code (`CONTEXT_WINDOW_EXCEEDED`
  → `context_length`, `RATE_LIMIT` → `rate_limited`, `TIMEOUT` →
  `idle_timeout`, `TRANSPORT` → `http`, `EMPTY_RESPONSE` → `empty_response`),
  else `api` when the provider sent an HTTP status, else `other`. The message
  and the rejection (`turn failed: …`) name the status, code and provider
  request id. A 402 reads `HTTP 402` and `Unauthorized (401)` reads
  `Unauthorized, HTTP 401`, because the TUI takes the other spellings for
  xAI's credit-limit upsell or `/login`. Missing or unusable keys send no
  state; they still settle as the `/provider` refusal.
- While the model streams a tool call's arguments, the live
  `agent/assistant-stream` delta sends `tool_call_delta_chunk`
  `{tool_index, name?}` (the content-block position, and the name once it
  arrives): the TUI's "Writing file…"/"Preparing <tool>…" status. Arguments
  are never forwarded; the durable `tool/call` still opens the card. A call is
  sent when it starts, when its name arrives and then at most every 2 s while
  it keeps streaming, inside the TUI's 10 s dead-stream cutoff. Replay sends
  none.
- An automatic compaction (`compaction/*` markers without a
  `sourceCommandId`; a `/compact` command keeps the TUI's command flow) sends
  `auto_compact_started` `{tokens_used, context_window, percentage}` at its
  start, live only and only when native occupancy and capacity are known: the
  TUI's "Context N% full. Compacting…" line and spinner. Its end sends
  `auto_compact_failed` `{error}` or `auto_compact_completed`
  `{tokens_before, tokens_after, elapsed_ms, summary_preview}`, live and on
  replay. Live, `tokens_after` is the native next-request projection, which
  reprices the shadowed span at once; on replay, and live without that
  projection, it is the last reported prompt size minus the summary's shadowed
  tokens plus its output. The TUI shows the completion at the turn's end and
  empties its todo pane, so the bridge sends the turn's last plan again.

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
- Live reload holds its native session through async durable-history capture
  and read-handle cleanup before retirement. Closing cancels that read but waits
  for actual completion; read failure keeps the original owner usable. Live
  fork fixes its event cursor before flushing, then reads exactly that complete
  durable prefix. Concurrent appends are excluded and short reads fail closed.
- Rewind-point enumeration fixes its cursor before flushing and selects user
  prompt previews from storage pages of at most 256 events. It keeps the same
  complete point list, indices and preview text; unrelated transcript bodies
  are not collected. Short/noncontiguous pages fail the request. Close cancels
  and drains the read and handle cleanup before disposing the source session.
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
  the default for new sessions and as session-local durable events. Like DSH's
  own model picker, the bridge also rebuilds the catalog on
  `llm/adapters-updated`, `settings/document-updated`, `app-boot/config-reload`,
  `credentials/reference-updated` and `credentials/record-updated`: a burst of
  events settles into one rebuild, broadcast as `x.ai/models/update` only when
  what clients were last sent changed.
- Fresh profiles resolve new sessions to `standard`. A TUI picker selection
  stamped with `_meta.rememberAgentPreset: true`, or raw `/preset`, writes
  `agent-preset-registry.selectedDefault` for later new sessions. Unmarked per-session/headless
  overrides remain session-local. Resume and fork retain their durable session
  preset unless a still-blank session receives another manual selection.
- An explicit wire model id with no explicit provider resolves through the live
  catalog before any saved default route. A removed or renamed saved provider
  therefore cannot poison headless `--model <id>`.
- A remembered route (a resumed or forked session's last selection, or the
  saved default for a new session) that the catalog no longer carries falls
  back to the catalog's current model. Once the open is answered, that session
  gets one `image_dropped` system note: `Saved model <provider>/<model> is
  unavailable; using <provider>/<model>. /model to change.`
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
  not a fabricated shell exit code or success result. A background subagent's
  `subagent` job gets no task row: its child row stands for it, and
  `x.ai/subagent/cancel` on that one-shot child kills the job (found by its
  description among the session's running subagent jobs; a description another
  job or running one-shot child shares refuses). A `workflow` job keeps its task
  row, since the workflow row offers no stop.
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
  Stop reads its initial attempt asynchronously and tracks turn starts during
  that read, including handle cleanup. It rechecks the exact live Agent before
  interrupting; an ended/replaced child is not interrupted.
- `x.ai/subagent/history` accepts the owning `sessionId`, a descendant
  `childSessionId`, and an optional nonnegative `after` cursor. Responses contain
  `entries` (ACP updates with replay metadata or `turnEnded` boundaries),
  `nextSeq`, `totalSeq`, and `durable`. Pages cover at most 256 native events.
  `x.ai/subagent/history_changed` carries the parent ID, child ID and `nextSeq`;
  an open view fetches committed native events on notification. Closed finished
  views release transcript memory only after a successful durable read. Failed
  reads retain existing history and can be retried by reopening the view.
  Live reads fix their cursor before flushing and use the same owned storage
  handle as cold reads. Incremental metadata and requested pages remain bounded
  to 256 events; short/noncontiguous pages fail closed. Session cancellation or
  shutdown aborts reads and drains actual handle cleanup before returning.
- Goal activation changes use native `goal/activation-changed` notifications;
  there is no periodic Goal reconciliation timer. New model selections append
  native `model/selection` events. For historical V0/V1/V2 logs the bridge adapts
  `dscode/model-selected` and `model/selected` before native migration, preserving
  original generations and native validation, locks and atomic publication.
- Only the `history` preset adds the five official history tools to `standard`:
  `session_search`, `session_event_search`, `session_trace`, `session_event_trace`,
  and `session_event_read`. They remain workspace-scoped even with explicit
  foreign session IDs; ordinary presets do not gain these tools globally.
- Unknown JSON-RPC methods return `-32601`; invalid parameters return `-32602`
  with `data.message` repeating the message, so the TUI shows a refusal as
  final rather than as a retryable failure.
- `subagent_finished` carries `duration_ms` with `_meta.subagentDurationAvailable`
  when the child's settled run length is known, even while its other metrics
  are not (`subagentMetricsAvailable: false`).
- `x.ai/session/list` and `x.ai/sessions/list` leave out subagent and teammate
  children (`origin: 'subagent'`); an exact-id query still finds one.
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

`x.ai/session/cancel_prompt` is a dscode extension **request** with
`{sessionId, promptId}`. It requires the owning client and returns `{status}`:

- `cancelled`: retired this preparing/queued prompt, or requested cancellation
  of its active native turn. It does not prove that earlier effects never ran.
- `cancelling`: signalled a native command; accepted atomic operations may finish
  before cancellation settles. No late unhandled-command fallback is admitted.
- `already_submitted`: the prompt is settling or was merged as steering, so it
  cannot be independently retracted without affecting another turn.
- `not_found`: no current owner for that ID; this is not proof of non-execution.

It never falls back to session-wide cancellation. Unrelated queued rows and edit
holds survive; only cancelling the active owner also cancels its human requests
and pauses its goal. A cancelled preparation releases its FIFO slot immediately,
but real native storage remains in the shutdown drain and cannot later submit
the prompt. Cancelling a waiting slot cannot let successors overtake earlier
preparation. Prompt IDs must be unique among active requests; use fresh IDs for
retries, never automatic resends after an uncertain timeout.

Old leaders reject this method with method-not-found, safely leaving their queue
intact. Clients must not retry it as legacy `session/cancel` with extra metadata:
old bridges ignore that metadata and cancel the whole session queue. Legacy
`session/cancel` retains its existing whole-session semantics.

The TUI/headless first-ack watchdog uses a 120s hard deadline. TUI displays a
notice after 10s; `DSCODE_PROMPT_ACK_TIMEOUT_SECS` can tune the hard deadline to
5–3600s (zero/invalid/missing values retain 120s; the notice is at most half the
hard deadline). A matching queue row/running ID, live named update, terminal
notification or prompt RPC response disarms it. Replay and unrelated activity
do not count. Acknowledged model work has no deadline from this watchdog.

On expiry, TUI retires only its local prompt view and restores the original
composer content when safe; a newer image-free text draft is retained below it.
New images, queue edits and interaction-owned input are not overwritten with
the expired prompt. Committed native scrollback is not removed. The original
prompt remains in the transcript when it cannot be restored. Late updates are
discarded by the existing rewound-ID gates. Reconnect owns its own recovery.
Cancellation confirmation is bounded to 2s; failure/old leaders display a warning.
Headless emits `prompt_ack_timeout` and exits nonzero, with bounded cancellation
and log flush. Neither surface automatically retries or claims non-execution.

`node scripts/e2e-prompt-ack.mjs` exercises compiled headless and tmux clients
against a local socket fixture (no model credentials). Set `DSCODE_TUI_BIN` to
the built client and optionally `DSCODE_E2E_ACK_OUT` for its isolated artifacts.
This complements, not replaces, real DSH acceptance.

Session-picker cold reads share at most four open logs. Each response owns its
projection snapshots so cache eviction cannot erase rows in a concurrent request.

For validation commands, see [Upgrade and release](upgrade-strategy.md#validation).

## Skill discovery and preset authoring

`x.ai/skills/list` requires an owned `sessionId`; discovery uses that agent scope
and cwd. `x.ai/commands/list` and ambient `available_commands_update` merge
user-invocable skills after native commands, preserving collision precedence.
The ambient update is re-sent on `commands/change`, `skills/change`, and on
`tools/change` when a session's capabilities change. A tool-registry change
inside a conversation reaches the TUI as an `image_dropped` system note
(`Tools added: …` / `Tools removed: …`), live and on replay.
The TUI inserts a native `/name` mention into the draft and DSH loads it through
its own user-invocation pre-step. No skill body is loaded by Rust.

`x.ai/presets` uses `{sessionId, action}` with `list` as default. `copy` takes
`from` and `id`; `read`/`edit` take `id`. Native copy/read APIs own the filesystem
operation. Only native `trust: user` entries produce `document.editPath` for the
external editor; shipped entries can be read or copied. Replies use the existing
session and modal nonce checks, so a dismissed or rebound session cannot open an
editor from a stale reply. Copies and file edits leave live compositions intact.

Live preset selection reads the host-only `dscodePresetHistory` projection,
registered through the native `sessionProjections` service before the bridge
accepts clients. It preserves the existing model-visible-history lock and latest
valid selection across resume/fork, without retaining transcript bodies. Missing
policy state fails closed; it does not fall back to a synchronous log scan. The
native projection registry owns restore, incremental updates and cache lifetime.

## Workflow history state

Workflow rendering reads the host-only `dscodeWorkflows` projection, registered
before clients are accepted. The bridge defines the workflow-domain JSON fold;
the native registry drives seed, append and checkpoint lifetime. State keeps run
and member metadata, not unrelated transcript bodies. Inherited workflow history
is preserved, members render in native sequence order, and repeated names remain
distinct by run ID. Liveness, active phase and elapsed time are rendered from
current native runtime state, never persisted as active-state claims. The child
view is still published before a workflow exposes that member.

Production bridge code has no direct `snapshotEvents`, `eventAt` or `ownEvents`
dependencies. This does not remove the pinned SDK's internal synchronous reads
or full in-memory log, and does not claim a measured memory or latency gain.

## Persistent terminal controls and runtime diagnostics

`deliverables/presented` events project to Markdown file links through the
existing `agent_message_chunk` update. Projection covers live events, session
resume and child-history pages; relative paths resolve against the viewed
session's workspace, including forks. It neither copies nor opens file contents.
Native configurable-provider diagnostics use the existing provider `note` field,
including providers with no serviceable models, without hiding healthy routes.
A provider whose model listing throws (an expired login, an unreachable
endpoint) stays in the roster with no models and `could not list models: …` as
its note, as DSH's own catalog reports per-provider failures; initialize,
`x.ai/models/list` and provider writes keep working.

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
