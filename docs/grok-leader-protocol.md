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

Extension notifications use the `_x.ai/*` wire spelling expected by the ACP
decoder. `session/update` remains the normal unprefixed ACP notification.

## Invariants

- `session/new` and `session/load` require an absolute cwd and an empty
  `mcpServers` array. Harness-side MCPs belong in the dsh composition.
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
- On the pinned published DSH `0.1.2-rc.1` runtime, cancelling an underway armed
  goal leaves it paused/disarmed with exactly one revision increment. The bridge
  explicitly pauses active/armed goals before cancellation because native idle
  cancellation is a no-op; a dormant active/disarmed goal is not changed or revised.
  `/goal pause` stops future rounds without aborting the current turn. Ctrl+C
  still cancels actual native running activity after that pause.
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
- Only the `history` preset adds the five official history tools to `standard`:
  `session_search`, `session_event_search`, `session_trace`, `session_event_trace`,
  and `session_event_read`. They remain workspace-scoped even with explicit
  foreign session IDs; ordinary presets do not gain these tools globally.
- Unknown JSON-RPC methods return `-32601`; invalid parameters return `-32602`.
- Disconnect and plugin disposal cancel and flush only the sessions owned by
  that client.

## Validation

Run the socket contract and real product flows with:

```sh
scripts/e2e-product.sh
scripts/e2e-product.sh --full --provider-ui
```

The full suite uses isolated homes and a mock model gateway.
