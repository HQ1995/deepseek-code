import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createSessionInput } from '../src/session-input.ts'
import { createPromptQueues, type PromptQueue, type PromptSettleResult } from '../src/prompt-queue.ts'
import { modelEffortKey, type ModelCatalog } from '../src/model-catalog.ts'
import type { ParsedPrompt } from '../src/prompt-content.ts'
import type { SessionModel } from '../src/session-models.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { for (const stop of stops.splice(0)) await stop() })
const tick = async () => { for (let i = 0; i < 25; i++) await Promise.resolve() }
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture() {
  const followup = vi.fn(), steer = vi.fn(), cancelAgent = vi.fn(), ready = { value: true }
  const agent = { session: { id: SessionId('one') }, status: 'idle', followup, steer, cancel: cancelAgent,
    whenIdle: async () => {} } as unknown as Agent
  const record = { clientId: 1, agent, prompts: [] as string[], model: { current: { provider: 'provider', model: 'vision' } as SessionModel['current'] }, queue: undefined as unknown as PromptQueue }
  let owner = record
  const notes = vi.fn()
  record.queue = createPromptQueues({ combineQueued: false, followUpSteer: false, logger: { warn() {} } })({
    sessionId: 'one', agent, isLive: () => owner === record, notify: notes, echo: vi.fn(), flushOutput: async () => {},
  })
  const catalog = { providerModelToWireId: new Map([[modelEffortKey('provider', 'vision'), 'vision']]),
    availableModels: [{ modelId: 'vision', name: 'Vision', _meta: { acceptsImages: true } }] } as ModelCatalog
  const saveImages = vi.fn(async (images: Array<{ mediaType: string; data: Uint8Array }>) => images.map((image, i) => ({
    attachmentId: 'image-' + i, mediaType: image.mediaType, bytes: image.data.length, width: 1, height: 1,
  })))
  const attachments = { saveImages } as unknown as AttachmentStore
  const host = {
    owned: vi.fn((id: number, sessionId: SessionId | undefined) => id === 1 && sessionId === 'one' ? owner : undefined),
    assertReady: vi.fn(() => { if (!ready.value) throw new Error('initializing') }),
    commands: { execute: vi.fn<(_record: typeof record, _params: Record<string, unknown>, _parsed: ParsedPrompt, _signal?: AbortSignal) => Promise<PromptSettleResult | undefined> | undefined>(() => undefined) },
    models: { current: vi.fn(async () => catalog) }, attachments: vi.fn(() => attachments),
    notify: vi.fn(), cancelHuman: vi.fn(), goal: { pauseGoal: vi.fn(), refresh: vi.fn() },
  }
  const input = createSessionInput(host)
  stops.push(async () => { await record.queue.dispose(); await input.dispose() })
  const prompt = (text = 'hello', images = false) => input.prompt(1, { sessionId: 'one', _meta: { promptId: 'request' },
    prompt: [{ type: 'text', text }, ...images ? [{ type: 'image', mimeType: 'image/png', data: 'AQ==' }] : []] })
  return { input, host, record, ready, catalog, attachments, saveImages, prompt, followup, steer, cancelAgent, notes,
    replace: () => { owner = { ...record } } }
}

describe('session input routing', () => {
  it('targets same-tick ordinary input without cancelling the native agent, human requests or goal', async () => {
    const f = fixture(), request = f.prompt()
    expect(f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'request' })).toEqual({ status: 'cancelled' })
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'request' } })
    expect(f.followup).not.toHaveBeenCalled(); expect(f.cancelAgent).not.toHaveBeenCalled()
    expect(f.host.cancelHuman).not.toHaveBeenCalled(); expect(f.host.goal.pauseGoal).not.toHaveBeenCalled()
    await f.prompt('fresh'); expect(f.followup).toHaveBeenCalledOnce()
  })

  it('rejects foreign, malformed and duplicate active prompt ownership', async () => {
    const f = fixture(), gate = deferred<undefined>()
    f.host.commands.execute.mockReturnValueOnce(gate.promise)
    const request = f.prompt('/unknown')
    expect(() => f.input.cancelPrompt(2, { sessionId: 'one', promptId: 'request' })).toThrow('unknown session')
    expect(() => f.input.cancelPrompt(1, { sessionId: 'one', promptId: '' })).toThrow('required')
    await expect(f.prompt('duplicate')).rejects.toThrow('duplicate active prompt')
    expect(f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'absent' })).toEqual({ status: 'not_found' })
    expect(f.record.prompts).toEqual(['/unknown'])
    gate.resolve(undefined); await request
  })

  it('cancels asynchronous command dispatch before its unhandled fallback reaches the queue', async () => {
    const f = fixture(), gate = deferred<undefined>()
    f.host.commands.execute.mockReturnValueOnce(gate.promise)
    const request = f.prompt('/unknown')
    const signal = f.host.commands.execute.mock.calls[0]![3]!
    expect(f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'request' })).toEqual({ status: 'cancelling' })
    expect(signal.aborted).toBe(true)
    gate.resolve(undefined)
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'request' } })
    expect(f.followup).not.toHaveBeenCalled(); expect(f.cancelAgent).not.toHaveBeenCalled()
    expect(f.host.goal.pauseGoal).not.toHaveBeenCalled()
  })

  it('keeps cancelled native command work in the input disposal drain and preserves native failures', async () => {
    const f = fixture(), gate = deferred<undefined>(), failure = new Error('native failure')
    f.host.commands.execute.mockReturnValueOnce(gate.promise)
    const request = f.prompt('/command'), rejected = expect(request).rejects.toBe(failure)
    f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'request' })
    let drained = false; const disposal = f.input.dispose().then(() => { drained = true })
    await tick(); const early = drained
    gate.reject(failure); await rejected; await disposal
    expect(early).toBe(false)
  })

  it('releases a targeted model lookup so fresh input runs without saving the late image', async () => {
    const f = fixture(), gate = deferred<ModelCatalog>()
    f.host.models.current.mockReturnValueOnce(gate.promise)
    const request = f.prompt('image', true)
    await tick()
    expect(f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'request' })).toEqual({ status: 'cancelled' })
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled' })
    await f.prompt('fresh')
    gate.resolve(f.catalog); await tick()
    expect(f.saveImages).not.toHaveBeenCalled()
    expect(f.followup).toHaveBeenCalledOnce()
    expect(f.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: 'fresh' }])
    expect(f.host.goal.pauseGoal).not.toHaveBeenCalled()
  })

  it('still cancels the running owner human request and pauses its goal when native cancellation fails', async () => {
    const f = fixture(), gate = deferred<void>(), error = new Error('native cancel failed')
    vi.spyOn(f.record.agent, 'whenIdle').mockReturnValue(gate.promise)
    const request = f.prompt(); await tick()
    f.cancelAgent.mockImplementationOnce(() => { throw error })
    expect(() => f.input.cancelPrompt(1, { sessionId: 'one', promptId: 'request' })).toThrow(error)
    gate.resolve(); await expect(request).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.host.cancelHuman).toHaveBeenCalledWith(1, 'one')
    expect(f.host.goal.pauseGoal).toHaveBeenCalledOnce(); expect(f.host.goal.refresh).toHaveBeenCalledOnce()
  })

  it('admits ordinary prompts synchronously before a same-tick cancel', async () => {
    const f = fixture(), request = f.prompt()
    expect(f.record.queue.busy).toBe(true)
    f.input.cancel(1, { sessionId: 'one' })
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'request' } })
    expect(f.followup).not.toHaveBeenCalled(); expect(f.record.prompts).toEqual(['hello'])
    await f.prompt('fresh')
    expect(f.followup).toHaveBeenCalledOnce()
  })

  it('validates ownership, readiness and content before appending composer history', async () => {
    const f = fixture()
    await expect(f.input.prompt(2, { sessionId: 'one', prompt: [] })).rejects.toThrow('unknown session')
    f.ready.value = false
    await expect(f.prompt()).rejects.toThrow('initializing')
    f.ready.value = true
    await expect(f.prompt(' ')).rejects.toThrow('empty prompt')
    await expect(f.input.prompt(1, { sessionId: 'one', prompt: [{ type: 'text', text: 1 }] })).rejects.toThrow('requires text')
    expect(f.record.prompts).toEqual([]); expect(f.host.commands.execute).not.toHaveBeenCalled()
  })

  it('preserves text/resource order and avoids attachment or model discovery for text-only input', async () => {
    const f = fixture()
    await f.input.prompt(1, { sessionId: 'one', prompt: [{ type: 'text', text: 'before' },
      { type: 'resource_link', name: 'file', uri: 'file:///tmp/a' }, { type: 'text', text: 'after' }] })
    expect(f.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: 'before' },
      { type: 'text', text: '\n[resource_link name="file" uri="file:///tmp/a"]\n' }, { type: 'text', text: 'after' }])
    expect(f.host.models.current).not.toHaveBeenCalled(); expect(f.host.attachments).not.toHaveBeenCalled()
  })

  it('handles turnless commands before model requirements and falls back only when unhandled', async () => {
    const f = fixture(), result = { stopReason: 'end_turn' as const, _meta: { sessionId: 'one', promptId: 'command' } }
    f.record.model.current = undefined
    f.host.commands.execute.mockReturnValueOnce(Promise.resolve(result))
    await expect(f.prompt('/dsh plugins')).resolves.toBe(result)
    expect(f.followup).not.toHaveBeenCalled()
    await expect(f.prompt('/unknown')).rejects.toThrow('no model selected')
    f.record.model.current = { provider: 'provider', model: 'vision' } as SessionModel['current']
    f.host.commands.execute.mockReturnValueOnce(Promise.resolve(undefined))
    await f.prompt('/unknown')
    expect(f.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '/unknown' }])
  })

  it('checks owner and input readiness again after asynchronous unhandled-command dispatch', async () => {
    const f = fixture(), gate = deferred<undefined>()
    f.host.commands.execute.mockReturnValueOnce(gate.promise)
    const request = f.prompt('/unknown'), rejected = expect(request).rejects.toThrow('initializing')
    f.ready.value = false; gate.resolve(undefined); await rejected
    expect(f.followup).not.toHaveBeenCalled()
  })

  it('checks image capability before durable admission and preserves native block order', async () => {
    const f = fixture()
    await f.prompt('', true)
    expect(f.record.prompts).toEqual(['[Image]'])
    expect(f.saveImages).toHaveBeenCalledOnce()
    expect(f.followup.mock.calls[0]![0].content).toEqual([{ type: 'text', text: '' },
      { type: 'image', attachment: { attachmentId: 'image-0', mediaType: 'image/png', bytes: 1, width: 1, height: 1 } }])
    f.catalog.availableModels[0]!._meta!.acceptsImages = false
    await expect(f.prompt('text', true)).rejects.toThrow('selected model does not support image input')
    expect(f.saveImages).toHaveBeenCalledOnce()
  })

  it('does not persist images after a model-capability wait crosses queue cancellation', async () => {
    const f = fixture(), gate = deferred<ModelCatalog>()
    f.host.models.current.mockReturnValueOnce(gate.promise)
    const request = f.prompt('image', true)
    await tick(); expect(f.host.models.current).toHaveBeenCalledOnce()
    f.input.cancel(1, { sessionId: 'one' }); gate.resolve(f.catalog)
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.saveImages).not.toHaveBeenCalled(); expect(f.followup).not.toHaveBeenCalled()
  })

  it('does not persist images when the attachment getter synchronously cancels admission', async () => {
    const f = fixture()
    f.host.attachments.mockImplementationOnce(() => { f.input.cancel(1, { sessionId: 'one' }); return f.attachments })
    await expect(f.prompt('image', true)).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.saveImages).not.toHaveBeenCalled(); expect(f.followup).not.toHaveBeenCalled()
  })

  it('drains discovery on module shutdown without saving or admitting a late image', async () => {
    const f = fixture(), gate = deferred<ModelCatalog>()
    f.host.models.current.mockReturnValueOnce(gate.promise)
    const request = f.prompt('image', true), rejected = expect(request).rejects.toThrow('disposed')
    await tick()
    let done = false; const disposal = f.input.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve(f.catalog); await rejected; await disposal
    expect(early).toBe(false); expect(f.saveImages).not.toHaveBeenCalled(); expect(f.followup).not.toHaveBeenCalled()
  })

  it('waits for already-started image storage after cancellation without reviving its queue row', async () => {
    const f = fixture(), gate = deferred<Awaited<ReturnType<typeof f.saveImages>>>()
    f.saveImages.mockReturnValueOnce(gate.promise)
    const request = f.prompt('image', true)
    await tick(); expect(f.saveImages).toHaveBeenCalledOnce()
    f.input.cancel(1, { sessionId: 'one' })
    expect(f.record.queue.busy).toBe(true)
    gate.resolve([{ attachmentId: 'image', mediaType: 'image/png', bytes: 1, width: 1, height: 1 }])
    await expect(request).resolves.toMatchObject({ stopReason: 'cancelled' })
    expect(f.followup).not.toHaveBeenCalled(); expect(f.record.queue.busy).toBe(false)
  })

  it('retains every cancellation error while still cancelling human requests and refreshing native state', () => {
    const f = fixture(), errors = [new Error('goal failed'), new Error('native cancel failed'), new Error('human failed')]
    f.host.goal.pauseGoal.mockImplementationOnce(() => { throw errors[0] })
    f.cancelAgent.mockImplementationOnce(() => { throw errors[1] })
    f.host.cancelHuman.mockImplementationOnce(() => { throw errors[2] })
    try { f.input.cancel(1, { sessionId: 'one' }); throw new Error('expected cancellation failure') }
    catch (error) { expect(error).toBeInstanceOf(AggregateError); expect((error as AggregateError).errors).toEqual(errors) }
    expect(f.host.cancelHuman).toHaveBeenCalledWith(1, 'one'); expect(f.host.goal.refresh).toHaveBeenCalledOnce()
  })

  it('steers immediately and preserves the caller interjection id without taking over queue settlement', () => {
    const f = fixture()
    expect(f.input.interject(1, { sessionId: 'one', text: 'urgent', interjectionId: 'origin' })).toEqual({})
    expect(f.steer.mock.calls[0]![0].content).toEqual([{ type: 'text', text: 'urgent' }])
    expect(f.record.prompts).toEqual(['urgent'])
    expect(f.host.notify).toHaveBeenCalledWith(f.record, 'x.ai/session/interjection', { sessionId: 'one', text: 'urgent', interjectionId: 'origin' })
    expect(f.record.queue.busy).toBe(false)
  })

  it('rejects invalid interjections and suppresses an echo after a reentrant owner replacement', () => {
    const f = fixture()
    expect(() => f.input.interject(1, { sessionId: 'one', text: '' })).toThrow('empty interjection')
    f.steer.mockImplementationOnce(f.replace)
    expect(() => f.input.interject(1, { sessionId: 'one', text: 'accepted' })).toThrow('session closed')
    expect(f.host.notify).not.toHaveBeenCalled()
  })

  it('unwraps owned queue notifications without treating unrelated nested payloads as authority', () => {
    const f = fixture(), control = vi.spyOn(f.record.queue, 'control'), method = 'x.ai/queue/clear'
    f.input.control(1, method, { method, params: { sessionId: 'one' } })
    expect(control).toHaveBeenCalledWith(method, { sessionId: 'one' })
    f.input.control(2, method, { sessionId: 'one' })
    f.input.control(1, method, { method: 'unrelated', params: { sessionId: 'one' } })
    f.input.control(1, method, null)
    expect(control).toHaveBeenCalledOnce()
  })

  it('registers command work before synchronous reentrant disposal and preserves its original failure', async () => {
    const f = fixture(), gate = deferred<undefined>(), failure = new Error('native command failed')
    let disposal!: Promise<void>, done = false
    f.host.commands.execute.mockImplementationOnce(() => {
      disposal = f.input.dispose(); void disposal.then(() => { done = true }); return gate.promise
    })
    const request = f.prompt('/command'), rejected = expect(request).rejects.toBe(failure)
    await tick(); const early = done
    gate.reject(failure); await rejected; await disposal
    expect(early).toBe(false); expect(f.input.dispose()).toBe(disposal)
    await expect(f.prompt()).rejects.toThrow('disposed')
    f.input.cancel(1, { sessionId: 'one' }); f.input.control(1, 'x.ai/queue/clear', { sessionId: 'one' })
    expect(f.host.goal.pauseGoal).not.toHaveBeenCalled()
  })
})
