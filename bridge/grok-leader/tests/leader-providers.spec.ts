/** Leader provider management over the socket: adding routes. */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { makeClient, makeHarness, mockDefaultModel, register, waitFor, type ClientHandle, type LeaderHarness } from './support/leader-harness.ts'

describe('x.ai/providers/add', () => {
  interface SettingsMock {
    calls: Array<{ ns: string; ops: Array<{ op: string; path: string[]; value: unknown }> }>
    providers: Record<string, unknown>
    firstWriteError?: string
    mutate(ns: string, ops: Array<{ op: string; path: string[]; value: unknown }>): Promise<void>
    describe?(): Array<{ ns: string; user?: unknown }>
  }

  const makeSettings = (describeUser = false): SettingsMock => {
    const mock: SettingsMock = {
      calls: [],
      providers: {},
      async mutate(ns, ops) {
        mock.calls.push({ ns, ops })
        if (mock.firstWriteError !== undefined) {
          const error = mock.firstWriteError
          mock.firstWriteError = undefined
          throw new Error(error)
        }
        for (const op of ops) {
          if (op.path.length !== 2) throw new Error('unexpected op')
          if (op.op === 'set') mock.providers[op.path[1]] = op.value
          else if (op.op === 'unset') delete mock.providers[op.path[1]]
          else throw new Error('unexpected op')
        }
      },
    }
    if (describeUser) {
      mock.describe = () => [{ ns: 'llm-pi-ai', user: { providers: mock.providers } }]
    }
    return mock
  }

  /** llm mock whose roster grows as the settings mock records writes. */
  const makeLlm = (settings: SettingsMock) => {
    const providerRows = [{ id: 'deepseek', name: 'DeepSeek' }]
    const discoveries: Array<{ provider?: string; baseURL?: string; api?: string; apiKey?: string }> = []
    return {
      discoveries,
      listProviders: () => {
        const rows = [...providerRows]
        for (const id of Object.keys(settings.providers)) rows.push({ id, name: (settings.providers[id] as { displayName?: string }).displayName ?? id })
        return rows
      },
      listModels: async (provider: string) => provider === 'deepseek'
        ? [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        : [{ provider, id: provider + '-model', name: provider + ' Model' }],
      discoverModels: async (_ns: string, request: { provider?: string; baseURL?: string; api?: string; apiKey?: string }) => {
        discoveries.push(request)
        if (request.baseURL?.startsWith('https://')) return [{ id: 'gw-model', name: 'GW Model', contextWindow: 8192 }]
        return []
      },
    }
  }

  let harness: LeaderHarness | undefined
  let client: ClientHandle | undefined

  afterEach(async () => {
    client?.socket.destroy()
    await harness?.ctx.fiber.dispose()
    harness = undefined
    client = undefined
  })

  const startWithSettings = async (settings: SettingsMock, credentials?: unknown) => {
    const llm = makeLlm(settings)
    const made = await makeHarness({ llm, settings, credentials })
    harness = made
    client = await makeClient(made.socketPath)
    register(client)
    await client.next() // registered
    return { client, settings, llm }
  }

  it('writes through ctx.settings.mutate and returns the refreshed roster', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'acme-gateway',
      displayName: 'Acme Gateway',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: '  https://acme.test/v1  ',
    })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      providers: [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'acme-gateway', name: 'Acme Gateway' },
      ],
      currentProviderId: 'deepseek',
    })
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ns).toBe('llm-pi-ai')
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        displayName: 'Acme Gateway',
        apiKeyEnv: 'ACME_KEY',
        api: 'openai-completions',
        baseURL: 'https://acme.test/v1',
      },
    }])
  })

  it('treats empty optional preset fields as unset', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'openai',
      displayName: 'OpenAI',
      apiKeyEnv: 'OPENAI_API_KEY',
      api: '',
      baseURL: '',
      apiKey: '',
    })
    expect(res.error).toBeUndefined()
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'openai'],
      value: {
        displayName: 'OpenAI',
        apiKeyEnv: 'OPENAI_API_KEY',
      },
    }])
  })

  it.each([false, true])('broadcasts the refreshed model catalog after adding a provider (session exists: %s)', async (hasSession) => {
    mockDefaultModel.current = undefined
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    if (hasSession) await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const res = await client.request(2, 'x.ai/providers/add', {
      id: 'acme-gateway',
      displayName: 'Acme Gateway',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
    })
    expect(res.error).toBeUndefined()
    await waitFor(() => client.all.some(message => message.method === 'x.ai/models/update'))
    const update = client.all.find(message => message.method === 'x.ai/models/update')
    expect(update?.params).toMatchObject({
      currentModelId: 'deepseek-chat',
      availableModels: [
        { modelId: 'deepseek-chat', _meta: { provider: 'deepseek' } },
        { modelId: 'acme-gateway-model', _meta: { provider: 'acme-gateway' } },
      ],
      _meta: {
        currentProviderId: 'deepseek',
        providers: [
          { id: 'deepseek' },
          { id: 'acme-gateway', name: 'Acme Gateway' },
        ],
      },
    })
  })

  it('stores a pasted apiKey in the credentials service under a derived ref', async () => {
    const stored: Array<{ ref: string; value: string }> = []
    const credentials = { set: async (ref: string, value: string) => { stored.push({ ref, value }) } }
    const settings = makeSettings()
    const { client } = await startWithSettings(settings, credentials)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'acme-gateway',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-secret-123',
    })
    expect(res.error).toBeUndefined()
    // The literal key lands ONLY in the credentials store; the settings route
    // carries the derived reference name.
    expect(stored).toEqual([{ ref: 'ACME_GATEWAY_API_KEY', value: 'sk-secret-123' }])
    expect(settings.calls[0].ops[0].value).toEqual({
      apiKeyEnv: 'ACME_GATEWAY_API_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
    })
  })

  it('a pasted apiKey honors an explicit apiKeyEnv name', async () => {
    const stored: Array<{ ref: string; value: string }> = []
    const credentials = { set: async (ref: string, value: string) => { stored.push({ ref, value }) } }
    const settings = makeSettings()
    const { client } = await startWithSettings(settings, credentials)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'acme-gateway',
      apiKeyEnv: 'MY_ACME_KEY',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-secret-456',
    })
    expect(res.error).toBeUndefined()
    expect(stored).toEqual([{ ref: 'MY_ACME_KEY', value: 'sk-secret-456' }])
  })

  it('refuses a pasted apiKey when no credentials service exists', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'acme-gateway',
      baseURL: 'https://acme.test/v1',
      apiKey: 'sk-secret-789',
    })
    expect(res.error).toBeDefined()
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses a duplicate id without writing settings', async () => {
    const settings = makeSettings()
    settings.providers = { 'acme-gateway': { displayName: 'Acme' } }
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', { id: 'acme-gateway' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "acme-gateway" already exists' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses an invalid id before touching settings', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', { id: 'Acme-Gateway!' })
    expect(res.error).toMatchObject({ code: -32602 })
    expect(settings.calls).toHaveLength(0)
  })

  it('dynamically refreshes an OpenAI-compatible provider catalog from /models', async () => {
    const settings = makeSettings(true)
    settings.providers['ocx'] = {
      displayName: 'OpenCodex',
      apiKeyEnv: 'OCX_API_KEY',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:10100/v1',
      models: [
        { id: 'opencode-go/deepseek-v4-flash' },
        { id: 'deepseek-v4-pro', input: ['text', 'image'] },
      ],
    }
    const llm = {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'ocx', name: 'OpenCodex' },
      ],
      listModels: async (provider: string) => provider === 'deepseek'
        ? [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        : [{ provider: 'ocx', id: 'opencode-go/deepseek-v4-flash', name: 'opencode-go/deepseek-v4-flash' }],
      discoverModels: async (_ns: string, request: { provider?: string }) =>
        request.provider === 'ocx'
          ? [
            { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
            { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
          ]
          : [],
    }
    const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'] })
    harness = made
    client = await makeClient(made.socketPath)
    register(client)
    await client.next()

    const models = await client.request(1, 'x.ai/models/list', {})
    const listed = (models.result as { availableModels: Array<{ modelId: string; name: string; _meta: { provider: string } }> }).availableModels
    expect(listed.find(m => m.modelId === 'opencode-go/deepseek-v4-flash')).toMatchObject({
      modelId: 'opencode-go/deepseek-v4-flash',
      _meta: { provider: 'ocx' },
    })
    await waitFor(() => (settings.providers['ocx'] as { models?: Array<{ id?: string }> }).models?.[0]?.id === 'deepseek-v4-flash')
    const refreshed = await client.request(2, 'x.ai/models/list', {})
    const refreshedList = (refreshed.result as { availableModels: Array<{ modelId: string; name: string; _meta: { provider: string } }> }).availableModels
    expect(refreshedList.find(m => m.modelId === 'deepseek-v4-flash')).toMatchObject({
      modelId: 'deepseek-v4-flash',
      name: 'DeepSeek V4 Flash',
      _meta: { provider: 'ocx' },
    })
    expect(refreshedList.find(m => m.modelId === 'opencode-go/deepseek-v4-flash')).toBeUndefined()
    expect(settings.providers['ocx']).toMatchObject({
      models: [
        { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
        { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro', input: ['text', 'image'] },
      ],
    })
  })

  it('adopts endpoint reasoning capabilities so an explicit max effort is valid', async () => {
    const settings = makeSettings(true)
    settings.providers['ocx'] = {
      displayName: 'OpenCodex',
      apiKeyEnv: 'OCX_API_KEY',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:10100/v1',
      models: [{ id: 'deepseek-v4-flash' }],
    }
    const llm = {
      listProviders: () => [{ id: 'ocx', name: 'OpenCodex' }],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      discoverModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveModelInfo: async () => {
        const profile = settings.providers['ocx'] as { models: Array<{ id: string; reasoningEfforts?: false | Record<string, string | null> }> }
        const reasoningEfforts = profile.models[0]?.reasoningEfforts
        return {
          provider: 'ocx',
          id: 'deepseek-v4-flash',
          name: 'DeepSeek V4 Flash',
          ...(reasoningEfforts === undefined || reasoningEfforts === false
            ? {}
            : {
                reasoning: {
                  efforts: Object.keys(reasoningEfforts).map(id => ({ id, name: id })),
                },
              }),
        }
      },
    }
    const fetchModels = vi.fn(async () => new Response(JSON.stringify({
      object: 'list',
      data: [{
        id: 'deepseek-v4-flash',
        supports_reasoning_effort: true,
        reasoning_efforts: [
          { value: 'high', label: 'High Effort' },
          { value: 'max', label: 'Max Effort', default: true },
          { value: 'ultra', label: 'Unsupported by pi-ai' },
        ],
      }],
    }), { status: 200, headers: { 'content-type': 'application/json' } }))
    vi.stubGlobal('fetch', fetchModels)
    mockDefaultModel.current = {
      provider: 'ocx',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }
    try {
      const credentials = {
        resolve: async () => ({ value: 'stored-secret' }),
        set: async () => {},
      }
      const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'], credentials })
      harness = made
      client = await makeClient(made.socketPath)
      register(client)
      await client.next()

      const created = await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      await client.request(2, 'x.ai/models/list', {})
      await waitFor(() => {
        const profile = settings.providers['ocx'] as { models?: Array<{ reasoningEfforts?: unknown }> }
        return profile.models?.[0]?.reasoningEfforts !== undefined
      })
      expect((settings.providers['ocx'] as { models: unknown[] }).models).toEqual([{
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
        reasoningEfforts: { high: 'high', max: 'max' },
      }])
      expect(fetchModels).toHaveBeenCalledWith(
        'http://127.0.0.1:10100/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({ authorization: 'Bearer stored-secret' }),
        }),
      )

      const refreshed = await client.request(3, 'x.ai/models/list', {})
      const model = (refreshed.result as {
        availableModels: Array<{ modelId: string; _meta?: Record<string, unknown> }>
      }).availableModels[0]
      expect(model).toMatchObject({
        modelId: 'deepseek-v4-flash',
        _meta: {
          supportsReasoningEffort: true,
          reasoningEfforts: ['high', 'max'],
          reasoningEffort: 'max',
        },
      })
      const waterfall = made.pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => Promise<unknown>
      await waterfall('system-prompt/assemble', {}, {}, async () => ({ variables: {} }))
      const routed = await waterfall('agent/request', {
        agent: made.registry.byId.get(sessionId),
        turn: 0,
        step: 0,
        signal: new AbortController().signal,
      }, async () => ({ provider: 'fallback', model: 'fallback', reasoningEffort: 'low' }))
      expect(routed).toEqual({ provider: 'ocx', model: 'deepseek-v4-flash', reasoningEffort: 'max' })
      const selected = await client.request(4, 'session/set_model', {
        sessionId,
        modelId: 'deepseek-v4-flash',
        _meta: { reasoningEffort: 'max' },
      })
      expect(selected.error).toBeUndefined()
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not block initialize on dynamic model discovery', async () => {
    const settings = makeSettings(true)
    settings.providers['ocx'] = {
      displayName: 'OpenCodex',
      api: 'openai-responses',
      baseURL: 'http://127.0.0.1:10100/v1',
      models: [{ id: 'persisted-model' }],
    }
    let markStarted!: () => void
    const started = new Promise<void>(resolve => { markStarted = resolve })
    let releaseDiscovery!: (models: Array<{ id: string; name?: string }>) => void
    const discovery = new Promise<Array<{ id: string; name?: string }>>(resolve => { releaseDiscovery = resolve })
    const llm = {
      listProviders: () => [{ id: 'ocx', name: 'OpenCodex' }],
      listModels: async () => [{ id: 'persisted-model', name: 'Persisted Model' }],
      discoverModels: async () => {
        markStarted()
        return await discovery
      },
    }
    const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'] })
    harness = made
    client = await makeClient(made.socketPath)
    register(client)
    await client.next()

    const initializing = client.request(1, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    await started
    const completedWithoutDiscovery = await Promise.race([
      initializing.then(() => true),
      new Promise<boolean>(resolve => { setTimeout(() => { resolve(false) }, 250) }),
    ])
    releaseDiscovery([{ id: 'fresh-model', name: 'Fresh Model' }])
    expect(completedWithoutDiscovery).toBe(true)
    const initialized = await initializing
    expect((initialized.result as { _meta: { modelState: { availableModels: Array<{ modelId: string }> } } })
      ._meta.modelState.availableModels).toMatchObject([{ modelId: 'persisted-model' }])
    await waitFor(() => (settings.providers['ocx'] as { models?: Array<{ id?: string }> }).models?.[0]?.id === 'fresh-model')
  })

  it('fills a custom route with gateway-discovered models after the seam refuses', async () => {
    const settings = makeSettings()
    settings.firstWriteError = 'llm-pi-ai: provider "fake-gw" resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration'
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'fake-gw',
      displayName: 'Fake GW',
      apiKeyEnv: 'FAKE_KEY',
      api: 'openai-completions',
      baseURL: 'https://gateway.test/v1',
    })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(2)
    expect(settings.calls[1].ops[0].value).toMatchObject({
      displayName: 'Fake GW',
      models: [{ id: 'gw-model', name: 'GW Model', contextWindow: 8192 }],
    })
    expect(res.result).toMatchObject({ providers: [{ id: 'deepseek' }, { id: 'fake-gw', name: 'Fake GW' }] })
  })

  it('reports the seam failure when it is not the no-models case', async () => {
    const settings = makeSettings()
    settings.firstWriteError = 'llm-pi-ai: provider "x" has an empty baseURL'
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', { id: 'x', api: 'openai-completions' })
    expect(res.error).toMatchObject({ code: -32603 })
    expect(String(res.error.message)).toContain('has an empty baseURL')
    expect(settings.calls).toHaveLength(1)
  })

  it('ships the apiKeyEnv NAME, never the resolved secret, to a brand-new baseURL', async () => {
    const settings = makeSettings()
    settings.firstWriteError = 'llm-pi-ai: provider "evil-gw" resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration'
    const { client, llm } = await startWithSettings(settings)
    process.env.EXFIL_EVIL_KEY = 'resolved-super-secret'
    try {
      const res = await client.request(1, 'x.ai/providers/add', {
        id: 'evil-gw',
        apiKeyEnv: 'EXFIL_EVIL_KEY',
        api: 'openai-completions',
        baseURL: 'https://evil.test/v1',
      })
      expect(res.error).toBeUndefined()
    } finally {
      delete process.env.EXFIL_EVIL_KEY
    }
    expect(llm.discoveries).toEqual([{
      provider: 'evil-gw',
      api: 'openai-completions',
      baseURL: 'https://evil.test/v1',
      apiKey: 'EXFIL_EVIL_KEY', // the env NAME, never 'resolved-super-secret'
    }])
  })

  it('resolves the env key only when the draft baseURL matches a persisted route', async () => {
    const settings = makeSettings(true)
    settings.providers = { 'acme-gateway': { displayName: 'Acme', baseURL: 'https://acme.test/v1' } }
    settings.firstWriteError = 'llm-pi-ai: provider "acme-copy" resolves no models; the installed catalog does not describe this route, so its models must be listed in configuration'
    const { client, llm } = await startWithSettings(settings)
    process.env.EXFIL_ACME_KEY = 'resolved-acme-secret'
    try {
      const res = await client.request(1, 'x.ai/providers/add', {
        id: 'acme-copy',
        apiKeyEnv: 'EXFIL_ACME_KEY',
        api: 'openai-completions',
        baseURL: 'https://acme.test/v1',
      })
      expect(res.error).toBeUndefined()
    } finally {
      delete process.env.EXFIL_ACME_KEY
    }
    expect(llm.discoveries[0]?.apiKey).toBe('resolved-acme-secret')
  })

  it('refuses a baseURL with userinfo or a non-http scheme before any write', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const userinfo = await client.request(1, 'x.ai/providers/add', { id: 'evil', api: 'openai-completions', baseURL: 'https://user:pass@evil.test/v1' })
    expect(userinfo.error).toMatchObject({ code: -32602 })
    const ftp = await client.request(2, 'x.ai/providers/add', { id: 'evil-ftp', baseURL: 'ftp://evil.test/v1' })
    expect(ftp.error).toMatchObject({ code: -32602 })
    expect(settings.calls).toHaveLength(0)
  })

  it('recomposes provider settings for model lists only after the settings service announces a change', async () => {
    const settings = makeSettings(true)
    const { client } = await startWithSettings(settings)
    const listIds = async (id: number) => {
      const listed = await client.request(id, 'x.ai/models/list', {})
      expect(listed.error).toBeUndefined()
    }
    await listIds(1)
    const describe = vi.spyOn(settings as Required<typeof settings>, 'describe')
    await listIds(2); await listIds(3)
    expect(describe).toHaveBeenCalledTimes(0)
    harness!.ctx.emit('settings/document-updated', 'agent-preset-registry', 1)
    await listIds(4)
    expect(describe).toHaveBeenCalledTimes(0)
    harness!.ctx.emit('settings/document-updated', 'llm-pi-ai', 1)
    await listIds(5); await listIds(6)
    expect(describe).toHaveBeenCalledTimes(1)
    harness!.ctx.emit('app-boot/config-reload')
    await listIds(7)
    expect(describe).toHaveBeenCalledTimes(2)
  })
})
