import { describe, expect, it, vi } from 'vitest'
import { createSessionWork } from '../src/session-work.ts'

function deferred<T = void>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const state = { live: true }, assertReady = vi.fn()
  const work = createSessionWork({ isLive: () => state.live, assertReady })
  return { work, state, assertReady }
}
describe('per-session accepted work', () => {
  it('checks write readiness while allowing initialization reads through the same owner', async () => {
    const f = fixture(), execute = vi.fn(async () => 7)
    f.assertReady.mockImplementation(() => { throw new Error('initializing') })
    await expect(f.work.run(execute)).rejects.toThrow('initializing')
    expect(execute).not.toHaveBeenCalled()
    await expect(f.work.read(execute)).resolves.toBe(7)
    f.state.live = false
    await expect(f.work.read(execute)).rejects.toThrow('session closed')
    expect(execute).toHaveBeenCalledOnce()
    await f.work.dispose()
  })

  it('waits for a cancelled native operation to actually finish rather than racing its result', async () => {
    const f = fixture(), gate = deferred<number>()
    let signal!: AbortSignal
    const result = f.work.run(async scope => { signal = scope.signal; return gate.promise })
    const rejected = expect(result).rejects.toThrow('session closed')
    let done = false
    const disposal = f.work.dispose().then(() => { done = true })
    expect(signal.aborted).toBe(true)
    await Promise.resolve(); expect(done).toBe(false)
    gate.resolve(4)
    await rejected; await disposal
    expect(done).toBe(true)
    await expect(f.work.run(async () => 5)).rejects.toThrow('session closed')
  })

  it('keeps cancellation irreversible for old operations after the same owner becomes ready again', async () => {
    const f = fixture(), gate = deferred(), write = vi.fn()
    const result = f.work.run(async scope => { await gate.promise; scope.assertActive(); write() })
    const rejected = expect(result).rejects.toThrow('session closed')
    f.state.live = false; f.work.cancel(); f.state.live = true
    gate.resolve(); await rejected
    expect(write).not.toHaveBeenCalled()
    await expect(f.work.run(async () => 'new request')).resolves.toBe('new request')
    await f.work.dispose()
  })

  it('publishes accepted work and its disposal promise before callbacks can reenter close', async () => {
    const f = fixture(), gate = deferred()
    let first!: Promise<void>, reentered!: Promise<void>, done = false
    const result = f.work.run(async scope => {
      scope.signal.addEventListener('abort', () => { reentered = f.work.dispose() })
      first = f.work.dispose()
      void first.then(() => { done = true })
      await gate.promise
    })
    const rejected = expect(result).rejects.toThrow('session closed')
    expect(first).toBe(reentered)
    await Promise.resolve(); expect(done).toBe(false)
    gate.resolve(); await rejected; await first
    expect(done).toBe(true)
  })

  it('does not sweep new-generation work started reentrantly by cancellation', async () => {
    const f = fixture(), gate = deferred(), fresh = deferred<number>()
    let successor!: Promise<number>
    const first = f.work.run(async scope => {
      scope.signal.addEventListener('abort', () => { successor = f.work.run(async () => fresh.promise) })
      await gate.promise
    })
    const rejected = expect(first).rejects.toThrow('session closed')
    f.work.cancel(); gate.resolve(); fresh.resolve(8)
    await rejected; await expect(successor).resolves.toBe(8)
    await f.work.dispose()
  })

  it('drains reads, writes and nested work while preserving primary native errors', async () => {
    const f = fixture(), read = deferred(), write = deferred(), failure = new Error('native failed')
    const first = f.work.read(async () => { await read.promise; throw failure })
    const rejected = expect(first).rejects.toBe(failure)
    const second = f.work.run(async () => f.work.read(async () => write.promise))
    let settled = false
    const settlement = f.work.settle().then(() => { settled = true })
    read.resolve(); await rejected
    await Promise.resolve(); expect(settled).toBe(false)
    write.resolve(); await second; await settlement
    expect(settled).toBe(true)
    await f.work.dispose()
  })

  it('captures synchronous throws without leaking work and isolates unrelated owners', async () => {
    const f = fixture(), other = fixture(), gate = deferred<number>(), error = new Error('sync failure')
    await expect(f.work.run(() => { throw error })).rejects.toBe(error)
    const result = other.work.run(async () => gate.promise)
    await f.work.dispose()
    gate.resolve(3); await expect(result).resolves.toBe(3)
    await other.work.dispose()
  })
})
