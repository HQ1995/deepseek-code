# 改进方案：subagent `ready` 快照的回收与呈现

> 面向 deepseek-harness（dsh）———— 我们这套 DST/DeepSeek Code 的运行时（upstream）。
> 背景：当前会话 5 个测试/研究子代理全部显示为 `ready` 且无法回收、无法从 UI 区分"已完成/可恢复"，令用户困惑。
> 本文档对照 grok-build 的成熟做法（见 `subagent-lifecycle-research.md`），给出本仓可落地的改进项。

---

## 0. 关键澄清：`ready` 快照是 dsh 官方的**预期语义**，不是 bug

调查 dsh 官方 agent preset（`apps/cli/config/agent-presets/{standard,code,cordis}/agent.cordis.yml`）确认：

```yaml
tool-subagent:
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable        # dsh 官方默认：continuable
tool-subagent-fork:
  config:
    provider: fork
    toolName: subagent_fork
    backgroundMode: continuable
```

- **dsh 官方主动选择**让后台/并行子代理成为"可续跑持久快照"（continuable），以便父代理 `send_message` 续聊、做多阶段/并行任务。
- `tool-subagent/index.ts`：`foreground ` 调用完成即 `dispose`；`backgroundMode: one-shot` 用普通 Task（无残留）；**`continuable` 用 `startContinuable()` 返回耐用 child id，完成后成为 `ready` 快照**（正是我们遇到的情形）。
- **所以"保留几个 ready 快照"与 dsh 官方配置一致——我们没有接错配置。**
- **真正的 gap 是"呈现/回收"那一半没接好**：dsh 官方配套（grok TUI）会把 completed/ready 明确标注、不显示为运行、运行计数只数活的（见 `subagent-lifecycle-research.md`）；我们的 bridge 呈现还没对齐。

---

## 1. 机制事实（已从源码确认）

### 1.1 `ready` 的准确定义

`packages/subagent/tool-subagent-control/src/list-agents.ts` L59-63：

```ts
function statusOf(agents, id) {
  const agent = agents.get(id)
  if (agent === undefined) return 'ready'            // 无 live Agent 对象 → ready
  return agent.status === 'running' ? 'running' : 'idle'
}
```

- **`ready` = 子代理的 Agent 对象已被卸载（不占用内存/CPU），只作为持久化会话数据存在。**
- `list_agents` 只列 **continuable（可续跑）** 子代理（L77：`mode !== 'continuable'` 直接排除）。
- `list_agents` 是**纯只读**工具：不枚举、无删除/清理入口。

### 1.2 为什么 `ready` 一直挂着不消失

- `SubagentRuntime`（`packages/subagent/subagent/src/index.ts`）是 provider registry + 生命周期发布；
- Continuation manager（`continuation.ts`）：`ActivationState = 'running' | 'waiting' | 'settled'`（L155-159）。
  - **`settled`** = 所有子代理已释放、handle 被 dispose、Activation 被移除（L156-157, 1086-1088）。
  - **已 settled 的子代理仍以持久化会话存在**，于是被重新列为 `ready`。
- 全仓 **没有任何 TTL / 逐出 / 垃圾回收 / prune 逻辑**（grep `ttl|expire|prune|reap|garbage` 无产物）。
- 因此：**只要父会话不销毁、且持久化记录不被删除，`ready` 快照永久保留。**

### 1.3 存储位置

- 每子代理是一份持久化会话数据（`subagent` 投影 + `sessionPersistence`/缓存；`list-children.ts` L3-23, 209-239）。
- 在运行时 profile：`~/.dsh/profiles/dscode/sessions/<escaped>/` 下有历史会话目录。
- `worktrees.db` 为 SQLite（worktree 隔离子代理用，非本主题核心）。

---

## 2. 缺口对照（grok-build 有，本仓没有）

| 能力 | grok-build | deepseek-harness |
|---|---|---|
| 完成态**自动有界逐出** | ✅ completed 缓存 1024 FIFO | ❌ 无任何 TTL/逐出 |
| **显式终止/回收运行态** | ✅ kill_task（Cancel+Shutdown） | ⚠️ 有 `interrupt_agent`（只中断当前 turn，不销毁） |
| **删除/回收 ready 快照的工具** | ⚠️ 设计上就不提供单条删除（靠有界逐出） | ❌ 更没有 |
| 状态机**严格区分 running/completed** | ✅ 结构性分离，运行计数只数 active | ⚠️ 有 running/idle/ready 三态，但 UI 呈现歧义 |
| UI **把 completed 标清楚**、不显示为仍运行 | ✅ scrollback 转灰 + completed chip，状态行只数 still running | ❌ TUI 呈现易被感知为"挂着/在跑" |
| **所有结局收敛到显式终态** | ✅ finish_child 收敛 panic/未启动/被杀/取消 | ⚠️ 有 settle 语义，但 ready 与"终态"边界不清 |

---

## 3. 改进方案（分优先级，全部有明确落点）

### P0：给 `ready` 快照分级 + 最小回收入口（缓解燃眉之急）

现状：模型（及用户）没有任何办法清理已完成的子代理。
建议：
1. **提供模型侧回收工具** `dispose_subagent`（或 `prune_subagents`）：
   - 只允许回收 `ready`（无 live Agent）的 continuable 子代理；
   - 在 `list-children.ts` 枚举的基础上，按 id 删除持久化会话（配合 `sessionPersistence.delete`）；
   - 对 `running`/`idle` 返回明确错误（要求先 `interrupt_agent`）。
   - 落点：`packages/subagent/tool-subagent-control/src/` 新增工具 + `packages/subagent/subagent/src/index.ts` 暴露 `disposeChild`。
2. **让 `list_agents` 可选展示"可回收"提示**：给 `ready` 条目渲染 `(disposable)` 之类语义，减少"它是活的吗"歧义。

### P1：自动 TTL / 逐出（对齐 grok-build 的"有界回收"）

- 给 continuation manager 加入**完成态保留期**（如默认 N 天后自动标记可清理，超期由后台任务删除持久化记录）；
- 或**按上限逐出**：超过 `MAX_READY_SUBAGENTS`（如 64）时按 FIFO/最久未用逐出最老的 `ready` 快照。
- 落点：`packages/subagent/subagent/src/continuation.ts` 增加 `settled` 记录的时间戳与逐出扫描；持久化删除复用 P0 的 `disposeChild`。

### P2：UI/呈现层区分 completed≠running（根治"看起来在跑"）

- 将 `list_agents` 的状态词汇在 TUI 侧投影为**明确的"已完成（可恢复）"**，而不是与运行中并列；
- 顶部运行状态/状态行**只在真正有 running/idle 时出现**，`ready` 不进计数（grok-build `◎ N subagents still running` 只数运行中的思路）；
- tasks 面板：`ready` 条目显示 ✓ + "completed, 可 resume"，不得显示 spinner/animation。

### P3：生命周期收敛到显式终态（对齐 grok-build finish_child）

- 明确"settled 即终态"，并给每个 child 一个**稳定终态标志**（completed / interrupted / failed / disposed），持久化到 meta；
- `list_agents` 基于该标志渲染，而不是仅凭"有无 live Agent"推断 ready。

---

## 4. 落点文件索引

| 改动 | 文件 |
|---|---|
| `ready` 状态判定 | `packages/subagent/tool-subagent-control/src/list-agents.ts` |
| registry/start/dispose | `packages/subagent/subagent/src/index.ts`（`SubagentRuntime`） |
| 持久化枚举 | `packages/subagent/subagent/src/list-children.ts` |
| 续跑/定居/回收 | `packages/subagent/subagent/src/continuation.ts` |
| 生命周期发布 | `packages/subagent/subagent/src/lifecycle.ts` |
| 会话持久化接口 | `packages/session-persistence`（`SessionPersistence.delete/list`） |
| TUI 桥接（底层就不显示为运行） | DST `bridge/grok-leader/src/index.ts`（subagent_spawned/finished） |

---

## 5. 建议的实施顺序

1. **P0 先做**：`dispose_subagent`（或先手动删 profile 里对应 sessions 目录应急）→ 立即可解决"5 个 ready 挂着"；
2. **P1 跟进**：TTL/上限逐出，让未来不再累积；
3. **P2/P3 深化**：呈现与终态语义，根治"用户觉得还在跑"的困惑。

> ⚠️ 注意：`packages/...` 属于 **upstream deepseek-harness** 仓库（DST 是其下游/启动器）。改动上游代码前需确认改动归属（是 upstream PR 还是 DST 侧 overlay），以及 dsh profile 的更新渠道。
