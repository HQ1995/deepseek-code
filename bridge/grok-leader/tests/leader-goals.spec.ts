/** Leader socket spec: leader native goals. */
import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createAssistantMessage } from '@deepseek-ai/dsh-llm'
import type { NativeGoalView } from '../src/projection.ts'
import { makeClient, mockAttachments, register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader native goals', () => {
  const start = useLeaderHarness()

  it('streams native goal output before settlement and reconciles missing durable chunks once', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const createdResult = created.result as { sessionId: string }
    const sessionId = createdResult.sessionId
    const agent = registry.byId.get(sessionId)!
    const beforeStream = c.all.length
    const startFrame = { type: 'start', attemptId: 'attempt-1', revision: 1, turn: 0, step: 0 } as const
    const reasoning = { type: 'reasoning-delta', index: 0, text: 'reasoning' } as const
    const answer = { type: 'text-delta', index: 1, text: 'answer' } as const
    pluginCtx.emit('agent/assistant-stream', { agent, frame: startFrame } as never)
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'chunk', attemptId: 'attempt-1', revision: 2, index: 0, time: 10, chunk: reasoning } } as never)
    const thought = await c.next()
    expect(thought).toMatchObject({ method: 'session/update', params: { update: { sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'reasoning' } }, _meta: { agentTimestampMs: 10 } } })
    const thoughtParams = thought.params as { _meta: object }
    expect(thoughtParams._meta).not.toHaveProperty('promptId')
    const chunkFrame = { type: 'chunk', attemptId: 'attempt-1', revision: 4, index: 2, time: 12, chunk: answer } as const
    pluginCtx.emit('agent/assistant-stream', { agent, frame: chunkFrame } as never)
    expect(await c.next()).toMatchObject({ params: { update: { sessionUpdate: 'agent_message_chunk', content: { text: 'answer' } } } })
    // Duplicate chunks and starts must not reset delivered positions.
    pluginCtx.emit('agent/assistant-stream', { agent, frame: chunkFrame } as never)
    pluginCtx.emit('agent/assistant-stream', { agent, frame: startFrame } as never)
    // A different durable message in the same step is not this live attempt.
    pluginCtx.emit('session/event', agent.session, { type: 'assistant/message', seq: 0, time: 12, surfaceOp: 'append', data: {
      turn: 0, step: 0, stream: [{ type: 'text-chunks', time0: 12, index: 0, dt: [], texts: ['independent'] }],
      message: createAssistantMessage({ content: [{ type: 'text', text: 'independent' }], source: { provider: 'deepseek', model: 'chat' } }),
    } } as never)
    pluginCtx.emit('session/event', agent.session, {
      type: 'assistant/message', seq: 1, time: 13, surfaceOp: 'append', data: {
        turn: 0, step: 0,
        stream: [
          { type: 'chunk', time: 10, chunk: reasoning },
          { type: 'reasoning-chunks', time0: 11, index: 0, dt: [], texts: [' recovered'] },
          { type: 'chunk', time: 12, chunk: answer },
        ],
        message: createAssistantMessage({ content: [{ type: 'reasoning', text: 'reasoning recovered' }, { type: 'text', text: 'answer' }], source: { provider: 'deepseek', model: 'chat' } }),
        usage: { inputTokens: 1, outputTokens: 5, cacheReadTokens: 999, cacheWriteTokens: 0 },
      },
    } as never)
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { type: 'end', attemptId: 'attempt-1', revision: 5, index: 3, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 1 } } } as never)
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: 'independent' } } } })
    expect(await c.next()).toMatchObject({ params: { update: { sessionUpdate: 'agent_thought_chunk', content: { text: ' recovered' } } } })
    expect(await c.next()).toMatchObject({ params: { update: { content: { text: '' } }, _meta: { cumulativeTokens: 1005, cacheHitPercent: '99.9' } } })
    pluginCtx.emit('agent/assistant-stream', { agent, frame: { ...chunkFrame, index: 3 } } as never)
    await c.request(2, 'x.ai/session/info', { sessionId })
    const updates = c.all.slice(beforeStream).filter(message => message.method === 'session/update').map(message => message.params as { update: { content?: { text: string } }; _meta: { eventSeq: number } })
    expect(updates.map(item => item.update.content?.text)).toEqual(['reasoning', 'answer', 'independent', ' recovered', ''])
    expect(updates.every((item, index) => index === 0 || item._meta.eventSeq > updates[index - 1]!._meta.eventSeq)).toBe(true)
  })

  it('hydrates completed goals on load and fork without presenting a fresh completion', async () => {
    let goal: NativeGoalView | undefined = { id: 'done', revision: 5, objective: 'finished', phase: 'complete', activation: 'disarmed', roundsStarted: 3, maxGoalRounds: 3 }
    const get = vi.fn((_agent: Agent) => goal)
    const { registry, client: c } = await start({ goals: { get, pause: vi.fn() } })
    register(c); await c.next()
    expect((await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })).error).toBeUndefined()
    expect(get).toHaveBeenCalledWith(registry.byId.get('persisted-session'))
    expect(c.all).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ sessionId: 'persisted-session', update: expect.objectContaining({ goal_id: 'done', status: 'complete', is_snapshot: true }), _meta: expect.objectContaining({ isReplay: true }) }) }))
    const forkId = '22222222-2222-4222-8222-222222222222'
    expect((await c.request(2, 'x.ai/session/fork', { sourceSessionId: 'persisted-session', newSessionId: forkId, newCwd: '/tmp/proj' })).error).toBeUndefined()
    expect(get).toHaveBeenCalledWith(registry.byId.get(forkId))
    expect(c.all).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ sessionId: forkId, update: expect.objectContaining({ goal_id: 'done', status: 'complete', is_snapshot: true }) }) }))
    goal = undefined
    expect((await c.request(3, 'session/load', { sessionId: forkId, cwd: '/tmp/proj', mcpServers: [] })).error).toBeUndefined()
    expect(c.all).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ sessionId: forkId, update: expect.objectContaining({ goal_id: '', status: 'cleared', is_snapshot: true }) }) }))
  })

  it('hydrates goals, preserves dormant activation, pauses armed idle goals and emits clear tombstones', async () => {
    let goal: NativeGoalView | undefined = { id: 'native-goal', revision: 1, objective: 'finish', phase: 'active', activation: 'armed', roundsStarted: 0, maxGoalRounds: 3 }
    const get = vi.fn(() => goal)
    const pause = vi.fn((_agent: Agent, ref: { id: string; revision: number }) => { expect(ref).toEqual({ id: goal!.id, revision: goal!.revision }); goal = { ...goal!, phase: 'paused', activation: 'disarmed', revision: goal!.revision + 1 } })
    const { registry, pluginCtx, client: c } = await start({ goals: { get, pause } })
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    expect(get).toHaveBeenCalledWith(agent)
    expect(c.all).toContainEqual(expect.objectContaining({ params: expect.objectContaining({ update: expect.objectContaining({ sessionUpdate: 'goal_updated', is_snapshot: true, status: 'armed' }) }) }))
    goal = { ...goal!, activation: 'disarmed', roundsStarted: 1 }
    pluginCtx.emit('goal/activation-changed', { sessionId, activation: 'disarmed' } as never)
    await waitFor(() => c.all.some(msg => JSON.stringify(msg).includes('"rounds_started":1')))
    const dormant = { ...goal }
    c.notify('session/cancel', { sessionId })
    await waitFor(() => agent.internals.cancelCalls === 1)
    expect(pause.mock.calls.length).toBe(0)
    expect(goal).toEqual(dormant)
    goal = { ...goal, activation: 'armed' }
    c.notify('session/cancel', { sessionId })
    await waitFor(() => pause.mock.calls.length === 1)
    expect(agent.internals.cancelCalls).toBe(2)
    expect(goal.phase).toBe('paused')
    goal = undefined
    pluginCtx.emit('goal/changed', { agent, change: { operation: 'clear', ref: { id: 'native-goal', revision: 3 } } })
    await waitFor(() => c.all.some(msg => JSON.stringify(msg).includes('"status":"cleared"')))
    expect(agent.internals.followups).toEqual([])
  })

  it('executes x.ai/goal immediately beside a held model prompt and queued prompt without settling or notifying either', async () => {
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown[], _signal: AbortSignal) => ({
      commandId: 'native-goal', result: { kind: 'success', text: 'native goal updated' },
    }))
    const saveImages = vi.fn(mockAttachments.saveImages)
    const { registry, client: c } = await start({
      manualIdle: true, commands: { list: () => [], execute }, attachments: { saveImages },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'held' }], _meta: { promptId: 'held' } })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'queued' }], _meta: { promptId: 'queued' } })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'queued')))
    const before = c.all.length
    const queues = [...c.broadcasts]
    const completes = [...c.completes]
    // Enqueue registers a second whenIdle waiter for queue promotion before
    // broadcasting the row; snapshot both it and the held prompt's waiter.
    const idleWaiters = [...agent.internals.idleWaiters]
    expect(idleWaiters).toHaveLength(2)
    const raw = '  /goal set  preserve "quoted args"  --max-rounds 7  '
    const response = await c.request(4, 'x.ai/goal', {
      sessionId,
      prompt: [{ type: 'text', text: raw }, { type: 'image', data: 'AQID', mimeType: 'image/png' }],
    })
    expect(response.result).toEqual({ result: { kind: 'success', text: 'native goal updated' } })
    expect(execute).toHaveBeenCalledTimes(1)
    expect(execute.mock.calls[0]![0]).toBe(agent)
    expect(execute.mock.calls[0]![1]).toBe(raw)
    expect(execute.mock.calls[0]![2]).toEqual([{ data: 'AQID', mediaType: 'image/png' }])
    const signal = execute.mock.calls[0]![3]
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    expect(saveImages).not.toHaveBeenCalled()
    expect(agent.internals.followups).toEqual(['held'])
    expect(agent.internals.steered).toEqual([])
    expect(agent.internals.cancelCalls).toBe(0)
    expect(agent.internals.status).toBe('running')
    expect(agent.internals.idleWaiters).toEqual(idleWaiters)
    expect(c.broadcasts).toEqual(queues)
    expect(c.completes).toEqual(completes)
    expect(c.all.slice(before).filter(m => m.method === 'session/update')).toEqual([])
    expect(c.all.some(m => m.id === 2 || m.id === 3)).toBe(false)

    await c.request(5, 'x.ai/goal', { sessionId, prompt: [{ type: 'text', text: '/goal status' }] })
    expect(execute.mock.calls[1]![3]).not.toBe(signal)
    expect(execute.mock.calls[1]![3].aborted).toBe(false)
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'held' } })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('queued'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'queued' } })
    expect(agent.internals.followups).toEqual(['held', 'queued'])
    expect(signal.aborted).toBe(false)
    expect(c.completes).toHaveLength(completes.length + 2)
  })

  it.each(['success', 'error'])('returns native %s over x.ai/goal and preserves its outcome over session/prompt', async (kind) => {
    const result = { kind, text: 'native admission response' }
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown[], _signal: AbortSignal) => ({ commandId: 'goal', result }))
    const { registry, client: c } = await start({ commands: { list: () => [], execute } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const prompt = [{ type: 'text', text: ' /goal status  ' }]
    const before = c.all.length
    expect((await c.request(2, 'x.ai/goal', { sessionId, prompt })).result).toEqual({ result })
    expect(c.all.slice(before).filter(m => m.method === 'session/update')).toEqual([])
    expect(c.completes).toEqual([])
    const response = await c.request(3, 'session/prompt', { sessionId, prompt, _meta: { promptId: 'native-headless' } })
    if (kind === 'error') {
      expect(response.error).toMatchObject({ code: -32602, message: result.text })
      expect(c.all.slice(before).filter(m => m.method === 'session/update')).toEqual([])
    } else {
      expect(response.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'native-headless' } })
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && (m.params as { update?: { content?: { text?: string } } }).update?.content?.text === result.text))
    }
    expect(execute.mock.calls.map(call => call[1])).toEqual([' /goal status  ', ' /goal status  '])
    expect(execute.mock.calls.every(call => call[0] === agent && call[3] instanceof AbortSignal && !call[3].aborted)).toBe(true)
    expect(agent.internals.followups).toEqual([])
  })

  it('delegates goal attachment admission and native throws without model I/O or attachment persistence', async () => {
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown[], _signal: AbortSignal) => {
      throw new Error('native goal rejects attachments')
    })
    const saveImages = vi.fn(mockAttachments.saveImages)
    const { registry, client: c } = await start({ commands: { list: () => [], execute }, attachments: { saveImages } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    for (const [index, method] of ['x.ai/goal', 'session/prompt'].entries()) {
      const response = await c.request(index + 2, method, {
        sessionId, prompt: [{ type: 'text', text: '/goal status' }, { type: 'image', data: 'AQID', mimeType: 'image/png' }],
      })
      expect(response.error).toMatchObject({ code: -32603, message: expect.stringContaining('native goal rejects attachments') })
      expect(execute.mock.calls[index]![0]).toBe(registry.byId.get(sessionId))
      expect(execute.mock.calls[index]![2]).toEqual([{ data: 'AQID', mediaType: 'image/png' }])
    }
    expect(execute).toHaveBeenCalledTimes(2)
    expect(saveImages).not.toHaveBeenCalled()
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual([])
    expect(c.completes).toEqual([])
  })

  it('requires the exact owned session for x.ai/goal including absent unknown and other-client IDs', async () => {
    const execute = vi.fn(async () => ({ commandId: 'goal', result: { kind: 'success', text: 'ok' } }))
    const { socketPath, client: c } = await start({ commands: { list: () => [], execute } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const other = await makeClient(socketPath)
    try {
      register(other)
      await other.next()
      await other.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      for (const [index, id] of [undefined, 'unknown-goal-session', '', 42, null].entries()) {
        expect((await c.request(index + 2, 'x.ai/goal', { sessionId: id, prompt: [{ type: 'text', text: '/goal status' }] })).error)
          .toMatchObject({ code: -32602 })
      }
      expect((await other.request(2, 'x.ai/goal', { sessionId, prompt: [{ type: 'text', text: '/goal status' }] })).error)
        .toMatchObject({ code: -32602 })
      expect(execute).not.toHaveBeenCalled()
    } finally {
      other.socket.destroy()
    }
  })

  it('rejects invalid goal invocations ACP shapes and image fields before registry execution', async () => {
    const execute = vi.fn(async () => ({ commandId: 'goal', result: { kind: 'success', text: 'ok' } }))
    const { registry, client: c } = await start({ commands: { list: () => [], execute } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const invalidPrompts = [
      undefined, null, '/goal status', [], [null], [{ type: 'text', text: 7 }],
      [{ type: 'text', text: 'ordinary prompt' }], [{ type: 'text', text: '/goals status' }],
      [{ type: 'text', text: '/auto' }], [{ type: 'audio', data: 'AQID', mimeType: 'audio/wav' }],
      [{ type: 'text', text: '/goal status' }, { type: 'image', data: 7, mimeType: 'image/png' }],
      [{ type: 'text', text: '/goal status' }, { type: 'image', data: 'AQID', mimeType: 'image/svg+xml' }],
      [{ type: 'text', text: '/goal status' }, { type: 'image', mimeType: 'image/png' }],
    ]
    for (const [index, prompt] of invalidPrompts.entries()) {
      expect((await c.request(index + 2, 'x.ai/goal', { sessionId, prompt })).error, `invalid prompt case ${index}: ${JSON.stringify(prompt)}`).toMatchObject({ code: -32602 })
    }
    // The shared parser must classify null/primitive/array blocks before any
    // type projection on both native controls and the ordinary prompt route.
    for (const [index, block] of [null, false, 7, 'text', []].entries()) {
      expect((await c.request(40 + index, 'session/prompt', { sessionId, prompt: [block] })).error)
        .toMatchObject({ code: -32602, message: 'prompt content blocks must be objects' })
    }
    expect((await c.request(30, 'x.ai/goal', null)).error).toMatchObject({ code: -32602 })
    expect(execute).not.toHaveBeenCalled()
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual([])
    expect(c.completes).toEqual([])
  })

  it.each([
    ['missing result', {}],
    ['missing text', { result: { kind: 'success' } }],
    ['non-string text', { result: { kind: 'error', text: 7 } }],
    ['missing kind', { result: { text: 'ok' } }],
    ['non-string kind', { result: { kind: 7, text: 'ok' } }],
  ])('fails malformed native goal output closed: %s', async (_name, execution) => {
    const { registry, client: c } = await start({ commands: { list: () => [], execute: async () => execution } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    for (const [index, method] of ['x.ai/goal', 'session/prompt'].entries()) {
      expect((await c.request(index + 2, method, { sessionId, prompt: [{ type: 'text', text: '/goal status' }] })).error)
        .toMatchObject({ code: -32603 })
    }
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual([])
    expect(c.completes).toEqual([])
  })

  it.each(['no registry', 'undefined execution'])('rejects unavailable native goal before model I/O for both routes: %s', async (availability) => {
    const execute = vi.fn(async () => undefined)
    const { registry, client: c } = await start({
      ...(availability === 'no registry' ? {} : { commands: { list: () => [], execute } }),
      llm: { listProviders: () => [], listConfigurableProviders: () => [], listModels: async () => [] },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    for (const [index, method] of ['x.ai/goal', 'session/prompt'].entries()) {
      expect((await c.request(index + 2, method, { sessionId, prompt: [{ type: 'text', text: '/goal status' }] })).error)
        .toMatchObject({ code: -32602, message: expect.stringContaining('unavailable') })
    }
    expect(execute).toHaveBeenCalledTimes(availability === 'no registry' ? 0 : 2)
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual([])
    expect(c.completes).toEqual([])
  })

  it('refuses /auto before a conflicting registry command without model I/O or permission mutation', async () => {
    const execute = vi.fn(async () => ({ commandId: 'auto', result: { kind: 'success', text: 'must not execute' } }))
    const setPermission = vi.fn()
    const setPlan = vi.fn()
    const { registry, client: c } = await start({
      commands: { list: () => [{ name: 'auto', description: 'Conflicting registration' }], execute },
      permissionPresets: { set: setPermission }, planMode: { set: setPlan },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { permissionMode: 'ask' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    setPermission.mockClear()
    setPlan.mockClear()
    expect((await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/auto on' }] })).error)
      .toMatchObject({ code: -32602, message: expect.stringContaining('/auto is unsupported') })
    expect(c.all.filter(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('/auto is unsupported'))).toEqual([])
    expect(execute).not.toHaveBeenCalled()
    expect(setPermission).not.toHaveBeenCalled()
    expect(setPlan).not.toHaveBeenCalled()
    expect(registry.byId.get(sessionId)!.internals.followups).toEqual([])
  })

  it('keeps an executing x.ai/goal signal live when the held model prompt is cancelled', async () => {
    let releaseGoal!: () => void
    const gate = new Promise<void>(resolve => { releaseGoal = resolve })
    const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown[], _signal: AbortSignal) => {
      await gate
      return { commandId: 'goal', result: { kind: 'success', text: 'native completed after cancel' } }
    })
    const { registry, client: c } = await start({ manualIdle: true, commands: { list: () => [], execute } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const result = created.result
    if (typeof result !== 'object' || result === null || !('sessionId' in result) || typeof result.sessionId !== 'string') {
      throw new Error('session/new did not return a session ID')
    }
    const sessionId = result.sessionId
    const agent = registry.byId.get(sessionId)!
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'held' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'x.ai/goal', { sessionId, prompt: [{ type: 'text', text: '/goal status' }] })
    await waitFor(() => execute.mock.calls.length === 1)
    const signal = execute.mock.calls[0]![3]
    c.notify('session/cancel', { sessionId })
    await waitFor(() => agent.internals.cancelCalls === 1)
    expect(signal).toBeInstanceOf(AbortSignal)
    expect(signal.aborted).toBe(false)
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(c.all.some(message => message.id === 3)).toBe(false)
    releaseGoal()
    expect((await waitForId(c, 3)).result).toEqual({ result: { kind: 'success', text: 'native completed after cancel' } })
    expect(signal.aborted).toBe(false)
    expect(agent.internals.followups).toEqual(['held'])
  })
})
