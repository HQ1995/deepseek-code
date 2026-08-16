# deepseek-build

Architecture and status of the direct-hook integration: the real grok-build TUI
driving the DeepSeek Harness agent runtime.

## Shape

- `third_party/grok-build/` — vendored [xai-org/grok-build](https://github.com/xai-org/grok-build)
  source (Apache-2.0). The TUI is `crates/codegen/xai-grok-pager` with its
  composition root `xai-grok-pager-bin`; the vendored copy renames the binary
  artifact to `dscode` (`[[bin]] name = "dscode"`).
- `packages/`, `apps/cli` — the DeepSeek Harness fork (MIT): agent runtime,
  Cordis plugin system, provider/model directory, sessions and persistence,
  tools, approvals.
- The seam: grok's **leader protocol** — 4-byte big-endian length-prefixed JSON
  frames over a unix socket (`xai-grok-shell/src/leader/{protocol,transport,server,client}.rs`).
  The TUI runs in leader-client mode; a harness-owned plugin
  (`packages/bridge/grok-leader`, in progress) listens on the socket and maps
  the protocol onto the harness's Agent/Session/llm services.

## Status

In progress, tracked in three parallel workstreams:

- `grok-probe` — builds the unmodified grok TUI from source and captures the
  exact startup message sequence against a stub socket endpoint; proves the
  TUI can attach to an external leader.
- `grok-spec` — full protocol inventory (messages, framing, lifecycle,
  handshake sequence) with file:line citations, committed as
  `docs/grok-leader-protocol.md`.
- `grok-leader` — `packages/bridge/grok-leader`, the harness-side socket server
  implementing the protocol over the harness services.

## Launch

`dscode` (the rebuilt TUI binary) will be wired to spawn/attach to the leader
server so `dscode` alone boots the full surface. The earlier TypeScript TUI
port was removed (commit `2f8e458`): the launch surface is the real grok TUI.
