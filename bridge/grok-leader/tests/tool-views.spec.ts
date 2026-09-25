/** Tool views: DSH presenters normalized for the TUI, and their projection. */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { sessionEventToUpdates, type ProjectedUpdate } from '../src/projection.ts'
import { createSessionOutput } from '../src/session-output.ts'
import { callView, resultView, viewKind, type ToolPresenter, type ToolPresenters } from '../src/tool-views.ts'

const presenting = (tools: Record<string, ToolPresenters>): ToolPresenter => name => tools[name]
const call = (id: string, name: string, args: unknown, seq = 0) =>
  ({ type: 'tool/call', seq, time: 1000 + seq, data: { turn: 1, step: 1, callId: id, name, arguments: JSON.stringify(args) } }) as unknown as SessionEvent
const result = (id: string, text: string, meta?: unknown, seq = 1, isError = false) => ({ type: 'tool/result', seq, time: 1000 + seq,
  data: { ...meta === undefined ? {} : { meta }, message: { role: 'tool', toolCallId: id, content: [{ type: 'text', text }], ...isError ? { isError } : {} } } }) as unknown as SessionEvent

describe('tool view normalization', () => {
  it('keeps a generic view\'s known fields, text content and locations, and caps its raw input', () => {
    const tool = presenting({ lookup: { presentCall: () => ({
      card: 'generic', title: 'Look up T-1', kind: 'search', rawInput: 'T-1', extra: 'dropped',
      content: [{ type: 'text', text: 'why' }, { type: 'image', attachment: { attachmentId: 'a1' } }, { type: 'text', text: '' }],
      locations: [{ path: 'src/a.ts', line: 3, column: 9 }],
    }) } })
    expect(callView(tool, 'lookup', {})).toEqual({ card: 'generic', title: 'Look up T-1', kind: 'search', rawInput: 'T-1',
      content: [{ type: 'text', text: 'why' }, { type: 'text', text: '[image attachment a1]' }], locations: [{ path: 'src/a.ts', line: 3 }] })
    // An unknown kind is dropped, not invented; the title is required.
    expect(callView(presenting({ t: { presentCall: () => ({ card: 'generic', title: 'T', kind: 'think' }) } }), 't', {})).toEqual({ card: 'generic', title: 'T' })
    expect(callView(presenting({ t: { presentCall: () => ({ card: 'generic', kind: 'read' }) } }), 't', {})).toBeUndefined()
    const long = { notes: 'x'.repeat(9000) }
    const capped = callView(presenting({ t: { presentCall: () => ({ card: 'generic', title: 'T', rawInput: long }) } }), 't', {}) as { rawInput: string }
    expect(typeof capped.rawInput).toBe('string')
    expect(capped.rawInput).toHaveLength(8 * 1024 + 1)
    expect(capped.rawInput.startsWith('{\n  "notes": "xxx')).toBe(true)
    expect(capped.rawInput.endsWith('…')).toBe(true)
  })

  it('resolves a relative terminal cwd against the session cwd and keeps an absolute one', () => {
    const tool = (cwd?: string) => presenting({ bash: { presentCall: () => ({ card: 'terminal', title: 'npm test', description: 'Run tests', ...cwd === undefined ? {} : { cwd } }) } })
    expect(callView(tool('pkg'), 'bash', {}, '/work')).toEqual({ card: 'terminal', title: 'npm test', description: 'Run tests', cwd: '/work/pkg' })
    expect(callView(tool('/abs'), 'bash', {}, '/work')).toMatchObject({ cwd: '/abs' })
    expect(callView(tool('pkg'), 'bash', {})).toMatchObject({ cwd: 'pkg' })
    // Omitted means the session workspace; the bridge adds nothing.
    expect(callView(tool(), 'bash', {}, '/work')).toEqual({ card: 'terminal', title: 'npm test', description: 'Run tests' })
  })

  it('drops a diff view beyond the fallback-diff budget and keeps null before-images', () => {
    const diff = (newText: string) => presenting({ write: {
      presentCall: () => ({ card: 'diff', title: 'Write a', diffs: [{ path: 'a', oldText: null, newText }] }),
      presentResult: () => ({ card: 'diff', diffs: [{ path: 'a', newText }] }),
    } })
    expect(callView(diff('new'), 'write', {})).toEqual({ card: 'diff', title: 'Write a', diffs: [{ path: 'a', oldText: null, newText: 'new' }] })
    expect(resultView(diff('new'), 'write', {}, { content: [], isError: false })).toEqual({ card: 'diff', diffs: [{ path: 'a', oldText: null, newText: 'new' }] })
    expect(callView(diff('x'.repeat(64 * 1024 + 1)), 'write', {})).toBeUndefined()
    expect(resultView(diff('x'.repeat(64 * 1024 + 1)), 'write', {}, { content: [], isError: false })).toBeUndefined()
  })

  it('passes each result card through checked and rejects malformed ones', () => {
    const view = (value: unknown) => resultView(presenting({ t: { presentResult: () => value } }), 't', {}, { content: [], isError: false })
    const valid = [
      { card: 'terminal', output: 'ok', exitCode: 0 },
      { card: 'terminal', title: 'killed', signal: 'SIGTERM' },
      { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 2, line: 'foo' }] }], truncated: false, total: 1 },
      { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: true, total: 9 },
      { card: 'read', path: '/w/a.ts', offset: 1, lines: [{ number: 1, text: 'a' }], totalLines: 1, lang: 'ts' },
      { card: 'web', kind: 'search', title: 'q', sources: [{ url: 'https://a.test', title: 'A' }], answer: 'yes', truncated: false },
      { card: 'web', kind: 'fetch', url: 'https://a.test', statusCode: 200, truncated: false },
      { card: 'generic', title: 'Plan review' },
    ]
    for (const value of valid) expect(view(value)).toEqual(value)
    expect(view({ card: 'read', path: 'a', offset: 1, lines: [], totalLines: 0, content: [{ type: 'text', text: 'body' }] }))
      .toMatchObject({ content: [{ type: 'text', text: 'body' }] })
    for (const value of [
      { card: 'terminal', exitCode: 1.5 }, { card: 'search', shape: 'lines', paths: [], truncated: false, total: 0 },
      { card: 'search', shape: 'paths', paths: [1], truncated: false, total: 1 }, { card: 'read', path: 'a', offset: 1, lines: [{ number: 'one' }], totalLines: 1 },
      { card: 'web', kind: 'fetch', url: 'u', statusCode: '200', truncated: false }, { card: 'web', kind: 'crawl' },
      { card: 'chart' }, 'text', null, Promise.resolve({ card: 'generic' }),
    ]) expect(view(value)).toBeUndefined()
  })

  it('treats a missing tool, a missing presenter or a throwing one as no view', () => {
    const throwing = presenting({ t: { presentCall: () => { throw new Error('schema drift') }, presentResult: () => { throw new Error('bad meta') } } })
    expect(callView(throwing, 't', {})).toBeUndefined()
    expect(resultView(throwing, 't', {}, { content: [], isError: true })).toBeUndefined()
    expect(callView(presenting({ t: {} }), 't', {})).toBeUndefined()
    expect(callView(presenting({}), 't', {})).toBeUndefined()
    expect(callView(undefined, 't', {})).toBeUndefined()
    expect(callView(() => { throw new Error('registry gone') }, 't', {})).toBeUndefined()
  })

  it('derives the ACP kind a call view implies', () => {
    expect(viewKind({ card: 'terminal', title: 'ls' })).toBe('execute')
    expect(viewKind({ card: 'diff', title: 'Edit a', diffs: [] })).toBe('edit')
    expect(viewKind({ card: 'generic', title: 'Read a', kind: 'read' })).toBe('read')
    expect(viewKind({ card: 'generic', title: 'Close', kind: 'delete' })).toBe('delete')
    expect(viewKind({ card: 'generic', title: 'Todo' })).toBe('other')
  })
})

describe('tool view projection', () => {
  const bash: ToolPresenters = {
    presentCall: args => ({ card: 'terminal', title: (args as { command: string }).command, cwd: 'pkg' }),
    presentResult: (_args, outcome) => outcome.isError
      ? { card: 'generic', content: [{ type: 'text', text: '```console\nboom\n```' }] }
      : { card: 'terminal', output: 'hi', exitCode: 0 },
  }

  it('sends the call view and the result view, and lets the views replace the name tables', () => {
    const presenter = presenting({ bash })
    const [started] = sessionEventToUpdates(call('b1', 'bash', { command: 'echo hi' }), { replay: false, cwd: '/w', presenter })
    expect(started).toEqual({ sessionUpdate: 'tool_call', toolCallId: 'b1', title: 'echo hi', kind: 'execute', status: 'in_progress', rawInput: { command: 'echo hi' },
      _meta: { 'x.ai/tool': { name: 'bash' }, 'dscode/view': { card: 'terminal', title: 'echo hi', cwd: '/w/pkg' } } })
    const prior = () => ({ name: 'bash', arguments: { command: 'echo hi' } })
    const [settled] = sessionEventToUpdates(result('b1', 'hi'), { replay: false, toolCall: prior, presenter })
    // No Bash-shaped byte array: the terminal view carries the exit status.
    expect(settled).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'b1', status: 'completed', content: [{ type: 'content', content: { type: 'text', text: 'hi' } }],
      _meta: { 'dscode/view': { card: 'terminal', output: 'hi', exitCode: 0 } } })
    const [failed] = sessionEventToUpdates(result('b1', 'boom', undefined, 1, true), { replay: false, toolCall: prior, presenter })
    expect(failed).toMatchObject({ status: 'failed', _meta: { 'dscode/view': { card: 'generic', content: [{ type: 'text', text: '```console\nboom\n```' }] } } })
    expect(failed).not.toHaveProperty('rawOutput')
    // Without the presenter the name tables rebuild the Bash shape, as before.
    expect(sessionEventToUpdates(result('b1', 'hi'), { replay: false, toolCall: prior })[0]).toMatchObject({ rawOutput: { type: 'Bash', exit_code: 0 } })
  })

  it('takes the kind from the view, keeps argument-shape titles and sends the view\'s diffs as ACP content', () => {
    const presenter = presenting({
      terminal_close: { presentCall: () => ({ card: 'generic', title: 'Close terminal t1', kind: 'delete' }) },
      exit_plan_mode: { presentCall: () => ({ card: 'generic', title: 'Ship it', kind: 'other' }) },
      web_search: { presentCall: () => ({ card: 'generic', title: 'rust', kind: 'search', rawInput: 'rust' }) },
      write: {
        presentCall: () => ({ card: 'diff', title: 'Write a', diffs: [{ path: 'a', oldText: null, newText: 'new' }] }),
        presentResult: (_args, outcome) => outcome.isError ? undefined : ({ card: 'diff', title: 'Write a', diffs: [{ path: 'a', oldText: null, newText: 'new' }] }),
      },
    })
    const start = (name: string, args: unknown) => sessionEventToUpdates(call('c-' + name, name, args), { replay: false, presenter })[0]
    expect(start('terminal_close', { id: 't1' })).toMatchObject({ title: 'Close terminal t1', kind: 'delete' })
    // The TUI's inline plan review reads the plan title; the card renders from the view.
    expect(start('exit_plan_mode', { plan: '# Ship it\n\n1. Step' })).toMatchObject({ title: 'Plan: Submit for approval', _meta: { 'dscode/view': { title: 'Ship it' } } })
    // No `variant` is added to a viewed call's input.
    expect(start('web_search', { queries: ['rust'] })).toMatchObject({ kind: 'search', rawInput: { queries: ['rust'] } })
    const prior = () => ({ name: 'write', arguments: { file_path: 'a', content: 'new' } })
    const [written] = sessionEventToUpdates(result('c-write', 'Wrote a', { diffs: [{ path: 'a', oldText: 'stale', newText: 'meta' }] }), { replay: false, toolCall: prior, presenter })
    expect(written).toMatchObject({ content: [{ type: 'content' }, { type: 'diff', path: 'a', newText: 'new' }] })
    expect((written as { content: unknown[] }).content[1]).not.toHaveProperty('oldText')
    // A failed write has a call view but no result view: no diff is synthesized from its arguments.
    const [failed] = sessionEventToUpdates(result('c-write', 'denied', undefined, 1, true), { replay: false, toolCall: prior, presenter })
    expect(failed).toEqual({ sessionUpdate: 'tool_call_update', toolCallId: 'c-write', status: 'failed', content: [{ type: 'content', content: { type: 'text', text: 'denied' } }] })
  })

  it('always names the tool and keeps legacy output byte-identical when no view is presented', () => {
    const events = [call('e1', 'edit', { file_path: '/w/a', old_string: 'a', new_string: 'b' }), result('e1', 'edited', { diffs: [{ path: '/w/a', oldText: 'a', newText: 'b' }] })]
    const prior = () => ({ name: 'edit', arguments: { file_path: '/w/a', old_string: 'a', new_string: 'b' } })
    const project = (presenter?: ToolPresenter) => events.flatMap(event => sessionEventToUpdates(event, { replay: true, cwd: '/w', toolCall: prior, ...presenter === undefined ? {} : { presenter } }))
    const legacy = JSON.stringify(project())
    expect(project()[0]).toMatchObject({ _meta: { 'x.ai/tool': { name: 'edit' } } })
    // Unmounted, presenter-less, throwing and malformed presenters are all the legacy output.
    for (const presenter of [presenting({}), presenting({ edit: {} }),
      presenting({ edit: { presentCall: () => { throw new Error('x') }, presentResult: () => { throw new Error('y') } } }),
      presenting({ edit: { presentCall: () => ({ card: 'diff' }), presentResult: () => 42 } })]) {
      expect(JSON.stringify(project(presenter))).toBe(legacy)
    }
  })

  it('presents PTC sub-calls from their arguments and text, without meta', () => {
    const seen: unknown[] = []
    const presenter = presenting({ read: {
      presentCall: () => ({ card: 'generic', title: 'Read a', kind: 'read', locations: [{ path: 'a' }] }),
      presentResult: (_args, outcome) => { seen.push(outcome); return undefined },
    } })
    const start = { type: 'tool/ptc-dispatch-start', seq: 0, time: 1, data: { subCallId: 'code:ptc:1', name: 'read', arguments: { file_path: 'a' } } } as unknown as SessionEvent
    const done = { type: 'tool/ptc-dispatch', seq: 1, time: 2, data: { subCallId: 'code:ptc:1', name: 'read', arguments: { file_path: 'a' }, isError: false, content: [{ type: 'text', text: 'body' }] } } as unknown as SessionEvent
    expect(sessionEventToUpdates(start, { replay: false, presenter })[0]).toMatchObject({ _meta: { 'dscode/view': { card: 'generic', title: 'Read a', kind: 'read' } } })
    const [settled] = sessionEventToUpdates(done, { replay: false, presenter, toolCall: () => ({ name: 'read', arguments: { file_path: 'a' } }) })
    expect(settled).not.toHaveProperty('_meta')
    expect(seen).toEqual([{ content: [{ type: 'text', text: 'body' }], isError: false }])
  })

  it('projects the same views live and on restore', async () => {
    const run = async (mode: 'live' | 'restore') => {
      const updates: ProjectedUpdate[] = []
      const output = createSessionOutput({ sessionId: 's', cwd: () => '/w', isLive: () => true, promptId: () => undefined, contextValues: () => ({}),
        notify: (_method, params) => { updates.push((params as { update: ProjectedUpdate }).update) }, projectImages: async (_event, items) => items,
        presenter: presenting({ bash }), logger: { warn: () => {} } })
      const events = [call('b1', 'bash', { command: 'echo hi' }, 0), result('b1', 'hi', undefined, 1)]
      if (mode === 'live') for (const event of events) output.live(event)
      else await output.restore(events)
      await output.flush()
      return updates.filter(update => update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update')
    }
    const live = await run('live')
    expect(live.map(update => (update as { _meta?: Record<string, unknown> })._meta?.['dscode/view'])).toEqual([
      { card: 'terminal', title: 'echo hi', cwd: '/w/pkg' }, { card: 'terminal', output: 'hi', exitCode: 0 },
    ])
    expect(await run('restore')).toEqual(live)
  })
})
