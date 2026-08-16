# Grok Leader Protocol

This is a reference for the IPC protocol between grok clients (the TUI in `xai-grok-pager`, headless modes, IDE extensions) and the shared `grok` leader process, including the ACP (Agent Client Protocol) JSON-RPC traffic the leader multiplexes. It documents what the implementation in the ground-truth checkout does, so a foreign client or a dsh-side server can interoperate with it.

Citations are `file:line` into the ground-truth checkout at `/tmp/grok-build-src`; paths under `crates/codegen/` are grok sources. ACP request/response field definitions live in the pinned crates.io dependencies `agent-client-protocol-schema 0.11.4` and `agent-client-protocol 0.10.4` (both pinned by `Cargo.lock`); citations into them use the `agent-client-protocol-schema@0.11.4:` prefix. All line numbers are from the 2026-08-15 checkout.

The protocol has two layers: the leader IPC envelope (per-connection `ClientMessage`/`ServerMessage` frames) and the ACP payloads (JSON-RPC 2.0 objects) forwarded inside envelope `Acp` frames. Control operations (`ControlCommand`) are one-shot request/response pairs on the envelope layer; all streaming happens on the ACP layer.

## 1 Transport

### 1.1 Unix socket and lock files

On Unix the transport is a Unix domain socket. The default path is `<grok-home>/leader.sock` (the module diagram at `crates/codegen/xai-grok-shell/src/leader/mod.rs:26`; path derivation at `crates/codegen/xai-grok-shell/src/leader/lock.rs:92`), paired with the sibling flock file `leader.lock` (`lock.rs:57`). `grok_home` is `~/.grok` by default.

`compute_ws_url_suffix` (`lock.rs:13`) appends `-<8-hex-hash>` of the grok websocket URL to both file names when the URL is non-default: empty URL and the default production relay URL get no suffix, so environments get distinct sockets (`leader.sock`, `leader-3f2a1b0c.sock`, ...). The lock and socket suffix can be recovered from a path pair via `ws_url_suffix_from_paths` (`lock.rs:96`).

The `GROK_LEADER_SOCKET` environment variable overrides the socket path entirely, and the sibling `.lock` is derived from it (`lock.rs:44-50`, `lock.rs:57`). Both the client and the spawned leader honor it, and the TUI sets it from its `--leader-socket` flag (`crates/codegen/xai-grok-pager-bin/src/main.rs:1921-1922`).

The lock is flock-based mutual exclusion with the leader PID written into the lock file (`lock.rs:191`, `lock.rs:243`, `lock.rs:253`); exactly one leader runs per machine per ws-url suffix. The socket file is created by the leader at bind time and removed at shutdown (`crates/codegen/xai-grok-shell/src/leader/server.rs:1563`, `server.rs:2331`), and readiness is probed by file existence (`crates/codegen/xai-grok-shell/src/leader/transport.rs:19-26`).

### 1.2 Windows named pipe

On Windows tokio exposes no AF_UNIX, so the same path API is mapped onto a named pipe `\\.\pipe\grok-leader-<hash>`, where the leaf hash is SipHash-1-3 with fixed keys (stable across Rust versions) (`transport.rs:230-249`). Readiness is probed non-connecting with `WaitNamedPipeW` so a probe never consumes a real `accept()` (`transport.rs:204-228`). The wire protocol over the pipe is identical to the Unix socket.

### 1.3 Framing

Every message is a 4-byte big-endian `u32` byte length followed by exactly that many bytes of UTF-8 JSON (`read_frame`/`write_frame` at `crates/codegen/xai-grok-shell/src/leader/protocol.rs:22`, `protocol.rs:44`). The maximum body size is 64 MiB; an oversized length prefix fails with `MessageTooLarge` before the body is read (`protocol.rs:8`, `protocol.rs:35`). A clean EOF while reading the prefix is `ConnectionClosed`, and a malformed body is `InvalidJson` (`protocol.rs:11-20`).

Each frame body is exactly one JSON object. Envelope objects are discriminated by a `type` field serialized in snake_case (`protocol.rs:292`, `protocol.rs:342`). `Acp` frames carry one JSON-RPC 2.0 object each. The agent's line discipline can leave a trailing newline on payloads; readers must tolerate it, and the TUI strips trailing whitespace before sending (`crates/codegen/xai-grok-pager/src/acp/leader_bridge.rs:193`; the in-process agent trims on emit at `crates/codegen/xai-grok-shell/src/leader/in_process.rs:58-73`).

### 1.4 Keepalive, timeouts, and version handling

The client sends `Ping` every 30 s and the leader answers `Pong` (`crates/codegen/xai-grok-shell/src/leader/client.rs:25`, `client.rs:500-519`; `server.rs:2524-2529`). Client connects time out after 5 s per attempt with 3 retries at 100 ms (`client.rs:21-23`, `client.rs:309-327`). The client waits up to 10 s for `Registered` (`client.rs:28`, `client.rs:359-367`), and the leader gives a connection 30 s to send `Register` (`server.rs:36`, `server.rs:2377-2393`). After `Registered { ready: false }` the client waits up to `LEADER_READY_TIMEOUT` for `LeaderReady` (`client.rs:35`, `client.rs:403-428`; the 300 s behavior is pinned by `client.rs:578-585`).

There is no version negotiation step: `LEADER_PROTOCOL_VERSION` is `1` (`protocol.rs:125`), registration succeeds against any version, and only the control surface rejects a mismatched advertised version with `UnsupportedControl` (`client.rs:187-205`; pinned by the `wrong_protocol_version_registers_but_rejects_control` test). When the registered client's binary version differs from the leader's, the leader pushes a one-shot ACP notification `x.ai/leader/version_mismatch` (`server.rs:1474-1504`, emitted at registration `server.rs:1669`).

## 2 Message inventory

### 2.1 Client to leader: `ClientMessage` (`protocol.rs:292-320`)

| variant | fields | pairing and behavior |
|---|---|---|
| `Register` | `client_type: string`, `mode: ClientMode`, `capabilities: ClientCapabilities` | must be the first frame. Anything else gets envelope `Error` code 1 `Expected Register message` (`server.rs:2474-2484`); a second `Register` gets code 2 `Already registered` (`server.rs:2533-2540`); nothing within 30 s gets code 3 `Registration timeout` (`server.rs:2377-2393`). Answered by `Registered`. |
| `Acp` | `payload: string` (one JSON-RPC 2.0 object) | bidirectional ACP tunnel; the hot path. No envelope-level ack. |
| `Control` | `request_id: string`, `command: ControlCommand` | one-shot; answered by `ControlResult` with the same `request_id` (`client.rs:187-237`). |
| `Ping` | — | answered by `Pong` (`server.rs:2524-2529`). |
| `Disconnect` | — | graceful client-initiated close (`client.rs:508`). |

`ClientMode` (`protocol.rs:112-119`): `headless` (client driven remotely through the grok.com websocket relay; the first headless registration flips the leader's relay demand on) or `stdio` (local IPC; the TUI uses this).

### 2.2 Leader to client: `ServerMessage` (`protocol.rs:342-413`)

| variant | fields | behavior |
|---|---|---|
| `Registered` | `client_id: u64`, `ready: bool`, `leader_protocol_version?: u32`, `leader_binary_version?: string`, `leader_capabilities?: LeaderCapabilities` | registration confirmation. `ready` defaults to `true` for old leaders that predate the field (`protocol.rs:335`). When `ready` is `false` the client must send no ACP until `LeaderReady` arrives (`server.rs:2439-2457`). |
| `Acp` | `payload: string` | one JSON-RPC 2.0 object. |
| `ControlResult` | `request_id: string`, `result: Result<ControlPayload, ControlError>` | control response; `ControlError` is `{ code, message, details? }` (`crates/codegen/xai-grok-shell-base/src/cpu_profile.rs:33`, `cpu_profile.rs:62`). |
| `Pong` | — | keepalive answer. |
| `Error` | `code: i32`, `message: string` | envelope-level errors: 1 expected-register, 2 already-registered, 3 registration-timeout. |
| `ShuttingDown` | `reason: ShutdownReason`, `delay_ms: u64` | advance notice; `delay_ms` is always `0` today, so `Shutdown` follows immediately (`protocol.rs:391-396`, `server.rs:2575-2591`). |
| `Shutdown` | — | connection is about to close. |
| `LeaderReady` | — | sent after a `ready: false` registration once initialization completes (`server.rs:2455`). |

`ShutdownReason` (`protocol.rs:322-333`): `auto_update` (leader relaunches onto a freshly installed binary; clients reconnect immediately), `manual` (default), `idle_timeout` (reserved, never emitted).

### 2.3 Capabilities

`ClientCapabilities` (`protocol.rs:128-175`), all optional with defaults: `yolo_mode`, `auto_mode`, `default_model`, `client_version`, `code_nav_enabled`, `terminal`, `fs_read`, `fs_write`. Each is injected by the leader into `session/new`/`session/load`/`session/resume` requests unless already present (see 3.4).

`LeaderCapabilities` (`protocol.rs:176-194`), all optional: `control_v1`, `runtime_cpu_profile`, `profile_formats`, `workspace_exposure`, `relaunch_v1`. Clients must treat every control command beyond the handshake as capability-gated.

### 2.4 Control channel

`ControlCommand` (`protocol.rs:195-228`) and the payload that answers each command:

| command | fields | response payload |
|---|---|---|
| `GetLeaderInfo` | — | `LeaderInfo` (`server.rs:1237-1242`, built at `server.rs:977`) |
| `CpuProfileStatus` | — | `CpuProfileStatus` (`server.rs:944`) |
| `StartCpuProfile` | `output?: string`, `frequency_hz?: i32` | `CpuProfileStarted`, or `CpuProfileStatus` when the profiler ends up inactive or stopping (`server.rs:1246-1277`) |
| `StopCpuProfile` | — | `CpuProfileStopped` (handled asynchronously; `server.rs:1753-1765`, `server.rs:1296`) |
| `WorkspaceStart` | `hub_url?: string`, `cwd: string` | `WorkspaceStatus` (`server.rs:1102`) |
| `WorkspacePause` | — | `WorkspaceStatus` (`server.rs:1172`) |
| `WorkspaceResume` | — | `WorkspaceStatus` (`server.rs:1189`) |
| `WorkspaceStop` | — | `WorkspaceStatus` (`server.rs:1210`) |
| `WorkspaceStatus` | — | `WorkspaceStatus` (`server.rs:1220`) |
| `RelaunchForUpdate` | `to_version: string` | `Relaunching`, or `RelaunchDeclined` when `to_version` is not strictly newer or a relaunch is already in progress (`server.rs:1394-1432`) |

`ControlPayload` variants with fields (`protocol.rs:229-291`): `LeaderInfo { pid, socket_path, lock_path, ws_url_suffix, leader_protocol_version, leader_binary_version, profiling_supported, profiling_compiled_in, cpu_profile_active, cpu_profile_stopping, profile_started_at, profile_formats }`; `CpuProfileStatus { active, stopping, started_at, svg_path, frequency_hz }`; `CpuProfileStarted { pid, svg_path, frequency_hz, started_at }`; `CpuProfileStopped { pid, svg_path, started_at, stopped_at }`; `WorkspaceStatus { state, hub_url?, cwd?, uptime_ms, active_tool_calls, sessions, pid }`; `Relaunching { from_version, to_version, grace_ms }`; `RelaunchDeclined { reason }`.

The control channel is strictly one-shot request/response keyed by `request_id`; no streaming exists on it. `RelaunchForUpdate` additionally arms a bounded-grace drain (5 s in-flight grace, 5 s session flush) before the leader exits with `ShutdownReason::AutoUpdate` (`server.rs:1377`, `server.rs:1434-1472`).

### 2.5 ACP layer: agent-bound methods (client to agent)

Grok's typed gateway inventory is `AcpAgentMessageGeneric` (`crates/codegen/xai-acp-lib/src/message.rs:400-425`) with request/response pairs at `message.rs:352-398`. Wire names and field definitions come from the schema crate (`agent-client-protocol-schema@0.11.4:src/agent.rs:4079-4110`):

| wire method | request fields | response fields |
|---|---|---|
| `initialize` | `protocolVersion`, `clientCapabilities`, `clientInfo?`, `_meta?` (`agent.rs:47`) | `protocolVersion`, `agentCapabilities`, `authMethods`, `agentInfo?`, `_meta?` (`agent.rs:113`) |
| `authenticate` | `methodId`, `_meta?` (`agent.rs:253`) | `_meta?` (`agent.rs:292`) |
| `session/new` | `cwd`, `mcpServers`, `additionalDirectories?` (unstable), `_meta?` (`agent.rs:909`) | `sessionId`, `modes?`, `models?`, `configOptions?`, `_meta?` (`agent.rs:985`) |
| `session/load` | `sessionId`, `cwd`, `mcpServers`, `additionalDirectories?` (unstable), `_meta?` (`agent.rs:1082`) | `modes?`, `models?`, `configOptions?`, `_meta?` (`agent.rs:1159`) |
| `session/set_mode` | `sessionId`, `modeId`, `_meta?` (`agent.rs:2017`) | `_meta?` (`agent.rs:2048`) |
| `session/set_model` (unstable) | `sessionId`, model fields (`agent.rs:3307`) | model state (`agent.rs:3348`) |
| `session/prompt` | `sessionId`, `prompt: [ContentBlock]`, `messageId?` (unstable), `_meta?` (`agent.rs:2912`) | `stopReason`, `userMessageId?`, `usage?`, `_meta?` (`agent.rs:2997`) |
| `session/cancel` (notification) | `sessionId`, `_meta?` (`agent.rs:4462`) | — |

The schema also defines `session/list`, `session/fork`, `session/resume`, `session/close`, `logout`, `nes_*`, and `document_*` (`agent.rs:4087-4110`), but these are not in grok's typed gateway inventory (`message.rs:400-425`), so grok does not send them over this path today.

### 2.6 ACP layer: client-bound methods (agent to client, reverse requests)

Typed inventory `AcpClientMessageGeneric` (`message.rs:180-215`), pairs at `message.rs:154-177`; wire names at `agent-client-protocol-schema@0.11.4:src/client.rs:1775-1790`:

| wire method | kind | fields |
|---|---|---|
| `session/update` | notification | `sessionId`, `update`, `_meta?` (`client.rs:37`) |
| `session/request_permission` | request | `sessionId`, `toolCall`, `options: [PermissionOption]`, `_meta?` (`client.rs:541`); response `{ outcome: { cancelled } | { selected: { optionId, _meta? } } }` (`client.rs:667-737`) |
| `fs/read_text_file` | request | fields at `client.rs:848` (response `client.rs:911`) |
| `fs/write_text_file` | request | fields at `client.rs:763` (response `client.rs:812`) |
| `terminal/create` | request | fields at `client.rs:964` (response `client.rs:1063`) |
| `terminal/output` | request | fields at `client.rs:1101` (response `client.rs:1142`) |
| `terminal/release` | request | fields at `client.rs:1193` (response `client.rs:1234`) |
| `terminal/wait_for_exit` | request | fields at `client.rs:1341` (response `client.rs:1382`) |
| `terminal/kill` | request | fields at `client.rs:1267` (response `client.rs:1308`) |

`session/update` carries the `SessionUpdate` enum discriminated by a `sessionUpdate` tag: `user_message_chunk`, `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `plan`, `available_commands_update`, `current_mode_update`, `config_option_update`, `session_info_update`, `usage_update` (`client.rs:74-135`). This is the streaming channel: every chunk of a turn is one notification.

### 2.7 Extension methods and notifications

Any method outside the typed tables rides the ACP extension slots. The wire form is a top-level `_`-prefixed method: `{"jsonrpc":"2.0","id":...,"method":"_x.ai/foo","params":{...}}`; receivers strip the `_` and treat the message as `ExtRequest`/`ExtNotification` (`agent-client-protocol@0.10.4:src/lib.rs:280-311`; `ExtRequest`/`ExtResponse`/`ExtNotification` at `agent-client-protocol-schema@0.11.4:src/ext.rs:25`, `ext.rs:50`, `ext.rs:67`). Grok emits this form for its internal notifications (`protocol.rs:424-437`), and the leader normalizes both wire forms - direct `x.ai/foo` and wrapped `_x.ai/foo` with the real method nested under `params` - when classifying (`server.rs:439-467`).

`x.ai` methods seen on this channel include `x.ai/session_notification`, `x.ai/session/update`, `x.ai/ask_user_question`, `x.ai/exit_plan_mode`, `x.ai/scheduled_task_inject_prompt`, `x.ai/yolo_mode_changed`, `x.ai/settings/update`, `x.ai/session/prompt_complete`, `x.ai/marketplace/list`, `x.ai/leader/version_mismatch`, and the `_x.ai/internal/*` methods (`protocol.rs:398-412`). Four machine-wide notifications are broadcast to every connected client: `x.ai/sessions/changed`, `x.ai/models/update`, `x.ai/mcp/servers_updated`, `x.ai/announcements/update` (`server.rs:419-437`).

## 3 Session lifecycle over the wire

### 3.1 IPC handshake

Connect, then send `Register` as the first frame (`client.rs:333-351`). The leader replies `Registered` (`server.rs:2366-2425`). If `ready` is `false`, the connection is held until the leader sends `LeaderReady` (`server.rs:2439-2457`). Before readiness, ACP requests receive a JSON-RPC error `-32002` `leader_starting` and ACP notifications are dropped (`server.rs:878-897`, `server.rs:1823-1847`).

Request/response routing is by rewritten request IDs: every forwarded request's `id` becomes `"<clientId>|<original-id-json>"`, and the response's namespaced id is restored before delivery (`server.rs:293-324`). Responses whose requesting client disconnected are dropped (`server.rs:1937-1956`).

### 3.2 initialize

The TUI sends `InitializeRequest` with `protocolVersion: "1"`, `clientCapabilities` (filesystem read/write text file plus terminal per flags, with the x.ai meta of section 4), and `_meta` carrying `clientType`, `clientVersion`, and optionally `systemPromptOverride` and `rules` (`crates/codegen/xai-grok-pager/src/acp/mod.rs:502-560`, `mod.rs:460-470`). The leader injects `clientIdentifier` from the IPC registration's `client_type` when absent (`server.rs:771-810`) and patches the response's `result.meta.modelState.currentModelId` to the client's `default_model` so the TUI never flashes the agent's global default (`server.rs:842-870`, applied at `server.rs:1978-1985`).

### 3.3 authenticate

`AuthenticateRequest { methodId }` uses a method advertised in the initialize response. The TUI authenticates eagerly when the first advertised method is non-interactive (`xai.api_key`/cached token) and defers interactive methods (`grok.com` login) to its welcome screen (`acp/mod.rs:600-700`).

### 3.4 session/new

The TUI sends `NewSessionRequest { cwd, mcpServers, _meta { yoloMode, autoMode, ... } }` (built at `crates/codegen/xai-grok-pager/src/app/effects/mod.rs:184-190` with meta from `crates/codegen/xai-grok-pager/src/app/effects/helpers.rs:358`). The leader then injects, only when absent from `_meta`: `yoloMode` (from `yolo_mode`), `autoMode` (from `auto_mode && !yolo_mode`), `modelId` (from `default_model`), `clientIdentifier`, `x.ai/leaderClientId`, `codeNavEnabled`, `clientTerminal`, `clientFsRead`, `clientFsWrite` (`server.rs:671-770`). The same injection applies to `session/load` and `session/resume`.

The response's `sessionId` subscribes the client to the session and marks it the session driver (`server.rs:557-572`; driver assignment at `server.rs:1849-1858`).

### 3.5 session/prompt and streaming

`PromptRequest { sessionId, prompt, _meta? }` starts a turn; the response `PromptResponse { stopReason, ... }` ends it (`agent.rs:2912`, `agent.rs:2997`). Everything between is streamed as `session/update` notifications, which the leader broadcasts to every subscriber of the session (`server.rs:2199-2260`) and buffers for in-flight loads (3.8).

### 3.6 Permission requests

The agent sends the reverse request `session/request_permission { sessionId, toolCall, options }`; the client must answer with `RequestPermissionResponse { outcome }`. It is one of the shared interactive requests - together with `x.ai/ask_user_question` and `x.ai/exit_plan_mode` - which the leader broadcasts to every subscriber, first answer wins (`server.rs:489-506`). The leader caches each by tool-call id and replays it to a client that attaches mid-request (`server.rs:508-523`, `server.rs:2047-2063`), evicting on `interaction_resolved` (`server.rs:2177-2183`). On `session/cancel` the client must answer every pending permission request with the `cancelled` outcome (`client.rs:707-723`).

### 3.7 Cancel

`session/cancel` is a JSON-RPC notification `{ sessionId }` (`agent.rs:4462`). Non-interactive reverse requests (driver-only) and `x.ai/scheduled_task_inject_prompt` are routed only to the session driver, not broadcast (`server.rs:2204-2237`).

### 3.8 session/load, replay, and session/resume

`LoadSessionRequest { sessionId, cwd, mcpServers, _meta { cursor? } }` attaches to an existing session; the TUI's resume meta includes the `cursor` (last seen event id) (`crates/codegen/xai-grok-pager/src/app/leader_cluster/scenarios.rs:322-345`). `session/resume` is treated as an attach too (`server.rs:344-348`).

Replay mechanics: the leader records the in-flight load by rewritten request id (`server.rs:2033-2040`), buffers live notifications during the load (cap 4096 per load; overflow falls back to live forwarding, `server.rs:47`, `server.rs:2236`), and unicasts the replay to the loading client only, using the `_meta["x.ai/leaderClientId"]` tag the agent echoes from the load request (`server.rs:356-374`, `server.rs:2082-2144`). Replay/live overlap is deduplicated by the monotonic `eventId` sequence before the buffered flush (`server.rs:376-394`, `server.rs:2043`).

### 3.9 Dispose

There is no client-visible dispose method in grok's typed inventory (2.5). Session teardown is leader-side: when the last subscriber of a session disconnects, the leader removes the routing state and tells the agent to evict via the internal notification `_x.ai/internal/evict_sessions { sessionIds }` (`server.rs:1699-1742`, `protocol.rs:398-412`). The ACP schema has `session/close` (unstable; `agent.rs:1615`, wire name `agent.rs:4110`), compiled into grok's dependency (the `unstable` umbrella feature includes `unstable_session_close`), but it is absent from grok's typed gateway, so the TUI never sends it.

### 3.10 Disconnect and leader shutdown

On client disconnect the leader detaches the client's sessions (3.9), transfers a departed session driver to another subscriber, and - when the last client leaves and the leader was not started with `--no-exit-on-disconnect` - the leader exits (`server.rs:1699-1748`). Planned shutdown sends `ShuttingDown { reason, delay_ms: 0 }` then `Shutdown` to every client (`server.rs:2575-2591`); `AutoUpdate` means reconnect immediately (`protocol.rs:322-333`). The client surfaces the reason through `disconnect_reason` (`client.rs:42-52`), and the TUI bridge reconnects automatically (section 5, step 3).

## 4 x.ai-specific capabilities the TUI advertises or requires

| capability | where it is advertised | required or optional |
|---|---|---|
| permission modes | IPC `ClientCapabilities.yolo_mode` / `auto_mode` (`acp/mod.rs:294-297`) | optional; injected into every session request's `_meta` (3.4). |
| default model | IPC `ClientCapabilities.default_model` (`acp/mod.rs:298`) | optional; injected into `session/new` and patched into the initialize response (`server.rs:842`). |
| terminal and filesystem | ACP initialize `clientCapabilities.fs { readTextFile, writeTextFile }` and `terminal` from CLI flags (`acp/mod.rs:515-522`) | optional. `terminal` defaults to false for the TUI; when true the agent routes terminal commands to the client via the `terminal/*` reverse methods (`protocol.rs:166-175`). |
| x.ai capability meta | initialize `clientCapabilities.meta`: `x.ai/incrementalBashOutput: true`, `x.ai/hunkTracker: { mode }`, `x.ai/bashOutputNoColor: true`, `x.ai/gitHeadChanged: true` (`acp/mod.rs:480-490`) | optional; the agent may ignore unknown keys. |
| MCP | per-session `mcpServers` on `session/new` and `session/load` (`effects/mod.rs:184`, `scenarios.rs:330`) | optional. The leader neither inspects nor rewrites `mcpServers`; catalog changes arrive as the machine-wide `x.ai/mcp/servers_updated` broadcast (`server.rs:419-437`). |
| worktree | the `grok worktree` utility is a separate client: it spawns its own embedded agent (not the leader), sends initialize with filesystem capabilities, no terminal, and `clientType` = headless (`crates/codegen/xai-grok-pager/src/worktree_cmd/mod.rs:101-121`), then ext methods `x.ai/git/worktree/list` and `x.ai/git/worktree/db/stats` | not negotiated with the leader at all. |
| marketplace | on-demand ext method `x.ai/marketplace/list` (`crates/codegen/xai-grok-pager/src/app/effects/mod.rs:2473`) | optional; no startup advertisement. |
| voice | not part of the leader protocol. The TUI runs its voice pipeline client-side and shares only the `AuthManager` bearer with the agent (`crates/codegen/xai-grok-pager/src/acp/spawn.rs:47-48`, `spawn.rs:214`; `acp/mod.rs:115`) | nothing voice-related appears in initialize capabilities. |
| leader management | `grok leader list|info|kill` discovers leaders from lock/socket files, verifies with `GetLeaderInfo`, and kills by PID (`crates/codegen/xai-grok-pager-bin/src/main.rs:216-320`). `grok workspace start|stop` requires leader mode (`main.rs:537-569`) and drives `WorkspaceStart`/`WorkspaceStop` over the control channel, gated on the `workspace_exposure` capability (`main.rs:482`). `grok update` relaunch uses `RelaunchForUpdate` (`main.rs:2464-2510`) | every control command is optional and capability-gated; a client must tolerate absent `leader_capabilities` from legacy leaders. |

The precedence that decides leader mode itself: `--no-leader`, then `--leader`, then eligibility, then config `[cli] use_leader`, then remote `leader_mode` (release builds), then default off; a requested sandbox confinement profile vetoes leader use (`crates/codegen/xai-grok-pager/src/app/mod.rs:410-448`). The CLI flags live at `crates/codegen/xai-grok-pager/src/app/cli.rs:253-258` (workspace), `cli.rs:296-303` (agent), `cli.rs:349`, `cli.rs:389-445` (leader subprocess and `--leader-socket`), `cli.rs:785-790`.

## 5 Exact TUI startup sequence against an existing leader

The TUI resolves leader mode (`app/mod.rs:410`), then runs `bounded_connect` with a 30 s budget toward `AgentKind::Leader`, falling back to an embedded agent on failure (`app/mod.rs:925-960`). The leader path is `connect_via_leader` (`acp/mod.rs:266-350`). Against an already-running leader the wire sequence is:

1. Resolve the socket path (1.1); if the socket file exists and the lock PID is alive, connect (`crates/codegen/xai-grok-shell/src/leader/mod.rs:1443-1510`).
2. IPC connect with 5 s timeout and 3 retries, then send `Register { client_type, mode: "stdio", capabilities }` as the first frame (`client.rs:333-351`).
3. Receive `Registered { client_id, ready, leader_protocol_version, leader_binary_version, leader_capabilities }` (within 10 s). With `ready: true` proceed; with `ready: false` wait for `LeaderReady`. Optionally the first ACP frame is the `x.ai/leader/version_mismatch` notification.
4. Bridge the connection with an unbounded `LeaderReconnector` (`acp/mod.rs:316-330`); on later disconnect it re-runs this connect with exponential backoff 1 s doubling to 30 s (`mod.rs:113-115`, `mod.rs:1025-1094`) and then re-runs steps 5-8.
5. Send ACP `initialize` (3.2) and receive the initialize response.
6. Send ACP `authenticate` when a non-interactive method is advertised; skip for interactive login.
7. Open the first session: a fresh start sends `session/new`, a resume sends `session/load` with cursor meta (3.4, 3.8); the first session is dispatched at `crates/codegen/xai-grok-pager/src/app/event_loop.rs:1955` (minimal mode) or deferred until auth/trust completes (`event_loop.rs:1909-1955`).
8. Normal operation: `session/update` streaming, `session/request_permission` reverse requests, `session/cancel`, per section 3.

The frames a dsh-side server must accept, in order, look like this (envelope fields shown as JSON; `Acp` payloads abbreviated to their JSON-RPC object):

```json
{"type":"register","client_type":"grok-tui","mode":"stdio","capabilities":{"yolo_mode":false,"auto_mode":false,"default_model":"grok-3","client_version":"0.1.150","code_nav_enabled":false,"terminal":false,"fs_read":true,"fs_write":true}}
{"type":"registered","client_id":1,"ready":true,"leader_protocol_version":1,"leader_binary_version":"...","leader_capabilities":{"control_v1":true,"runtime_cpu_profile":true,"profile_formats":["svg"],"workspace_exposure":true,"relaunch_v1":true}}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"1\",\"clientCapabilities\":{\"fs\":{\"readTextFile\":true,\"writeTextFile\":true},\"terminal\":false,\"meta\":{\"x.ai/incrementalBashOutput\":true,\"x.ai/hunkTracker\":{\"mode\":\"agent\"},\"x.ai/bashOutputNoColor\":true,\"x.ai/gitHeadChanged\":true}},\"_meta\":{\"clientType\":\"grok-tui\",\"clientVersion\":\"0.1.150\"}}}"}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":\"1\",\"result\":{\"protocolVersion\":\"1\",\"agentCapabilities\":{},\"authMethods\":[{\"id\":\"xai.api_key\",\"name\":\"API key\"}],\"_meta\":{\"grokShell\":true,\"modelState\":{...},\"availableCommands\":[...]}}}"}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"method\":\"authenticate\",\"params\":{\"methodId\":\"xai.api_key\"}}"}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":\"2\",\"result\":{\"_meta\":{...}}}"}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":\"3\",\"method\":\"session/new\",\"params\":{\"cwd\":\"/path\",\"mcpServers\":[],\"_meta\":{\"yoloMode\":false,\"autoMode\":false}}}"}
```

The leader rewrites each forwarded ACP request id to `"<clientId>|<original-id-json>"` and restores it on the response (`server.rs:293-324`), injects the session meta of 3.4 into `session/new`, and from the `session/new` response onward owns session subscriber/driver routing for all later `session/update` traffic (3.5, 3.8).

Minimum requirements for a foreign server to pass this handshake: answer `Register` with `Registered { ready: true, leader_protocol_version: 1, ... }` (or `ready: false` followed by `LeaderReady`), answer `Ping` with `Pong`, accept `Disconnect`, forward `Acp` JSON-RPC objects bidirectionally without reordering, and preserve the response `id` of every ACP request. `Control` frames are optional for the handshake; a server that never advertised `control_v1` is never sent one.
