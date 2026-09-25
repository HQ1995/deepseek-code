import { randomUUID } from 'node:crypto'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { ApprovalOutcome } from '@deepseek-ai/dsh-user-approval'
import type { ApprovalRequestEvent } from '@deepseek-ai/dsh-user-approval/types'
import { UserQuestionError, type AskUserQuestionAnswer, type AskUserQuestionRequest } from '@deepseek-ai/dsh-user-questions'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { browserAction, isBrowserTool } from './browser-actions.ts'
import { isRecord } from './guards.ts'
import type { LeaderClient } from './leader-transport.ts'
import { environmentLocale, pick } from './localized-text.ts'
import { callView, registryPresenter, viewKind } from './tool-views.ts'

interface InteractionSession { agent: Agent; clientId: number; yolo: boolean; queue: { cancel(): void }; work: { cancel(): void } }
interface PendingCall { readonly callId?: string; readonly name: string; readonly arguments: unknown }
interface InteractionEvents {
  'tools/pre-execute': (exec: PendingCall, next: () => Promise<unknown>) => Promise<unknown>
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
  on<K extends keyof InteractionEvents>(name: K, listener: InteractionEvents[K], options?: { prepend?: boolean }): () => void
  logger: { warn(message: string): void }
  /** Lower-case BCP 47 tag an approval reason is shown in; defaults to the process locale. */
  locale?(): string | undefined
  /** Hands the model the text a user typed while rejecting a call; a returned
   * promise is the queued fallback's settlement. */
  rejectionFeedback?(record: S, text: string): Promise<unknown> | undefined
}
type Meta = Record<string, unknown> | null | undefined
const permissionModes = new Set(['default', 'ask', 'workspace-write', 'plan', 'bypassPermissions', 'always-approve'])
const object = (value: unknown): Record<string, unknown> | undefined => isRecord(value) ? value : undefined
const cancelledQuestion = () => new UserQuestionError('the user cancelled ask_user_question', 'ASK_CANCELLED')
/** Calls whose arguments an approval prompt may still show. */
const RECENT_CALLS = 64
/** Prefix of the audited reason DSH 0.1.7-rc.2's experimental auto-review
 * gives a call its reviewer denied and hands to a human. The request carries
 * no other mark, and always-approve must never answer it; a spec checks the
 * installed package still writes it. */
export const REVIEWER_DENIED = 'Auto review denied tool "'
const REASON_LIMIT = 500

/** One prompt line for why an approval is asked: `displayReason` in the
 * locale (see `pick`), then the audited `reason`. Control and format
 * characters (bidi overrides included) and line breaks collapse to spaces;
 * the text is bounded by code points. */
export function approvalReason(request: Pick<ApprovalRequestEvent, 'reason' | 'displayReason'>, locale?: string): string | undefined {
  const chosen = pick(request.displayReason, locale)
    ?? (typeof request.reason === 'string' && request.reason.trim() !== '' ? request.reason : undefined)
  if (chosen === undefined) return undefined
  const line = [...chosen.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim()]
  return line.length > REASON_LIMIT ? line.slice(0, REASON_LIMIT - 1).join('') + '…' : line.join('')
}

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
  // Approval requests name only the call. Its arguments come from the
  // pre-execute pass that runs just before; a bounded window keeps an ask that
  // never reaches an answerer from pinning them.
  const calls = new Map<string, PendingCall>()
  const remember: InteractionEvents['tools/pre-execute'] = (exec, next) => {
    if (typeof exec.callId === 'string') {
      calls.delete(exec.callId)
      // Only what the prompt shows: the live execution must not outlive its call.
      calls.set(exec.callId, { callId: exec.callId, name: exec.name, arguments: exec.arguments })
      if (calls.size > RECENT_CALLS) calls.delete(calls.keys().next().value!)
    }
    return next()
  }
  const locale = (): string | undefined => host.locale === undefined ? environmentLocale() : host.locale()
  /** The TUI shows the planned arguments and, for browser calls, what they do.
   * A tool that presents its call sends that view (`_meta['dscode/view']`) and
   * the kind it implies, and the prompt renders from it as the tool's card does.
   * The title is the view's title (else the tool name) and, after " — ", the
   * asker's reason, which the TUI shows as its own line. A browser prompt names
   * its action instead: the browser plugin's fixed reason restates what the
   * docs and `/browser status` say. */
  const permissionToolCall = (agent: Agent, callId: string, toolName: string, reason: string | undefined) => {
    const call = calls.get(callId)
    calls.delete(callId)
    const args = call?.name === toolName ? call.arguments : undefined
    const action = browserAction(toolName, args)
    const view = args === undefined || action !== undefined ? undefined
      : callView(registryPresenter(agent), toolName, args, agent.session.header?.cwd)
    const title = action !== undefined ? 'the browser to ' + action
      : reason === undefined ? view?.title : (view?.title ?? toolName) + ' — ' + reason.replace(/[.。]+$/u, '')
    return {
      toolCallId: callId, displayName: toolName,
      ...title === undefined ? {} : { title },
      ...view === undefined ? {} : { kind: viewKind(view) },
      ...args === undefined ? {} : {
        rawInput: toolName.startsWith('mcp__') ? { variant: 'MCPTool', tool_name: toolName, tool_input: args } : args,
      },
      ...view === undefined ? {} : { _meta: { 'dscode/view': view } },
    }
  }
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
  /** DSH's approval outcome has no room for a reason, so the text the TUI's
   * reject row invites travels as a steer once the rejection has resolved. */
  const deliverFeedback = (record: S, text: string): void => {
    const failed = (error: unknown) => { host.logger.warn('grok-leader: rejection feedback was not delivered: ' + errorChain(error)) }
    try {
      if (!live(record)) throw new Error('session closed')
      void host.rejectionFeedback?.(record, text)?.catch(failed)
    } catch (error) { failed(error) }
  }
  const approval: InteractionEvents['approval/request'] = (request, next) => {
    if (closed) return Promise.resolve('cancelled')
    const record = host.ownedAgent(request.agent)
    const callId = request.callId
    if (record === undefined || callId === undefined) return next()
    const client = host.client(record.clientId)
    if (client === undefined) return next()
    let feedback: string | undefined
    const decided = accepted(record, request.signal, async signal => {
      if (signal.aborted || !live(record)) return 'cancelled'
      // Browser actions reach arbitrary hosts, and a reviewer's denial is a
      // decision only a human may overrule; always-approve covers neither.
      const alwaysAsks = isBrowserTool(request.toolName)
        || (typeof request.reason === 'string' && request.reason.startsWith(REVIEWER_DENIED))
      if (record.yolo && !alwaysAsks) { calls.delete(callId); return 'allowed-once' }
      try {
        const response = await client.request<unknown>('session/request_permission', {
          sessionId: record.agent.session.id,
          toolCall: permissionToolCall(request.agent, callId, request.toolName, approvalReason(request, locale())),
          options: [
            { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
            { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' },
          ],
          // The TUI neither auto-approves nor offers always-approve for these.
          ...alwaysAsks ? { _meta: { dscodeAlwaysAsks: true } } : {},
        }, record.agent.session.id, Infinity, signal)
        if (signal.aborted || !live(record)) return 'cancelled'
        const outcome = object(object(response)?.outcome)
        if (outcome?.outcome === 'cancelled') return 'cancelled'
        if (outcome?.outcome === 'selected' && outcome.optionId === 'allow-once') return 'allowed-once'
        const text = object(object(response)?._meta)?.followup_message
        if (typeof text === 'string' && text.trim() !== '') feedback = text
        return 'rejected'
      } catch (error) {
        host.logger.warn('grok-leader: permission request failed: ' + errorChain(error))
        return 'cancelled'
      }
    })
    void decided.then(outcome => { if (outcome === 'rejected' && feedback !== undefined) deliverFeedback(record, feedback) }, () => {})
    return decided
  }
  /** A plan-review question (DSH's `exit_plan_mode`) opens the TUI's plan
   * approval view, and its decision answers the question: approve selects the
   * approve label; request changes selects the other option, with the feedback
   * as the custom answer; abandon turns plan mode off and dismisses the review,
   * which DSH tells the model means stop and wait. */
  const planReview = async (record: S, client: NonNullable<ReturnType<InteractionHost<S>['client']>>, item: AskUserQuestionRequest['questions'][number],
    intent: { approve: string; callId?: string }, signal: AbortSignal): Promise<AskUserQuestionAnswer> => {
    let response: unknown
    try {
      response = await client.request<unknown>('_x.ai/exit_plan_mode', {
        sessionId: record.agent.session.id, toolCallId: intent.callId ?? randomUUID(), planContent: item.detail ?? '',
      }, record.agent.session.id, Infinity, signal)
    } catch (error) {
      if (signal.aborted || !live(record)) throw cancelledQuestion()
      throw error
    }
    if (signal.aborted || !live(record)) throw cancelledQuestion()
    const outcome = object(response)?.outcome, feedback = object(response)?.feedback
    if (outcome === 'approved') return { answers: [{ id: item.id, selected: [intent.approve] }] }
    const revise = item.options?.find(option => option.label !== intent.approve)?.label
    if (outcome === 'cancelled' && revise !== undefined) {
      return { answers: [{ id: item.id, selected: [revise], ...typeof feedback === 'string' && feedback.trim() !== '' ? { custom: feedback } : {} }] }
    }
    if (outcome === 'abandoned') {
      try { host.planMode(record)?.set(record.agent, false) } catch (error) { host.logger.warn('grok-leader: leaving plan mode failed: ' + errorChain(error)) }
    }
    throw cancelledQuestion()
  }
  const question: InteractionEvents['user-questions/request'] = (request, next) => {
    if (closed) return Promise.reject(cancelledQuestion())
    const record = request.agent === undefined ? undefined : host.ownedAgent(request.agent)
    const client = record === undefined ? undefined : host.client(record.clientId)
    if (record === undefined || client === undefined) return next()
    const review = request.questions.length === 1 ? request.questions[0] : undefined
    const intent = review?.intent?.kind === 'plan-review' ? review.intent : undefined
    if (review !== undefined && intent !== undefined) {
      return accepted(record, request.signal, async signal => {
        if (signal.aborted || !live(record)) throw cancelledQuestion()
        return planReview(record, client, review, intent, signal)
      })
    }
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
    const record = closed ? undefined : host.owned(clientId, sessionIdParam(p.sessionId))
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
    const record = closed ? undefined : host.owned(clientId, sessionIdParam(p?.sessionId))
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
    // First in the chain, so a policy that answers without delegating still leaves the arguments.
    unsubscribes.push(host.on('tools/pre-execute', remember, { prepend: true }))
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
