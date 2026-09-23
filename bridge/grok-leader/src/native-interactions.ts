import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import type { LeaderClient } from './leader-transport.ts'

interface InteractionSession { agent: Agent; clientId: number; yolo: boolean; queue: { cancel(): void }; work: { cancel(): void } }
interface InteractionEvents {
  'approval/request': (request: ApprovalRequestEvent, next: () => Promise<ApprovalOutcome>) => Promise<ApprovalOutcome>
  'user-questions/request': (request: AskUserQuestionRequest, next: () => Promise<AskUserQuestionAnswer>) => Promise<AskUserQuestionAnswer>
}
interface InteractionHost<S extends InteractionSession> {
  ownedAgent(agent: Agent): S | undefined
  owned(clientId: number, id: SessionId | undefined): S | undefined
  assertReady(record: S): void
  client(id: number): Pick<LeaderClient, 'closed' | 'request' | 'rejectSessionRequests'> | undefined
  permissionPresets(): { set(session: Agent['session'], preset: string): void } | undefined
  planMode(record: S): { set(agent: Agent, active: boolean): unknown } | undefined
  on<K extends keyof InteractionEvents>(name: K, listener: InteractionEvents[K]): () => void
  logger: { warn(message: string): void }
}
type Meta = Record<string, unknown> | null | undefined
const permissionModes = new Set(['default', 'ask', 'workspace-write', 'plan', 'bypassPermissions', 'always-approve'])
const object = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : undefined
const cancelledQuestion = () => new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')

/** Native policy and human answerers share exact-session ownership. This module
 * owns subscriptions and accepted reverse requests, not the transport engine.
 * Human waits have no deadline; native abort, reload, close and host disposal
 * cancel them. A reply which already left the transport still needs admission
 * checks before it may become an approval or a structured native answer. */
export function createNativeInteractions<S extends InteractionSession>(host: InteractionHost<S>) {
  let closed = false, disposal: Promise<void> | undefined
  const pending = new Map<AbortController, { record: S; promise: Promise<unknown> }>()
  const inconsistent = new WeakSet<S>()
  const unsubscribes: Array<() => void> = []
  const assertReady = (record: S): void => {
    if (closed) throw internalError('native interactions have been disposed')
    if (inconsistent.has(record)) throw invalidParams('session permission state is inconsistent; close or reload the session')
  }
  const live = (record: S): boolean => {
    if (closed || host.ownedAgent(record.agent) !== record || host.client(record.clientId)?.closed !== false) return false
    try { assertReady(record); host.assertReady(record); return true } catch { return false }
  }
  const accepted = <R>(record: S, signal: AbortSignal | undefined, run: (signal: AbortSignal) => Promise<R>): Promise<R> => {
    const controller = new AbortController(), abort = () => controller.abort()
    // Publish work before any external request callback can reenter disposal.
    const promise = Promise.resolve().then(() => run(controller.signal)).finally(() => {
      signal?.removeEventListener('abort', abort)
      pending.delete(controller)
    })
    pending.set(controller, { record, promise })
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted || !live(record)) abort()
    return promise
  }
  const cancel = (clientId: number, id: string): void => {
    for (const [controller, { record }] of pending) {
      if (record.clientId === clientId && record.agent.session.id === id) controller.abort()
    }
    host.client(clientId)?.rejectSessionRequests(id)
  }
  const failedMutation = (record: S, error: unknown): never => {
    record.yolo = false
    inconsistent.add(record)
    // A native setter may already have appended part of its change. Do not
    // keep an active turn or previously accepted queue running in that state.
    const failures = [error]
    try { record.work.cancel() } catch (failure) { failures.push(failure) }
    try { record.queue.cancel() } catch (failure) { failures.push(failure) }
    try { cancel(record.clientId, record.agent.session.id) } catch (failure) { failures.push(failure) }
    if (failures.length > 1) throw new AggregateError(failures, 'permission change and cancellation failed')
    throw error
  }
  const approval: InteractionEvents['approval/request'] = (request, next) => {
    if (closed) return Promise.resolve('cancelled')
    const record = host.ownedAgent(request.agent)
    if (record === undefined || request.callId === undefined) return next()
    const client = host.client(record.clientId)
    if (client === undefined) return next()
    return accepted(record, request.signal, async signal => {
      if (signal.aborted || !live(record)) return 'cancelled'
      // Browser actions reach arbitrary hosts; always-approve never covers them.
      if (record.yolo && request.toolName?.startsWith('mcp__playwright-mcp__') !== true) return 'allowed-once'
      try {
        const response = await client.request<unknown>('session/request_permission', {
          sessionId: record.agent.session.id,
          toolCall: { toolCallId: request.callId, displayName: request.toolName },
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
        }, record.agent.session.id, Infinity, signal)
        if (signal.aborted || !live(record)) return 'cancelled'
        const outcome = object(object(response)?.outcome)
        if (outcome?.outcome === 'cancelled') return 'cancelled'
        return outcome?.outcome === 'selected' && outcome.optionId === 'allow-once' ? 'allowed-once' : 'rejected'
      } catch (error) {
        host.logger.warn('grok-leader: permission request failed: ' + errorChain(error))
        return 'cancelled'
      }
    })
  }
  const question: InteractionEvents['user-questions/request'] = (request, next) => {
    if (closed) return Promise.reject(cancelledQuestion())
    const record = request.agent === undefined ? undefined : host.ownedAgent(request.agent)
    const client = record === undefined ? undefined : host.client(record.clientId)
    if (record === undefined || client === undefined) return next()
    return accepted(record, request.signal, async signal => {
      if (signal.aborted || !live(record)) throw cancelledQuestion()
      // Native IDs are stable; legacy heading keys must be unambiguous.
      const byId = new Map(request.questions.map(item => [item.id, item]))
      const textToId = new Map<string, string | undefined>()
      const questions = request.questions.map(item => {
        const text = [item.header, item.question, item.detail]
          .filter(value => typeof value === 'string' && value.length > 0).join('\n')
        textToId.set(text, textToId.has(text) ? undefined : item.id)
        return { question: text, id: item.id,
          options: (item.options ?? []).map(option => ({ label: option.label, description: option.description ?? '' })),
          ...item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect },
        }
      })
      let response: unknown
      try {
        // Keep fields FLAT: the real pager deserializes params directly, not
        // a nested {method, params} wrapper. Human waits are deliberately unbounded.
        response = await client.request<unknown>('_x.ai/ask_user_question', {
          sessionId: record.agent.session.id, toolCallId: randomUUID(), questions, mode: 'default',
        }, record.agent.session.id, Infinity, signal)
      } catch (error) {
        if (signal.aborted || !live(record)) throw cancelledQuestion()
        throw error
      }
      if (signal.aborted || !live(record)) throw cancelledQuestion()
      const payload = object(response), wireAnswers = object(payload?.answers)
      if (payload?.outcome !== 'accepted' || wireAnswers === undefined) throw cancelledQuestion()
      const annotations = object(payload.annotations), answers: AskUserQuestionAnswer['answers'] = []
      for (const [key, labels] of Object.entries(wireAnswers)) {
        const id = byId.has(key) ? key : textToId.get(key)
        if (id === undefined) throw new UserQuestionError('unknown or ambiguous question in response', 'ASK_CANCELLED')
        const rawLabels = Array.isArray(labels) ? labels : labels === undefined ? [] : [labels]
        const notes = object(annotations?.[key])?.notes
        const offered = new Set(byId.get(id)?.options?.map(option => option.label))
        const selected = rawLabels.filter((label): label is string => typeof label === 'string' && (label !== 'Other' || offered.has(label)))
        answers.push({ id, selected, ...typeof notes === 'string' && notes.length > 0 ? { custom: notes } : {} })
      }
      return { answers }
    })
  }
  const validateMeta = (meta: Meta, method: string): void => {
    if (meta === undefined || meta === null) return
    for (const key of ['yoloMode', 'autoMode', 'askUserQuestion', 'noReplay', 'rememberAgentPreset']) {
      if (meta[key] !== undefined && typeof meta[key] !== 'boolean') throw invalidParams('_meta.' + key + ' must be a boolean')
    }
    for (const key of ['permissionMode', 'sandbox']) {
      if (meta[key] !== undefined && typeof meta[key] !== 'string') throw invalidParams('_meta.' + key + ' must be a string')
    }
    if (meta.subagents === false) throw invalidParams('--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead')
    const unsupported: string[] = []
    if (meta.autoMode === true) unsupported.push('autoMode')
    if (meta.askUserQuestion === false) unsupported.push('askUserQuestion')
    if (typeof meta.permissionMode === 'string' && !permissionModes.has(meta.permissionMode)) unsupported.push('permissionMode=' + JSON.stringify(meta.permissionMode))
    if (typeof meta.sandbox === 'string' && meta.sandbox !== 'off' && meta.sandbox !== 'none') unsupported.push('sandbox=' + JSON.stringify(meta.sandbox))
    for (const key of ['systemPromptOverride', 'rules', 'tools', 'disallowedTools']) if (meta[key] !== undefined) unsupported.push(key)
    if (unsupported.length > 0) throw invalidParams(method + ' cannot enforce _meta.' + unsupported.join(', _meta.') + '; refusing to run with silently weakened CLI settings')
  }
  const applyMode = (record: S, mode: string | undefined, yolo: boolean | undefined): void => {
    assertReady(record)
    if (mode === undefined && yolo === undefined) return
    const effective = mode === undefined || permissionModes.has(mode) ? mode : 'default'
    if (effective !== mode) host.logger.warn('grok-leader: unsupported permission mode notification "' + mode + '" failed closed to default')
    const fullAccess = effective === undefined ? yolo === true : effective === 'bypassPermissions' || effective === 'always-approve'
    const plan = host.planMode(record), permission = host.permissionPresets()
    // Validate before touching either native state or the bridge's bypass bit.
    if (effective === 'plan' && plan === undefined) throw invalidParams('permissionMode "plan" is not available in the selected agent preset')
    try {
      plan?.set(record.agent, effective === 'plan')
      permission?.set(record.agent.session, fullAccess ? 'danger-full-access' : 'workspace-write')
      record.yolo = fullAccess
    } catch (error) { failedMutation(record, error) }
  }
  const mode = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'session/set_mode')
    const record = closed ? undefined : host.owned(clientId, typeof p.sessionId === 'string' ? SessionId(p.sessionId) : undefined)
    if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
    assertReady(record); host.assertReady(record)
    const plan = host.planMode(record)
    if (plan === undefined) throw internalError('plan mode is not available in this agent preset')
    try { plan.set(record.agent, p.modeId === 'plan') }
    catch (error) { failedMutation(record, error) }
    return {}
  }
  const notification = (clientId: number, params: unknown): void => {
    const outer = object(params), p = object(outer?.params) ?? outer
    const record = closed || typeof p?.sessionId !== 'string' ? undefined : host.owned(clientId, SessionId(p.sessionId))
    if (record === undefined) return
    try {
      host.assertReady(record)
      applyMode(record, typeof p?.permission_mode === 'string' ? p.permission_mode : undefined,
        typeof p?.yolo_mode === 'boolean' ? p.yolo_mode : undefined)
    } catch (error) { host.logger.warn('grok-leader: permission mode notification failed: ' + errorChain(error)) }
  }
  const dispose = (): Promise<void> => {
    if (disposal !== undefined) return disposal
    closed = true
    const failures: unknown[] = []
    disposal = Promise.resolve().then(async () => {
      while (pending.size > 0) await Promise.allSettled([...pending.values()].map(item => item.promise))
      if (failures.length > 0) throw new AggregateError(failures, 'native interaction disposal failed')
    })
    for (const controller of pending.keys()) controller.abort()
    for (const stop of unsubscribes.splice(0)) { try { stop() } catch (error) { failures.push(error) } }
    return disposal
  }
  try {
    unsubscribes.push(host.on('approval/request', approval))
    unsubscribes.push(host.on('user-questions/request', question))
  } catch (error) {
    closed = true
    for (const controller of pending.keys()) controller.abort()
    // Construction can fail after a callback has already accepted work.
    for (const { promise } of pending.values()) void promise.catch(() => {})
    const failures: unknown[] = [error]
    for (const stop of unsubscribes.splice(0)) { try { stop() } catch (failure) { failures.push(failure) } }
    throw new AggregateError(failures, 'native interaction subscription setup failed')
  }
  return { validateMeta, assertReady, mode, notification, cancel, dispose,
    /** Adoption occurs before publication; live mutations must use mode/notification. */
    apply: (record: S, meta: Meta) => applyMode(record,
      typeof meta?.permissionMode === 'string' ? meta.permissionMode : undefined,
      typeof meta?.yoloMode === 'boolean' ? meta.yoloMode : undefined),
  }
}
