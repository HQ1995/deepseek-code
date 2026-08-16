# Agent Note: grok leader transport over a unix socket

Status: implemented

English | [中文](2026-08-15-grok-leader-transport.zh.md)

## Problem

The grok TUI and headless clients attach to a shared leader process over a unix socket instead of embedding an agent, and the dsh side had no server for that wire. The contract spans a length-prefixed JSON envelope (protocol.rs ClientMessage/ServerMessage) plus ACP JSON-RPC payloads inside acp frames, and the real TUI is strict about the handshake: a registered reply without ready plus a leader_binary_version at or above the client version makes the TUI evict and respawn its own leader, and a non-empty authMethods list forces authentication before the welcome screen (docs/grok-tui-connect.md capture, docs/grok-leader-protocol.md).

## Decision

@deepseek-ai/dsh-grok-leader (packages/bridge/grok-leader) implements the leader server as a Cordis plugin over node:net. The envelope layer (codec.ts, protocol.ts) pins the 4-byte big-endian framing, 64 MiB cap, snake_case wire names, and the probe-verified registered/pong replies to the captured TUI transcript (tests/fixtures/grok-tui-messages.jsonl). The inner ACP dialect maps onto the services the ACP bridge drives: agents.create/resume, agent.followup/whenIdle/cancel, the session/event firehose projected to session/update kinds (user_message_chunk, agent_message_chunk, agent_thought_chunk, tool_call, tool_call_update) with per-session eventSeq/promptId stamps and a dsh-seq high-water dedup, approval/request to session/request_permission with YOLO pre-approval, sessions.flush on close, the llm catalog to _meta.modelState and x.ai/models/list, sessionPersistence.list/load with isReplay transcript replay before the response, and agentDefaultModel.saveSelection for session/set_model.

The package doubles as the deepseek-leader profile bundle: cordis.patch.yml mounts the server over dsh-base and inserts the agent-presets roster (default: standard) like the web profile, with the shipped preset root patched in by apps/cli profile-boot. The grok TUI's agent selection arrives as session/new and session/load _meta.agentProfile — a string name or an inline JSON definition (pager effects/helpers.rs SessionFlags::to_meta; upload/turn.rs parse_agent_profile_from_meta). A string (or the dsh-native _meta.agentPreset) resolves through the roster and is recorded as meta.agentPreset with the preset mounted in the agent setup; the roster default composes when nothing is sent, and inline JSON definitions reject because a grok AgentDefinition has no dsh equivalent. On load the preset recorded on the persisted header wins for replay. The flat modelState catalog keeps a leader-side modelId-to-provider map, so session/set_model switches the provider that owns the chosen model instead of falling back to the first registered adapter.

## Alternatives considered

**Reuse packages/acp/acp behind a spawned bridge process.** Rejected: the grok leader dialect is a length-prefixed binary envelope, not newline-delimited JSON-RPC stdio; the ACP bridge owns one connection and its teardown model, while the leader multiplexes several clients with per-session ownership and per-client release.

**Reuse @agentclientprotocol/sdk for the inner JSON-RPC layer.** Rejected: the pinned grok schema (agent-client-protocol 0.10.4) diverges from the SDK method set (session/set_model, x.ai/models/list ext, initialize modelState), so the grok shapes are hand-typed from the pinned sources and the capture, with TODO(verify) markers naming the grok file:line where a surface is unverified.

**Broadcast interactions to every subscriber, first answer wins, as server.rs does.** Rejected for this change: permission and ask_user_question requests route to the session-owning client only; multi-client broadcast, interaction caching, and replay-on-attach are deferred.

## Consequences

The real TUI handshake completes against the captured wire, and the session flow (new, prompt, cancel, chunks, models, list, load, close, permission, preset routing, cross-provider model switch) is covered end-to-end over a socket against a mocked agent registry. The control plane is stubbed with a ControlResult error, leader_binary_version is pinned to 1.0.4, and provider-scoped model ids are flattened into grok's global catalog while the provider mapping is retained leader-side; each carries a TODO(verify) with a grok file:line. Live notifications racing a session/load replay are dropped by the high-water mark instead of buffered (server.rs MAX_BUFFERED_LIVE_PER_LOAD), and the ask_user_question shapes plus capability injection remain unverified. The codec tests replay the captured transcript byte-for-byte, so any wire drift fails the suite.
