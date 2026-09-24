import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import { createNativeAsides, type NativeAsideRuntime } from '../src/native-asides.ts'
import { createSessionWork } from '../src/session-work.ts'

const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }
const answer = (text = 'answer'): SubagentResult => ({ output: [{ type: 'text', text }], stopReason: 'completed' })
const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
function fixture() {
  const ready = { value: true }, live = { value: true }
  const agent = { session: { id: SessionId('parent') } } as Agent
  const record = { agent, clientId: 1, work: createSessionWork({ isLive: () => live.value,
    assertReady: () => { if (!ready.value) throw new Error('initializing') } }) }
  let current = record
  const run: SubagentRun = { id: SessionId('child'), localAgent: undefined, result: Promise.resolve(answer()), dispose: vi.fn(async () => {}) }
  const runtime = { list: vi.fn(() => ['fork', 'spawn']), start: vi.fn<NativeAsideRuntime['start']>(async () => run) }
  const host = {
    owned: vi.fn((client: number, id: SessionId | undefined) => client === 1 && id === 'parent' ? current : undefined),
    canDelegate: vi.fn((_record: typeof record) => true),
    subagents: vi.fn((_record: typeof record): NativeAsideRuntime | undefined => runtime),
  }
  const asides = createNativeAsides(host)
  stops.push(async () => { await asides.dispose(); await record.work.dispose() })
  return { asides, record, ready, live, run, runtime, host,
    btw: (extra: object = {}) => asides.btw(1, { sessionId: 'parent', question: 'question', ...extra }),
    replace: () => { current = { ...record } } }
}

describe('one-shot native aside ownership', () => {
  it.each([
    [['fork', 'spawn'], 'spawn'], [['remote', 'fork'], 'fork'], [['remote'], 'remote'],
  ])('selects a provider from %j without changing the native request', async (providers, provider) => {
    const f = fixture(); f.runtime.list.mockReturnValue(providers as string[])
    await expect(f.btw({ question: '  original question  ' })).resolves.toEqual({ result: { answer: 'answer' } })
    expect(f.runtime.start).toHaveBeenCalledWith(provider, { parent: f.record.agent,
      prompt: [{ type: 'text', text: '  original question  ' }], signal: expect.any(AbortSignal), label: 'btw' })
    expect(f.runtime.start.mock.calls[0]![1].signal!.aborted).toBe(true)
    expect(f.run.dispose).toHaveBeenCalledOnce()
  })

  it('validates ownership, readiness, question and capabilities before starting native work', async () => {
    const f = fixture()
    await expect(f.asides.btw(2, { sessionId: 'parent', question: 'x' })).rejects.toThrow('unknown session')
    await expect(f.asides.btw(1, null)).rejects.toThrow('params')
    await expect(f.btw({ question: '  ' })).rejects.toThrow('empty btw')
    f.ready.value = false; await expect(f.btw()).rejects.toThrow('initializing'); f.ready.value = true
    f.host.canDelegate.mockReturnValue(false); await expect(f.btw()).rejects.toThrow('/btw needs subagents')
    f.host.canDelegate.mockReturnValue(true); f.host.subagents.mockReturnValue(undefined)
    await expect(f.btw()).rejects.toThrow('subagents are not available')
    f.host.subagents.mockReturnValue({ start: f.runtime.start })
    await expect(f.btw()).rejects.toThrow('no subagent provider')
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('joins native text blocks and preserves the empty-answer fallback', async () => {
    const f = fixture()
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: Promise.resolve({ ...answer(), output: [
      { type: 'text', text: ' first' }, { type: 'reasoning', text: 'hidden' }, { type: 'text', text: 'second ' },
    ] }) })
    await expect(f.btw()).resolves.toEqual({ result: { answer: 'firstsecond' } })
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: Promise.resolve(answer('  ')) })
    await expect(f.btw()).resolves.toEqual({ result: { answer: '(no answer)' } })
  })

  it('does not return partial output when the aside does not complete', async () => {
    const f = fixture()
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: Promise.resolve({
      output: [{ type: 'text', text: 'partial' }], stopReason: 'aborted' as const,
    }) })
    await expect(f.btw()).rejects.toThrow('/btw did not complete (aborted)')
    expect(f.run.dispose).toHaveBeenCalledOnce()
  })

  it.each(['capability', 'runtime', 'providers'])('does not start after cancellation reentered from the %s getter', async getter => {
    const f = fixture()
    if (getter === 'capability') f.host.canDelegate.mockImplementationOnce(() => { f.record.work.cancel(); return true })
    if (getter === 'runtime') f.host.subagents.mockImplementationOnce(() => { f.record.work.cancel(); return f.runtime })
    if (getter === 'providers') f.runtime.list.mockImplementationOnce(() => { f.record.work.cancel(); return ['spawn'] })
    await expect(f.btw()).rejects.toThrow('session closed')
    expect(f.runtime.start).not.toHaveBeenCalled()
  })

  it('preserves a rejected start without inventing a caller-owned handle', async () => {
    const f = fixture(), error = new Error('provider refused')
    f.runtime.start.mockRejectedValueOnce(error)
    await expect(f.btw()).rejects.toBe(error)
    expect(f.run.dispose).not.toHaveBeenCalled()
    expect(f.runtime.start.mock.calls[0]![1].signal!.aborted).toBe(true)
  })

  it('preserves result and disposal failures and releases a normal run exactly once', async () => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>(), primary = new Error('native result'), cleanup = new Error('native disposal')
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise, dispose: vi.fn(async () => { throw cleanup }) })
    const request = f.btw(), caught = request.catch(error => error)
    result.reject(primary)
    expect((await caught as AggregateError).errors).toEqual([primary, cleanup])
  })

  it.each(['session', 'module'])('starts disposal while a returned result is pending on %s cancellation and drains real cleanup', async owner => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>(), gate = Promise.withResolvers<void>()
    const dispose = vi.fn(async () => { await gate.promise })
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise, dispose })
    const request = f.btw(), caught = request.catch(error => error)
    await tick()
    let finished = false
    const closing = owner === 'session' ? f.record.work.dispose() : f.asides.dispose()
    void closing.then(() => { finished = true })
    await tick()
    const startedBeforeResult = dispose.mock.calls.length, finishedBeforeRelease = finished
    // Always release the fixture even against the old implementation.
    result.resolve(answer('late')); gate.resolve()
    const failure = await caught; await closing
    expect(startedBeforeResult).toBe(1)
    expect(finishedBeforeRelease).toBe(false)
    expect(failure.message).toMatch(/session closed|disposed/)
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('adopts a late handle after close and drains disposal without waiting for its result', async () => {
    const f = fixture(), start = Promise.withResolvers<SubagentRun>(), result = Promise.withResolvers<SubagentResult>(), gate = Promise.withResolvers<void>()
    const dispose = vi.fn(async () => { await gate.promise })
    f.runtime.start.mockReturnValueOnce(start.promise)
    const request = f.btw(), rejected = expect(request).rejects.toThrow('session closed')
    const closing = f.record.work.dispose(); let finished = false
    void closing.then(() => { finished = true })
    await tick(); expect(finished).toBe(false)
    start.resolve({ ...f.run, result: result.promise, dispose }); await tick()
    expect(dispose).toHaveBeenCalledOnce(); expect(finished).toBe(false)
    gate.resolve(); await rejected; await closing
    result.reject(new Error('late provider failure')); await tick()
  })

  it('registers pending start before reentrant shutdown and preserves its failure', async () => {
    const f = fixture(), start = Promise.withResolvers<SubagentRun>(), primary = new Error('failed start')
    let closing!: Promise<void>, finished = false
    f.runtime.start.mockImplementationOnce(() => {
      closing = f.asides.dispose(); void closing.then(() => { finished = true }); return start.promise
    })
    const request = f.btw(), rejected = expect(request).rejects.toBe(primary)
    await tick(); expect(finished).toBe(false); expect(f.asides.dispose()).toBe(closing)
    expect(f.runtime.start.mock.calls[0]![1].signal!.aborted).toBe(true)
    start.reject(primary); await rejected; await closing
    await expect(f.btw()).rejects.toThrow('disposed')
  })

  it('does not publish an answer for a replacement owner and still releases the old child', async () => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>()
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise })
    const request = f.btw(), rejected = expect(request).rejects.toThrow('session closed')
    await tick(); f.replace(); result.resolve(answer()); await rejected
    expect(f.run.dispose).toHaveBeenCalledOnce()
  })

  it('finishes cancellation only after disposal even if the result never settles, observing a later rejection', async () => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>(), gate = Promise.withResolvers<void>()
    const dispose = vi.fn(async () => { await gate.promise })
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise, dispose })
    const request = f.btw(), rejected = expect(request).rejects.toThrow('session closed')
    await tick(); const closing = f.record.work.dispose()
    await tick(); expect(dispose).toHaveBeenCalledOnce()
    gate.resolve(); await rejected; await closing
    result.reject(new Error('rejected after native quiescence')); await tick()
  })

  it('shares one release when native disposal reenters module shutdown', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    let closing!: Promise<void>, finished = false
    const dispose = vi.fn(async () => {
      closing = f.asides.dispose(); void closing.then(() => { finished = true }); await gate.promise
    })
    f.runtime.start.mockResolvedValueOnce({ ...f.run, dispose })
    const request = f.btw(), rejected = expect(request).rejects.toThrow('disposed')
    await tick(); expect(finished).toBe(false); expect(f.asides.dispose()).toBe(closing)
    gate.resolve(); await rejected; await closing
    expect(dispose).toHaveBeenCalledOnce()
  })

  it('releases a published handle even if accessing its result throws', async () => {
    const f = fixture(), primary = new Error('broken result getter')
    f.runtime.start.mockResolvedValueOnce({ ...f.run, get result(): Promise<SubagentResult> { throw primary } })
    await expect(f.btw()).rejects.toBe(primary)
    expect(f.run.dispose).toHaveBeenCalledOnce()
  })

  it('retains cancellation and disposal errors without abandoning the drain', async () => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>(), cleanup = new Error('cleanup failed')
    const dispose = vi.fn(async () => { throw cleanup })
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise, dispose })
    const request = f.btw(), caught = request.catch(error => error)
    await tick(); f.record.work.cancel()
    const failure = await caught as AggregateError
    expect(failure.errors[0].message).toContain('session closed'); expect(failure.errors[1]).toBe(cleanup)
    await f.asides.dispose(); expect(dispose).toHaveBeenCalledOnce()
    result.reject(new Error('late failure')); await tick()
  })

  it('does not cancel a sibling run when releasing a completed aside', async () => {
    const f = fixture(), result = Promise.withResolvers<SubagentResult>(), dispose = vi.fn(async () => {})
    f.runtime.start.mockResolvedValueOnce({ ...f.run, result: result.promise, dispose })
    const held = f.btw(); await tick()
    await expect(f.btw()).resolves.toEqual({ result: { answer: 'answer' } })
    expect(f.runtime.start.mock.calls[0]![1].signal!.aborted).toBe(false)
    expect(dispose).not.toHaveBeenCalled()
    result.resolve(answer('held')); await expect(held).resolves.toEqual({ result: { answer: 'held' } })
    expect(dispose).toHaveBeenCalledOnce()
  })
})
