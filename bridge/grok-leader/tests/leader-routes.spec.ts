/** The ACP method registry and the replies it builds itself. */
import { describe, expect, it, vi } from 'vitest'
import { JSONRPC_METHOD_NOT_FOUND } from '../src/acp.ts'
import { WIRE, createLeaderRoutes, initializeReply, registerFixedReplies } from '../src/leader-routes.ts'
import { RpcError } from '../src/protocol.ts'

const makeRoutes = () => {
  const warn = vi.fn()
  return { routes: createLeaderRoutes({ logger: { warn } }), warn }
}

describe('leader routes registry', () => {
  it('answers a request from its registered owner, sync or async', async () => {
    const { routes } = makeRoutes()
    const seen: unknown[] = []
    routes.register('x.ai/sync', { request: (clientId, params, method) => { seen.push([clientId, params, method]); return { ok: true } } })
    routes.register('x.ai/async', { request: async () => 'later' })
    await expect(routes.request(3, 'x.ai/sync', { a: 1 })).resolves.toEqual({ ok: true })
    await expect(routes.request(3, 'x.ai/async', undefined)).resolves.toBe('later')
    expect(seen).toEqual([[3, { a: 1 }, 'x.ai/sync']])
  })

  it('rejects an unknown request as METHOD_NOT_FOUND and drops an unknown notification', async () => {
    const { routes, warn } = makeRoutes()
    await expect(routes.request(1, 'x.ai/nothing', {})).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND, message: 'method not found: x.ai/nothing' })
    await expect(routes.request(1, 'x.ai/nothing', {})).rejects.toBeInstanceOf(RpcError)
    routes.notification(1, 'x.ai/nothing', {})
    expect(warn).toHaveBeenCalledWith('grok-leader: dropped notification x.ai/nothing')
  })

  it('treats a method sent as the kind it lacks as unknown', async () => {
    const { routes, warn } = makeRoutes()
    const notified = vi.fn(), requested = vi.fn(() => 'reply')
    routes.register('x.ai/only-notification', { notification: notified })
    routes.register('x.ai/only-request', { request: requested })
    await expect(routes.request(1, 'x.ai/only-notification', {})).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND })
    routes.notification(1, 'x.ai/only-request', {})
    expect(warn).toHaveBeenCalledWith('grok-leader: dropped notification x.ai/only-request')
    expect(notified).not.toHaveBeenCalled()
    expect(requested).not.toHaveBeenCalled()
    routes.notification(2, 'x.ai/only-notification', { n: 1 })
    expect(notified).toHaveBeenCalledWith(2, { n: 1 }, 'x.ai/only-notification')
  })

  it('gives each method one owner and removes only that owner on unregister', async () => {
    const { routes } = makeRoutes()
    const first = routes.register('x.ai/owned', { request: () => 'first' })
    expect(() => routes.register('x.ai/owned', { request: () => 'second' })).toThrow('leader route already registered: x.ai/owned')
    first()
    await expect(routes.request(1, 'x.ai/owned', {})).rejects.toMatchObject({ code: JSONRPC_METHOD_NOT_FOUND })
    routes.register('x.ai/owned', { request: () => 'second' })
    first() // The retired registration cannot remove its successor.
    await expect(routes.request(1, 'x.ai/owned', {})).resolves.toBe('second')
  })
})

describe('fixed replies', () => {
  it('answers the methods no owner implements with fresh fixed shapes', async () => {
    const { routes } = makeRoutes()
    registerFixedReplies(routes)
    await expect(routes.request(1, WIRE.authenticate, {})).resolves.toEqual({})
    await expect(routes.request(1, 'x.ai/marketplace/list', {})).resolves.toEqual({ sources: [] })
    await expect(routes.request(1, 'x.ai/hooks/list', {})).resolves.toEqual({ hooks: [], projectTrusted: false, loadErrors: [] })
    await expect(routes.request(1, 'x.ai/plugins/list', {})).resolves.toEqual({ plugins: [] })
    await expect(routes.request(1, 'x.ai/workflows/list', {})).resolves.toEqual({ workflows: [] })
    await expect(routes.request(1, 'x.ai/billing', {})).resolves.toEqual({ config: null, onDemandEnabled: false, subscriptionTier: null })
    await expect(routes.request(1, 'x.ai/suggestPrompt', { generation: 7 })).resolves.toEqual({ suggestion: null, generation: 7 })
    await expect(routes.request(1, 'x.ai/suggestPrompt', undefined)).resolves.toEqual({ suggestion: null, generation: 0 })
    // Built per call: a caller that mutates one reply cannot change the next.
    const hooks = await routes.request(1, 'x.ai/hooks/list', {}) as { hooks: unknown[] }
    hooks.hooks.push('mutated')
    await expect(routes.request(1, 'x.ai/hooks/list', {})).resolves.toEqual({ hooks: [], projectTrusted: false, loadErrors: [] })
  })

  it('refuses a session delete with a final internal error the TUI can print', async () => {
    const { routes } = makeRoutes()
    registerFixedReplies(routes)
    const failure = await routes.request(1, 'x.ai/session/delete', { sessionId: 's' }).then(() => undefined, (error: unknown) => error) as RpcError
    expect(failure).toBeInstanceOf(RpcError)
    expect(failure.code).not.toBe(JSONRPC_METHOD_NOT_FOUND)
    expect(failure.message).toBe('dscode sessions cannot be deleted; DSH keeps them. Archive is not supported yet.')
    expect((failure as { data?: unknown }).data).toBeUndefined()
  })
})

describe('initialize reply', () => {
  it('carries the fixed capabilities and the facts read at request time', () => {
    const catalog = {
      currentModelId: 'deepseek-chat',
      availableModels: [{ modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek' } }],
      currentProviderId: 'deepseek',
      providers: [{ id: 'deepseek', name: 'DeepSeek' }],
    }
    const commands = [{ name: 'model', description: 'Choose a model' }]
    expect(initializeReply({ version: '1.2.3', world: { kind: 'ssh', host: 'build', workspace: '/srv/work' }, commands, catalog })).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { embeddedContext: false },
        mcpCapabilities: { http: true },
        sessionCapabilities: { list: {}, close: {} },
      },
      authMethods: [{ id: 'xai.api_key', name: 'API key' }],
      agentInfo: { name: 'deepseek-harness-grok-leader', version: '1.2.3' },
      _meta: {
        grokShell: true,
        dscodeExecutionWorld: { kind: 'ssh', host: 'build', workspace: '/srv/work' },
        cancelRewind: false,
        sessionRecap: false,
        dscodeRemote: 1,
        availableCommands: commands,
        modelState: {
          currentModelId: 'deepseek-chat',
          availableModels: catalog.availableModels,
          _meta: { currentProviderId: 'deepseek', providers: catalog.providers },
        },
      },
    })
  })
})
