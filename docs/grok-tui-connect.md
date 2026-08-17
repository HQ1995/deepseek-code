# Connecting the Grok TUI to an External Leader Socket

The real `xai-grok-pager` TUI binary connects to an existing leader process over a unix socket instead of spawning an in-process agent. This page records the verified invocation, the wire handshake, and the build notes. The grok source snapshot, binary, scratch server, and message log live under `/tmp` and are not part of this repository.

## CLI invocation

`--leader` selects leader mode, `--leader-socket PATH` overrides the default `~/.grok/leader.sock`, and `--no-leader` is the opposite switch that keeps the agent in-process. `--sandbox off` prevents a confining sandbox profile from silently vetoing leader mode. Both `--leader` and `--no-leader` are hidden flags on `PagerArgs` in `xai-grok-pager/src/app/cli.rs`; the connection code is `xai-grok-shell/src/leader/client.rs`.

```sh
cd /tmp && TERM=xterm-256color numactl --cpunodebind=1 --membind=1 \
  /tmp/grok-build-src/target/release/xai-grok-pager \
  --leader --leader-socket /tmp/grok-tui-leader.sock --sandbox off --no-auto-update
```

The run was made in a tmux pane so the rendered screen could be captured. `--debug-file /tmp/grok-tui-debug.log` was added for the evidence run only.

## Wire handshake

Frames are 4-byte big-endian length followed by JSON; each message carries a top-level `type` field. The captured startup sequence was `register`, `registered`, then one ACP `initialize` request inside an `acp` envelope, then only `_x.ai/log` notifications and a keepalive `ping`/`pong` pair. Elided fields are marked `...`:

```json
{"type":"register","client_type":"grok-shell","mode":"stdio","capabilities":{...}}
{"type":"registered","client_id":1,"ready":true,"leader_protocol_version":1,"leader_binary_version":"1.0.4","leader_capabilities":{...}}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{...}}"}
{"type":"acp","payload":"{\"jsonrpc\":\"2.0\",\"id\":0,\"result\":{\"protocolVersion\":1,\"authMethods\":[],\"_meta\":{\"grokShell\":true,...}}}"}
{"type":"ping"}
{"type":"pong"}
```

Two replies keep the TUI alive: `registered` with `ready: true` (and `leader_binary_version` at least the client version, or the client evicts the leader and spawns its own), and the ACP `initialize` result. The empty `authMethods` array skips authentication, and the TUI then lands on the welcome screen without sending `session/new`.

## Result

The TUI rendered the full welcome screen (logo, login row, prompt box, `Grok Build 1.0.4 [stable]` footer) and stayed interactive. The keepalive pair was exchanged at T+30 s and `q` exited it cleanly. The leader connect completed over the socket, so no embedded-agent fallback ran.

## Build notes

- Source snapshot: `/tmp/grok-build-src`, synced from the monorepo at `SOURCE_REV 7140ec21cc4ec809131b0fa774f4b81d61667084`.
- Command: `numactl --cpunodebind=1 --membind=1 cargo build --release -j 24 -p xai-grok-pager-bin` (NUMA node 1).
- Toolchain: rustc/cargo 1.94.0 selected by the snapshot's `rust-toolchain.toml`; `protoc` resolved from the snapshot's `bin/`.
- Time: about 16 min from invocation to the linked binary at 17:31:54 EDT, dominated by crate downloads; the on-disk compile window was 17:27:09 to 17:31:54.
- Binary: `target/release/xai-grok-pager`, 201 MB, reports `grok 1.0.4 (d6a22a1) [stable]`.

## Grok source patches

None. The scratch server `/tmp/grok-probe-scratch/fake-grok-leader.mjs` (uncommitted) speaks the framing and the two replies above; the full log is `/tmp/grok-tui-messages.jsonl`.
