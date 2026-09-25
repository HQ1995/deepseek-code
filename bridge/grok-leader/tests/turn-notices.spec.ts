import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { describeFailure, isXaiNotice, toolCallWriting, turnFailure, turnNotices, WRITING_REFRESH_MS, type WritingCalls } from '../src/turn-notices.ts'
import { event } from './support/session-events.ts'

const retry = (data: Record<string, unknown>) => event('llm/retry', {
  retryId: 'r1', turn: 1, step: 1, provider: 'deepseek', policyKey: 'normal', delayMs: 500, ...data,
})
const turnEnd = (error: unknown) => event('turn/end', { turn: 1, reason: { kind: 'error', error } })

describe('turn notices', () => {
  it('shows a scheduled model retry as a live retrying state, never on replay', () => {
    const scheduled = retry({ mode: 'normal', retry: 2, maxRetries: 5, failure: { message: 'upstream busy', code: 'SERVER', status: 503 } })
    expect(turnNotices(scheduled, false)).toEqual([{ sessionUpdate: 'retry_state', type: 'retrying',
      attempt: 2, max_retries: 5, reason: 'upstream busy (status 503, SERVER)' }])
    expect(turnNotices(scheduled, true)).toEqual([])
    // Unbounded policy: no maximum to show.
    expect(turnNotices(retry({ mode: 'always', retry: 7, failure: { message: 'reset', code: 'TRANSPORT' } }), false))
      .toMatchObject([{ attempt: 7, max_retries: 0, reason: 'reset (TRANSPORT)' }])
    expect(turnNotices(event('llm/retry-started', { retryId: 'r1', turn: 1, step: 1, retry: 2 }), false)).toEqual([])
    // The flag behind xAI's rate-limit upsell is never part of the state.
    expect(JSON.stringify(turnNotices(retry({ mode: 'normal', retry: 1, maxRetries: 5, failure: { message: 'slow down', code: 'RATE_LIMIT', status: 429 } }), false)))
      .not.toContain('rate_limited')
  })

  it('types a failed turn by its native code or HTTP status, live and on replay', () => {
    const failed = (error: unknown) => turnNotices(turnEnd(error), true)[0]
    expect(failed({ message: 'upstream busy', code: 'SERVER', status: 503, requestId: 'req-7' }))
      .toEqual({ sessionUpdate: 'retry_state', type: 'failed', error_type: 'api', message: 'upstream busy (status 503, SERVER, request req-7)' })
    expect(failed({ message: 'too long', code: 'CONTEXT_WINDOW_EXCEEDED', status: 400 })).toMatchObject({ error_type: 'context_length' })
    expect(failed({ message: 'slow down', code: 'RATE_LIMIT', status: 429 })).toMatchObject({ error_type: 'rate_limited' })
    expect(failed({ message: 'stalled', code: 'TIMEOUT' })).toMatchObject({ error_type: 'idle_timeout' })
    expect(failed({ message: 'socket hang up', code: 'TRANSPORT' })).toMatchObject({ error_type: 'http' })
    expect(failed({ message: 'nothing', code: 'EMPTY_RESPONSE' })).toMatchObject({ error_type: 'empty_response' })
    expect(failed({ message: 'plugin threw', code: 'UNKNOWN' })).toEqual({ sessionUpdate: 'retry_state', type: 'failed', error_type: 'other', message: 'plugin threw' })
    expect(turnNotices(event('turn/end', { turn: 1, reason: { kind: 'completed' } }), false)).toEqual([])
  })

  it('leaves credential failures to the prompt refusal naming dscode\'s fix', () => {
    expect(turnFailure({ message: 'no API key for provider route "deepseek"', code: 'MISSING_CREDENTIAL' })).toBeUndefined()
    expect(turnFailure({ message: 'malformed', code: 'INVALID_CREDENTIAL' })).toBeUndefined()
    expect(turnFailure({ code: 'SERVER' })).toBeUndefined()
  })

  it('never spells a failure as xAI\'s credit-limit upsell or /login prompt', () => {
    const quota = turnFailure({ message: 'API error (status 402): Insufficient Balance', code: 'QUOTA', status: 402 })!
    expect(quota).toMatchObject({ error_type: 'other' })
    expect(quota.type === 'failed' && quota.message).toBe('API error (HTTP 402): Insufficient Balance (HTTP 402, QUOTA)')
    expect(describeFailure({ message: 'Payment Required (402) and Unauthorized (401)' }))
      .toBe('Payment Required, HTTP 402 and Unauthorized, HTTP 401')
  })

  it('forwards a tool call being written by name and position, throttled per call', () => {
    const calls: WritingCalls = new Map()
    const delta = (index: number, name?: string) => ({ type: 'tool-call-delta', index, id: 'call-' + index, argumentsDelta: '{"pa', ...name === undefined ? {} : { name } }) as StreamChunk
    expect(toolCallWriting(calls, delta(1), 0)).toEqual({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 1 })
    expect(toolCallWriting(calls, delta(1, 'write'), 10)).toEqual({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 1, name: 'write' })
    expect(toolCallWriting(calls, delta(1), 20)).toBeUndefined()
    expect(toolCallWriting(calls, delta(1, 'write'), 30)).toBeUndefined()
    expect(toolCallWriting(calls, delta(3, 'bash'), 40)).toEqual({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 3, name: 'bash' })
    // A long write keeps refreshing well inside the TUI's 10 s staleness cutoff.
    expect(toolCallWriting(calls, delta(1), 10 + WRITING_REFRESH_MS)).toEqual({ sessionUpdate: 'tool_call_delta_chunk', tool_index: 1 })
    expect(WRITING_REFRESH_MS).toBeLessThan(10_000)
    expect(toolCallWriting(calls, { type: 'text-delta', index: 0, text: 'x' }, 50)).toBeUndefined()
    expect(isXaiNotice({ sessionUpdate: 'tool_call_delta_chunk' })).toBe(true)
  })

  it('routes only xAI session updates to the xAI notification', () => {
    expect(isXaiNotice({ sessionUpdate: 'retry_state' })).toBe(true)
    expect(isXaiNotice({ sessionUpdate: 'image_dropped' })).toBe(true)
    expect(isXaiNotice({ sessionUpdate: 'agent_message_chunk' })).toBe(false)
  })
})
