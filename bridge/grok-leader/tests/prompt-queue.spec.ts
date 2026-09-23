import { afterEach, describe, expect, it, vi } from 'vitest'
import { setImmediate } from 'node:timers/promises'
import type { SessionEvent, TurnEndReason } from '@deepseek-ai/dsh-session'
import { createPromptQueues, type DurablePromptBlock, type PromptQueue, type PromptQueueHost } from '../src/prompt-queue.ts'

const disposers: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(disposers.splice(0).map(dispose => dispose())) })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
type Snapshot = { seq: number; entries: Array<{ id: string; text: string; version: number }>; runningPromptId?: string; runningCombinedTexts?: string[] }
function fixture(options: { combineQueued?: boolean; followUpSteer?: boolean; flushOutput?: () => Promise<void>; notify?: () => void; disposalError?: string } = {},
  attach = createPromptQueues({ combineQueued: options.combineQueued ?? false, followUpSteer: options.followUpSteer ?? false, logger: { warn() {} } })) {
  let status: PromptQueueHost['agent']['status'] = 'idle'
  let live = true
  let idleWait = deferred<void>()
  const messages: Array<Parameters<PromptQueueHost['agent']['followup']>[0]> = []
  const steered: typeof messages = []
  const notes: Array<{ method: string; params: Record<string, unknown> }> = []
  const echoes: string[] = []
  const followup = vi.fn((message: typeof messages[number]) => {
    messages.push(message); status = 'running'; idleWait = deferred<void>()
  })
  const agent: PromptQueueHost['agent'] = {
    get status() { return status }, followup,
    steer: vi.fn((message: typeof messages[number]) => { steered.push(message) }),
    whenIdle: vi.fn(() => status === 'idle' ? Promise.resolve() : idleWait.promise),
    cancel: vi.fn(),
  }
  const queue = attach({ sessionId: 'session', agent, isLive: () => live,
    notify: (method, params) => { options.notify?.(); notes.push({ method, params: params as Record<string, unknown> }) },
    echo: text => { echoes.push(text) }, flushOutput: options.flushOutput ?? (async () => {}) })
  disposers.push(async () => {
    if (options.disposalError !== undefined) await expect(queue.dispose()).rejects.toThrow(options.disposalError)
    else await queue.dispose()
  })
  const submit = (id: string, extra: Record<string, unknown> = {}, prepare = async (): Promise<DurablePromptBlock[]> => [{ type: 'text', text: id }]) =>
    queue.submit({ _meta: { promptId: id, ...extra } }, id, prepare)
  const observe = (turn: number, reason: TurnEndReason = { kind: 'completed' }) => queue.observe({ type: 'turn/end', seq: turn, time: Date.now(), data: { turn, reason } } as SessionEvent)
  const claim = (turn: number) => queue.claimed(messages.at(-1)!.id, turn)
  const idle = () => { status = 'idle'; idleWait.resolve() }
  const finish = (turn: number) => { claim(turn); observe(turn); idle() }
  const control = (name: string, params: Record<string, unknown> = {}) => queue.control('x.ai/queue/' + name, params)
  // Reentrant notifications can arrive out of order; the client keeps the highest seq.
  const snapshot = () => notes.filter(note => note.method === 'x.ai/queue/changed')
    .toSorted((a, b) => Number(a.params.seq) - Number(b.params.seq)).at(-1)!.params as unknown as Snapshot
  return { queue, agent, messages, steered, notes, echoes, submit, observe, claim, idle, finish, control, snapshot, followup,
    unpublish: () => { live = false } }
}
// Flush the event-loop turn, not an implementation-specific number of awaits.
const tick = () => setImmediate()

describe('owned prompt queue', () => {
  it('releases targeted preparation without losing its native drain or admitting late content', async () => {
    const f = fixture(), gate = deferred<void>(), write = vi.fn()
    const request = f.queue.submit({ _meta: { promptId: 'image' } }, 'image', async admission => {
      await gate.promise; admission.assertActive(); write(); return []
    })
    await tick()
    expect(f.queue.cancelPrompt('image')).toBe('cancelled')
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'image' } })
    const next = f.submit('next'); await tick()
    expect(f.echoes).toEqual(['next']); expect(f.agent.cancel).not.toHaveBeenCalled()
    f.finish(1); await next
    let drained = false
    const disposal = f.queue.dispose().then(() => { drained = true })
    await tick(); const early = drained
    gate.resolve(); await disposal
    expect(early).toBe(false); expect(write).not.toHaveBeenCalled()
  })

  it('retires a cancelled waiting admission without letting later input overtake its predecessor', async () => {
    const f = fixture(), gate = deferred<DurablePromptBlock[]>(), prepare = vi.fn(async () => [])
    const first = f.submit('first', {}, () => gate.promise)
    const second = f.submit('second', {}, prepare), third = f.submit('third')
    expect(f.queue.cancelPrompt('second')).toBe('cancelled')
    await expect(second).resolves.toMatchObject({ stopReason: 'cancelled' })
    await tick(); const early = [...f.echoes]
    gate.resolve([{ type: 'text', text: 'first' }]); await tick()
    expect(early).toEqual([]); expect(prepare).not.toHaveBeenCalled()
    expect(f.echoes).toEqual(['first'])
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['third'])
    f.finish(1); await first; await tick(); f.finish(2); await third
  })

  it('removes only the targeted held row and preserves its running owner and queued successor', async () => {
    const f = fixture(), first = f.submit('first'), second = f.submit('second'), third = f.submit('third')
    await tick(); await tick()
    f.control('hold_edit', { id: 'second' })
    expect(f.queue.cancelPrompt('second')).toBe('cancelled')
    await expect(second).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['third'])
    f.finish(1); await first; await tick(); f.finish(2); await third
  })

  it('cancels only the running owner and ignores a repeated late cancellation after promotion', async () => {
    const f = fixture(), first = f.submit('first'), second = f.submit('second')
    await tick(); await tick()
    expect(f.queue.cancelPrompt('first')).toBe('cancelled')
    let settled = false
    void first.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete')).toEqual([])
    expect(f.snapshot().runningPromptId).toBe('first')
    f.idle()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    await tick()
    expect(f.echoes).toEqual(['first', 'second'])
    expect(f.queue.cancelPrompt('first')).toBe('not_found')
    expect(f.agent.cancel).toHaveBeenCalledTimes(1)
    f.finish(2); await second
  })

  it('does not cancel another turn to retract an already-submitted steering prompt', async () => {
    const f = fixture({ followUpSteer: true }), first = f.submit('first')
    await tick(); const second = f.submit('second'); await tick()
    expect(f.queue.cancelPrompt('second')).toBe('already_submitted')
    expect(f.agent.cancel).not.toHaveBeenCalled()
    f.finish(1); await first; await second
  })

  it('settles a cancelled prompt when its own activity ends, not after a turn woken during the unwind', async () => {
    const f = fixture(), first = f.submit('first')
    await tick()
    expect(f.queue.cancelPrompt('first')).toBe('cancelled')
    let settled = false
    void first.then(() => { settled = true })
    await tick()
    expect(settled).toBe(false)
    // A subagent completion woke a new native turn: whenIdle keeps waiting,
    // but the aborted activity already reported idle.
    f.queue.agentIdle()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.snapshot().runningPromptId).toBeUndefined()
  })

  it('does not hold disposal behind the native drain of a cancelled prompt', async () => {
    const f = fixture(), first = f.submit('first')
    await tick()
    await f.queue.dispose()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('reports a failed native cancellation drain instead of publishing successful completion', async () => {
    const f = fixture(), drain = deferred<void>(), error = new Error('native drain failed')
    vi.mocked(f.agent.whenIdle).mockImplementationOnce(() => drain.promise)
    const first = f.submit('first'), rejected = expect(first).rejects.toBe(error)
    await tick(); f.queue.cancel(); drain.reject(error); f.idle()
    await rejected
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete')).toEqual([])
    expect(f.queue.busy).toBe(false)
  })

  it('honors cancellation reentered from a steering acknowledgment without dropping other queued rows', async () => {
    const notify = vi.fn(), f = fixture({ notify }), first = f.submit('first')
    await tick(); const queued = f.submit('queued'); await tick()
    notify.mockImplementationOnce(() => { expect(f.queue.cancelPrompt('steer')).toBe('cancelled') })
    const steer = f.submit('steer', { followUp: 'steer' })
    await expect(steer).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.steered).toEqual([]); expect(f.agent.cancel).not.toHaveBeenCalled()
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['queued'])
    f.finish(1); await first; await tick(); f.finish(2); await queued
  })

  it('publishes steering ownership before native callbacks can reenter cancellation', async () => {
    const f = fixture({ followUpSteer: true }), first = f.submit('first')
    await tick()
    vi.mocked(f.agent.steer).mockImplementationOnce(() => { expect(f.queue.cancelPrompt('steer')).toBe('already_submitted') })
    const steer = f.submit('steer'); await tick()
    expect(f.agent.cancel).not.toHaveBeenCalled()
    f.finish(1); await first; await expect(steer).resolves.toMatchObject({ stopReason: 'end_turn' })
  })

  it('keeps a settling owner distinct from an active turn during output hydration', async () => {
    const gate = deferred<void>(), f = fixture({ flushOutput: () => gate.promise }), first = f.submit('first')
    await tick(); f.claim(1); f.observe(1); await tick()
    expect(f.queue.cancelPrompt('first')).toBe('already_submitted')
    expect(f.agent.cancel).not.toHaveBeenCalled()
    gate.resolve(); f.idle(); await first
  })

  it('rejects duplicate active ids without replacing the original cancellation owner', async () => {
    const f = fixture(), first = f.submit('same')
    await expect(f.submit('same')).rejects.toThrow('duplicate active prompt')
    expect(f.queue.cancelPrompt('same')).toBe('cancelled')
    f.idle()
    await first
  })

  it('drains late failed preparation after targeted cancellation without reviving the row', async () => {
    const f = fixture(), gate = deferred<DurablePromptBlock[]>(), first = f.submit('image', {}, () => gate.promise)
    await tick(); f.queue.cancelPrompt('image'); await first
    const disposal = f.queue.dispose()
    gate.reject(new Error('late storage failure')); await disposal
    expect(f.messages).toEqual([])
  })

  it('drains the targeted running RPC even if native cancellation throws, preserving queued input', async () => {
    const f = fixture(), first = f.submit('first'), second = f.submit('second')
    await tick(); await tick()
    vi.mocked(f.agent.cancel).mockImplementationOnce(() => { throw new Error('native cancellation failed') })
    expect(() => f.queue.cancelPrompt('first')).toThrow('native cancellation failed')
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['second'])
    f.idle(); await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    await tick(); f.finish(2); await second
  })

  it('lets accepted preparation stop before its next write when its queue generation is cancelled', async () => {
    const f = fixture(), gate = deferred<void>(), write = vi.fn()
    const request = f.queue.submit({ _meta: { promptId: 'guarded' } }, 'image', async admission => {
      await gate.promise; admission.assertActive(); write(); return [{ type: 'text', text: 'image' }]
    })
    await tick(); f.queue.cancel(); gate.resolve()
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'guarded' } })
    expect(write).not.toHaveBeenCalled(); expect(f.messages).toEqual([])
    const next = f.submit('fresh'); await tick(); f.finish(1); await next
  })

  it('keeps disposal stronger than the preparation cancellation checkpoint and drains the actual wait', async () => {
    const f = fixture(), gate = deferred<void>(), write = vi.fn()
    const request = f.queue.submit({}, 'image', async admission => {
      await gate.promise; admission.assertActive(); write(); return []
    }), rejected = expect(request).rejects.toThrow('unknown session')
    await tick()
    let done = false; const disposal = f.queue.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve(); await rejected; await disposal
    expect(early).toBe(false); expect(write).not.toHaveBeenCalled()
  })

  it('does not mask a native preparation failure with a coincident queue cancellation', async () => {
    const f = fixture(), gate = deferred<DurablePromptBlock[]>(), failure = new Error('storage failed')
    const request = f.submit('image', {}, () => gate.promise), rejected = expect(request).rejects.toBe(failure)
    await tick(); f.queue.cancel(); gate.reject(failure); await rejected
    expect(f.queue.busy).toBe(false)
  })

  it('preserves FIFO and emits completion before promoting a successor at whole-agent idle', async () => {
    const f = fixture()
    const first = f.submit('first'), second = f.submit('second')
    await tick()
    expect(f.echoes).toEqual(['first'])
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['second'])
    f.claim(1); f.observe(1)
    await expect(first).resolves.toEqual({ stopReason: 'end_turn', _meta: { sessionId: 'session', promptId: 'first' } })
    expect(f.echoes).toEqual(['first'])
    f.idle(); await tick()
    expect(f.echoes).toEqual(['first', 'second'])
    const complete = f.notes.findIndex(note => note.method === 'x.ai/session/prompt_complete' && note.params.promptId === 'first')
    const next = f.notes.findIndex(note => note.method === 'x.ai/queue/changed' && note.params.runningPromptId === 'second')
    expect(complete).toBeLessThan(next)
    f.finish(2); await second
    expect(f.queue.busy).toBe(false)
  })

  it('serializes asynchronous content admission without serializing whole turns', async () => {
    const f = fixture(), content = deferred<DurablePromptBlock[]>()
    const prepareSecond = vi.fn(async (): Promise<DurablePromptBlock[]> => [{ type: 'text', text: 'second' }])
    const first = f.submit('image', {}, () => content.promise)
    const second = f.submit('second', {}, prepareSecond)
    await tick()
    expect(prepareSecond).not.toHaveBeenCalled()
    expect(f.messages).toHaveLength(0)
    content.resolve([{ type: 'image', attachment: { id: 'image' } as Extract<DurablePromptBlock, { type: 'image' }>['attachment'] }])
    await tick()
    expect(prepareSecond).toHaveBeenCalledTimes(1)
    expect(f.snapshot().entries.map(row => row.id)).toEqual(['second'])
    f.finish(1); await first; await tick(); f.finish(2); await second
  })

  it('counts content preparation as busy and cancels its generation without disabling future input', async () => {
    const f = fixture(), content = deferred<DurablePromptBlock[]>()
    const first = f.submit('image', {}, () => content.promise)
    const prepare = vi.fn(async () => [{ type: 'text' as const, text: 'queued' }])
    const second = f.submit('queued', {}, prepare)
    expect(f.queue.busy).toBe(true)
    await tick(); f.queue.cancel()
    content.resolve([{ type: 'text', text: 'image' }])
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'image' } })
    await expect(second).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'queued' } })
    expect(prepare).not.toHaveBeenCalled(); expect(f.messages).toEqual([]); expect(f.queue.busy).toBe(false)
    const next = f.submit('fresh'); await tick(); f.finish(1); await next
    expect(f.echoes).toEqual(['fresh'])
  })

  it('releases a failed admission so the next accepted input can run', async () => {
    const f = fixture()
    const bad = f.submit('bad', {}, async () => { throw new Error('invalid image') })
    const failure = expect(bad).rejects.toThrow('invalid image')
    const good = f.submit('good')
    await failure; await tick()
    expect(f.echoes).toEqual(['good'])
    f.finish(1); await good
  })

  it('blocks late admission after disposal and waits for accepted preparation to retire', async () => {
    const f = fixture(), content = deferred<DurablePromptBlock[]>()
    const pending = f.submit('late', {}, () => content.promise)
    const rejected = expect(pending).rejects.toThrow('unknown session')
    await tick()
    let drained = false
    const disposal = f.queue.dispose().then(() => { drained = true })
    await tick(); expect(drained).toBe(false)
    content.resolve([{ type: 'text', text: 'late' }])
    await rejected; await disposal
    expect(f.messages).toHaveLength(0)
    const prepare = vi.fn(async () => [])
    await expect(f.submit('after', {}, prepare)).rejects.toThrow('unknown session')
    expect(prepare).not.toHaveBeenCalled()
  })

  it('still cancels active and held rows when native cancellation throws, without reviving old input', async () => {
    const f = fixture(), error = new Error('native cancellation failed')
    const first = f.submit('first'), queued = f.submit('queued')
    await tick(); f.control('hold_edit', { id: 'queued' })
    vi.mocked(f.agent.cancel).mockImplementationOnce(() => { throw error })
    expect(() => f.queue.cancel()).toThrow(error)
    await tick()
    const afterCancel = f.snapshot()
    // Let the native driver finish independently; cancellation failure must not run its old follower.
    f.idle(); await tick()
    const messages = [...f.messages]
    // Baseline cleanup allows a failing test to terminate without a stranded held row.
    await f.queue.dispose()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    await expect(queued).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(afterCancel.entries).toEqual([])
    expect(afterCancel.runningPromptId).toBe('first')
    expect(messages).toHaveLength(1)
  })

  it('publishes one disposal before cancellation reentry and waits for preparation even when cancellation throws', async () => {
    const f = fixture({ disposalError: 'native cancellation failed' }), content = deferred<DurablePromptBlock[]>(), error = new Error('native cancellation failed')
    const pending = f.submit('late', {}, () => content.promise)
    const rejected = expect(pending).rejects.toThrow('unknown session')
    await tick()
    let reentered!: Promise<void>
    vi.mocked(f.agent.cancel).mockImplementationOnce(() => { reentered = f.queue.dispose(); throw error })
    let done = false
    const disposal = f.queue.dispose()
    const outcome = disposal.catch(reason => { done = true; return reason })
    await tick()
    const doneEarly = done
    content.resolve([{ type: 'text', text: 'late' }])
    await rejected
    expect(await outcome).toBe(error)
    await reentered.catch(() => {})
    expect(doneEarly).toBe(false)
    expect(reentered).toBe(disposal)
    expect(f.queue.dispose()).toBe(disposal)
    expect(f.messages).toEqual([])
  })

  it('retains cancellation and notification errors after draining queued work', async () => {
    const notify = vi.fn(), f = fixture({ notify, disposalError: 'prompt cancellation failed' }), cancellation = new Error('cancel failed'), notification = new Error('notify failed')
    const first = f.submit('first'), queued = f.submit('queued')
    await tick()
    vi.mocked(f.agent.cancel).mockImplementationOnce(() => { throw cancellation })
    notify.mockImplementationOnce(() => { throw notification })
    const disposal = f.queue.dispose(), outcome = disposal.catch(error => error)
    f.idle()
    // Flush baseline strands so all assertions below report the real behavior.
    await tick(); f.queue.cancel()
    await Promise.all([first, queued])
    const error = await outcome
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toEqual([cancellation, notification])
  })

  it('clears running and steering ownership after output flush failure and admits the successor', async () => {
    const error = new Error('output hydration failed'), flushOutput = vi.fn(async () => {})
    const f = fixture({ flushOutput }), first = f.submit('first')
    const failed = expect(first).rejects.toBe(error)
    await tick()
    const steered = f.submit('steered', { followUp: 'steer' }), next = f.submit('next')
    await tick(); flushOutput.mockRejectedValueOnce(error)
    f.control('interject', { id: 'next', expectedVersion: 0 }); f.idle()
    await failed; await tick()
    expect(f.echoes).toEqual(['first', 'steered', 'next'])
    await expect(steered).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete')).toEqual([])
    f.finish(2); await next
    expect(f.queue.busy).toBe(false)
    expect(f.notes.find(note => note.method === 'x.ai/session/prompt_complete')!.params.cancelTrigger).toBeUndefined()
  })

  it('settles steering and admits the successor even if completion notification throws', async () => {
    const notify = vi.fn(), error = new Error('completion notification failed'), f = fixture({ notify })
    const first = f.submit('first'), failed = expect(first).rejects.toBe(error)
    await tick()
    const steered = f.submit('steered', { followUp: 'steer' }), next = f.submit('next')
    await tick(); f.control('interject', { id: 'next', expectedVersion: 0 })
    notify.mockImplementationOnce(() => { throw error }); f.idle()
    await failed; await tick()
    expect(f.echoes).toEqual(['first', 'steered', 'next'])
    await expect(steered).resolves.toMatchObject({ stopReason: 'cancelled' })
    f.finish(2); await next
    expect(f.queue.busy).toBe(false)
    expect(f.notes.find(note => note.method === 'x.ai/session/prompt_complete')!.params.cancelTrigger).toBeUndefined()
  })

  it('retains native, output and cleanup errors without poisoning future admission', async () => {
    const output = new Error('hydration failed'), notification = new Error('cleanup notification failed')
    const notify = vi.fn(), flushOutput = vi.fn(async () => {}), f = fixture({ notify, flushOutput })
    f.followup.mockImplementationOnce(() => { throw new Error('native admission failed') })
    flushOutput.mockRejectedValueOnce(output)
    notify.mockImplementationOnce(() => { throw notification })
    const error = await f.submit('bad').catch(reason => reason)
    expect(error).toBeInstanceOf(AggregateError)
    expect(error.errors).toHaveLength(3)
    expect(error.errors[0].message).toContain('native admission failed')
    expect(error.errors.slice(1)).toEqual([output, notification])
    expect(f.queue.busy).toBe(false)
    const next = f.submit('next'); await tick(); f.finish(1); await next
  })

  it('does not revive an unpublished session through a pending idle promotion', async () => {
    const f = fixture()
    const first = f.submit('first'), second = f.submit('second')
    await tick(); f.claim(1); f.observe(1); await first
    f.unpublish(); f.idle(); await tick()
    expect(f.messages).toHaveLength(1)
    await f.queue.dispose()
    await expect(second).resolves.toMatchObject({ stopReason: 'cancelled' })
  })

  it('settles steering with its host turn without a second prompt_complete', async () => {
    const f = fixture({ followUpSteer: true })
    const host = f.submit('host'); await tick()
    const steer = f.submit('steer'); await tick()
    expect(f.steered).toHaveLength(1)
    expect(f.echoes).toEqual(['host', 'steer'])
    expect(f.snapshot().entries).toEqual([])
    f.finish(1)
    await expect(steer).resolves.toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'steer' } })
    await host
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete').map(note => note.params.promptId)).toEqual(['host'])
  })

  it('keeps output hydration ahead of completion and successor admission', async () => {
    const output = deferred<void>()
    const f = fixture({ flushOutput: () => output.promise })
    const first = f.submit('first'), second = f.submit('second')
    await tick(); f.finish(1); await tick()
    expect(f.queue.busy).toBe(true)
    expect(f.messages).toHaveLength(1)
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete')).toEqual([])
    output.resolve(); await first; await tick()
    expect(f.messages).toHaveLength(2)
    f.finish(2); await second
  })

  it('merges only adjacent text rows and retains image-bearing message admission', async () => {
    const f = fixture({ combineQueued: true })
    const first = f.submit('first'); await tick()
    const a = f.submit('a'), b = f.submit('b')
    const image = f.submit('image', {}, async () => [{ type: 'image', attachment: { id: 'img' } as Extract<DurablePromptBlock, { type: 'image' }>['attachment'] }])
    const c = f.submit('c')
    await tick(); f.finish(1); await first; await tick()
    expect(f.echoes).toEqual(['first', 'a\n\nb'])
    expect(f.snapshot().runningCombinedTexts).toEqual(['a', 'b'])
    await expect(b).resolves.toMatchObject({ stopReason: 'cancelled' })
    f.finish(2); await a; await tick()
    expect(f.snapshot().runningPromptId).toBe('image')
    f.finish(3); await image; await tick(); f.finish(4); await c
  })

  it('uses versioned edits, front holds and reorder without losing or duplicating rows', async () => {
    const f = fixture()
    const first = f.submit('first'), a = f.submit('a'), b = f.submit('b')
    await tick()
    f.control('hold_edit', { id: 'a' })
    f.finish(1); await first; await tick()
    expect(f.messages).toHaveLength(1)
    f.control('edit', { id: 'a', newText: 'changed' })
    await tick(); expect(f.echoes).toEqual(['first', 'changed'])
    f.control('hold_edit', { id: 'b' })
    f.control('edit', { id: 'b', newText: 'b2', expectedVersion: 0 })
    f.control('remove', { id: 'b', expectedVersion: 0 })
    expect(f.snapshot().entries).toEqual([{ id: 'b', text: 'b2', version: 1, kind: 'prompt', position: 0 }])
    f.control('reorder', { orderedIds: ['b', 'b', 'unknown'] })
    expect(f.snapshot().entries).toHaveLength(1)
    f.finish(2); await a; await tick(); f.finish(3); await b
  })

  it('interjects ahead of pending rows with the send_now cancellation marker', async () => {
    const f = fixture()
    const first = f.submit('first'), a = f.submit('a'), b = f.submit('b')
    await tick()
    f.control('interject', { id: 'b', expectedVersion: 0 })
    await tick()
    expect(f.echoes).toEqual(['first'])
    expect(f.notes.filter(note => note.method === 'x.ai/session/prompt_complete')).toEqual([])
    f.idle()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.notes.find(note => note.method === 'x.ai/session/prompt_complete')!.params.cancelTrigger).toBe('send_now')
    await tick(); expect(f.echoes).toEqual(['first', 'b'])
    f.finish(2); await b; await tick(); f.finish(3); await a
  })

  it('cancels the active turn and queued followers without permanently closing the queue', async () => {
    const f = fixture()
    const first = f.submit('first'), a = f.submit('a')
    await tick(); f.control('hold_edit', { id: 'a' })
    f.queue.cancel(); f.idle()
    await expect(first).resolves.toMatchObject({ stopReason: 'cancelled' })
    await expect(a).resolves.toMatchObject({ stopReason: 'cancelled' })
    const reused = f.submit('a'); await tick(); f.finish(2); await reused
    expect(f.echoes).toEqual(['first', 'a'])
  })

  it('rejects only the correlated failed turn and recovers from rejected followup admission', async () => {
    const f = fixture()
    f.followup.mockImplementationOnce(() => { throw new Error('followup rejected') })
    await expect(f.submit('bad')).rejects.toThrow('followup rejected')
    expect(f.queue.busy).toBe(false)
    const good = f.submit('good')
    const rejection = expect(good).rejects.toThrow('correlated failure')
    await tick(); f.claim(2)
    f.queue.failed(99, new Error('unrelated')); await tick(); expect(f.queue.busy).toBe(true)
    f.queue.failed(2, new Error('correlated failure')); f.idle(); await rejection
    expect(f.queue.busy).toBe(false)
  })

  it('shares a monotonically increasing wire sequence across independently owned queues', async () => {
    const attach = createPromptQueues({ combineQueued: false, followUpSteer: false, logger: { warn() {} } })
    const a = fixture({}, attach), b = fixture({}, attach)
    const first = a.submit('a'); await tick(); const seqA = a.snapshot().seq
    const second = b.submit('b'); await tick(); expect(b.snapshot().seq).toBeGreaterThan(seqA)
    a.finish(1); b.finish(1); await Promise.all([first, second])
  })
})
