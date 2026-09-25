/**
 * Turn lifecycle facts the TUI already renders from its xAI session updates:
 * model-request retries, typed turn failures, tool calls the model is still
 * writing, automatic compaction, plan mode and why a turn started, and the
 * notes for model-visible context nothing else renders. Pure mapping of
 * native events and stream chunks; the owning session output keeps their
 * state and decides when to send them.
 *
 * @module dscode/turn-notices
 */
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-llm-retry/types'

/** A model failure as native events record it (`LlmFailure`). */
export interface FailureFacts {
  readonly message: string
  readonly code?: string
  readonly status?: number
  readonly requestId?: string
}

/** The TUI's `retry_state` update: a scheduled retry, or the failure that ended a turn. */
export type RetryStateUpdate =
  | { sessionUpdate: 'retry_state'; type: 'retrying'; attempt: number; max_retries: number; reason: string }
  | { sessionUpdate: 'retry_state'; type: 'failed'; error_type: string; message: string }

/** A tool call the model is still writing: its position and, once known, its name. */
export type ToolCallWriting = { sessionUpdate: 'tool_call_delta_chunk'; tool_index: number; name?: string }

/** Updates that ride `x.ai/session_notification` rather than ACP `session/update`. */
export type XaiNotice = { sessionUpdate: 'image_dropped'; notes: string[] } | RetryStateUpdate | ToolCallWriting | CompactionNotice

const XAI_NOTICES: ReadonlySet<string> = new Set<XaiNotice['sessionUpdate']>(['image_dropped', 'retry_state', 'tool_call_delta_chunk',
  'auto_compact_started', 'auto_compact_completed', 'auto_compact_failed'])
export const isXaiNotice = (update: { sessionUpdate: string }): update is XaiNotice => XAI_NOTICES.has(update.sessionUpdate)

/** A model call DSH refused for want of a usable key fails the same way on
 * every retry, and DSH's wording points at its web Models page. It settles as
 * a refusal naming dscode's fix; the TUI shows a refusal without "Try sending
 * again". */
export function credentialFix(failure: { message: string; code?: string }): string | undefined {
  const provider = /provider route "([^"]+)"/.exec(failure.message)?.[1]
  const which = provider === undefined ? 'this provider' : 'provider "' + provider + '"'
  const edit = ' in /provider (highlight it and press e), then send again.'
  if (failure.code === 'MISSING_CREDENTIAL') return 'No API key is stored for ' + which + '. Add one' + edit
  if (failure.code === 'INVALID_CREDENTIAL') return 'The API key stored for ' + which + ' is not usable. Replace it' + edit
  return undefined
}

/** The TUI reads "status 402" and "Payment Required (402)" as xAI's credit-limit
 * upsell and "Unauthorized (401)" as its /login prompt. Neither is dscode's
 * fix, so those spellings become a plain HTTP status. */
const neutral = (text: string): string => text
  .replace(/\bstatus\s+402\b/gi, 'HTTP 402')
  .replace(/\b(Payment Required|Unauthorized) \((\d{3})\)/g, '$1, HTTP $2')

/** One line naming a failure with its HTTP status, code and provider request
 * id. `status N` is what the TUI parses into its request-failure headline. */
export function describeFailure(failure: FailureFacts): string {
  const facts = [
    ...failure.status === undefined ? [] : ['status ' + failure.status],
    ...failure.code === undefined || failure.code === 'UNKNOWN' ? [] : [failure.code],
    ...failure.requestId === undefined ? [] : ['request ' + failure.requestId],
  ]
  return neutral(facts.length === 0 ? failure.message : failure.message + ' (' + facts.join(', ') + ')')
}

/** Native failure codes with a dedicated TUI failure class. The rest render
 * the status headline when the provider sent one ('api'), else a plain failure. */
const ERROR_TYPES: Readonly<Record<string, string>> = {
  CONTEXT_WINDOW_EXCEEDED: 'context_length', RATE_LIMIT: 'rate_limited', TIMEOUT: 'idle_timeout',
  TRANSPORT: 'http', EMPTY_RESPONSE: 'empty_response',
}

const failureFacts = (value: unknown): FailureFacts | undefined => {
  const facts = value as Partial<Record<keyof FailureFacts, unknown>> | null | undefined
  if (typeof facts?.message !== 'string') return undefined
  return {
    message: facts.message,
    ...typeof facts.code === 'string' ? { code: facts.code } : {},
    ...typeof facts.status === 'number' && Number.isSafeInteger(facts.status) ? { status: facts.status } : {},
    ...typeof facts.requestId === 'string' && facts.requestId !== '' ? { requestId: facts.requestId } : {},
  }
}

/** The typed failure one failed turn shows, or undefined for a credential
 * refusal: that settles the prompt with dscode's fix instead. */
export function turnFailure(value: unknown): RetryStateUpdate | undefined {
  const failure = failureFacts(value)
  if (failure === undefined || credentialFix(failure) !== undefined) return undefined
  const typed = failure.code === undefined ? undefined : ERROR_TYPES[failure.code]
  const error_type = typed ?? (failure.status !== undefined && failure.status !== 402 ? 'api' : 'other')
  return { sessionUpdate: 'retry_state', type: 'failed', error_type, message: describeFailure(failure) }
}

/**
 * Retry and failure notices one durable event carries. A scheduled retry is a
 * live spinner only (`isRateLimited` is never set: that is xAI's upsell); the
 * session output ends it when the retried attempt starts, and a later failure
 * or the turn's end also clears it. A failed turn's typed failure is part of
 * its history, so it is sent on replay too.
 */
export function turnNotices(event: SessionEvent, replay: boolean): XaiNotice[] {
  if (event.type === 'llm/retry') {
    const failure = failureFacts(event.data.failure)
    if (replay || failure === undefined) return []
    return [{ sessionUpdate: 'retry_state', type: 'retrying', attempt: event.data.retry,
      max_retries: event.data.mode === 'normal' ? event.data.maxRetries : 0, reason: describeFailure(failure) }]
  }
  if (event.type === 'turn/end' && event.data.reason.kind === 'error') {
    const failed = turnFailure(event.data.reason.error)
    return failed === undefined ? [] : [failed]
  }
  return []
}

/** The TUI treats a write whose deltas stop for 10 s as a dead stream, so a
 * long write is refreshed well inside that; forwarding every delta would put
 * one socket frame per argument fragment. */
export const WRITING_REFRESH_MS = 2000

/** Live tool-call deltas of one streamed attempt, by content-block index. */
export type WritingCalls = Map<number, { named: boolean; at: number }>

/**
 * The TUI's "Writing file…"/"Preparing <tool>…" status for a tool call the
 * model is still streaming, which reaches no transcript until its durable
 * `tool/call` opens the card. Name and position only: the arguments stay with
 * the card. Sent for a new call, when its name first arrives, and then at most
 * every {@link WRITING_REFRESH_MS} while the call keeps streaming.
 */
export function toolCallWriting(calls: WritingCalls, chunk: StreamChunk, time: number): ToolCallWriting | undefined {
  if (chunk.type !== 'tool-call-delta') return undefined
  const name = typeof chunk.name === 'string' && chunk.name !== '' ? chunk.name : undefined
  const seen = calls.get(chunk.index)
  if (seen !== undefined && (name === undefined || seen.named) && time - seen.at < WRITING_REFRESH_MS) return undefined
  calls.set(chunk.index, { named: seen?.named === true || name !== undefined, at: time })
  return { sessionUpdate: 'tool_call_delta_chunk', tool_index: chunk.index, ...name === undefined ? {} : { name } }
}

/** The TUI's automatic-compaction blocks (`session_event.rs`). */
export type CompactionNotice =
  | { sessionUpdate: 'auto_compact_started'; tokens_used: number; context_window: number; percentage: number; reason: string }
  | { sessionUpdate: 'auto_compact_completed'; tokens_before?: number; tokens_after: number; elapsed_ms: number; summary_preview?: string }
  | { sessionUpdate: 'auto_compact_failed'; error: string }

/** Automatic compactions between their durable start and end markers. */
export type CompactionFold = Map<string, { start: number; before?: number; shadowed?: number; summaryTokens?: number; preview?: string }>

/** Context occupancy when a compaction event is seen: the native next-request
 * projection (`native`) live, else the last provider-reported prompt size. */
export interface ContextTokens { used?: number; window?: number; native?: boolean }

const PREVIEW_CHARS = 100

/**
 * Map one `compaction/*` marker of an automatic compaction (no initiating
 * command: `/compact` keeps the TUI's own command flow). Start shows the
 * TUI's "Context N% full. Compacting…" with its spinner, live only and only
 * when occupancy and capacity are known. End shows the failure, or the
 * completion with the context before and after; live, "after" is the native
 * projection, which reprices the span the summary shadowed at once, and on
 * replay it is estimated from the summary's own accounting.
 */
export function compactionNotices(fold: CompactionFold, event: SessionEvent, replay: boolean, context: () => ContextTokens): CompactionNotice[] {
  const type = String(event.type)
  if (type !== 'compaction/start' && type !== 'compaction/summary' && type !== 'compaction/end') return []
  const data = event.data as { compactionId?: unknown; sourceCommandId?: unknown; error?: unknown; shadowedTokenCount?: unknown;
    usage?: { outputTokens?: unknown }; summary?: Array<{ type?: unknown; text?: unknown }> } | null
  if (typeof data?.compactionId !== 'string' || data.sourceCommandId !== undefined) return []
  const id = data.compactionId
  if (type === 'compaction/start') {
    const { used, window } = context()
    fold.set(id, { start: event.time, ...used === undefined ? {} : { before: used } })
    if (replay || used === undefined || window === undefined || window <= 0) return []
    return [{ sessionUpdate: 'auto_compact_started', tokens_used: used, context_window: window,
      percentage: Math.min(255, Math.round(used / window * 100)), reason: 'context pressure' }]
  }
  const open = fold.get(id)
  if (type === 'compaction/summary') {
    if (open === undefined) return []
    const text = (Array.isArray(data.summary) ? data.summary : []).flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
    if (typeof data.shadowedTokenCount === 'number') open.shadowed = data.shadowedTokenCount
    open.summaryTokens = typeof data.usage?.outputTokens === 'number' ? data.usage.outputTokens : Math.ceil(text.length / 4)
    const preview = text.trim().replace(/\s+/g, ' ')
    if (preview !== '') open.preview = preview.length > PREVIEW_CHARS ? preview.slice(0, PREVIEW_CHARS - 1) + '…' : preview
    return []
  }
  fold.delete(id)
  if (typeof data.error === 'string') return [{ sessionUpdate: 'auto_compact_failed', error: data.error }]
  const estimate = open?.before === undefined || open.shadowed === undefined ? undefined
    : Math.max(0, open.before - open.shadowed + (open.summaryTokens ?? 0))
  const now = replay ? undefined : context()
  const after = (now?.native === true ? now.used : undefined) ?? estimate
  if (after === undefined) return []
  return [{ sessionUpdate: 'auto_compact_completed', tokens_after: after, elapsed_ms: Math.max(0, event.time - (open?.start ?? event.time)),
    ...open?.before === undefined ? {} : { tokens_before: open.before },
    ...open?.preview === undefined ? {} : { summary_preview: open.preview } }]
}

/** ACP's session-mode update, which drives the TUI's plan-mode indicator. */
export type ModeUpdate = { sessionUpdate: 'current_mode_update'; currentModeId: 'plan' | 'default' }
export const planModeUpdate = (active: boolean): ModeUpdate => ({ sessionUpdate: 'current_mode_update', currentModeId: active ? 'plan' : 'default' })

/** A durable `plan/mode` selection (the last one wins), live and on replay:
 * `/plan`, the TUI's own mode switch, an approved plan and the queued exit of
 * an abandoned review all land here once DSH commits them. */
export function planModeNotice(event: SessionEvent): ModeUpdate | undefined {
  if (String(event.type) !== 'plan/mode') return undefined
  const active = (event.data as { active?: unknown } | null)?.active
  return typeof active === 'boolean' ? planModeUpdate(active) : undefined
}

/** The next-turn inbox as its durable splices leave it, and the batch its
 * latest claim took: the messages that woke the current turn. */
export interface TriggerFold { pending: string[]; claimed: Set<string> }
export const emptyTriggers = (): TriggerFold => ({ pending: [], claimed: new Set() })

/** DSH's own client titles for what woke a turn, by message source kind
 * (ui-chat `turn-trigger.ts`); an unlisted producer reads as a request. */
const TRIGGER_TITLES: Readonly<Record<string, string>> = {
  goal: 'Continuing goal', 'agent-message': 'Task message received', 'team-message': 'Team message received',
  'subagent-settled': 'Subtask status updated', webhook: 'External event received', schedule: 'Scheduled task',
  'tool-jobs': 'Background task updated', 'cordis-host-runner': 'Plugin status updated',
}
/** One display line: control and format characters (bidi overrides
 * included) and line breaks collapse to spaces; bounded by code points. */
const line = (text: string, limit: number): string => {
  const chars = [...text.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()]
  return chars.length > limit ? chars.slice(0, limit - 1).join('') + '…' : chars.join('')
}
/** DSH's bound for a `notice` summary (`CONTEXT_SUMMARY_MAX_CHARS`). */
const SUMMARY_CHARS = 120
/** A producer's one-line account of what happened: a message source of DSH's
 * `notice` context form carries it (`ContextFormed`); other forms have none. */
const noticeSummary = (source: { form?: unknown; summary?: unknown }): string =>
  source.form === 'notice' && typeof source.summary === 'string' ? line(source.summary, SUMMARY_CHARS) : ''

/**
 * A display-only note naming why a turn started when no human prompt did: a
 * reminder, a finished background job, a teammate's or subagent's message, a
 * goal round. Mirrors DSH's client: a non-user `user/message` is a turn
 * trigger when the latest next-turn inbox claim took it. Its line is DSH's
 * title for the source kind, then the producer's one-line `notice` summary or
 * the sender's name when the source carries one.
 */
export function triggerNotes(fold: TriggerFold, event: SessionEvent): string[] | undefined {
  if (String(event.type) === 'agent/inbox/spliced') {
    const splice = event.data as { target?: unknown; start?: unknown; removedCount?: unknown; inserted?: unknown; outcome?: unknown } | null
    if (splice?.target !== 'next-turn' || typeof splice.start !== 'number') return undefined
    const inserted = (Array.isArray(splice.inserted) ? splice.inserted : []).map(message => String((message as { id?: unknown } | null)?.id))
    const removed = fold.pending.splice(splice.start, typeof splice.removedCount === 'number' ? splice.removedCount : 0, ...inserted)
    if (removed.length > 0 && splice.outcome !== 'canceled') fold.claimed = new Set(removed)
    else for (const id of inserted) fold.claimed.delete(id)
    return undefined
  }
  if (event.type !== 'user/message') return undefined
  const source = event.data.source as { kind?: unknown; form?: unknown; summary?: unknown; senderName?: unknown; provider?: unknown }
  if (source.kind === 'user' || !fold.claimed.delete(String(event.data.id))) return undefined
  const title = source.kind === 'webhook' && source.provider === 'github' ? 'GitHub event received'
    : (typeof source.kind === 'string' ? TRIGGER_TITLES[source.kind] : undefined) ?? 'Execution requested'
  const summary = noticeSummary(source)
  const sender = typeof source.senderName === 'string' ? line(source.senderName, 60) : ''
  return [title + (summary !== '' ? ': ' + summary : sender !== '' ? ' from ' + sender : '')]
}

/** Context forms (DSH `ContextFormed.form`) whose content is standing state,
 * instructions or a catalog the model rereads, not something that happened:
 * the transcript leaves them out. */
const UNSHOWN_FORMS: ReadonlySet<string> = new Set(['snapshot', 'instructions', 'catalog'])
/** Longest line an opaque model-visible record shows. */
export const OPAQUE_NOTE_CHARS = 200

/** `[label] {compact JSON}` on one bounded line. */
function opaqueNote(label: string, value: unknown): string {
  let json: string | undefined
  try { json = JSON.stringify(value) } catch { json = undefined }
  return line('[' + label + '] ' + (json ?? ''), OPAQUE_NOTE_CHARS)
}

/** Message content as one line of text; a non-text block reads as its `[type]`. */
const contentText = (content: unknown): string => line((Array.isArray(content) ? content : []).map((block: { type?: unknown; text?: unknown } | null) =>
  block?.type === 'text' && typeof block.text === 'string' ? block.text : '[' + String(block?.type ?? 'block') + ']').join(' '), OPAQUE_NOTE_CHARS)

/**
 * The note for a model-visible event nothing else renders, keyed on the
 * producer's declared context form, never on its source kind. A user or
 * developer message from any producer but the user (appended, not a
 * replacement copy, which stays model-only): a `notice` shows its summary; a
 * `snapshot`, `instructions` or `catalog` shows nothing; a `relay`, a
 * `recall`, no form or an unknown one shows `[kind] {compact JSON}` of its
 * content and other source fields. An event a plugin projects onto existing
 * messages (`messageProjection`; `image/offload` has its own notice) shows
 * `[type] {compact JSON}` of its data. Lines are bounded to
 * {@link OPAQUE_NOTE_CHARS}. The caller leaves out a message whose turn
 * trigger note already names it.
 */
export function contextNotes(event: SessionEvent, messageProjection?: (type: string) => boolean): string[] | undefined {
  const type = String(event.type)
  if (type === 'user/message' || type === 'developer/message') {
    const surfaceOp = (event as { surfaceOp?: unknown }).surfaceOp
    if (surfaceOp !== undefined && surfaceOp !== 'append') return undefined
    const message = (type === 'user/message' ? event.data : (event.data as { message?: unknown } | null)?.message) as
      { source?: unknown; content?: unknown } | null | undefined
    const source = typeof message?.source === 'object' && message.source !== null ? message.source as Record<string, unknown> : undefined
    if (source === undefined || typeof source.kind !== 'string' || source.kind === 'user') return undefined
    if (typeof source.form === 'string' && UNSHOWN_FORMS.has(source.form)) return undefined
    const summary = noticeSummary(source)
    if (summary !== '') return [summary]
    const fields = Object.fromEntries(Object.entries(source).filter(([key]) => key !== 'kind'))
    return [opaqueNote(source.kind, { content: contentText(message!.content), ...fields })]
  }
  if (type === 'image/offload' || messageProjection?.(type) !== true) return undefined
  return [opaqueNote(type, event.data)]
}
