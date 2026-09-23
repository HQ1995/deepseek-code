import { describe, expect, it, vi } from 'vitest'
import { createModelCatalog } from '../src/model-catalog.ts'
import { createNativeProviders, nativeProviderForm, NATIVE_DEEPSEEK_API, NATIVE_DEEPSEEK_PROVIDER } from '../src/native-provider.ts'
import { createPluginRows, type PluginManagerLike } from '../src/plugin-rows.ts'
import type { LlmLike, SettingsLike } from '../src/native-seams.ts'

function fixture(options: { enabled?: boolean; application?: string; errorCode?: string; noManager?: boolean; noCredentials?: boolean; hmr?: boolean } = {}) {
  let enabled = options.enabled ?? false
  let saved = enabled
  const reload = vi.fn(async (required: readonly string[]) => {
    enabled = saved
    if (required.length > 0 && !enabled) throw new Error('required row did not activate')
  })
  const section: Record<string, unknown> = {}
  const stored = new Map<string, string>()
  const manager: PluginManagerLike = {
    listPlugins: vi.fn(async () => [
      { entryId: 'e-other', moduleName: '@deepseek-ai/dsh-llm-pi-ai', enabled: true, patchId: 'llm-pi-ai' },
      { entryId: 'e-deepseek', moduleName: '@deepseek-ai/dsh-llm-deepseek', enabled, patchId: 'llm-deepseek' },
    ]),
    // dscode runs without hmr: the manager saves the row and asks for a restart.
    setPluginEnabled: vi.fn(async (_id: string, next: boolean) => {
      if (options.application === undefined && options.errorCode === undefined) saved = next
      if (options.hmr === true && options.application === undefined) enabled = next
      return { application: options.application ?? (options.hmr === true ? 'applied' : 'restart-required'),
        ...options.errorCode === undefined ? {} : { error: { code: options.errorCode } } }
    }),
  }
  const settings: SettingsLike = {
    describe: () => [{ ns: 'llm-deepseek', user: { ...section } }],
    mutate: vi.fn(async (ns: string, ops: unknown) => {
      expect(ns).toBe('llm-deepseek')
      for (const op of ops as Array<{ op: string; path: string[]; value?: unknown }>) {
        if (op.op === 'unset') delete section[op.path[0]!]
        else section[op.path[0]!] = op.value
      }
    }),
  }
  const credentials = { set: vi.fn(async (ref: string, value: string) => { stored.set(ref, value) }),
    describe: async (ref: string) => ({ configured: stored.has(ref), source: 'file', writable: true }) }
  const native = createNativeProviders({
    rows: createPluginRows({ pluginManager: () => options.noManager === true ? undefined : manager, reload }),
    credentials: () => options.noCredentials === true ? undefined : credentials,
    settings: () => settings,
  })
  return { native, manager, settings, credentials, stored, section, reload, isEnabled: () => enabled }
}

describe('native DeepSeek provider', () => {
  it('validates the form before any write', () => {
    expect(nativeProviderForm({ apiKeyEnv: ' MY_KEY ', apiKey: ' sk ', baseURL: 'https://gateway.example/anthropic' }))
      .toEqual({ apiKeyEnv: 'MY_KEY', apiKey: 'sk', baseURL: 'https://gateway.example/anthropic' })
    expect(nativeProviderForm({ apiKeyEnv: '', baseURL: '' })).toEqual({})
    expect(() => nativeProviderForm({ apiKeyEnv: 'not a name' })).toThrow('environment variable name')
    expect(() => nativeProviderForm({ baseURL: 'https://api.example/?q=1' })).toThrow('without credentials, query or fragment')
    expect(() => nativeProviderForm({ baseURL: 'file:///etc' })).toThrow('without credentials')
    expect(() => nativeProviderForm({ baseURL: 42 })).toThrow('must be a string')
  })

  it('stores a pasted key, enables the disabled row once and applies its settings', async () => {
    const f = fixture()
    await f.native.enable({ apiKeyEnv: 'MY_DEEPSEEK_KEY', apiKey: 'sk-fixture', baseURL: 'https://gateway.example/anthropic' })
    expect(f.stored.get('MY_DEEPSEEK_KEY')).toBe('sk-fixture')
    expect(f.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith('e-deepseek', true)
    expect(f.reload).toHaveBeenCalledExactlyOnceWith(['llm-deepseek'])
    expect(f.section).toEqual({ apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: 'https://gateway.example/anthropic' })
    expect(f.native.describe()).toEqual({ api: NATIVE_DEEPSEEK_API, apiKeyEnv: 'MY_DEEPSEEK_KEY', baseURL: 'https://gateway.example/anthropic' })
    // An update with empty optional fields returns to the adapter defaults without re-enabling.
    await f.native.enable({})
    expect(f.manager.setPluginEnabled).toHaveBeenCalledTimes(1)
    expect(f.section).toEqual({})
    expect(f.native.describe()).toEqual({ api: NATIVE_DEEPSEEK_API, apiKeyEnv: 'DEEPSEEK_API_KEY' })
    await f.native.disable()
    expect(f.manager.setPluginEnabled).toHaveBeenLastCalledWith('e-deepseek', false)
    expect(f.reload).toHaveBeenLastCalledWith([])
    expect(f.isEnabled()).toBe(false)
  })

  it('does not reconcile again when the manager already applied the change', async () => {
    const f = fixture({ hmr: true })
    await f.native.enable({})
    expect(f.isEnabled()).toBe(true)
    expect(f.reload).not.toHaveBeenCalled()
  })

  it.each([
    [{ application: 'failed', errorCode: 'activation-failed' }, 'could not enable the DeepSeek adapter: activation-failed'],
    [{ application: 'overridden' }, 'overridden by a home patch'],
    [{ noManager: true }, 'plugin manager is unavailable'],
  ])('reports a row that cannot be enabled: %o', async (options, text) => {
    const f = fixture(options)
    await expect(f.native.enable({})).rejects.toThrow(text)
    expect(f.settings.mutate).not.toHaveBeenCalled()
  })

  it('refuses a pasted key it cannot store before touching the profile', async () => {
    const f = fixture({ noCredentials: true })
    await expect(f.native.enable({ apiKey: 'sk-fixture' })).rejects.toThrow('credentials service is unavailable')
    expect(f.manager.setPluginEnabled).not.toHaveBeenCalled()
  })

  it('routes add, describe, update and remove through the catalog', async () => {
    const f = fixture()
    let liveProvider: string | undefined
    const llm: LlmLike = {
      listProviders: () => [{ id: 'alpha' }, ...f.isEnabled() ? [{ id: NATIVE_DEEPSEEK_PROVIDER, name: 'DeepSeek' }] : []],
      listModels: async provider => provider === NATIVE_DEEPSEEK_PROVIDER ? [{ id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' }] : [{ id: 'shared', name: 'Shared' }],
    }
    const piAi: SettingsLike = { describe: () => [{ ns: 'llm-pi-ai', user: { providers: {} } }, ...f.settings.describe!()], mutate: f.settings.mutate }
    const catalog = createModelCatalog({
      config: {}, llm: () => llm, settings: () => piAi,
      getCredentials: () => f.credentials,
      getDefaultModel: () => ({ currentSelection: () => ({ provider: 'alpha', model: 'shared' }), saveSelection: vi.fn() }),
      isProviderInUse: id => liveProvider === id,
      onChanged: vi.fn(), logger: { warn: vi.fn() }, environment: {},
      native: f.native,
    })
    const added = await catalog.add({ id: 'ignored', api: NATIVE_DEEPSEEK_API, apiKey: 'sk-fixture' })
    expect(f.stored.get('DEEPSEEK_API_KEY')).toBe('sk-fixture')
    expect(JSON.stringify(added)).toContain(NATIVE_DEEPSEEK_PROVIDER)
    const roster = (await catalog.current()).providers.find(provider => provider.id === NATIVE_DEEPSEEK_PROVIDER)
    expect(roster).toMatchObject({ api: NATIVE_DEEPSEEK_API, apiKeyEnv: 'DEEPSEEK_API_KEY', credential: { configured: true } })
    await expect(catalog.add({ id: NATIVE_DEEPSEEK_PROVIDER })).rejects.toThrow('already enabled')
    await catalog.update({ providerId: NATIVE_DEEPSEEK_PROVIDER, baseURL: 'https://gateway.example/anthropic' })
    expect(f.section).toEqual({ baseURL: 'https://gateway.example/anthropic' })
    liveProvider = NATIVE_DEEPSEEK_PROVIDER
    await expect(catalog.remove({ id: NATIVE_DEEPSEEK_PROVIDER })).rejects.toThrow('is in use')
    liveProvider = undefined
    await catalog.remove({ id: NATIVE_DEEPSEEK_PROVIDER })
    expect(f.isEnabled()).toBe(false)
    expect((await catalog.current()).providers.map(provider => provider.id)).toEqual(['alpha'])
    await catalog.dispose()
  })
})
