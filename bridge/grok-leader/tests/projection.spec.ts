/** Pure session-event projection: settlement, context, goals, usage and tool-result rendering. */
import { describe, expect, it } from 'vitest'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import * as GrokLeader from '../src/index.ts'
import { assistantEventUsage, contextInfoFromProjection, goalUpdateFromView, type NativeGoalView } from '../src/projection.ts'

describe('native assistant settlement projection', () => {
  it('renders native deliveries live and on replay in the viewed workspace, including nested tool declarations', () => {
    const event = { type: 'deliverables/presented', data: {
      turn: 1, callId: ToolCallId('nested-present'), files: [
        { path: 'report [final].md', description: '*ready*\nfor review' },
        { path: '/tmp/image.png' },
      ],
    } } as SessionEvent
    const project = (replay: boolean, cwd: string) => GrokLeader.sessionEventToUpdates(event, { replay, cwd })
    expect(project(false, '/parent')).toEqual(project(true, '/parent'))
    expect(project(true, '/child')).toEqual([{ sessionUpdate: 'agent_message_chunk', content: {
      type: 'text', text: '\n\n**Delivered files**\n- [report \\[final\\].md](<file:///child/report%20%5Bfinal%5D.md>): \\*ready\\* for review\n- [/tmp/image.png](<file:///tmp/image.png>)\n\n',
    } }])
    expect(project(true, '/parent')).not.toEqual(project(true, '/child'))
  })

  it('preserves interrupted reasoning and whitespace from the embedded stream, not only safe message blocks', () => {
    const event = { type: 'assistant/message', data: {
      turn: 0, step: 0, interrupted: true,
      stream: [
        { type: 'reasoning-chunks', time0: 10, index: 0, dt: [1], texts: ['thinking', ' '] },
        { type: 'text-chunks', time0: 12, index: 1, dt: [], texts: ['  '] },
      ],
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'thinking ' }] },
    } } as never
    expect(GrokLeader.sessionEventToUpdates(event, { replay: true })).toEqual([
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'thinking' } },
      { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' ' } },
      { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '  ' } },
    ])
  })

  it('uses explicit message usage before the last embedded sample and never sums samples', () => {
    const latest = { inputTokens: 10, outputTokens: 2, cacheReadTokens: 7, cacheWriteTokens: 3 }
    const data = { turn: 0, step: 0, stream: [
      { type: 'chunk', time: 1, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: latest } },
    ] }
    expect(assistantEventUsage({ type: 'assistant/attempt', data } as never)).toEqual(latest)
    expect(assistantEventUsage({ type: 'assistant/message', data: { ...data, usage: { inputTokens: 20, outputTokens: 4 } } } as never)).toEqual({ inputTokens: 20, outputTokens: 4 })
  })
})

describe('truthful current context projection', () => {
  it('keeps unknown distinct from known zero without invented capacity or threshold', () => {
    expect(contextInfoFromProjection({})).toEqual({ available: false, capacityAvailable: false, breakdownAvailable: false, autoCompactThresholdAvailable: false })
    expect(contextInfoFromProjection({ contextPressure: { projectedTokens: 0, contextWindow: 200 } })).toMatchObject({ available: true, capacityAvailable: true, used: 0, total: 200, freeTokens: 200, usagePct: 0 })
  })
  it('uses current projected occupancy rather than cumulative spend and labels heuristic composition', () => {
    expect(contextInfoFromProjection({ tokenUsage: { uncachedInputTokens: 9000, outputTokens: 2000, cacheReadTokens: 500, cacheWriteTokens: 0 }, contextPressure: { projectedTokens: 120, contextWindow: 1000 }, contextBreakdown: { systemTokens: 20, toolsTokens: 30, messageTokens: 40 } })).toEqual({ available: true, capacityAvailable: true, breakdownAvailable: true, autoCompactThresholdAvailable: false, used: 120, total: 1000, freeTokens: 880, usagePct: 12, breakdownApproximate: true, systemPromptTokens: 20, toolDefinitionsTokens: 30, messageTokens: 40 })
  })
})

describe('native goal projection', () => {
  it('preserves durable phase, activation, reason and real round counts without invented metrics', () => {
    const goal: NativeGoalView = { id: 'goal', revision: 4, objective: 'finish', phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 7 }
    expect(goalUpdateFromView(goal)).toEqual({ sessionUpdate: 'goal_updated', goal_id: 'goal', objective: 'finish', status: 'disarmed', phase: 'idle', native_goal: { revision: 4, phase: 'active', activation: 'disarmed', rounds_started: 2, max_goal_rounds: 7 } })
    expect(goalUpdateFromView({ ...goal, activation: 'armed' })).toMatchObject({ status: 'armed' })
    expect(goalUpdateFromView({ ...goal, phase: 'blocked', blockedReason: { code: 'round-limit', message: 'limit' } })).toMatchObject({ status: 'blocked', native_goal: { reason: { code: 'round-limit', message: 'limit' } } })
  })
})

describe('cacheHitPercent', () => {
  it('shows only a true full hit as 100 and preserves near-full precision', () => {
    expect(GrokLeader.cacheHitPercent(0, 0, 0)).toBeUndefined()
    expect(GrokLeader.cacheHitPercent(0, 1000, 0)).toBe('100')
    expect(GrokLeader.cacheHitPercent(1, 1, 0)).toBe('50')
    expect(GrokLeader.cacheHitPercent(5, 995, 0)).toBe('99.5')
    expect(GrokLeader.cacheHitPercent(1, 999, 0)).toBe('99.9')
    expect(GrokLeader.cacheHitPercent(1, 9999, 0)).toBe('99.99')
  })
})

describe('decodeTokensPerSecond', () => {
  it('is silent before a timed step and formats by the upstream client rule', () => {
    const speed = GrokLeader.emptyDecodeSpeed()
    expect(GrokLeader.decodeTokensPerSecond(speed)).toBeUndefined()
    speed.decodeMs = 12_000
    speed.decodeTokens = 100
    expect(GrokLeader.decodeTokensPerSecond(speed)).toBe('8.3')
    speed.decodeTokens = 240
    expect(GrokLeader.decodeTokensPerSecond(speed)).toBe('20')
  })
})

describe('sessionEventToUpdates tool-result diff fallback', () => {
  const toolResult = (opts: { text?: string; meta?: unknown; error?: { name: string; code: string } } = {}) => ({
    type: 'tool/result',
    data: {
      message: { role: 'tool', toolCallId: 'call-1', content: opts.text === undefined ? [] : [{ type: 'text', text: opts.text }] },
      ...opts.meta === undefined ? {} : { meta: opts.meta },
      ...opts.error === undefined ? {} : { error: opts.error },
    },
  }) as never

  const map = (event: never, call?: { name: string; arguments: unknown }) =>
    GrokLeader.sessionEventToUpdates(event, { replay: false, toolCall: () => call })

  const diffs = (updates: GrokLeader.GrokSessionUpdate[]): unknown[] =>
    ((updates[0] as { content?: Array<{ type: string }> }).content ?? []).filter(block => block.type === 'diff')

  it('synthesizes a diff block from the recorded Edit call when meta has none', () => {
    const updates = map(toolResult({ text: 'ok' }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'let x = 1', new_string: 'let x = 2' },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'let x = 1', newText: 'let x = 2' }])
  })

  it('prefers presentation-meta diffs over the call-argument fallback', () => {
    const updates = map(
      toolResult({ meta: { diffs: [{ path: '/tmp/a.ts', oldText: 'meta old', newText: 'meta new' }] } }),
      { name: 'edit', arguments: { file_path: '/tmp/a.ts', old_string: 'arg old', new_string: 'arg new' } },
    )
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'meta old', newText: 'meta new' }])
  })

  it('wraps text blocks in ACP content so the tool_call_update frame parses', () => {
    // ACP ToolCallContent is tagged `content`/`diff`/`terminal`; a bare
    // `{"type":"text"}` block fails serde and drops the whole update in the
    // TUI (verified against agent-client-protocol 0.10.4).
    const updates = map(toolResult({ text: 'ok' }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' },
    })
    expect((updates[0] as { content?: unknown[] }).content).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok' } },
      { type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' },
    ])
  })

  it('emits no fallback diff when the tool errored', () => {
    const updates = map(toolResult({ error: { name: 'EditError', code: 'not_found' } }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' },
    })
    // ACP accepts failed, not error; the latter drops the whole result frame.
    expect((updates[0] as { status: string }).status).toBe('failed')
    expect(diffs(updates)).toEqual([])
  })

  it('renders Write as a new-file diff (no oldText) and keeps deletions (empty new_string)', () => {
    const write = map(toolResult({}), { name: 'Write', arguments: { file_path: '/tmp/new.md', content: 'hello' } })
    expect(diffs(write)).toEqual([{ type: 'diff', path: '/tmp/new.md', newText: 'hello' }])
    const deletion = map(toolResult({}), { name: 'edit', arguments: { file_path: '/tmp/a.ts', old_string: 'gone', new_string: '' } })
    expect(diffs(deletion)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'gone', newText: '' }])
  })

  it('covers str_replace_editor create via file_text', () => {
    const updates = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'create', path: '/tmp/new.py', file_text: 'print(1)' },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/new.py', newText: 'print(1)' }])
  })

  it('covers str_replace_editor replace, deletion, and insert fallback diffs', () => {
    const replace = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path: '/tmp/a.ts', old_str: 'let x = 1', new_str: 'let x = 2' },
    })
    expect(diffs(replace)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'let x = 1', newText: 'let x = 2' }])

    const deletion = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path: '/tmp/a.ts', old_str: 'gone' },
    })
    expect(diffs(deletion)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'gone', newText: '' }])

    const insert = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'insert', path: '/tmp/a.ts', insert_line: 1, new_str: 'added' },
    })
    expect(diffs(insert)).toEqual([{ type: 'diff', path: '/tmp/a.ts', newText: 'added' }])

    const view = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'view', path: '/tmp/a.ts' },
    })
    expect(diffs(view)).toEqual([])
  })

  it('skips fallback diffs that would exceed the display-only performance budget', () => {
    const huge = 'x'.repeat(64 * 1024 + 1)
    expect(diffs(map(toolResult({}), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'small', new_string: huge },
    }))).toEqual([])
    expect(diffs(map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'create', path: '/tmp/new.py', file_text: huge },
    }))).toEqual([])
    expect(diffs(map(toolResult({}), {
      name: 'write',
      arguments: { file_path: '/tmp/new.md', content: huge },
    }))).toEqual([])
  })

  it('skips oversized presentation-meta diffs as a defensive performance guard', () => {
    const huge = 'y'.repeat(64 * 1024 + 1)
    expect(diffs(map(toolResult({ meta: { diffs: [{ path: '/tmp/a.ts', oldText: 'small', newText: huge }] } }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'small', new_string: huge },
    }))).toEqual([])
  })

  it('keeps fallback diffs within the performance budget', () => {
    const ok = 'z'.repeat(64 * 1024 - 1)
    const updates = map(toolResult({}), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: ok },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: ok }])
  })

  it('yields no diff for non-edit tools, incomplete args, or unknown calls', () => {
    expect(diffs(map(toolResult({ text: 'ran' }), { name: 'bash', arguments: { command: 'ls' } }))).toEqual([])
    expect(diffs(map(toolResult({}), { name: 'edit', arguments: { file_path: '/tmp/a.ts' } }))).toEqual([])
    expect(diffs(map(toolResult({}), { name: 'edit', arguments: { old_string: 'a', new_string: 'b' } }))).toEqual([])
    expect(diffs(map(toolResult({})))).toEqual([])
  })
})
