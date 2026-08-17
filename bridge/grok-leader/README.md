# @deepseek-ai/dsh-grok-leader

English | [中文](README.zh.md)

Grok leader-protocol unix-socket server that drives DeepSeek Harness agents for grok clients (the TUI, headless modes). It speaks the leader IPC envelope — 4-byte big-endian length plus JSON frames with a type discriminator — and carries ACP JSON-RPC 2.0 payloads inside acp frames, mapping them onto the harness services the ACP bridge drives. The wire facts are pinned by the real TUI capture in [tests/fixtures/grok-tui-messages.jsonl](tests/fixtures/grok-tui-messages.jsonl) and the protocol reference in [docs/grok-leader-protocol.md](../../../docs/grok-leader-protocol.md).

This package is a transport adapter, not a UI integration. Interactive rendering stays with the grok client; dsh-side presentation features (plans, titles, usage cards) are not projected onto the wire yet.

## Plugin

apply(ctx, config) binds a node:net unix socket, answers the registration handshake, and drives ctx.agents plus the optional sessionPersistence, userQuestions, agentDefaultModel, agentPresets, and sessions services through structural reads. The socket file is removed on disposal; a stale socket file from a crashed leader is unlinked once on EADDRINUSE.

The package doubles as the deepseek-leader profile bundle: cordis.patch.yml mounts the server over dsh-base, disables HMR, and inserts the agent-presets roster (default: standard) exactly like the web profile. apps/cli profile-boot patches in the shipped preset root (apps/cli/config/agent-presets) for any composition whose rows include agent-presets.

| Config | Default | Meaning |
|---|---|---|
| socketPath | /tmp/dsh-grok-leader.sock | Unix socket path the grok clients connect to. |
| provider | — | Initial provider route for every created agent. |
| model | — | Initial model for every created agent. |
| combineQueuedPrompts | false | grok ui.combine_queued_prompts parity; env DEEPSEEK_LEADER_COMBINE_QUEUED=1 also enables it. |

## Protocol contract

| Method | Behavior |
|---|---|
| register / registered | The first envelope frame must be register; the leader answers registered with ready: true and a leader_binary_version at least the client version, or the TUI evicts and respawns its own leader. A non-register first frame gets envelope error 1, a second registration error 2, and a 30 s registration timeout error 3. |
| ping / pong | Keepalive pair exchanged every 30 s. |
| initialize | Advertises protocol version 1 and the xai.api_key auth method (the pager fails closed on an empty list), plus the flattened model catalog in _meta.modelState. |
| authenticate | No-op because the server advertises no authentication methods. |
| session/new | Creates a fresh agent with an absolute cwd; empty mcpServers are accepted, non-empty values reject. _meta.sessionId pins the session id and _meta.yoloMode marks the session for pre-approved permission requests. _meta.agentProfile (a string preset id) or the dsh-native _meta.agentPreset resolves through the preset roster and is recorded as meta.agentPreset; absent either, the roster default composes. Inline JSON agent definitions reject. |
| session/prompt | Flattens text and resource-link blocks, permits one in-flight request per session, echoes a user_message_chunk for the accepted prompt, then settles at the correlated turn end with the grok stopReason vocabulary; a turnless admission settles cancelled. |
| session/cancel | Cancels the addressed agent and settles its pending prompt as cancelled; unknown ids are no-ops. |
| session/update | Streams user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, and tool_call_update notifications with per-session eventSeq and promptId stamps. |
| session/load | Resumes the persisted session and replays its transcript as isReplay updates before responding. The preset recorded on the persisted header recomposes; a header that predates presets falls back to the TUI's agentProfile, then the roster default. |
| session/list | Lists persisted session headers. |
| session/set_model | Switches the live selection and saves the default through agentDefaultModel; the provider comes from the catalog's modelId-to-provider mapping, then the agent's own route. |
| session/close | Cancels, flushes through ctx.sessions, and disposes the session. |
| session/request_permission | Offers one-shot allow/reject choices for bridge-owned approval requests; YOLO sessions pre-approve without a roundtrip. |
| x.ai/models/list | Returns the provider catalog as grok SessionModelState. |
| x.ai/providers/add | Writes one provider route into the dsh settings document through the official settings seam (ctx.settings.mutate on the llm-pi-ai namespace); refuses duplicate ids; fills a non-catalog route's models from gateway discovery. Returns the refreshed provider roster. |
| x.ai/providers/update | Merges the form fields over one route's user profile (empty fields unset, models preserved) through the same settings seam. Returns the refreshed roster. |
| x.ai/providers/remove | Unsets one provider route through the settings seam; refuses the provider that owns the current model. Returns the refreshed roster. |
| x.ai/session/list | Session-picker and dashboard list over persisted headers (cwd/query/limit filters, firstPrompt backfill cached per process, rows tagged chat-kind so the TUI bypasses its local-store gate and loads via session/load). |
| x.ai/queue/changed | Broadcast on every queue mutation: pending rows (id, version, kind, text, position) plus the running prompt (runningPromptId/runningText/runningKind). The TUI adopts current_prompt_id from this. |
| x.ai/queue/interject, /remove, /reorder, /clear | Queue edit notifications. interject is grok send-now: the row jumps to front, the running turn is cancelled (prompt_complete carries cancelTrigger=send_now) and the row runs next. remove (running row falls back to cancel), reorder by orderedIds, clear. |
| x.ai/session/prompt_complete | Terminal signal per settled turn (stopReason, promptId, optional cancelTrigger/cancellationCategory); emitted before the queue broadcast so the pager finalizes and reconciles the turn. |
| combine | grok ui.combine_queued_prompts parity: with 2+ plain queued prompts, followers fold into the front (text joined with blank lines, runningCombinedTexts broadcast, followers settle cancelled). Config combineQueuedPrompts or env DEEPSEEK_LEADER_COMBINE_QUEUED=1; default off. |
| other methods | Unknown requests get JSON-RPC -32601; unknown notifications are dropped with a warning. |

One connection may own several sessions. Each session has an independent prompt slot, workspace, cancellation path, model selection, and disposer; a disconnected client releases exactly its own sessions.

## Lifecycle

Client disconnect and Cordis disposal share the per-client teardown: owned agents cancel, pending prompts settle cancelled, and disposers run in parallel with every failure reported. Other frontends sharing the Context retain their agents.

## Running

Compose the plugin into a cordis.yml alongside the agent loop, LLM adapters, and session persistence (the same composition dsh-acp requires), then launch the grok TUI against the socket with --leader --leader-socket <socketPath> --sandbox off --no-auto-update. No bundled launcher exists yet; see the Known Limitations section.

## Model Experience

### Prompt text

#### What the model sees

`session/prompt` text blocks are concatenated verbatim into one user message; a baseline resource link appears in that message as a bracketed `resource_link` reference the model may open with its own tools. Protocol metadata, client capabilities, permission choices, and session ids never enter the model request.

#### Token effect

Prompt tokens are data-dependent and remain in that session's history until compaction. Concurrent leader sessions retain independent contexts.

#### KV Cache effect

Append-only; the new user message follows the reusable request prefix and does not invalidate prior cache entries.

### Permission decisions

#### What the model sees

Nothing directly. The owning tool records its allowed, rejected, cancelled, or unavailable outcome through the normal tool-result path.

#### Token effect

Only the owning tool result contributes tokens.

#### KV Cache effect

Append-only through the owning tool result.

## Known Limitations and Deferred Work

- Control plane stubbed — control commands answer a ControlResult error; GetLeaderInfo and CpuProfileStatus are unimplemented (protocol.rs ControlCommand).
- Leader-version pin — leader_binary_version is pinned to 1.0.4 to satisfy the probe-verified TUI; it is not derived from the package version.
- Transcript projection incomplete — plans, titles, and usage cards stay off the wire; cancelRewind and sessionRecap mirror the captured stub without verified semantics.
- Provider-scoped model ids flattened — grok expects one global catalog of bare modelId strings; the leader keeps the modelId-to-provider mapping privately for session/set_model, so the bare-id wire contract costs no provider ownership on switch.
- Replay buffering — live notifications racing a session/load are dropped by the high-water mark instead of buffered for a gap-free flush (server.rs MAX_BUFFERED_LIVE_PER_LOAD).
- Unverified surfaces — the x.ai/ask_user_question request and answer shapes, capability injection into session/new, the grok built-in agentProfile name mapping (grok-build-plan and friends have no dsh preset counterparts), and the lock-file singleton guard carry TODO(verify) markers with grok file:line citations.

## Running the tests out-of-tree

The bridge resolves its @deepseek-ai/* peers from the built deepseek-harness
submodule. Link them once, then run vitest from the harness install:

```sh
# from bridge/grok-leader
mkdir -p node_modules/@deepseek-ai
ln -sfn ../../deepseek-harness/vendor/cordis node_modules/@deepseek-ai/cordis
ln -sfn ../../deepseek-harness/vendor/schemastery node_modules/@deepseek-ai/schemastery
ln -sfn ../../deepseek-harness/packages/core/agent node_modules/@deepseek-ai/dsh-agent
../../deepseek-harness/node_modules/.bin/vitest run
```

## License

Apache-2.0. See [LICENSE](LICENSE).
