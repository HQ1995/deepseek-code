import { describe, expect, it, vi } from 'vitest'
import { createModelCatalog, type ModelCatalogDependencies } from '../src/model-catalog.ts'
import type { LlmLike, SettingsLike } from '../src/native-seams.ts'
import { modelEffortKey } from '../src/wire-catalog.ts'

const deferred = <T>() => {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed })
  return { promise, resolve, reject }
}
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function fixture() {
  const routes: Record<string, Record<string, unknown>> = {}
  const stored = new Map<string, string>()
  let liveProvider: string | undefined
  let defaultSelection = { provider: 'alpha', model: 'shared', reasoningEffort: 'high' }
  const settings: SettingsLike = {
    describe: () => [{ ns: 'llm-pi-ai', user: { providers: routes } }],
    mutate: vi.fn(async (_ns, input) => {
      for (const op of input as Array<{ op: string; path: string[]; value?: Record<string, unknown> }>) {
        expect(op.path[0]).toBe('providers')
        const id = op.path[1]!
        if (op.op === 'unset') delete routes[id]
        else routes[id] = op.value!
      }
    }),
  }
  const llm: LlmLike = {
    listProviders: () => [...new Set(['alpha', 'beta', ...Object.keys(routes)])].map(id => ({ id })),
    listModels: vi.fn(async () => [{ id: 'shared', name: 'Shared model' }]),
    resolveModelInfo: async (provider, id) => ({ provider, id,
      reasoning: { defaultEffort: 'high', efforts: [{ id: 'high' }, { id: 'low' }] }, inputModalities: ['text', 'image'] }),
  }
  const changed = vi.fn()
  const deps: ModelCatalogDependencies = {
    config: {}, llm: () => llm, settings: () => settings,
    getDefaultModel: () => ({ currentSelection: () => defaultSelection, saveSelection: vi.fn() }),
    getCredentials: () => ({
      set: vi.fn(async (ref, value) => { stored.set(ref, value) }),
      resolve: async ref => stored.has(ref) ? { value: stored.get(ref)! } : undefined,
      describe: async ref => ({ configured: stored.has(ref), source: 'file', writable: true }),
      unset: async ref => { stored.delete(ref) },
    }),
    isProviderInUse: provider => liveProvider === provider,
    onChanged: changed, logger: { warn: vi.fn() }, environment: {},
    fetch: vi.fn(async () => new Response(JSON.stringify({ data: [] }))),
  }
  const catalog = createModelCatalog(deps)
  return { catalog, deps, routes, stored, settings, llm, changed,
    useProvider: (id: string) => { liveProvider = id },
    selectDefault: (id: string) => { defaultSelection = { ...defaultSelection, provider: id } },
  }
}

describe('model catalog module', () => {
  it('names a bare model id the way the picker does, unless providers disagree', async () => {
    const f = fixture()
    expect(f.catalog.modelName('shared')).toBeUndefined()
    await f.catalog.current()
    expect(f.catalog.modelName('shared')).toBe('Shared model')
    expect(f.catalog.modelName('missing')).toBeUndefined()
    vi.mocked(f.llm.listModels).mockImplementation(async (provider: string) => [{ id: 'shared', name: provider + ' shared' }])
    await f.catalog.refresh()
    expect(f.catalog.modelName('shared')).toBeUndefined()
    expect(f.catalog.modelName('shared', 'beta')).toBe('beta shared')
    await f.catalog.dispose()
  })

  it('publishes acknowledged choices through the latest wire mapping without rediscovery', async () => {
    const f = fixture(), current = await f.catalog.current()
    const calls = vi.mocked(f.llm.listModels).mock.calls.length
    // Use the catalog key format; consumers carry native identity, not wire IDs.
    current.providerModelToWireId.set(modelEffortKey('beta', 'shared'), 'remapped')
    f.catalog.selected({ provider: 'beta', model: 'shared' })
    expect(current.currentModelId).toBe('remapped')
    expect(current.currentProviderId).toBe('beta')
    expect(f.llm.listModels).toHaveBeenCalledTimes(calls)
    f.catalog.selected({ provider: 'removed', model: 'missing' })
    expect(current.currentModelId).toBe('remapped')
    await f.catalog.dispose()
    expect(() => f.catalog.selected({ provider: 'alpha', model: 'shared' })).toThrow('disposed')
  })

  it('rejects every new public operation after closing without touching native capabilities', async () => {
    const f = fixture(); const closing = f.catalog.dispose()
    const calls = [() => f.catalog.current(), () => f.catalog.refresh(), () => f.catalog.list(),
      () => f.catalog.select(undefined, {}), () => f.catalog.initialize(),
      () => f.catalog.add({ id: 'late' }), () => f.catalog.update({ providerId: 'alpha' }), () => f.catalog.remove({ id: 'beta' })]
    for (const call of calls) await expect(call()).rejects.toThrow('disposed')
    await closing; expect(f.catalog.dispose()).toBe(closing)
    expect(f.llm.listModels).not.toHaveBeenCalled(); expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('owns background discovery before its native callback can reenter shutdown', async () => {
    const f = fixture(), discovery = deferred<Array<{ id: string }>>()
    f.routes.beta = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'shared' }] }
    let closing!: Promise<void>, finished = false
    f.llm.discoverModels = vi.fn(() => {
      closing = f.catalog.dispose(); void closing.then(() => { finished = true }); return discovery.promise
    })
    await expect(f.catalog.initialize()).rejects.toThrow('disposed')
    expect(finished).toBe(false); expect(f.catalog.dispose()).toBe(closing)
    discovery.resolve([{ id: 'late' }]); await closing
    expect(f.settings.mutate).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled()
  })

  it.each(['add', 'update'] as const)('does not begin %s writes after a native validation getter reenters shutdown', async method => {
    const f = fixture(), credentials = f.deps.getCredentials()!
    f.routes.custom = {}
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => credentials })
    const describe = f.settings.describe!
    f.settings.describe = vi.fn(() => { void catalog.dispose(); return describe() })
    const params = method === 'add' ? { id: 'new-custom', apiKey: 'fixture-only' } : { providerId: 'custom', apiKey: 'fixture-only' }
    await expect(catalog[method](params)).rejects.toThrow('disposed')
    await catalog.dispose()
    expect(credentials.set).not.toHaveBeenCalled(); expect(f.settings.mutate).not.toHaveBeenCalled()
    await f.catalog.dispose()
  })

  it.each(['add', 'update'] as const)('does not begin a keyless %s write after validation reenters shutdown', async method => {
    const f = fixture(); f.routes.custom = {}
    const describe = f.settings.describe!
    f.settings.describe = vi.fn(() => { void f.catalog.dispose(); return describe() })
    const params = method === 'add' ? { id: 'new-custom' } : { providerId: 'custom' }
    await expect(f.catalog[method](params)).rejects.toThrow('disposed')
    await f.catalog.dispose(); expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('drains the complete accepted credential, fallback route write and cleanup sequence during shutdown', async () => {
    const f = fixture(), credentials = f.deps.getCredentials()!, discovery = deferred<Array<{ id: string }>>()
    const persist = deferred<void>(), cleanup = deferred<void>(), mutate = f.settings.mutate
    f.routes.custom = { apiKeyEnv: 'OLD_KEY' }; f.stored.set('OLD_KEY', 'old-fixture')
    const unset = vi.fn(async (ref: string) => { await cleanup.promise; await credentials.unset!(ref) })
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => ({ ...credentials, unset }) })
    f.settings.mutate = vi.fn(async (ns, ops, revision) => {
      if (!(ops as Array<{ value: { models?: unknown } }>)[0]?.value.models) throw new Error('resolves no models')
      await persist.promise; await mutate(ns, ops, revision)
    })
    f.llm.discoverModels = vi.fn(() => discovery.promise)
    const request = catalog.update({ providerId: 'custom', apiKeyEnv: 'NEW_KEY', apiKey: 'new-fixture' })
    const rejected = expect(request).rejects.toThrow('disposed')
    await tick(); expect(f.llm.discoverModels).toHaveBeenCalledOnce()
    const closing = catalog.dispose(); let finished = false
    void closing.then(() => { finished = true })
    discovery.resolve([{ id: 'new-model' }]); await tick()
    expect(finished).toBe(false); expect(f.settings.mutate).toHaveBeenCalledTimes(2)
    persist.resolve(); await tick(); expect(unset).toHaveBeenCalledWith('OLD_KEY'); expect(finished).toBe(false)
    cleanup.resolve(); await rejected; await closing
    expect(f.routes.custom).toEqual({ apiKeyEnv: 'NEW_KEY', models: [{ id: 'new-model' }] })
    expect(f.stored.has('OLD_KEY')).toBe(false); expect(f.stored.get('NEW_KEY')).toBe('new-fixture')
    expect(catalog.peek()).toBeUndefined(); expect(f.changed).not.toHaveBeenCalled()
    expect(catalog.dispose()).toBe(closing); await f.catalog.dispose()
  })

  it('shares one drain when the first credential write synchronously reenters disposal', async () => {
    const f = fixture(), gate = deferred<void>(), credentials = f.deps.getCredentials()!
    let closing!: Promise<void>, finished = false
    const set = vi.fn(async (ref: string, value: string) => {
      closing = catalog.dispose(); void closing.then(() => { finished = true })
      await gate.promise; await credentials.set(ref, value)
    })
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => ({ ...credentials, set }) })
    const request = catalog.add({ id: 'held', apiKey: 'fixture-only' }), rejected = expect(request).rejects.toThrow('disposed')
    await tick(); expect(finished).toBe(false); expect(catalog.dispose()).toBe(closing)
    await expect(catalog.add({ id: 'denied' })).rejects.toThrow('disposed')
    gate.resolve(); await rejected; await closing
    expect(f.routes.held).toEqual({ apiKeyEnv: 'HELD_API_KEY' }); expect(set).toHaveBeenCalledOnce()
    await f.catalog.dispose()
  })

  it('preserves a native write failure during shutdown without issuing the route write', async () => {
    const f = fixture(), gate = deferred<void>(), credentials = f.deps.getCredentials()!, primary = new Error('credential storage failure')
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => ({ ...credentials, set: () => gate.promise }) })
    const request = catalog.add({ id: 'held', apiKey: 'fixture-only' }), rejected = expect(request).rejects.toBe(primary)
    const closing = catalog.dispose(); gate.reject(primary)
    await rejected; await closing
    expect(f.settings.mutate).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled()
    await f.catalog.dispose()
  })

  it('keeps parallel native reads owned after a sibling causes a fail-fast refresh rejection', async () => {
    const f = fixture(), held = deferred<Array<{ id: string; name: string }>>(), primary = new Error('first provider failed')
    f.llm.listModels = vi.fn(async provider => { if (provider === 'alpha') throw primary; return held.promise })
    await expect(f.catalog.refresh()).rejects.toBe(primary)
    const closing = f.catalog.dispose(); let finished = false
    void closing.then(() => { finished = true }); await tick(); expect(finished).toBe(false)
    held.resolve([{ id: 'late', name: 'Late' }]); await closing
    expect(f.catalog.peek()).toBeUndefined(); expect(f.changed).not.toHaveBeenCalled()
  })

  it('drains removal through unshared credential cleanup and does not publish after close', async () => {
    const f = fixture(), gate = deferred<void>(), credentials = f.deps.getCredentials()!
    f.routes.custom = { apiKeyEnv: 'CUSTOM_KEY' }; f.stored.set('CUSTOM_KEY', 'fixture-only')
    const unset = vi.fn(async (ref: string) => { await gate.promise; await credentials.unset!(ref) })
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => ({ ...credentials, unset }) })
    const request = catalog.remove({ id: 'custom' }), rejected = expect(request).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(unset).toHaveBeenCalledOnce())
    const closing = catalog.dispose(); let finished = false
    void closing.then(() => { finished = true }); await tick(); expect(finished).toBe(false)
    gate.resolve(); await rejected; await closing
    expect(f.routes.custom).toBeUndefined(); expect(f.stored.has('CUSTOM_KEY')).toBe(false)
    expect(f.changed).not.toHaveBeenCalled(); await f.catalog.dispose()
  })

  it('disposal waits for an already-accepted foreground credential write', async () => {
    const f = fixture(), gate = deferred<void>(), credentials = f.deps.getCredentials()!
    const set = vi.fn(async (ref: string, value: string) => { await gate.promise; await credentials.set(ref, value) })
    const catalog = createModelCatalog({ ...f.deps, getCredentials: () => ({ ...credentials, set }) })
    const request = catalog.add({ id: 'held', apiKey: 'fixture-only' }).catch(error => error)
    expect(set).toHaveBeenCalledOnce()
    let closed = false
    const closing = Promise.resolve(catalog.dispose()).then(() => { closed = true })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const closedBeforeWrite = closed
    gate.resolve(); await request; await closing; f.catalog.dispose()
    expect(closedBeforeWrite).toBe(false)
  })

  it('disposal waits for an already-accepted background catalog persistence write', async () => {
    const f = fixture(), gate = deferred<void>(), mutate = f.settings.mutate
    f.routes.beta = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'shared' }] }
    f.llm.discoverModels = vi.fn(async () => [{ id: 'discovered' }])
    f.settings.mutate = vi.fn(async (...args) => { await gate.promise; await mutate(...args) })
    await f.catalog.initialize()
    await vi.waitFor(() => expect(f.settings.mutate).toHaveBeenCalledOnce())
    let closed = false
    const closing = Promise.resolve(f.catalog.dispose()).then(() => { closed = true })
    for (let i = 0; i < 20; i++) await Promise.resolve()
    const closedBeforeWrite = closed
    gate.resolve(); await closing
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(f.changed).not.toHaveBeenCalled()
    expect(closedBeforeWrite).toBe(false)
  })

  it('owns its cache and qualified model selection without mounting a bridge or socket', async () => {
    const f = fixture()
    expect(f.catalog.peek()).toBeUndefined()
    const first = await f.catalog.current()
    expect(first.currentProviderId).toBe('alpha')
    expect(first.availableModels.map(model => model.modelId)).toEqual(['shared', 'beta:shared'])
    expect(first.availableModels[0]?._meta).toMatchObject({ acceptsImages: true, reasoningEfforts: ['high', 'low'], reasoningEffort: 'high' })
    await f.catalog.current()
    expect(f.llm.listModels).toHaveBeenCalledTimes(2)
    expect(await f.catalog.select(undefined, { model: 'beta:shared', reasoningEffort: 'low' }))
      .toMatchObject({ provider: 'beta', model: 'shared', reasoningEffort: 'low' })
    await expect(f.catalog.select(undefined, { model: 'unknown' })).rejects.toMatchObject({ code: -32602 })
    f.selectDefault('beta')
    expect((await f.catalog.refresh()).currentModelId).toBe('beta:shared')
    f.catalog.dispose()
  })

  it('reads optional capabilities lazily and waits for asynchronously mounted settings', async () => {
    const f = fixture(), ready = f.deps.settings
    f.deps.settings = () => undefined
    // The factory captures capability functions, never their service result.
    let available = false
    f.deps.settings = () => available ? ready() : undefined
    const catalog = createModelCatalog(f.deps)
    const initial = catalog.initialize()
    available = true
    expect((await initial).providers).toHaveLength(2)
    catalog.dispose(); f.catalog.dispose()
  })

  it('waits for the native legacy settings import before reading routes', async () => {
    const f = fixture()
    let finish!: () => void
    const ready = new Promise<void>(resolve => { finish = resolve })
    const settings = f.deps.settings()!
    f.deps.settings = () => ({ ...settings, ready })
    const catalog = createModelCatalog(f.deps)
    const initial = catalog.initialize()
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(f.llm.listModels).not.toHaveBeenCalled()
    finish()
    expect((await initial).providers).toHaveLength(2)
    await catalog.dispose(); await f.catalog.dispose()
  })

  it.each([undefined, null, 'invalid', {}, { providers: null }, { providers: { alpha: 'invalid', beta: { baseURL: 42 } } }])(
    'does not invent editable provider fields from malformed or absent settings: %j', async user => {
      const f = fixture()
      f.settings.describe = () => [{ ns: 'agent-preset-registry', user: { providers: { alpha: { baseURL: 'ignored' } } } }, { ns: 'llm-pi-ai', user }]
      expect((await f.catalog.current()).providers).toEqual([{ id: 'alpha' }, { id: 'beta' }])
      f.catalog.dispose()
    },
  )

  it('keeps pasted credentials out of settings and catalog, preserves unedited fields and cleans only unshared refs', async () => {
    const f = fixture()
    await f.catalog.add({ id: 'custom', apiKey: 'fixture-secret', displayName: 'Custom' })
    expect(f.stored.get('CUSTOM_API_KEY')).toBe('fixture-secret')
    expect(f.routes.custom).toEqual({ displayName: 'Custom', apiKeyEnv: 'CUSTOM_API_KEY' })
    expect(JSON.stringify(f.catalog.peek())).not.toContain('fixture-secret')
    f.routes.custom!.models = [{ id: 'kept' }]
    f.routes.other = { apiKeyEnv: 'CUSTOM_API_KEY' }
    await f.catalog.update({ providerId: 'custom', displayName: '', apiKeyEnv: 'NEW_REF', apiKey: 'replacement' })
    expect(f.routes.custom).toEqual({ apiKeyEnv: 'NEW_REF', models: [{ id: 'kept' }] })
    expect(f.stored.has('CUSTOM_API_KEY')).toBe(true)
    await f.catalog.remove({ id: 'custom' })
    expect(f.routes.custom).toBeUndefined()
    expect(f.stored.has('NEW_REF')).toBe(false)
    expect(f.changed).toHaveBeenCalledTimes(3)
    f.catalog.dispose()
  })

  it('refuses malformed writes, missing user routes and providers used by a live session', async () => {
    const f = fixture()
    await expect(f.catalog.add({ id: 'Bad ID' })).rejects.toMatchObject({ code: -32602 })
    await expect(f.catalog.add({ id: 'custom', baseURL: 'not a url' })).rejects.toMatchObject({ code: -32602 })
    await expect(f.catalog.add({ id: 'custom', credentialSource: 'environment', apiKey: 'not-allowed' })).rejects.toMatchObject({ code: -32602 })
    await expect(f.catalog.remove({ id: 'beta' })).rejects.toThrow('no removable user route')
    f.routes.beta = {}
    f.useProvider('beta')
    await expect(f.catalog.remove({ id: 'beta' })).rejects.toThrow('is in use')
    expect(f.settings.mutate).not.toHaveBeenCalled()
    f.catalog.dispose()
  })

  it('resolves secrets only for persisted endpoints and deduplicates background discovery', async () => {
    const f = fixture(), discovery = deferred<Array<{ id: string }>>()
    f.routes.beta = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', apiKeyEnv: 'FIXTURE_KEY', models: [{ id: 'shared' }] }
    f.stored.set('FIXTURE_KEY', 'fixture-secret')
    f.llm.discoverModels = vi.fn(() => discovery.promise)
    await f.catalog.initialize()
    await f.catalog.list()
    await vi.waitFor(() => expect(f.llm.discoverModels).toHaveBeenCalledTimes(1))
    expect(f.llm.discoverModels).toHaveBeenCalledWith('llm-pi-ai', expect.objectContaining({ provider: 'beta', apiKey: 'fixture-secret' }))
    discovery.resolve([{ id: 'discovered' }])
    await vi.waitFor(() => expect(f.changed).toHaveBeenCalledWith(expect.anything(), 'discovery'))
    expect(f.catalog.peek()?.availableModels.some(model => model.modelId === 'discovered')).toBe(true)
    expect(f.routes.beta!.models).toEqual([{ id: 'discovered' }])
    f.catalog.dispose()
  })

  it('does not send a resolved secret to a new draft endpoint during fallback discovery', async () => {
    const f = fixture()
    f.stored.set('FIXTURE_KEY', 'fixture-secret')
    const mutate = f.settings.mutate
    f.settings.mutate = vi.fn(async (ns, ops, revision) => {
      if (!(ops as Array<{ value: { models?: unknown } }>)[0]?.value.models) throw new Error('resolves no models')
      return mutate(ns, ops, revision)
    })
    f.llm.discoverModels = vi.fn(async () => [{ id: 'discovered' }])
    await f.catalog.add({ id: 'custom', api: 'openai-completions', baseURL: 'https://new-fixture.invalid/v1', apiKeyEnv: 'FIXTURE_KEY' })
    expect(f.llm.discoverModels).toHaveBeenCalledWith('llm-pi-ai', expect.objectContaining({ apiKey: 'FIXTURE_KEY' }))
    expect(f.deps.fetch).not.toHaveBeenCalled()
    f.catalog.dispose()
  })

  it('fences a discovery completing after disposal, without republishing or writing settings', async () => {
    const f = fixture(), discovery = deferred<Array<{ id: string }>>()
    f.routes.beta = { api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'shared' }] }
    f.llm.discoverModels = vi.fn(() => discovery.promise)
    await f.catalog.initialize()
    f.catalog.dispose(); f.catalog.dispose()
    discovery.resolve([{ id: 'late' }])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(f.catalog.peek()).toBeUndefined()
    expect(f.changed).not.toHaveBeenCalled()
    expect(f.settings.mutate).not.toHaveBeenCalled()
    await expect(f.catalog.add({ id: 'closed' })).rejects.toThrow('disposed')
    await expect(f.catalog.current()).rejects.toThrow('disposed')
  })

  it('does not resurrect the cached catalog when a foreground refresh completes after disposal', async () => {
    const f = fixture(), models = deferred<Array<{ id: string; name: string }>>()
    f.llm.listModels = () => models.promise
    const pending = f.catalog.refresh()
    f.catalog.dispose()
    models.resolve([{ id: 'late', name: 'Late' }])
    await expect(pending).rejects.toThrow('disposed')
    expect(f.catalog.peek()).toBeUndefined()
  })

  it('shares one settings composition across display reads until the provider section may have changed', async () => {
    const f = fixture()
    const describe = vi.spyOn(f.settings, 'describe')
    await f.catalog.refresh(); await f.catalog.list(); await f.catalog.refresh()
    expect(describe).toHaveBeenCalledTimes(1)
    f.catalog.settingsChanged('agent-preset-registry')
    await f.catalog.refresh()
    expect(describe).toHaveBeenCalledTimes(1)
    f.catalog.settingsChanged('llm-pi-ai')
    await f.catalog.refresh()
    expect(describe).toHaveBeenCalledTimes(2)
    f.catalog.settingsChanged()
    await f.catalog.refresh()
    expect(describe).toHaveBeenCalledTimes(3)
  })

  it('keys the shared composition on the settings instance behind cordis lookup wrappers', async () => {
    const f = fixture()
    const original = Symbol.for('cordis.original')
    const wrap = (service: SettingsLike): SettingsLike => new Proxy(service, {
      get: (target, key) => key === original ? target : Reflect.get(target, key),
    })
    let service: SettingsLike = f.settings
    const catalog = createModelCatalog({ ...f.deps, settings: () => wrap(wrap(service)) })
    const describe = vi.spyOn(f.settings, 'describe')
    await catalog.refresh(); await catalog.refresh()
    expect(describe).toHaveBeenCalledTimes(1)
    const replacement: SettingsLike = { mutate: f.settings.mutate, describe: vi.fn(() => [{ ns: 'llm-pi-ai', user: { providers: { alpha: { displayName: 'Remounted' } } } }]) }
    service = replacement
    const current = await catalog.refresh()
    expect(replacement.describe).toHaveBeenCalledTimes(1)
    expect(current.providers.find(provider => provider.id === 'alpha')?.displayName).toBe('Remounted')
  })

  it('reads fresh for writes and publishes the route it just wrote', async () => {
    const f = fixture()
    await f.catalog.refresh()
    const describe = vi.spyOn(f.settings, 'describe')
    const added = await f.catalog.add({ id: 'gw', displayName: 'Gateway', api: 'anthropic-messages' }) as { providers: Array<{ id: string; displayName?: string }> }
    expect(describe).toHaveBeenCalled()
    expect(added.providers.find(provider => provider.id === 'gw')?.displayName).toBe('Gateway')
    expect((await f.catalog.current()).providers.find(provider => provider.id === 'gw')?.displayName).toBe('Gateway')
  })

  it('never caches an absent provider section, so a late provider plugin is still read', async () => {
    const f = fixture()
    let active = false
    const service: SettingsLike = {
      mutate: f.settings.mutate,
      describe: vi.fn(() => active ? [{ ns: 'llm-pi-ai', user: { providers: { alpha: { displayName: 'Alpha gateway' } } } }] : []),
    }
    const catalog = createModelCatalog({ ...f.deps, settings: () => service })
    expect((await catalog.refresh()).providers.find(provider => provider.id === 'alpha')?.displayName).toBeUndefined()
    active = true
    expect((await catalog.refresh()).providers.find(provider => provider.id === 'alpha')?.displayName).toBe('Alpha gateway')
    await catalog.refresh()
    expect(service.describe).toHaveBeenCalledTimes(2)
  })
})
