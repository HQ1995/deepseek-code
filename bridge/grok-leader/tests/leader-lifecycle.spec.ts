import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLeaderLifecycle } from '../src/leader-lifecycle.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const stops: Array<() => Promise<void>> = []
beforeEach(() => { vi.useFakeTimers() })
afterEach(async () => {
  await Promise.allSettled(stops.splice(0).map(stop => Promise.resolve().then(stop)))
  vi.useRealTimers()
})
function fixture() {
  const order: string[] = [], clients = { size: 0 }
  const sessions = { closed: false, disconnect: vi.fn((_id: number) => {}), drain: vi.fn(async () => {}),
    dispose: vi.fn(async () => { order.push('sessions'); sessions.closed = true }) }
  const catalog = { dispose: vi.fn(() => { order.push('catalog') }) }
  const transport = { clients, failure: undefined as NodeJS.ErrnoException | undefined,
    start: vi.fn(), close: vi.fn(() => { order.push('transport') }) }
  const owners = ['first', 'second'].map(name => ({ dispose: vi.fn<() => void | Promise<unknown>>(async () => { order.push(name) }) }))
  const pollers = ['tasks', 'children', 'status'].map(name => ({ poll: vi.fn(() => { order.push(name) }) }))
  const exit = vi.fn((_code: number) => {}), appExit = vi.fn<() => ((code: number) => void) | undefined>(() => exit)
  const logger = { warn: vi.fn((_message: string) => {}) }
  const leader = createLeaderLifecycle({ sessions, catalog, transport, owners, pollers, appExit, logger, idleExitMs: 20 })
  stops.push(leader.dispose)
  return { leader, sessions, catalog, transport, owners, pollers, clients, exit, appExit, logger, order }
}

describe('leader host lifecycle ownership', () => {
  it('starts one shared 500ms heartbeat and stops polling before feature retirement', async () => {
    const f = fixture()
    expect(vi.getTimerCount()).toBe(0)
    f.leader.start(); expect(f.transport.start).toHaveBeenCalledOnce()
    expect(() => f.leader.start()).toThrow('cannot be started again')
    await vi.advanceTimersByTimeAsync(500)
    expect(f.order).toEqual(['tasks', 'children', 'status'])
    await f.leader.dispose(); await vi.advanceTimersByTimeAsync(1000)
    expect(f.order.slice(3)).toEqual(['sessions', 'catalog', 'transport', 'first', 'second'])
    for (const owner of f.pollers) expect(owner.poll).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('waits for both detached-session drain and every owner before requesting an idle exit', async () => {
    const f = fixture(), detached = deferred(), owner = deferred()
    f.sessions.drain.mockReturnValueOnce(detached.promise); f.owners[0]!.dispose.mockReturnValueOnce(owner.promise)
    f.leader.start(); f.leader.disconnected(7)
    expect(f.sessions.disconnect).toHaveBeenCalledWith(7)
    await vi.advanceTimersByTimeAsync(20)
    expect(f.sessions.dispose).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled()
    detached.resolve(); await tick()
    expect(f.sessions.dispose).toHaveBeenCalledOnce(); expect(f.exit).not.toHaveBeenCalled()
    owner.resolve(); await tick(); expect(f.exit).toHaveBeenCalledWith(0)
    await f.leader.dispose(); expect(f.sessions.dispose).toHaveBeenCalledOnce()
  })

  it('does not schedule exit while other registered clients remain', async () => {
    const f = fixture(); f.leader.start(); f.clients.size = 1; f.leader.disconnected(1)
    await vi.advanceTimersByTimeAsync(100)
    expect(f.sessions.drain).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled()
    f.clients.size = 0; f.leader.disconnected(2); await vi.advanceTimersByTimeAsync(20)
    expect(f.exit).toHaveBeenCalledOnce()
  })

  it.each(['grace', 'drain'])('invalidates an idle exit when reconnecting during %s', async phase => {
    const f = fixture(), gate = deferred(); f.leader.start()
    if (phase === 'drain') f.sessions.drain.mockReturnValueOnce(gate.promise)
    f.leader.disconnected(1)
    if (phase === 'drain') await vi.advanceTimersByTimeAsync(20)
    f.clients.size = 1; f.leader.registered(); gate.resolve()
    await vi.advanceTimersByTimeAsync(100)
    expect(f.sessions.dispose).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled()
    f.clients.size = 0; f.leader.disconnected(2); await vi.advanceTimersByTimeAsync(20)
    expect(f.exit).toHaveBeenCalledOnce()
  })

  it('manual disposal invalidates an idle callback already awaiting a detached drain', async () => {
    const f = fixture(), gate = deferred(); f.sessions.drain.mockReturnValueOnce(gate.promise)
    f.leader.start(); f.leader.disconnected(1); await vi.advanceTimersByTimeAsync(20)
    await f.leader.dispose(); gate.resolve(); await tick()
    expect(f.exit).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })

  it('publishes one shutdown promise before native retirement can reenter disposal', async () => {
    const f = fixture(), gate = deferred()
    let reentered: Promise<void> | undefined
    f.sessions.dispose.mockImplementationOnce(() => { reentered = f.leader.dispose(); return gate.promise })
    const closing = f.leader.dispose(); let finished = false
    void closing.then(() => { finished = true }); await tick()
    const callsBeforeRelease = f.sessions.dispose.mock.calls.length, early = finished
    gate.resolve(); await closing; await reentered
    expect(reentered).toBe(closing); expect(callsBeforeRelease).toBe(1)
    expect(early).toBe(false); expect(finished).toBe(true)
    for (const owner of f.owners) expect(owner.dispose).toHaveBeenCalledOnce()
  })

  it('attempts every cleanup after synchronous failures and drains the last owner', async () => {
    const f = fixture(), gate = deferred()
    f.catalog.dispose.mockImplementationOnce(() => { throw new Error('catalog cleanup') })
    f.transport.close.mockImplementationOnce(() => { throw new Error('transport cleanup') })
    f.owners[0]!.dispose.mockImplementationOnce(() => { throw new Error('first cleanup') })
    f.owners[1]!.dispose.mockReturnValueOnce(gate.promise)
    let finished = false
    const closing = Promise.resolve().then(() => f.leader.dispose())
    void closing.then(() => { finished = true }, () => { finished = true })
    await tick(); const early = finished, attempts = f.owners[1]!.dispose.mock.calls.length
    gate.resolve(); await closing.catch(() => {})
    expect(attempts).toBe(1); expect(early).toBe(false)
    const warnings = f.logger.warn.mock.calls.flat().join('\n')
    expect(warnings).toContain('catalog cleanup'); expect(warnings).toContain('transport cleanup'); expect(warnings).toContain('first cleanup')
  })

  it('retains asynchronous cleanup errors while waiting for a sibling drain', async () => {
    const f = fixture(), gate = deferred()
    f.owners[0]!.dispose.mockRejectedValueOnce(new Error('owner rejected'))
    f.owners[1]!.dispose.mockReturnValueOnce(gate.promise)
    let finished = false; const closing = f.leader.dispose(); void closing.then(() => { finished = true })
    await tick(); expect(finished).toBe(false)
    gate.resolve(); await closing
    expect(f.logger.warn.mock.calls.flat().join('\n')).toContain('owner rejected')
  })

  it('still closes sources when session retirement throws before publishing its own drain', async () => {
    const f = fixture()
    f.sessions.dispose.mockImplementationOnce(() => { throw new Error('session retirement') })
    await f.leader.dispose()
    expect(f.catalog.dispose).toHaveBeenCalledOnce(); expect(f.transport.close).toHaveBeenCalledOnce()
    for (const owner of f.owners) expect(owner.dispose).toHaveBeenCalledOnce()
    expect(f.logger.warn.mock.calls.flat().join('\n')).toContain('session retirement')
  })

  it('does not lose a pending catalog disposal or repeat reentrant transport cleanup', async () => {
    const f = fixture(), gate = deferred()
    f.catalog.dispose.mockImplementationOnce(() => gate.promise)
    let reentered: Promise<void> | undefined
    f.transport.close.mockImplementationOnce(() => { reentered = f.leader.dispose() })
    let finished = false; const closing = f.leader.dispose(); void closing.then(() => { finished = true })
    await tick(); expect(finished).toBe(false); expect(reentered).toBe(closing)
    gate.resolve(); await closing
    expect(f.transport.close).toHaveBeenCalledOnce()
  })

  it('keeps the fatal listener error authoritative after all cleanup and reuses the drain', async () => {
    const f = fixture(), gate = deferred(), fatal = Object.assign(new Error('socket failed'), { code: 'EADDRINUSE' })
    f.transport.failure = fatal; f.owners[0]!.dispose.mockReturnValueOnce(gate.promise)
    f.leader.failed(fatal)
    const closing = f.leader.dispose(), rejected = expect(closing).rejects.toBe(fatal)
    expect(f.leader.dispose()).toBe(closing)
    gate.resolve(); await rejected
    expect(f.transport.close).toHaveBeenCalledOnce()
    for (const owner of f.owners) expect(owner.dispose).toHaveBeenCalledOnce()
  })

  it('starts cleanup on a synchronous listener start error and releases its heartbeat', async () => {
    const f = fixture(), fatal = new Error('bad socket path')
    f.transport.start.mockImplementationOnce(() => { throw fatal })
    expect(() => f.leader.start()).toThrow(fatal)
    await expect(f.leader.dispose()).rejects.toBe(fatal)
    expect(f.transport.close).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })

  it('can close before starting without introducing a timer or listener', async () => {
    const f = fixture(); await f.leader.dispose()
    expect(() => f.leader.start()).toThrow('cannot be started again')
    expect(f.transport.start).not.toHaveBeenCalled(); expect(vi.getTimerCount()).toBe(0)
  })

  it('warns once when no exit capability exists and leaves no heartbeat running', async () => {
    const f = fixture(); f.appExit.mockReturnValue(undefined)
    f.leader.start(); f.leader.disconnected(1); await vi.advanceTimersByTimeAsync(2000)
    expect(f.logger.warn.mock.calls.flat().join('\n')).toContain('no appExit')
    expect(f.appExit).toHaveBeenCalledOnce(); expect(vi.getTimerCount()).toBe(0)
  })

  it('reports a rejected pre-exit drain without closing a still-usable host', async () => {
    const f = fixture(); f.sessions.drain.mockRejectedValueOnce(new Error('drain failed'))
    f.leader.start(); f.leader.disconnected(1); await vi.advanceTimersByTimeAsync(20)
    expect(f.sessions.dispose).not.toHaveBeenCalled(); expect(f.exit).not.toHaveBeenCalled()
    expect(f.logger.warn.mock.calls.flat().join('\n')).toContain('drain failed')
  })
})
