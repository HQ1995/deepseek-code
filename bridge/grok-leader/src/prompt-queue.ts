import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { DurablePromptBlock } from './prompt-content.ts'
export type { DurablePromptBlock } from './prompt-content.ts'
import { createUserMessage, errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams } from './acp.ts'
import { turnEndToStopReason, type StopReasonWire } from './projection.ts'

/** RPC result of a settled session/prompt. `_meta.promptId` lets the pager
 *  attribute the response to its queue row directly (the grok shell's
 *  PromptResponse `_meta` shape) instead of inferring from RPC ids. */
export interface PromptSettleResult {
  stopReason: StopReasonWire
  _meta: { sessionId: string; promptId: string }
}

/** Already-submitted steering/settling input cannot be retracted independently. */
export type PromptCancelResult = 'cancelled' | 'not_found' | 'already_submitted'

interface PromptState {
  /** Serializes pre-enqueue image admission so later text prompts cannot overtake it. */
  promptAdmissionTail: Promise<void>
  /** FIFO of validated prompts waiting for the in-flight one to settle. */
  promptQueue: Array<{
    resolve: (value: PromptSettleResult) => void
    reject: (error: Error) => void
    /** Stable queue-row id: the request _meta.promptId or a minted uuid. */
    id: string
    text: string
    /** Durable model content; text is kept separately for queue/history display. */
    content: DurablePromptBlock[]
    /** Edit counter: fresh rows start at 0 (grok QueueEntryMeta), edits bump by one. */
    version: number
    /** Per-prompt display texts when combine folded followers into this row (len >= 2). */
    combinedTexts?: string[]
  }>
  /** Queue row id of the prompt the agent is currently draining. */
  runningPromptId: string | undefined
  /** Plain text of the running prompt (queue/changed carries it; the running row is omitted from entries). */
  runningText: string | undefined
  /** Per-prompt display texts of a combined running turn (len >= 2). */
  runningCombinedTexts: string[] | undefined
  /** Stamps the next prompt_complete broadcast (send_now suppresses the cancelled marker). */
  cancelTrigger: string | undefined
  /** Queue rows parked under queue/hold_edit; advance and combine skip them. */
  editHolds: Set<string>
  inflight: {
    resolve: (reason: StopReasonWire) => void
    reject: (error: Error) => void
    messageId: string
    promptId: string
    turn: number | undefined
  } | undefined
  /** True while the one idle-gated promotion wait is outstanding on
   *  `whenIdle`; dedups concurrent promotion requests. */
  promotionScheduled: boolean
  /** Prompts folded into the running turn as steering (follow-up steer).
   *  They settle with the host turn's stop reason at its turn end. */
  steered: Array<{ id: string; resolve: (value: PromptSettleResult) => void }>
}

export interface PromptQueueHost {
  sessionId: string
  agent: Pick<Agent, 'status' | 'followup' | 'steer' | 'whenIdle' | 'cancel'>
  isLive(): boolean
  notify(method: string, params: unknown): void
  echo(text: string): void
  flushOutput(): Promise<void>
}

export interface PromptQueue {
  readonly busy: boolean
  readonly promptId: string | undefined
  /** Check the supplied admission before further native work after an await.
   * Queue cancellation at that checkpoint settles cancelled; disposal rejects. */
  submit(params: Record<string, unknown>, text: string, prepare: (admission: { assertActive(): void }) => Promise<DurablePromptBlock[]>): Promise<PromptSettleResult>
  control(method: string, params: Record<string, unknown>): void
  observe(event: SessionEvent): void
  claimed(messageId: string, turn: number): void
  failed(turn: number, error: unknown): void
  cancel(): void
  /** Retire only this prompt; never fall back to whole-session cancellation. */
  cancelPrompt(promptId: string): PromptCancelResult
  dispose(): Promise<void>
}

/** One sequence owner per leader; each attached queue owns its own admission,
 * active turn, FIFO, edits and steering settlements. No session registry access. */
export function createPromptQueues(options: {
  combineQueued: boolean
  followUpSteer: boolean
  logger: { warn(message: string): void }
}): (host: PromptQueueHost) => PromptQueue {
  /** Queue-snapshot sequence, strictly increasing across every broadcast the
   *  leader emits. Epoch-seeded so a restarted leader outranks its
   *  predecessor's snapshots without a pager-side reset handshake; the pager
   *  drops any snapshot whose seq is not strictly newer for its session.
   *  The x1024 scale means a successor could only fall behind if the
   *  predecessor sustained over 1024 broadcasts per millisecond of its own
   *  lifetime — far beyond what per-broadcast JSON encoding and socket writes
   *  allow; the +1024 headstart covers even a same-millisecond succession.
   *  A clock that steps backwards between leaders is out of this seed's
   *  reach, so the pager also clears its watermarks whenever the leader
   *  connection is re-established (watermarks are connection-scoped).
   *  Stays integer-exact: 2^53 / (Date.now() * 1024) leaves millennia of
   *  headroom. */
  let queueSeq = Date.now() * 1024 + 1024

  return host => attachPromptQueue(host, options, () => ++queueSeq)
}

function attachPromptQueue(host: PromptQueueHost, options: Parameters<typeof createPromptQueues>[0], nextSequence: () => number): PromptQueue {
  const { combineQueued, followUpSteer, logger } = options
  let disposed = false
  let disposal: Promise<void> | undefined
  let admissionEpoch = 0, admissions = 0
  const runs = new Set<Promise<PromptSettleResult>>()
  const preparations = new Set<Promise<DurablePromptBlock[]>>()
  const preparing = new Map<string, () => void>()
  const state: PromptState = {
    promptAdmissionTail: Promise.resolve(),
    promptQueue: [],
    runningPromptId: undefined,
    runningText: undefined,
    runningCombinedTexts: undefined,
    cancelTrigger: undefined,
    editHolds: new Set(),
    inflight: undefined,
    promotionScheduled: false,
    steered: [],
  }

  const settlePrompt = (reason: StopReasonWire): void => {
    const inflight = state.inflight
    if (inflight === undefined) return
    state.inflight = undefined
    inflight.resolve(reason)
  }

  /** Terminal signal for one settled turn (grok x.ai/session/prompt_complete rail). */
  const emitPromptComplete = (id: string, stopReason: StopReasonWire, cancelTrigger: string | undefined): void => {
    host.notify('x.ai/session/prompt_complete', {
      sessionId: host.sessionId,
      promptId: id,
      stopReason,
      ...cancelTrigger === undefined ? {} : { cancelTrigger },
    })
  }

  /** Broadcast the live queue to the pager: pending rows plus the running prompt. */
  const broadcastQueueChanged = (): void => {
    host.notify('x.ai/queue/changed', {
      sessionId: host.sessionId,
      seq: nextSequence(),
      entries: state.promptQueue.map((entry, index) => ({
        id: entry.id,
        version: entry.version,
        kind: 'prompt',
        text: entry.text,
        position: index,
      })),
      ...state.runningPromptId === undefined ? {} : {
        runningPromptId: state.runningPromptId,
        runningText: state.runningText,
        runningKind: 'prompt',
        ...state.runningCombinedTexts === undefined ? {} : { runningCombinedTexts: state.runningCombinedTexts },
      },
    })
  }

  /** The settle result a resolved prompt RPC carries back to the pager. */
  const promptSettled = (promptId: string, stopReason: StopReasonWire): PromptSettleResult =>
    ({ stopReason, _meta: { sessionId: String(host.sessionId), promptId } })

  /**
   * Run one validated prompt: admit it, stream the echo, and settle at turn
   * end (or idle for a turnless slot).
   */
  const runPrompt = async (
    id: string,
    text: string,
    content: DurablePromptBlock[],
    combinedTexts?: string[],
  ): Promise<PromptSettleResult> => {
    if (!host.isLive()) {
      throw internalError('prompt was not queued: the agent was disposed outside the bridge')
    }
    const message = createUserMessage({ content, source: { kind: 'user' } })
    state.runningPromptId = id
    state.runningText = combinedTexts === undefined || combinedTexts[0] === undefined ? text : combinedTexts[0]
    state.runningCombinedTexts = combinedTexts
    let stopReason: StopReasonWire | undefined
    const failures: unknown[] = []
    try {
      stopReason = await new Promise<StopReasonWire>((resolve, reject) => {
        const inflight: NonNullable<PromptState['inflight']> = {
          resolve, reject, messageId: message.id, promptId: id, turn: undefined,
        }
        state.inflight = inflight
        try {
          host.agent.followup(message)
        } catch (error: unknown) {
          state.inflight = undefined
          reject(internalError('prompt was not queued: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
      // Echo the accepted prompt so it enters the client transcript, then let
      // the turn stream. Settlement happens at the correlated turn/end; a
      // turnless slot (admission discarded the prompt) settles cancelled at idle.
      broadcastQueueChanged()
      host.echo(text)
      void host.agent.whenIdle().then(() => {
        if (state.inflight !== inflight) return
        state.inflight = undefined
        inflight.resolve('cancelled')
      }, (error: unknown) => {
        if (state.inflight !== inflight) return
        state.inflight = undefined
        inflight.reject(internalError('agent idle wait failed: ' + errorChain(error)))
      })
      })
    } catch (error: unknown) {
      failures.push(error)
      // A throw from the echo/broadcast above rejects the promise with the
      // inflight still set; clearing it here guarantees advancePromptQueue is
      // never stalled behind a settled failure.
      state.inflight = undefined
    }
    // Completion must not clear the pager's pending tools before image hydration.
    try { await host.flushOutput() } catch (error) { failures.push(error) }
    // Cleanup on BOTH paths: a followup rejection or a rejected turn must not
    // strand runningPromptId or stall the queued successors.
    state.runningPromptId = undefined
    state.runningText = undefined
    state.runningCombinedTexts = undefined
    const cancelTrigger = state.cancelTrigger
    state.cancelTrigger = undefined
    if (failures.length === 0 && stopReason !== undefined) {
      try { emitPromptComplete(id, stopReason, cancelTrigger) } catch (error) { failures.push(error) }
    }
    // Steered follow-ups rode this turn: settle them with its outcome. They
    // never had a turn of their own, so no prompt_complete is emitted for them.
    for (const steered of state.steered.splice(0)) {
      steered.resolve(promptSettled(steered.id, stopReason ?? 'cancelled'))
    }
    try {
      if (state.promptQueue.length > 0) promoteWhenIdle()
      else broadcastQueueChanged()
    } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'prompt settlement failed')
    // A settled prompt must always carry a stop reason; an undefined one here
    // means the settlement path broke, and a silent non-null assertion would
    // lie to the pager about how the turn ended.
    if (stopReason === undefined) throw internalError('prompt settled without a stop reason')
    return promptSettled(id, stopReason)
  }

  /** Start the next queued prompt once the in-flight one has settled. */
  const advancePromptQueue = (): void => {
    // A settling prompt (inflight resolved, cleanup pending) still owns the
    // running slot: promoting now would emit the promotion broadcast before
    // the settling prompt's prompt_complete, breaking the grok wire order.
    // The settle path re-requests promotion after its cleanup.
    if (state.inflight !== undefined || state.runningPromptId !== undefined) return
    const front = state.promptQueue[0]
    if (front === undefined) return
    // A held front parks the whole queue (grok maybe_start_running_task):
    // nothing promotes until queue/release_edit clears the hold.
    if (state.editHolds.has(front.id)) return
    // grok combine: fold only adjacent text-only rows. Images are durable
    // message content and must retain their own per-message admission boundary.
    if (combineQueued && state.promptQueue.length >= 2
      && !front.content.some(block => block.type === 'image')) {
      const segments = [front.text]
      // Held or image-bearing followers stop the merge at that row.
      while (state.promptQueue.length >= 2
        && !state.editHolds.has(state.promptQueue[1]!.id)
        && !state.promptQueue[1]!.content.some(block => block.type === 'image')) {
        const follower = state.promptQueue.splice(1, 1)[0]!
        segments.push(follower.text)
        follower.resolve(promptSettled(follower.id, 'cancelled'))
      }
      if (segments.length >= 2) front.combinedTexts = segments
    }
    const entry = state.promptQueue.shift()!
    const runText = entry.combinedTexts === undefined ? entry.text : entry.combinedTexts.join('\n\n')
    const runContent = entry.combinedTexts === undefined
      ? entry.content
      : [{ type: 'text' as const, text: runText }]
    const run = runPrompt(entry.id, runText, runContent, entry.combinedTexts)
    runs.add(run)
    void run.then(entry.resolve, entry.reject).finally(() => { runs.delete(run) })
  }

  /** Promote the next queued prompt without racing the harness turn lifecycle.
   *
   * The single promotion entry point: settle, enqueue, and every queue
   * mutation route through here, so no path can start a followup from inside
   * the harness's turn/end handling (the harness discards a followup admitted
   * there). An agent reporting `status === 'idle'` has retired its driver —
   * no turn/end handler can be on the stack — so the idle path promotes
   * synchronously, keeping its enqueue → running broadcast order. (Load-
   * bearing agent-loop ordering: kick() flips status to idle before the
   * driver promise that whenIdle awaits resolves, so a settling prompt's
   * cleanup always runs before anyone observes idle for that turn.) Any other
   * state schedules exactly one `whenIdle` wait (`promotionScheduled` dedups;
   * the settle path re-requests promotion, so a wait that fires while a turn
   * is still in flight never strands the queue). The live-record guard
   * mirrors the settle path: a closed, reloaded, or re-parented session must
   * not resurrect queued prompts through a stale agent reference. */
  const promoteWhenIdle = (): void => {
    if (disposed || !host.isLive() || state.promotionScheduled) return
    if (state.inflight === undefined && host.agent.status === 'idle') {
      advancePromptQueue()
      return
    }
    state.promotionScheduled = true
    void host.agent.whenIdle().then(() => {
      state.promotionScheduled = false
      if (disposed || !host.isLive()) return
      advancePromptQueue()
    }, (error: unknown) => {
      state.promotionScheduled = false
      logger.warn('grok-leader: idle wait failed for ' + String(host.sessionId) + ': ' + errorChain(error))
    })
  }

  /** Settle every queued (not-yet-run) prompt as cancelled (cancel/close/teardown). */
  const discardPromptQueue = (): void => {
    // A discarded row can never be promoted, so its edit hold must not linger
    // and accidentally park a future row that reuses the same id.
    state.editHolds.clear()
    for (const entry of state.promptQueue.splice(0)) entry.resolve(promptSettled(entry.id, 'cancelled'))
  }

  /** Enqueue a validated prompt and run it as soon as the session is idle. */
  const enqueuePrompt = (p: Record<string, unknown>, text: string, content: DurablePromptBlock[], id: string): Promise<PromptSettleResult> =>
    new Promise((resolve, reject) => {
      const meta = p._meta as Record<string, unknown> | null | undefined
      if (meta?.sendNow === true && state.inflight !== undefined) {
        // grok send-now for a composer prompt (_meta.sendNow): cancel the
        // running turn and run this prompt next, ahead of the queue —
        // mirroring x.ai/queue/interject's front-jump for queued rows. The
        // send_now trigger suppresses the pager's "Turn cancelled" marker.
        state.promptQueue.unshift({ resolve, reject, id, text, content, version: 0 })
        state.cancelTrigger = 'send_now'
        host.agent.cancel({ kind: 'user' })
        settlePrompt('cancelled')
        broadcastQueueChanged()
        return
      }
      // Per-prompt routing: _meta.followUp overrides the configured default,
      // so one keystroke can steer a single follow-up while plain sends keep
      // queueing (or vice versa). Unknown values fall back to the default.
      const steerThis = meta?.followUp === 'steer' ? true : meta?.followUp === 'queue' ? false : followUpSteer
      if (steerThis && state.inflight !== undefined) {
        // Follow-up steer (grok ui.follow_up_behavior=steer): fold the prompt
        // into the running turn at the harness's next step boundary instead of
        // parking it behind a whole (possibly minutes-long) turn. The row is
        // confirmed to the pager once — so its optimistic echo retires by id —
        // and then leaves the queue as it joins the live turn; its RPC settles
        // with the host turn (see the steered drain in runPrompt).
        const row = { resolve, reject, id, text, content, version: 0 }
        state.promptQueue.push(row)
        broadcastQueueChanged()
        const index = state.promptQueue.indexOf(row)
        if (index < 0) return // A reentrant cancellation retired this advertised row.
        state.promptQueue.splice(index, 1)
        const steered = { id, resolve }
        state.steered.push(steered)
        try {
          host.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
        } catch (error: unknown) {
          const index = state.steered.indexOf(steered)
          if (index >= 0) state.steered.splice(index, 1)
          broadcastQueueChanged()
          reject(internalError('prompt was not steered: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
        // Echo into the live turn's stream: steered text belongs to the
        // running transcript, mirroring runPrompt's admission echo.
        host.echo(text)
        broadcastQueueChanged()
        return
      }
      // Fresh rows start at version 0 (grok QueueEntryMeta); edits bump by one.
      state.promptQueue.push({ resolve, reject, id, text, content, version: 0 })
      const runningBefore = state.runningPromptId
      promoteWhenIdle()
      // The idle fast path already broadcast the promoted state from inside
      // runPrompt (with this row included); a second identical snapshot would
      // only burn a seq and a client wakeup.
      if (state.runningPromptId === runningBefore) broadcastQueueChanged()
    })

  const control = (method: string, unwrapped: Record<string, unknown>): void => {
    const queueEntry = (id: unknown): { index: number; entry: PromptState['promptQueue'][number] } | undefined => {
      if (typeof id !== 'string') return undefined
      const index = state.promptQueue.findIndex(entry => entry.id === id)
      return index < 0 ? undefined : { index, entry: state.promptQueue[index]! }
    }
    const queueMutate = broadcastQueueChanged
    switch (method) {
      case 'x.ai/queue/interject': {
        const p = unwrapped
        // The client supplies the version it last saw (absent = 0, the version
        // of never-edited rows); a mismatch is a benign no-op + resync.
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(p.id)
        if (located === undefined || located.entry.version !== expectedVersion) {
          if (typeof p.id === 'string') state.editHolds.delete(p.id)
          promoteWhenIdle()
          queueMutate()
          return
        }
        const [entry] = state.promptQueue.splice(located.index, 1)
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          entry.text = p.newText
          entry.content = [
            { type: 'text', text: p.newText },
            ...entry.content.filter((block): block is Extract<DurablePromptBlock, { type: 'image' }> => block.type === 'image'),
          ]
          entry.combinedTexts = undefined
          entry.version = entry.version + 1
        }
        state.promptQueue.unshift(entry)
        state.editHolds.delete(entry.id)
        // grok send-now: cancel the running turn and run this prompt next.
        // cancelTrigger='send_now' suppresses the pager's Turn-cancelled marker.
        if (state.inflight !== undefined) {
          state.cancelTrigger = 'send_now'
          host.agent.cancel({ kind: 'user' })
          settlePrompt('cancelled')
        } else {
          promoteWhenIdle()
        }
        queueMutate()
        return
      }
      case 'x.ai/queue/steer': {
        const p = unwrapped
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(p.id)
        if (located === undefined || located.entry.version !== expectedVersion) {
          if (typeof p.id === 'string') state.editHolds.delete(p.id)
          promoteWhenIdle()
          queueMutate()
          return
        }
        // Steer is only meaningful into a live turn; otherwise keep the row
        // queued and let it run normally (grok InterjectQueuedPrompt no-op).
        if (state.inflight === undefined) {
          promoteWhenIdle()
          queueMutate()
          return
        }
        const [entry] = state.promptQueue.splice(located.index, 1)
        state.editHolds.delete(entry.id)
        const text = entry.combinedTexts === undefined ? entry.text : entry.combinedTexts.join('\n\n')
        const content = entry.combinedTexts === undefined
          ? entry.content
          : [{ type: 'text' as const, text }]
        try {
          host.agent.steer(createUserMessage({ content, source: { kind: 'user' } }))
        } catch (error) {
          // Put the row back so a failed steer never loses the queued message.
          state.promptQueue.splice(located.index, 0, entry)
          queueMutate()
          entry.reject(internalError('prompt was not steered: ' + (error instanceof Error ? error.message : String(error))))
          return
        }
        state.steered.push({ id: entry.id, resolve: entry.resolve })
        host.echo(text)
        queueMutate()
        return
      }
      case 'x.ai/queue/remove': {
        const p = unwrapped
        const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
        const located = queueEntry(p.id)
        if (located !== undefined && located.entry.version !== expectedVersion) {
          // Stale version: leave the row untouched and resync the client.
          state.editHolds.delete(located.entry.id)
          promoteWhenIdle()
          queueMutate()
          return
        }
        if (located !== undefined) {
          const [entry] = state.promptQueue.splice(located.index, 1)
          entry.resolve(promptSettled(entry.id, 'cancelled'))
          state.editHolds.delete(entry.id)
          queueMutate()
          // Removing a held front must not strand the rows behind it.
          promoteWhenIdle()
          return
        }
        if (state.runningPromptId === p.id) {
          host.agent.cancel({ kind: 'user' })
          settlePrompt('cancelled')
          state.editHolds.delete(String(p.id))
        }
        promoteWhenIdle()
        queueMutate()
        return
      }
      case 'x.ai/queue/edit': {
        const p = unwrapped
        const located = queueEntry(p.id)
        if (located === undefined) return
        // Every path drops the hold (grok handle_edit_queued_prompt): a stale
        // or blank edit must not leave promotion parked.
        state.editHolds.delete(located.entry.id)
        // The TUI sends no version for edit (grok edits LWW); honor one when a
        // client pins it: a stale version no-ops + resyncs like remove/interject.
        if (typeof p.expectedVersion === 'number' && located.entry.version !== p.expectedVersion) {
          promoteWhenIdle()
          queueMutate()
          return
        }
        if (typeof p.newText === 'string' && p.newText.trim().length > 0) {
          located.entry.text = p.newText
          located.entry.content = [
            { type: 'text', text: p.newText },
            ...located.entry.content.filter((block): block is Extract<DurablePromptBlock, { type: 'image' }> => block.type === 'image'),
          ]
          located.entry.combinedTexts = undefined
          located.entry.version = located.entry.version + 1
        }
        promoteWhenIdle()

        queueMutate()
        return
      }
      case 'x.ai/queue/hold_edit': {
        const p = unwrapped
        if (typeof p.id === 'string') state.editHolds.add(p.id)
        return
      }
      case 'x.ai/queue/release_edit': {
        const p = unwrapped
        if (typeof p.id !== 'string' || !state.editHolds.delete(p.id)) return
        // Unblocks a front parked under edit hold (grok SessionCommand::ReleaseEdit).
        promoteWhenIdle()
        return
      }
      case 'x.ai/queue/reorder': {
        const p = unwrapped
        const orderedIds = Array.isArray(p.orderedIds) ? p.orderedIds.filter((id): id is string => typeof id === 'string') : []
        let changed = false
        if (orderedIds.length > 0) {
          const byId = new Map(state.promptQueue.map(entry => [entry.id, entry]))
          const next: typeof state.promptQueue = []
          for (const id of orderedIds) {
            const entry = byId.get(id)
            if (entry === undefined) continue
            next.push(entry)
            byId.delete(id)
          }
          for (const entry of state.promptQueue) if (byId.has(entry.id)) next.push(entry)
          changed = next.length === state.promptQueue.length
            && next.some((entry, index) => entry !== state.promptQueue[index])
          state.promptQueue.splice(0, state.promptQueue.length, ...next)
        }
        if (changed) promoteWhenIdle()
        queueMutate()
        return
      }
      case 'x.ai/queue/clear': {
        discardPromptQueue()
        queueMutate()
        return
      }

    }
  }

  const cancel = (): void => {
    admissionEpoch++
    const failures: unknown[] = []
    // Native cancellation and presentation cannot prevent the queue from
    // retiring its own accepted rows and edit holds.
    try { host.agent.cancel({ kind: 'user' }) } catch (error) { failures.push(error) }
    settlePrompt('cancelled')
    discardPromptQueue()
    try { broadcastQueueChanged() } catch (error) { failures.push(error) }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'prompt cancellation failed')
  }

  const cancelPrompt = (id: string): PromptCancelResult => {
    if (disposed || !host.isLive()) return 'not_found'
    // Enqueue can synchronously publish a notification before submit
    // retires its admission. The actual running/queued owner wins in that gap.
    if (state.inflight?.promptId === id) {
      try { host.agent.cancel({ kind: 'user' }) }
      finally { settlePrompt('cancelled') }
      return 'cancelled'
    }
    const index = state.promptQueue.findIndex(entry => entry.id === id)
    if (index >= 0) {
      const entry = state.promptQueue.splice(index, 1)[0]!
      state.editHolds.delete(id)
      entry.resolve(promptSettled(id, 'cancelled'))
      promoteWhenIdle()
      broadcastQueueChanged()
      return 'cancelled'
    }
    if (state.runningPromptId === id || state.steered.some(entry => entry.id === id)) return 'already_submitted'
    const stop = preparing.get(id)
    if (stop === undefined) return 'not_found'
    stop()
    return 'cancelled'
  }

  return {
    get busy() { return admissions > 0 || state.promptQueue.length > 0 || state.inflight !== undefined || state.runningPromptId !== undefined },
    get promptId() { return state.inflight?.promptId },
    submit(params, text, prepare) {
      if (disposed || !host.isLive()) return Promise.reject(invalidParams('unknown session: ' + host.sessionId))
      const epoch = admissionEpoch
      const meta = params._meta as Record<string, unknown> | null | undefined
      const id = typeof meta?.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
      if (preparing.has(id) || state.runningPromptId === id || state.promptQueue.some(entry => entry.id === id)
        || state.steered.some(entry => entry.id === id)) return Promise.reject(invalidParams('duplicate active prompt: ' + id))
      admissions++
      const previous = state.promptAdmissionTail
      let release = (): void => {}
      state.promptAdmissionTail = new Promise<void>(resolve => { release = resolve })
      let resolve!: (value: PromptSettleResult | PromiseLike<PromptSettleResult>) => void, reject!: (error: unknown) => void
      const result = new Promise<PromptSettleResult>((yes, no) => { resolve = yes; reject = no })
      const cancelled = Symbol('cancelled prompt preparation')
      let targeted = false, retired = false, predecessorDone = false
      const retire = () => {
        if (retired) return
        retired = true; preparing.delete(id); admissions--
        // A cancelled waiting slot cannot let successors overtake its predecessor.
        if (predecessorDone) release()
      }
      preparing.set(id, () => { targeted = true; resolve(promptSettled(id, 'cancelled')); retire() })
      const admission = { assertActive() {
        if (disposed || !host.isLive()) throw invalidParams('unknown session: ' + host.sessionId)
        if (targeted || epoch !== admissionEpoch) throw cancelled
      } }
      const failed = (error: unknown) => {
        if (retired) return
        // Whole-session cancellation must not mask an unrelated native failure.
        if (error === cancelled) resolve(promptSettled(id, 'cancelled'))
        else reject(error)
        retire()
      }
      void previous.then(() => {
        predecessorDone = true
        if (retired) { release(); return }
        try {
          admission.assertActive()
          // Keep actual IO in the drain even when cancellation retires its slot.
          // No extra admission awaits: preserve completion/promotion wire order.
          const preparation = prepare(admission)
          preparations.add(preparation)
          void preparation.then(content => {
            preparations.delete(preparation)
            if (retired) return
            try { admission.assertActive(); resolve(enqueuePrompt(params, text, content, id)); retire() }
            catch (error) { failed(error) }
          }, error => { preparations.delete(preparation); failed(error) })
        } catch (error) { failed(error) }
      })
      return result
    },
    control(method, params) { if (!disposed && host.isLive()) control(method, params) },
    observe(event) {
      const inflight = state.inflight
      if (inflight !== undefined && event.type === 'turn/end' && inflight.turn === event.data.turn) {
        if (event.data.reason.kind === 'error') {
          state.inflight = undefined
          inflight.reject(internalError('turn failed: ' + event.data.reason.error.message))
        } else {
          // The grok PromptResponse settles at turn end, not whole-agent idle.
          settlePrompt(turnEndToStopReason(event.data.reason))
        }
      }

    },
    claimed(messageId, turn) {
      if (state.inflight?.messageId === messageId) state.inflight.turn = turn
    },
    failed(turn, error) {
      const inflight = state.inflight
      if (inflight === undefined || inflight.turn !== turn) return
      state.inflight = undefined
      inflight.reject(internalError('turn failed: ' + errorChain(error)))
    },
    cancel,
    cancelPrompt,
    dispose() {
      if (disposal !== undefined) return disposal
      disposed = true
      const failures: unknown[] = []
      // Publish before cancellation callbacks reenter disposal, then drain
      // even if a hook failed. Native run errors belong to their prompt RPCs.
      disposal = Promise.resolve().then(async () => {
        await Promise.allSettled([...runs, state.promptAdmissionTail])
        while (preparations.size > 0) await Promise.allSettled([...preparations])
        if (failures.length > 0) throw failures[0]
      })
      try { cancel() } catch (error) { failures.push(error) }
      return disposal
    },
  }
}
