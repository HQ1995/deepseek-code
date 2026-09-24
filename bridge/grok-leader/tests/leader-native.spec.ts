/** Leader socket spec: leader native jobs, children, workflows and activity. */
import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { NativeGoalView } from '../src/projection.ts'
import { register, sendRequest, useLeaderHarness, waitFor, waitForId, type MockAgent } from './support/leader-harness.ts'

describe('leader native jobs, children, workflows and activity', () => {
  const start = useLeaderHarness()

  it('fences abandoned and foreign attempts while same-step retries account usage and tools once', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const createdResult = created.result as { sessionId: string }
    const sessionId = createdResult.sessionId
    const agent = registry.byId.get(sessionId)!
    const startAttempt = (attemptId: string, revision: number) => pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'start', attemptId, revision, turn: 0, step: 0 } } as never)
    const chunk = (attemptId: string, revision: number, text: string) => pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId, revision, index: 0, time: 1, chunk: { type: 'text-delta', index: 0, text } } } as never)
    startAttempt('abandoned', 1)
    chunk('abandoned', 2, 'partial')
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: 'partial' } } } })
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'abandoned', revision: 3, index: 1, outcome: { kind: 'abandoned' } } } as never)
    chunk('abandoned', 4, 'late abandoned')
    startAttempt('failed', 4)
    chunk('abandoned', 3, 'stale revision')
    chunk('wrong-id', 5, 'wrong attempt')
    pluginCtx.emit('agent/assistant-stream', { agent: { ...agent, session: agent.session }, frame: { type: 'start', attemptId: 'foreign', revision: 99, turn: 0, step: 0 } } as never)
    chunk('failed', 5, 'failed text')
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: 'failed text' } } } })
    const attempt = { type: 'assistant/attempt', seq: 0, time: 2, data: { turn: 0, step: 0, stream: [
      { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['failed text'] },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 1 } } },
      { type: 'chunk', time: 2, chunk: { type: 'usage', usage: { inputTokens: 10, outputTokens: 2 } } },
    ] } } as never
    pluginCtx.emit('session/event', agent.session, attempt)
    pluginCtx.emit('session/event', agent.session, attempt)
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'failed', revision: 8, index: 3, outcome: { kind: 'committed', eventType: 'assistant/attempt', seq: 0 } } } as never)
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: '' } }, _meta: { cumulativeTokens: 12 } } })
    pluginCtx.emit('session/event', agent.session, { type: 'llm/retry-started', seq: 1, time: 3, data: { retryId: 'retry-1', turn: 0, step: 0, retry: 1 } } as never)
    startAttempt('retry', 9)
    chunk('failed', 8, 'late failed')
    chunk('retry', 10, 'success')
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: 'success' } } } })
    pluginCtx.emit('session/event', agent.session, { type: 'assistant/message', seq: 2, time: 4, surfaceOp: 'append', data: {
      turn: 0, step: 0, stream: [
        { type: 'text-chunks', time0: 1, index: 0, dt: [], texts: ['success'] },
        { type: 'tool-call-chunks', time0: 2, index: 1, dt: [], id: 'call-1', name: 'read', args: ['{}'] },
        { type: 'chunk', time: 3, chunk: { type: 'usage', usage: { inputTokens: 20, outputTokens: 3 } } },
      ], message: createAssistantMessage({ content: [{ type: 'text', text: 'success' }, { type: 'tool-call', id: ToolCallId('call-1'), name: 'read', arguments: '{}' }], source: { provider: 'deepseek', model: 'chat' } }),
    } } as never)
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'retry', revision: 13, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 2 } } } as never)
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: '' } }, _meta: { cumulativeTokens: 35 } } })
    pluginCtx.emit('session/event', agent.session, { type: 'tool/call', seq: 3, time: 5, data: { turn: 0, step: 0, callId: 'call-1', name: 'read', arguments: '{}' } } as never)
    expect(await c.next()).toMatchObject({ params: { update: { sessionUpdate: 'tool_call', toolCallId: 'call-1' } } })
    await c.request(2, 'x.ai/session/info', { sessionId })
    const updates = c.all.filter(message => message.method === 'session/update').map(message => message.params as { update: { sessionUpdate: string; content?: { text: string } } })
    expect(updates.map(item => item.update.content?.text).filter(text => text !== undefined)).toEqual(['partial', 'failed text', '', 'success', ''])
    expect(updates.filter(item => item.update.sessionUpdate === 'tool_call')).toHaveLength(1)
  })

  it('reports completed compactions in session info', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    pluginCtx.emit('session/event', agent.session, {
      type: 'compaction/end',
      seq: 0,
      time: Date.now(),
      data: { compactionId: 'compaction-test', turn: null },
    } as unknown as SessionEvent)

    expect((await c.request(2, 'x.ai/session/info', { sessionId })).result).toMatchObject({
      result: { context: { compactionCount: 1 } },
    })
  })

  it('streams traced native jobs once per owner and authorizes controls until terminal notification', async () => {
    type Job = { id: string; kind: string; label: string; owner?: string; status: 'running' | 'stopping' | 'killed' | 'completed'; startedAt: number; finishedAt?: number; detail?: string }
    const rows: Job[] = []
    let changed!: (event: { type: string; owner: string; id: string; total: number }) => void
    let finish!: (job: Job) => void
    const list = vi.fn((owner: string) => rows.filter(job => job.owner === owner))
    const get = vi.fn((id: string, owner: string) => list(owner).find(job => job.id === id)!)
    const kill = vi.fn((id: string, owner: string) => { get(id, owner).status = 'stopping'; changed({ type: 'output', owner: typeof owner === 'string' ? owner : owner.session.id, id: 'bash-1', total: 0 }); return 'requested' })
    const wait = vi.fn(() => new Promise<Job>(resolve => { finish = resolve }))
    const subscribe = vi.fn(function (_filter: unknown, fn: typeof changed) {
      changed = fn
      return () => {}
    })
    const { registry, presets, client: c } = await start({ presets: true, jobs: { list, get, kill, wait, events: { subscribe } } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const owner = registry.byId.get(sessionId)!
    const secondCreated = await c.request(10, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const secondResult = secondCreated.result
    if (typeof secondResult !== 'object' || secondResult === null || !('sessionId' in secondResult) || typeof secondResult.sessionId !== 'string') throw new Error('second session was not created')
    const secondSessionId = secondResult.sessionId
    const secondOwner = registry.byId.get(secondSessionId)!
    // Real Service instances acquire a fresh Cordis tracing proxy on every lookup.
    expect(owner.ctx.get('jobs')).not.toBe(owner.ctx.get('jobs'))
    // The traced preset method wraps the already-traced jobs return value again.
    expect(presets!.serviceFor).toHaveBeenCalledWith(owner, 'jobs')
    expect(presets!.serviceFor).toHaveBeenCalledWith(secondOwner, 'jobs')
    for (const id of [sessionId, secondSessionId, sessionId]) {
      expect((await c.request(11, 'x.ai/session/info', { sessionId: id })).error).toBeUndefined()
    }
    expect(subscribe).toHaveBeenCalledTimes(1)
    expect(subscribe.mock.calls[0]![0]).toEqual({ owners: 'all' })
    const row: Job = { id: 'bash-1', kind: 'bash', label: 'sleep 30', owner: sessionId, status: 'running', startedAt: 1000 }
    rows.push(row, { ...row, id: 'bash-foreign', owner: 'other-session' }, { ...row, id: 'bash-done', status: 'completed', finishedAt: 2000 })
    rows.push({ ...row, id: 'bash-2', owner: secondSessionId })
    changed({ type: 'output', owner: typeof owner === 'string' ? owner : owner.session.id, id: 'bash-1', total: 0 })
    changed({ type: 'output', owner: secondOwner.session.id, id: 'bash-2', total: 0 })
    // Observe the push before any kill or query can incidentally refresh Tasks.
    await waitFor(() => c.all.filter(msg => msg.method === 'x.ai/task_backgrounded').length >= 2)
    expect(c.all.filter(msg => msg.method === 'x.ai/task_backgrounded').map(msg => msg.params)).toEqual([
      expect.objectContaining({ sessionId, update: expect.objectContaining({ task_id: row.id, command: row.label }) }),
      expect.objectContaining({ sessionId: secondSessionId, update: expect.objectContaining({ task_id: 'bash-2', command: row.label }) }),
    ])
    expect(subscribe).toHaveBeenCalledTimes(1)
    for (const taskId of ['missing', 'bash-foreign', 'bash-2']) expect((await c.request(2, 'x.ai/task/kill', { sessionId, taskId, source: 'clientUi' })).result).toEqual({ result: { taskId, outcome: 'not_found' } })
    expect((await c.request(3, 'x.ai/task/kill', { sessionId, taskId: 'bash-done', source: 'teardown' })).result).toEqual({ result: { taskId: 'bash-done', outcome: 'already_exited' } })
    expect(kill).not.toHaveBeenCalled()
    expect((await c.request(4, 'x.ai/task/kill', { sessionId: 'foreign-session', taskId: row.id, source: 'clientUi' })).error).toBeDefined()
    sendRequest(c, 5, 'x.ai/task/kill', { sessionId, taskId: row.id, source: 'clientUi' })
    await waitFor(() => wait.mock.calls.length === 1)
    expect(c.all.some(msg => msg.id === 5)).toBe(false)
    expect(kill).toHaveBeenCalledWith(row.id, owner.session.id, 'cancelled by the user')
    expect(wait).toHaveBeenCalledWith(row.id, 5000, owner.session.id)
    Object.assign(row, { status: 'killed', finishedAt: 3000, detail: 'terminated by producer' })
    changed({ type: 'output', owner: typeof owner === 'string' ? owner : owner.session.id, id: 'bash-1', total: 0 }); finish(row)
    expect((await waitForId(c, 5)).result).toEqual({ result: { taskId: row.id, outcome: 'killed' } })
    expect(c.all).toContainEqual(expect.objectContaining({ method: 'x.ai/task_completed', params: expect.objectContaining({ update: { sessionUpdate: 'task_completed', task_snapshot: expect.objectContaining({ task_id: row.id, completed: true, exit_code: null, signal: null }) }, _meta: expect.objectContaining({ nativeTask: { status: 'killed', kind: 'bash', detail: 'terminated by producer', outputAvailable: false } }) }) }))
    expect(c.all.filter(msg => msg.method === 'x.ai/task_backgrounded')).toHaveLength(2)
    expect(subscribe).toHaveBeenCalledTimes(1)
  })

  it('does not report a requested but unsettled job cancellation as killed', async () => {
    const row = { id: 'bash-1', kind: 'bash', label: 'slow producer', status: 'running', startedAt: 1 }
    const kill = vi.fn(() => { row.status = 'stopping'; return 'requested' })
    const { client: c } = await start({ jobs: { list: () => [row], get: () => row, kill, wait: async () => row, events: { subscribe: () => () => {} } } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect((await c.request(2, 'x.ai/task/kill', { sessionId, taskId: row.id, source: 'clientUi' })).error).toMatchObject({ message: 'task cancellation requested; producer has not settled yet' })
    expect(c.all.some(msg => msg.method === 'x.ai/task_completed')).toBe(false)
  })

  it('routes human child controls through scoped native admission without touching the parent turn', async () => {
    const rows = [
      { kind: 'child', id: 'child-one', parentId: 'nested-parent', mode: 'continuable' },
      { kind: 'child', id: 'child-two', mode: 'continuable' },
      { kind: 'child', id: 'one-shot', mode: 'one-shot' },
    ]
    const prompt = vi.fn(async () => ({ messageId: 'admitted' }))
    const interrupt = vi.fn()
    const listDescendants = vi.fn(async () => rows)
    const { registry, client: c } = await start({ subagents: { listDescendants, prompt, interrupt } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const owner = registry.byId.get(sessionId)!
    owner.internals.status = 'running'
    await registry.create({ sessionId: SessionId('child-one'), meta: {} })
    const child = registry.byId.get('child-one')!
    child.internals.status = 'running'
    const message = createUserMessage({ content: [{ type: 'text', text: 'original' }], source: { kind: 'user' } })
    const remove = vi.fn(), replace = vi.fn(), clear = vi.fn()
    Object.assign(child.inbox, { nextTurn: [message], nextStep: [], remove, replace, clear })
    let requestId = 2
    const command = (text: string, receivingSession = sessionId) => c.request(requestId++, 'x.ai/subagents', {
      sessionId: receivingSession, prompt: [{ type: 'text', text: '/subagents ' + text }],
    })
    for (const text of ['queue foreign message', 'queue child message', 'queue one-shot message', 'queue child-one', 'remove child-one missing']) {
      expect((await command(text)).result).toMatchObject({ result: { kind: 'error' } })
    }
    expect((await command('queue child-one message', 'foreign-owner')).error).toBeDefined()
    expect(prompt).not.toHaveBeenCalled()
    expect(remove).not.toHaveBeenCalled()
    for (const delivery of ['queue', 'steer']) {
      expect((await command(`${delivery} child-o exact\n message`)).result).toMatchObject({ result: { kind: 'success' } })
      expect(prompt).toHaveBeenLastCalledWith(expect.objectContaining({
        requestId: expect.any(String), parentSessionId: 'nested-parent', childSessionId: 'child-one',
        mode: 'continuable', delivery, content: [{ type: 'text', text: 'exact\n message' }],
      }), expect.any(AbortSignal))
    }
    const inbox = (params: Record<string, unknown>) => c.request(requestId++, 'x.ai/subagent/inbox', { sessionId, childId: 'child-one', ...params })
    expect((await inbox({})).result).toMatchObject({ items: [{ id: message.id, text: 'original', editable: true }] })
    expect((await inbox({ childId: 'one-shot' })).error).toBeDefined()
    expect((await inbox({ sessionId: 'foreign-owner' })).error).toBeDefined()
    expect((await inbox({ action: 'edit', messageId: message.id, expectedText: 'stale', text: 'new' })).error).toBeDefined()
    expect(replace).not.toHaveBeenCalled()
    listDescendants.mockImplementationOnce(async () => rows).mockImplementationOnce(async () => {
      Object.assign(child.inbox, { nextTurn: [{ ...message, content: [{ type: 'text', text: 'concurrent edit' }] }] })
      return rows
    })
    expect((await inbox({ action: 'edit', messageId: message.id, expectedText: 'original', text: 'new' })).error).toBeDefined()
    expect(replace).not.toHaveBeenCalled()
    Object.assign(child.inbox, { nextTurn: [message] })
    expect((await inbox({ action: 'remove', messageId: 'already-consumed' })).error).toBeDefined()
    expect((await command('pending child-one')).result).toMatchObject({ result: { text: expect.stringContaining(message.id) } })
    expect((await command(`edit child-one ${message.id.slice(0, 8)} revised`)).result).toMatchObject({ result: { kind: 'success' } })
    expect(replace).toHaveBeenCalledWith(message.id, { ...message, content: [{ type: 'text', text: 'revised' }] })
    await command(`remove child-one ${message.id}`)
    expect(remove).toHaveBeenCalledWith(message.id)
    await command('steer-queued child-one all')
    expect(child.internals.steered).toEqual(['original'])
    await command('clear child-one')
    expect(clear).toHaveBeenCalledOnce()
    expect(owner.internals.status).toBe('running')
    expect(owner.internals.followups).toEqual([])
    expect(owner.internals.steered).toEqual([])
    expect(owner.internals.cancelCalls).toBe(0)
  })

  it.each([false, true])('coalesces pending child refreshes without losing a later refresh after failure=%s', async failFirst => {
    const listDescendants = vi.fn(async (): Promise<Array<{ kind: string; id: string }>> => [])
    const { pluginCtx, client: c } = await start({ subagents: { listDescendants, interrupt() {} } })
    register(c); await c.next()
    await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    await new Promise<void>(resolve => setImmediate(resolve))
    const baseline = listDescendants.mock.calls.length
    let release!: () => void, entered!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    listDescendants.mockImplementationOnce(async () => {
      entered(); await held
      if (failFirst) throw new Error('snapshot temporarily unavailable')
      return []
    })
    pluginCtx.emit('subagent/start', { id: 'child' } as never)
    await started
    for (let i = 0; i < 30; i++) pluginCtx.emit('subagent/start', { id: 'child' } as never)
    release()
    await waitFor(() => listDescendants.mock.calls.length >= baseline + 2)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(listDescendants.mock.calls.length - baseline).toBe(2)
  })

  it('discovers workflow children published after early lifecycle and membership events', async () => {
    const rows: Array<{ kind: string; id: string; mode: string }> = []
    const listDescendants = vi.fn(async () => [...rows])
    const { registry, pluginCtx, client: c } = await start({ subagents: { listDescendants, interrupt() {} } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const parent = registry.byId.get((created.result as { sessionId: string }).sessionId)!
    await new Promise<void>(resolve => setImmediate(resolve))
    const before = listDescendants.mock.calls.length
    pluginCtx.emit('subagent/start', { id: 'workflow-child' } as never)
    await waitFor(() => listDescendants.mock.calls.length > before)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(c.all.some(msg => JSON.stringify(msg).includes('subagent_spawned'))).toBe(false)
    parent.session.append('tool-workflow/run-start', { runId: 'run', name: 'review' } as never)
    const event = parent.session.append('tool-workflow/agent-start', { runId: 'run', seq: 1, childId: 'workflow-child', label: 'Reader' } as never)
    pluginCtx.emit('session/event', parent.session, event as never)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(c.all.some(msg => JSON.stringify(msg).includes('workflow_updated'))).toBe(false)
    await registry.create({ sessionId: SessionId('workflow-child'), meta: {} })
    rows.push({ kind: 'child', id: 'workflow-child', mode: 'one-shot' })
    // No further host-visible lifecycle edge: only reconciliation can find it.
    const spawned = await waitForNotification(() => c.all.find(msg => JSON.stringify(msg).includes('subagent_spawned')))
    expect(JSON.stringify(spawned)).toContain('workflow-child')
    const workflow = await waitForNotification(() => c.all.find(msg => JSON.stringify(msg).includes('workflow_updated')))
    expect(JSON.stringify(workflow)).toContain('workflow-child')
    expect(c.all.indexOf(spawned)).toBeLessThan(c.all.indexOf(workflow))
    const discovered = listDescendants.mock.calls.length
    await new Promise(resolve => setTimeout(resolve, 600))
    expect(listDescendants.mock.calls.length).toBe(discovered)
  })

  it('paginates owned native child history and protects a newer attempt from late completion', async () => {
    const rows: Array<{ kind: string; id: string; mode: string }> = []
    const { registry, persistence, pluginCtx, client: c } = await start({ subagents: { listDescendants: async () => rows, interrupt() {} } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const { agent } = await registry.create({ sessionId: SessionId('history-child'), meta: {} })
    const child = registry.byId.get('history-child')!
    child.internals.status = 'running'
    child.session.append('turn/start', { turn: 0 })
    for (let index = 0; index < 260; index++) child.session.append('user/message', createUserMessage({ content: [{ type: 'text', text: `message-${index}` }], source: { kind: 'user' } }))
    rows.push({ kind: 'child', id: child.session.id, mode: 'continuable' })
    const pages: Array<[number | undefined, number | undefined]> = []
    const open = persistence.open
    persistence.open = async (...args) => {
      const handle = await open(...args), read = handle.read
      handle.read = (offset, length, options) => {
        if (args[0] === child.session.id) pages.push([offset, length])
        return read(offset, length, options)
      }
      return handle
    }
    pluginCtx.emit('subagent/start', { id: child.session.id } as never)
    await waitForNotification(() => c.all.find(msg => JSON.stringify(msg).includes('subagent_spawned')))
    const request = (id: number, after: unknown = 0, childSessionId: string = child.session.id, parent: string = sessionId) => c.request(id, 'x.ai/subagent/history', { sessionId: parent, childSessionId, after })
    expect((await request(2, -1)).error).toBeDefined()
    expect((await request(3, 0, 'foreign-child')).error).toBeDefined()
    expect((await request(4, 0, child.session.id, 'foreign-parent')).error).toBeDefined()
    const first = (await request(5)).result as { entries: unknown[]; nextSeq: number; totalSeq: number; durable: boolean }
    expect(first).toMatchObject({ nextSeq: 256, totalSeq: 261, durable: false })
    expect(first.entries).toHaveLength(256) // includes native turn/start Todo reset
    const second = (await request(6, first.nextSeq)).result as typeof first
    expect(second).toMatchObject({ nextSeq: 261, totalSeq: 261 })
    expect(second.entries).toHaveLength(5)
    expect(JSON.stringify(second.entries)).toContain('message-259')
    expect(pages.every(([offset, length]) => offset !== undefined && length !== undefined && length <= 256)).toBe(true)
    expect(pages.reduce((sum, [, length]) => sum + length!, 0)).toBe(522)
    const nextTurn = child.session.append('turn/start', { turn: 1 })
    pluginCtx.emit('session/event', child.session, nextTurn)
    await waitForNotification(() => c.all.find(msg => JSON.stringify(msg).includes('history-child:1')))
    pluginCtx.emit('session/event', child.session, { type: 'turn/end', seq: 0, time: 1, data: { turn: 0, reason: { kind: 'completed' } } } as unknown as SessionEvent)
    pluginCtx.emit('subagent/end', { id: child.session.id, stopReason: 'completed' } as never)
    await request(7, second.nextSeq)
    expect(c.all.some(msg => JSON.stringify(msg).includes('subagent_finished'))).toBe(false)
    child.internals.status = 'idle'
    const end = child.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    pluginCtx.emit('session/event', child.session, end)
    pluginCtx.emit('agent/status', { agent, status: 'idle' })
    expect((await request(8, second.nextSeq)).result).toMatchObject({ durable: true, nextSeq: 263 })
    registry.byId.delete(child.session.id)
    expect((await request(9)).result).toMatchObject({ nextSeq: 256, totalSeq: 263, durable: true })
    expect(c.all).toContainEqual(expect.objectContaining({ method: 'x.ai/subagent/history_changed' }))
    expect((await request(10, 1000)).error).toBeDefined()
  })

  it('authorizes descendant interrupts and acknowledges only the actual cancelled turn', async () => {
    const rows: Array<{ kind: string; id: string; mode: string; label: string }> = []
    const interrupt = vi.fn()
    const { registry, pluginCtx, client: c } = await start({ subagents: { listDescendants: async () => rows, interrupt } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const owner = registry.byId.get(sessionId)!
    const handle = await registry.create({ sessionId: SessionId('descendant'), meta: {} })
    const child = registry.byId.get('descendant')!
    child.session.append('turn/start', { turn: 0 })
    child.internals.status = 'running'
    rows.push({ kind: 'child', id: 'descendant', mode: 'continuable', label: 'nested worker' }, { kind: 'child', id: 'cold', mode: 'continuable', label: 'cold worker' })
    expect((await c.request(2, 'x.ai/subagent/cancel', { sessionId, subagentId: 'foreign' })).result).toEqual({ result: { subagentId: 'foreign', cancelled: false, outcome: { kind: 'not_found' } } })
    expect((await c.request(3, 'x.ai/subagent/cancel', { sessionId, subagentId: 'cold' })).result).toEqual({ result: { subagentId: 'cold', cancelled: false, outcome: { kind: 'already_finished', status: 'inactive' } } })
    expect((await c.request(4, 'x.ai/subagent/cancel', { sessionId: 'foreign', subagentId: 'descendant' })).error).toBeDefined()
    expect(interrupt).not.toHaveBeenCalled()
    sendRequest(c, 5, 'x.ai/subagent/cancel', { sessionId, subagentId: 'descendant' })
    await waitFor(() => interrupt.mock.calls.length === 1)
    expect(interrupt).toHaveBeenCalledWith(SessionId('descendant'), { kind: 'ancestor', agent: owner })
    expect(c.all.some(msg => msg.id === 5)).toBe(false)
    child.internals.status = 'idle'
    const event = { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 0, reason: { kind: 'interrupted' } } } as unknown as SessionEvent
    pluginCtx.emit('session/event', child.session, event)
    expect((await waitForId(c, 5)).result).toEqual({ result: { subagentId: 'descendant', cancelled: true, outcome: { kind: 'cancelled', status: 'cancelled' } } })
    expect(c.all).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'subagent_finished', subagent_id: 'descendant', status: 'cancelled' }), _meta: expect.objectContaining({ subagentMetricsAvailable: false }) }) }))
    pluginCtx.emit('subagent/end', { id: 'descendant', stopReason: 'aborted', lastAssistantMessage: 'real final output' })
    await waitFor(() => c.all.some(msg => JSON.stringify(msg).includes('real final output')))
    expect((await c.request(6, 'x.ai/subagent/cancel', { sessionId, subagentId: 'descendant' })).result).toEqual({ result: { subagentId: 'descendant', cancelled: false, outcome: { kind: 'already_finished', status: 'idle' } } })
    await handle.dispose()
  })

  it('returns not_found without publishing controllable tasks when services are absent', async () => {
    const { client: c } = await start()
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect((await c.request(2, 'x.ai/task/kill', { sessionId, taskId: 'job', source: 'clientUi' })).result).toEqual({ result: { taskId: 'job', outcome: 'not_found' } })
    expect((await c.request(3, 'x.ai/subagent/cancel', { sessionId, subagentId: 'child' })).result).toEqual({ result: { subagentId: 'child', cancelled: false, outcome: { kind: 'not_found' } } })
    expect(c.all.some(msg => msg.method === 'x.ai/task_backgrounded' || JSON.stringify(msg).includes('subagent_spawned'))).toBe(false)
  })

  it('refreshes current context live and ignores a foreign Session with the same id', async () => {
    let listener!: (session: unknown, key: string) => void
    let values: { contextPressure: { projectedTokens?: number; contextWindow?: number } } = { contextPressure: { projectedTokens: 0, contextWindow: 8000 } }
    const snapshot = vi.fn(() => ({ values }))
    const { registry, client: c } = await start({ sessionProjections: { snapshot, onChanged(fn: typeof listener) { listener = fn; return () => {} } } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    listener(agent.session, 'contextPressure')
    expect(await c.next()).toMatchObject({ method: 'session/update', params: { sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }, _meta: { contextInfo: { available: true, used: 0, total: 8000 } } } })
    expect(snapshot).toHaveBeenCalledWith(agent.session, ['tokenUsage', 'contextPressure', 'contextBreakdown'])
    const calls = snapshot.mock.calls.length
    listener({ ...agent.session }, 'contextPressure')
    expect(snapshot).toHaveBeenCalledTimes(calls)
    values = { contextPressure: {} }
    listener(agent.session, 'contextPressure')
    expect(await c.next()).toMatchObject({ params: { _meta: { contextInfo: { available: false, capacityAvailable: false } } } })
  })

  it('reports a natural job completion racing cancellation as already_exited', async () => {
    const row = { id: 'bash-1', kind: 'bash', label: 'finishing', status: 'running', startedAt: 1 }
    const { client: c } = await start({ jobs: { list: () => [row], get: () => row, kill: () => 'requested', wait: async () => { row.status = 'completed'; return row }, events: { subscribe: () => () => {} } } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect((await c.request(2, 'x.ai/task/kill', { sessionId, taskId: row.id, source: 'clientUi' })).result).toEqual({ result: { taskId: row.id, outcome: 'already_exited' } })
  })

  it('publishes one-shot history without pretending the native service can interrupt it', async () => {
    const rows: Array<{ kind: string; id: string; mode: string }> = []
    const interrupt = vi.fn()
    const { registry, pluginCtx, client: c } = await start({ subagents: { listDescendants: async () => rows, interrupt } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const child = await registry.create({ sessionId: SessionId('one-shot'), meta: {} })
    registry.byId.get('one-shot')!.internals.status = 'running'
    rows.push({ kind: 'child', id: 'one-shot', mode: 'one-shot' })
    pluginCtx.emit('subagent/start', { id: 'one-shot', runId: 'run-one', provider: 'spawn', local: true })
    expect((await c.request(2, 'x.ai/subagent/cancel', { sessionId, subagentId: 'one-shot' })).error).toBeDefined()
    expect(interrupt).not.toHaveBeenCalled()
    expect(c.all.some(msg => JSON.stringify(msg).includes('subagent_spawned'))).toBe(true)
    await child.dispose()
  })

  it('lists a background subagent once, as its child row, and stops it through its job', async () => {
    type Job = { id: string; kind: string; label: string; owner?: string; status: string; startedAt: number }
    const jobs: Job[] = [
      { id: 'subagent-1', kind: 'subagent', label: 'scan repo', status: 'running', startedAt: 1 },
      { id: 'workflow-1', kind: 'workflow', label: 'review', status: 'running', startedAt: 1 },
      { id: 'bash-1', kind: 'bash', label: 'sleep 30', status: 'running', startedAt: 1 },
    ]
    let changed!: (event: { type: string; owner: string; id: string; total: number }) => void
    const list = (owner: string) => jobs.filter(job => job.owner === owner)
    const get = (id: string, owner: string) => list(owner).find(job => job.id === id)!
    const kill = vi.fn((id: string, owner: string) => { get(id, owner).status = 'stopping'; return 'requested' })
    const wait = vi.fn(async (id: string, _ms: number, owner: string) => Object.assign(get(id, owner), { status: 'killed' }))
    const rows: Array<Record<string, string>> = []
    const interrupt = vi.fn()
    const { registry, pluginCtx, client: c } = await start({
      jobs: { list, get, kill, wait, events: { subscribe: (_filter: unknown, fn: typeof changed) => { changed = fn; return () => {} } } },
      subagents: { listDescendants: async () => rows, interrupt },
    })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    for (const job of jobs) job.owner = sessionId
    const child = await registry.create({ sessionId: SessionId('bg-child'), meta: {} })
    registry.byId.get('bg-child')!.internals.status = 'running'
    // DSH's background subagent tool starts a `subagent` job whose run spawns a one-shot child.
    rows.push({ kind: 'child', id: 'bg-child', mode: 'one-shot', label: 'scan repo', parentId: sessionId })
    pluginCtx.emit('subagent/start', { id: 'bg-child', runId: 'run-bg', provider: 'spawn', local: true })
    await waitFor(() => typeof changed === 'function')
    changed({ type: 'output', owner: sessionId, id: 'bash-1', total: 0 })
    await waitFor(() => c.all.some(msg => JSON.stringify(msg).includes('subagent_spawned'))
      && c.all.some(msg => msg.method === 'x.ai/task_backgrounded'))
    await c.request(2, 'x.ai/session/info', { sessionId })
    // The Tasks pane merges jobs, children and workflows: the child row stands
    // for the subagent job. A workflow job stays: its workflow row has no stop.
    expect(c.all.filter(msg => msg.method === 'x.ai/task_backgrounded')
      .map(msg => (msg.params as { update: { task_id: string } }).update.task_id)).toEqual(['workflow-1', 'bash-1'])
    // The job names no child: a description another job or running one-shot
    // child shares refuses rather than guess.
    jobs.push({ id: 'subagent-2', kind: 'subagent', label: 'scan repo', owner: sessionId, status: 'running', startedAt: 2 })
    expect((await c.request(3, 'x.ai/subagent/cancel', { sessionId, subagentId: 'bg-child' })).error)
      .toMatchObject({ message: expect.stringContaining('cannot tell which background job to stop') })
    jobs.pop()
    const foreground = await registry.create({ sessionId: SessionId('fg-child'), meta: {} })
    registry.byId.get('fg-child')!.internals.status = 'running'
    rows.push({ kind: 'child', id: 'fg-child', mode: 'one-shot', label: 'scan repo', parentId: sessionId })
    expect((await c.request(4, 'x.ai/subagent/cancel', { sessionId, subagentId: 'fg-child' })).error)
      .toMatchObject({ message: expect.stringContaining('cannot tell which background job to stop') })
    expect(kill).not.toHaveBeenCalled()
    rows.pop(); await foreground.dispose()
    // The native service cannot interrupt a one-shot child; its job can be killed.
    expect((await c.request(5, 'x.ai/subagent/cancel', { sessionId, subagentId: 'bg-child' })).result).toEqual({
      result: { subagentId: 'bg-child', cancelled: true, outcome: { kind: 'cancelled', status: 'cancelled' } } })
    expect(kill).toHaveBeenCalledWith('subagent-1', sessionId, 'cancelled by the user')
    expect(wait).toHaveBeenCalledWith('subagent-1', 5000, sessionId)
    expect(interrupt).not.toHaveBeenCalled()
    await child.dispose()
  })

  it('keeps native activity running until backend cancellation settlement', async () => {
    let goal: NativeGoalView = { id: 'held-goal', revision: 1, objective: 'finish', phase: 'active', activation: 'armed', roundsStarted: 1, maxGoalRounds: 3 }
    const pause = vi.fn()
    const execute = vi.fn(async () => {
      goal = { ...goal, revision: 2, phase: 'paused', activation: 'disarmed' }
      return { commandId: 'native-goal', result: { kind: 'success', text: 'paused' } }
    })
    const { registry, pluginCtx, client: c } = await start({ manualIdle: true, goals: { get: () => goal, pause }, commands: { list: () => [], execute } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const result = created.result
    if (typeof result !== 'object' || result === null || !('sessionId' in result) || typeof result.sessionId !== 'string') throw new Error('session was not created')
    const sessionId = result.sessionId
    const agent = registry.byId.get(sessionId)!
    const activity = () => c.all.filter(msg => {
      const params = msg.params
      if (msg.method !== 'session/update' || typeof params !== 'object' || params === null || !('update' in params)) return false
      const update = params.update
      return typeof update === 'object' && update !== null && 'sessionUpdate' in update && update.sessionUpdate === 'session_info_update'
    }).map(msg => msg.params as { sessionId: string; _meta: { eventSeq: number; sessionRunning: boolean; promptId?: string; isReplay?: boolean } })
    expect(activity().map(msg => msg._meta.sessionRunning)).toEqual([false])
    // Native driver reservation has no ACP foreground prompt or inbox row.
    agent.internals.status = 'running'
    pluginCtx.emit('agent/status', { agent, status: 'running' })
    await waitFor(() => activity().length === 2)
    expect((await c.request(2, 'x.ai/goal', { sessionId, prompt: [{ type: 'text', text: '/goal pause' }] })).error).toBeUndefined()
    c.notify('session/cancel', { sessionId })
    await c.request(3, 'x.ai/session/info', { sessionId })
    expect(agent.internals.cancelCalls).toBe(1)
    expect(pause).not.toHaveBeenCalled()
    expect(goal).toMatchObject({ revision: 2, phase: 'paused', activation: 'disarmed' })
    expect(agent.status).toBe('running')
    expect(activity().map(msg => msg._meta.sessionRunning)).toEqual([false, true])
    const foreign = { ...agent, status: 'idle' } as Agent
    pluginCtx.emit('agent/status', { agent: foreign, status: 'idle' })
    await c.request(4, 'x.ai/session/info', { sessionId })
    expect(activity()).toHaveLength(2)
    agent.internals.status = 'idle'
    pluginCtx.emit('agent/status', { agent, status: 'idle' })
    await waitFor(() => activity().length === 3)
    expect(activity().map(msg => msg._meta.sessionRunning)).toEqual([false, true, false])
    expect(activity().every(msg => msg.sessionId === sessionId && !('promptId' in msg._meta) && !('isReplay' in msg._meta))).toBe(true)
    const seqs = activity().map(msg => msg._meta.eventSeq)
    expect(seqs[1]).toBeGreaterThan(seqs[0]!)
    expect(seqs[2]).toBeGreaterThan(seqs[1]!)
    expect(agent.internals.followups).toEqual([])
    expect(c.completes).toEqual([])
    expect(c.broadcasts).toEqual([expect.objectContaining({ params: expect.objectContaining({ entries: [] }) })])
  })

  it('hydrates live native activity on load and fork and ignores retired Agent identities', async () => {
    const { registry, pluginCtx, client: c } = await start()
    const resume = registry.resume.bind(registry)
    vi.spyOn(registry, 'resume').mockImplementation(async options => {
      const handle = await resume(options)
      registry.byId.get(handle.agent.session.id)!.internals.status = 'running'
      return handle
    })
    register(c); await c.next()
    const sessionId = 'persisted-session'
    expect((await c.request(1, 'session/load', { sessionId, cwd: '/tmp/proj', mcpServers: [], _meta: { noReplay: true } })).error).toBeUndefined()
    const retired = registry.byId.get(sessionId)!
    const activity = () => c.all.filter(msg => {
      const params = msg.params
      if (msg.method !== 'session/update' || typeof params !== 'object' || params === null || !('update' in params)) return false
      const update = params.update
      return typeof update === 'object' && update !== null && 'sessionUpdate' in update && update.sessionUpdate === 'session_info_update'
    })
    expect(activity()[0]).toMatchObject({ params: { sessionId, _meta: { sessionRunning: true } } })
    expect(activity()[0]).not.toHaveProperty('params._meta.isReplay')
    const forkId = '33333333-3333-4333-8333-333333333333'
    expect((await c.request(2, 'x.ai/session/fork', { sourceSessionId: sessionId, newSessionId: forkId, newCwd: '/tmp/proj' })).error).toBeUndefined()
    expect(activity()[1]).toMatchObject({ params: { sessionId: forkId, _meta: { sessionRunning: false } } })
    expect((await c.request(3, 'session/load', { sessionId, cwd: '/tmp/proj', mcpServers: [] })).error).toBeUndefined()
    const count = activity().length
    pluginCtx.emit('agent/status', { agent: retired, status: 'idle' })
    await c.request(4, 'x.ai/session/info', { sessionId })
    expect(activity()).toHaveLength(count)
  })

  it('sends subagent_finished even after the child Agent was disposed (ready snapshot)', async () => {
    // Regression: `subagent/end` fires after the child Agent has been disposed
    // and unregistered, so `agents.get(childId)` is undefined by then. The
    // bridge must resolve the parent from its spawn-time mapping instead of
    // dropping the finish (which left the TUI's `finished` flag unset and
    // presented a completed/ready subagent as still running forever).
    const children: Array<{ kind: string; id: string; mode: string; label: string }> = []
    const { registry, pluginCtx, client: c } = await start({ subagents: { listDescendants: async () => children, interrupt() {} } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const childId = 'child-' + randomUUID().slice(0, 12)
    // The child exists (spawned Agent is live) and carries its parent's id in
    // the header so the bridge can resolve the owner at spawn time.
    const child = await registry.create({
      sessionId: SessionId(childId),
      meta: { cwd: process.cwd(), agentPreset: undefined },
    })
    ;(child.agent.session.header as { parentSession?: string }).parentSession = sessionId
    registry.byId.set(childId, child.agent as MockAgent)
    registry.byId.get(childId)!.internals.status = 'running'
    child.agent.session.append('turn/start', { turn: 0 })
    children.push({ kind: 'child', id: childId, mode: 'continuable', label: 'worker' })
    // Spawn: the child Agent is live, so the bridge records childId -> parent.
    pluginCtx.emit('subagent/start', { runId: 'run-' + childId, provider: 'spawn', id: childId, local: true })
    const spawned = await waitForNotification(() => c.all.find((msg) =>
      (msg as { params?: { update?: { sessionUpdate?: string; child_session_id?: string } } })
        .params?.update?.sessionUpdate === 'subagent_spawned'
        && msg !== undefined))
    expect(spawned).toBeDefined()
    const spawnedParams = (spawned as { params?: { update?: { sessionUpdate?: string; child_session_id?: string } } }).params
    expect(spawnedParams?.update?.child_session_id).toBe(childId)
    expect(spawnedParams?.update?.sessionUpdate).toBe('subagent_spawned')

    // Simulate completion: the child Agent is disposed/unregistered before the
    // end edge arrives (this is exactly the ready-snapshot case).
    registry.byId.delete(childId)
    await child.dispose().catch(() => undefined)
    pluginCtx.emit('session/event', child.agent.session, child.agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } }))
    pluginCtx.emit('subagent/end', { runId: 'run-' + childId, provider: 'spawn', id: childId, local: true, stopReason: 'completed' })
    const finished = await waitForNotification(() => c.all.find((msg) =>
      (msg as { params?: { update?: { sessionUpdate?: string; subagent_id?: string } } })
        .params?.update?.sessionUpdate === 'subagent_finished'
        && msg !== undefined))
    expect(finished).toBeDefined()
    const finishedUpdate = (finished as { params?: { update?: { subagent_id?: string; status?: string } } }).params?.update
    expect(finishedUpdate?.subagent_id).toBe(childId)
    expect(finishedUpdate?.status).toBe('completed')
  })

  function waitForNotification<T>(fn: () => T | undefined): Promise<T> {
    const deadline = Date.now() + 2_000
    return new Promise<T>((resolve, reject) => {
      const tick = (): void => {
        const found = fn()
        if (found !== undefined) { resolve(found); return }
        if (Date.now() >= deadline) { reject(new Error('timed out waiting for notification')); return }
        setTimeout(tick, 10)
      }
      tick()
    })
  }

  it.each(['session/new', 'session/load', 'x.ai/session/fork'])('%s finishes child/workflow snapshots before its response', async method => {
    let release!: () => void
    const held = new Promise<void>(resolve => { release = resolve })
    const listDescendants = vi.fn(async () => {
      await held
      return [{ kind: 'child', id: 'restored-child', mode: 'continuable' }]
    })
    const { registry, client: c } = await start({ subagents: { listDescendants, interrupt() {} } })
    await registry.create({ sessionId: SessionId('restored-child'), meta: {} })
    const operation = method === 'session/load' ? 'resume' : 'create'
    const original = registry[operation].bind(registry)
    vi.spyOn(registry, operation).mockImplementation(async options => {
      const handle = await original(options)
      handle.agent.session.append('tool-workflow/run-start', { runId: 'restored-run', name: 'review' } as never)
      handle.agent.session.append('tool-workflow/agent-start', { runId: 'restored-run', seq: 0, childId: 'restored-child', label: 'worker' } as never)
      return handle
    })
    register(c); await c.next()
    const params = method === 'x.ai/session/fork'
      ? { sourceSessionId: 'persisted-session', newCwd: '/tmp/proj' }
      : { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] }
    sendRequest(c, 1, method, params)
    try {
      await waitFor(() => listDescendants.mock.calls.length > 0)
      // A separate request proves the socket is still responsive and drains
      // any prematurely emitted lifecycle response before this assertion.
      await c.request(99, 'initialize', {})
      expect(c.all.some(message => message.id === 1)).toBe(false)
    } finally { release() }
    expect((await waitForId(c, 1)).error).toBeUndefined()
    const kind = (message: Record<string, unknown>) => (message.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate
    const child = c.all.findIndex(message => kind(message) === 'subagent_spawned')
    const workflow = c.all.findIndex(message => kind(message) === 'workflow_updated')
    const response = c.all.findIndex(message => message.id === 1)
    expect(child).toBeGreaterThanOrEqual(0)
    expect(workflow).toBeGreaterThan(child)
    expect(response).toBeGreaterThan(workflow)
    expect(c.all[workflow]).toMatchObject({ params: { _meta: { isReplay: true } } })
  })
})
