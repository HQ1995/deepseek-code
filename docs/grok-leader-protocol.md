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
| `session/prompt`, `session/update` | stream text, reasoning, tool activity, diffs, usage, and turn completion |
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
