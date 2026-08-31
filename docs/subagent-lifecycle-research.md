# 子代理（Subagent）生命周期管理研究

> 背景问题：本会话中有 4 个测试用 subagent 长期显示为 `ready`（可恢复快照态），用户困惑“为什么还没退出 / 看起来仍在运行”。本文调研 grok-build 是如何处理子代理生命周期的，作为对照参考。
>
> 主源：`/home/hanqing/agents/grok-build-sec/grok-build`（本地 grok-build 源码副本）。
> 核心 crate：`crates/codegen/xai-grok-tools/src/implementations/grok_build/task/`。

---

## 1. 核心结论（TL;DR）

grok-build 用**一个单写者 channel 驱动的 actor——`SubagentCoordinator`——集中管理子代理生命周期**，并明确定义了三类状态与两种回收路径：

| 状态 | 含义 | 内存中位置 |
|---|---|---|
| `pending` | 已受理、排队/等待启动 | coordinator 的 `pending: HashMap` |
| `active` | 正在运行（或阻塞等待） | coordinator 的 `active: HashMap` + `runs: FuturesUnordered` |
| `completed` | 已结束、结果可查询（用于 resume） | coordinator 的 `completed: HashMap` + FIFO `completed_order` |

关键机制（均有源码行号佐证，见 §2）：

1. **完成的子代理不会无限堆积**：`completed` 缓存有硬上限 `MAX_COMPLETED_ENTRIES = 1024`，超限即逐出最老的条目。
2. **运行中的子代理在父会话销毁时不残留**：`SubagentCoordinator` 的 `Drop` 会 `cancel_all_children()`，取消所有 `active` + `pending` 的后代。
3. **提供显式终止工具**：`kill_task` 可对指定 subagent 发送 Cancel+Shutdown。
4. **提供阻塞等待与结果检索工具**：`get_task_output` / `SubagentEvent::Query` 支持按 id 查询并等待完成。

对照本会话 harness 层：4 个测试 subagent 处于 `ready`（可恢复快照态）而非 `running`，且当前工具清单里**没有销毁 subagent 的入口**，因此快照保留是设计行为，不是 Bug。grok-build 的启示是：**完成态条目应当有界、可逐出，且运行态需有明确的显式取消与 Drop 兜底**。

---

## 2. 证据（源码与行号）

以下引用均来自 `/home/hanqing/agents/grok-build-sec/grok-build`。

### 2.1 completed 缓存上限与逐出（FIFO）

`crates/codegen/xai-grok-tools/src/implementations/grok_build/task/coordinator_state.rs`

```rust
/// Cap on retained completed-subagent entries before the oldest are evicted.
pub const MAX_COMPLETED_ENTRIES: usize = 1024;
```

`.../task/coordinator.rs` 的事件循环，每次迭代后检查并按 FIFO 逐出最老的：

```rust
while self.completed.len() > MAX_COMPLETED_ENTRIES {
    let Some(id) = self.completed_order.pop_front() else { break; };
    self.completed.remove(&id);
}
```
（coordinator.rs L201–206）

配套单元测试：`coordinator_tests.rs` → `completed_cache_evicts_oldest_entry_at_cap`（L1721 起），逐出语义被显式验证。

### 2.2 完成转移：active/pending → completed

`finish_child`（coordinator.rs L614–743）：
- 从 `active` 或 `pending` 中移除该 child（`ChildRecord`）；
- 组装 `CompletedChild`（含 `child_session_id`、`snapshot_ref`、`persisted_output_ref` 等，**供将来 resume 用**）；
- 唤醒该 id 的阻塞 waiter；
- 插入 `completed` 并把 id `push_back` 到 `completed_order`（FIFO）；
- 触发 `runner.on_completed(...)` 完成回调；
- 若超出 `MAX_PENDING_COMPLETIONS = 256` 也会丢弃最老的缓冲完成通知（L706–710）。

### 2.3 销毁兜底：Drop → cancel_all_children

`impl<R: ChildRunner> Drop for SubagentCoordinator<R>`（coordinator.rs L1121–1129）：

```rust
fn drop(&mut self) {
    self.resolve_queued_at_drop();
    self.cancel_all_children();
}
```

其中 `cancel_all_children`（L1106–1114）对每个 `active` child 同时调用 `cancellation.cancel()` 与 `control.cancel()`，对每个 `pending` child 调用 `cancellation.cancel()`。因此父会话销毁时，不会有运行中的后代泄漏。此外还有 30s 背止（`TEARDOWN_DRAIN_MAX`，coordinator.rs L92）防止删除路径卡死 spawn 准入。

### 2.4 显式终止工具：kill_task（Cancel+Shutdown）

- 工具命名/描述：`xai-tool-types` 中 `build_kill_task_description` → “Sends Cancel+Shutdown to a subagent”（`kill_task` 描述，见 `xai_tool_types` 的 `build_terminate_*_description` 系列）。
- 实现位置：`.../grok_build/kill_task/mod.rs`（`KillTaskTool`）。处理三种目标：bash task、monitor、**subagent**。
- 结果分类：`SubagentCancelOutcome`（Cancelled / AlreadyFinished / NotFound 等；见 `.../task/types.rs`）。
- 测试：`kill_task_subagent_cancelled`、`kill_task_subagent_already_finished`、`kill_task_subagent_not_found_falls_through`（kill_task/mod.rs L678/719/758）。

### 2.5 协调器是单写者 actor，沟通走 channel

`SubagentCoordinator`（coordinator.rs L45–87）持有若干 channel/集合，通过 `SubagentEvent` 驱动；`run()` 是唯一写者。状态划分：
- `pending: HashMap<String, PendingChild>`
- `active: HashMap<String, ActiveChild<R::Control>>`
- `completed: HashMap<String, CompletedChild>` + `completed_order: VecDeque<String>`

运行时并发运行集合：`runs: FuturesUnordered<...>`（协程级，非 OS 线程）。

### 2.6 事件/完成提醒机制

- `SubagentEventSender` / `SubagentCompletionsRequest`：`.../task/types.rs`。
- `TaskCompletionReminder`：`crates/codegen/xai-grok-tools/src/reminders/task_completion.rs` 顶部注释——每次工具调用时通过 coordinator 查询新完成的 subagent 并在结果中注入 `<system-reminder>`，让模型得知完成事件（无需轮询）。

---

## 3. 对本会话问题的启示

1. **完成≠删除**：grok-build 同样保留 `CompletedChild`（为了 `resume_from`），与 harness 的 `ready` 快照语义一致——保留本身不是异常。
2. **关键差异在“有界与逐出”**：grok-build 的 completed 缓存只有 1024 条且自动 FIFO 逐出；harness 侧目前看不到这样的对数上限或逐出机制，是观感差异的主要来源。
3. **运行态要可取消**：grok-build 有 `kill_task`（Cancel+Shutdown）、Drop 兜底、以及父会话/WorkflowRun 级取消（`SubagentCancelTarget::ParentSession` / `WorkflowRunId`）。当前 harness 工具集中的 `interrupt_agent` 只支持中断当前 turn，缺乏“销毁/回收 ready 快照”的显式入口。
4. **UI 呈现**：grok-build 把“still running”与“completed（可 resume）”严格分状态渲染（例如 compaction reminder 中 `## Running Subagents` 只含仍运行中的 id，完成项走 completion 提醒）。若 harness UI 把 `ready` 显示为仍运行/未退出，属于呈现层歧义，而非生命周期故障。

---

## 4. 引用来源清单

| 断言 | 来源 |
|---|---|
| `MAX_COMPLETED_ENTRIES = 1024` | coordinator_state.rs L16–17 |
| FIFO 逐出逻辑 | coordinator.rs L201–206 |
| 逐出行为单元测试 | coordinator_tests.rs L1721 `completed_cache_evicts_oldest_entry_at_cap` |
| `finish_child` 完成转移 | coordinator.rs L614–743 |
| buffered completions 上限 256 | coordinator.rs L706–710 |
| `Drop` → `cancel_all_children` | coordinator.rs L1121–1129, L1106–1114 |
| teardown 背止 30s | coordinator.rs L92 |
| `kill_task` 发送 Cancel+Shutdown | xai-tool-types 描述构建 + kill_task/mod.rs |
| 状态三分类 | coordinator.rs L60–63, L130–136 |
| 完成提醒（不轮询） | task_completion.rs L1–17 |
| 已完成子代理驱动内存、重开时从磁盘重建 | xai-grok-shell CHANGELOG（"Finished subagent transcripts are now evicted from memory … rebuilt from disk when reopened"） |
| 状态行只计"still running"，完成项落为 "Task completed" chip | xai-grok-pager docs/user-guide/20-background-tasks.md L189–205 |
| UI 生命周期块：running / completed / failed / cancelled | xai-grok-pager docs/user-guide/16-subagents.md L285–314 |
| tasks pane 同时列出 running 与 completed 并标注状态 | 16-subagents.md L276, 20-background-tasks.md L176–184 |

---

## 5. 补充：UI / 存储层的回收与呈现（官方 user-guide 证据）

DST 仓库厂商目录 `third_party/grok-build/` 自带官方 docs，从用户视角印证了生命周期设计：

1. **内存回收**：已完成子代理的 transcripts 会**从内存逐出**以减少 RAM 占用，**重新打开时才从磁盘重建**（xai-grok-shell CHANGELOG：*"Finished subagent transcripts are now evicted from memory to reduce RAM usage and rebuilt from disk when reopened."*）。
2. **状态行只会在仍有运行中后代时出现**：`◎ 1 command · 1 subagent still running`——它只数还在运行的，**一旦完成就从计数中消失**，完成项以 transcript 中的 "Task completed" chip 落定（20-background-tasks.md L189–197）。因此用户**不会**看到"已完成的子代理还挂在状态行上"。
3. **UI 生命周期块区分状态**：spawning 后 parent scrollback 出现 `Subagent running: "…"`；结束后要么更新 bullet 为完成态，要么追加 `Subagent completed/failed/cancelled in Xs: "…"`（16-subagents.md L289–300）。任务面板（Ctrl+G）同时列 running 与 completed，但**每条都带明确状态标注**（spinner / ✓ / ✗）（16-subagents.md L276–304）。
4. **可续跑但语义清晰**：`resume_from` 明确要求源 must be **completed**（not running）；`kill_command_or_subagent` 发 Cancel+Shutdown。即"保留快照供续跑"与"还活着"在术语和 UI 上都被严格区分。

> 对照本 harness：4 个测试 subagent 为 `ready`（即"已完成/可恢复"），但其呈现似乎被用户感知为"仍在运行"。grok-build 的做法是**完成项要么被逐出内存、要么在 UI 上明确标注为 completed，且运行计数严格只数存量运行中的后代**——这些值得本 harness 层对齐。

---

*生成于工具连通性测试会话；后台研究代理独立核对其余外部/呈现层信息。*

---

## 6. 补充：父会话已证实事实的标注 + 本轮新增独立发现（运行时对象退场 / UI 呈现 / ready 回收机制）

### 8.0 父会话提供的已证实事实（交叉验证通过，纳入报告）

以下 5 点由父会话直接定位源码给出，本轮独立核实一致，**可作为定论**：

1. `completed` 缓存上限 `MAX_COMPLETED_ENTRIES = 1024`，事件循环内按 `completed_order`（FIFO）逐出最老条目。`coordinator.rs:201-206`、`coordinator_state.rs:16-17`。
2. `finish_child` 将完成的子代理从未 `active`/`pending` 移除、存入 `completed` 并推入 FIFO `completed_order`。`coordinator.rs:614-743`。
3. `Drop for SubagentCoordinator` 调用 `cancel_all_children()` 取消所有 active+pending，父会话销毁时不残留运行中子代理。`coordinator.rs:1106-1114, 1121-1129`。
4. `kill_task` 工具可对指定 subagent 发 Cancel+Shutdown（`SubagentCancelTarget::SubagentId` → `cancel_one`）。`kill_task/mod.rs`、`coordinator.rs:772-807`、`task/backend.rs:388-399`。
5. 有专门逐出单元测试 `completed_cache_evicts_oldest_entry_at_cap`。`coordinator_tests.rs:1721`（验证 cache-0000 在 1025 次完成后被逐出、最新条目仍可查询）。

### 8.1 独立发现 A：运行时"进程/会话对象"在子代理完成后的内存退场路径

除了协调器把 child 移入 `completed` map，**真正的子会话运行对象**（SessionActor、workspace session、临时工具集、terminal backend 绑定）也有明确的关闭序列。完成时（`handle_request.rs:1783-1787`）：

```rust
let _ = child_handle.cmd_tx.send(SessionCommand::Shutdown(
    crate::session::ShutdownKind::Graceful,
));
ctx.workspace_ops.end_local_session(child_session_id.0.as_ref());
```

- `SessionCommand::Shutdown(Graceful)` 的处理器（`session/acp_session_impl/run_loop.rs:2111-2160`）：`shutdown_workflows` → 冲刷 replay buffer → 触发 `session_end` 钩子 → 跑 session-end memory pipeline → finish exit feedback → **return，结束该 SessionActor**（上面注释明言 "return; ... 这个 arm 返回后，未答复的 turn 不会竞态 teardown"）。即**子代理完成后其 session actor 即终止、退出内存**。
- `end_local_session`（`xai-grok-workspace/src/workspace_ops.rs:1407-1415`）= `handle.on_session_ended(session_id)` + `handle.drop_session(session_id, session_id)`——把 child session 从 workspace 句柄中释放。
- 顺带：隔离子代理的 worktree 完成后快照成 git ref 并删除临时目录（`handle_request.rs:1788-1854`，见 §6.4）。

**结论**：grok-build 里"运行对象退场"是**两层**——协调器的 `CompletedChild` 记录（有界、用于 resume）**保留在内存/磁盘**，而**真正存活的进程/会话对象（SessionActor、workspace session、worktree）在 `finish_child` 完成回调后立即关闭并 `drop`**。二者严格分离：不销毁"可恢复快照"，但销毁/退场所有"活资源"。

### 8.2 独立发现 B：UI 层如何呈现 ready/running/completed（用户感知的来源）

- **滚动条里的生命周期块**（`scrollback/blocks/subagent.rs`）：`SubagentBlockKind::{Started, Completed, Failed, Cancelled}`（L30-43）。只有 `Started` 且 `ctx.is_running` 时才显示**动画 bullet**（accent_running，L276-285）；一旦结束，bullet 变灰（finished → `None`，L282-284）。完成显示 `Subagent completed in Xs: "…"`，失败 `failed in Xs:`, 取消 `cancelled in Xs:`（L218-255）。**"运行中动画"与"完成态文本"在 UI 上物理不同**——完成的子代理不会再显示转圈。
- **`N … still running` 状态行**（`views/turn_status.rs`）：`Watchers` 结构里 `subagents` 字段注释明确为 *"Running background subagents"*（L108-111）；`format_still_running` 只列 count>0 的种类并统一追加 " still running"（L134-154）。测试 `idle_with_subagents_renders_still_running_cue` 验证 `1 subagent still running`；**一旦完成即从该计数消失**（count 为 0 不显示）。所以用户不会在状态行看到"已完成的子代理还挂着 still running"。
- **Tasks 面板（Ctrl+G）**：官方 user-guide（`docs/user-guide/16-subagents.md:275-318`）——面板"lists active and completed subagents … with their status"；每条带**明确状态标注（spinner / ✓ / ✗）**；滚动条中 blocking 子代理结束后"updates its bullet color"，background 子代理追加"completed/failed/cancelled in Xs"块。
- **fullscreen 子代理视图标题栏**：状态图标（spinner / ✓ / ✗）+ label + description + model + 可选 "resumed"/"forked" 徽标（`16-subagents.md:311-315`）。
- **Depth limit = 1**（`16-subagents.md:323`：*"Only the top-level session spawns subagents … maximum nesting depth is one"*）——一个直接的防失控/防孤儿机制：子代理不能再生子代理，agent 树保持扁平。

**对 harness 的启示**：grok-build 在 UI 上是**把"completed（可恢复）"与"running"分开呈现**——完成的子代理从"still running"计数消失、动画 bullet 熄灭、状态行/toast 明确标 completed。若 harness 的 `ready` 被用户感知为"还在跑"，属于**呈现层没有把 ready 与 running 区分开**，而非生命周期故障。

### 8.3 独立发现 C：与 harness 层"4 个 ready 快照"对应的回收机制

针对父会话提到"harness 工具集没有销毁 ready 快照的入口"，grok-build 提供的对照是可回收/可清理完成态的三类手段：

1. **有界 + FIFO 逐出（内存）**：`MAX_COMPLETED_ENTRIES=1024`，超额自动逐出最老条目（§8.0-1）。这是完成态快照的**上限回收**机制，不需要用户干预。
2. **显式取消运行态**：`kill_command_or_subagent`（`kill_task`）对 running subagent 发 Cancel；对已完成则返回 `AlreadyFinished`（不能/无需再杀）。即 **kill 面向"运行态"，不是"回收已完成快照"**——这是语义上的明确区分。
3. **父会话关闭 / teardown 排空**：`TeardownSession`（delete 路径）会取消该会话所有后代并**排空**，配 30s 背止 `TEARDOWN_DRAIN_MAX`（`coordinator.rs:831-916, 1028-1046`）；`Drop` 兜底 `cancel_all_children`。删除父 session 时其子代理一并清场。

此外**没有**一个从 `completed` map 手动删除单条快照的工具——grok-build 的选择是"**有界自动逐出 + 磁盘持久化，而非主动手动销毁**"。这正对应 harness 侧：`ready` 快照保留是设计行为；若要消除"残留感"，应像 grok-build 一样给完成态一个**上限/自动回收 + 显式终止运行态 + 严格区分 ready/running 呈现**的组合。

*

---

## 7. 补充：本轮独立核对新增的**主源**证据（源码级，覆盖磁盘持久化、worktree 回收、workflow fan-out、僵尸防护不变量）

以下均来自 `/home/hanqing/agents/grok-build-sec/grok-build` 镜像（upstream
`https://github.com/xai-org/grok-build.git`，`grok-build/.git/config` origin）。
与上文的 UI/CHANGELOG 证据互为印证，且直接落到源码行号。

### 6.1 三层状态划分与"运行计数只数活跃项"的不变量（防僵尸核心）

协调器状态（`.../task/coordinator.rs` L45–87）：
- `pending: HashMap<String, PendingChild>`
- `active: HashMap<String, ActiveChild<R::Control>>`
- `completed: HashMap<String, CompletedChild>` + FIFO `completed_order: VecDeque<String>`

运行计数定义为 **只剩 `pending.len() + active.len()`**，`completed` 一律不计入：
```rust
fn running_count_changed(&self) {
    self.runner.running_count_changed(self.pending.len() + self.active.len());
}
```
`coordinator.rs:1101-1104`。`ListRunning` 也只列出 `active` 子代理，完成的子代理**不会**以"运行中"身份返回：`coordinator/query.rs:176-208`。
这直接回答"如何避免看起来仍在运行的僵尸/残留代理"——**完成的子代理从结构上就不可能出现在任何"running 视图"里**。

### 6.2 任何结局都经 `finish_child` 收敛到终态（正常/panic/未启动/被 kill/被取消）

- `finish_child`（coordinator.rs L614–744）：把 child 从 `active` 或 `pending` 摘下 → 组装 `CompletedChild`（保留 `child_session_id`/`snapshot_ref`/`persisted_output_ref` 供 resume）→ 唤醒 waiter → 插入 `completed` + FIFO → 触发 `runner.on_completed`。
- **panic 兜底**：`finish_panicked_child`（L746–770）把"子代理 runner panic"合成为失败结果并走同一条 `finish_child`，因此崩溃的子代理也不会遗留在运行集合里。
- **未启动即被拒 / cancelling**：`finish_never_started`（`coordinator/spawn.rs:180–208`）、`cancel_one`（coordinator.rs L772–807，已完成的返回 `AlreadyFinished`）都收敛到终态。
- **Drop 兜底**：`Drop for SubagentCoordinator` → `cancel_all_children()` 取消所有 active+pending 后代（coordinator.rs L1121–1129, L1106–1114）。`teardown_session_children`（L831–865）在父会话销毁时逐出所有后代，并有 30s 背止 `TEARDOWN_DRAIN_MAX`（L89–92, 1028–1046）保证不会卡死 spawn 准入。

### 6.3 完成态记录：内存有界 + **磁盘持久化**（"ready 快照"可跨逐出/重启存在）

- 内存：`MAX_COMPLETED_ENTRIES = 1024`（`coordinator_state.rs:16-17`），FIFO 逐出（coordinator.rs L201–206），测试 `completed_cache_evicts_oldest_entry_at_cap`（coordinator_tests.rs L1721）。
- 磁盘：完成时写入每 child 的 `subagent.json` / `meta.json`（`persist_subagent_completion`、`persist_subagent_output`，`handle_request.rs:1627-1628`；`subagent/mod.rs` 的 `SubagentSessionMetadata`/`GcsSessionMetadata` 等结构）。
- 续跑可跨逐出：`run_shell_child` 的 `resume_from` 先查协调器，若 `SubagentResumeLookup::Missing` 则回退磁盘 `durable_resume_source_for(...)`（`handle_request.rs:154-200`）；协调器的 `InternalEvent::ResumeSource` 只认 `completed` 里的源（`coordinator.rs:506-542`）。因此"completed 但可恢复"是**以磁盘为根的持久快照**，不是残留的运行。

### 6.4 worktree 回收（隔离子代理专用的资源清理）

对 `isolation=worktree` 的子代理，完成后：
- 先把 worktree 快照成 git ref `refs/grok/subagents/<id>`，
- 再把 ref 持久化进 meta.json，
- **随后 `remove_subagent_worktree` 删除临时目录**；任一步失败则保留 worktree 以便 resume。

`handle_request.rs:1788-1854`；测试 `tests/rest.rs:617-700`（`completion_snapshot_sequence_persists_ref_then_removes_worktree`）。这是"运行结束即回收自有资源、避免每个 worker 泄漏临时 worktree"的具体实现。

### 6.5 编排：`task` 工具 fan-out 与 `xai-workflow` 引擎

- `task` 工具（模型可见 fan-out）：`run_in_background` 只是"立即返回 id"，完成后仍会通过缓冲的 between-turn reminder 上浮（`task/types.rs:83-90` 注释：*"background does not mean fire-and-forget"*）；workflow 拥有的 spawn 绕过准入、永不排队。`task/mod.rs:220`（`background_task_action` + `kill_task` 搭配要求）。
- `xai-workflow`（Rhai 脚本编排引擎）：通过 `WorkflowHostRequest::SpawnAgent` 逐调用 spawn→收取 `AgentResult`→返回，另用 `ReserveAgentCalls`/`ReleaseAgentCalls` 做配额；`host.rs`（`AgentOpts`/`AgentResult`）、`engine.rs`（`MAX_PARALLEL`、`MAX_HOST_CALLS`）。**每个 worker 的生命周期就是一次 spawn→await→返回**，不长期持有 worker 对象。
- 组取消与排空：`SubagentCancelTarget::WorkflowRunId` → `cancel_workflow_children` + `resolve_workflow_cancel_waiters`（coordinator.rs L949–978）：只有当该 run 的 pending+active 全空才 resolve 取消 waiter，即"等 fan-out 彻底排空"而非留下孤立并行 worker。

### 6.6 与 Claude Code 约定的对应

- 任务/杀掉类工具的别名显式映射到 Claude Code 命名：`TaskStop/KillShell/KillBash/... → kill_command_or_subagent / kill_terminal_command`（`xai-grok-tools/src/types/claude_alias.rs:67-69`）。
- 通用 `computer` backend（`computer/local/terminal.rs`、`computer/types.rs`：`kill_task`/`wait_for_completion`/`get_task`）在语义上复刻 Claude Code 的"spawn → 后台 id → 按 id 轮询/杀掉 → completed-但可 resume"契约。
- 区分：grok-build 是**自研 Rust 协调器**，只是复用 Claude Code 的公开工具名/语义约定，并未 vendor Claude Code。

### 6.7 对本 harness "ready 残留"问题的最终启示（源码级）

1. **completed ≠ running**：grok-build 把"已完成/可恢复快照"与"运行中"从状态机和 UI 上硬性分开；`running` 计数、`ListRunning`、状态行（`◎ N subagents still running`）都**只数真正存活的后代**。若 harness 的 `ready` 被用户感知为"还在跑"，属于呈现层歧义，而非生命周期故障。
2. **完成态必须有界与可回收**：内存 1024 FIFO 逐出 + 磁盘持久化 + worktree 快照后删除。harness 侧若保留 `ready` 快照，应补一个"上限/逐出"和"显式丢弃/回收"入口（grok-build 用 `kill_command_or_subagent` 取消运行态；当前 harness 工具集只有 `interrupt_agent` 中断当前 turn，无"回收 ready 快照"入口）。
3. **所有结局都收敛到显式终态**：正常/panic/未启动/被 kill/被取消皆经 `finish_child` 落为 terminal 记录——这是"无僵尸"的根因，值得在 harness 层对齐。

---

## 8. 本轮新增的引用来源清单（源码级）

| 断言 | 来源（相对 grok-build 镜像根） |
|---|---|
| 运行计数 = pending+active（不含 completed） | `xai-grok-tools/.../grok_build/task/coordinator.rs:1101-1104` |
| `ListRunning` 只列 active | `.../task/coordinator/query.rs:176-208` |
| 三层状态字段 | coordinator.rs L45–87 |
| panic/未启动/被杀均收敛终态 | coordinator.rs L614–770, L772–807；`coordinator/spawn.rs:180-208` |
| Drop→cancel_all_children | coordinator.rs L1121–1129, L1106–1114 |
| teardown 30s 背止 | coordinator.rs L89–92, L831–916, L1028–1046 |
| 完成态从磁盘重建用于 resume | `xai-grok-shell/src/agent/subagent/handle_request.rs:154-200`；coordinator.rs L506–542 |
| worktree 快照+删除回收 | handle_request.rs L1788–1854；`tests/rest.rs:617-700` |
| `task` 工具 fan-out / background 语义 | `.../task/types.rs:83-90`；task/mod.rs:220 |
| xai-workflow SpawnAgent/quota | `xai-workflow/src/host.rs`、`engine.rs` |
| workflow 组取消排空 | coordinator.rs L949–978 |
| Claude Code 工具名别名 | `xai-grok-tools/src/types/claude_alias.rs:67-69` |
| upstream URL | `grok-build/.git/config` → `git@github.com/xai-org/grok-build.git` |

运行时对象退场 / UI 呈现 / ready 回收（本轮新增）：

| 断言 | 来源（相对 grok-build 镜像根） |
|---|---|
| 完成后 `Shutdown(Graceful)` + `end_local_session` | `xai-grok-shell/src/agent/subagent/handle_request.rs:1783-1787` |
| `Shutdown` 处理器终止 SessionActor（run_loop return） | `xai-grok-shell/src/session/acp_session_impl/run_loop.rs:2111-2160` |
| `end_local_session` = on_session_ended + drop_session | `xai-grok-workspace/src/workspace_ops.rs:1407-1415` |
| UI 生命周期块四种状态、运行动画 vs 完成文本 | `xai-grok-pager/src/scrollback/blocks/subagent.rs:30-43, 158-160, 189-323` |
| `Watchers.subagents` = "Running background subagents"（只数运行） | `xai-grok-pager/src/views/turn_status.rs:100-113, 134-154, 157-169` |
| "still running" 状态行只列 count>0 种类 | turn_status.rs L134–154；测试 `idle_with_subagents_renders_still_running_cue` L1386 |
| Tasks 面板列出 running+completed 且各带状态标注 | `xai-grok-pager/docs/user-guide/16-subagents.md:275-318` |
| finished→灰 bullet / completed in Xs 文本 | `scrollback/blocks/subagent.rs:276-292, 218-255` |
| Depth limit =1（子代理不能再生） | `docs/user-guide/16-subagents.md:323` |
| kill 面向运行态，完成则 AlreadyFinished | `kill_task/mod.rs`（SubagentCancelOutcome）；coordinator.rs L772–807 |
| 删除父会话 teardown 排空 + 30s 背止 | coordinator.rs L831–916, L1028–1046 |
| 有界自动逐出而非手动单条销毁 | coordinator_state.rs L16-17；coordinator.rs L201-206 |*
