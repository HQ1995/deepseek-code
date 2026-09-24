/** Leader socket spec: leader handshake, registration and socket contract. */
import { statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { makeHarness, mockSessionsStore, mockVisionLlm, packageVersion, register, useLeaderHarness, waitFor } from './support/leader-harness.ts'

describe('leader handshake, registration and socket contract', () => {
  const start = useLeaderHarness()

  it('completes the probe-verified handshake with the captured reply shapes', async () => {
    const { registry, client: c } = await start()
    // Report the loaded bridge, independently of the client's advertised build.
    c.send({
      type: 'register',
      client_type: 'grok-shell',
      mode: 'stdio',
      capabilities: {
        yolo_mode: true, auto_mode: false, default_model: null, client_version: '1.0.4',
        code_nav_enabled: false, terminal: false, fs_read: false, fs_write: false,
      },
    })
    expect(await c.next()).toEqual({
      type: 'registered',
      client_id: 1,
      ready: true,
      leader_protocol_version: 1,
      leader_binary_version: packageVersion,
      leader_capabilities: { control_v1: false, workspace_exposure: false, relaunch_v1: false },
    })

    c.send({ type: 'ping' })
    expect(await c.next()).toEqual({ type: 'pong' })

    const initialize = await c.request(0, 'initialize', {
      protocolVersion: 1,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false, auth: { terminal: false } },
    })
    expect(initialize.error).toBeUndefined()
    expect(initialize.result).toMatchObject({
      protocolVersion: 1,
      authMethods: [{ id: 'xai.api_key', name: 'API key' }],
      _meta: {
        grokShell: true,
        dscodeExecutionWorld: { kind: 'local' },
        modelState: {
          currentModelId: 'deepseek-chat',
          availableModels: [
            { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
            { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
            { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi', supportsReasoningEffort: true, acceptsImages: false, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
          ],
          _meta: {
            currentProviderId: 'deepseek',
            providers: [
              { id: 'deepseek', name: 'DeepSeek' },
              { id: 'pi', name: 'Pi AI' },
            ],
          },
        },
      },
    })
    expect(registry.created).toHaveLength(0)
  })

  it('reports the actual bridge version to a dev client', async () => {
    const { client: c } = await start()
    c.send({
      type: 'register',
      client_type: 'grok-shell',
      mode: 'stdio',
      capabilities: { client_version: '0.0.13-beta.12-dev' },
    })
    const reply = await c.next() as { type: string; leader_binary_version?: string }
    expect(reply.type).toBe('registered')
    expect(reply.leader_binary_version).toBe(packageVersion)
  })

  it('reports the actual bridge version when the client omits one', async () => {
    const { client: c } = await start()
    register(c)
    const reply = await c.next() as { type: string; leader_binary_version?: string }
    expect(reply.leader_binary_version).toBe(packageVersion)
  })

  it('advertises the package.json version in agentInfo', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const initialize = await c.request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    const result = initialize.result as {
      agentInfo: { name: string; version: string }
      agentCapabilities: { mcpCapabilities: unknown }
    }
    // Drift guard: the hardcoded agentInfo.version must track package.json.
    expect(result.agentInfo).toEqual({
      name: 'deepseek-harness-grok-leader',
      version: packageVersion,
    })
    expect(result.agentCapabilities.mcpCapabilities).toEqual({ http: true })
  })

  it('supports a provider-neutral fresh profile with an empty model catalog', async () => {
    const emptyLlm = {
      listProviders: () => [],
      listModels: async () => [],
    }
    const { registry, client: c } = await start({ llm: emptyLlm })
    register(c)
    await c.next()
    const initialized = await c.request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    expect(initialized.error).toBeUndefined()
    expect((initialized.result as { _meta: { modelState: unknown } })._meta.modelState).toEqual({
      currentModelId: '',
      availableModels: [],
      _meta: { currentProviderId: '', providers: [] },
    })
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    expect(created.error).toBeUndefined()
    expect(registry.created).toHaveLength(1)
    const sessionId = (created.result as { sessionId: string }).sessionId
    const prompt = await c.request(2, 'session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: 'hello' }],
    })
    expect(prompt.error).toEqual({
      code: -32602,
      message: 'no model selected; use /provider to add or choose a provider first',
    })
  })

  it('rejects invalid MCP declarations before publishing a session', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [{ name: 'unsafe', command: 'relative', args: [], env: [] }],
    })
    expect(created.error).toEqual({
      code: -32602,
      message: 'mcpServers[0].command must be an absolute path',
    })
    expect(registry.created).toHaveLength(0)
  })

  it('mounts stdio MCP tools into a new Agent session', async () => {
    const definitions = new Map<string, {
      name: string
      execute(args: unknown, execution: unknown): Promise<unknown>
    }>()
    const tools = {
      register(definition: unknown) {
        const tool = definition as { name: string; execute(args: unknown, execution: unknown): Promise<unknown> }
        definitions.set(tool.name, tool)
        return () => { definitions.delete(tool.name) }
      },
      schemas: () => [...definitions.values()],
    }
    const { client: c } = await start({ tools })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [{
        name: 'fixture',
        command: process.execPath,
        args: [fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))],
        env: [],
      }],
    })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect([...definitions.keys()]).toEqual(['mcp__fixture__echo'])
    const echo = definitions.get('mcp__fixture__echo')
    await expect(echo?.execute({ text: 'through MCP' }, { signal: new AbortController().signal }))
      .resolves.toMatchObject({ content: [{ type: 'text', text: 'through MCP' }] })
    expect((await c.request(2, 'x.ai/mcp/list', { sessionId })).result).toMatchObject({
      servers: [{ name: 'fixture', session: { status: 'unknown' }, _meta: { toolCount: 1 } }],
    })
  })

  it('rejects invalid session requests with JSON-RPC errors', async () => {
    const { client: c } = await start({ llm: mockVisionLlm })
    register(c)
    await c.next()

    const badCwd = await c.request(1, 'session/new', { cwd: 'relative', mcpServers: [] })
    expect(badCwd.error).toEqual({ code: -32602, message: 'cwd must be an absolute path: relative' })

    const withMcp = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [{ name: 'fs', command: 'node', args: [], env: [] }] })
    expect(withMcp.error).toEqual({ code: -32602, message: 'mcpServers[0].command must be an absolute path' })

    const badMcp = await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: 'not-an-array' })
    expect(badMcp.error).toEqual({ code: -32602, message: 'mcpServers must be an array' })

    const created = await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    const unknownSession = await c.request(5, 'session/prompt', { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }] })
    expect(unknownSession.error).toEqual({ code: -32602, message: 'unknown session: missing' })

    const imagePrompt = await c.request(6, 'session/prompt', { sessionId, prompt: [{ type: 'image', data: '', mimeType: 'image/png' }] })
    expect(imagePrompt.error).toEqual({ code: -32602, message: 'Image upload is not canonical base64.' })
  })

  it('rejects malformed mcpServers declarations', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    expect((await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: { name: 'fs' } })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: 'fs' })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: 7 })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [{}] })).error).toEqual({ code: -32602, message: 'mcpServers[0].name must be a string' })
    expect((await c.request(5, 'session/new', { cwd: process.cwd(), mcpServers: [] })).error).toBeUndefined()
  })

  it('chmods the socket 0600 once listening', async () => {
    const made = await makeHarness()
    try {
      await waitFor(() => (statSync(made.socketPath).mode & 0o777) === 0o600)
    } finally {
      await made.ctx.fiber.dispose()
    }
  })

  it('treats a null _meta as absent on session/new, session/prompt, and session/load', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: null })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const prompted = await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'null meta' }], _meta: null })
    expect(prompted.error).toBeUndefined()
    expect(prompted.result).toMatchObject({ stopReason: 'cancelled' })
    await c.next() // consume the echoed user_message_chunk before the next request
    const loaded = await c.request(3, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: null })
    expect(loaded.error).toBeUndefined()
    expect(loaded.result).toEqual({})
  })

  it('enforces registration and rejects a second registration', async () => {
    const { client: c } = await start()

    c.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize' }) })
    expect(await c.next()).toEqual({ type: 'error', code: 1, message: 'Expected Register message' })

    register(c)
    await c.next()
    register(c)
    expect(await c.next()).toEqual({ type: 'error', code: 2, message: 'Already registered' })
  })

  it('tears down a disconnected client owned sessions', async () => {
    mockSessionsStore.flushed.length = 0
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)
    expect(agent).toBeDefined()

    c.send({ type: 'disconnect' })
    await new Promise<void>((resolveClose) => { c.socket.once('close', () => { resolveClose() }) })
    await waitFor(() => agent?.internals.disposed === true)
    expect(agent?.internals.disposed).toBe(true)
    expect(registry.byId.size).toBe(0)
    // The client teardown flushed the session store before disposing.
    expect(mockSessionsStore.flushed).toContain(agent?.session)
  })

  it('rejects CLI metadata the bridge cannot enforce instead of weakening it silently', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const cases = [
      { sandbox: 'workspace-write' },
      { tools: 'bash,edit' },
      { disallowedTools: 'web_search' },
      { systemPromptOverride: 'override' },
      { rules: 'extra rules' },
      { askUserQuestion: false },
      { autoMode: true },
      { permissionMode: 'acceptEdits' },
      { permissionMode: 'dontAsk' },
      { permissionMode: 'auto' },
      { permissionMode: 'unknown-mode' },
    ]
    for (const [index, meta] of cases.entries()) {
      const response = await c.request(index + 1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: meta })
      expect(response.error).toMatchObject({ code: -32602 })
      expect(String((response.error as { message?: string }).message)).toContain('refusing to run with silently weakened CLI settings')
    }
    const noSubagents = await c.request(cases.length + 1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { subagents: false } })
    expect(noSubagents.error).toEqual({
      code: -32602,
      message: '--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead',
    })
    expect(registry.created).toEqual([])
  })

  it('accepts the explicit disabled sandbox emitted by the dscode launcher', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const off = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { sandbox: 'off' },
    })
    const none = await c.request(2, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { sandbox: 'none' },
    })
    expect(off.error).toBeUndefined()
    expect(none.error).toBeUndefined()
    expect(registry.created).toHaveLength(2)
    const invalid = await c.request(3, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { sandbox: false },
    })
    expect(invalid.error).toEqual({ code: -32602, message: '_meta.sandbox must be a string' })
  })

  it('closing a session before 50ms suppresses _x.ai/mcp_initialized', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const closed = await c.request(2, 'session/close', { sessionId })
    expect(closed.error).toBeUndefined()
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 80) })
    expect(c.all.some(msg => msg.method === '_x.ai/mcp_initialized')).toBe(false)
  })
})
