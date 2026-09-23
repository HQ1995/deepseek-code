import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, ModelSelection } from '@deepseek-ai/dsh-agent'
import { KNOWN_SESSION_EVENT_TYPES, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { AgentDefaultModelLike } from '../src/native-seams.ts'
import { acceptedReasoningEffort, modelEffortKey, modelSelectionFromRequest, type ModelCatalog } from '../src/wire-catalog.ts'
import { createSessionModels, type SessionModel } from '../src/session-models.ts'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
interface Record { clientId: number; agent: Agent; model: SessionModel }
function fixture(config: { provider?: string; model?: string } = {}) {
  const sessions = new Map<SessionId, Record>(), clients = new Set([1, 2, 3])
  const view: ModelCatalog = {
    currentModelId: 'shared', currentProviderId: 'alpha', providers: [{ id: 'alpha' }, { id: 'beta' }],
    availableModels: [
      { modelId: 'shared', name: 'Alpha', _meta: { provider: 'alpha', supportsReasoningEffort: true, reasoningEfforts: ['high', 'low'] } },
      { modelId: 'beta:shared', name: 'Beta', _meta: { provider: 'beta', supportsReasoningEffort: true, reasoningEfforts: ['high', 'low'] } },
      { modelId: 'plain', name: 'Plain', _meta: { provider: 'alpha', supportsReasoningEffort: false } },
    ],
    routesByModel: new Map([['shared', { provider: 'alpha', model: 'shared' }], ['beta:shared', { provider: 'beta', model: 'shared' }], ['plain', { provider: 'alpha', model: 'plain' }]]),
    providerModelToWireId: new Map([[modelEffortKey('alpha', 'shared'), 'shared'], [modelEffortKey('beta', 'shared'), 'beta:shared'], [modelEffortKey('alpha', 'plain'), 'plain']]),
  }
  let defaultSelection: { provider: string; model: string; reasoningEffort?: string } | undefined = { provider: 'alpha', model: 'shared', reasoningEffort: 'high' }
  const order: string[] = []
  const defaults: AgentDefaultModelLike = {
    currentSelection: () => defaultSelection,
    saveSelection: vi.fn(async next => { order.push('save:' + next.provider + '/' + next.model); defaultSelection = { ...next } }),
  }
  const catalog = {
    current: vi.fn(async () => view), peek: vi.fn((): ModelCatalog | undefined => view), refresh: vi.fn(async () => view),
    selected: vi.fn((choice: Pick<ModelSelection, 'provider' | 'model'>) => {
      const wire = view.providerModelToWireId.get(modelEffortKey(choice.provider, choice.model))
      if (wire !== undefined) { view.currentModelId = wire; view.currentProviderId = choice.provider }
    }),
    select: vi.fn(async (fallback: Parameters<typeof modelSelectionFromRequest>[1], meta: Parameters<typeof modelSelectionFromRequest>[2]): Promise<ModelSelection | undefined> => {
      const choice = modelSelectionFromRequest(config, fallback, meta)
      if (choice === undefined) return undefined
      const wire = view.providerModelToWireId.get(modelEffortKey(choice.provider, choice.model))
      const effort = acceptedReasoningEffort(view.availableModels.find(model => model.modelId === wire), choice.reasoningEffort)
      return { provider: choice.provider, model: choice.model, ...effort === undefined ? {} : { reasoningEffort: effort as ModelSelection['reasoningEffort'] } }
    }),
  }
  const notify = vi.fn(), flush = vi.fn(async (_session: Agent['session']) => { order.push('flush') })
  const host = { sessions, clients: () => clients.values(), config, catalog, defaults: (): AgentDefaultModelLike | undefined => defaults,
    owned: (clientId: number, id: SessionId | undefined) => {
      const record = id === undefined ? undefined : sessions.get(id)
      return record?.clientId === clientId ? record : undefined
    }, notify, flush }
  const models = createSessionModels(host)
  const add = async (id = 'root', clientId = 1, events: SessionEvent[] = [], meta?: Parameters<typeof modelSelectionFromRequest>[2]) => {
    const model = await models.prepare(meta, events), ctx = new Context()
    const append = vi.fn((type: string, data: unknown) => {
      order.push('append:' + (data as { provider: string; model: string }).provider + '/' + (data as { model: string }).model)
      const event = { type, data, seq: events.length, time: 1 } as SessionEvent
      events.push(event); return event
    })
    const agent = { id, ctx, options: model.agentOptions, session: { id: SessionId(id), append } } as unknown as Agent
    const record = { clientId, agent, model }
    sessions.set(agent.session.id, record)
    return { record, model, ctx, events, append }
  }
  const set = (modelId: string, effort?: string, clientId = 1, sessionId = 'root') => models.set(clientId, { sessionId, modelId, _meta: { reasoningEffort: effort } })
  return { models, host, view, sessions, clients, catalog, defaults, notify, flush, order, add, set,
    setDefault: (value: typeof defaultSelection) => { defaultSelection = value } }
}
const event = (type: string, data: unknown): SessionEvent => ({ type, data, seq: 0, time: 0 }) as SessionEvent

describe('session model ownership', () => {
  it('prepares independent runtime references from latest native/legacy choices and exact per-model effort memory', async () => {
    const f = fixture()
    expect(KNOWN_SESSION_EVENT_TYPES.has('dscode/model-selected')).toBe(false)
    expect(KNOWN_SESSION_EVENT_TYPES.has('model/selected')).toBe(false)
    const root = await f.add('root', 1, [
      event('dscode/model-selected', { provider: 'alpha', model: 'shared', reasoningEffort: 'low' }),
      event('model/selected', { provider: 'beta', model: 'shared', reasoningEffort: 'high' }),
      event('model/selection', { provider: 'alpha', model: 'plain' }),
      event('model/selection', { provider: '', model: 'broken' }),
    ])
    const other = await f.add('other', 2)
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'plain' })
    expect(other.model.current).toMatchObject({ model: 'shared', reasoningEffort: 'high' })
    await f.set('shared')
    expect(root.model.current).toMatchObject({ provider: 'alpha', reasoningEffort: 'low' })
    await f.set('beta:shared')
    expect(root.model.current).toMatchObject({ provider: 'beta', model: 'shared', reasoningEffort: 'high' })
    expect(other.model.current).toMatchObject({ provider: 'alpha', reasoningEffort: 'high' })
    const copy = root.model.current as { model: string }; copy.model = 'mutated'
    expect(root.model.current?.model).toBe('shared')
    await f.models.dispose()
  })

  it('retains provider-neutral onboarding and resolves deployment/request choices without leaking old effort', async () => {
    const f = fixture()
    f.setDefault(undefined)
    const blank = await f.add()
    expect(blank.model.current).toBeUndefined()
    expect(blank.model.agentOptions).toEqual({})
    f.setDefault({ provider: 'alpha', model: 'shared', reasoningEffort: 'high' })
    const override = await f.add('other', 2, [], { provider: 'beta', model: 'shared' })
    expect(override.model.current).toEqual({ provider: 'beta', model: 'shared' })
    expect(override.model.agentOptions).toEqual({ provider: 'beta', model: 'shared' })
    const configured = fixture({ provider: 'alpha', model: 'plain' })
    const record = await configured.add()
    expect(record.model.current).toEqual({ provider: 'alpha', model: 'plain' })
    await f.models.dispose(); await configured.models.dispose()
  })

  it('installs the native assembly/request coupling and releases its listeners with the model handle', async () => {
    const f = fixture(), { record, model, ctx } = await f.add()
    model.install(ctx)
    const waterfall = ctx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>
    const assemble = () => waterfall('system-prompt/assemble', {}, {}, async () => ({ variables: {} }))
    const route = () => waterfall('agent/request', { agent: record.agent }, async () => ({ provider: 'fallback', model: 'fallback', reasoningEffort: 'low' }))
    await assemble()
    await f.set('plain')
    // A selection change cannot split an already assembled request.
    expect(await route()).toEqual({ provider: 'alpha', model: 'shared', reasoningEffort: 'high' })
    await assemble()
    expect(await route()).toEqual({ provider: 'alpha', model: 'plain' })
    await model.dispose()
    expect(await route()).toEqual({ provider: 'fallback', model: 'fallback', reasoningEffort: 'low' })
    expect(() => model.install(ctx)).toThrow('disposed')
    await f.models.dispose()
  })

  it('rejects invalid/foreign choices before writes and saves default, appends and flushes before notifying', async () => {
    const f = fixture(), { append } = await f.add()
    for (const request of [f.set('shared', 'high', 2), f.set('missing'), f.set(''), f.set('plain', 'high'), f.set('shared', 'unsupported')]) {
      await expect(request).rejects.toMatchObject({ code: -32602 })
    }
    expect(append).not.toHaveBeenCalled(); expect(f.defaults.saveSelection).not.toHaveBeenCalled()
    await f.set('beta:shared', 'low')
    expect(f.order).toEqual(['save:beta/shared', 'append:beta/shared', 'flush'])
    expect(append).toHaveBeenCalledWith('model/selection', { provider: 'beta', model: 'shared', reasoningEffort: 'low' })
    expect(f.notify).toHaveBeenLastCalledWith(1, 'x.ai/models/update', expect.objectContaining({ currentModelId: 'beta:shared', _meta: expect.objectContaining({ currentProviderId: 'beta' }) }))
    await f.models.dispose()
  })

  it('does not change runtime choice or effort memory when native append fails', async () => {
    const f = fixture(), { model, append } = await f.add()
    append.mockImplementationOnce(() => { throw new Error('append failed') })
    await expect(f.set('beta:shared', 'low')).rejects.toThrow('append failed')
    expect(model.current).toMatchObject({ provider: 'alpha', reasoningEffort: 'high' })
    expect(f.defaults.saveSelection).toHaveBeenCalledOnce(); expect(f.flush).not.toHaveBeenCalled()
    await f.set('beta:shared')
    expect(model.current).toEqual({ provider: 'beta', model: 'shared' })
    await f.models.dispose()
  })

  it('does not change the live choice when the global default write fails and allows a later request', async () => {
    const f = fixture(), { model } = await f.add()
    vi.mocked(f.defaults.saveSelection).mockRejectedValueOnce(new Error('settings failed'))
    await expect(f.set('plain')).rejects.toThrow('settings failed')
    expect(model.current).toEqual({ provider: 'alpha', model: 'shared', reasoningEffort: 'high' })
    expect(f.flush).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled()
    await f.set('shared', 'low')
    expect(model.current).toMatchObject({ model: 'shared', reasoningEffort: 'low' })
    await f.models.dispose()
  })

  it('serializes selection writes within one session without blocking another session', async () => {
    const f = fixture(), held = deferred<void>(), entered = deferred<void>()
    const root = await f.add(); await f.add('other', 2)
    vi.mocked(f.defaults.saveSelection).mockImplementationOnce(async () => { entered.resolve(); await held.promise })
    const first = f.set('beta:shared', 'low')
    await entered.promise
    const second = f.set('plain')
    await f.set('shared', 'low', 2, 'other')
    expect(root.append).not.toHaveBeenCalled()
    held.resolve(); await first; await second
    expect(root.events.map(event => (event.data as { model: string }).model)).toEqual(['shared', 'plain'])
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'plain' })
    await f.models.dispose()
  })

  it('rejects a retired owner after catalog lookup without touching native state or defaults', async () => {
    const f = fixture(), root = await f.add(), held = deferred<ModelCatalog>()
    f.catalog.current.mockImplementationOnce(() => held.promise)
    const work = f.set('plain'), rejected = expect(work).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.catalog.current).toHaveBeenCalledOnce())
    f.sessions.delete(root.record.agent.session.id)
    const closing = root.model.dispose()
    held.resolve(f.view); await rejected; await closing
    expect(root.append).not.toHaveBeenCalled(); expect(f.defaults.saveSelection).not.toHaveBeenCalled()
    await f.models.dispose()
  })

  it('drains a committed choice through final flush during retirement and suppresses late catalog/UI work', async () => {
    const f = fixture(), root = await f.add(), held = deferred<void>(), entered = deferred<void>()
    f.flush.mockImplementationOnce(async () => { entered.resolve(); await held.promise })
    const work = f.set('plain'), rejected = expect(work).rejects.toThrow('session closed')
    await entered.promise
    f.sessions.delete(root.record.agent.session.id)
    let done = false
    const closing = root.model.dispose().then(() => { done = true })
    await Promise.resolve()
    expect(done).toBe(false); expect(f.flush).toHaveBeenCalledOnce()
    expect(root.append).toHaveBeenCalledOnce()
    held.resolve(); await rejected; await closing
    expect(f.flush).toHaveBeenCalledOnce()
    expect(f.catalog.refresh).not.toHaveBeenCalled(); expect(f.notify).not.toHaveBeenCalled()
    await f.models.dispose()
  })

  it('reads late default capabilities and prevents preparation from publishing after disposal', async () => {
    const f = fixture(), held = deferred<ModelSelection | undefined>()
    f.host.defaults = () => undefined
    expect((await f.models.prepare()).current).toBeUndefined()
    f.host.defaults = () => f.defaults
    expect((await f.models.prepare()).current).toMatchObject({ provider: 'alpha' })
    f.catalog.select.mockImplementationOnce(() => held.promise)
    const preparation = f.models.prepare(), rejected = expect(preparation).rejects.toThrow('disposed')
    const disposal = f.models.dispose()
    expect(f.models.dispose()).toBe(disposal)
    held.resolve(undefined); await rejected; await disposal
    await expect(f.models.prepare()).rejects.toThrow('disposed')
    await expect(f.set('plain')).rejects.toThrow('disposed')
  })

  it('drains a default writer that synchronously reenters global disposal', async () => {
    const f = fixture(), root = await f.add(), held = deferred<void>(), entered = deferred<void>()
    let disposal!: Promise<void>, done = false
    vi.mocked(f.defaults.saveSelection).mockImplementationOnce(async () => {
      disposal = f.models.dispose()
      void disposal.then(() => { done = true })
      entered.resolve(); await held.promise
    })
    const work = f.set('plain'), rejected = expect(work).rejects.toThrow('session closed')
    await entered.promise; await Promise.resolve()
    expect(done).toBe(false)
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'shared', reasoningEffort: 'high' })
    held.resolve(); await rejected; await disposal
    expect(f.flush).not.toHaveBeenCalled(); expect(root.append).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
  })

  it('rejects failed defaults but acknowledges an applied choice with a durability warning on flush failure', async () => {
    const f = fixture(), root = await f.add()
    vi.mocked(f.defaults.saveSelection).mockRejectedValueOnce(new Error('default failed'))
    f.flush.mockRejectedValueOnce(new Error('flush failed'))
    await expect(f.set('plain')).rejects.toThrow('default failed')
    expect(f.flush).not.toHaveBeenCalled(); expect(root.append).not.toHaveBeenCalled()
    expect(f.notify).not.toHaveBeenCalled()
    await expect(f.set('plain')).resolves.toMatchObject({ _meta: { persistenceWarning: expect.stringContaining('flush failed') } })
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'plain' })
    expect(f.notify).toHaveBeenCalledOnce()
    expect(f.catalog.refresh).not.toHaveBeenCalled()
    await f.models.dispose()
  })

  it('reconciles discovered effort capabilities and publishes scoped versus onboarding snapshots without mutating the catalog', async () => {
    const f = fixture()
    f.view.availableModels[0]!._meta!.supportsReasoningEffort = false
    const root = await f.add()
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'shared' })
    await f.add('other', 2, [], { provider: 'beta', model: 'shared', reasoningEffort: 'low' })
    f.view.availableModels[0]!._meta!.supportsReasoningEffort = true
    f.models.changed(f.view, 'discovery')
    expect(root.model.current).toMatchObject({ reasoningEffort: 'high' })
    expect(f.notify.mock.calls.map(call => [call[0], (call[2] as { currentModelId: string }).currentModelId])).toEqual([[1, 'shared'], [2, 'beta:shared'], [3, 'shared']])
    expect(f.view.availableModels.every(model => model._meta?.reasoningEffort === undefined)).toBe(true)
    expect(f.models.isProviderInUse('beta')).toBe(true)
    f.view.availableModels[0]!._meta!.reasoningEfforts = ['low']
    f.models.changed(f.view, 'discovery')
    expect(root.model.current).toEqual({ provider: 'alpha', model: 'shared' })
    f.view.availableModels[0]!._meta!.reasoningEfforts = ['high', 'low']
    f.models.changed(f.view, 'discovery')
    expect(root.model.current?.reasoningEffort).toBeUndefined()
    await f.models.dispose()
    f.notify.mockClear(); f.models.changed(f.view, 'mutation')
    expect(f.notify).not.toHaveBeenCalled()
  })
})
