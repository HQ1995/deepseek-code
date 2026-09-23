import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AttachmentStore } from '@deepseek-ai/dsh-attachment'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import type { createModelCatalog } from './model-catalog.ts'
import { modelEffortKey } from './wire-catalog.ts'
import { admitPromptContent, parsePrompt, type ParsedPrompt, type DurablePromptBlock } from './prompt-content.ts'
import type { PromptCancelResult, PromptQueue, PromptSettleResult } from './prompt-queue.ts'
import type { SessionModel } from './session-models.ts'
import { acpPromptToText } from './projection.ts'

interface InputSession {
  agent: Agent
  clientId: number
  prompts: string[]
  queue: Pick<PromptQueue, 'submit' | 'cancel' | 'cancelPrompt' | 'promptId' | 'control'>
  model: Pick<SessionModel, 'current'>
}
interface InputHost<S extends InputSession> {
  owned(clientId: number, sessionId: SessionId | undefined): S | undefined
  assertReady(record: S): void
  commands: { execute(record: S, params: Record<string, unknown>, parsed: ParsedPrompt, signal?: AbortSignal): Promise<PromptSettleResult | undefined> | undefined }
  models: Pick<ReturnType<typeof createModelCatalog>, 'current'>
  attachments(): AttachmentStore | undefined
  notify(record: S, method: string, params: unknown): void
  cancelHuman(clientId: number, sessionId: SessionId): void
  goal: { pauseGoal(record: S): void; refresh(record: S): void }
}

/** Composer input validation/routing and cancellation, not a second queue.
 * The queue owns admission generations, FIFO/steering and terminal settlement;
 * commands own turnless execution. Ordinary text reaches submit synchronously,
 * while accepted preparation/dispatch remains attached to this module's drain. */
export function createSessionInput<S extends InputSession>(host: InputHost<S>) {
  let closed = false, disposal: Promise<void> | undefined
  const pending = new Set<Promise<unknown>>()
  // Published before command discovery can await; the queue takes over content
  // preparation and turns. Keep native command completion attached to our drain.
  const requests = new WeakMap<S, Map<string, { controller: AbortController; queued: boolean }>>()
  const assertOpen = () => { if (closed) throw internalError('session input has been disposed') }
  const active = (record: S) => {
    assertOpen()
    if (host.owned(record.clientId, record.agent.session.id) !== record) throw invalidParams('session closed')
  }
  const owned = (clientId: number, id: unknown) => {
    assertOpen()
    const record = host.owned(clientId, typeof id === 'string' ? SessionId(id) : undefined)
    if (record === undefined) throw invalidParams('unknown session: ' + String(id))
    active(record); host.assertReady(record); active(record)
    return record
  }
  const accept = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(internalError('session input has been disposed'))
    let resolve!: (value: T | PromiseLike<T>) => void, reject!: (error: unknown) => void
    const result = new Promise<T>((yes, no) => { resolve = yes; reject = no })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    try { resolve(Promise.resolve(operation()).then(value => { assertOpen(); return value })) }
    catch (error) { reject(error) }
    return result
  }
  return {
    prompt(clientId: number, params: unknown) {
      return accept(async () => {
        const p = paramRecord(params, 'session/prompt'), record = owned(clientId, p.sessionId)
        const parsed = parsePrompt(p.prompt)
        const text = parsed.text.trim().length > 0 ? parsed.text : parsed.images.length > 0 ? '[Image]' : ''
        if (text.length === 0) throw invalidParams('empty prompt')
        const meta = typeof p._meta === 'object' && p._meta !== null && !Array.isArray(p._meta) ? p._meta as Record<string, unknown> : {}
        const id = typeof meta.promptId === 'string' && meta.promptId.length > 0 ? meta.promptId : randomUUID()
        const requestParams = { ...p, _meta: { ...meta, promptId: id } }
        let ownedRequests = requests.get(record)
        if (ownedRequests === undefined) { ownedRequests = new Map(); requests.set(record, ownedRequests) }
        if (ownedRequests.has(id)) throw invalidParams('duplicate active prompt: ' + id)
        const request = { controller: new AbortController(), queued: false }
        ownedRequests.set(id, request)
        try {
          // History records accepted composer input, including queued commands.
          record.prompts.push(text)
          const execution = host.commands.execute(record, requestParams, parsed, request.controller.signal)
          if (execution !== undefined) {
            const handled = await execution
            active(record)
            request.controller.signal.throwIfAborted()
            if (handled !== undefined) return handled
            host.assertReady(record)
          }
          request.controller.signal.throwIfAborted()
          if (record.model.current === undefined) throw invalidParams('no model selected; use /provider to add or choose a provider first')
          request.queued = true
          return await record.queue.submit(requestParams, text, async admission => {
            const check = () => { assertOpen(); admission.assertActive() }
            check()
            if (parsed.images.length > 0) {
              const selected = record.model.current
              if (selected === undefined) throw invalidParams('no model selected; use /provider to add or choose a provider first')
              const current = await host.models.current()
              check()
              const wireId = current.providerModelToWireId.get(modelEffortKey(selected.provider, selected.model))
              const advertised = current.availableModels.find(model => model.modelId === wireId)
              if (advertised?._meta?.acceptsImages !== true) throw invalidParams('selected model does not support image input: ' + selected.provider + '/' + selected.model)
            }
            if (parsed.images.length > 0) {
              const attachments = host.attachments()
              check()
              return admitPromptContent(attachments, parsed)
            }
            return parsed.blocks.map((block): DurablePromptBlock => {
              if (block.type === 'text') return block
              if (block.type === 'resource_link') return { type: 'text', text: acpPromptToText([block]) }
              throw internalError('image prompt admission state drifted')
            })
          })
        } catch (error) {
          if (!request.controller.signal.aborted || error !== request.controller.signal.reason) throw error
          active(record)
          return { stopReason: 'cancelled', _meta: { sessionId: String(record.agent.session.id), promptId: id } }
        } finally { ownedRequests.delete(id) }
      })
    },
    interject(clientId: number, params: unknown) {
      const p = paramRecord(params, 'x.ai/interject'), record = owned(clientId, p.sessionId)
      const text = typeof p.text === 'string' ? p.text : ''
      if (text.trim().length === 0) throw invalidParams('empty interjection')
      record.prompts.push(text)
      record.agent.steer(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
      active(record)
      // The originator already rendered its block; its id dedupes this echo.
      host.notify(record, 'x.ai/session/interjection', { sessionId: String(record.agent.session.id), text,
        ...typeof p.interjectionId === 'string' ? { interjectionId: p.interjectionId } : {} })
      return {}
    },
    cancel(clientId: number, params: unknown): void {
      if (closed) return
      const p = typeof params === 'object' && params !== null && !Array.isArray(params) ? params as Record<string, unknown> : undefined
      const record = host.owned(clientId, typeof p?.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
      if (record === undefined) return
      const failures: unknown[] = []
      // session/cancel must abort composer work that has not reached the queue
      // yet; cancelPrompt already does this for a targeted promptId.
      for (const request of requests.get(record)?.values() ?? []) {
        if (!request.queued) request.controller.abort()
      }
      for (const cancel of [() => host.goal.pauseGoal(record), () => record.queue.cancel(),
        () => host.cancelHuman(clientId, record.agent.session.id), () => host.goal.refresh(record)]) {
        try { cancel() } catch (error) { failures.push(error) }
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'prompt cancellation failed')
    },
    /** A separate request method makes old leaders fail closed (method-not-found)
     * instead of ignoring metadata and clearing their entire session queue. */
    cancelPrompt(clientId: number, params: unknown): { status: PromptCancelResult | 'cancelling' } {
      assertOpen()
      const p = paramRecord(params, 'x.ai/session/cancel_prompt')
      if (typeof p.sessionId !== 'string' || typeof p.promptId !== 'string' || p.promptId.length === 0) throw invalidParams('sessionId and promptId are required')
      const record = host.owned(clientId, SessionId(p.sessionId))
      if (record === undefined) throw invalidParams('unknown session: ' + p.sessionId)
      active(record)
      const request = requests.get(record)?.get(p.promptId)
      if (request !== undefined && !request.queued) {
        request.controller.abort()
        return { status: 'cancelling' }
      }
      const running = record.queue.promptId === p.promptId
      let status: PromptCancelResult = 'not_found'
      const failures: unknown[] = []
      const steps = [() => { status = record.queue.cancelPrompt(p.promptId as string) }]
      if (running) steps.push(() => host.goal.pauseGoal(record),
        () => host.cancelHuman(clientId, record.agent.session.id), () => host.goal.refresh(record))
      for (const step of steps) { try { step() } catch (error) { failures.push(error) } }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'prompt cancellation failed')
      return { status }
    },
    control(clientId: number, method: string, params: unknown): void {
      if (closed) return
      const outer = params as Record<string, unknown> | undefined
      const p = outer !== undefined && outer !== null && typeof outer.params === 'object' && outer.params !== null
        && (outer.method === undefined || outer.method === method) ? outer.params as Record<string, unknown> : outer
      if (typeof p?.sessionId !== 'string') return
      host.owned(clientId, SessionId(p.sessionId))?.queue.control(method, p)
    },
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => { while (pending.size > 0) await Promise.allSettled([...pending]) })
      return disposal
    },
  }
}
