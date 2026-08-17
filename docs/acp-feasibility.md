# ACP feasibility: interactive pager on the official dsh ACP server

Question: can the interactive `dscode` TUI be driven by the official dsh ACP
server (`deepseek-harness/packages/acp`) instead of the custom grok-leader
unix-socket bridge, while keeping the interactive pager (mouse, queue pane,
session picker, tool blocks)?

**Verdict: (c) lateral move.** The pager already speaks standard ACP JSON-RPC
inside a thin unix-socket envelope, and nearly all of the bridge's value is the
grok-specific `x.ai/*` surface that standard ACP has no equivalent for. Wiring
the pager to the official dsh ACP server would require re-implementing that
entire surface inside dsh plus a new socket transport — strictly more code for
the same result, and the official server is explicitly documented as an
automation (headless-semantics) transport. Evidence below.

Sources analyzed (this worktree):

- Official ACP server at the release pin from `SOURCE_REV`
  (`deepseek-harness` @ `9cf50430f3d8871f09325681ca218a1334723162`);
  the dev gitlink `47b5c455` was cross-checked and agrees on every point below
  (it only adds image-prompt support).
- Pager connection surfaces under
  `third_party/grok-build/crates/codegen/xai-grok-pager/src/`.
- Bridge wire surface `bridge/grok-leader/src/index.ts`.
- Wire docs `docs/grok-tui-connect.md`, `docs/grok-leader-protocol.md`.

## 1. What the official dsh ACP server implements today

It is a JSON-RPC **stdio** server with the smallest automation contract
(README:5, README:7, index.ts:1-10, index.ts:348-352 — stdin/stdout
`ndJsonStream`; the `stream` config override at index.ts:75-77 is tests-only).

| Method | Behavior | Evidence |
|---|---|---|
| `initialize` | Advertises baseline prompts only (`image:false, audio:false, embeddedContext:false`), `authMethods: []`, and **no** session/editor/terminal/fs/MCP capabilities and no `_meta`. | index.ts:234-245, README:24 |
| `authenticate` | No-op. | index.ts:247-249, README:25 |
| `session/new` | Fresh agent only; absolute `cwd`; non-empty `additionalDirectories`/`mcpServers` rejected; session id is always a fresh `randomUUID` — `_meta` (pinned id, presets, yolo) is ignored. | index.ts:251-275, index.ts:429-436, README:26 |
| `session/prompt` | Text + `resource_link` only; one in-flight per session; settles at whole-agent idle as `end_turn`/`cancelled`. No queue. | index.ts:277-336, README:27 |
| `session/cancel` | Cancels the addressed agent, settles pending prompt as `cancelled`. | index.ts:338-344, README:28 |
| `session/update` (emitted) | **Only** `agent_message_chunk` per committed assistant text block (image placeholder as text). Raw deltas, reasoning, tool activity, plans, titles are deliberately off-wire. | index.ts:152-196, README:29, README:80 |
| `session/request_permission` | One-shot `allow-once`/`reject-once` for approval requests with a tool call id. | index.ts:215-229, README:30 |

Not implemented at all: `session/load`, `session/list`, `session/resume`,
`session/fork`, `session/close`, `session/set_model`, anything `x.ai/*`
(README:78 "load, list, resume, delete, and fork are unsupported"; the dispatch
table has no other handlers). Lifecycle is connection-owned; per-session close
does not exist (README:81, index.ts:355-414).

## 2. Can the pager attach to an EXTERNAL ACP server over a socket?

Yes — that is exactly what leader mode does today, but only over the **grok
leader transport**, which the official dsh ACP server does not speak.

Actual external-attach path:

1. In leader mode the pager calls `acp::connect_via_leader`
   (src/acp/mod.rs:266-403; invoked from src/app/mod.rs:953).
2. It dials `connect_or_spawn_external` over a **unix socket**
   (`GROK_LEADER_SOCKET` / `~/.grok/leader.sock`) and, for dscode, spawns the
   external `dsh --profile deepseek-leader` process that serves it
   (src/acp/mod.rs:308-316, src/dsh_leader.rs:86-125). Never a self-spawned
   agent.
3. The wire is grok leader framing — 4-byte BE length + JSON envelope
   (`register`/`registered`/`acp`/`ping`) with ACP JSON-RPC objects inside
   `acp` frames (docs/grok-tui-connect.md:19-32, docs/grok-leader-protocol.md:9-29).
4. `bridge_leader_connection` → `bridge_channels` feeds those raw lines into a
   stock ACP `ClientSideConnection`, producing the same typed channels the
   in-process path uses (src/acp/leader_bridge.rs:90-111, 240-251). The pager
   is therefore a real ACP client; the in-process path is GrokShell-only
   (src/acp/spawn.rs:1-4).

The official dsh ACP server cannot be the target of this path: it has no unix
socket listener and no envelope layer, only JSON-RPC stdio (index.ts:348-352).
A socket↔stdio transport shim could be written, but the shim would still have
to answer every `x.ai/*` and load/replay method itself — which is the entire
bridge. Note headless mode in this repo is unrelated: it runs the agent
in-process and the reducer is only an output formatter
(src/headless.rs:3, src/headless.rs:848, src/headless/reducer/acp.rs:1-3).

## 3. Grok extensions: standard ACP coverage per surface

For each, `none` means the bridge (or a dsh extension of equal size) stays.

| Extension | Bridge role | Standard ACP coverage |
|---|---|---|
| `x.ai/queue/changed` + `queue/interject`/`remove`/`reorder`/`clear` | Queue pane state + mutations: broadcast at index.ts:945-963, handlers at index.ts:1683-1757; pager consumes at src/app/acp_handler/queue.rs:85 | **None.** ACP has no prompt-queue concept; `session/prompt` has no queue admission or queue notifications. |
| `x.ai/session/list` | Session picker rows (firstPrompt, cwd filter, `_meta.x.ai/session.kind=chat`): index.ts:1607-1654 | **None in practice.** `session/list` exists in the ACP schema but the dsh server does not implement it (README:78). |
| `x.ai/session/prompt_complete` | Turn-settled broadcast: index.ts:931-943; pager handles at src/app/acp_handler/mod.rs:717 | **None.** ACP carries `stopReason` only on the `session/prompt` response; there is no async completion notification and no promptId rail. |
| `x.ai/providers/add`/`update`/`remove` | Provider roster CRUD + model discovery: index.ts:1325-1474 | **None.** No ACP method for provider routes or settings. |
| `x.ai/models/list` | Model catalog + provider ownership: index.ts:1478-1489; also initialize `_meta.modelState` index.ts:726-765 | **None.** ACP has no models/list; dsh doesn't implement `session/set_model` either. |
| `x.ai/bundle/status` personas | Preset roster → persona list: index.ts:1513-1554 | **None.** |
| `x.ai/session/info` | Context-usage meter: index.ts:1584-1606 | **None.** |
| `x.ai/prompt_history` | Up-arrow history: index.ts:1491-1502 | **None.** |
| Slash-command advertising | initialize `_meta.availableCommands` + `x.ai/commands/list`: index.ts:709-720, index.ts:757-760, index.ts:1572-1574; pager parses at src/acp/mod.rs:81-84 | **None from dsh.** The grok schema has an `AvailableCommandsUpdate` client notification, but the dsh server never emits it. |

Gaps on standard-named surfaces that break the hard constraint even before the
extensions (all are bridge-only today):

- **Live update kinds.** The pager renders user echo, reasoning blocks, tool
  blocks, and plans from `session/update` kinds `user_message_chunk`,
  `agent_thought_chunk`, `tool_call`/`tool_call_update`, `Plan`
  (bridge update vocabulary index.ts:133-140; pager consumption
  src/app/acp_handler/mod.rs:280-418). The dsh server emits only committed
  `agent_message_chunk` (index.ts:159-181) — so reasoning and tool blocks
  would vanish and text would appear only after each turn commits.
- **Update `_meta` stamps.** The pager's ordering/dedup/viewer logic reads
  `_meta.eventSeq`, `promptId`, `isReplay`, `totalTokens`,
  `turnStartMs`/`streamStartMs` (bridge emitUpdate index.ts:483-513; pager gates
  src/app/acp_handler/mod.rs:165-330). The dsh server emits no `_meta`
  (index.ts:162-167).
- **Session creation.** The pager sends `_meta.sessionId`/`yoloMode`/
  `agentProfile`/`agentPreset` and parks on "Starting session…" until
  `_x.ai/mcp_initialized` (bridge index.ts:841-878, index.ts:919-928); dsh
  ignores all `_meta` and mints a random id (index.ts:254, index.ts:259-273).
- **`session/load` + replay.** Session picker attach needs load-with-replay
  stamps (bridge index.ts:1112-1210); absent in dsh (README:78).
- **`session/set_model`, `session/close`.** Bridge index.ts:1218-1270,
  index.ts:1532-1545; absent in dsh.
- **`x.ai/ask_user_question`.** Interactive question modal (bridge
  index.ts:656-679; pager src/app/acp_handler/mod.rs:822); absent in dsh.
- **`initialize` result `_meta`.** The pager reads `grokShell`, `cancelRewind`,
  `sessionRecap`, `availableCommands`, `modelState` from initialize `_meta`
  (bridge index.ts:726-765; pager fields src/acp/mod.rs:81-115). dsh's
  initialize result has none (index.ts:234-245).

The one compatible surface is permissions: the dsh `requestPermission` option
shapes (index.ts:215-229) match the bridge's (index.ts:601-615) and the pager's
handler (src/app/acp_handler/mod.rs:577). Protocol versions are not a blocker —
the pager uses `agent-client-protocol` 0.10.4 Rust, dsh uses
`@agentclientprotocol/sdk` 0.25.1, both negotiating `protocolVersion` 1.

## 4. Verdict

**(c) Lateral move.** The custom leader protocol is already ~95% standard ACP
JSON-RPC on the inside (initialize/authenticate/session new/prompt/cancel/
update/request_permission are standard names); the non-standard parts are the
unix-socket envelope and the `x.ai/*` surface, and the envelope is pinned by
capture and tests (docs/grok-tui-connect.md:19-32, docs/grok-leader-protocol.md).
The grok extensions dominate the bridge value: every one of the nine surfaces
in §3 has no standard ACP equivalent, and the dsh server's own README declares
it "a transport adapter, not a UI integration or a capability seam" with
"interactive rendering and human questions" out of scope (README:7). Pointing
the interactive pager at it would degrade the TUI to the server's
automation-only semantics (committed text after whole-agent idle, no tools, no
queue, no picker).

For completeness, option (b) — feasible only if dsh extends its ACP server —
would require dsh to add: a unix-socket + envelope transport the pager can
dial; `session/load` with replay; `session/list`; `session/set_model` and
`session/close`; user/thought/tool/plan update kinds with `_meta` stamps;
queue state + mutations + `prompt_complete`; providers/models/bundle/
session-info/prompt-history methods; slash-command advertising; and
`ask_user_question`. That is the grok-leader bridge moved inside dsh — more
code, two moving parts, zero TUI benefit.

Cheapest path that keeps the interactive TUI and shrinks the
reverse-engineered surface: **keep the pager + grok-leader bridge as-is.** The
reverse-engineered surface is already minimal and battle-tested, and new
pager-needed methods should be added as standard ACP shapes first (ext only
when ACP has no equivalent) — which is the existing policy. Do not route the
interactive pager through the official dsh ACP server; keep that server for
its intended automation clients.
