import type { Context } from '@deepseek-ai/cordis'
import { installModelSelection, type Agent, type AgentOptions, type ModelSelection, type ModelSelectionRef } from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId, errorChain } from '@deepseek-ai/dsh-llm'
import type { SessionId, SessionEvent } from '@deepseek-ai/dsh-session'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { nonEmpty } from './guards.ts'
import type { CatalogChange, createModelCatalog } from './model-catalog.ts'
import type { AgentDefaultModelLike } from './native-seams.ts'
import { acceptedReasoningEffort, modelEffortKey, modelSelectionFromRequest, type ModelCatalog } from './wire-catalog.ts'
import { LEGACY_MODEL_SELECTION_EVENTS } from './session-migration.ts'

interface DscodeModelSelectionEvent { provider: string; model: string; reasoningEffort?: string }
declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    'model/selection': ModelSelection
    'dscode/model-selected': DscodeModelSelectionEvent
    'model/selected': DscodeModelSelectionEvent
  }
}
// Legacy names are normalized by the migration adapter before native admission.

export interface SessionModel {
  readonly current: Readonly<ModelSelection> | undefined
  readonly agentOptions: Pick<AgentOptions, 'provider' | 'model'>
  install(ctx: Context): void
  /** Settle accepted writes for reversible reload without releasing routing. */
  settle(): Promise<void>
  /** Drain accepted selection writes before releasing the owning native agent. */
  dispose(): Promise<void>
}
interface ModelSession { clientId: number; agent: Agent; model: SessionModel }
interface ModelState {
  selection: ModelSelectionRef
  efforts: Map<string, string>
  pending: Set<Promise<unknown>>
  tail: Promise<unknown>
  subscriptions: Set<() => void>
  closed: boolean
  disposal?: Promise<void>
}
interface ModelHost<S extends ModelSession> {
  config: { provider?: string; model?: string }
  sessions: ReadonlyMap<SessionId, S>
  owned(clientId: number, id: SessionId | undefined): S | undefined
  clients(): Iterable<number>
  notify(clientId: number, method: string, params: unknown): void
  catalog: Pick<ReturnType<typeof createModelCatalog>, 'current' | 'peek' | 'select' | 'selected'>
  defaults(): AgentDefaultModelLike | undefined
  flush(session: Agent['session']): Promise<unknown>
}
const isSelection = (event: SessionEvent) => event.type === 'model/selection' || LEGACY_MODEL_SELECTION_EVENTS.has(event.type)
function selectionFromLog(events: readonly SessionEvent[]): ModelSelection | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]!
    if (!isSelection(event)) continue
    const { provider, model, reasoningEffort } = event.data as DscodeModelSelectionEvent
    if (!nonEmpty(provider) || !nonEmpty(model)) continue
    return { provider, model, ...nonEmpty(reasoningEffort) ? { reasoningEffort: ReasoningEffortId(reasoningEffort) } : {} }
  }
  return undefined
}
function effortsFromLog(events: readonly SessionEvent[], selection: ModelSelection | undefined): Map<string, string> {
  const efforts = new Map<string, string>()
  const remember = ({ provider, model, reasoningEffort }: DscodeModelSelectionEvent) => {
    if (nonEmpty(provider) && nonEmpty(model) && nonEmpty(reasoningEffort)) efforts.set(modelEffortKey(provider, model), reasoningEffort)
  }
  if (selection !== undefined) remember(selection)
  for (const event of events) if (isSelection(event)) remember(event.data as DscodeModelSelectionEvent)
  return efforts
}

/** Owns runtime model references, durable choice/effort memory and scoped
 * catalog fan-out. Session construction only installs the prepared handle;
 * callers never mutate a reference or carry an effort cache themselves. */
export function createSessionModels<S extends ModelSession>(host: ModelHost<S>) {
  const states = new WeakMap<SessionModel, ModelState>()
  const handles = new Set<SessionModel>()
  const pending = new Set<Promise<unknown>>()
  let closed = false, disposal: Promise<void> | undefined
  const assertOpen = () => { if (closed) throw internalError('session models have been disposed') }
  const isLive = (record: S) => !closed && states.get(record.model)?.closed === false && host.sessions.get(record.agent.session.id) === record
  const assertLive = (record: S) => { if (!isLive(record)) throw invalidParams('session closed') }
  const run = <R>(operation: () => Promise<R>, state?: ModelState): Promise<R> => {
    let resolve!: (value: R | PromiseLike<R>) => void, reject!: (reason: unknown) => void
    const work = new Promise<R>((yes, no) => { resolve = yes; reject = no })
    pending.add(work); state?.pending.add(work)
    const done = () => { pending.delete(work); state?.pending.delete(work) }
    void work.then(done, done)
    try { resolve(operation()) } catch (error) { reject(error) }
    return work
  }
  const drain = async (work: ReadonlySet<Promise<unknown>>) => {
    while (work.size > 0) await Promise.allSettled([...work])
  }
  const prepare = async (meta?: Record<string, unknown> | null, events: readonly SessionEvent[] = []): Promise<SessionModel> => {
    assertOpen()
    const fallback = selectionFromLog(events) ?? host.defaults()?.currentSelection?.()
    const remembered = modelSelectionFromRequest(host.config, fallback, meta)
    const current = await host.catalog.select(fallback, meta)
    assertOpen()
    const state: ModelState = { selection: { current, assembled: undefined }, efforts: effortsFromLog(events, remembered ?? current), pending: new Set(), tail: Promise.resolve(), subscriptions: new Set(), closed: false }
    const model: SessionModel = {
      get current() { return state.selection.current === undefined ? undefined : { ...state.selection.current } },
      get agentOptions() {
        const provider = state.selection.current?.provider ?? host.config.provider
        const model = state.selection.current?.model ?? host.config.model
        return { ...provider === undefined ? {} : { provider }, ...model === undefined ? {} : { model } }
      },
      install(ctx) {
        assertOpen()
        if (state.closed) throw invalidParams('session model disposed')
        state.subscriptions.add(installModelSelection(ctx, state.selection))
      },
      settle: () => drain(state.pending),
      dispose() {
        state.closed = true
        return state.disposal ??= Promise.resolve().then(async () => {
          await drain(state.pending)
          const failures: unknown[] = []
          for (const stop of state.subscriptions) { try { stop() } catch (error) { failures.push(error) } }
          state.subscriptions.clear()
          handles.delete(model)
          if (failures.length > 0) throw new AggregateError(failures, 'session model subscription disposal failed')
        })
      },
    }
    states.set(model, state)
    handles.add(model)
    return model
  }
  const notify = (record: S, current = host.catalog.peek()): void => {
    if (!isLive(record) || current === undefined) return
    const selection = record.model.current
    const selectedId = selection === undefined ? '' : current.providerModelToWireId.get(modelEffortKey(selection.provider, selection.model)) ?? ''
    host.notify(record.clientId, 'x.ai/models/update', {
      currentModelId: selectedId,
      availableModels: current.availableModels.map(model => {
        if (selection === undefined || model.modelId !== selectedId || model._meta === undefined) return model
        const meta = { ...model._meta }
        delete meta.reasoningEffort
        return { ...model, _meta: { ...meta, ...selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort } } }
      }),
      _meta: { currentProviderId: selection?.provider ?? '', providers: current.providers },
    })
  }
  const reconcile = (record: S, current: ModelCatalog) => {
    const state = states.get(record.model)!, selection = state.selection.current
    if (selection === undefined) return
    const key = modelEffortKey(selection.provider, selection.model), wireId = current.providerModelToWireId.get(key)
    if (wireId === undefined) return
    const advertised = current.availableModels.find(model => model.modelId === wireId)
    const requested = selection.reasoningEffort ?? state.efforts.get(key)
    const accepted = acceptedReasoningEffort(advertised, requested)
    if (accepted === undefined && requested !== undefined) state.efforts.delete(key)
    if (accepted !== selection.reasoningEffort) state.selection.current = { provider: selection.provider, model: selection.model, ...accepted === undefined ? {} : { reasoningEffort: ReasoningEffortId(accepted) } }
  }
  const change = async (record: S, state: ModelState, p: Record<string, unknown>): Promise<object> => {
    assertLive(record)
    const modelId = p.modelId
    if (!nonEmpty(modelId)) throw invalidParams('modelId must be a non-empty string')
    const meta = p._meta as Record<string, unknown> | null | undefined
    const explicitEffort = nonEmpty(meta?.reasoningEffort) ? meta.reasoningEffort : undefined
    const current = await host.catalog.current()
    assertLive(record)
    if (!current.routesByModel.has(modelId)) throw invalidParams('modelId is not in the catalog: ' + modelId)
    const advertised = current.availableModels.find(model => model.modelId === modelId)
    if (explicitEffort !== undefined && (advertised?._meta?.supportsReasoningEffort === false
      || (advertised?._meta?.reasoningEfforts !== undefined && !advertised._meta.reasoningEfforts.includes(explicitEffort)))) {
      throw invalidParams('reasoningEffort "' + explicitEffort + '" is not supported by model ' + modelId)
    }
    const { provider, model: rawModel } = current.routesByModel.get(modelId)!
    const key = modelEffortKey(provider, rawModel)
    const remembered = state.efforts.get(key)
    const effort = explicitEffort ?? acceptedReasoningEffort(advertised, remembered)
    const selection: ModelSelection = { provider, model: rawModel, ...effort === undefined ? {} : { reasoningEffort: ReasoningEffortId(effort) } }
    // Match the acknowledged TUI switch: a failed default save leaves the live
    // choice unchanged. Retirement during that native write drains it, but must
    // not append to a retired session when the write returns.
    await host.defaults()?.saveSelection(selection)
    assertLive(record)
    // Keep the live reference and effort memory unchanged if append fails.
    record.agent.session.append('model/selection', selection)
    state.selection.current = selection
    if (effort === undefined) state.efforts.delete(key)
    else state.efforts.set(key, effort)
    // Once appended the model really changed. A flush error is a durability
    // warning, not a rejected switch that would leave the UI on the old model.
    // The accepted operation still drains before native agent disposal.
    let persistenceWarning: string | undefined
    try { await host.flush(record.agent.session) } catch (error) {
      persistenceWarning = 'Model changed, but session history could not be saved; resuming may restore the previous model. ' + errorChain(error)
    }
    assertLive(record)
    host.catalog.selected(selection)
    notify(record)
    return persistenceWarning === undefined ? {} : { _meta: { persistenceWarning } }
  }
  return {
    prepare: (meta?: Record<string, unknown> | null, events?: readonly SessionEvent[]) => run(() => prepare(meta, events)),
    set(clientId: number, params: unknown): Promise<object> {
      return run(async () => {
        assertOpen()
        const p = paramRecord(params, 'session/set_model')
        const record = host.owned(clientId, sessionIdParam(p.sessionId))
        if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
        const state = states.get(record.model)
        if (state === undefined || !isLive(record)) throw invalidParams('session closed')
        const previous = state.tail
        const work = run(async () => { await previous; return change(record, state, p) }, state)
        state.tail = work.then(() => {}, () => {})
        return work
      })
    },
    changed(current: ModelCatalog, reason: CatalogChange): void {
      if (closed) return
      const awaitingSession = new Set(host.clients())
      for (const record of host.sessions.values()) {
        if (!isLive(record)) continue
        // Metadata may have moved under a live choice unless the write was ours.
        if (reason !== 'mutation') reconcile(record, current)
        notify(record, current); awaitingSession.delete(record.clientId)
      }
      for (const clientId of awaitingSession) host.notify(clientId, 'x.ai/models/update', {
        currentModelId: current.currentModelId, availableModels: current.availableModels,
        _meta: { currentProviderId: current.currentProviderId, providers: current.providers },
      })
    },
    isProviderInUse(id: string): boolean { return [...host.sessions.values()].some(record => record.model.current?.provider === id) },
    dispose(): Promise<void> {
      closed = true
      return disposal ??= Promise.resolve().then(async () => {
        const results = await Promise.allSettled([...handles].map(model => model.dispose()))
        await drain(pending)
        const failures = results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : [])
        if (failures.length > 0) throw new AggregateError(failures, 'session model disposal failed')
      })
    },
  }
}
