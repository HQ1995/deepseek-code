import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionRegistry, type OwnedSession } from '../src/session-registry.ts'
import { createSessionWork } from '../src/session-work.ts'

function fixture() {
  const live = new Set([1, 2])
  const flush = vi.fn(async (_session: Agent['session']) => {})
  const cancelRequests = vi.fn()
  const warn = vi.fn()
  const registry = createSessionRegistry<OwnedSession>({ clientIsLive: id => live.has(id), flush, cancelRequests, logger: { warn } })
  const record = (id = 'session', clientId = 1): OwnedSession => ({
    clientId,
    // The registry consumes identity and lifecycle, not an agent runtime.
    agent: { session: { id: SessionId(id) }, whenIdle: vi.fn(async () => {}) } as unknown as Agent,
    queue: { cancel: vi.fn(), dispose: vi.fn(async () => {}) },
    work: { cancel: vi.fn(), settle: vi.fn(async () => {}), dispose: vi.fn(async () => {}) },
    mcpInitTimer: undefined,
    dispose: vi.fn(async () => {}),
  })
  return { live, flush, cancelRequests, warn, registry, record }
}

describe('owned session registry', () => {
  it('withdraws and aborts immediately but waits for native work before final flush and disposal', async () => {
    const f = fixture(), record = f.record(), gate = Promise.withResolvers<void>(), entered = vi.fn()
    const work = createSessionWork({ isLive: () => f.registry.acceptsInput(record), assertReady: () => f.registry.assertReady(record) })
    record.work = work
    await f.registry.publish(record.agent.session.id, record)
    let signal!: AbortSignal
    const operation = work.run(async scope => { signal = scope.signal; entered(); await gate.promise })
    const rejected = expect(operation).rejects.toThrow('session closed')
    const closing = f.registry.close(record)
    expect(entered).toHaveBeenCalledOnce(); expect(signal.aborted).toBe(true)
    expect(f.registry.ownedAgent(record.agent)).toBeUndefined()
    await Promise.resolve(); await Promise.resolve()
    expect(f.flush).not.toHaveBeenCalled(); expect(record.dispose).not.toHaveBeenCalled()
    gate.resolve(); await rejected; await closing
    expect(f.flush).toHaveBeenCalledOnce(); expect(record.dispose).toHaveBeenCalledOnce()
    expect(f.flush.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(record.dispose).mock.invocationCallOrder[0]!)
  })

  it('reload aborts old native work, settles it before capture, and permits new work after failed flush', async () => {
    const f = fixture(), record = f.record(), gate = Promise.withResolvers<void>(), mutation = vi.fn()
    const work = createSessionWork({ isLive: () => f.registry.acceptsInput(record), assertReady: () => f.registry.assertReady(record) })
    record.work = work
    await f.registry.publish(record.agent.session.id, record)
    const operation = work.run(async scope => { await gate.promise; scope.assertActive(); mutation() })
    const rejected = expect(operation).rejects.toThrow('session closed')
    f.flush.mockRejectedValueOnce(new Error('preflight flush failed'))
    const capture = vi.fn(), reload = f.registry.reload(record, capture)
    const failed = expect(reload).rejects.toThrow('preflight flush failed')
    await expect(work.run(async () => mutation())).rejects.toThrow('already reloading')
    await Promise.resolve(); expect(record.agent.whenIdle).not.toHaveBeenCalled()
    gate.resolve(); await rejected; await failed
    expect(mutation).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
    expect(f.registry.ownedAgent(record.agent)).toBe(record)
    await expect(work.run(async () => 'usable')).resolves.toBe('usable')
    await f.registry.dispose()
  })

  it('does not skip native settlement when a parallel model settlement fails', async () => {
    const f = fixture(), record = f.record(), gate = Promise.withResolvers<void>(), model = new Error('model settle failed')
    const work = createSessionWork({ isLive: () => f.registry.acceptsInput(record), assertReady: () => f.registry.assertReady(record) })
    record.work = work
    await f.registry.publish(record.agent.session.id, record)
    const operation = work.run(async () => gate.promise), rejected = expect(operation).rejects.toThrow('session closed')
    const reload = f.registry.reload(record, vi.fn(), async () => { throw model })
    const failed = expect(reload).rejects.toBe(model)
    let settled = false; void reload.catch(() => { settled = true })
    await Promise.resolve(); await Promise.resolve(); expect(settled).toBe(false)
    gate.resolve(); await rejected; await failed
    expect(f.flush).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it.each(['prompt', 'requests', 'work'])('reload attempts every cancellation and drains before reopening after a %s cancellation failure', async failure => {
    const f = fixture(), record = f.record(), gate = Promise.withResolvers<void>(), modelGate = Promise.withResolvers<void>(), mutation = vi.fn()
    const error = new Error(failure + ' cancellation failed')
    const work = createSessionWork({ isLive: () => f.registry.acceptsInput(record), assertReady: () => f.registry.assertReady(record) })
    record.work = work
    const cancel = work.cancel, cancelWork = vi.spyOn(work, 'cancel')
    record.mcpInitTimer = setTimeout(() => {}, 10_000)
    record.mcpInitTimer.unref()
    if (failure === 'prompt') vi.mocked(record.queue.cancel).mockImplementationOnce(() => { throw error })
    else if (failure === 'requests') f.cancelRequests.mockImplementationOnce(() => { throw error })
    else cancelWork.mockImplementationOnce(() => { cancel(); throw error })
    await f.registry.publish(record.agent.session.id, record)
    let signal!: AbortSignal
    const operation = work.run(async scope => { signal = scope.signal; await gate.promise; scope.assertActive(); mutation() })
    const rejected = operation.catch(reason => reason)
    const capture = vi.fn(), model = vi.fn(() => modelGate.promise)
    const reload = f.registry.reload(record, capture, model)
    let done = false
    const failed = reload.catch(reason => { done = true; return reason })
    // Release gates before assertions so a regression never leaves native work hanging.
    await Promise.resolve(); await Promise.resolve()
    const during = { done, ready: f.registry.acceptsInput(record), aborted: signal.aborted }
    gate.resolve()
    await operation.catch(() => {})
    await Promise.resolve()
    const beforeModel = done
    modelGate.resolve()
    expect(await failed).toBe(error)
    expect(during).toEqual({ done: false, ready: false, aborted: true })
    expect(beforeModel).toBe(false)
    expect(await rejected).toEqual(expect.objectContaining({ message: 'session closed' }))
    expect(record.queue.cancel).toHaveBeenCalledOnce()
    expect(f.cancelRequests).toHaveBeenCalledOnce()
    expect(cancelWork).toHaveBeenCalledOnce()
    expect(record.mcpInitTimer).toBeUndefined()
    expect(model).toHaveBeenCalledOnce()
    expect(mutation).not.toHaveBeenCalled(); expect(capture).not.toHaveBeenCalled()
    expect(record.agent.whenIdle).not.toHaveBeenCalled(); expect(f.flush).not.toHaveBeenCalled()
    await expect(work.run(async () => 'ready again')).resolves.toBe('ready again')
    await f.registry.dispose()
  })

  it('close waits for an in-flight reload flush before final flush and native disposal', async () => {
    const f = fixture(), record = f.record(), flushEntered = Promise.withResolvers<void>(), flushGate = Promise.withResolvers<void>(), order: string[] = []
    await f.registry.publish(record.agent.session.id, record)
    f.flush.mockImplementationOnce(async () => { order.push('reload flush'); flushEntered.resolve(); await flushGate.promise; order.push('reload flushed') })
    f.flush.mockImplementation(async () => { order.push('close flush') })
    record.dispose = vi.fn(async () => { order.push('dispose') })
    const capture = vi.fn(), reload = f.registry.reload(record, capture)
    const failed = expect(reload).rejects.toThrow('session closed')
    await flushEntered.promise
    let closed = false
    const closing = f.registry.close(record).then(() => { closed = true })
    // The record is withdrawn immediately, but its borrowed native store must remain live.
    expect(f.registry.ownedAgent(record.agent)).toBeUndefined()
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    const beforeRelease = { closed, order: [...order] }
    flushGate.resolve()
    await failed; await closing
    expect(beforeRelease).toEqual({ closed: false, order: ['reload flush'] })
    expect(order).toEqual(['reload flush', 'reload flushed', 'close flush', 'dispose'])
    expect(capture).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it('preserves every cancellation and settlement failure, including synchronous throws', async () => {
    const f = fixture(), record = f.record()
    const failures = ['prompt', 'requests', 'work', 'model settlement', 'work settlement'].map(label => new Error(label))
    vi.mocked(record.queue.cancel).mockImplementationOnce(() => { throw failures[0] })
    f.cancelRequests.mockImplementationOnce(() => { throw failures[1] })
    vi.mocked(record.work.cancel).mockImplementationOnce(() => { throw failures[2] })
    vi.mocked(record.work.settle).mockImplementationOnce(() => { throw failures[4] })
    await f.registry.publish(record.agent.session.id, record)
    const result = await f.registry.reload(record, vi.fn(), () => { throw failures[3] }).catch(error => error)
    expect(result).toBeInstanceOf(AggregateError)
    expect(result.errors).toEqual(failures)
    expect(f.registry.acceptsInput(record)).toBe(true)
    expect(f.flush).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it('publishes the reload borrow before a cancellation callback can reenter close', async () => {
    const f = fixture(), record = f.record(), modelGate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    await f.registry.publish(record.agent.session.id, record)
    let closing!: Promise<void>
    f.cancelRequests.mockImplementationOnce(() => { closing = f.registry.close(record) })
    const reload = f.registry.reload(record, vi.fn(), async () => { entered.resolve(); await modelGate.promise })
    const failed = expect(reload).rejects.toThrow('session closed')
    await entered.promise
    await Promise.resolve(); await Promise.resolve()
    const disposedEarly = vi.mocked(record.dispose).mock.calls.length
    modelGate.resolve()
    await failed; await closing
    expect(disposedEarly).toBe(0)
    expect(record.agent.whenIdle).not.toHaveBeenCalled()
    expect(record.dispose).toHaveBeenCalledOnce()
    await f.registry.dispose()
  })

  it('does not publish a snapshot if capture reenters close', async () => {
    const f = fixture(), record = f.record()
    await f.registry.publish(record.agent.session.id, record)
    let closing!: Promise<void>
    const reload = f.registry.reload(record, () => { closing = f.registry.close(record); return 'retired snapshot' })
    await expect(reload).rejects.toThrow('session closed')
    await closing
    expect(record.dispose).toHaveBeenCalledOnce()
    await f.registry.dispose()
  })

  it('keeps async capture borrowed and input closed until capture resolves, then retires', async () => {
    const f = fixture(), record = f.record(), gate = Promise.withResolvers<string>(), entered = Promise.withResolvers<void>()
    await f.registry.publish(record.agent.session.id, record)
    const reload = f.registry.reload(record, async () => { entered.resolve(); return gate.promise })
    await entered.promise
    const before = { owned: f.registry.ownedAgent(record.agent), ready: f.registry.acceptsInput(record), disposals: vi.mocked(record.dispose).mock.calls.length }
    gate.resolve('complete prefix')
    await expect(reload).resolves.toBe('complete prefix')
    expect(before).toEqual({ owned: record, ready: false, disposals: 0 })
    expect(record.dispose).toHaveBeenCalledOnce()
    await f.registry.dispose()
  })

  it('reopens admission after async capture rejects without retiring the native owner', async () => {
    const f = fixture(), record = f.record(), failure = new Error('read failed')
    await f.registry.publish(record.agent.session.id, record)
    await expect(f.registry.reload(record, async () => { await Promise.resolve(); throw failure })).rejects.toBe(failure)
    expect(f.registry.acceptsInput(record)).toBe(true)
    expect(record.dispose).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it('releases the reload borrow on flush failure while close retains its own cleanup failure', async () => {
    const f = fixture(), record = f.record(), entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<void>()
    const reloadError = new Error('reload storage failure'), closeError = new Error('close storage failure')
    await f.registry.publish(record.agent.session.id, record)
    f.flush.mockImplementationOnce(async () => { entered.resolve(); await gate.promise; throw reloadError })
    f.flush.mockRejectedValueOnce(closeError)
    const reload = f.registry.reload(record, vi.fn()), failedReload = expect(reload).rejects.toBe(reloadError)
    await entered.promise
    const closing = f.registry.close(record), failedClose = expect(closing).rejects.toMatchObject({ errors: [closeError] })
    await Promise.resolve(); await Promise.resolve()
    const disposedEarly = vi.mocked(record.dispose).mock.calls.length
    gate.resolve()
    await failedReload; await failedClose
    expect(disposedEarly).toBe(0)
    expect(record.dispose).toHaveBeenCalledOnce()
    expect(f.registry.records.size).toBe(0)
    await f.registry.dispose()
  })

  it('drains an accepted operation that synchronously starts shutdown', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>()
    let shutdown!: Promise<void>, done = false
    const operation = f.registry.operation(1, async () => {
      shutdown = f.registry.dispose()
      void shutdown.then(() => { done = true })
      entered.resolve()
      await gate.promise
    })
    await entered.promise; await Promise.resolve(); await Promise.resolve()
    try { expect(done).toBe(false) } finally { gate.resolve() }
    await operation; await shutdown
    expect(done).toBe(true)
  })

  it('enforces client and exact agent identity and disposes a losing publication', async () => {
    const f = fixture(), a = f.record(), duplicate = f.record()
    await f.registry.publish(a.agent.session.id, a)
    expect(f.registry.owned(1, a.agent.session.id)).toBe(a)
    expect(f.registry.owned(2, a.agent.session.id)).toBeUndefined()
    expect(f.registry.ownedAgent(a.agent)).toBe(a)
    expect(f.registry.ownedAgent(duplicate.agent)).toBeUndefined()
    await expect(f.registry.publish(a.agent.session.id, a)).rejects.toThrow('already published')
    await expect(f.registry.publish(duplicate.agent.session.id, duplicate)).rejects.toThrow('already in use')
    expect(duplicate.dispose).toHaveBeenCalledTimes(1)
    expect(a.dispose).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it('clears timers, withdraws ownership immediately and reserves the retiring id until close completes', async () => {
    const f = fixture(), a = f.record(), gate = Promise.withResolvers<void>()
    const fired = vi.fn()
    a.mcpInitTimer = setTimeout(fired, 10)
    f.flush.mockImplementationOnce(() => gate.promise)
    await f.registry.publish(a.agent.session.id, a)
    const closing = f.registry.close(a)
    expect(f.registry.records.has(a.agent.session.id)).toBe(false)
    expect(a.mcpInitTimer).toBeUndefined()
    expect(f.cancelRequests).toHaveBeenCalledWith(1, a.agent.session.id)
    expect(f.registry.close(a)).toBe(closing)
    const premature = f.record()
    await expect(f.registry.publish(premature.agent.session.id, premature)).rejects.toThrow('already in use')
    expect(a.dispose).not.toHaveBeenCalled()
    gate.resolve(); await closing
    const next = f.record()
    await f.registry.publish(next.agent.session.id, next)
    expect(f.registry.ownedAgent(next.agent)).toBe(next)
    expect(fired).not.toHaveBeenCalled()
    expect(a.dispose).toHaveBeenCalledTimes(1)
    await f.registry.dispose()
  })

  it('drains bridge input and flushes before the owned disposer without taking over its driver', async () => {
    const f = fixture(), a = f.record(), input = Promise.withResolvers<void>(), order: string[] = []
    a.queue.dispose = async () => { order.push('cancel'); await input.promise; order.push('input drained') }
    f.flush.mockImplementation(async () => { order.push('flush') })
    a.dispose = async () => { order.push('dispose agent') }
    await f.registry.publish(a.agent.session.id, a)
    const closing = f.registry.close(a)
    expect(order).toEqual(['cancel'])
    input.resolve(); await closing
    expect(order).toEqual(['cancel', 'input drained', 'flush', 'dispose agent'])
    expect(a.agent.whenIdle).not.toHaveBeenCalled()
  })

  it('waits for agent idle and reads the final log before disposal when replacing a session', async () => {
    const f = fixture(), a = f.record(), idle = Promise.withResolvers<void>(), order: string[] = []
    a.agent.whenIdle = () => idle.promise
    f.flush.mockImplementation(async () => { order.push('flush') })
    a.dispose = async () => { order.push('dispose agent') }
    await f.registry.publish(a.agent.session.id, a)
    const closing = f.registry.reload(a, () => { order.push('capture log') })
    await Promise.resolve(); expect(order).toEqual([])
    idle.resolve(); await closing
    expect(order).toEqual(['flush', 'capture log', 'dispose agent'])
  })

  it.each(['drain', 'sync drain', 'cancel', 'flush'])('always disposes and surfaces a %s failure', async failure => {
    const f = fixture(), a = f.record()
    if (failure === 'drain') a.queue.dispose = async () => { throw new Error('input failure') }
    else if (failure === 'sync drain') a.queue.dispose = () => { throw new Error('input failure') }
    else if (failure === 'cancel') f.cancelRequests.mockImplementationOnce(() => { throw new Error('input failure') })
    else f.flush.mockRejectedValueOnce(new Error('storage failure'))
    await f.registry.publish(a.agent.session.id, a)
    await expect(f.registry.close(a)).rejects.toThrow(/input failure|storage failure/)
    expect(f.flush).toHaveBeenCalledTimes(1)
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(f.registry.records.size).toBe(0)
  })

  it('registers retirement before queue disposal can reenter shutdown', async () => {
    const f = fixture(), a = f.record(), gate = Promise.withResolvers<void>()
    let shutdown!: Promise<void>, reentered!: Promise<void>, done = false
    a.queue.dispose = async () => {
      reentered = f.registry.close(a)
      shutdown = f.registry.dispose()
      void shutdown.then(() => { done = true })
      await gate.promise
    }
    await f.registry.publish(a.agent.session.id, a)
    const close = f.registry.close(a)
    expect(reentered).toBe(close)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    try { expect(done).toBe(false) } finally { gate.resolve() }
    await close; await shutdown
    expect(a.dispose).toHaveBeenCalledOnce()
  })

  it('preserves the exact usable owner if reload preflight fails, then allows a retry', async () => {
    const f = fixture(), a = f.record(), capture = vi.fn(() => 'snapshot')
    await f.registry.publish(a.agent.session.id, a)
    f.flush.mockRejectedValueOnce(new Error('storage failure'))
    await expect(f.registry.reload(a, capture)).rejects.toThrow('storage failure')
    expect(f.registry.ownedAgent(a.agent)).toBe(a)
    expect(a.queue.cancel).toHaveBeenCalledTimes(1)
    expect(a.queue.dispose).not.toHaveBeenCalled()
    expect(a.dispose).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
    await expect(f.registry.reload(a, capture)).resolves.toBe('snapshot')
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(f.registry.records.size).toBe(0)
  })

  it('blocks input while draining reload work, retains read ownership, and reopens admission after failure', async () => {
    const f = fixture(), a = f.record(), gate = Promise.withResolvers<void>(), order: string[] = []
    await f.registry.publish(a.agent.session.id, a)
    f.flush.mockImplementationOnce(async () => { order.push('flush'); throw new Error('offline') })
    const reload = f.registry.reload(a, () => {}, async () => { order.push('settle'); await gate.promise })
    const failure = expect(reload).rejects.toThrow('offline')
    expect(f.registry.ownedAgent(a.agent)).toBe(a)
    expect(f.registry.acceptsInput(a)).toBe(false)
    expect(() => f.registry.assertReady(a)).toThrow('reloading')
    expect(a.agent.whenIdle).not.toHaveBeenCalled()
    gate.resolve(); await failure
    expect(order).toEqual(['settle', 'flush'])
    expect(f.registry.acceptsInput(a)).toBe(true)
    f.registry.assertReady(a)
    await f.registry.close(a)
    expect(f.registry.acceptsInput(a)).toBe(false)
  })

  it('does not touch the native driver if close wins while reload settles accepted writes', async () => {
    const f = fixture(), a = f.record(), gate = Promise.withResolvers<void>()
    await f.registry.publish(a.agent.session.id, a)
    const reload = f.registry.reload(a, () => {}, () => gate.promise)
    const failure = expect(reload).rejects.toThrow('session closed')
    const closing = f.registry.close(a)
    expect(f.registry.ownedAgent(a.agent)).toBeUndefined()
    await Promise.resolve(); await Promise.resolve()
    expect(a.dispose).not.toHaveBeenCalled()
    gate.resolve(); await failure; await closing
    expect(a.agent.whenIdle).not.toHaveBeenCalled()
    expect(a.dispose).toHaveBeenCalledOnce()
  })

  it('disconnects only the owning client and lets callers await its failed teardown', async () => {
    const f = fixture(), a = f.record('a', 1), b = f.record('b', 2)
    await f.registry.publish(a.agent.session.id, a)
    await f.registry.publish(b.agent.session.id, b)
    f.flush.mockRejectedValueOnce(new Error('offline storage'))
    f.live.delete(1); f.registry.disconnect(1)
    expect(f.registry.records.size).toBe(1)
    expect(f.registry.ownedAgent(b.agent)).toBe(b)
    await f.registry.drain()
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('offline storage'))
    expect(b.dispose).not.toHaveBeenCalled()
    await f.registry.dispose()
  })

  it('closes admission immediately and waits for a late accepted creator to clean up', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), a = f.record()
    const creation = f.registry.operation(1, async () => { await gate.promise; await f.registry.publish(a.agent.session.id, a) })
    const rejected = expect(creation).rejects.toThrow('leader closed')
    const shutdown = f.registry.dispose()
    expect(f.registry.dispose()).toBe(shutdown)
    expect(f.registry.closed).toBe(true)
    const never = vi.fn(async () => {})
    await expect(f.registry.operation(1, never)).rejects.toThrow('disposed')
    expect(never).not.toHaveBeenCalled()
    let done = false
    void shutdown.then(() => { done = true })
    await Promise.resolve(); expect(done).toBe(false)
    gate.resolve(); await rejected; await shutdown
    expect(a.dispose).toHaveBeenCalledTimes(1)
    expect(f.registry.records.size).toBe(0)
  })

  it('rejects disconnected operations without work and retains every shutdown failure', async () => {
    const f = fixture(), a = f.record('a'), b = f.record('b')
    f.live.delete(2)
    const never = vi.fn(async () => {})
    await expect(f.registry.operation(2, never)).rejects.toThrow('disconnected')
    expect(never).not.toHaveBeenCalled()
    await f.registry.publish(a.agent.session.id, a); await f.registry.publish(b.agent.session.id, b)
    f.flush.mockRejectedValue(new Error('storage offline'))
    await expect(f.registry.dispose()).rejects.toThrow('teardown failed for 2 session(s)')
    expect(a.dispose).toHaveBeenCalledTimes(1); expect(b.dispose).toHaveBeenCalledTimes(1)
  })

  it('reports a late creator cleanup failure in the shutdown result', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), late = f.record()
    late.dispose = vi.fn(async () => { throw new Error('late cleanup failure') })
    const operation = f.registry.operation(1, async () => { await gate.promise; await f.registry.publish(late.agent.session.id, late) })
    const failedOperation = expect(operation).rejects.toThrow('late cleanup failure')
    const failedShutdown = expect(f.registry.dispose()).rejects.toThrow('late cleanup failure')
    gate.resolve(); await failedOperation; await failedShutdown
    expect(late.dispose).toHaveBeenCalledTimes(1)
  })
})
