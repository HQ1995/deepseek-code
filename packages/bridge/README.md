# bridge/ — external agent transports

English | [中文](README.zh.md)

The bridge group exposes harness agents to external protocol clients over their native wire transports. It is an interoperability layer, not a presentation or human-interaction layer.

| Package | Role |
|---|---|
| [grok-leader/](grok-leader/README.md) | Grok leader-protocol unix-socket server driving harness agents for grok clients. |

The wire contracts are documented in the protocol reference: [docs/grok-leader-protocol.md](../../docs/grok-leader-protocol.md).
