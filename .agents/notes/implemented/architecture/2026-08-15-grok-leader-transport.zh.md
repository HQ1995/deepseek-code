# Agent Note: grok leader transport over a unix socket

Status: implemented

[English](2026-08-15-grok-leader-transport.md) | 中文

## Problem

grok TUI 与无头客户端通过 Unix socket 附着到共享的 leader 进程，而不是内嵌 Agent，而 dsh 侧没有该线上协议的服务器。该契约包含带长度前缀的 JSON 信封（protocol.rs ClientMessage/ServerMessage）以及 acp 帧内的 ACP JSON-RPC 载荷；真实 TUI 对手握非常严格：registered 应答若缺少 ready，或 leader_binary_version 低于客户端版本，TUI 就会驱逐并重启自己的 leader；非空 authMethods 会强制在欢迎页之前认证（docs/grok-tui-connect.md 捕获，docs/grok-leader-protocol.md）。

## Decision

@deepseek-ai/dsh-grok-leader（packages/bridge/grok-leader）用 node:net 以 Cordis 插件实现 leader 服务器。信封层（codec.ts、protocol.ts）钉住 4 字节大端分帧、64 MiB 上限、snake_case 线上命名，以及探针验证过的 registered/pong 应答，并以捕获的 TUI 转录（tests/fixtures/grok-tui-messages.jsonl）为基准。内部 ACP 方言映射到 ACP 桥接所驱动的服务：agents.create/resume、agent.followup/whenIdle/cancel；session/event 火线投影为 session/update 种类（user_message_chunk、agent_message_chunk、agent_thought_chunk、tool_call、tool_call_update），带每会话 eventSeq/promptId 戳与 dsh-seq 高水位去重；approval/request 映射为 session/request_permission，YOLO 会话预批准；关闭时 sessions.flush；llm 目录映射为 _meta.modelState 与 x.ai/models/list；sessionPersistence.list/load 在应答前以 isReplay 重放转录；session/set_model 经 agentDefaultModel.saveSelection 保存。

本包同时充当 deepseek-leader profile 的 bundle：cordis.patch.yml 在 dsh-base 之上挂载服务器，并像 web profile 一样插入 agent-presets 名册（默认 standard），随附预设根由 apps/cli profile-boot 补上。grok TUI 的 Agent 选择经 session/new 与 session/load 的 _meta.agentProfile 到达——字符串名称或内联 JSON 定义（pager effects/helpers.rs SessionFlags::to_meta；upload/turn.rs parse_agent_profile_from_meta）。字符串（或 dsh 原生的 _meta.agentPreset）经名册解析并记录为 meta.agentPreset，预设挂载进 Agent setup；未发送任何选择时由名册默认值组装；内联 JSON 定义因 grok AgentDefinition 没有 dsh 等价物而被拒绝。加载时以持久化头上记录的预设优先用于重放。展平的 modelState 目录在 leader 侧保留 modelId 到 provider 的映射，因此 session/set_model 切换到拥有该模型的 provider，而不是回退到第一个注册的 adapter。

## Alternatives considered

**在派生桥接进程后复用 packages/acp/acp。** 拒绝：grok leader 方言是带长度前缀的二进制信封，不是换行分隔的 JSON-RPC stdio；ACP 桥接拥有单条连接及其拆除模型，而 leader 需要多客户端复用与每会话归属、每客户端释放。

**内部 JSON-RPC 层复用 @agentclientprotocol/sdk。** 拒绝：钉住的 grok schema（agent-client-protocol 0.10.4）与 SDK 方法集不同（session/set_model、x.ai/models/list 扩展方法、initialize modelState），因此 grok 形状按钉住源码与捕获手工定型，未验证面以 TODO(verify) 标注 grok 文件:行号。

**像 server.rs 那样把交互广播给所有订阅者，先答先赢。** 本变更拒绝：权限与 ask_user_question 请求只路由到会话拥有方客户端；多客户端广播、交互缓存与附着时重放均延后。

## Consequences

真实 TUI 握手对捕获线上报文完成，会话流（new、prompt、cancel、chunks、models、list、load、close、permission、预设路由、跨 provider 模型切换）经 socket 针对模拟 Agent 注册表端到端覆盖。控制面为桩实现并以 ControlResult 错误应答，leader_binary_version 钉为 1.0.4，provider 作用域模型 id 被展平进 grok 的全局目录而 provider 映射保留在 leader 侧；每处都带指向 grok 文件:行号的 TODO(verify)。与 session/load 重放竞速的实时通知被高水位丢弃而非缓冲（server.rs MAX_BUFFERED_LIVE_PER_LOAD），ask_user_question 形状与能力注入仍未验证。编解码测试逐字节重放捕获转录，任何线上漂移都会使测试失败。
