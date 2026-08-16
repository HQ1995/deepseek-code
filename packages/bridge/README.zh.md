# bridge/ — 外部 Agent 传输

[English](README.md) | 中文

bridge 组通过各自的原生线上传输，把 Harness Agent 暴露给外部协议客户端。它是互操作层，不是展示层或人机交互层。

| Package | Role |
|---|---|
| [grok-leader/](grok-leader/README.md) | 面向 grok 客户端驱动 Harness Agent 的 Grok leader 协议 Unix socket 服务端。 |

线上契约见协议参考：[docs/grok-leader-protocol.md](../../docs/grok-leader-protocol.md)。
