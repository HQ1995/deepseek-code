/**
 * End-to-end leader tests over a real unix socket against a mocked agent
 * registry, pinned to the captured TUI handshake
 * (tests/fixtures/grok-tui-messages.jsonl, docs/grok-tui-connect.md).
 */
import { randomUUID } from 'node:crypto'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { encodeJsonFrame, FrameDecoder } from '../src/codec.ts'
import * as GrokLeader from '../src/index.ts'

interface MockAgentInternals {
  cancelCalls: number
  followups: string[]
  disposed: boolean
  idleWaiters: Array<() => void>
}

type MockAgent = Agent & { internals: MockAgentInternals }

interface MockRegistry {
  created: Array<{ sessionId: string; cwd?: string; agentPreset?: string }>
  resumed: Array<{ sessionId: string }>
  byId: Map<string, MockAgent>
  create(options: unknown): Promise<{ agent: Agent; dispose: () => Promise<void> }>
  resume(options: unknown): Promise<{ agent: Agent; dispose: () => Promise<void> }>
  get(id: SessionId): Agent | undefined
}

function makeMockRegistry(ctx: Context, manualIdle = false): MockRegistry {
  const created: Array<{ sessionId: string; cwd?: string }> = []
  const resumed: Array<{ sessionId: string }> = []
  const byId = new Map<string, MockAgent>()
  const makeAgent = (sessionId: SessionId, cwd: string | undefined): MockAgent => {
    const internals: MockAgentInternals = { cancelCalls: 0, followups: [], disposed: false, idleWaiters: [] }
    const agent = {
      id: sessionId,
      options: {} as AgentOptions,
      session: {
        id: sessionId,
        header: { id: sessionId, version: 0, createdAt: 0, ...cwd === undefined ? {} : { cwd } },
        events: [],
      },
      inbox: {},
      status: 'idle',
      ctx,
      internals,
      cancel() { internals.cancelCalls += 1 },
      whenIdle() {
        if (!manualIdle) return Promise.resolve()
        return new Promise<void>((resolveIdle) => { internals.idleWaiters.push(resolveIdle) })
      },
      runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) { return task(new AbortController().signal) },
      send() {},
      followup(message: unknown) {
        const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text !== undefined) internals.followups.push(block.text)
        }
      },
      steer() {},
      inject() {},
    } as unknown as MockAgent
    byId.set(sessionId, agent)
    return agent
  }
  return {
    created,
    resumed,
    byId,
    async create(options) {
      const o = options as { sessionId: SessionId; meta?: { cwd?: string; agentPreset?: string }; setup?: (agentCtx: Context) => unknown }
      created.push({
        sessionId: o.sessionId,
        ...o.meta?.cwd === undefined ? {} : { cwd: o.meta.cwd },
        ...o.meta?.agentPreset === undefined ? {} : { agentPreset: o.meta.agentPreset },
      })
      if (o.setup !== undefined) await o.setup(ctx)
      const agent = makeAgent(o.sessionId, o.meta?.cwd)
      return { agent, dispose: async () => { agent.internals.disposed = true; byId.delete(o.sessionId) } }
    },
    async resume(options) {
      const o = options as { resumeSessionId: SessionId; setup?: (agentCtx: Context) => unknown }
      resumed.push({ sessionId: o.resumeSessionId })
      if (o.setup !== undefined) await o.setup(ctx)
      const agent = makeAgent(o.resumeSessionId, undefined)
      return { agent, dispose: async () => { agent.internals.disposed = true; byId.delete(o.resumeSessionId) } }
    },
    get(id) { return byId.get(id) },
  }
}

const mockLlm = {
  listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }, { id: 'pi', name: 'Pi AI' }],
  listModels: async (provider: string) => provider === 'deepseek'
    ? [
      { provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' },
      { provider: 'deepseek', id: 'deepseek-reasoner', name: 'DeepSeek Reasoner' },
    ]
    : provider === 'pi'
      ? [{ provider: 'pi', id: 'pi-code', name: 'Pi Code' }]
      : [],
}

/** Two providers that both list the id "shared": exercises the catalog dedup. */
const collidingLlm = {
  listProviders: () => [{ id: 'a' }, { id: 'b' }],
  listModels: async (provider: string) => provider === 'a'
    ? [{ id: 'shared', name: 'Shared A' }, { id: 'only-a', name: 'Only A' }]
    : [{ id: 'shared', name: 'Shared B' }, { id: 'only-b', name: 'Only B' }],
}

function makeMockPersistence() {
  const header = { version: 0, id: SessionId('persisted-session'), createdAt: 0, cwd: '/tmp/proj', agentPreset: 'standard' }
  const loaded: string[] = []
  return {
    header,
    loaded,
    list: async () => [header],
    load: async (id: SessionId) => { loaded.push(id); return { meta: header, events: [] } },
  }
}

function makeMockPresets() {
  const resolved: Array<string | undefined> = []
  const mounted: string[] = []
  return {
    resolved,
    mounted,
    list: async () => [
      { id: 'standard', trust: 'system', name: '标准模式', description: 'standard desc' },
      { id: 'code', trust: 'system', name: 'PTC 模式', description: 'code desc' },
      { id: 'minimal', trust: 'system', name: '极简模式', description: 'minimal desc' },
      { id: 'cordis', trust: 'system', name: '创造模式', description: 'cordis desc' },
    ],
    resolve: async (id?: string) => {
      resolved.push(id)
      const chosen = id ?? 'standard'
      if (chosen === 'standard' || chosen === 'code' || chosen === 'minimal' || chosen === 'cordis') return { id: chosen }
      throw new Error('agent-presets: preset "' + chosen + '" not found (available: standard, cordis, minimal, code)')
    },
    mount: async (_agentCtx: unknown, id?: string) => {
      mounted.push(id ?? 'standard')
      return { id: id ?? 'standard' }
    },
  }
}

const mockDefaultModel = {
  saved: [] as Array<{ provider: string; model: string; reasoningEffort?: string }>,
  saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
    mockDefaultModel.saved.push(next)
  },
}

const mockSessionsStore = {
  flushed: [] as unknown[],
  flush: async (session: object) => { mockSessionsStore.flushed.push(session); return true },
}

interface LeaderHarness {
  ctx: Context
  socketPath: string
  registry: MockRegistry
  persistence: ReturnType<typeof makeMockPersistence>
  presets: ReturnType<typeof makeMockPresets> | undefined
}

interface ClientHandle {
  socket: Socket
  next(): Promise<Record<string, unknown>>
  /** x.ai/queue/changed broadcasts, captured instead of queueing. */
  broadcasts: Array<Record<string, unknown>>
  send(msg: unknown): void
  request(id: number, method: string, params?: unknown): Promise<Record<string, unknown>>
  notify(method: string, params?: unknown): void
}

async function makeClient(socketPath: string): Promise<ClientHandle> {
  const socket = createConnection(socketPath)
  await new Promise<void>((resolveConnect, reject) => {
    socket.once('connect', () => { resolveConnect() })
    socket.once('error', reject)
  })
  const decoder = new FrameDecoder()
  const queue: Record<string, unknown>[] = []
  const broadcasts: Array<Record<string, unknown>> = []
  const waiters: Array<(value: Record<string, unknown>) => void> = []
  socket.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const raw = JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>
      // Unwrap acp envelopes: the inner JSON-RPC object carries the request id.
      const msg = raw.type === 'acp' && typeof raw.payload === 'string'
        ? JSON.parse(raw.payload) as Record<string, unknown>
        : raw
      // Ambient queue broadcasts interleave with every response; capture them
      // separately so order-sensitive assertions keep their exact messages.
      if (msg.method === 'x.ai/queue/changed') { broadcasts.push(msg); continue }
      const waiter = waiters.shift()
      if (waiter !== undefined) waiter(msg)
      else queue.push(msg)
    }
  })
  const next = (): Promise<Record<string, unknown>> => {
    const head = queue.shift()
    if (head !== undefined) return Promise.resolve(head)
    return new Promise((resolveWait) => { waiters.push(resolveWait) })
  }
  return {
    socket,
    broadcasts,
    next,
    send(msg: unknown) { socket.write(encodeJsonFrame(msg)) },
    async request(id: number, method: string, params?: unknown) {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
      if (params !== undefined) payload.params = params
      socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(payload) }))
      for (let spins = 0; ; spins++) {
        const msg = await next()
        if (msg.id === id) return msg
        queue.push(msg)
        if (spins > 5) throw new Error('request spin: want id ' + String(id) + ' got ' + JSON.stringify(msg).slice(0, 240))
      }
    },
    notify(method: string, params?: unknown) {
      const payload: Record<string, unknown> = { jsonrpc: '2.0', method }
      if (params !== undefined) payload.params = params
      socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify(payload) }))
    },
  }
}

/** Poll until the predicate holds, then return; fail after the timeout. */
async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 1) })
  }
}

/** Fire a JSON-RPC request without awaiting its response (deferred-response tests). */
function sendRequest(client: ClientHandle, id: number, method: string, params?: unknown): void {
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) payload.params = params
  client.send({ type: 'acp', payload: JSON.stringify(payload) })
}

/** Consume frames until the response with id arrives, dropping the rest. */
async function waitForId(client: ClientHandle, id: number): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await client.next()
    if (msg.id === id) return msg
  }
}

/** Consume frames until every requested id has been answered (order-independent). */
async function collectIds(client: ClientHandle, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const found = new Map<number, Record<string, unknown>>()
  while (found.size < ids.length) {
    const msg = await client.next()
    if (typeof msg.id === 'number' && ids.includes(msg.id)) found.set(msg.id, msg)
  }
  return found
}

async function makeHarness(
  options: { presets?: boolean; manualIdle?: boolean; llm?: unknown; model?: string; settings?: unknown } = {},
): Promise<LeaderHarness> {
  const ctx = new Context()
  const registry = makeMockRegistry(ctx, options.manualIdle === true)
  const persistence = makeMockPersistence()
  const presets = options.presets === true ? makeMockPresets() : undefined
  ctx.provide('agents', registry as unknown as Context['agents'])
  ctx.provide('llm', options.llm ?? mockLlm as unknown as Context['llm'])
  // Stub settings service: initialize awaits the real one for a bounded time,
  // which tests must not spend when the harness composes no settings provider.
  ctx.provide('settings', (options.settings ?? { mutate: async () => {} }) as unknown as Context['settings'])
  ctx.provide('sessionPersistence', persistence as unknown as Context['sessionPersistence'])
  ctx.provide('sessions', mockSessionsStore as unknown as Context['sessions'])
  if (presets !== undefined) ctx.provide('agentPresets', presets as unknown as Context['agentPresets'])
  ctx.provide('agentDefaultModel', mockDefaultModel as unknown as Context['agentDefaultModel'])
  const socketPath = resolve(tmpdir(), 'dsh-grok-leader-' + String(process.pid) + '-' + randomUUID() + '.sock')
  await ctx.plugin({
    name: 'grok-leader-test',
    inject: [...GrokLeader.inject],
    apply: (inner: Context) => { GrokLeader.apply(inner, { socketPath, ...options.model === undefined ? {} : { model: options.model } }) },
  })
  return { ctx, socketPath, registry, persistence, presets }
}

const register = (client: ClientHandle): void => {
  client.send({ type: 'register', client_type: 'grok-shell', mode: 'stdio' })
}

describe('grok leader over a unix socket', () => {
  let harness: LeaderHarness | undefined
  let client: ClientHandle | undefined

  afterEach(async () => {
    client?.socket.destroy()
    await harness?.ctx.fiber.dispose()
    harness = undefined
    client = undefined
    mockDefaultModel.saved.length = 0
  })

  const start = async (
    options: { presets?: boolean; manualIdle?: boolean; llm?: unknown; model?: string } = {},
  ): Promise<LeaderHarness & { client: ClientHandle }> => {
    harness = await makeHarness(options)
    client = await makeClient(harness.socketPath)
    return { ...harness, client }
  }

  it('completes the probe-verified handshake with the captured reply shapes', async () => {
    const { registry, client: c } = await start()
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
      leader_binary_version: '1.0.4',
      leader_capabilities: { control_v1: true, workspace_exposure: false, relaunch_v1: false },
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
        modelState: {
          currentModelId: '',
          availableModels: [
            { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek' } },
            { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek' } },
            { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi' } },
          ],
          _meta: {
            currentProviderId: '',
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

  it('runs the session flow: new, prompt, cancel, models, list, load, close', async () => {
    const { registry, persistence, client: c } = await start()
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd() }])

    const promptResult = await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello there' }] })
    // Turnless mock: admission never claims a turn, so the prompt settles cancelled at idle.
    expect(promptResult.result).toEqual({ stopReason: 'cancelled' })
    expect(registry.byId.get(sessionId)?.internals.followups).toEqual(['hello there'])

    // The accepted prompt is echoed before the response so it enters the transcript.
    const echo = await c.next()
    expect(echo).toMatchObject({
      jsonrpc: '2.0',
      method: 'session/update',
      params: {
        sessionId,
        update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'hello there' } },
        _meta: { eventSeq: 1, promptId: expect.any(String) as string },
      },
    })

    c.notify('session/cancel', { sessionId })
    c.notify('_x.ai/log', { src: 'grok-pager', entries: [] })

    const models = await c.request(3, 'x.ai/models/list', {})
    expect(models.result).toEqual({
      currentModelId: '',
      availableModels: [
        { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek' } },
        { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek' } },
        { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi' } },
      ],
      _meta: {
        currentProviderId: '',
        providers: [
          { id: 'deepseek', name: 'DeepSeek' },
          { id: 'pi', name: 'Pi AI' },
        ],
      },
    })

    const listed = await c.request(4, 'session/list', {})
    expect(listed.result).toEqual({
      sessions: [{ sessionId: 'persisted-session', cwd: '/tmp/proj', updatedAt: '1970-01-01T00:00:00.000Z' }],
    })

    const loaded = await c.request(5, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.result).toEqual({})
    expect(persistence.loaded).toEqual(['persisted-session'])
    expect(registry.resumed).toEqual([{ sessionId: 'persisted-session' }])

    const closed = await c.request(6, 'session/close', { sessionId: 'persisted-session' })
    expect(closed.result).toEqual({})
    // The mock disposer removes the entry, so absence is the disposal proof.
    expect(registry.byId.has('persisted-session')).toBe(false)
    expect(mockSessionsStore.flushed).toHaveLength(1)

    // Unknown notifications are dropped and unknown requests get method-not-found.
    const unknown = await c.request(7, 'no/such/method', {})
    expect(unknown.error).toEqual({ code: -32601, message: 'method not found: no/such/method' })

    // The connection survives all of it: ping still answers.
    c.send({ type: 'ping' })
    expect(await c.next()).toEqual({ type: 'pong' })
  })

  it('broadcasts x.ai/queue/changed while a prompt runs and when it settles', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello there' }] })

    expect(c.broadcasts.length).toBeGreaterThanOrEqual(3)
    const first = c.broadcasts[0]!
    expect(first.params).toMatchObject({
      sessionId,
      entries: [],
    })
    const fp = first.params as { runningPromptId?: string; runningText?: string; runningKind?: string }
    expect(fp.runningPromptId).toEqual(expect.any(String) as string)
    expect(fp.runningText).toBe('hello there')
    expect(fp.runningKind).toBe('prompt')
    const last = c.broadcasts[c.broadcasts.length - 1]!
    expect((last.params as { runningPromptId?: string }).runningPromptId).toBeUndefined()
  })

  it('queues a second prompt and reports it in x.ai/queue/changed until promotion', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // First prompt parks on an idle waiter (mock never claims the turn).
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => Array.isArray((b.params as { entries?: unknown }).entries) && ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const hp = held.params as { entries?: Array<{ id: string; text: string; kind: string; position: number }>; runningPromptId?: string }
    expect(hp.entries).toHaveLength(1)
    expect(hp.entries![0]).toMatchObject({ kind: 'prompt', text: 'second', position: 0 })
    expect(hp.runningPromptId).toEqual(expect.any(String) as string)

    // Release the first turn; the queue promotes and empties.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.length === 2 && agent.internals.idleWaiters.length === 1)
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 0 && (b.params as { runningPromptId?: string }).runningPromptId !== undefined))
  })

  it('rejects invalid session requests with JSON-RPC errors', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()

    const badCwd = await c.request(1, 'session/new', { cwd: 'relative', mcpServers: [] })
    expect(badCwd.error).toEqual({ code: -32602, message: 'cwd must be an absolute path: relative' })

    const badMcp = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [{ name: 'fs', command: 'node', args: [], env: [] }] })
    expect(badMcp.error).toEqual({ code: -32602, message: 'mcpServers is not supported' })

    const created = await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    const unknownSession = await c.request(4, 'session/prompt', { sessionId: 'missing', prompt: [{ type: 'text', text: 'x' }] })
    expect(unknownSession.error).toEqual({ code: -32602, message: 'unknown session: missing' })

    const imagePrompt = await c.request(5, 'session/prompt', { sessionId, prompt: [{ type: 'image', data: '', mimeType: 'image/png' }] })
    expect(imagePrompt.error).toEqual({ code: -32602, message: 'only text and resource_link prompt content is supported' })
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
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)
    expect(agent).toBeDefined()

    c.send({ type: 'disconnect' })
    await new Promise<void>((resolveClose) => { c.socket.once('close', () => { resolveClose() }) })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent?.internals.disposed).toBe(true)
    expect(registry.byId.size).toBe(0)
  })

  it('routes the grok agentProfile to the dsh preset roster', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'code' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd(), agentPreset: 'code' }])
    expect(presets?.resolved).toEqual(['code'])
    expect(presets?.mounted).toEqual(['code'])
  })

  it('lists the dsh preset roster as bundle/status personas', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const status = await c.request(1, 'x.ai/bundle/status', {})
    expect(status.error).toBeUndefined()
    expect(status.result).toEqual({
      hasCache: true,
      personas: ['standard', 'code', 'minimal', 'cordis'],
      roles: [],
      agents: [],
      skills: [],
      personaDetails: [
        { name: 'Standard mode', description: 'Full coding agent with file editing, shell, file and web search, skills, planning, goals, subagents, and workflows.', hasInputs: false, hasOutputs: false },
        { name: 'Code mode', description: 'All Standard mode capabilities, with tools exposed through the Code Mode SDK so the model can combine multi-step operations in one TypeScript program.', hasInputs: false, hasOutputs: false },
        { name: 'Minimal mode', description: 'Two-tool coding agent with persistent bash and str_replace_editor.', hasInputs: false, hasOutputs: false },
        { name: 'Creator mode', description: 'Built for creating custom agent presets, with all Standard mode capabilities plus runtime inspection, plugin experiments, and preset-authoring guidance.', hasInputs: false, hasOutputs: false },
      ],
      roleDetails: [],
    })
  })

  it('overrides the persisted preset on session/load when a valid preset is explicitly requested', async () => {
    const { presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['minimal'])
  })

  it('keeps the persisted preset on session/load when no preset is explicitly requested', async () => {
    const { presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['standard'])
  })

  it('defaults a preset-less session to the roster default', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd(), agentPreset: 'standard' }])
    expect(presets?.mounted).toEqual(['standard'])
  })

  it('falls back to the default preset for grok built-ins and rejects JSON-object agent selections', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const unknown = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'grok-build-plan' } })
    expect(unknown.error).toBeUndefined()
    const objectProfile = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: { name: 'custom' } } })
    expect(objectProfile.error).toEqual({ code: -32602, message: '_meta.agentProfile JSON definitions are not supported; send a preset id string' })
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

  it('queues a second prompt behind the in-flight one (FIFO)', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)
    expect(agent).toBeDefined()

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    expect(agent!.internals.followups).toEqual(['first'])
    // The first prompt echoes before its response; consume it so the queued
    // prompt's echo order below is unambiguous.
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'first' } } },
    })

    // The second prompt must queue instead of hard-erroring while the first runs.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent!.internals.followups).toEqual(['first'])

    agent!.internals.idleWaiters.shift()!()
    // The first prompt's JSON-RPC response must reach the client before the
    // queued prompt starts streaming its echo; otherwise the TUI can append
    // the second user message to the still-running first turn.
    const isEcho = (msg: Record<string, unknown>, text: string): boolean => {
      const params = msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } } | undefined
      return params?.update?.sessionUpdate === 'user_message_chunk'
        && params.update.content?.type === 'text'
        && params.update.content.text === text
    }
    let sawSecondEcho = false
    for (;;) {
      const msg = await c.next()
      if (msg.id === 2) {
        expect(msg.result).toEqual({ stopReason: 'cancelled' })
        break
      }
      if (isEcho(msg, 'second')) sawSecondEcho = true
    }
    expect(sawSecondEcho).toBe(false)

    await waitFor(() => agent!.internals.followups.length === 2 && agent!.internals.idleWaiters.length === 1)
    let gotSecondEcho = false
    while (!gotSecondEcho) {
      const msg = await c.next()
      if (isEcho(msg, 'second')) gotSecondEcho = true
    }
    expect(agent!.internals.followups).toEqual(['first', 'second'])

    agent!.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toEqual({ stopReason: 'cancelled' })
  })

  it('cancel settles the in-flight and queued prompts as cancelled', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent!.internals.followups).toEqual(['one'])

    c.notify('session/cancel', { sessionId })
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toEqual({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toEqual({ stopReason: 'cancelled' })
    expect(agent!.internals.followups).toEqual(['one']) // the queued prompt never ran
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
      { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a' } },
      { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a' } },
      { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b' } },
    ])
    expect(modelState.currentModelId).toEqual('shared')

    const models = await c.request(1, 'x.ai/models/list', {})
    expect(models.result).toEqual({
      currentModelId: 'shared',
      availableModels: [
        { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a' } },
        { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a' } },
        { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b' } },
      ],
      _meta: {
        currentProviderId: 'a',
        providers: [{ id: 'a' }, { id: 'b' }],
      },
    })
  })

  it('advertises the preset command and serves the session prompt history', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()

    const initialize = await c.request(0, 'initialize', { protocolVersion: 1 })
    const meta = (initialize.result as {
      _meta: { cancelRewind: boolean; availableCommands: Array<{ name: string; description: string; input?: { hint: string } }> }
    })._meta
    expect(meta.cancelRewind).toBe(false)
    expect(meta.availableCommands).toEqual([
      { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | code | minimal | cordis' } },
    ])

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await c.next() // consume the echoed user_message_chunk before the next request

    const commands = await c.request(3, 'x.ai/commands/list', { sessionId })
    expect(commands.result).toEqual({
      commands: [
        { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | code | minimal | cordis' } },
      ],
    })

    const history = await c.request(4, 'x.ai/prompt_history', { cwd: process.cwd(), filter_session_id: sessionId })
    expect(history.result).toEqual({ prompts: ['hello'] })
  })
})


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
    return {
      listProviders: () => {
        const rows = [...providerRows]
        for (const id of Object.keys(settings.providers)) rows.push({ id, name: (settings.providers[id] as { displayName?: string }).displayName ?? id })
        return rows
      },
      listModels: async (provider: string) => provider === 'deepseek'
        ? [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
        : [{ provider, id: provider + '-model', name: provider + ' Model' }],
      discoverModels: async (_ns: string, request: { provider?: string; baseURL?: string }) => {
        if (request.baseURL === 'https://gateway.test/v1') {
          return [{ id: 'gw-model', name: 'GW Model', contextWindow: 8192 }]
        }
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

  const startWithSettings = async (settings: SettingsMock) => {
    const llm = makeLlm(settings)
    const made = await makeHarness({ llm, settings })
    harness = made
    client = await makeClient(made.socketPath)
    register(client)
    await client.next() // registered
    return { client, settings }
  }

  it('writes through ctx.settings.mutate and returns the refreshed roster', async () => {
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    const res = await client.request(1, 'x.ai/providers/add', {
      id: 'acme-gateway',
      displayName: 'Acme Gateway',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
    })
    expect(res.error).toBeUndefined()
    expect(res.result).toEqual({
      providers: [
        { id: 'deepseek', name: 'DeepSeek' },
        { id: 'acme-gateway', name: 'Acme Gateway' },
      ],
      currentProviderId: '',
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
})

/** Shared mock harness for the provider update/remove suites. */
interface ManageSettingsMock {
  calls: Array<{ ns: string; ops: Array<{ op: string; path: string[]; value: unknown }> }>
  providers: Record<string, unknown>
  mutate(ns: string, ops: Array<{ op: string; path: string[]; value: unknown }>): Promise<void>
  describe(): Array<{ ns: string; user?: unknown }>
}

const makeManageSettings = (): ManageSettingsMock => {
  const mock: ManageSettingsMock = {
    calls: [],
    providers: {},
    async mutate(ns, ops) {
      mock.calls.push({ ns, ops })
      for (const op of ops) {
        if (op.path.length !== 2) throw new Error('unexpected op')
        if (op.op === 'set') mock.providers[op.path[1]] = op.value
        else if (op.op === 'unset') delete mock.providers[op.path[1]]
        else throw new Error('unexpected op')
      }
    },
    describe: () => [{ ns: 'llm-pi-ai', user: { providers: mock.providers } }],
  }
  return mock
}

const manageLlm = (settings: ManageSettingsMock) => ({
  listProviders: () => {
    const rows = [{ id: 'deepseek', name: 'DeepSeek' }]
    for (const id of Object.keys(settings.providers)) rows.push({ id, name: (settings.providers[id] as { displayName?: string }).displayName ?? id })
    return rows
  },
  listModels: async (provider: string) => provider === 'deepseek'
    ? [{ provider: 'deepseek', id: 'deepseek-chat', name: 'DeepSeek Chat' }]
    : [{ provider, id: provider + '-model', name: provider + ' Model' }],
})

async function startManageHarness(settings: ManageSettingsMock, model?: string): Promise<{ client: ClientHandle; settings: ManageSettingsMock }> {
  const llm = manageLlm(settings)
  const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'], model })
  const client = await makeClient(made.socketPath)
  register(client)
  await client.next() // registered
  return { client, settings }
}

describe('x.ai/providers/update', () => {
  it('merges the form over the current profile, preserving models and unsetting emptied fields', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = {
      displayName: 'Acme',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
      models: [{ id: 'gw-model' }],
    }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', {
      providerId: 'acme-gateway',
      displayName: '',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-responses',
      baseURL: 'https://new.test/v1',
    })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ns).toBe('llm-pi-ai')
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        apiKeyEnv: 'ACME_KEY',
        api: 'openai-responses',
        baseURL: 'https://new.test/v1',
        models: [{ id: 'gw-model' }],
      },
    }])
    expect(res.result).toMatchObject({
      providers: [{ id: 'deepseek' }, { id: 'acme-gateway', api: 'openai-responses', baseURL: 'https://new.test/v1' }],
    })
  })

  it('refuses an unknown provider without writing settings', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'nope', api: 'openai-completions' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "nope" does not exist' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses an invalid api before touching settings', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'acme-gateway', api: 'grpc' })
    expect(res.error).toMatchObject({ code: -32602 })
    expect(settings.calls).toHaveLength(0)
  })
})

describe('x.ai/providers/remove', () => {
  it('unsets the route and returns the refreshed roster', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'acme-gateway' })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ops).toEqual([{ op: 'unset', path: ['providers', 'acme-gateway'] }])
    expect('acme-gateway' in settings.providers).toBe(false)
    expect(res.result).toEqual({ providers: [{ id: 'deepseek', name: 'DeepSeek' }], currentProviderId: 'deepseek' })
  })

  it('refuses the provider that owns the current model', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'deepseek' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "deepseek" is in use; switch to another provider first' })
    expect(settings.calls).toHaveLength(0)
  })

  it('refuses an unknown provider', async () => {
    const settings = makeManageSettings()
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/remove', { id: 'nope' })
    expect(res.error).toMatchObject({ code: -32602, message: 'provider "nope" does not exist' })
    expect(settings.calls).toHaveLength(0)
  })
})
