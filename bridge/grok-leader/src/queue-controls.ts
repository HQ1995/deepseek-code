/**
 * `x.ai/queue/*` row controls over one prompt queue's state: interject,
 * steer, remove, edit, edit holds, reorder and clear. Each handler keeps its
 * wire-visible order of splice, hold release, settlement, promotion and
 * broadcast. Admission, the running turn and settlement stay in prompt-queue.
 *
 * @module dscode/queue-controls
 */
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { internalError } from './acp.ts'
import { errorMessage } from './guards.ts'
import type { DurablePromptBlock } from './prompt-content.ts'
import type { StopReasonWire } from './projection.ts'

/** RPC result of a settled session/prompt. `_meta.promptId` lets the pager
 *  attribute the response to its queue row directly (the grok shell's
 *  PromptResponse `_meta` shape) instead of inferring from RPC ids. */
export interface PromptSettleResult {
  stopReason: StopReasonWire
  _meta: { sessionId: string; promptId: string }
}

export interface PromptState {
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

type QueueRow = PromptState['promptQueue'][number]

/** The queue a control acts on: its state, host and the engine's own steps. */
export interface QueueControlContext {
  /** Mutated in place, never replaced. */
  state: PromptState
  /** `agent` is read at call time. */
  host: { readonly agent: Pick<Agent, 'steer' | 'cancel'>; echo(text: string): void }
  /** Publish `x.ai/queue/changed`. */
  broadcast(): void
  /** The single promotion entry point. */
  promote(): void
  /** Settle the in-flight prompt. */
  settle(reason: StopReasonWire): void
  /** Settle every queued row as cancelled. */
  discard(): void
  /** The result a settled prompt RPC carries. */
  settled(promptId: string, stopReason: StopReasonWire): PromptSettleResult
}

type Control = (ctx: QueueControlContext, p: Record<string, unknown>) => void

const locate = (state: PromptState, id: unknown): { index: number; entry: QueueRow } | undefined => {
  if (typeof id !== 'string') return undefined
  const index = state.promptQueue.findIndex(entry => entry.id === id)
  return index < 0 ? undefined : { index, entry: state.promptQueue[index]! }
}

/** Replace a row's text, keeping its image blocks, and bump its version. */
const rewriteText = (entry: QueueRow, newText: string): void => {
  entry.text = newText
  entry.content = [
    { type: 'text', text: newText },
    ...entry.content.filter((block): block is Extract<DurablePromptBlock, { type: 'image' }> => block.type === 'image'),
  ]
  entry.combinedTexts = undefined
  entry.version = entry.version + 1
}

const interject: Control = ({ state, host, broadcast, promote, settle }, p) => {
  // The client supplies the version it last saw (absent = 0, the version
  // of never-edited rows); a mismatch is a benign no-op + resync.
  const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
  const located = locate(state, p.id)
  if (located === undefined || located.entry.version !== expectedVersion) {
    if (typeof p.id === 'string') state.editHolds.delete(p.id)
    promote()
    broadcast()
    return
  }
  const [entry] = state.promptQueue.splice(located.index, 1)
  if (typeof p.newText === 'string' && p.newText.trim().length > 0) rewriteText(entry, p.newText)
  state.promptQueue.unshift(entry)
  state.editHolds.delete(entry.id)
  // grok send-now: cancel the running turn and run this prompt next.
  // cancelTrigger='send_now' suppresses the pager's Turn-cancelled marker.
  if (state.inflight !== undefined) {
    state.cancelTrigger = 'send_now'
    host.agent.cancel({ kind: 'user' })
    settle('cancelled')
  } else {
    promote()
  }
  broadcast()
}

const steer: Control = ({ state, host, broadcast, promote }, p) => {
  const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
  const located = locate(state, p.id)
  if (located === undefined || located.entry.version !== expectedVersion) {
    if (typeof p.id === 'string') state.editHolds.delete(p.id)
    promote()
    broadcast()
    return
  }
  // Steer is only meaningful into a live turn; otherwise keep the row
  // queued and let it run normally (grok InterjectQueuedPrompt no-op).
  if (state.inflight === undefined) {
    promote()
    broadcast()
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
    broadcast()
    entry.reject(internalError('prompt was not steered: ' + errorMessage(error)))
    return
  }
  state.steered.push({ id: entry.id, resolve: entry.resolve })
  host.echo(text)
  broadcast()
}

const remove: Control = ({ state, host, broadcast, promote, settle, settled }, p) => {
  const expectedVersion = typeof p.expectedVersion === 'number' ? p.expectedVersion : 0
  const located = locate(state, p.id)
  if (located !== undefined && located.entry.version !== expectedVersion) {
    // Stale version: leave the row untouched and resync the client.
    state.editHolds.delete(located.entry.id)
    promote()
    broadcast()
    return
  }
  if (located !== undefined) {
    const [entry] = state.promptQueue.splice(located.index, 1)
    entry.resolve(settled(entry.id, 'cancelled'))
    state.editHolds.delete(entry.id)
    broadcast()
    // Removing a held front must not strand the rows behind it.
    promote()
    return
  }
  if (state.runningPromptId === p.id) {
    host.agent.cancel({ kind: 'user' })
    settle('cancelled')
    state.editHolds.delete(String(p.id))
  }
  promote()
  broadcast()
}

const edit: Control = ({ state, broadcast, promote }, p) => {
  const located = locate(state, p.id)
  if (located === undefined) return
  // Every path drops the hold (grok handle_edit_queued_prompt): a stale
  // or blank edit must not leave promotion parked.
  state.editHolds.delete(located.entry.id)
  // The TUI sends no version for edit (grok edits LWW); honor one when a
  // client pins it: a stale version no-ops + resyncs like remove/interject.
  if (typeof p.expectedVersion === 'number' && located.entry.version !== p.expectedVersion) {
    promote()
    broadcast()
    return
  }
  if (typeof p.newText === 'string' && p.newText.trim().length > 0) rewriteText(located.entry, p.newText)
  promote()
  broadcast()
}

const holdEdit: Control = ({ state }, p) => {
  if (typeof p.id === 'string') state.editHolds.add(p.id)
}

const releaseEdit: Control = ({ state, promote }, p) => {
  if (typeof p.id !== 'string' || !state.editHolds.delete(p.id)) return
  // Unblocks a front parked under edit hold (grok SessionCommand::ReleaseEdit).
  promote()
}

const reorder: Control = ({ state, broadcast, promote }, p) => {
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
  if (changed) promote()
  broadcast()
}

const clear: Control = ({ broadcast, discard }) => {
  discard()
  broadcast()
}

/** Apply one `x.ai/queue/*` control; an unknown method is a no-op. */
export function controlQueue(ctx: QueueControlContext, method: string, params: Record<string, unknown>): void {
  switch (method) {
    case 'x.ai/queue/interject': return interject(ctx, params)
    case 'x.ai/queue/steer': return steer(ctx, params)
    case 'x.ai/queue/remove': return remove(ctx, params)
    case 'x.ai/queue/edit': return edit(ctx, params)
    case 'x.ai/queue/hold_edit': return holdEdit(ctx, params)
    case 'x.ai/queue/release_edit': return releaseEdit(ctx, params)
    case 'x.ai/queue/reorder': return reorder(ctx, params)
    case 'x.ai/queue/clear': return clear(ctx, params)
  }
}
