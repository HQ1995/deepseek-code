# PR: fix(bridge) — 子代理完成事件 `subagent_finished` 在 Agent 卸载后丢失

> 分支状态：commit `4b362c7dbe`（基于 `origin/main` 上游 388d4145db）
> 范围：`bridge/grok-leader/src/index.ts`（+17/-1）、`bridge/grok-leader/tests/leader.spec.ts`（+59）

---

## 问题

后台/并行子代理完成后，TUI 里它**永远显示为"运行中"**，即使它早已结束（harness 侧是 `ready` 快照）。

根因（`bridge/grok-leader/src/index.ts` 的 `subagentEndHandler`）：

```ts
// 修复前
const child = agents?.get(info.id)              // ← 子代理完成后 Agent 已卸载 → undefined
const parentId = child?.session.header.parentSession  // → undefined
const record = ...sessions.get(parentId)         // undefined
if (record === undefined) return                 // ← 静默丢弃！不发 subagent_finished
```

dsh 的 `subagent/end` 生命周期事件在子代理 **settle/dispose 之后**才触发，此时子 Agent 已从 live 注册表移除。bridge 用 live Agent 反查父会话必然失败，于是 `subagent_finished` 通知**从不发送**。TUI 端 `SubagentInfo.finished` 永远为 false → `is_running()` 恒为 true → 已完成的子代理一直显示为运行中/挂着。

## 修复

在 `subagentStartHandler` 记录 **spawn 时 `childId → parentSessionId` 映射**，`subagentEndHandler` 优先用该映射反查父会话；live Agent 仅作为兜底（用于非本 bridge spawn 的子代理，例如父会话稍后附加的场景）。

```ts
// start
if (typeof parentId === 'string') spawnedChildParents.set(childId, parentId)
// end
const parentId = spawnedChildParents.get(childId) ?? child?.session.header.parentSession
spawnedChildParents.delete(childId)
```

## 验证

- 类型检查：`tsc -b tsconfig.json` 通过
- 回归测试：`sends subagent_finished even after the child Agent was disposed (ready snapshot)`
  - spawn 子代理 → 从注册表移除（模拟完成/卸载）→ 触发 `subagent/end` → **断言 bridge 仍发出 `subagent_finished`（status=completed）**
  - 修复前该测试超时失败（bug 复现）；修复后通过
- 完整 suite：`tests/leader.spec.ts` **160/160 通过**

## 副作用 / 兼容性

- 无 API 或协议变化；纯 bridge 事件补发。
- `spawnedChildParents` 映射在 `subagentEndHandler` 消费后即删除（防泄漏）。
- 对"父会话 attached 后才出现的子代理"（无 spawn 记录），回退到 live Agent 查询，行为与修复前一致。

## 已知遗留（不在本 PR）

- 本次会话之前工作区里残留的 `session-list` 重构（`session-list.ts` / `session-list.spec.ts` 未跟踪 + `src/index.ts` 相关段）**未包含**在本 PR，留在工作区，由你另行决定如何处理。
- 已完成的 `ready` 快照在修复前产生的、TUI 侧已丢失的 `finished` 状态，需重启 dsh（重建 bridge）或清理对应会话目录才会从"运行中"视图消失；新产生的子代理不再受影响。
