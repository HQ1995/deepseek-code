import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import { errorChain, type TokenUsage } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { commandResults, type CommandFold } from './command-results.ts'
import { hasToolImages } from './image-output.ts'
import { compactionNotices, emptyTriggers, isXaiNotice, planModeNotice, toolCallWriting, triggerNotes, turnNotices, type CompactionFold, type ContextTokens, type ModeUpdate, type WritingCalls, type XaiNotice } from './turn-notices.ts'
import { assistantChunkToUpdates, assistantEventUsage, cacheHitPercent, decodeTokensPerSecond, emptyDecodeSpeed, noteDecodeSpeed, parseJsonObject, sessionEventToUpdates, systemNotes, contextInfoFromProjection, type ContextProjectionValues, type DecodeSpeed, type ProjectedUpdate, type ToolPresenter } from './projection.ts'

export interface SessionOutputHost {
  sessionId: string
  cwd(): string | undefined
  isLive(): boolean
  promptId(): string | undefined
  notify(method: string, params: unknown): void
  drain?(): Promise<void> | undefined
  contextValues(): ContextProjectionValues
  /** The session log position `contextValues` is folded to. They fold committed
   * events only, so the streamed deltas between two events share one reading;
   * `contextChanged` also drops it. Without a position every update reads afresh. */
  contextRevision?(): number
  projectImages(event: SessionEvent, updates: ProjectedUpdate[]): Promise<ProjectedUpdate[]>
  /** The attached agent's tool presenters: live and restored cards carry the same views. */
  presenter?: ToolPresenter
  /** Event types a plugin projects onto existing messages (`sessions.registerMessageProjection`). */
  messageProjection?(type: string): boolean
  logger: { warn(message: string): void }
}
interface OutputState {
  /** Highest forwarded dsh event seq; replay/live overlap dedup drops at or below it. */
  lastSeq: number
  /** Millisecond epoch when the current turn started, stamped into update _meta. */
  turnStartMs: number | undefined
  /** Monotonic per-session counter stamped into every update _meta.eventSeq. */
  eventSeq: number
  /** Native settlement usage totals, with same-step replacement and retry fences. */
  inputTokens: number
  outputTokens: number
  /** Disjoint prompt-side cache token buckets from dsh TokenUsage. */
  cacheReadTokens: number
  cacheWriteTokens: number
  /** Decode-speed fold mirrored from the upstream sessionStats projection. */
  decodeSpeed: DecodeSpeed
  /** Counters the grok x.ai/session/info context reads. */
  turnCount: number
  toolCallCount: number
  messageCount: number
  compactionCount: number
  /** Pending tool-call facts keyed by callId, used to attach rawInput/rawOutput. */
  pendingToolCalls: Map<string, { name: string; arguments: unknown }>
}
/** xAI-only updates: system notes (the pager renders `image_dropped` notes as
 * one plain system block, so every neutral notice rides it), retry/failure
 * states, tool calls being written, automatic compaction and command results.
 * No meters. */
type NoticeUpdate = (XaiNotice | ModeUpdate) & { totalTokens?: never; cacheHitPercent?: never; tokensPerSecond?: never }
type OutputUpdate = ProjectedUpdate | NoticeUpdate

/** Per-attached-agent output ownership: revision/replay dedup, meter folding,
 * wire sequence stamps and asynchronous image hydration share one lifetime. */
export function createSessionOutput(host: SessionOutputHost) {
  const { logger } = host
  let closed = false
  let outputTail: Promise<void> | undefined
  const outputQueue: Array<(() => void | Promise<void>) | undefined> = []
  let outputHead = 0
  let streamState: { attemptId: string; revision: number; turn: number; step: number; delivered: Set<number>; closed: boolean; pending: SessionEvent[]; writing: WritingCalls } | undefined
  let lastUsage: { turn: number; step: number; usage: TokenUsage } | undefined
  /** Last provider-reported prompt size, the occupancy replay can recover. */
  let promptTokens: number | undefined
  /** The TUI empties its todo pane at an automatic compaction; DSH keeps the
   * turn's todos, so the last plan is sent again after the completion. */
  let lastPlan: ProjectedUpdate | undefined
  const compactions: CompactionFold = new Map()
  const commands: CommandFold = new Map()
  const triggers = emptyTriggers()
  const state: OutputState = {
    lastSeq: -1,
    turnStartMs: undefined,
    eventSeq: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    decodeSpeed: emptyDecodeSpeed(),
    turnCount: 0,
    toolCallCount: 0,
    messageCount: 0,
    compactionCount: 0,
    pendingToolCalls: new Map(),
  }
  const stats = () => ({ compactionCount: state.compactionCount, turnCount: state.turnCount,
    toolCallCount: state.toolCallCount, messageCount: state.messageCount })
  /** The last `contextInfo`, valid while the log position and the counters it
   * carries are unchanged and no context change was announced. A read goes
   * through a traced native service call; once per streamed delta, it cost
   * about 40% of the leader's CPU. */
  let contextMemo: { revision: number; turnCount: number; toolCallCount: number; messageCount: number; compactionCount: number
    value: Record<string, unknown> } | undefined
  const context = (): Record<string, unknown> => {
    const revision = host.contextRevision?.(), memo = contextMemo
    if (memo !== undefined && memo.revision === revision && memo.turnCount === state.turnCount && memo.toolCallCount === state.toolCallCount
      && memo.messageCount === state.messageCount && memo.compactionCount === state.compactionCount) return memo.value
    const value = { ...contextInfoFromProjection(host.contextValues()), ...stats() }
    contextMemo = revision === undefined ? undefined : { revision, turnCount: state.turnCount, toolCallCount: state.toolCallCount,
      messageCount: state.messageCount, compactionCount: state.compactionCount, value }
    return value
  }

  /**
   * Admit a dsh event once, before projecting its items. Replay/live overlap
   * dedup happens at event granularity: several wire updates can come from one
   * event (a user/message with many text blocks), and gating inside update
   * would drop every item after the first. Returns false when this seq was
   * already forwarded (replay of a still-live session).
   */
  const admitEvent = (seq: number): boolean => {
    if (seq <= state.lastSeq) return false
    state.lastSeq = seq
    return true
  }

  // One drain owns the FIFO, rather than a Promise chain per text update.
  // Start in a microtask so restore can reserve the complete replay prefix
  // before live output or reentrant notifications can overtake that history.
  const enqueue = (emit: () => void | Promise<void>): void => {
    outputQueue.push(emit)
    if (outputTail !== undefined) return
    outputTail = Promise.resolve().then(async () => {
      try {
        while (outputHead < outputQueue.length) {
          const next = outputQueue[outputHead]!
          outputQueue[outputHead++] = undefined
          try {
            const pending = next()
            if (pending !== undefined) await pending
          } catch (error) { logger.warn('TUI output projection: ' + errorChain(error)) }
          // Reentrant/live producers may keep a slow-reader drain nonempty.
          // Release consumed slots with amortized linear compaction.
          if (outputHead >= 1024 && outputHead >= outputQueue.length / 2) {
            outputQueue.splice(0, outputHead)
            outputHead = 0
          }
        }
      } finally {
        outputQueue.length = outputHead = 0
        outputTail = undefined
      }
    })
  }

  /**
   * Forward one update with the leader _meta stamp. The eventSeq monotonic
   * counter plus the per-session dsh-seq high-water make replay/live overlap
   * deduplicable on the client side (server.rs eventId dedup).
   * Event-to-wire admission is `admitEvent` — this only serializes.
   */
  const update = (
    item: OutputUpdate | Promise<OutputUpdate>,
    isReplay = false,
    agentTimestampMs?: number,
  ): void => {
    if (closed || !host.isLive()) return
    const promptId = host.promptId()
    const turnStartMs = state.turnStartMs
    const send = (item: OutputUpdate): Promise<void> | undefined => {
      const eventSeq = state.eventSeq++
      const { totalTokens, cacheHitPercent, tokensPerSecond, ...update } = item
      host.notify(isXaiNotice(item) ? 'x.ai/session_notification' : 'session/update', {
        sessionId: host.sessionId,
        update,
        _meta: {
          eventSeq,
          ...promptId === undefined ? {} : { promptId },
          ...isReplay ? { isReplay: true } : {},
          contextInfo: context(),
          ...totalTokens === undefined ? {} : { cumulativeTokens: totalTokens },
          ...cacheHitPercent === undefined ? {} : { cacheHitPercent },
          ...tokensPerSecond === undefined ? {} : { tokensPerSecond },
          ...agentTimestampMs === undefined ? {} : { agentTimestampMs },
          ...turnStartMs === undefined ? {} : { streamStartMs: turnStartMs, turnStartMs },
        },
      })
      return isReplay ? host.drain?.() : undefined
    }
    if (item instanceof Promise) {
      // Hydrate a tool result once, before its completion and subsequent text.
      // The pager discards further updates after completing that tool call.
      // Observe rejection at admission, not after an earlier preview finishes.
      // Retain FIFO even when a later projection fails first.
      const projected = item.then(
        value => ({ status: 'fulfilled' as const, value }),
        reason => ({ status: 'rejected' as const, reason }),
      )
      enqueue(() => projected.then(result => {
        if (result.status === 'rejected') throw result.reason
        if (!closed && host.isLive()) return send(result.value)
      }))
    } else if (outputTail !== undefined || isReplay) {
      enqueue(() => { if (!closed && host.isLive()) return send(item) })
    } else send(item)
  }

  /** Accumulate the token and counter facts one session event contributes. */
  const noteEvent = (event: SessionEvent): void => {
    noteDecodeSpeed(state.decodeSpeed, event)
    if (event.type === 'llm/retry-started') {
      const previous = lastUsage
      if (previous !== undefined && previous.turn === event.data.turn && previous.step === event.data.step) lastUsage = undefined
    }
    if (event.type === 'assistant/message' || event.type === 'assistant/attempt') {
      const usage = assistantEventUsage(event)
      if (usage !== undefined) {
        const last = lastUsage
        const previous = last?.turn === event.data.turn && last.step === event.data.step ? last.usage : undefined
        state.inputTokens += usage.inputTokens - (previous?.inputTokens ?? 0)
        state.outputTokens += usage.outputTokens - (previous?.outputTokens ?? 0)
        state.cacheReadTokens += (usage.cacheReadTokens ?? 0) - (previous?.cacheReadTokens ?? 0)
        state.cacheWriteTokens += (usage.cacheWriteTokens ?? 0) - (previous?.cacheWriteTokens ?? 0)
        lastUsage = { turn: event.data.turn, step: event.data.step, usage }
        promptTokens = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
      }
      if (event.type === 'assistant/message') state.messageCount += 1
    } else if (event.type === 'tool/call') {
      state.toolCallCount += 1
      state.pendingToolCalls.set(String(event.data.callId), {
        name: event.data.name,
        arguments: parseJsonObject(event.data.arguments),
      })
    } else if (event.type === 'tool/ptc-dispatch-start') {
      // Nested PTC calls resolve their raw shapes and fallback diffs from the
      // same map; the dispatch arguments are already JSON-normalized.
      state.pendingToolCalls.set(String(event.data.subCallId), {
        name: event.data.name,
        arguments: event.data.arguments,
      })
    } else if (event.type === 'user/message' && (event.data.source as { kind?: unknown }).kind === 'user') {
      state.messageCount += 1
    } else if (String(event.type) === 'compaction/end') {
      state.compactionCount += 1
    } else if (event.type === 'turn/end') {
      state.turnCount += 1
    }
  }

  /** Map one event to wire updates, attaching the cumulative token total to agent text. */
  const mapEvent = (
    event: SessionEvent,
    replay: boolean,
    streamedChunks?: ReadonlySet<number>,
  ): Array<ProjectedUpdate> => {
    noteEvent(event)
    const totalTokens = state.inputTokens + state.cacheReadTokens + state.cacheWriteTokens + state.outputTokens
    const hitPercent = cacheHitPercent(state.inputTokens, state.cacheReadTokens, state.cacheWriteTokens)
    const speed = decodeTokensPerSecond(state.decodeSpeed)
    const meters = {
      totalTokens,
      ...hitPercent === undefined ? {} : { cacheHitPercent: hitPercent },
      ...speed === undefined ? {} : { tokensPerSecond: speed },
    }
    const updates: Array<ProjectedUpdate> = []
    for (const item of sessionEventToUpdates(event, {
      replay,
      streamedChunks,
      cwd: host.cwd(),
      toolCall: (callId) => state.pendingToolCalls.get(callId),
      presenter: host.presenter,
    })) {
      if (item.sessionUpdate === 'agent_message_chunk') {
        updates.push({ ...item, ...meters })
      } else {
        updates.push(item)
      }
    }
    // Streamed responses suppress their assembled assistant message. Emit one
    // empty content chunk so the terminal usage still reaches the TUI without
    // creating another scrollback block.
    if (assistantEventUsage(event) !== undefined
      && !updates.some(item => item.sessionUpdate === 'agent_message_chunk')) {
      updates.push({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        ...meters,
      })
    }
    const plan = updates.findLast(item => item.sessionUpdate === 'plan')
    if (plan !== undefined) lastPlan = plan
    if (event.type === 'tool/result') {
      state.pendingToolCalls.delete(String(event.data.message.toolCallId))
    }
    if (event.type === 'tool/ptc-dispatch') {
      state.pendingToolCalls.delete(String(event.data.subCallId))
    }
    return updates
  }

  // Native append dispatches session/event synchronously before end supplies
  // its exact seq. Delay only assistant settlements across that tiny boundary:
  // a same-step unrelated message must never borrow this attempt's live text.
  const drainAssistantEvents = (committed?: { seq: number; eventType: string }): void => {
    const stream = streamState
    if (stream === undefined) return
    for (const event of stream.pending) {
      const delivered = committed?.seq === event.seq && committed.eventType === event.type ? stream.delivered : undefined
      const updates = mapEvent(event, false, delivered)
      for (const item of updates) update(item, false, event.time)
    }
    stream.pending.length = 0
  }
  const assistant = (frame: AssistantStreamFrame): void => {
    if (closed || !host.isLive()) return
    const previous = streamState
    if (frame.type === 'start') {
      if (previous !== undefined && frame.revision <= previous.revision) return
      if (previous?.attemptId === frame.attemptId) return
      drainAssistantEvents()
      streamState = {
        attemptId: frame.attemptId, revision: frame.revision, turn: frame.turn, step: frame.step,
        delivered: new Set(), closed: false, pending: [], writing: new Map(),
      }
      return
    }
    if (previous === undefined || previous.closed || frame.revision <= previous.revision
      || previous.attemptId !== frame.attemptId) return
    previous.revision = frame.revision
    if (frame.type === 'end') {
      previous.closed = true
      drainAssistantEvents(frame.outcome.kind === 'committed' ? frame.outcome : undefined)
      previous.delivered.clear()
      previous.writing.clear()
      return
    }
    if (previous.delivered.has(frame.index)) return
    for (const item of assistantChunkToUpdates(frame.chunk)) update(item, false, frame.time)
    const writing = toolCallWriting(previous.writing, frame.chunk, frame.time)
    if (writing !== undefined) update(writing, false, frame.time)
    previous.delivered.add(frame.index)
  }

  /** Occupancy for compaction notices: the native projection live, else the last reported prompt. */
  const occupancy = (replay: boolean) => (): ContextTokens => {
    const pressure = replay ? undefined : host.contextValues().contextPressure
    const native = pressure?.projectedTokens, used = native ?? promptTokens
    return { ...used === undefined ? {} : { used }, ...native === undefined ? {} : { native: true },
      ...pressure?.contextWindow === undefined ? {} : { window: pressure.contextWindow } }
  }
  /** What one event adds beside its projected updates: system notes, xAI
   * turn notices, mode updates and command results. Folds see every event,
   * sent or not. */
  const notices = (event: SessionEvent, replay: boolean): OutputUpdate[] => {
    // A turn trigger's note already names its message; the fold sees every event.
    const trigger = triggerNotes(triggers, event), mode = planModeNotice(event)
    const notes = trigger ?? systemNotes(event, host.messageProjection)
    const compaction = compactionNotices(compactions, event, replay, occupancy(replay))
    // DSH starts the retried attempt: an empty text chunk (the meters' no-op
    // update) ends the TUI's Retrying state, as that attempt's first chunk would.
    const retried = !replay && event.type === 'llm/retry-started'
    return [
      ...notes === undefined ? [] : [{ sessionUpdate: 'image_dropped' as const, notes }], ...mode === undefined ? [] : [mode],
      ...turnNotices(event, replay), ...compaction, ...commandResults(commands, event),
      ...retried ? [{ sessionUpdate: 'agent_message_chunk' as const, content: { type: 'text' as const, text: '' } }] : [],
      ...lastPlan !== undefined && compaction.some(item => item.sessionUpdate === 'auto_compact_completed') ? [lastPlan] : [],
    ]
  }

  const live = (event: SessionEvent): void => {
    if (closed || !host.isLive()) return
    if (!admitEvent(event.seq)) return
    if (event.type === 'turn/start') state.turnStartMs = event.time
    const stream = streamState
    if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
      && stream !== undefined && !stream.closed && stream.turn === event.data.turn && stream.step === event.data.step) {
      stream.pending.push(event)
      return
    }
    const updates = mapEvent(event, false)
    for (const notice of notices(event, false)) update(notice, false, event.time)
    const projected = hasToolImages(event) ? host.projectImages(event, updates) : undefined
    updates.forEach((item, index) => update(
      projected === undefined ? item : projected.then(items => items[index]!), false, event.time))
  }

  const notify = (method: string, params: Record<string, unknown>, meta: Record<string, unknown> = {}): void => {
    if (closed || !host.isLive()) return
    host.notify(method, { ...params, sessionId: host.sessionId, _meta: { ...meta, eventSeq: state.eventSeq++ } })
  }
  /** The context projections changed: send the TUI's meters a fresh reading,
   * an empty text chunk that renders nothing. */
  const contextChanged = (): void => {
    contextMemo = undefined
    update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }, false)
  }
  const flush = async (): Promise<void> => {
    while (outputTail !== undefined) await outputTail
  }
  return {
    get stats() { return stats() },
    context, contextChanged, update, notify, live, assistant, flush,
    activity(running: boolean) {
      notify('session/update', { update: { sessionUpdate: 'session_info_update' } }, { sessionRunning: running })
    },
    async restore(events: readonly SessionEvent[], send = true): Promise<void> {
      let hydration: Promise<ProjectedUpdate[]> | undefined
      for (const event of events) {
        if (closed || !host.isLive()) return
        // Reserve each durable event once before either counters or async
        // projection. Live/replay overlap must not double-count its meters.
        if (!admitEvent(event.seq)) continue
        if (event.type === 'turn/start') state.turnStartMs = event.time
        const items = mapEvent(event, true)
        const extra = notices(event, true)
        if (!send) continue
        for (const notice of extra) update(notice, true, event.time)
        if (items.length === 0) continue
        // Reserve the complete replay prefix and its wire positions before
        // yielding. Otherwise a live successor raises lastSeq while an image
        // is loading and causes the remaining history to be dropped. Keep
        // image I/O sequential instead of opening every attachment at once.
        if (hasToolImages(event)) {
          const projected = (hydration ?? Promise.resolve()).then(() => closed || !host.isLive() ? items : host.projectImages(event, items))
          hydration = projected
          for (let index = 0; index < items.length; index++) update(projected.then(values => values[index]!), true, event.time)
        } else {
          for (const item of items) update(item, true, event.time)
        }
      }
      await hydration
      await flush()
    },
    async dispose(): Promise<void> {
      closed = true
      await flush()
      if (streamState !== undefined) streamState.pending.length = 0
      state.pendingToolCalls.clear()
      commands.clear()
    },
  }
}

export type SessionOutput = ReturnType<typeof createSessionOutput>
