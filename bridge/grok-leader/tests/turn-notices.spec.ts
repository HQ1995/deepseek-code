import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { compactionNotices, contextNotes, describeFailure, emptyTriggers, isXaiNotice, OPAQUE_NOTE_CHARS, toolCallWriting, triggerNotes, turnFailure, turnNotices, WRITING_REFRESH_MS, type CompactionFold, type WritingCalls } from '../src/turn-notices.ts'
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

  it('shows an automatic compaction from its markers, estimating the result on replay', () => {
    const marker = (type: string, time: number, data: Record<string, unknown> = {}) => event('compaction/' + type, { compactionId: 'c1', turn: 3, ...data }, 0, time)
    const summary = marker('summary', 1500, { shadowedTokenCount: 20000, usage: { inputTokens: 21000, outputTokens: 900 },
      summary: [{ type: 'text', text: '## Summary\n' + 'x'.repeat(200) }] })
    const live: CompactionFold = new Map()
    let context = { used: 26000, window: 32000, native: true }
    expect(compactionNotices(live, marker('start', 1000), false, () => context)).toEqual([{ sessionUpdate: 'auto_compact_started',
      tokens_used: 26000, context_window: 32000, percentage: 81, reason: 'context pressure' }])
    expect(compactionNotices(live, summary, false, () => context)).toEqual([])
    context = { used: 7000, window: 32000, native: true }
    const [completed] = compactionNotices(live, marker('end', 4200), false, () => context)
    expect(completed).toMatchObject({ sessionUpdate: 'auto_compact_completed', tokens_before: 26000, tokens_after: 7000, elapsed_ms: 3200 })
    expect(completed).toHaveProperty('summary_preview', expect.stringMatching(/^## Summary x+…$/))
    expect((completed as { summary_preview: string }).summary_preview).toHaveLength(100)
    expect(live.size).toBe(0)

    const replayed: CompactionFold = new Map()
    const durable = () => ({ used: 26000 })
    expect(compactionNotices(replayed, marker('start', 1000), true, durable)).toEqual([])
    compactionNotices(replayed, summary, true, durable)
    expect(compactionNotices(replayed, marker('end', 4200), true, durable)).toMatchObject([{ tokens_before: 26000, tokens_after: 6900 }])
    // Live without the native projection: the stale reported prompt is no result; estimate it.
    const stale: CompactionFold = new Map()
    compactionNotices(stale, marker('start', 1000), false, durable)
    compactionNotices(stale, summary, false, durable)
    expect(compactionNotices(stale, marker('end', 1200), false, durable)).toMatchObject([{ tokens_before: 26000, tokens_after: 6900 }])
  })

  it('leaves /compact to the command flow and reports a failed automatic compaction', () => {
    const fold: CompactionFold = new Map()
    const context = () => ({ used: 10, window: 100 })
    expect(compactionNotices(fold, event('compaction/start', { compactionId: 'm', sourceCommandId: 'cmd', turn: null }), false, context)).toEqual([])
    expect(compactionNotices(fold, event('compaction/end', { compactionId: 'm', sourceCommandId: 'cmd', turn: null }), false, context)).toEqual([])
    compactionNotices(fold, event('compaction/start', { compactionId: 'a', turn: 1 }), false, context)
    expect(compactionNotices(fold, event('compaction/end', { compactionId: 'a', turn: 1, error: 'summary failed: 500' }), false, context))
      .toEqual([{ sessionUpdate: 'auto_compact_failed', error: 'summary failed: 500' }])
    // No capacity: no percentage to show, but the completion is still reported.
    compactionNotices(fold, event('compaction/start', { compactionId: 'b', turn: 1 }, 0, 5), false, () => ({ used: 10 }))
    expect(compactionNotices(fold, event('compaction/end', { compactionId: 'b', turn: 1 }, 0, 9), false, () => ({ used: 4, native: true })))
      .toEqual([{ sessionUpdate: 'auto_compact_completed', tokens_before: 10, tokens_after: 4, elapsed_ms: 4 }])
    expect(isXaiNotice({ sessionUpdate: 'auto_compact_completed' })).toBe(true)
  })

  it('names what woke a turn only for the message the next-turn claim took', () => {
    const fold = emptyTriggers()
    const splice = (target: string, start: number, removedCount: number, inserted: string[], outcome?: string) => triggerNotes(fold,
      event('agent/inbox/spliced', { target, start, ...removedCount === 0 ? {} : { removedCount }, inserted: inserted.map(id => ({ id })), ...outcome === undefined ? {} : { outcome } }))
    const message = (id: string, source: Record<string, unknown>) => triggerNotes(fold, event('user/message', { id, source, content: [{ type: 'text', text: 'framed' }] }))
    const job = { kind: 'tool-jobs', form: 'notice', summary: 'bash sleep 1 completed\n(exit 0)' }
    expect(splice('next-turn', 0, 0, ['job', 'dropped', 'human'])).toBeUndefined()
    // Removing a queued message cancels it; it wakes nothing.
    splice('next-turn', 1, 1, [], 'canceled')
    splice('next-step', 0, 0, ['steer'])
    splice('next-turn', 0, 1, [])
    expect(message('job', job)).toEqual(['Background task updated: bash sleep 1 completed (exit 0)'])
    expect(message('job', job)).toBeUndefined()
    // Injected context in a running turn is not a trigger.
    expect(message('steer', { kind: 'time-context' })).toBeUndefined()
    splice('next-turn', 0, 1, [])
    expect(message('human', { kind: 'user' })).toBeUndefined()
    const woke = (source: Record<string, unknown>) => { splice('next-turn', 0, 0, ['m']); splice('next-turn', 0, 1, []); return message('m', source) }
    expect(woke({ kind: 'schedule' })).toEqual(['Scheduled task'])
    expect(woke({ kind: 'team-message', senderName: 'alice\u202e' })).toEqual(['Team message received from alice'])
    expect(woke({ kind: 'subagent-settled', form: 'notice', summary: 'reviewer finished', senderSessionId: 's' })).toEqual(['Subtask status updated: reviewer finished'])
    expect(woke({ kind: 'goal', goalId: 'g', revision: 1, round: 2 })).toEqual(['Continuing goal'])
    expect(woke({ kind: 'webhook', provider: 'github', form: 'notice', summary: 'push to main' })).toEqual(['GitHub event received: push to main'])
    expect(woke({ kind: 'someone-elses-plugin' })).toEqual(['Execution requested'])
  })

  it('notes model-visible context by its declared form, never by its producer', () => {
    const user = (source: Record<string, unknown>, content: unknown[] = [{ type: 'text', text: 'body' }], surfaceOp?: unknown) =>
      contextNotes({ ...event('user/message', { id: 'm', source, content }), ...surfaceOp === undefined ? {} : { surfaceOp } } as SessionEvent)
    // A notice shows its one-line account, whoever produced it.
    expect(user({ kind: 'repeat-tool-reminder', form: 'notice', summary: 'bash × 3' })).toEqual(['bash × 3'])
    expect(user({ kind: 'plan-mode', form: 'notice', summary: 'The user switched\nthis session to plan mode.' })).toEqual(['The user switched this session to plan mode.'])
    expect(user({ kind: 'hooks-claude-code' }, [{ type: 'text', text: 'line one\n\nline two' }])).toEqual(['[hooks-claude-code] {"content":"line one line two"}'])
    // Standing state, instructions and catalogs stay off the transcript.
    for (const form of ['snapshot', 'instructions', 'catalog']) expect(user({ kind: 'time-context', form, sections: [] })).toBeUndefined()
    // A relay, a recall, no form or an unknown one is an opaque record: its kind, then its content and other fields.
    expect(user({ kind: 'agent-message', form: 'relay', senderSessionId: 'child' }, [{ type: 'text', text: 'Agent child sent a message: ' }, { type: 'text', text: 'done' }]))
      .toEqual(['[agent-message] {"content":"Agent child sent a message: done","form":"relay","senderSessionId":"child"}'])
    expect(user({ kind: 'session-reference', form: 'recall' }, [{ type: 'image' }])).toEqual(['[session-reference] {"content":"[image]","form":"recall"}'])
    expect(user({ kind: 'user-approval' })).toEqual(['[user-approval] {"content":"body"}'])
    expect(user({ kind: 'someone-elses-plugin', form: 'hologram' })).toEqual(['[someone-elses-plugin] {"content":"body","form":"hologram"}'])
    const long = user({ kind: 'ptc-mode' }, [{ type: 'text', text: 'x'.repeat(500) }])![0]!
    expect([...long]).toHaveLength(OPAQUE_NOTE_CHARS)
    expect(long.endsWith('…')).toBe(true)
    // A notice without its summary is opaque too; control characters never reach the line.
    expect(user({ kind: 'tool-jobs', form: 'notice' }, [{ type: 'text', text: 'a\u202eb' }])).toEqual(['[tool-jobs] {"content":"a b","form":"notice"}'])
    // The user's own words render as the prompt; a replacement copy stays model-only.
    expect(user({ kind: 'user' })).toBeUndefined()
    expect(user({ kind: 'compaction-checkpoint' }, undefined, { op: 'replace', startSeq: 1, endSeq: 4 })).toBeUndefined()
    expect(user({ kind: 'ptc-mode' }, undefined, 'append')).toEqual(['[ptc-mode] {"content":"body"}'])
    expect(user({ form: 'notice', summary: 'no kind' })).toBeUndefined()
    // Developer messages read the same way.
    expect(contextNotes(event('developer/message', { turn: 1, step: 1, message: { role: 'developer', source: { kind: 'lint' }, content: [{ type: 'text', text: 'fix it' }] } })))
      .toEqual(['[lint] {"content":"fix it"}'])
    // A plugin's message projection is an opaque record of its decision; image offload has its own notice.
    const projected = (type: string) => contextNotes(event(type, { targets: [{ seq: 3 }] }), name => name === type)
    expect(projected('redact/apply')).toEqual(['[redact/apply] {"targets":[{"seq":3}]}'])
    expect(projected('image/offload')).toBeUndefined()
    expect(contextNotes(event('redact/apply', {}))).toBeUndefined()
    expect(contextNotes(event('turn/start', { turn: 1 }), () => false)).toBeUndefined()
  })

  it('routes only xAI session updates to the xAI notification', () => {
    expect(isXaiNotice({ sessionUpdate: 'retry_state' })).toBe(true)
    expect(isXaiNotice({ sessionUpdate: 'image_dropped' })).toBe(true)
    expect(isXaiNotice({ sessionUpdate: 'agent_message_chunk' })).toBe(false)
  })
})
