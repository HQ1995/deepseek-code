/**
 * Turn lifecycle facts the TUI already renders from its xAI session updates:
 * model-request retries, typed turn failures and tool calls the model is still
 * writing. Pure mapping of native events and stream chunks; the owning session
 * output decides when to send them.
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
export type XaiNotice = { sessionUpdate: 'image_dropped'; notes: string[] } | RetryStateUpdate | ToolCallWriting

const XAI_NOTICES: ReadonlySet<string> = new Set<XaiNotice['sessionUpdate']>(['image_dropped', 'retry_state', 'tool_call_delta_chunk'])
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
 * TUI clears it at the retried attempt's first streamed update, a later
 * failure or the turn's end. A failed turn's typed failure is part of its
 * history, so it is sent on replay too.
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
