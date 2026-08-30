# dscode

DeepSeek Harness coding TUI, distributed as a dsh plugin: this package
carries the grok-leader bridge (the dsh-side server the TUI drives) plus the
`dscode` launcher, which materializes the release-pinned TUI binary from
GitHub Releases on first run (SHA-256 verified, cached at
`~/.dsh/profiles/dscode/bin/`).

```sh
npx @hqzhao95/dscode
```

First run reuses an exactly tested `dsh` on PATH or installs the pin under
`~/.dsh/profiles/dscode/runtime`, downloads the TUI binary, and links
`dscode`. It never mutates the global npm prefix.

`dscode update` reconciles the profile package from the matching npm ref
(`latest`, `beta`, or an explicit version) before updating the TUI.
`dscode uninstall` removes only the owned profile and launcher; shared dsh
sessions and storages remain.

> **Personal project** — not affiliated with, endorsed by, or sponsored by
> DeepSeek or xAI; their names appear only to describe the open-source
> components this package builds on.

Source, issues, full docs: https://github.com/HQ1995/deepseek-code

## The bridge (grok-leader)

Grok leader-protocol unix-socket server that drives DeepSeek Harness agents for grok clients (the TUI, headless modes). It speaks the leader IPC envelope — 4-byte big-endian length plus JSON frames with a type discriminator — and carries ACP JSON-RPC 2.0 payloads inside acp frames, mapping them onto the harness services the ACP bridge drives. The wire facts are pinned by the real TUI capture in [tests/fixtures/grok-tui-messages.jsonl](tests/fixtures/grok-tui-messages.jsonl) and the protocol reference in [docs/grok-leader-protocol.md](../../docs/grok-leader-protocol.md).

This package is a transport adapter, not a UI integration. Interactive rendering stays with the grok client; dsh-side presentation features (plans, titles, usage cards) are not projected onto the wire yet.

## Plugin

apply(ctx, config) binds a node:net unix socket after agents and sessionPersistence are ready, answers the registration handshake, and drives the remaining dsh services through structural reads. The socket file is unlinked on disposal, but the bridge never unlinks on EADDRINUSE: it fails loud instead of orphaning a live leader. The launcher owns the path and removes stale files before spawning the leader.

The package doubles as the dscode profile bundle: cordis.patch.yml mounts the server over dsh-base, disables HMR and the implicit DeepSeek route, and inserts the agent-presets roster (default: standard) plus the host code runtime available to the optional `code` preset. A fresh profile is provider-neutral; users add any catalog or custom route through `/provider`. apps/cli profile-boot patches in the shipped preset root (apps/cli/config/agent-presets) for any composition whose rows include agent-presets.

Fresh profiles default to `standard`. A preset picked in the TUI or through
raw `/preset` is saved through the `agent-presets` settings namespace and
becomes the default for later new sessions. Per-session/headless overrides do
not rewrite that default. Resume and fork keep their own durable session preset
unless the user explicitly switches a still-blank session.

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
| initialize | Advertises protocol version 1 and the xai.api_key auth method (the pager fails closed on an empty list), plus the persisted model catalog in _meta.modelState. Remote catalog discovery runs afterward and broadcasts an update, so endpoint latency never blocks startup. |
| authenticate | No-op because credentials belong to the harness-side providers; the advertised compatibility method only satisfies the pager's auth gate. |
| session/new | Creates a fresh agent with an absolute cwd; a non-array mcpServers rejects, but a well-formed array (empty or not) is accepted and ignored with a logged warning — the bridge advertises mcpCapabilities http/sse false and serves no MCP tools, so a TUI-discovered server must not brick the session. _meta.sessionId pins the session id. Permission modes `default`, `workspace-write`, `plan`, `bypassPermissions`, and `always-approve` map to dsh's permission/plan services; an explicit mode wins over _meta.yoloMode. Modes or CLI metadata the bridge cannot enforce (`auto`, `acceptEdits`, `dontAsk`, confining sandbox/tool/rule overrides, `--no-subagents`, and similar) reject instead of silently weakening the launch. `sandbox=off` and its `none` alias are accepted because they match the external dsh leader's actual unconfined execution. _meta.agentProfile (a string preset id) or the dsh-native _meta.agentPreset resolves throu…
| session/prompt | Validates text, resource-link, and image blocks. Images are batch-admitted through dsh's durable attachment store before one user message is appended, preserving block order; image-bearing queued rows never combine with another prompt. Plugin slash commands receive their raw image uploads through the rc.2 command registry, which owns command-specific admission. The bridge permits one in-flight request per session, echoes the accepted display text, then settles at the correlated turn end with the grok stopReason vocabulary; a turnless admission settles cancelled. |
| session/cancel | Cancels the addressed agent and settles its pending prompt as cancelled; unknown ids are no-ops. |
| session/update | Streams user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, and tool_call_update notifications with per-session eventSeq and promptId stamps. Terminal dsh usage includes cache reads/writes in `totalTokens` and carries the exact display-ready `cacheHitPercent`, including an empty non-rendering chunk when streamed text already suppressed the assembled message. |
| session/load | Validates cwd/mcpServers and CLI metadata like session/new, then resumes the durable session. Interactive loads replay the transcript as isReplay updates; `_meta.noReplay: true` rebuilds state without emitting prior text for headless output. Only the owning client may reload a live session. The latest durable preset and model selections win; a preset may change only before model-visible history exists. |
| session/list | Lists persisted session headers. |
| session/set_model | Switches the live selection, appends a durable session event, and saves the default for new sessions through agentDefaultModel. Provider and effort memory are keyed by the exact provider/model route. A modelId outside the catalog rejects; unsupported saved efforts are dropped instead of reaching the provider. |
| session/set_mode | Maps `plan` to the selected preset's plan-mode service and all other ids to leaving plan mode; rejects when that service is not present. |
| session/close | Cancels, flushes through ctx.sessions, and disposes the session. |
| session/request_permission | Offers one-shot allow/reject choices for bridge-owned approval requests; YOLO sessions pre-approve without a roundtrip. |
| x.ai/models/list | Returns the current provider catalog as grok SessionModelState and schedules non-blocking discovery for compatible custom routes. Exact dsh input modalities become `inputModalities` plus `acceptsImages`; only affirmative image metadata enables image paste, while text-only and unknown models fail closed. Recognized `/models` reasoning extensions are persisted as pi-ai `reasoningEfforts`; selectors then expose only the exact model's declared levels. |
| x.ai/providers/add | Writes one provider route into the dsh settings document through the official settings seam (ctx.settings.mutate on the llm-pi-ai namespace); refuses duplicate ids; fills a non-catalog route's models from gateway discovery. Returns the refreshed roster and broadcasts the new catalog. |
| x.ai/providers/update | Merges the form fields over one route's user profile (empty fields unset, models preserved) through the same settings seam. Returns the refreshed roster and broadcasts the new catalog. |
| x.ai/providers/remove | Unsets one provider route through the settings seam; refuses the provider that owns the current model. Returns the refreshed roster and broadcasts the new catalog. |
| x.ai/commands/list | Returns the built-in bridge commands plus commands registered by the live session's plugin composition. A supplied session id must belong to the caller. |
| x.ai/ask_user_question | Routes dsh questions to the owning TUI. Separate header, question, and supporting detail fields are preserved in the card's multiline heading; multiline free-form notes return unchanged. |
| x.ai/session/list | Session-picker and dashboard list over persisted headers and logs (cwd/query/limit filters, durable title and firstPrompt projection, latest-event ordering, rows tagged chat-kind so the TUI bypasses its local-store gate and loads via session/load). |
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

For headless selection, an explicit wire model id resolves through the current
catalog before the saved provider default. This keeps `--model <id>` usable
when the profile still remembers a provider route that was removed or renamed.

The resolved provider/model route is also written into the parent dsh
`AgentOptions` for create, resume, and fork. This is required by dsh's child
agent resolver: native `subagent` runs inherit that route instead of receiving
an unset `{{model}}` prompt variable.

## Slash commands and plugins

Preset support is registry-driven, not an allowlist. The four shipped presets are regression baselines (`minimal`: two native tools; `code`: `run_code`; `standard`: native catalog; `cordis`: native plus Cordis tools). User presets under dsh's preset root appear in `/preset` with their own ids and names. Their actual tool schemas drive TUI capability flags, and commands registered in their dsh scope flow through `available_commands_update`.

The automatic compatibility boundary is the standard dsh seams: presets, tools, commands, providers, models, settings, and session services. A plugin that requires a browser-only UI slot, a custom frontend panel, a private ACP method, or its own durable session-event vocabulary needs an explicit dscode adapter; pinned dsh 0.1.1-rc.2 has no public downstream event-type registration seam. The bridge does not guess or silently emulate unsupported surfaces, and mount or protocol failures stay visible.

The bridge owns `/dsh` and the headless/raw `/preset` path. `/preset` changes composition only before model-visible history exists. Model-facing add-ons are not mounted globally over the preset layer: in particular, the shipped `minimal` preset remains exactly `bash` plus `str_replace_editor`. `/compact` is discovered and executed through the preset-scoped dsh command registry (`standard`, `code`, and `cordis`); a raw request under `minimal` gets a precise unavailable result. `/loop` is likewise capability-gated and stays hidden unless a preset-scoped scheduling composition supplies it. Unsupported dsh extension commands (`/delete`, `/remember`, `/mcps`, and `/skills`) are hard-hidden in the TUI and explicitly refused by the bridge, so they never fall through as model prompts.

`/dsh add [--trust] <spec>` first installs into an isolated npm stage with lifecycle scripts disabled, parses and reports every bundle's composition patch, and requires `--trust` before registering any executable bundle. The real profile install is re-verified before its bundle list is atomically updated. `/dsh remove <name>` unregisters the bundle before uninstalling the dependency, so an npm failure leaves inert files rather than a broken profile reference. Core profile packages cannot be added or removed through this path.

## Lifecycle

Client disconnect and Cordis disposal share the per-client teardown: owned agents cancel, pending prompts settle cancelled, and disposers run in parallel with every failure reported. Other frontends sharing the Context retain their agents.

## Running

The dscode binary bootstraps the leader directly: it resolves the tested dsh from the launcher's `DSH_BIN` or an existing `dsh` on `PATH`, spawns `dsh --profile dscode` bound to the socket, removes any stale socket file first, waits for the socket, and attaches through the normal `--leader` path (`third_party/grok-build/crates/codegen/xai-grok-pager/src/dsh_leader.rs`). It never starts an npm install after entering the alternate screen. The same composition underneath is the agent loop, LLM adapters, session persistence, and this plugin in the dscode profile.

After changing this package, run `scripts/update-bridge.sh` (repo root): building alone does not replace the copy already installed in the profile. The script packs the local bridge, installs it without changing the profile's registry or `file:` dependency, and verifies the bridge, launcher, and composition files. A leader that is already running keeps its loaded code either way; it exits with its last client, and the next dscode spawn picks up the refreshed profile.

## Model Experience

### Prompt content

#### What the model sees

`session/prompt` text blocks are concatenated verbatim; a baseline resource link becomes a bracketed textual reference. Image blocks are validated and normalized into immutable dsh attachment references before the user message enters durable history, then the selected adapter performs its model-specific request resize/format/offload policy. Protocol metadata, client capabilities, permission choices, and session ids never enter the model request.

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
- Leader-version mirror — the registered reply mirrors the client's advertised `client_version` (floor `0.0.0` when absent). The TUI evicts strictly-older leaders; the dsh backend respawns the same plugin, so equality is the only convergent answer, whatever version the TUI carries (release pin, `-dev` suffix, or a bare cargo build).
- Transcript projection incomplete — plans, titles, and usage cards stay off the wire; cancelRewind and sessionRecap mirror the captured stub without verified semantics.
- Provider-scoped model ids adapted — the first bare model id keeps the TUI-friendly spelling; collisions are qualified as `provider:model`, and reasoning-effort memory is keyed by the underlying provider/model pair.
- Replay buffering — live notifications racing a session/load are dropped by the high-water mark instead of buffered for a gap-free flush (server.rs MAX_BUFFERED_LIVE_PER_LOAD).
- Verified divergences — inline `_meta.agentProfile` objects are rejected (dsh has no AgentDefinition equivalent), and grok-only registration-capability injections (autoMode, codeNav, terminal/fs routing) are deliberately absent from `session/new`; each divergence is annotated at the code site with the grok file:line it was checked against.

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
