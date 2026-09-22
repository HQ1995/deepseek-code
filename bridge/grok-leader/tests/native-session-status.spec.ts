import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createNativeSessionStatus, type NativeStatusProjections } from '../src/native-session-status.ts'
import type { NativeGoalView } from '../src/projection.ts'
import { createSessionWork } from '../src/session-work.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture() {
  const listeners = new Map<string, (...args: never[]) => void>()
  const stops: Array<ReturnType<typeof vi.fn>> = []
  const on = vi.fn((name: string, listener: (...args: never[]) => void) => {
    listeners.set(name, listener)
    const stop = vi.fn(() => { listeners.delete(name) })
    stops.push(stop); return stop
  })
  const emit = (name: string, ...args: unknown[]) => listeners.get(name)?.(...args as never[])
  const record = (id: string, clientId: number) => { const value = { clientId,
    agent: { status: 'idle', session: { id: SessionId(id) } } as Agent,
    output: { notify: vi.fn(), update: vi.fn(), activity: vi.fn() },
    work: createSessionWork({ isLive: () => sessions.get(SessionId(id)) === value, assertReady: () => {} }),
  }; return value }
  const root = record('root', 1), other = record('other', 2)
  const sessions = new Map([[root.agent.session.id, root], [other.agent.session.id, other]])
  const goals = new Map<Agent, NativeGoalView>()
  const get = vi.fn((agent: Agent) => goals.get(agent)), pause = vi.fn()
  const execute = vi.fn(async (_agent: Agent, _line: string, _images: unknown, _signal: AbortSignal): Promise<{ result: { kind: string; text?: string } } | undefined> => ({ result: { kind: 'success', text: 'native result' } }))
  let changed: (session: unknown, key: string) => void = () => {}
  const stopProjection = vi.fn()
  const projection: NativeStatusProjections = {
    snapshot: vi.fn(() => ({ values: { contextPressure: { projectedTokens: 12, contextWindow: 100 } } })),
    onChanged: listener => { changed = listener; return stopProjection },
  }
  const host = { sessions, owned: (clientId: number, id: SessionId | undefined) => {
    const found = id === undefined ? undefined : sessions.get(id)
    return found?.clientId === clientId ? found : undefined
  }, goals: () => ({ get, pause }), commands: () => ({ execute }), projections: (): NativeStatusProjections | undefined => projection, on }
  const status = createNativeSessionStatus(host)
  const goal = (overrides: Partial<NativeGoalView> = {}): NativeGoalView => ({ id: 'goal', revision: 1, objective: 'finish', phase: 'active', activation: 'disarmed', roundsStarted: 2, maxGoalRounds: 8, ...overrides })
  const command = (text = '/goal pause', clientId = 1) => status.goal(clientId, { sessionId: 'root', prompt: [{ type: 'text', text }] })
  return { status, host, root, other, record, sessions, goals, get, pause, execute, projection, changed: (session: unknown, key: string) => changed(session, key), stopProjection, on, emit, stops, listeners, goal, command }
}

describe('native session status ownership', () => {
  it('observes agent/created only for the exact attached owner', async () => {
    const f = fixture()
    f.goals.set(f.root.agent, f.goal())
    f.emit('agent/created', { agent: { ...f.root.agent }, source: 'fresh' })
    await Promise.resolve()
    expect(f.root.output.notify).not.toHaveBeenCalled()
    f.emit('agent/created', { agent: f.root.agent, source: 'fresh' })
    await Promise.resolve()
    expect(f.root.output.notify).toHaveBeenCalledExactlyOnceWith('x.ai/session_notification', {
      update: expect.objectContaining({ goal_id: 'goal', status: 'disarmed' }),
    }, {})
    expect(f.listeners.has('agent/session-start')).toBe(false)
    await f.status.dispose()
  })

  it('restores snapshots, deduplicates live goals and retains the id in clear tombstones without arming', async () => {
    const f = fixture()
    f.status.snapshot(f.root, true)
    expect(f.root.output.activity).toHaveBeenCalledWith(false)
    expect(f.root.output.notify).toHaveBeenLastCalledWith('x.ai/session_notification', { update: {
      sessionUpdate: 'goal_updated', goal_id: '', objective: '', status: 'cleared', phase: 'idle', is_snapshot: true,
    } }, { isReplay: true })
    f.goals.set(f.root.agent, f.goal())
    f.status.refresh(f.root)
    expect(f.root.output.notify).toHaveBeenLastCalledWith('x.ai/session_notification', { update: expect.objectContaining({ goal_id: 'goal', status: 'disarmed' }) }, {})
    f.status.refresh(f.root)
    expect(f.root.output.notify).toHaveBeenCalledTimes(2)
    f.goals.delete(f.root.agent)
    f.emit('goal/changed', { agent: f.root.agent })
    expect(f.root.output.notify).toHaveBeenLastCalledWith('x.ai/session_notification', { update: expect.objectContaining({ goal_id: 'goal', status: 'cleared' }) }, {})
    f.status.refresh(f.root)
    expect(f.root.output.notify).toHaveBeenCalledTimes(3)
    expect(f.pause).not.toHaveBeenCalled()
    expect(f.execute).not.toHaveBeenCalled()
    await f.status.dispose()
  })

  it('uses the exact agent/session identity and refreshes status after native state changes settle', async () => {
    const f = fixture(), goal = f.goal({ phase: 'complete' })
    f.goals.set(f.root.agent, goal)
    const foreign = { ...f.root.agent }
    f.emit('goal/changed', { agent: foreign })
    f.emit('agent/status', { agent: foreign })
    f.changed({ ...f.root.agent.session }, 'contextPressure')
    expect(f.root.output.notify).not.toHaveBeenCalled()
    expect(f.root.output.activity).not.toHaveBeenCalled()
    expect(f.root.output.update).not.toHaveBeenCalled()
    f.emit('agent/status', { agent: f.root.agent })
    expect(f.root.output.activity).toHaveBeenCalledWith(false)
    expect(f.root.output.notify).not.toHaveBeenCalled()
    f.goals.set(f.root.agent, { ...goal, phase: 'blocked', revision: 2 })
    await Promise.resolve()
    expect(f.root.output.notify).toHaveBeenLastCalledWith('x.ai/session_notification', { update: expect.objectContaining({ status: 'blocked' }) }, {})
    f.goals.set(f.root.agent, { ...goal, phase: 'active', activation: 'armed' })
    f.emit('goal/activation-changed', { sessionId: 'root' })
    expect(f.root.output.notify).toHaveBeenLastCalledWith('x.ai/session_notification', { update: expect.objectContaining({ status: 'armed' }) }, {})
    expect(f.other.output.notify).not.toHaveBeenCalled()
    await f.status.dispose()
  })

  it('projects context lazily and drops retired owners and scheduled updates after disposal', async () => {
    const f = fixture()
    for (const key of ['tokenUsage', 'contextPressure', 'contextBreakdown']) f.changed(f.root.agent.session, key)
    f.changed(f.root.agent.session, 'unrelated')
    expect(f.root.output.update).toHaveBeenCalledTimes(3)
    expect(f.root.output.update).toHaveBeenLastCalledWith({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }, false)
    expect(f.status.contextValues(f.root)).toEqual({ contextPressure: { projectedTokens: 12, contextWindow: 100 } })
    const lateProjection = { ...f.projection, snapshot: vi.fn(() => ({ values: {} })) }
    f.host.projections = () => lateProjection
    expect(f.status.contextValues(f.root)).toEqual({})
    expect(lateProjection.snapshot).toHaveBeenCalledWith(f.root.agent.session, ['tokenUsage', 'contextPressure', 'contextBreakdown'])
    f.changed(f.root.agent.session, 'goal')
    f.emit('agent/created', { agent: f.root.agent, source: 'fresh' })
    f.sessions.set(f.root.agent.session.id, f.record('root', 1))
    f.status.contextValues(f.root)
    expect(lateProjection.snapshot).toHaveBeenCalledTimes(1)
    await f.status.dispose()
    f.changed(f.root.agent.session, 'contextPressure')
    expect(f.root.output.notify).not.toHaveBeenCalled()
    expect(f.root.output.update).toHaveBeenCalledTimes(3)
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
    expect(f.stopProjection).toHaveBeenCalledTimes(1)
  })

  it('pauses only an armed active goal using its current native revision', async () => {
    const f = fixture()
    for (const overrides of [{}, { phase: 'paused' as const, activation: 'armed' as const }, { phase: 'complete' as const }]) {
      f.goals.set(f.root.agent, f.goal(overrides)); f.status.pauseGoal(f.root)
    }
    expect(f.pause).not.toHaveBeenCalled()
    f.goals.set(f.root.agent, f.goal({ activation: 'armed', revision: 5 }))
    f.status.pauseGoal(f.root)
    expect(f.pause).toHaveBeenCalledExactlyOnceWith(f.root.agent, { id: 'goal', revision: 5 })
    f.sessions.delete(f.root.agent.session.id)
    f.status.pauseGoal(f.root)
    expect(f.pause).toHaveBeenCalledTimes(1)
    await f.status.dispose()
  })

  it('validates scoped goal invocations and returns only a validated native result', async () => {
    const f = fixture()
    await expect(f.command('/goal pause', 2)).rejects.toMatchObject({ code: -32602 })
    await expect(f.command('/goalkeeper')).rejects.toMatchObject({ code: -32602 })
    await expect(f.status.goal(1, null)).rejects.toMatchObject({ code: -32602 })
    await expect(f.status.goal(1, { sessionId: 'root', prompt: 'not-blocks' })).rejects.toMatchObject({ code: -32602 })
    expect(f.execute).not.toHaveBeenCalled()
    const image = { type: 'image', mimeType: 'image/png', data: 'aW1hZ2U=' }
    expect(await f.status.goal(1, { sessionId: 'root', prompt: [{ type: 'text', text: ' /GOAL status' }, image] })).toEqual({ result: { kind: 'success', text: 'native result' } })
    expect(f.execute).toHaveBeenCalledWith(f.root.agent, ' /GOAL status', [{ mediaType: 'image/png', data: image.data }], expect.any(AbortSignal))
    f.execute.mockResolvedValueOnce(undefined)
    await expect(f.command()).rejects.toThrow('unavailable')
    f.execute.mockResolvedValueOnce({ result: { kind: 'success' } })
    await expect(f.command()).rejects.toMatchObject({ code: -32603 })
    f.execute.mockRejectedValueOnce(new Error('native failure'))
    await expect(f.command()).rejects.toThrow('native failure')
    await f.status.dispose()
  })

  it('aborts withdrawn ownership and rejects late success without cancelling other sessions', async () => {
    const f = fixture(), held = deferred<never>()
    f.execute.mockImplementationOnce(async () => held.promise)
    const work = f.command()
    const rejected = expect(work).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
    const signal = f.execute.mock.calls[0]![3]
    f.sessions.set(f.root.agent.session.id, f.record('root', 2))
    f.status.poll()
    expect(signal.aborted).toBe(true)
    held.resolve({ result: { kind: 'success', text: 'too late' } } as never)
    await rejected
    expect(f.other.output.notify).not.toHaveBeenCalled()
    await f.status.dispose()
    await expect(f.command()).rejects.toMatchObject({ code: -32602 })
  })

  it('drains a command even when native execution reenters disposal before yielding', async () => {
    const f = fixture(), held = deferred<never>(), entered = deferred<void>()
    let disposal!: Promise<void>, drained = false
    f.execute.mockImplementationOnce(async (_agent, _line, _images, signal) => {
      disposal = f.status.dispose()
      void disposal.then(() => { drained = true })
      expect(signal.aborted).toBe(true)
      entered.resolve()
      return held.promise
    })
    const work = f.command()
    const rejected = expect(work).rejects.toThrow('session closed')
    await entered.promise
    await Promise.resolve()
    try {
      expect(drained).toBe(false)
      expect(f.status.dispose()).toBe(disposal)
    } finally { held.resolve({ result: { kind: 'success', text: 'late' } } as never) }
    await rejected; await disposal
    expect(drained).toBe(true)
  })

  it('attempts every unsubscribe and drains accepted commands despite cleanup failure', async () => {
    const f = fixture(), held = deferred<never>()
    f.execute.mockImplementationOnce(async () => held.promise)
    const work = f.command(), rejected = expect(work).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.execute).toHaveBeenCalledTimes(1))
    f.stops[0]!.mockImplementationOnce(() => { throw new Error('stop failed') })
    let done = false
    const disposal = f.status.dispose()
    const failed = expect(disposal).rejects.toMatchObject({ errors: [expect.objectContaining({ message: 'stop failed' })] })
    void disposal.then(() => { done = true }, () => { done = true })
    await Promise.resolve()
    expect(done).toBe(false)
    expect(f.execute.mock.calls[0]![3].aborted).toBe(true)
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
    expect(f.stopProjection).toHaveBeenCalledTimes(1)
    held.resolve({ result: { kind: 'success', text: 'late' } } as never)
    await rejected; await failed
    // A producer retaining a failed-unsubscribe callback still cannot emit.
    f.emit('goal/changed', { agent: f.root.agent, change: { ref: { id: 'late' } } })
    expect(f.root.output.notify).not.toHaveBeenCalled()
  })

  it('shares disposal during unsubscribe reentry and prevents not-yet-started work from reaching native code', async () => {
    const f = fixture()
    let reentered: Promise<void> | undefined
    f.stops[0]!.mockImplementationOnce(() => { reentered = f.status.dispose() })
    const work = f.command()
    const rejected = expect(work).rejects.toMatchObject({ code: -32602 })
    const disposal = f.status.dispose()
    expect(reentered).toBe(disposal)
    await disposal; await rejected
    expect(f.execute).not.toHaveBeenCalled()
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
  })

  it('rolls back partial construction when a native subscription cannot be registered', async () => {
    const f = fixture()
    await f.status.dispose()
    f.on.mockClear(); f.stops.length = 0
    f.host.projections = () => { throw new Error('projection unavailable') }
    expect(() => createNativeSessionStatus(f.host)).toThrow('subscription setup failed')
    expect(f.stops).toHaveLength(4)
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
    expect(f.listeners.size).toBe(0)
  })
})
