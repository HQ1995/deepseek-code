# dscode

DeepSeek Harness coding TUI, distributed as a dsh plugin: this package
carries the grok-leader bridge (the dsh-side server the TUI drives) plus the
`dscode` launcher, which materializes the release-pinned TUI binary from
GitHub Releases on first run (SHA-256 verified, cached at
`~/.dsh/profiles/dscode/bin/`).

```sh
npx @hqzhao95/dscode
```

First run runs `npm i -g @deepseek-ai/dsh@<pin>` if `dsh` is not already on PATH, downloads the TUI binary, and links `dscode`. You do not install dsh yourself.

> **Personal project** — not affiliated with, endorsed by, or sponsored by
> DeepSeek or xAI; their names appear only to describe the open-source
> components this package builds on.

Source, issues, full docs: https://github.com/HQ1995/deepseek-code

## The bridge (grok-leader)

Grok leader-protocol unix-socket server that drives DeepSeek Harness agents for grok clients (the TUI, headless modes). It speaks the leader IPC envelope — 4-byte big-endian length plus JSON frames with a type discriminator — and carries ACP JSON-RPC 2.0 payloads inside acp frames, mapping them onto the harness services the ACP bridge drives. The wire facts are pinned by the real TUI capture in [tests/fixtures/grok-tui-messages.jsonl](tests/fixtures/grok-tui-messages.jsonl) and the protocol reference in [docs/grok-leader-protocol.md](../../docs/grok-leader-protocol.md).

This package is a transport adapter, not a UI integration. Interactive rendering stays with the grok client; dsh-side presentation features (plans, titles, usage cards) are not projected onto the wire yet.

## Plugin

apply(ctx, config) binds a node:net unix socket, answers the registration handshake, and drives ctx.agents plus the optional sessionPersistence, userQuestions, agentDefaultModel, agentPresets, and sessions services through structural reads. The socket file is unlinked on disposal, but the bridge never unlinks on EADDRINUSE: it fails loud instead of orphaning a live leader. The launcher owns the path and removes stale files before spawning the leader.

The package doubles as the dscode profile bundle: cordis.patch.yml mounts the server over dsh-base, disables HMR, and inserts the agent-presets roster (default: standard) exactly like the web profile. apps/cli profile-boot patches in the shipped preset root (apps/cli/config/agent-presets) for any composition whose rows include agent-presets.

| Config | Default | Meaning |
|---|---|---|
| socketPath | /tmp/dsh-grok-leader.sock | Unix socket path the grok clients connect to. |
| provider | — | Initial provider route for every created agent. |
| model | — | Initial model for every created agent. |
| combineQueuedPrompts | false | grok ui.combine_queued_prompts parity; env DSCODE_COMBINE_QUEUED=1 also enables it. |
| followUpBehavior | queue | What a prompt sent while a turn runs does: queue (grok parity) parks it until the turn ends — Enter on the queued row is Send Now, which cancels the running turn; steer folds it into the running turn at the harness's next step boundary without interrupting (Codex-style steering). Explicit config wins over the DSCODE_FOLLOW_UP env override. |

## Protocol contract

| Method | Behavior |
|---|---|
| register / registered | The first envelope frame must be register; the leader answers registered with ready: true and a leader_binary_version at least the client version, or the TUI evicts and respawns its own leader. A non-register first frame gets envelope error 1, a second registration error 2, and a 30 s registration timeout error 3. |
| ping / pong | Keepalive pair exchanged every 30 s. |
| initialize | Advertises protocol version 1 and the xai.api_key auth method (the pager fails closed on an empty list), plus the flattened model catalog in _meta.modelState. |
| authenticate | No-op because the server advertises no authentication methods. |
| session/new | Creates a fresh agent with an absolute cwd; mcpServers must be an empty array (any non-array or non-empty value rejects). _meta.sessionId pins the session id and _meta.yoloMode marks the session for pre-approved permission requests. _meta.agentProfile (a string preset id) or the dsh-native _meta.agentPreset resolves through the preset roster and is recorded as meta.agentPreset; absent either, the roster default composes. Inline JSON agent definitions reject. |
| session/prompt | Flattens text and resource-link blocks, permits one in-flight request per session, echoes a user_message_chunk for the accepted prompt, then settles at the correlated turn end with the grok stopReason vocabulary; a turnless admission settles cancelled. |
| session/cancel | Cancels the addressed agent and settles its pending prompt as cancelled; unknown ids are no-ops. |
| session/update | Streams user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, and tool_call_update notifications with per-session eventSeq and promptId stamps. |
| session/load | Validates cwd/mcpServers like session/new, then resumes the persisted session and replays its transcript as isReplay updates before responding. Only the owning client may load a live session; a foreign live owner reads as an unknown session, and a reconnecting client re-attaches once its previous socket is gone. The preset recorded on the persisted header recomposes; a header that predates presets falls back to the TUI's agentProfile, then the roster default. |
| session/list | Lists persisted session headers. |
| session/set_model | Switches the live selection and saves the default through agentDefaultModel; the provider comes from the catalog's modelId-to-provider mapping, then the agent's own route. A modelId outside the catalog rejects instead of persisting an unresolvable selection. |
| session/close | Cancels, flushes through ctx.sessions, and disposes the session. |
| session/request_permission | Offers one-shot allow/reject choices for bridge-owned approval requests; YOLO sessions pre-approve without a roundtrip. |
| x.ai/models/list | Returns the provider catalog as grok SessionModelState. |
| x.ai/providers/add | Writes one provider route into the dsh settings document through the official settings seam (ctx.settings.mutate on the llm-pi-ai namespace); refuses duplicate ids; fills a non-catalog route's models from gateway discovery. Returns the refreshed provider roster. |
| x.ai/providers/update | Merges the form fields over one route's user profile (empty fields unset, models preserved) through the same settings seam. Returns the refreshed roster. |
| x.ai/providers/remove | Unsets one provider route through the settings seam; refuses the provider that owns the current model. Returns the refreshed roster. |
| x.ai/session/list | Session-picker and dashboard list over persisted headers (cwd/query/limit filters, firstPrompt backfill cached per process, rows tagged chat-kind so the TUI bypasses its local-store gate and loads via session/load). |
| notification wire form | Every extension notification (x.ai/*) rides the wire with the ACP '_' prefix (_x.ai/queue/changed, _x.ai/session/prompt_complete, …): the pager's agent-client-protocol decode strips the prefix before dispatching to its x.ai/* handlers and silently drops unprefixed unknown methods as method_not_found. session/update is the sole typed (unprefixed) notification. |
| x.ai/queue/changed | Broadcast on every queue mutation: pending rows (id, version, kind, text, position) plus the running prompt (runningPromptId/runningText/runningKind). Each snapshot carries a strictly increasing seq (epoch-seeded, so a restarted leader outranks its predecessor); the TUI drops any snapshot whose seq is not strictly newer for the session and adopts current_prompt_id from the applied ones. |
| x.ai/queue/interject, /remove, /reorder, /clear | Queue edit notifications. interject is grok send-now: the row jumps to front, the running turn is cancelled (prompt_complete carries cancelTrigger=send_now) and the row runs next. remove (running row falls back to cancel), reorder by orderedIds, clear. |
| x.ai/queue/steer | Queue-row steering: atomically removes a still-pending queued row and merges its text into the running turn WITHOUT cancelling it. The row's RPC settles with the host turn's stop reason; the authoritative `x.ai/queue/changed` rebroadcast is the source of truth. If no turn is running, the row stays queued (benign no-op + resync). |
| x.ai/session/prompt_complete | Terminal signal per settled turn (stopReason, promptId, optional cancelTrigger/cancellationCategory); emitted before the queue broadcast so the pager finalizes and reconciles the turn. The session/prompt RPC result carries the same attribution in _meta (sessionId, promptId), so the pager never has to infer which queue row a settle response belongs to. |
| combine | grok ui.combine_queued_prompts parity: with 2+ plain queued prompts, followers fold into the front (text joined with blank lines, runningCombinedTexts broadcast, followers settle cancelled). Config combineQueuedPrompts or env DSCODE_COMBINE_QUEUED=1; default off. |
| follow-up steer | With followUpBehavior=steer (default queue) — or per prompt via session/prompt _meta.followUp: 'steer' \| 'queue' — a prompt arriving while a turn is in flight is folded into that turn at the harness's next step boundary: its queue row is broadcast once (the pager's optimistic echo retires by id) and then leaves the queue, its text streams as a user echo inside the live turn, and its RPC settles with the host turn's stop reason (own promptId in _meta, no separate prompt_complete). An idle session runs the prompt as its own turn as usual. |
| x.ai/interject | Mid-turn interjection (the pager's Alt+Enter steer chord and plan review comments): merges the text into the running turn at the harness's next step boundary WITHOUT cancelling it, then broadcasts x.ai/session/interjection (sessionId, text, interjectionId) — the originator dedups by id, other panes render the block. An idle session's steering wakes a turn of its own. |
| send now | session/prompt with _meta.sendNow: true (the pager's Ctrl+Enter chord) cancels the running turn (prompt_complete carries cancelTrigger=send_now, suppressing the cancelled marker) and runs this prompt next, ahead of the queue — the composer twin of x.ai/queue/interject. |
| other methods | Unknown requests get JSON-RPC -32601; unknown notifications are dropped with a warning. |

One connection may own several sessions. Each session has an independent prompt slot, workspace, cancellation path, model selection, and disposer; a disconnected client releases exactly its own sessions.

## Lifecycle

Client disconnect and Cordis disposal share the per-client teardown: owned agents cancel, pending prompts settle cancelled, and disposers run in parallel with every failure reported. Other frontends sharing the Context retain their agents.

## Running

The dscode binary bootstraps the leader directly: it resolves dsh (DSH_BIN env, dsh on PATH, then npx --yes @deepseek-ai/dsh), spawns dsh --profile dscode bound to the socket, removes any stale socket file first, waits for the socket, and attaches through the normal --leader path (third_party/grok-build/crates/codegen/xai-grok-pager/src/dsh_leader.rs). The same composition underneath is the agent loop, LLM adapters, session persistence, and this plugin in the dscode profile.

After changing this package, run `scripts/update-bridge.sh` (repo root): building alone is not enough. The profile holds the plugin as a pnpm `file:` dependency materialized as hard links, and tsc replaces output inodes, so the profile keeps serving the old build until its node_modules is rebuilt from scratch — the script does that and verifies the copy. A leader that is already running keeps its loaded code either way; it exits with its last client, and the next dscode spawn picks up the refreshed profile.

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

## Running the tests

The bridge builds and tests against the official npm `@deepseek-ai/dsh-*`
packages, declared as devDependencies. No deepseek-harness checkout is
required.

```sh
pnpm install
pnpm run build
pnpm exec vitest run
```

## License

Apache-2.0. See [LICENSE](LICENSE).
