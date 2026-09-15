import { describe, expect, it, vi } from 'vitest'
import { createHook } from 'node:async_hooks'
import type { AssistantStreamFrame } from '@deepseek-ai/dsh-agent'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { createSessionOutput } from '../src/session-output.ts'
import type { ContextProjectionValues, ProjectedUpdate } from '../src/projection.ts'

type Note = { method: string; params: { sessionId: string; update: ProjectedUpdate; _meta: Record<string, unknown> } }
const event = (seq: number, type: string, data: unknown, time = 1000 + seq): SessionEvent => ({ seq, type, data, time }) as SessionEvent
const text = (body: string): ProjectedUpdate => ({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: body } })
const assistantEvent = (seq: number, body: string, usage = { inputTokens: 10, outputTokens: 2 }) => event(seq, 'assistant/message', {
  turn: 0, step: 0, usage, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: body }] },
})
const imageEvent = (seq: number) => event(seq, 'tool/ptc-dispatch', { subCallId: 'image-' + seq, name: 'read', content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }] })
function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  let live = true, promptId: string | undefined = 'prompt'
  let values: ContextProjectionValues = {}
  const notes: Note[] = []
  const warn = vi.fn()
  const drain = vi.fn<() => Promise<void> | undefined>(() => undefined)
  const projectImages = vi.fn(async (_event: SessionEvent, updates: ProjectedUpdate[]): Promise<ProjectedUpdate[]> => updates)
  const output = createSessionOutput({ sessionId: 'session', cwd: () => '/workspace', drain,
    isLive: () => live, promptId: () => promptId, contextValues: () => values,
    notify: (method, params) => { notes.push({ method, params: params as Note['params'] }) }, projectImages, logger: { warn } })
  const content = () => notes.flatMap(note => {
    const update = note.params.update
    return 'content' in update && !Array.isArray(update.content) && update.content?.type === 'text' ? [update.content.text] : []
  })
  const frame = (value: unknown) => output.assistant(value as AssistantStreamFrame)
  return { output, notes, warn, projectImages, content, frame, drain,
    unpublish: () => { live = false }, setPrompt: (id: string | undefined) => { promptId = id }, setContext: (next: ContextProjectionValues) => { values = next } }
}

describe('session output ownership', () => {
  it.each([false, true])('uses a constant-sized Promise drain for long ordinary replay (visible=%s)', async visible => {
    const f = fixture()
    const history = Array.from({ length: 4000 }, (_, seq) => visible
      ? assistantEvent(seq, String(seq)) : event(seq, 'fixture/no-output', {}))
    let promises = 0
    const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promises++ } })
    hook.enable()
    try { await f.output.restore(history) } finally { hook.disable() }
    expect(promises).toBeLessThan(100)
    expect(f.notes).toHaveLength(visible ? 4000 : 0)
    expect(f.projectImages).not.toHaveBeenCalled()
    if (visible) {
      expect(f.content()).toEqual(history.map((_, index) => String(index)))
      expect(f.notes.map(note => note.params._meta.eventSeq)).toEqual(history.map((_, index) => index + 1))
      expect(f.notes[0]!.params._meta.contextInfo).toMatchObject({ messageCount: 4000 })
    }
  })

  it('retains reentrant successors behind reserved history across slow-reader queue compaction', async () => {
    const f = fixture(), held = deferred<void>()
    f.drain.mockImplementationOnce(() => { f.output.update(text('reentrant')); return held.promise })
    const replay = f.output.restore(Array.from({ length: 2500 }, (_, index) => assistantEvent(index, String(index))))
    await vi.waitFor(() => expect(f.content()).toEqual(['0']))
    f.setPrompt('next')
    held.resolve(); await replay
    expect(f.content()).toEqual([...Array.from({ length: 2500 }, (_, index) => String(index)), 'reentrant'])
    expect(f.notes.map(note => note.params._meta.promptId)).toEqual(Array.from({ length: 2501 }, () => 'prompt'))
    expect(f.notes.map(note => note.params._meta.eventSeq)).toEqual(Array.from({ length: 2501 }, (_, index) => index + 1))
  })

  it('admits each event once while preserving all blocks and live/replay meter dedup', async () => {
    const f = fixture()
    const prompt = event(0, 'user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'one' }, { type: 'text', text: 'two' }] })
    await f.output.restore([prompt])
    expect(f.content()).toEqual(['one', 'two'])
    expect(f.output.stats.messageCount).toBe(1)
    f.output.live(prompt)
    await f.output.restore([prompt])
    expect(f.content()).toEqual(['one', 'two'])
    expect(f.output.stats.messageCount).toBe(1)
    const answer = assistantEvent(1, 'answer')
    f.output.live(answer); await f.output.restore([answer])
    expect(f.content()).toEqual(['one', 'two', 'answer'])
    expect(f.output.stats.messageCount).toBe(2)
    expect(f.notes.at(-1)!.params._meta.cumulativeTokens).toBe(12)
  })

  it('rebuilds headless state without transcript output or image hydration', async () => {
    const f = fixture()
    const log = [event(0, 'turn/start', { turn: 0 }), assistantEvent(1, 'old answer'), event(2, 'turn/end', { turn: 0, reason: { kind: 'completed' } })]
    await f.output.restore(log, false)
    expect(f.notes).toEqual([])
    expect(f.projectImages).not.toHaveBeenCalled()
    expect(f.output.stats).toMatchObject({ turnCount: 1, messageCount: 1 })
    f.output.live(log[1]!); expect(f.notes).toEqual([])
    f.output.update(text('new'))
    expect(f.notes[0]!.params._meta).toMatchObject({ eventSeq: 1, streamStartMs: 1000, promptId: 'prompt' })
  })

  it('correlates live stream settlement by exact event and ignores duplicate/late frames', () => {
    const f = fixture()
    f.frame({ type: 'start', attemptId: 'a', revision: 1, turn: 0, step: 0 })
    const chunk = { type: 'chunk', attemptId: 'a', revision: 2, index: 0, time: 1010, chunk: { type: 'text-delta', index: 0, text: 'live' } }
    f.frame(chunk); f.frame(chunk)
    f.output.live(event(0, 'assistant/message', { turn: 0, step: 0, stream: [{ type: 'text-chunks', time0: 1010, index: 0, dt: [], texts: ['live'] }], message: { role: 'assistant', content: [{ type: 'text', text: 'live' }] } }))
    f.output.live(assistantEvent(1, 'other'))
    expect(f.content()).toEqual(['live'])
    f.frame({ type: 'end', attemptId: 'a', revision: 3, index: 1, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 0 } })
    expect(f.content()).toEqual(['live', 'other'])
    f.frame({ ...chunk, revision: 4, index: 1 }); f.frame({ type: 'start', attemptId: 'a', revision: 5, turn: 0, step: 0 })
    expect(f.content()).toEqual(['live', 'other'])
    f.frame({ type: 'start', attemptId: 'b', revision: 6, turn: 0, step: 1 })
    f.frame({ ...chunk, revision: 7, attemptId: 'a' })
    expect(f.content()).toEqual(['live', 'other'])
  })

  it('replaces same-step usage but keeps separately billed retry attempts', () => {
    const f = fixture()
    f.output.live(assistantEvent(0, 'first', { inputTokens: 10, outputTokens: 2 }))
    f.output.live(assistantEvent(1, 'replacement', { inputTokens: 12, outputTokens: 3 }))
    expect(f.notes.at(-1)!.params._meta.cumulativeTokens).toBe(15)
    f.output.live(event(2, 'llm/retry-started', { turn: 0, step: 0, retry: 1 }))
    f.output.live(assistantEvent(3, 'retry', { inputTokens: 5, outputTokens: 2 }))
    expect(f.notes.at(-1)!.params._meta.cumulativeTokens).toBe(22)
  })

  it('keeps occupancy separate from cumulative spend and owns feature envelope identity', () => {
    const f = fixture()
    f.setContext({ contextPressure: { projectedTokens: 120, contextWindow: 1000 } })
    f.output.live(assistantEvent(0, 'spend', { inputTokens: 9000, outputTokens: 2000 }))
    expect(f.notes[0]!.params._meta).toMatchObject({ cumulativeTokens: 11000, contextInfo: { used: 120, total: 1000 } })
    f.output.notify('x.ai/session_notification', { sessionId: 'foreign', update: { sessionUpdate: 'feature' } }, { eventSeq: -1, native: true })
    f.output.activity(true)
    expect(f.notes.map(note => note.params._meta.eventSeq)).toEqual([1, 2, 3])
    expect(f.notes[1]!.params).toMatchObject({ sessionId: 'session', _meta: { native: true, eventSeq: 2 } })
    expect(f.notes[1]!.params._meta.promptId).toBeUndefined()
    const snapshot = f.output.stats
    snapshot.messageCount = 99
    expect(f.output.stats.messageCount).toBe(1)
  })

  it('serializes hydrated tool output ahead of later text and captures the accepting prompt', async () => {
    const f = fixture(), image = deferred<ProjectedUpdate[]>()
    f.projectImages.mockImplementationOnce(() => image.promise)
    f.output.live(event(0, 'tool/result', { message: { content: [{ type: 'tool-result', toolCallId: 'image', content: [{ type: 'image', attachment: {} }] }] } }))
    f.output.update(text('after image'))
    expect(f.notes).toEqual([])
    f.setPrompt('next')
    image.resolve([{ sessionUpdate: 'tool_call_update', toolCallId: 'image', status: 'completed', rawOutput: { dscodeImages: ['/image.png'] } }])
    await f.output.flush()
    expect(f.notes.map(note => note.params.update.sessionUpdate)).toEqual(['tool_call_update', 'agent_message_chunk'])
    expect(f.notes.map(note => note.params._meta.promptId)).toEqual(['prompt', 'prompt'])
  })

  it('keeps delayed output stamped with the turn that accepted it', async () => {
    const f = fixture(), image = deferred<ProjectedUpdate>()
    f.output.live(event(0, 'turn/start', { turn: 0 }, 1000))
    f.output.update(image.promise)
    f.output.live(event(1, 'turn/start', { turn: 1 }, 2000))
    f.output.update(text('next turn'))
    image.resolve(text('previous turn')); await f.output.flush()
    expect(f.notes.filter(note => note.params.update.sessionUpdate === 'agent_message_chunk')
      .map(note => note.params._meta.turnStartMs)).toEqual([1000, 2000])
  })

  it('keeps an asynchronous replay event ahead of a live successor', async () => {
    const f = fixture(), image = deferred<ProjectedUpdate[]>()
    f.projectImages.mockImplementationOnce(() => image.promise)
    const replay = f.output.restore([imageEvent(0)])
    f.output.live(assistantEvent(1, 'new'))
    expect(f.notes).toEqual([])
    image.resolve([text('old')]); await replay
    expect(f.content()).toEqual(['old', 'new'])
    expect(f.notes[0]!.params._meta.isReplay).toBe(true)
    expect(f.notes[1]!.params._meta.isReplay).toBeUndefined()
  })

  it('reserves the whole replay prefix before live events while hydrating one event at a time', async () => {
    const f = fixture(), first = deferred<ProjectedUpdate[]>()
    f.projectImages.mockImplementationOnce(() => first.promise)
    f.projectImages.mockImplementationOnce(async () => [text('old two')])
    const replay = f.output.restore([imageEvent(0), imageEvent(1)])
    f.output.live(assistantEvent(2, 'live'))
    await Promise.resolve()
    expect(f.projectImages).toHaveBeenCalledTimes(1)
    first.resolve([text('old one')]); await replay
    expect(f.content()).toEqual(['old one', 'old two', 'live'])
    expect(f.output.stats.messageCount).toBe(1)
    expect(f.projectImages).toHaveBeenCalledTimes(2)
  })

  it('waits for replay socket drain without losing reserved history or overtaking a live successor', async () => {
    const f = fixture(), held = deferred<void>()
    f.drain.mockImplementationOnce(() => held.promise)
    const replay = f.output.restore([assistantEvent(0, 'first'), assistantEvent(1, 'second')])
    f.output.live(assistantEvent(2, 'live'))
    await vi.waitFor(() => expect(f.content()).toEqual(['first']))
    expect(f.projectImages).not.toHaveBeenCalled()
    held.resolve(); await replay
    expect(f.content()).toEqual(['first', 'second', 'live'])
    expect(f.output.stats.messageCount).toBe(3)
    expect(f.notes.map(note => note.params._meta.eventSeq)).toEqual([1, 2, 3])
  })

  it.each(['dispose', 'unpublish'])('drops late hydration after %s and cannot resurrect output', async action => {
    const f = fixture(), pending = deferred<ProjectedUpdate>()
    f.output.update(pending.promise)
    const drain = action === 'dispose' ? f.output.dispose() : (f.unpublish(), f.output.flush())
    pending.resolve(text('late')); await drain
    f.output.live(assistantEvent(0, 'later')); f.output.update(text('later')); f.output.activity(false)
    expect(f.notes).toEqual([])
  })

  it('logs a failed projection and drains later output rather than stranding the queue', async () => {
    const f = fixture(), pending = deferred<ProjectedUpdate>()
    f.output.update(pending.promise); f.output.update(text('after failure'))
    pending.reject(new Error('preview unavailable'))
    await f.output.flush()
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('preview unavailable'))
    expect(f.content()).toEqual(['after failure'])
  })

  it('observes a queued projection rejection immediately without overtaking the preceding output', async () => {
    const f = fixture(), first = deferred<ProjectedUpdate>(), second = deferred<ProjectedUpdate>()
    f.output.update(first.promise); f.output.update(second.promise); f.output.update(text('last'))
    second.reject(new Error('second preview failed early'))
    // Give the runtime an unhandled-rejection checkpoint while the first
    // output is still pending. Logging and successors must retain FIFO order.
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.content()).toEqual([])
    first.resolve(text('first'))
    await f.output.flush()
    expect(f.content()).toEqual(['first', 'last'])
    expect(f.warn).toHaveBeenCalledOnce()
  })
})
