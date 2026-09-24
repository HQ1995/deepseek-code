/** Leader socket spec: leader model catalog and selection. */
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { collectIds, collidingLlm, mockDefaultModel, mockSessionsStore, register, sendRequest, useLeaderHarness, waitFor } from './support/leader-harness.ts'

describe('leader model catalog and selection', () => {
  const start = useLeaderHarness()

  it('control: an ordinary catalog selection keeps the exact route', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'pi-code' })
    expect(switched.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'pi', model: 'pi-code' })
  })

  it('raw model names containing their provider prefix retain the full name', async () => {
    const llm = {
      listProviders: () => [{ id: 'p' }],
      listModels: async () => [{ id: 'base', name: 'Base' }, { id: 'p:mini', name: 'Tagged mini' }],
    }
    const { client: c } = await start({ llm: llm as never })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'p:mini' })
    expect(switched.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'p', model: 'p:mini' })
  })

  it('raw and generated model identifiers stay unique in the wire catalog', async () => {
    const llm = {
      listProviders: () => [{ id: 'a' }, { id: 'b' }],
      listModels: async (provider: string) => provider === 'a'
        ? [{ id: 'base', name: 'Base' }, { id: 'b:shared', name: 'A tagged model' }, { id: 'shared', name: 'A shared' }]
        : [{ id: 'shared', name: 'B shared' }],
    }
    const { client: c } = await start({ llm: llm as never })
    register(c)
    await c.next()
    const listed = await c.request(1, 'x.ai/models/list', {})
    expect(listed.error).toBeUndefined()
    const rows = (listed.result as { availableModels: Array<{ modelId: string }> }).availableModels
    expect(new Set(rows.map(row => row.modelId)).size).toBe(rows.length)
  })

  it('a rejected model save does not append an accepted session selection', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const before = agent.session.snapshotEvents()
    const originalSave = mockDefaultModel.saveSelection
    mockDefaultModel.saveSelection = async () => { throw new Error('injected settings write failure') }
    try {
      const rejected = await c.request(2, 'session/set_model', { sessionId, modelId: 'pi-code' })
      expect(rejected.error).toBeDefined()
      expect(agent.session.snapshotEvents()).toEqual(before)
    } finally {
      mockDefaultModel.saveSelection = originalSave
    }
  })

  it('reports an applied model with a durability warning when session flush fails', async () => {
    const store = { flush: async () => { throw new Error('history write failed') } }
    const { client: c, registry } = await start({ sessionsStore: store })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'pi-code' })
    expect(switched.error).toBeUndefined()
    expect(switched.result).toMatchObject({ _meta: { persistenceWarning: expect.stringContaining('history write failed') } })
    expect(registry.byId.get(sessionId)!.session.snapshotEvents().at(-1)).toMatchObject({ type: 'model/selection', data: { provider: 'pi', model: 'pi-code' } })
  })

  it('resolves model metadata across providers concurrently and refreshes changed adapters', async () => {
    let release!: () => void
    const ready = new Promise<void>(resolve => { release = resolve })
    const seen = new Set<string>()
    let effort = 'high'
    const llm = {
      listProviders: () => [{ id: 'one' }, { id: 'two' }],
      listModels: async () => [{ id: 'shared', name: 'Shared' }],
      resolveModelInfo: async (provider: string, id: string) => {
        seen.add(provider)
        if (seen.size === 2) release()
        await ready
        return { provider, id, reasoning: { efforts: [{ id: effort }] } }
      },
    }
    const { client: c } = await start({ llm })
    register(c)
    await c.next()
    const first = await c.request(1, 'x.ai/models/list', {})
    expect(first.result).toMatchObject({ availableModels: [
      { modelId: 'shared', _meta: { provider: 'one', reasoningEfforts: ['high'] } },
      { modelId: 'two:shared', _meta: { provider: 'two', reasoningEfforts: ['high'] } },
    ] })
    effort = 'max'
    const refreshed = await c.request(2, 'x.ai/models/list', {})
    expect(refreshed.result).toMatchObject({ availableModels: [
      { _meta: { reasoningEfforts: ['max'] } }, { _meta: { reasoningEfforts: ['max'] } },
    ] })
  })

  it('advertises exact model image capabilities to the TUI composer', async () => {
    const llm = {
      listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
      listModels: async () => [
        { id: 'vision', name: 'Vision', inputModalities: ['text', 'image'] },
        { id: 'text-only', name: 'Text only', inputModalities: ['text'] },
        { id: 'unknown', name: 'Unknown' },
      ],
      resolveModelInfo: async (_provider: string, model: string) => ({
        provider: 'deepseek',
        id: model,
        name: model,
        ...(model === 'unknown'
          ? {}
          : { inputModalities: model === 'vision' ? ['text', 'image'] : ['text'] }),
      }),
    }
    const { client: c } = await start({ llm })
    register(c)
    await c.next()

    const models = await c.request(1, 'x.ai/models/list', {})

    expect(models.result).toMatchObject({
      availableModels: [
        {
          modelId: 'vision',
          _meta: { inputModalities: ['text', 'image'], acceptsImages: true },
        },
        {
          modelId: 'text-only',
          _meta: { inputModalities: ['text'], acceptsImages: false },
        },
        {
          modelId: 'unknown',
          _meta: { acceptsImages: false },
        },
      ],
    })
  })

  it('rejects an explicit provider/model pair owned by different routes', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { provider: 'pi', model: 'deepseek-chat' },
    })
    expect(created.error).toMatchObject({
      code: -32602,
      message: 'requested provider/model is not in the catalog: pi/deepseek-chat',
    })
    expect(registry.created).toHaveLength(0)
  })

  it('lets an explicit wire model override a stale saved provider', async () => {
    mockDefaultModel.current = { provider: 'removed-provider', model: 'deepseek-chat' }
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { model: 'pi-code' },
    })
    const sessionId = (created.result as { sessionId: string }).sessionId

    expect(created.error).toBeUndefined()
    expect(registry.byId.get(sessionId)?.options).toMatchObject({
      provider: 'pi',
      model: 'pi-code',
    })
  })

  it('materializes the selected route into parent options for subagent inheritance', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { provider: 'pi', model: 'pi-code' },
    })
    const sessionId = (created.result as { sessionId: string }).sessionId

    expect(registry.byId.get(sessionId)?.options).toMatchObject({
      provider: 'pi',
      model: 'pi-code',
    })
  })

  it('rejects images for a model with no affirmative multimodal metadata', async () => {
    const saveImages = vi.fn(async () => [])
    const { client: c } = await start({ attachments: { saveImages } })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    const result = await c.request(2, 'session/prompt', {
      sessionId,
      prompt: [
        { type: 'text', text: 'inspect [Image #1]' },
        { type: 'image', data: 'AQID', mimeType: 'image/png' },
      ],
    })

    expect(result.error).toMatchObject({
      code: -32602,
      message: 'selected model does not support image input: deepseek/deepseek-chat',
    })
    expect(saveImages).not.toHaveBeenCalled()
  })

  it('drops a stale saved effort when exact model metadata exposes no reasoning', async () => {
    const exactLlm = {
      listProviders: () => [{ id: 'ocx', name: 'OpenCodex' }],
      listModels: async () => [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }],
      resolveModelInfo: async () => ({
        provider: 'ocx',
        id: 'deepseek-v4-flash',
        name: 'DeepSeek V4 Flash',
      }),
    }
    mockDefaultModel.current = {
      provider: 'ocx',
      model: 'deepseek-v4-flash',
      reasoningEffort: 'max',
    }
    const { persistence, client: c } = await start({ llm: exactLlm })
    register(c)
    await c.next()
    const initialized = await c.request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const modelState = (initialized.result as {
      _meta: { modelState: { availableModels: Array<{ modelId: string; _meta?: Record<string, unknown> }> } }
    })._meta.modelState
    const advertised = modelState.availableModels.find(model => model.modelId === 'deepseek-v4-flash')
    expect(advertised?._meta).toEqual({ provider: 'ocx', supportsReasoningEffort: false, acceptsImages: false })

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    const invalid = await c.request(2, 'session/set_model', {
      sessionId,
      modelId: 'deepseek-v4-flash',
      _meta: { reasoningEffort: 'max' },
    })
    expect(invalid.error).toMatchObject({
      code: -32602,
      message: 'reasoningEffort "max" is not supported by model deepseek-v4-flash',
    })
    const switched = await c.request(3, 'session/set_model', { sessionId, modelId: 'deepseek-v4-flash' })
    expect(switched.error).toBeUndefined()
    expect(mockDefaultModel.saved).toEqual([{ provider: 'ocx', model: 'deepseek-v4-flash' }])

    persistence.events.push({
      type: 'model/selected',
      seq: 0,
      time: 0,
      data: { provider: 'ocx', model: 'deepseek-v4-flash', reasoningEffort: 'max' },
    } as SessionEvent)
    const loaded = await c.request(4, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
    })
    expect(loaded.error).toBeUndefined()
    mockDefaultModel.saved.length = 0
    const resumedSwitch = await c.request(5, 'session/set_model', {
      sessionId: 'persisted-session',
      modelId: 'deepseek-v4-flash',
    })
    expect(resumedSwitch.error).toBeUndefined()
    expect(mockDefaultModel.saved).toEqual([{ provider: 'ocx', model: 'deepseek-v4-flash' }])
  })

  it('session/close drains an accepted model default write before disposing the native agent', async () => {
    const { registry, client: c } = await start()
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    let release!: () => void, entered = false
    const held = new Promise<void>(resolve => { release = resolve })
    const save = mockDefaultModel.saveSelection
    const spy = vi.spyOn(mockDefaultModel, 'saveSelection').mockImplementation(async selection => {
      entered = true; await held; await save(selection)
    })
    try {
      sendRequest(c, 2, 'session/set_model', { sessionId, modelId: 'pi-code' })
      await waitFor(() => entered)
      const notifications = c.all.length
      sendRequest(c, 3, 'session/close', { sessionId })
      await c.request(99, 'initialize', {})
      expect(agent.internals.disposed).toBe(false)
      expect(c.all.some(message => message.id === 3)).toBe(false)
      release()
      const replies = await collectIds(c, [2, 3])
      expect(replies.get(2)?.error).toMatchObject({ code: -32602, message: 'session closed' })
      expect(replies.get(3)?.error).toBeUndefined()
      expect(agent.internals.disposed).toBe(true)
      expect(mockSessionsStore.flushed).toContain(agent.session)
      expect(c.all.slice(notifications).some(message => message.method === 'x.ai/models/update')).toBe(false)
    } finally { release(); spy.mockRestore() }
  })

  it('reports the saved reasoning effort on the current model in models/list', async () => {
    const { client: c, registry } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined
    mockDefaultModel.current = { provider: 'deepseek', model: 'deepseek-chat' }
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'deepseek-chat', _meta: { reasoningEffort: 'max' } })
    expect(switched.error).toBeUndefined()
    expect(mockDefaultModel.saved).toEqual([{ provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' }])
    const agent = registry.byId.get(sessionId)!
    expect(agent.session.snapshotEvents().at(-1)).toMatchObject({
      type: 'model/selection',
      data: { provider: 'deepseek', model: 'deepseek-chat', reasoningEffort: 'max' },
    })
    expect(mockSessionsStore.flushed.at(-1)).toBe(agent.session)
    const models = await c.request(3, 'x.ai/models/list', {})
    const listed = (models.result as { availableModels: Array<{ modelId: string; _meta?: { reasoningEffort?: string } }> }).availableModels
    expect(listed.find(m => m.modelId === 'deepseek-chat')?._meta?.reasoningEffort).toBe('max')
  })

  it('remembers a model effort across switches and re-applies it on return', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined

    const setReasoner = await c.request(2, 'session/set_model', { sessionId, modelId: 'deepseek-reasoner', _meta: { reasoningEffort: 'max' } })
    expect(setReasoner.error).toBeUndefined()
    expect(mockDefaultModel.saved).toEqual([{ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' }])

    const setPi = await c.request(3, 'session/set_model', { sessionId, modelId: 'pi-code' })
    expect(setPi.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'pi', model: 'pi-code' })

    const backToReasoner = await c.request(4, 'session/set_model', { sessionId, modelId: 'deepseek-reasoner' })
    expect(backToReasoner.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'deepseek', model: 'deepseek-reasoner', reasoningEffort: 'max' })

    // The bridge broadcasts the refreshed catalog so the TUI can show the
    // remembered effort immediately, not only on the next models/list call.
    const update = c.all.find(m =>
      m.method === 'x.ai/models/update'
      && (m.params as { currentModelId?: string }).currentModelId === 'deepseek-reasoner')
    expect(update).toBeDefined()
    const updatedModels = (update!.params as { availableModels: Array<{ modelId: string; _meta?: { reasoningEffort?: string } }> }).availableModels
    expect(updatedModels.find(m => m.modelId === 'deepseek-reasoner')?._meta?.reasoningEffort).toBe('max')

    const models = await c.request(5, 'x.ai/models/list', {})
    const listed = (models.result as { availableModels: Array<{ modelId: string; _meta?: { reasoningEffort?: string } }> }).availableModels
    expect(listed.find(m => m.modelId === 'deepseek-reasoner')?._meta?.reasoningEffort).toBe('max')
  })

  it('keeps effort memory isolated between sessions using the same model', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const first = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const second = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const firstId = (first.result as { sessionId: string }).sessionId
    const secondId = (second.result as { sessionId: string }).sessionId

    expect((await c.request(3, 'session/set_model', {
      sessionId: firstId,
      modelId: 'deepseek-reasoner',
      _meta: { reasoningEffort: 'high' },
    })).error).toBeUndefined()
    expect((await c.request(4, 'session/set_model', {
      sessionId: secondId,
      modelId: 'deepseek-reasoner',
      _meta: { reasoningEffort: 'low' },
    })).error).toBeUndefined()
    expect((await c.request(5, 'session/set_model', {
      sessionId: firstId,
      modelId: 'pi-code',
    })).error).toBeUndefined()
    expect((await c.request(6, 'session/set_model', {
      sessionId: firstId,
      modelId: 'deepseek-reasoner',
    })).error).toBeUndefined()

    expect(mockDefaultModel.saved.at(-1)).toEqual({
      provider: 'deepseek',
      model: 'deepseek-reasoner',
      reasoningEffort: 'high',
    })
  })

  it('session/set_model rejects a modelId outside the catalog without persisting', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined
    const bad = await c.request(2, 'session/set_model', { sessionId, modelId: 'no-such-model' })
    expect(bad.error).toMatchObject({ code: -32602, message: 'modelId is not in the catalog: no-such-model' })
    // The unresolvable selection was never persisted as the default.
    expect(mockDefaultModel.saved).toEqual([])
  })

  it('resolves session/set_model provider through the catalog mapping', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'pi-code', _meta: { reasoningEffort: 'high' } })
    expect(switched.result).toEqual({})
    expect(mockDefaultModel.saved).toEqual([{ provider: 'pi', model: 'pi-code', reasoningEffort: 'high' }])
  })

  it('annotates every empty provider with the generic setup note', async () => {
    const subscriptionLlm = {
      listProviders: () => [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'codex', name: 'ChatGPT (Codex)' },
        { id: 'bare-api', name: 'Bare API' },
      ],
      listModels: async (provider: string) => provider === 'deepseek'
        ? [{ id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        : [],
    }
    const { client: c } = await start({ llm: subscriptionLlm })
    register(c)
    await c.next()

    const models = await c.request(1, 'x.ai/models/list', {})
    const providers = (models.result as { _meta: { providers: Array<{ id: string; note?: string }> } })._meta.providers
    // Every empty provider gets the same GENERIC note: the bridge carries no
    // plugin-specific knowledge of which login or key a provider wants (that
    // belongs to the provider's own plugin, e.g. a registered /login command).
    const genericNote = 'no models yet — the provider may need a login or API key (its plugin may register a /login command)'
    expect(providers).toEqual([
      { id: 'deepseek', name: 'DeepSeek' },
      { id: 'codex', name: 'ChatGPT (Codex)', note: genericNote },
      { id: 'bare-api', name: 'Bare API', note: genericNote },
    ])
  })

  it('keeps broken provider settings visible with native diagnostics and serves healthy models', async () => {
    const { client: c } = await start({ llm: {
      listProviders: () => [{ id: 'healthy' }],
      listModels: async (id: string) => {
        expect(id).toBe('healthy')
        return [{ id: 'working', name: 'Working model' }]
      },
      listConfigurableProviders: () => [
        { provider: 'healthy', displayName: 'Healthy', settingsNs: 'llm-pi-ai', error: 'Removed model retired; working remains usable' },
        { provider: 'broken', displayName: 'Broken route', settingsNs: 'llm-pi-ai', error: 'Unknown model old-id; repair its settings' },
        { provider: 'dormant', displayName: 'Not configured', settingsNs: 'llm-pi-ai' },
      ],
    } })
    register(c)
    await c.next()
    const response = await c.request(1, 'x.ai/models/list', {})
    expect(response.error).toBeUndefined()
    expect(response.result).toMatchObject({
      availableModels: [{ modelId: 'working' }],
      _meta: { providers: [
        { id: 'healthy', note: 'Removed model retired; working remains usable' },
        { id: 'broken', name: 'Broken route', note: 'Unknown model old-id; repair its settings' },
      ] },
    })
  })

  it('dedupes colliding model ids and falls back to a catalog entry', async () => {
    const { client: c } = await start({ llm: collidingLlm, model: 'not-in-catalog' })
    register(c)
    await c.next()

    const initialize = await c.request(0, 'initialize', { protocolVersion: 1 })
    const modelState = (initialize.result as {
      _meta: { modelState: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } }
    })._meta.modelState
    expect(modelState.availableModels).toEqual([
      { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
      { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { modelId: 'b:shared', name: 'Shared B', _meta: { provider: 'b', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    ])
    expect(modelState.currentModelId).toEqual('shared')

    const models = await c.request(1, 'x.ai/models/list', {})
    expect(models.result).toEqual({
      currentModelId: 'shared',
      availableModels: [
        { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
        { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'b:shared', name: 'Shared B', _meta: { provider: 'b', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      ],
      _meta: {
        currentProviderId: 'a',
        providers: [{ id: 'a' }, { id: 'b' }],
      },
    })
  })

  it('remembers model and effort for a provider-qualified duplicate id', async () => {
    const { client: c } = await start({ llm: collidingLlm })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined

    const setBShared = await c.request(2, 'session/set_model', { sessionId, modelId: 'b:shared', _meta: { reasoningEffort: 'max' } })
    expect(setBShared.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'b', model: 'shared', reasoningEffort: 'max' })

    const setOnlyA = await c.request(3, 'session/set_model', { sessionId, modelId: 'only-a' })
    expect(setOnlyA.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'a', model: 'only-a' })

    const backToBShared = await c.request(4, 'session/set_model', { sessionId, modelId: 'b:shared' })
    expect(backToBShared.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'b', model: 'shared', reasoningEffort: 'max' })

    const models = await c.request(5, 'x.ai/models/list', {})
    const listed = (models.result as { availableModels: Array<{ modelId: string; _meta?: { reasoningEffort?: string } }> }).availableModels
    expect(listed.find(m => m.modelId === 'b:shared')?._meta?.reasoningEffort).toBe('max')
  })

  it('does not leak a remembered effort to the same raw model on another provider', async () => {
    const { client: c } = await start({ llm: collidingLlm })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined

    const setAShared = await c.request(2, 'session/set_model', { sessionId, modelId: 'shared', _meta: { reasoningEffort: 'high' } })
    expect(setAShared.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'a', model: 'shared', reasoningEffort: 'high' })

    // The same raw id can expose a different effort vocabulary on provider b.
    const setBShared = await c.request(3, 'session/set_model', { sessionId, modelId: 'b:shared' })
    expect(setBShared.error).toBeUndefined()
    expect(mockDefaultModel.saved.at(-1)).toEqual({ provider: 'b', model: 'shared' })
  })

  it('rejects a reasoning effort the selected model did not advertise', async () => {
    const { client: c } = await start({ llm: collidingLlm })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/set_model', { sessionId, modelId: 'shared', _meta: { reasoningEffort: 'quantum' } })
    expect(switched.error).toMatchObject({ code: -32602, message: 'reasoningEffort "quantum" is not supported by model shared' })
  })
})
