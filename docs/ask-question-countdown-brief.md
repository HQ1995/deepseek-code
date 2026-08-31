# Ask-User-Question 倒计时 / 超时感知——调研简报

> 背景：用户提出"学 Claude，在 ask_user_question 上做 60/120 秒倒计时，让用户有意识"。
> 状态：调研已完成，待用户拍板设计决策后实施。

---

## 一、现状（代码事实）

| 层 | 现状 | 位置 |
|---|---|---|
| DST bridge | 超时 `REVERSE_REQUEST_TIMEOUT_MS = 60_000`，超时 → RpcError（工具失败） | `bridge/grok-leader/src/index.ts` L1302, L1309-1312 |
| bridge → pager wire | ACP `_x.ai/ask_user_question`，payload 是 `AskUserQuestionExtRequest{session_id, tool_call_id, questions, mode}`，**无 timeout 字段** | index.ts L1596-1600 |
| grok-build 工具 | 原生有超时：默认 30 分钟；`GROK_ASK_USER_QUESTION_TIMEOUT_SECS` 可覆盖；超时 → 返回"已跳过/取消"文案（**非工具失败**）给 agent | `xai-grok-tools/.../ask_user_question/mod.rs` L61, L106-147 |
| grok-build pager | `QuestionViewState` **没有 deadline/超时字段**；question_view **没有倒计时 UI**（只在交互/切换时渲染，无 per-second tick） | `xai-grok-pager/src/views/question_view.rs` L149+ |

**关键结论**：
- 超时机制在工具层已有，但 **pager 用户侧看不到倒计时**。
- DST bridge 的超时语义**偏离** grok 原生语义（RpcError vs 返回跳过文案）。
- `AskUserQuestionExtRequest` wire 结构**不能直接带 timeout 字段**，需要扩展。

## 二、想加"Claude 式倒计时"需要动两层

1. **DST bridge（index.ts）**：payload 增加 deadline/timeout 信息；并对齐语义（超时 → 返回跳过文案，而非 RpcError）。
2. **vendor grok-build pager（third_party）**：`QuestionViewState` 加 deadline 状态 + 每秒 tick 渲染倒计时 + 超时自动作答（返回 skip 文案）。

> 这只改动 bridge（问题详情文案里静态写"X 秒未回答将跳过"）则**不需要动 pager**，但没有实时递减显示。

## 三、待用户拍板的设计决策

1. **改动范围**：
   - A. 两层都改（完整实时倒计时）
   - B. 只改 bridge（静态提示文案，无倒计时）
   - C. 先出详细设计文档 + 分步计划再实施

2. **超时后 agent 得到什么**：
   - A. 返回"已跳过/取消"文案（对齐 grok 原生）
   - B. 工具失败（保持 DST 现状）
   - C. 自动选第一个选项（谨慎，可能违背意图）

3. **超时时长**：
   - A. 60 秒（沿用现状）
   - B. 120 秒
   - C. 30 分钟（grok 默认）

## 四、附注（本次会话实际发生的演示）

- 在征求以上决策时，`ask_user_question` 又一次 60 秒超时（客户端未应答）。
- 这恰好真实演示了本功能要解决的问题：超时只给 agent 一个 RpcError，用户端无感知、无倒计时。
- 按用户先前要求，agent 不会在用户未答复时自作主张继续推进。
