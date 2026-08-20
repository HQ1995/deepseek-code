/**
 * End-to-end leader tests over a real unix socket against a mocked agent
 * registry, pinned to tests/fixtures/grok-tui-messages.jsonl and the
 * docs/grok-leader-protocol.md contract.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import { SessionId, type SessionEvent, type UserMessage } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-session-persistence'
import { encodeJsonFrame, FrameDecoder } from '../src/codec.ts'
import * as GrokLeader from '../src/index.ts'

/** The package version the initialize response must advertise (drift guard). */
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version

interface MockAgentInternals {
  cancelCalls: number
  followups: string[]
  /** Texts submitted as mid-turn steering (follow-up steer). */
  steered: string[]
  messages: unknown[]
  disposed: boolean
  idleWaiters: Array<() => void>
  /** Mirrors the real agent: 'running' from followup admission until the
   *  test fires an idle waiter (manual-idle mode only). */
  status: 'idle' | 'running'
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
  const makeAgent = (sessionId: SessionId, cwd: string | undefined, agentPreset?: string): MockAgent => {
    const internals: MockAgentInternals = { cancelCalls: 0, followups: [], steered: [], messages: [], disposed: false, idleWaiters: [], status: 'idle' }
    const events: Array<{ type: string; data: unknown; seq: number; time: number }> = []
    const agent = {
      id: sessionId,
      options: {} as AgentOptions,
      session: {
        id: sessionId,
        header: { id: sessionId, version: 0, createdAt: 0, ...cwd === undefined ? {} : { cwd }, ...agentPreset === undefined ? {} : { agentPreset } },
        events,
        append(type: string, data: unknown) {
          const event = { type, data, seq: events.length, time: Date.now() }
          events.push(event)
          return event
        },
      },
      inbox: {},
      get status() { return internals.status },
      ctx,
      internals,
      cancel() { internals.cancelCalls += 1 },
      whenIdle() {
        if (!manualIdle) return Promise.resolve()
        // Firing a waiter models the real driver retirement: the agent
        // reports idle before any whenIdle continuation runs.
        return new Promise<void>((resolveIdle) => {
          internals.idleWaiters.push(() => { internals.status = 'idle'; resolveIdle() })
        })
      },
      runMaintenance(task: (signal: AbortSignal) => Promise<unknown>) { return task(new AbortController().signal) },
      send() {},
      followup(message: unknown) {
        if (manualIdle) internals.status = 'running'
        internals.messages.push(message)
        const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text !== undefined) internals.followups.push(block.text)
        }
      },
      steer(message: unknown) {
        const content = (message as { content?: Array<{ type?: string; text?: string }> }).content ?? []
        for (const block of content) {
          if (block.type === 'text' && block.text !== undefined) internals.steered.push(block.text)
        }
      },
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
      const agent = makeAgent(o.sessionId, o.meta?.cwd, o.meta?.agentPreset)
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
  const events: SessionEvent[] = []
  return {
    header,
    loaded,
    events,
    list: async () => [header],
    load: async (id: SessionId) => { loaded.push(id); return { meta: header, events } },
  }
}

function makeMockPresets() {
  const resolved: Array<string | undefined> = []
  const mounted: string[] = []
  const recomposed: string[] = []
  return {
    resolved,
    mounted,
    recomposed,
    list: async () => [
      { id: 'standard', trust: 'system', name: '标准模式', description: 'standard desc' },
      { id: 'code', trust: 'system', name: 'PTC 模式', description: 'code desc' },
      { id: 'minimal', trust: 'system', name: '极简模式', description: 'minimal desc' },
      { id: 'cordis', trust: 'system', name: '创造模式', description: 'cordis desc' },
    ],
    resolve: async (id?: string) => {
      resolved.push(id)
      const chosen = id ?? 'minimal'
      if (chosen === 'standard' || chosen === 'code' || chosen === 'minimal' || chosen === 'cordis') return { id: chosen }
      throw new Error('agent-presets: preset "' + chosen + '" not found (available: standard, cordis, minimal, code)')
    },
    mount: async (_agentCtx: unknown, id?: string) => {
      mounted.push(id ?? 'minimal')
      return { id: id ?? 'minimal' }
    },
    recompose: async (_agentCtx: unknown, id: string) => {
      recomposed.push(id)
      return { id }
    },
  }
}

const mockAppExit = {
  calls: [] as number[],
  exit: (code: number): void => { mockAppExit.calls.push(code) },
}

const mockDefaultModel = {
  saved: [] as Array<{ provider: string; model: string; reasoningEffort?: string }>,
  current: undefined as { provider: string; model: string; reasoningEffort?: string } | undefined,
  currentSelection: () => mockDefaultModel.current,
  saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
    mockDefaultModel.saved.push(next)
    mockDefaultModel.current = next
  },
}

const mockSessionsStore = {
  flushed: [] as unknown[],
  flush: async (session: object) => { mockSessionsStore.flushed.push(session); return true },
}

interface LeaderHarness {
  ctx: Context
  pluginCtx: Context
  socketPath: string
  registry: MockRegistry
  persistence: ReturnType<typeof makeMockPersistence>
  presets: ReturnType<typeof makeMockPresets> | undefined
}

interface HarnessOptions {
  presets?: boolean
  manualIdle?: boolean
  llm?: unknown
  model?: string
  settings?: unknown
  commands?: unknown
  userQuestions?: unknown
  credentials?: unknown
  permissionPresets?: unknown
  planMode?: unknown
  sessionsStore?: unknown
  tools?: unknown
  skills?: unknown
  subagents?: unknown
  sessionTitle?: unknown
  combineQueuedPrompts?: boolean
  followUpBehavior?: 'queue' | 'steer'
  idleExitMs?: number
}

interface ClientHandle {
  socket: Socket
  next(): Promise<Record<string, unknown>>
  /** x.ai/queue/changed broadcasts, captured instead of queueing. */
  broadcasts: Array<Record<string, unknown>>
  /** Every parsed message in arrival order, for order-sensitive assertions. */
  all: Array<Record<string, unknown>>
  /** x.ai/session/prompt_complete terminal signals, captured like broadcasts. */
  completes: Array<Record<string, unknown>>
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
  const completes: Array<Record<string, unknown>> = []
  const all: Array<Record<string, unknown>> = []
  const waiters: Array<(value: Record<string, unknown>) => void> = []
  socket.on('data', (chunk) => {
    for (const frame of decoder.push(chunk)) {
      const raw = JSON.parse(new TextDecoder().decode(frame)) as Record<string, unknown>
      // Unwrap acp envelopes: the inner JSON-RPC object carries the request id.
      const msg = raw.type === 'acp' && typeof raw.payload === 'string'
        ? JSON.parse(raw.payload) as Record<string, unknown>
        : raw
      // Mirror the pager's agent-client-protocol decode: extension methods
      // ride the wire with a '_' prefix that is stripped before dispatch.
      if (typeof msg.method === 'string' && msg.method.startsWith('_')) {
        msg.method = msg.method.slice(1)
      }
      all.push(msg)
      // Ambient queue broadcasts and terminal signals interleave with every
      // response; capture them so order-sensitive assertions stay exact.
      if (msg.method === 'x.ai/queue/changed') { broadcasts.push(msg); continue }
      if (msg.method === 'x.ai/session/prompt_complete') { completes.push(msg); continue }
      // Ambient model-catalog refreshes (after session/set_model) are not
      // request/response traffic; keep them out of the next() queue.
      if (msg.method === 'x.ai/models/update') continue
      // Ambient command-roster refreshes (fired on session create/load and on
      // registry changes) stay out of the request/next() queue; assertions
      // read them from `all`.
      if (msg.method === 'session/update'
        && (msg.params as { update?: { sessionUpdate?: string } } | undefined)?.update?.sessionUpdate === 'available_commands_update') {
        continue
      }
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
    completes,
    all,
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
  options: HarnessOptions = {},
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
  if (options.commands !== undefined) ctx.provide('commands', options.commands as never)
  if (options.userQuestions !== undefined) ctx.provide('userQuestions', options.userQuestions as never)
  if (options.credentials !== undefined) ctx.provide('credentials', options.credentials as never)
  if (options.permissionPresets !== undefined) ctx.provide('permissionPresets', options.permissionPresets as never)
  if (options.planMode !== undefined) ctx.provide('planMode', options.planMode as never)
  if (options.tools !== undefined) ctx.provide('tools', options.tools as never)
  if (options.skills !== undefined) ctx.provide('skills', options.skills as never)
  if (options.subagents !== undefined) ctx.provide('subagents', options.subagents as never)
  if (options.sessionTitle !== undefined) ctx.provide('sessionTitle', options.sessionTitle as never)
  ctx.provide('sessionPersistence', persistence as unknown as Context['sessionPersistence'])
  ctx.provide('sessions', (options.sessionsStore ?? mockSessionsStore) as unknown as Context['sessions'])
  if (presets !== undefined) ctx.provide('agentPresets', presets as unknown as Context['agentPresets'])
  ctx.provide('agentDefaultModel', mockDefaultModel as unknown as Context['agentDefaultModel'])
  ctx.provide('appExit', mockAppExit.exit)
  const socketPath = resolve('/tmp', 'dgl-' + String(process.pid) + '-' + randomUUID().slice(0, 12) + '.sock')
  let pluginCtx: Context | undefined
  await ctx.plugin({
    name: 'grok-leader-test',
    inject: [...GrokLeader.inject],
    apply: (inner: Context) => {
      pluginCtx = inner
      GrokLeader.apply(inner, { socketPath, ...options.model === undefined ? {} : { model: options.model }, ...options.combineQueuedPrompts === undefined ? {} : { combineQueuedPrompts: options.combineQueuedPrompts }, ...options.followUpBehavior === undefined ? {} : { followUpBehavior: options.followUpBehavior }, ...options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs } })
    },
  })
  return { ctx, pluginCtx: pluginCtx!, socketPath, registry, persistence, presets }
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
    mockDefaultModel.current = undefined
  })

  const start = async (
    options: HarnessOptions = {},
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
        modelState: {
          currentModelId: 'deepseek-chat',
          availableModels: [
            { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
            { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
            { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
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

  it('advertises the package.json version in agentInfo', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const initialize = await c.request(0, 'initialize', { protocolVersion: 1, clientCapabilities: {} })
    // Drift guard: the hardcoded agentInfo.version must track package.json.
    expect((initialize.result as { agentInfo: { name: string; version: string } }).agentInfo).toEqual({
      name: 'deepseek-harness-grok-leader',
      version: packageVersion,
    })
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

  it('rejects an explicit provider/model pair owned by different routes', async () => {
    const { registry, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { provider: 'pi', model: 'deepseek-chat' },
    })
    expect(created.error).toEqual({
      code: -32602,
      message: 'requested provider/model is not in the catalog: pi/deepseek-chat',
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
    expect(promptResult.result).toMatchObject({ stopReason: 'cancelled' })
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
      currentModelId: 'deepseek-chat',
      availableModels: [
        { modelId: 'deepseek-chat', name: 'DeepSeek Chat', _meta: { provider: 'deepseek', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
        { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', _meta: { provider: 'deepseek', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'pi-code', name: 'Pi Code', _meta: { provider: 'pi', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      ],
      _meta: {
        currentProviderId: 'deepseek',
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

    expect(c.broadcasts.length).toBeGreaterThanOrEqual(2)
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
    expect(c.completes.some(m => (m.params as { stopReason?: string }).stopReason === 'cancelled')).toBe(true)
  })

  it('queues a second prompt and reports it in x.ai/queue/changed until promotion', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
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
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.length === 2)
    const secondId = hp.entries![0]!.id
    await waitFor(() => c.broadcasts.some(b => {
      const params = b.params as { entries?: unknown[]; runningPromptId?: string; runningText?: string }
      return params.entries?.length === 0 && params.runningPromptId === secondId
    }))
    // The promotion broadcast must precede the promoted prompt's echo: the
    // pager routes user_message_chunk by runningPromptId.
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 0 && (m.params as { runningPromptId?: string }).runningPromptId === secondId)
    const echoIndex = c.all.findIndex(m => m.method === 'session/update' && ((m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text) === 'second')
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
  })

  it('settle emits prompt_complete, the promotion broadcast + echo, and the response LAST (grok wire order)', async () => {
    // Auto idle: the promotion microtask beats the RPC response write, pinning
    // the live/grok order — the TUI's stashed-adoption rail depends on it.
    const { client: c } = await start({ followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    // One write, one data event: both prompts enter the leader in the same
    // synchronous frame loop, so 'second' queues while 'first' is in flight
    // (split writes let 'first' settle before 'second' arrives).
    const promptFrame = (id: number, text: string): Uint8Array => encodeJsonFrame({
      type: 'acp',
      payload: JSON.stringify({ jsonrpc: '2.0', id, method: 'session/prompt', params: { sessionId, prompt: [{ type: 'text', text }] } }),
    })
    c.socket.write(Buffer.concat([promptFrame(2, 'first'), promptFrame(3, 'second')]))
    await waitForId(c, 2)
    await waitForId(c, 3)

    const idx = (predicate: (m: Record<string, unknown>) => boolean): number => {
      const i = c.all.findIndex(predicate)
      expect(i).toBeGreaterThanOrEqual(0)
      return i
    }
    const completeOf = (promptId: string): number => idx(m => m.method === 'x.ai/session/prompt_complete' && (m.params as { promptId?: string }).promptId === promptId)
    const responseOf = (id: number): number => idx(m => m.id === id && m.method === undefined)
    const promotionOf = (text: string): number => idx(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 0 && (m.params as { runningText?: string }).runningText === text)
    const echoOf = (text: string): number => idx(m => m.method === 'session/update' && (m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text === text)

    const firstId = (c.all.find(m => m.method === 'x.ai/queue/changed' && (m.params as { runningText?: string }).runningText === 'first')!.params as { runningPromptId: string }).runningPromptId
    const secondId = (c.all.find(m => m.method === 'x.ai/queue/changed' && (m.params as { entries?: unknown[] }).entries?.length === 1)!.params as { entries: Array<{ id: string }> }).entries[0]!.id

    const complete1 = completeOf(firstId)
    const response1 = responseOf(2)
    const promotion = promotionOf('second')
    const echo = echoOf('second')
    expect(complete1).toBeLessThan(response1)
    // The promotion broadcast adopts the next turn before its echo streams.
    expect(promotion).toBeLessThan(echo)
    // ...and the whole promotion rides out BEFORE the settling prompt's
    // JSON-RPC response (the response is last, as the TUI expects).
    expect(echo).toBeLessThan(response1)
    expect(complete1).toBeLessThan(promotion)
    // The promoted row ran its own turn (a terminal exists for its id).
    const complete2 = completeOf(secondId)
    expect(complete2).toBeGreaterThanOrEqual(0)
  })

  it('interject cancels the running turn (send-now) and promotes the row next', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await waitFor(() => c.broadcasts.some(b => ((b.params as { runningText?: string }).runningText) === 'first'))
    const firstId = (c.broadcasts.find(b => ((b.params as { runningText?: string }).runningText) === 'first')!.params as { runningPromptId: string }).runningPromptId
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const secondId = ((held.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/interject', { sessionId, id: secondId, expectedVersion: 0 })

    // The first turn settles cancelled with the send_now trigger...
    await waitFor(() => c.completes.some(m => (m.params as { cancelTrigger?: string }).cancelTrigger === 'send_now'))
    const complete = c.completes[c.completes.length - 1]!
    expect(complete.params).toMatchObject({ sessionId, promptId: firstId, stopReason: 'cancelled', cancelTrigger: 'send_now' })
    expect(agent.internals.cancelCalls).toBeGreaterThanOrEqual(1)
    for (;;) {
      const msg = await c.next()
      if (msg.id === 2) { expect(msg.result).toMatchObject({ stopReason: 'cancelled' }); break }
    }

    // ...and the interjected row runs next as its own turn (after the agent idles).
    await waitFor(() => agent.internals.idleWaiters.length >= 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length >= 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second') && c.broadcasts.some(b => (b.params as { runningPromptId?: string }).runningPromptId === secondId))
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { runningPromptId?: string }).runningPromptId === secondId)
    const echoIndex = c.all.findIndex(m => m.method === 'session/update' && ((m.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } } }).update?.content?.text) === 'second')
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
  })

  it('queue/steer merges a queued row into the running turn without cancelling it', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await waitFor(() => c.broadcasts.some(b => ((b.params as { runningText?: string }).runningText) === 'first'))
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const held = c.broadcasts[c.broadcasts.length - 1]!
    const secondId = ((held.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/steer', { sessionId, id: secondId, expectedVersion: 0 })

    // The queued row is folded into the live turn, not promoted/cancelled.
    await waitFor(() => agent.internals.steered.includes('second'))
    expect(agent.internals.cancelCalls).toBe(0)
    await waitFor(() => {
      const last = c.broadcasts[c.broadcasts.length - 1]!.params as {
        entries?: Array<{ id: string }>
        runningPromptId?: string
      }
      return last.entries?.length === 0 && last.runningPromptId !== undefined
    })

    // The host turn keeps running and settles normally; the steered prompt
    // settles with the host turn's stop reason.
    agent.internals.idleWaiters.shift()!()
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({
      stopReason: 'cancelled',
      _meta: { promptId: secondId },
    })
  })

  it('queue/edit replaces the row text, bumps its version, and rebroadcasts', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const queued = c.broadcasts.find(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1)!
    const row = ((queued.params as { entries: Array<{ id: string; text: string; version: number }> }).entries[0]!)
    expect(row).toMatchObject({ text: 'second', version: 0 })

    const before = c.broadcasts.length
    c.notify('x.ai/queue/edit', { sessionId, id: row.id, newText: 'edited second' })
    await waitFor(() => c.broadcasts.length > before)
    const edited = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string; text: string; version: number }> }).entries[0]!
    expect(edited).toMatchObject({ id: row.id, text: 'edited second', version: 1 })

    // The edited text is what the row runs once it promotes. One promotion
    // wait exists (scheduled at enqueue; the edit and settle dedup into it).
    agent.internals.idleWaiters.shift()!() // settle the running first
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!() // the pending promotion: runs the edited row
    await waitFor(() => agent.internals.followups.includes('edited second'))
    agent.internals.idleWaiters.shift()!() // settle the promoted row
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('queue/hold_edit parks the front and queue/release_edit promotes it', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const secondId = ((c.broadcasts[c.broadcasts.length - 1]!.params as { entries: Array<{ id: string }> }).entries[0]!).id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Releasing the hold unblocks the parked row. Either order works: if the
    // pending enqueue-time promotion fires before the release lands, it parks
    // on the held front and the release then promotes synchronously on the
    // idle agent; if the release lands first, its promotion request dedups
    // into the pending wait.
    c.notify('x.ai/queue/release_edit', { sessionId, id: secondId })
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!() // settle the promoted second
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('queue/remove of a held front promotes the next queued row', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))
    const entries = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string }> }).entries
    const secondId = entries[0]!.id
    const thirdId = entries[1]!.id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Removing the held front unblocks the next row instead of stranding it.
    c.notify('x.ai/queue/remove', { sessionId, id: secondId, expectedVersion: 0 })
    // The removed row's RPC resolves as cancelled; its response proves the
    // remove landed before the pending promotion wait is fired.
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    agent.internals.idleWaiters.shift()!() // the pending promotion: promotes the new front
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'third'])
    agent.internals.idleWaiters.shift()!() // settle the promoted third
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(thirdId).toEqual(expect.any(String) as string)
  })

  it('queue/reorder of a held front away from the lead promotes the new front', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))
    const entries = ((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries: Array<{ id: string }> }).entries
    const secondId = entries[0]!.id
    const thirdId = entries[1]!.id

    c.notify('x.ai/queue/hold_edit', { sessionId, id: secondId })

    // The running turn settles, but the held front must not promote.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Moving the held row out of the lead lets the new front run; the held
    // second stays queued behind it. The reorder's promotion request dedups
    // into the promotion wait scheduled at enqueue time; firing that wait
    // promotes the reordered new front.
    c.notify('x.ai/queue/reorder', { sessionId, orderedIds: [thirdId, secondId] })
    await waitFor(() => c.broadcasts.some(b => {
      const params = b.params as { entries?: Array<{ id: string }> }
      return params.entries?.map(entry => entry.id).join(',') === `${thirdId},${secondId}`
    }))
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'third'])
    const reorderBroadcast = () => c.broadcasts.find(b => {
      const params = b.params as { entries?: Array<{ id: string }>; runningPromptId?: string }
      return params.runningPromptId === thirdId && params.entries?.map(entry => entry.id).join(',') === secondId
    })
    await waitFor(() => reorderBroadcast() !== undefined)
    const afterReorder = (reorderBroadcast()!.params as { entries?: Array<{ id: string }> }).entries
    expect(afterReorder?.map(entry => entry.id)).toEqual([secondId])

    agent.internals.idleWaiters.shift()!() // settle the promoted third
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(secondId).toEqual(expect.any(String) as string)
  })

  it('a stale expectedVersion on edit/remove/interject is a no-op that resyncs', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    const id = ((c.broadcasts[c.broadcasts.length - 1]!.params as { entries: Array<{ id: string }> }).entries[0]!).id
    const latestRow = (): { text: string; version: number } | undefined => {
      const params = c.broadcasts[c.broadcasts.length - 1]!.params as { entries?: Array<{ id: string; text: string; version: number }> }
      return params.entries?.find(entry => entry.id === id)
    }

    // Stale edit: text/version untouched, still rebroadcast for the resync.
    const beforeEdit = c.broadcasts.length
    c.notify('x.ai/queue/edit', { sessionId, id, newText: 'changed', expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeEdit)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })

    // Stale remove: the row stays queued.
    const beforeRemove = c.broadcasts.length
    c.notify('x.ai/queue/remove', { sessionId, id, expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeRemove)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })

    // Stale interject: the row stays and the running turn is not cancelled.
    const beforeInterject = c.broadcasts.length
    c.notify('x.ai/queue/interject', { sessionId, id, expectedVersion: 1 })
    await waitFor(() => c.broadcasts.length > beforeInterject)
    expect(latestRow()).toMatchObject({ text: 'second', version: 0 })
    expect(agent.internals.cancelCalls).toBe(0)
  })

  it('combines 2+ queued plain prompts into one turn when enabled', async () => {
    const { registry, client: c } = await start({ manualIdle: true, combineQueuedPrompts: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 2))

    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    // Followers fold into the front: the front RUNS the combined turn (its
    // response settles with the turn); the follower resolves as removed now.
    await waitFor(() => agent.internals.followups.includes('second\n\nthird'))
    expect(agent.internals.followups).toEqual(['first', 'second\n\nthird'])
    agent.internals.idleWaiters.shift()!()
    const settled = new Set<unknown>()
    for (;;) {
      const msg = await c.next()
      if (msg.id === 3 || msg.id === 4) {
        expect(msg.result).toMatchObject({ stopReason: 'cancelled' })
        settled.add(msg.id)
        if (settled.size === 2) break
      }
    }
    const promo = c.broadcasts.find(b => (b.params as { runningText?: string }).runningText === 'second')
    expect(promo).toBeDefined()
    expect((promo!.params as { runningCombinedTexts?: string[] }).runningCombinedTexts).toEqual(['second', 'third'])
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

  it('session/new rejects any non-empty or non-array mcpServers value', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    // Objects, strings, and any other non-array type reject outright instead
    // of being silently ignored; non-empty arrays keep their own error.
    expect((await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: { name: 'fs' } })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: 'fs' })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: 7 })).error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    expect((await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [{}] })).error).toEqual({ code: -32602, message: 'mcpServers is not supported' })
  })

  it('session/load validates cwd and mcpServers like session/new', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const badCwd = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: 'relative', mcpServers: [] })
    expect(badCwd.error).toEqual({ code: -32602, message: 'cwd must be an absolute path: relative' })
    const badMcp = await c.request(2, 'session/load', { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: { name: 'fs' } })
    expect(badMcp.error).toEqual({ code: -32602, message: 'mcpServers must be an array' })
    const loaded = await c.request(3, 'session/load', { sessionId: 'persisted-session', cwd: process.cwd(), mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(loaded.result).toEqual({})
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
    expect(advertised?._meta).toEqual({ provider: 'ocx', supportsReasoningEffort: false })

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    mockDefaultModel.saved.length = 0
    const invalid = await c.request(2, 'session/set_model', {
      sessionId,
      modelId: 'deepseek-v4-flash',
      _meta: { reasoningEffort: 'max' },
    })
    expect(invalid.error).toEqual({
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

  it('reports the saved reasoning effort on the current model in models/list', async () => {
    const { client: c } = await start()
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
    const agent = harness?.registry.byId.get(sessionId) as unknown as { session: { events: Array<{ type: string; data: unknown }> } }
    expect(agent.session.events.at(-1)).toMatchObject({
      type: 'dscode/model-selected',
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
    expect(bad.error).toEqual({ code: -32602, message: 'modelId is not in the catalog: no-such-model' })
    // The unresolvable selection was never persisted as the default.
    expect(mockDefaultModel.saved).toEqual([])
  })

  it('rejects a session/new that pins an already-live session id', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { sessionId: 'pinned-session' } })
    expect(created.result).toEqual({ sessionId: 'pinned-session' })
    const dup = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { sessionId: 'pinned-session' } })
    expect(dup.error).toMatchObject({ code: -32602 })
    // The first session still works: its record was not replaced.
    const prompted = await c.request(3, 'session/prompt', { sessionId: 'pinned-session', prompt: [{ type: 'text', text: 'still here' }] })
    expect(prompted.result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('rejects a session/new id already present in durable persistence', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const duplicate = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { sessionId: 'persisted-session' },
    })
    expect(duplicate.error).toEqual({
      code: -32602,
      message: 'session id is already in use: persisted-session',
    })
  })

  it('a second client cannot touch the first client sessions', async () => {
    const { registry, client: c, socketPath } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    const other = await makeClient(socketPath)
    register(other)
    await other.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const denied = { code: -32602, message: 'unknown session: ' + sessionId }

    // Every session-scoped request reads as unknown to the foreign client.
    expect((await other.request(10, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'steal' }] })).error).toEqual(denied)
    expect((await other.request(11, 'session/set_model', { sessionId, modelId: 'pi-code' })).error).toEqual(denied)
    expect((await other.request(12, 'x.ai/prompt_history', { filter_session_id: sessionId })).error).toEqual(denied)
    expect((await other.request(13, 'x.ai/session/info', { sessionId })).error).toEqual(denied)
    expect((await other.request(14, 'session/close', { sessionId })).error).toEqual(denied)

    // Foreign notifications must not reach the owned session either.
    const agent = registry.byId.get(sessionId)!
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    other.notify('session/cancel', { sessionId })
    other.notify('x.ai/queue/clear', { sessionId })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.cancelCalls).toBe(0)
    expect(((c.broadcasts[c.broadcasts.length - 1]!.params) as { entries?: unknown[] }).entries).toHaveLength(1)

    // The owner's flow is untouched: the parked prompt settles and the queued
    // row still runs (a foreign queue/clear would have removed it).
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent.internals.followups).toEqual(['first', 'second'])
    expect(agent.internals.cancelCalls).toBe(0)
    expect(registry.byId.has(sessionId)).toBe(true)
    other.socket.destroy()
  })

  it('a second live client cannot load the first client live session', async () => {
    const { registry, client: c, socketPath } = await start()
    register(c)
    await c.next()
    const other = await makeClient(socketPath)
    register(other)
    await other.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // A live foreign owner is never displaced; the id reads as unknown so the
    // session's existence does not leak.
    const stolen = await other.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(stolen.error).toEqual({ code: -32602, message: 'unknown session: ' + sessionId })
    expect(agent.internals.disposed).toBe(false)
    expect(registry.byId.get(sessionId)).toBe(agent)
    expect(mockSessionsStore.flushed).not.toContain(agent.session)
    other.socket.destroy()
  })

  it('a reconnecting client re-loads its session after the first socket is gone', async () => {
    const { registry, client: c, socketPath } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const first = registry.byId.get(sessionId)!

    // TUI reconnect: the first socket dies and the respawned client registers
    // under a NEW clientId before re-loading its session.
    c.socket.destroy()
    await waitFor(() => first.internals.disposed === true)
    const again = await makeClient(socketPath)
    register(again)
    await again.next()
    const loaded = await again.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    expect(loaded.result).toEqual({})
    expect(registry.resumed.map(entry => entry.sessionId)).toContain(sessionId)
    again.socket.destroy()
  })

  it('session/load rejects the old owner pending permission before the reload', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))

    // waitForId, not request: the pending permission reverse request (its own
    // JSON-RPC id) interleaves with the load response.
    sendRequest(c, 2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [] })
    const loaded = await waitForId(c, 2)
    expect(loaded.error).toBeUndefined()
    // The old owner's outstanding permission roundtrip is rejected by the reload.
    await expect(decision).resolves.toBe('rejected')
  })

  it('keeps yolo approval active when a session is resumed', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { yoloMode: true },
    })
    expect(loaded.error).toBeUndefined()
    const agent = registry.byId.get('persisted-session')!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-yolo', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await expect(decision).resolves.toBe('allowed-once')
    expect(c.all.some(msg => msg.method === 'session/request_permission')).toBe(false)
  })

  it('lets bypassPermissions override the pager\'s explicit yoloMode false', async () => {
    const permissionPresets: string[] = []
    const { registry, pluginCtx, client: c } = await start({
      permissionPresets: { set: (_session: unknown, preset: string) => { permissionPresets.push(preset) } },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { permissionMode: 'bypassPermissions', yoloMode: false },
    })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-bypass', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await expect(decision).resolves.toBe('allowed-once')
    expect(c.all.some(msg => msg.method === 'session/request_permission')).toBe(false)
    expect(permissionPresets.at(-1)).toBe('danger-full-access')
  })

  it('applies plan permission mode without inheriting an explicit yolo bit', async () => {
    const planCalls: Array<{ agent: unknown; active: boolean }> = []
    const permissionPresets: string[] = []
    const { registry, pluginCtx, client: c } = await start({
      planMode: { set: (agent: unknown, active: boolean) => { planCalls.push({ agent, active }) } },
      permissionPresets: { set: (_session: unknown, preset: string) => { permissionPresets.push(preset) } },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { permissionMode: 'plan', yoloMode: true },
    })
    expect(created.error).toBeUndefined()
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    expect(planCalls).toEqual([{ agent, active: true }])
    expect(permissionPresets.at(-1)).toBe('workspace-write')
    c.notify('x.ai/yolo_mode_changed', {
      sessionId,
      permission_mode: 'default',
      yolo_mode: false,
    })
    await waitFor(() => planCalls.length === 2)
    expect(planCalls).toEqual([{ agent, active: true }, { agent, active: false }])
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-plan', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('rejected')
  })

  it('chmods the socket 0600 once listening', async () => {
    const made = await makeHarness()
    try {
      await waitFor(() => (statSync(made.socketPath).mode & 0o777) === 0o600)
    } finally {
      await made.ctx.fiber.dispose()
    }
  })

  it('rejects a prompt only when agent/error names its in-flight turn', async () => {
    const { registry, pluginCtx, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    pluginCtx.emit('agent/inbox/claimed', {
      agent,
      message: agent.internals.messages[0] as UserMessage,
      turn: 1,
    })
    // An error for a different turn is ignored...
    pluginCtx.emit('agent/error', { agent, turn: 2, step: 0, error: new Error('other turn') })
    // ...and the in-flight turn's own error rejects the prompt.
    pluginCtx.emit('agent/error', { agent, turn: 1, step: 0, error: new Error('boom') })
    expect((await waitForId(c, 2)).error).toEqual({ code: -32603, message: 'turn failed: boom' })

    // The rejected turn left the session clean: the next prompt still runs.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    await waitFor(() => agent.internals.idleWaiters.length >= 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('two'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
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
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['minimal'])
    expect(registry.byId.get('persisted-session')?.session.events.at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
  })

  it('switches a live blank session without requiring a persistence load first', async () => {
    const { registry, persistence, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'code' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const live = registry.byId.get(sessionId)!
    const loaded = await c.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(persistence.loaded).not.toContain(sessionId)
    expect(presets?.recomposed).toEqual(['minimal'])
    expect(mockSessionsStore.flushed).toContain(live.session)
    expect(live.session.events.at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
    expect(registry.resumed.map(entry => entry.sessionId)).toContain(sessionId)
  })

  it('keeps the live session owned when its reload flush fails', async () => {
    const sessionsStore = { flush: async () => { throw new Error('flush failed') } }
    const { registry, client: c } = await start({ presets: true, sessionsStore })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'code' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const live = registry.byId.get(sessionId)!
    const loaded = await c.request(2, 'session/load', { sessionId, cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toMatchObject({ code: -32603 })
    expect(registry.byId.get(sessionId)).toBe(live)
    expect(live.internals.disposed).toBe(false)
  })

  it('refuses to switch a persisted preset after the session has history', async () => {
    const { registry, persistence, presets, client: c } = await start({ presets: true })
    persistence.events.push({
      type: 'user/message',
      seq: 0,
      time: 0,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'already ran' }] },
    } as SessionEvent)
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toEqual({
      code: -32602,
      message: 'agent-preset-locked: a preset can only be changed before the session has produced history',
    })
    expect(registry.resumed).toEqual([])
    expect(presets?.mounted).toEqual([])
  })

  it('does not lock a blank preset switch on log-only session events', async () => {
    const { persistence, presets, client: c } = await start({ presets: true })
    persistence.events.push({
      type: 'request/header',
      seq: 0,
      time: 0,
      data: {},
    } as SessionEvent)
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [], _meta: { agentProfile: 'minimal' } })
    expect(loaded.error).toBeUndefined()
    expect(presets?.mounted).toEqual(['minimal'])
  })

  it('executes the advertised raw /preset command only while the session is blank', async () => {
    const { registry, presets, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'code' } })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/preset minimal' }] })
    expect(switched.error).toBeUndefined()
    expect(switched.result).toMatchObject({ stopReason: 'end_turn' })
    expect(presets?.recomposed).toEqual(['minimal'])
    expect(registry.byId.get(sessionId)?.session.events.at(-1)).toMatchObject({
      type: 'agent-preset/selected',
      data: { agentPreset: 'minimal' },
    })
    expect(registry.byId.get(sessionId)?.internals.followups).toEqual([])
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
    expect(registry.created).toEqual([{ sessionId, cwd: process.cwd(), agentPreset: 'minimal' }])
    expect(presets?.mounted).toEqual(['minimal'])
  })

  it('does not advertise subagents when the selected preset exposes no delegation tool', async () => {
    const { client: c } = await start({
      presets: true,
      subagents: { list: () => ['spawn'] },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'standard' },
    })
    expect(created.error).toBeUndefined()
    await waitFor(() => c.all.some(message => {
      const update = (message.params as { update?: { sessionUpdate?: string; meta?: { capabilities?: string[] } } } | undefined)?.update
      return update?.sessionUpdate === 'available_commands_update'
        && update.meta?.capabilities?.includes('subagents') === false
    }))
  })

  it('advertises plugin-added delegation from the actual tool surface, independent of preset id', async () => {
    const { client: c } = await start({
      presets: true,
      tools: { schemas: () => [{ name: 'subagent' }] },
      subagents: { list: () => ['spawn'] },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'minimal' },
    })
    expect(created.error).toBeUndefined()
    await waitFor(() => c.all.some(message => {
      const update = (message.params as { update?: { sessionUpdate?: string; meta?: { capabilities?: string[] } } } | undefined)?.update
      return update?.sessionUpdate === 'available_commands_update'
        && update.meta?.capabilities?.includes('subagents') === true
    }))
  })

  it('falls back to the default preset for grok built-ins and rejects JSON-object agent selections', async () => {
    const { client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const unknown = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'grok-build-plan' } })
    expect(unknown.error).toBeUndefined()
    const objectProfile = await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: { name: 'custom' } } })
    expect(objectProfile.error).toEqual({ code: -32602, message: '_meta.agentProfile JSON definitions are not supported; send a preset id string' })
    const typo = await c.request(3, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'stanard' } })
    expect(typo.error).toMatchObject({ code: -32602 })
    const noSubagents = await c.request(4, 'session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentProfile: 'grok-build-plan-no-subagents' } })
    expect(noSubagents.error).toEqual({
      code: -32602,
      message: '--no-subagents is not supported by this dscode bridge; choose a preset without subagents instead',
    })
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

  it('drives the auxiliary dscode rails end to end for one owned session', async () => {
    const planStates: boolean[] = []
    const renamed: string[] = []
    let titleRefreshes = 0
    let subagentDisposed = false
    const { registry, client: c } = await start({
      presets: true,
      planMode: { set: (_agent: unknown, active: boolean) => { planStates.push(active) } },
      sessionTitle: {
        rename: (_session: unknown, title: string) => { renamed.push(title) },
        refresh: async () => { titleRefreshes += 1 },
      },
      tools: {
        schemas: () => [
          { name: 'mcp__github__search' },
          { name: 'mcp__github__issues' },
          { name: 'mcp__filesystem__read' },
          { name: 'bash' },
          { name: 'subagent' },
        ],
      },
      skills: {
        list: async () => [{
          name: 'review-code',
          description: 'Review a change',
          whenToUse: 'When code needs review',
          path: '/skills/review-code',
          invocation: { userInvocable: true, modelInvocable: true },
        }],
      },
      subagents: {
        list: () => ['spawn'],
        start: async (provider: string, request: { prompt: Array<{ text: string }> }) => {
          expect(provider).toBe('spawn')
          expect(request.prompt).toEqual([{ type: 'text', text: 'check this independently' }])
          return {
            result: Promise.resolve({ output: [{ type: 'text', text: 'independent answer' }], stopReason: 'end_turn' }),
            dispose: async () => { subagentDisposed = true },
          }
        },
      },
    })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', {
      cwd: process.cwd(),
      mcpServers: [],
      _meta: { agentProfile: 'standard' },
    })
    const sessionId = (created.result as { sessionId: string }).sessionId

    expect((await c.request(2, 'session/set_mode', { sessionId, modeId: 'plan' })).result).toEqual({})
    expect((await c.request(3, 'session/set_mode', { sessionId, modeId: 'default' })).result).toEqual({})
    expect(planStates).toEqual([true, false])

    expect((await c.request(4, 'x.ai/session/rename', { sessionId, title: 'Reviewed session' })).result).toEqual({})
    expect((await c.request(5, 'x.ai/session/rename', { sessionId, resetToAuto: true })).result).toEqual({})
    expect(renamed).toEqual(['Reviewed session'])
    expect(titleRefreshes).toBe(1)

    const skills = await c.request(6, 'x.ai/skills/list', { sessionId })
    expect(skills.result).toEqual({
      skills: [{
        name: 'review-code',
        display_name: 'review-code',
        description: 'Review a change',
        has_user_specified_description: false,
        when_to_use: 'When code needs review',
        short_description: 'Review a change',
        path: '/skills/review-code',
        scope: 'plugin',
        user_invocable: true,
        enabled: true,
      }],
    })
    const mcp = await c.request(7, 'x.ai/mcp/list', { sessionId })
    expect(mcp.result).toMatchObject({
      servers: [
        { name: 'github', _meta: { toolCount: 2 }, session: { status: 'connected' } },
        { name: 'filesystem', _meta: { toolCount: 1 }, session: { status: 'connected' } },
      ],
    })

    const btw = await c.request(8, 'x.ai/btw', { sessionId, question: 'check this independently' })
    expect(btw.result).toEqual({ result: { answer: 'independent answer' } })
    expect(subagentDisposed).toBe(true)

    expect((await c.request(9, 'x.ai/marketplace/list', {})).result).toEqual({ sources: [] })
    expect((await c.request(10, 'x.ai/workflows/list', {})).result).toEqual({ workflows: [] })
    expect((await c.request(11, 'x.ai/billing', {})).result).toEqual({ config: null, onDemandEnabled: false, subscriptionTier: null })
    expect((await c.request(12, 'x.ai/suggestPrompt', { generation: 7 })).result).toEqual({ suggestion: null, generation: 7 })
    const info = await c.request(13, 'x.ai/session/info', { sessionId })
    expect(info.result).toMatchObject({
      result: {
        sessionId,
        cwd: process.cwd(),
        turns: 0,
        context: { used: 0, total: 100000, usagePct: 0 },
      },
    })

    const forkId = '11111111-1111-4111-8111-111111111111'
    const forked = await c.request(14, 'x.ai/session/fork', {
      sourceSessionId: sessionId,
      newSessionId: forkId,
      newCwd: process.cwd(),
    })
    expect(forked.result).toEqual({ newSessionId: forkId })
    expect(registry.byId.has(forkId)).toBe(true)
    expect(registry.created.at(-1)).toEqual({ sessionId: forkId, cwd: process.cwd(), agentPreset: 'standard' })
  })

  it('forks a durable session without requiring a live parent record', async () => {
    const { registry, persistence, client: c } = await start({ presets: true })
    register(c)
    await c.next()
    const childId = '22222222-2222-4222-8222-222222222222'
    const forked = await c.request(1, 'x.ai/session/fork', {
      sourceSessionId: 'persisted-session',
      newSessionId: childId,
      newCwd: '/tmp/proj',
    })
    expect(forked.result).toEqual({ newSessionId: childId })
    expect(persistence.loaded).toContain('persisted-session')
    expect(registry.created.at(-1)).toEqual({
      sessionId: childId,
      cwd: '/tmp/proj',
      agentPreset: 'standard',
    })
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
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
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
    // With the idle gate, the settling response goes out first; the promotion
    // broadcast and the promoted echo follow once the agent idles again.
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
        expect(msg.result).toMatchObject({ stopReason: 'cancelled' })
        expect(sawSecondEcho).toBe(false)
        break
      }
      if (isEcho(msg, 'second')) sawSecondEcho = true
    }

    await waitFor(() => agent!.internals.idleWaiters.length === 1)
    agent!.internals.idleWaiters.shift()!()
    await waitFor(() => agent!.internals.followups.includes('second'))
    // The promotion broadcast adopts the next turn before its echo streams.
    // Wait for the broadcast to cross the socket: the agent-side followup
    // lands before the client reads the frames.
    await waitFor(() => c.all.some(m => m.method === 'x.ai/queue/changed' && (m.params as { runningText?: string }).runningText === 'second'))
    await waitFor(() => c.all.some(m => isEcho(m, 'second')))
    const promoIndex = c.all.findIndex(m => m.method === 'x.ai/queue/changed' && (m.params as { runningPromptId?: string }).runningPromptId !== undefined && (m.params as { runningText?: string }).runningText === 'second')
    const echoIndex = c.all.findIndex(m => isEcho(m, 'second'))
    expect(promoIndex).toBeGreaterThanOrEqual(0)
    expect(echoIndex).toBeGreaterThan(promoIndex)
    expect(agent!.internals.followups).toEqual(['first', 'second'])

    agent!.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('does not bypass the idle gate for a prompt enqueued between turn-end and idle', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    expect(agent.internals.followups).toEqual(['first'])

    // Queue a second prompt while the first turn is still in flight.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // End the first turn. The settle path schedules an idle-gated promotion
    // for 'second', but the agent has not reported idle yet.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // This prompt arrives in the turn-end -> idle window. It must join the
    // queue instead of starting immediately and racing the harness.
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'third' }] })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(agent.internals.followups).toEqual(['first'])

    // Fire the pending idle-gated promotion; 'second' starts.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    expect(agent.internals.followups).toEqual(['first', 'second'])

    // Let 'second' settle and then 'third' runs through the same idle gate.
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('third'))
    expect(agent.internals.followups).toEqual(['first', 'second', 'third'])
  })

  it('steers a prompt sent mid-turn into the running turn (followUpBehavior=steer)', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // A follow-up during the turn folds in at the next step boundary instead
    // of parking behind the whole (possibly minutes-long) turn.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }], _meta: { promptId: 'steer-1' } })
    await waitFor(() => agent.internals.steered.includes('second'))
    expect(agent.internals.followups).toEqual(['first'])

    // The row was confirmed once (so the pager's optimistic echo retires by
    // id) and then left the queue as it joined the live turn.
    await waitFor(() => {
      const rowSeen = c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'steer-1'))
      const latest = c.broadcasts[c.broadcasts.length - 1]?.params as { entries?: Array<{ id: string }> } | undefined
      return rowSeen && latest !== undefined && !(latest.entries ?? []).some(e => e.id === 'steer-1')
    })
    // Its text streams into the live turn as a user echo.
    await waitFor(() => c.all.some(m => m.method === 'session/update' && ((m.params as { update?: { content?: { text?: string } } }).update?.content?.text) === 'second'))

    // Both RPCs settle with the host turn's outcome, each with its own attribution.
    agent.internals.idleWaiters.shift()!()
    const responses = await collectIds(c, [2, 3])
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'steer-1' } })
    // The steered prompt never became its own turn.
    expect(agent.internals.followups).toEqual(['first'])
  })

  it('routes per prompt: _meta.followUp=steer steers one message under the queue default', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    // One flagged message steers into the running turn...
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'nudge' }], _meta: { promptId: 'route-steer', followUp: 'steer' } })
    await waitFor(() => agent.internals.steered.includes('nudge'))
    // ...while an unflagged one still parks in the queue.
    sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'later' }], _meta: { promptId: 'route-queue' } })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'route-queue')))
    expect(agent.internals.followups).toEqual(['first'])

    // The steered message settles with the host turn; the queued one runs next.
    agent.internals.idleWaiters.shift()!()
    const settled = await collectIds(c, [2, 3])
    expect(settled.get(3)!.result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'route-steer' } })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('later'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 4)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'route-queue' } })
  })

  it('x.ai/interject merges text into the running turn without cancelling it', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    sendRequest(c, 3, 'x.ai/interject', { sessionId, text: 'course correction', interjectionId: 'ij-1' })
    expect((await waitForId(c, 3)).result).toEqual({})
    expect(agent.internals.steered).toEqual(['course correction'])
    expect(agent.internals.cancelCalls).toBe(0)
    // The broadcast reaches the pane (the originator dedups by id).
    await waitFor(() => c.all.some(m => m.method === 'x.ai/session/interjection'
      && (m.params as { interjectionId?: string }).interjectionId === 'ij-1'
      && (m.params as { text?: string }).text === 'course correction'))

    // The host turn keeps running and settles normally.
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('session/prompt with _meta.sendNow cancels the running turn and runs next', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)

    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'urgent' }], _meta: { promptId: 'now-1', sendNow: true } })
    // The running turn is cancelled with the send_now trigger...
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => c.completes.some(m => (m.params as { cancelTrigger?: string }).cancelTrigger === 'send_now'))
    expect(agent.internals.cancelCalls).toBeGreaterThanOrEqual(1)
    // ...and the send-now prompt runs next. Two waits are pending: the
    // cancelled turn's stale idle detector (a no-op) and the promotion wait.
    await waitFor(() => agent.internals.idleWaiters.length >= 2)
    agent.internals.idleWaiters.shift()!()
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('urgent'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled', _meta: { promptId: 'now-1' } })
  })

  it('routes per prompt: _meta.followUp=queue parks one message under a steer default', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'parked' }], _meta: { promptId: 'route-parked', followUp: 'queue' } })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: Array<{ id: string }> }).entries ?? []).some(e => e.id === 'route-parked')))
    expect(agent.internals.steered).toEqual([])

    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('parked'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('defaults to queue: a mid-turn prompt parks instead of steering', async () => {
    const { registry, client: c } = await start({ manualIdle: true })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'first' }] })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'second' }] })
    await waitFor(() => c.broadcasts.some(b => ((b.params as { entries?: unknown[] }).entries?.length ?? 0) === 1))
    expect(agent.internals.steered).toEqual([])

    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
    await waitFor(() => agent.internals.idleWaiters.length === 1)
    agent.internals.idleWaiters.shift()!()
    await waitFor(() => agent.internals.followups.includes('second'))
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 3)).result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent.internals.followups).toEqual(['first', 'second'])
  })

  it('steer mode still runs an idle-session prompt as its own turn', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'steer' })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'solo' }] })
    await waitFor(() => agent.internals.followups.includes('solo'))
    expect(agent.internals.steered).toEqual([])
    agent.internals.idleWaiters.shift()!()
    expect((await waitForId(c, 2)).result).toMatchObject({ stopReason: 'cancelled' })
  })

  it('a plugin command asks the user a question mid-execution (userQuestions rail)', async () => {
    // The harness-level contract this verifies: CommandInvocation carries the
    // live root agent, so a registry command handler may call
    // userQuestions.ask() and the bridge's registered provider relays it to
    // the owning client as the _x.ai/ask_user_question reverse request.
    const questionService = {
      provider: undefined as undefined | { ask(req: unknown): Promise<unknown> },
      registerProvider(p: { ask(req: unknown): Promise<unknown> }) {
        this.provider = p
        return () => { this.provider = undefined }
      },
    }
    const commandsService = {
      list: () => [{ name: 'confirm', description: 'Ask before doing' }],
      execute: async (agent: unknown, line: string) => {
        if (!/^\/confirm(\s|$)/.test(line)) return undefined
        const answer = await questionService.provider!.ask({
          agent,
          questions: [{ id: 'q1', question: 'Proceed?', options: [{ label: 'Yes' }, { label: 'No' }] }],
        }) as { answers: Array<{ id: string; selected: string[] }> }
        const picked = answer.answers[0]?.selected[0] ?? 'nothing'
        return { commandId: 'c1', result: { kind: 'success', text: 'confirmed: ' + picked } }
      },
    }
    const { client: c } = await start({ commands: commandsService, userQuestions: questionService })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    expect(questionService.provider).toBeDefined()

    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/confirm go' }], _meta: { promptId: 'ask-1' } })

    // The command handler blocks on the question: the client sees the wrapped
    // ext reverse request (leading '_' stripped by the decode mirror; the
    // inner method + params ride one level down).
    await waitFor(() => c.all.some(m => m.method === 'x.ai/ask_user_question' && typeof m.id === 'number'))
    const reverse = c.all.find(m => m.method === 'x.ai/ask_user_question')!
    const inner = reverse.params as { method: string; params: { sessionId: string; questions: Array<{ question: string; options: Array<{ label: string }> }> } }
    expect(inner.params.sessionId).toBe(sessionId)
    expect(inner.params.questions[0].question).toBe('Proceed?')
    expect(inner.params.questions[0].options.map(o => o.label)).toEqual(['Yes', 'No'])

    // Answer as the grok TUI would: accepted, keyed by question text.
    c.send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id: reverse.id, result: { outcome: 'accepted', answers: { 'Proceed?': ['Yes'] } } }) })

    const settled = await waitForId(c, 2)
    expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'ask-1' } })
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '') === 'confirmed: Yes'))
  })

  it('surfaces dsh-registry commands as slash commands and routes them to execute()', async () => {
    const executed: string[] = []
    const commandsService = {
      list: () => [{ name: 'greet', description: 'Say hello', input: { hint: '<name>' } }],
      execute: async (_agent: unknown, line: string) => {
        const parsed = /^\/greet(\s+(.*))?$/.exec(line)
        if (parsed === null) return undefined
        executed.push(line)
        return { commandId: 'c1', result: { kind: 'success', text: 'hello ' + (parsed[2] ?? 'world') } }
      },
    }
    const { registry, client: c } = await start({ commands: commandsService })
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!

    // The registry command is advertised to the session (ACP
    // available_commands_update) alongside the builtin bridge commands.
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && (m.params as { update?: { sessionUpdate?: string; availableCommands?: Array<{ name: string }> } }).update?.sessionUpdate === 'available_commands_update'
      && ((m.params as { update?: { availableCommands?: Array<{ name: string }> } }).update?.availableCommands ?? []).some(entry => entry.name === 'greet')))
    const listed = await c.request(10, 'x.ai/commands/list', { sessionId })
    expect(((listed.result as { commands: Array<{ name: string }> }).commands).map(command => command.name)).toContain('greet')

    // A registered command routes to execute() and never reaches the model.
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/greet dscode' }], _meta: { promptId: 'greet-1' } })
    const settled = await waitForId(c, 2)
    expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'greet-1' } })
    expect(executed).toEqual(['/greet dscode'])
    await waitFor(() => c.all.some(m => m.method === 'session/update'
      && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '') === 'hello dscode'))
    expect(agent.internals.followups).toEqual([])

    // Unknown slash text falls through to the model unchanged.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/nope do it' }] })
    await waitFor(() => agent.internals.followups.includes('/nope do it'))
    agent.internals.idleWaiters.shift()?.()
    await waitForId(c, 3)
  })

  it('reports the services and effects a loaded plugin brought, generically', async () => {
    const profileDir = resolve(tmpdir(), 'dsh-profile-inspect-' + randomUUID())
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: { 'dsh-plugin-example': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-example'] } },
    }))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { pluginCtx, client: c } = await start()
      register(c)
      await c.next()
      // Mount an arbitrary third-party-shaped plugin into the live context:
      // the report must attribute its service and effects with zero
      // plugin-specific knowledge (pure reflect.store + fiber parentage).
      await pluginCtx.plugin({
        name: 'dsh-plugin-example',
        apply(inner: Context) {
          inner.provide('exampleThing', { hello: true })
          ;(inner as unknown as { on(event: string, listener: () => void): void }).on('commands/change', () => {})
        },
      } as never)

      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh inspect dsh-plugin-example' }], _meta: { promptId: 'ins-1' } })
      const settled = await waitForId(c, 2)
      expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'ins-1' } })
      await waitFor(() => c.all.some(m => {
        if (m.method !== 'session/update') return false
        const text = String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '')
        return text.includes('provides services: exampleThing') && text.includes('registered effects:')
      }))

      // Unknown plugin: actionable, not a crash.
      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh inspect dsh-plugin-ghost' }] })
      await waitForId(c, 3)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('is not installed')))
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('advertises the /dsh command and interprets it in the bridge, never the model', async () => {
    const profileDir = resolve(tmpdir(), 'dsh-profile-test-' + randomUUID())
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: {
        '@hqzhao95/dscode': 'file:/x',
        'dsh-plugin-example': '^1.0.0',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-example', '@hqzhao95/dscode'] } },
    }, null, 2))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { registry, client: c } = await start()
      register(c)
      await c.next()

      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!

      const listed = await c.request(2, 'x.ai/commands/list', {})
      const names = ((listed.result as { commands: Array<{ name: string }> }).commands).map(entry => entry.name)
      expect(names).toContain('dsh')

      // /dsh plugins settles as its own end_turn without ever reaching the
      // model, and streams the profile bundle list as an agent message.
      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh plugins' }], _meta: { promptId: 'dsh-1' } })
      const settled = await waitForId(c, 3)
      expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'dsh-1' } })
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('dsh-plugin-example')))
      expect(agent.internals.followups).toEqual([])

      // Core components refuse removal.
      sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh remove @hqzhao95/dscode' }] })
      await waitForId(c, 4)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('refusing to remove')))
      expect(agent.internals.followups).toEqual([])

      // Unknown subcommands reply with usage instead of reaching the model.
      sendRequest(c, 5, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh frobnicate' }] })
      await waitForId(c, 5)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('Usage: /dsh')))
      expect(agent.internals.followups).toEqual([])
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('pre-audits local bundle plugins, requires trust, and removes them with npm', async () => {
    const root = resolve(tmpdir(), 'dsh-plugin-flow-' + randomUUID())
    const profileDir = resolve(root, 'profile')
    const pluginDir = resolve(root, 'plugin with spaces')
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode'] } },
    }, null, 2))
    writeFileSync(resolve(pluginDir, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-local-bundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(resolve(pluginDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: plugin-feature',
      "      name: 'dsh-plugin-local-bundle/feature'",
    ].join('\n'))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { client: c } = await start()
      register(c)
      await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const spec = 'file:' + pluginDir

      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh add ' + JSON.stringify(spec) }] })
      const refused = await waitForId(c, 2)
      expect(refused.error).toBeUndefined()
      await waitFor(() => c.all.some(message => message.method === 'session/update'
        && String((message.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('Not installed. Review the requested composition changes')))
      let manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
      expect((manifest.dependencies ?? {})['dsh-plugin-local-bundle']).toBeUndefined()

      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh add --trust ' + JSON.stringify(spec) }] })
      const installed = await waitForId(c, 3)
      expect(installed.error).toBeUndefined()
      manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as typeof manifest
      expect(manifest.dependencies['dsh-plugin-local-bundle']).toBeDefined()
      expect(manifest.dsh.profile.bundles).toContain('dsh-plugin-local-bundle')

      sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh remove dsh-plugin-local-bundle' }] })
      const removed = await waitForId(c, 4)
      expect(removed.error).toBeUndefined()
      manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as typeof manifest
      expect((manifest.dependencies ?? {})['dsh-plugin-local-bundle']).toBeUndefined()
      expect(manifest.dsh.profile.bundles).not.toContain('dsh-plugin-local-bundle')
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)

  it('stamps a strictly increasing seq on queue/changed and promptId meta on settle results', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId

    // A client-minted promptId rides back on the settle result, so the pager
    // attributes the response without falling back to the RPC id.
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'one' }], _meta: { promptId: 'row-1' } })
    const settledOne = await waitForId(c, 2)
    expect(settledOne.result).toMatchObject({ stopReason: 'cancelled', _meta: { sessionId, promptId: 'row-1' } })

    // A leader-minted id is still echoed on the result.
    sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'two' }] })
    const settledTwo = await waitForId(c, 3)
    expect((settledTwo.result as { _meta?: { promptId?: string } })._meta?.promptId).toEqual(expect.any(String) as string)

    // Every snapshot carries a seq, strictly increasing in emission order, so
    // the pager can drop a stale snapshot regardless of channel interleaving.
    const seqs = c.broadcasts.map(b => (b.params as { seq?: number }).seq)
    expect(seqs.length).toBeGreaterThanOrEqual(2)
    for (const seq of seqs) expect(typeof seq).toBe('number')
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
  })

  it('random queue-op interleavings converge: one settle per prompt, seq-ordered snapshots, a drained queue', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
    register(c)
    await c.next()
    let rpcId = 10
    // Three seeded rounds; a failure reproduces exactly from its seed.
    for (const seedBase of [0xC0FFEE, 0xBADD1E, 0x5EED]) {
      let seed = seedBase >>> 0
      const rnd = (): number => {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
        return seed / 2 ** 32
      }
      const pick = <T,>(items: T[]): T => items[Math.floor(rnd() * items.length)]!

      sendRequest(c, ++rpcId, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const created = await waitForId(c, rpcId)
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!
      const sent: Array<{ rpc: number; promptId: string }> = []
      const texts: string[] = []
      const knownIds: string[] = []
      const held: string[] = []
      let counter = 0

      for (let op = 0; op < 40; op++) {
        const roll = rnd()
        if (roll < 0.35) {
          const promptId = 's' + String(seedBase) + '-p' + String(counter)
          const text = 's' + String(seedBase) + '-t' + String(counter)
          counter += 1
          knownIds.push(promptId)
          texts.push(text)
          sent.push({ rpc: ++rpcId, promptId })
          sendRequest(c, rpcId, 'session/prompt', { sessionId, prompt: [{ type: 'text', text }], _meta: { promptId } })
        } else if (roll < 0.6) {
          // Model the agent reaching idle at an arbitrary point.
          agent.internals.idleWaiters.shift()?.()
        } else if (roll < 0.68) {
          if (knownIds.length > 0) c.notify('x.ai/queue/remove', { sessionId, id: pick(knownIds) })
        } else if (roll < 0.76) {
          if (knownIds.length > 0) {
            const text = 's' + String(seedBase) + '-edit' + String(counter)
            counter += 1
            texts.push(text)
            c.notify('x.ai/queue/edit', { sessionId, id: pick(knownIds), newText: text })
          }
        } else if (roll < 0.84) {
          if (knownIds.length > 0) {
            const id = pick(knownIds)
            held.push(id)
            c.notify('x.ai/queue/hold_edit', { sessionId, id })
          }
        } else if (roll < 0.9) {
          if (held.length > 0) c.notify('x.ai/queue/release_edit', { sessionId, id: held.splice(Math.floor(rnd() * held.length), 1)[0]! })
        } else if (roll < 0.96) {
          if (knownIds.length > 1) c.notify('x.ai/queue/reorder', { sessionId, orderedIds: [...knownIds].sort(() => rnd() - 0.5) })
        } else if (knownIds.length > 0) {
          c.notify('x.ai/queue/interject', { sessionId, id: pick(knownIds) })
        }
        // Let the leader drain its socket and microtasks at arbitrary cuts.
        if (op % 5 === 4) await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
      }

      // Stop mutating; discard what never ran and settle whatever is running.
      c.notify('x.ai/queue/clear', { sessionId })
      await waitFor(() => {
        agent.internals.idleWaiters.splice(0).forEach((fire) => { fire() })
        return sent.every(({ rpc }) => c.all.some(m => m.id === rpc && m.method === undefined))
      }, 10_000)

      // Exactly one settle per prompt, attributed to its queue row.
      for (const { rpc, promptId } of sent) {
        const responses = c.all.filter(m => m.id === rpc && m.method === undefined)
        expect(responses).toHaveLength(1)
        const result = responses[0]!.result as { stopReason?: string; _meta?: { promptId?: string } } | undefined
        expect(result?.stopReason).toEqual(expect.any(String) as string)
        expect(result?._meta?.promptId).toBe(promptId)
      }
      // Snapshots stay strictly seq-ordered.
      const snaps = c.broadcasts.filter(b => (b.params as { sessionId?: string }).sessionId === sessionId)
      const seqs = snaps.map(b => (b.params as { seq?: number }).seq)
      for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!)
      // No prompt ran twice, and only texts this round produced ever ran.
      const runs = agent.internals.followups
      expect(new Set(runs).size).toBe(runs.length)
      for (const run of runs) expect(texts).toContain(run)
      // The queue drained to the idle empty snapshot.
      const last = snaps[snaps.length - 1]!.params as { entries: unknown[]; runningPromptId?: string }
      expect(last.entries).toEqual([])
      expect(last.runningPromptId).toBeUndefined()
    }
  })

  it('cancel settles the in-flight and queued prompts as cancelled', async () => {
    const { registry, client: c } = await start({ manualIdle: true, followUpBehavior: 'queue' })
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
    expect(responses.get(2)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(responses.get(3)!.result).toMatchObject({ stopReason: 'cancelled' })
    expect(agent!.internals.followups).toEqual(['one']) // the queued prompt never ran
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

  it('dedupes colliding model ids and falls back to a catalog entry', async () => {
    const { client: c } = await start({ llm: collidingLlm, model: 'not-in-catalog' })
    register(c)
    await c.next()

    const initialize = await c.request(0, 'initialize', { protocolVersion: 1 })
    const modelState = (initialize.result as {
      _meta: { modelState: { currentModelId: string; availableModels: Array<{ modelId: string; name: string }> } }
    })._meta.modelState
    expect(modelState.availableModels).toEqual([
      { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
      { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { modelId: 'b:shared', name: 'Shared B', _meta: { provider: 'b', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
      { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
    ])
    expect(modelState.currentModelId).toEqual('shared')

    const models = await c.request(1, 'x.ai/models/list', {})
    expect(models.result).toEqual({
      currentModelId: 'shared',
      availableModels: [
        { modelId: 'shared', name: 'Shared A', _meta: { provider: 'a', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'], reasoningEffort: 'high' } },
        { modelId: 'only-a', name: 'Only A', _meta: { provider: 'a', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'b:shared', name: 'Shared B', _meta: { provider: 'b', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
        { modelId: 'only-b', name: 'Only B', _meta: { provider: 'b', supportsReasoningEffort: true, reasoningEfforts: ['low', 'medium', 'high', 'xhigh', 'max'] } },
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
    expect(switched.error).toEqual({ code: -32602, message: 'reasoningEffort "quantum" is not supported by model shared' })
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
      { name: 'dsh', description: 'Manage dsh plugins', input: { hint: 'plugins | add [--trust] <package> | remove <name> | inspect <name>' } },
      { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | code | minimal | cordis' } },
    ])

    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    await c.request(2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
    await c.next() // consume the echoed user_message_chunk before the next request

    const commands = await c.request(3, 'x.ai/commands/list', { sessionId })
    expect(commands.result).toEqual({
      commands: [
        { name: 'dsh', description: 'Manage dsh plugins', input: { hint: 'plugins | add [--trust] <package> | remove <name> | inspect <name>' } },
        { name: 'preset', description: 'Switch the active agent preset', input: { hint: 'standard | code | minimal | cordis' } },
      ],
    })

    const history = await c.request(4, 'x.ai/prompt_history', { cwd: process.cwd(), filter_session_id: sessionId })
    expect(history.result).toEqual({ prompts: ['hello'] })
  })

  it('x.ai/session/list backfills firstPrompt before the query filter', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.load = (async () => ({
      meta: persistence.header,
      events: [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Needle prompt title' }] } }],
    })) as unknown as typeof persistence.load
    const listed = await c.request(1, 'x.ai/session/list', { query: 'needle' })
    expect(listed.result).toMatchObject({
      sessions: [{
        sessionId: 'persisted-session',
        cwd: '/tmp/proj',
        firstPrompt: 'Needle prompt title',
        _meta: { 'x.ai/session': { kind: 'chat' } },
      }],
    })
  })

  it('x.ai/session/list resolves an exact id outside the launch cwd', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const listed = await c.request(1, 'x.ai/session/list', {
      cwd: '/another/project',
      query: 'persisted-session',
    })
    expect(listed.result).toMatchObject({
      sessions: [{ sessionId: 'persisted-session', cwd: '/tmp/proj' }],
    })
  })

  it('x.ai/session/list exposes durable titles for title-based resume', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.load = (async () => ({
      meta: persistence.header,
      events: [
        { type: 'user/message', seq: 0, time: 10, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Initial prompt' }] } },
        { type: 'session/title', seq: 1, time: 20, data: { title: 'Reviewed session', messageSeqs: [], source: { kind: 'user' } } },
      ],
    })) as unknown as typeof persistence.load
    const listed = await c.request(1, 'x.ai/session/list', { query: 'reviewed session' })
    expect(listed.result).toMatchObject({
      sessions: [{
        sessionId: 'persisted-session',
        title: 'Reviewed session',
        summary: 'Reviewed session',
        updatedAt: new Date(20).toISOString(),
      }],
    })
  })

  it('x.ai/session/list orders sessions by their latest durable event', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    const olderCreated = { ...persistence.header, id: SessionId('older-created'), createdAt: 100 }
    persistence.list = (async () => [olderCreated, persistence.header]) as typeof persistence.list
    persistence.load = (async (id: SessionId) => ({
      meta: id === olderCreated.id ? olderCreated : persistence.header,
      events: [{
        type: 'user/message',
        seq: 0,
        time: id === olderCreated.id ? 100 : 500,
        data: { source: { kind: 'user' }, content: [{ type: 'text', text: String(id) }] },
      }],
    })) as unknown as typeof persistence.load
    const listed = await c.request(1, 'x.ai/session/list', {})
    expect((listed.result as { sessions: Array<{ sessionId: string }> }).sessions.map(row => row.sessionId)).toEqual([
      'persisted-session',
      'older-created',
    ])
  })

  it('x.ai/session/list retries an empty firstPrompt instead of caching the miss', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    let prompted = false
    persistence.load = (async () => ({
      meta: persistence.header,
      events: prompted
        ? [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'Late title' }] } }]
        : [],
    })) as unknown as typeof persistence.load
    const first = await c.request(1, 'x.ai/session/list', {})
    expect((first.result as { sessions: Array<{ firstPrompt: string }> }).sessions[0]!.firstPrompt).toBe('')
    prompted = true
    const second = await c.request(2, 'x.ai/session/list', {})
    expect((second.result as { sessions: Array<{ firstPrompt: string }> }).sessions[0]!.firstPrompt).toBe('Late title')
  })

  it('session/load replay repopulates the up-arrow prompt history', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.load = (async () => ({
      meta: persistence.header,
      events: [
        { type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted one' }] } },
        { type: 'user/message', seq: 1, time: 1, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted two' }] } },
      ],
    })) as unknown as typeof persistence.load
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    // Consume the two replayed user_message_chunk notifications so the next
    // request is not stalled behind them in the client's message queue.
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'persisted one' } } },
    })
    expect(await c.next()).toMatchObject({
      method: 'session/update',
      params: { update: { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'persisted two' } } },
    })
    const history = await c.request(2, 'x.ai/prompt_history', { filter_session_id: 'persisted-session' })
    expect(history.result).toEqual({ prompts: ['persisted two', 'persisted one'] })
  })

  it('session/load noReplay rebuilds history without emitting prior transcript updates', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.load = (async () => ({
      meta: persistence.header,
      events: [
        { type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'persisted prompt' }] } },
        { type: 'assistant/message', seq: 1, time: 1, data: { message: { content: [{ type: 'text', text: 'persisted answer' }] } } },
      ],
    })) as unknown as typeof persistence.load
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { noReplay: true },
    })
    expect(loaded.error).toBeUndefined()
    expect(c.all.some(message => {
      const params = message.params as { _meta?: { isReplay?: boolean } } | undefined
      return message.method === 'session/update' && params?._meta?.isReplay === true
    })).toBe(false)
    const history = await c.request(2, 'x.ai/prompt_history', { session_id: 'persisted-session' })
    expect(history.result).toEqual({ prompts: ['persisted prompt'] })
  })

  it('session/load validates noReplay metadata type', async () => {
    const { client: c } = await start()
    register(c)
    await c.next()
    const loaded = await c.request(1, 'session/load', {
      sessionId: 'persisted-session',
      cwd: '/tmp/proj',
      mcpServers: [],
      _meta: { noReplay: 'yes' },
    })
    expect(loaded.error).toEqual({ code: -32602, message: '_meta.noReplay must be a boolean' })
  })

  it('emits a first projected event whose seq is 0 (lastSeq starts at -1)', async () => {
    const { persistence, client: c } = await start()
    register(c)
    await c.next()
    persistence.load = (async () => ({
      meta: persistence.header,
      events: [{ type: 'user/message', seq: 0, time: 0, data: { source: { kind: 'user' }, content: [{ type: 'text', text: 'seq zero replay' }] } }],
    })) as unknown as typeof persistence.load
    const loaded = await c.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/tmp/proj', mcpServers: [] })
    expect(loaded.error).toBeUndefined()
    const seen = (): boolean => c.all.some(msg => {
      const params = msg.params as { update?: { sessionUpdate?: string; content?: { type?: string; text?: string } }; _meta?: { isReplay?: boolean } }
      return msg.method === 'session/update'
        && params.update?.sessionUpdate === 'user_message_chunk'
        && params.update.content?.type === 'text'
        && params.update.content.text === 'seq zero replay'
        && params._meta?.isReplay === true
    })
    await waitFor(seen)
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

  it('rejects a reverse request the client never answers within 60s', async () => {
    vi.useFakeTimers()
    try {
      const { registry, pluginCtx, client: c } = await start()
      register(c)
      await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!
      const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
      const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
      vi.advanceTimersByTime(60_000)
      await expect(decision).resolves.toBe('rejected')
    } finally {
      vi.useRealTimers()
    }
  })

  it('session/cancel rejects a pending permission roundtrip', async () => {
    const { registry, pluginCtx, client: c } = await start()
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = registry.byId.get(sessionId)!
    const waterfall = pluginCtx.waterfall as unknown as (name: string, ...args: unknown[]) => unknown
    const decision = waterfall('approval/request', { agent, callId: 'tool-1', toolName: 'bash' }, async () => 'rejected' as const) as Promise<string>
    // The reverse request reached the client before the cancel settles it.
    await waitFor(() => c.all.some(msg => msg.method === 'session/request_permission'))
    let settled = false
    void decision.then(() => { settled = true })
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 0) })
    expect(settled).toBe(false)
    c.notify('session/cancel', { sessionId })
    await expect(decision).resolves.toBe('rejected')
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
      baseURL: 'https://acme.test/v1',
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

  it('broadcasts the refreshed model catalog after adding a provider', async () => {
    mockDefaultModel.current = undefined
    const settings = makeSettings()
    const { client } = await startWithSettings(settings)
    await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
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
          { value: 'ultra', label: 'Unsupported by pi-ai rc.8' },
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
})

describe('leader lifecycle', () => {
  it('requests a host exit shortly after the last client disconnects', async () => {
    mockAppExit.calls.length = 0
    const made = await makeHarness({ idleExitMs: 20 })
    const c = await makeClient(made.socketPath)
    register(c)
    await c.next()
    expect(mockAppExit.calls).toEqual([])
    c.socket.destroy()
    await waitFor(() => mockAppExit.calls.length === 1)
    expect(mockAppExit.calls[0]).toBe(0)
    await made.ctx.fiber.dispose()
  })

  it('reconnecting during the grace keeps the leader alive', async () => {
    mockAppExit.calls.length = 0
    const made = await makeHarness({ idleExitMs: 200 })
    const c = await makeClient(made.socketPath)
    register(c)
    await c.next()
    c.socket.destroy()
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 50) })
    const second = await makeClient(made.socketPath)
    register(second)
    await second.next()
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 300) })
    expect(mockAppExit.calls).toEqual([])
    second.socket.destroy()
    await made.ctx.fiber.dispose()
  })

  it('keeps the leader for remaining clients and exits after the last drop', async () => {
    mockAppExit.calls.length = 0
    const made = await makeHarness({ idleExitMs: 20 })
    const a = await makeClient(made.socketPath)
    register(a)
    await a.next()
    const b = await makeClient(made.socketPath)
    register(b)
    await b.next()
    a.socket.destroy()
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 80) })
    expect(mockAppExit.calls).toEqual([])
    b.socket.destroy()
    await waitFor(() => mockAppExit.calls.length === 1)
    expect(mockAppExit.calls[0]).toBe(0)
    await made.ctx.fiber.dispose()
  })

  it('waits for the in-flight teardown flush before the idle exit', async () => {
    mockAppExit.calls.length = 0
    mockSessionsStore.flushed.length = 0
    const made = await makeHarness({ idleExitMs: 5 })
    const c = await makeClient(made.socketPath)
    register(c)
    await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const agent = made.registry.byId.get(sessionId)!
    // Slow the session-store flush: the exit must not beat it.
    const originalFlush = mockSessionsStore.flush
    let releaseFlush: () => void = () => {}
    const flushGate = new Promise<void>((resolveFlush) => { releaseFlush = resolveFlush })
    mockSessionsStore.flush = async (session: object) => {
      mockSessionsStore.flushed.push(session)
      await flushGate
      return true
    }
    try {
      c.socket.destroy()
      await waitFor(() => mockSessionsStore.flushed.length === 1)
      // Long past idleExitMs: the slow flush must hold the exit open.
      await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 30) })
      expect(mockAppExit.calls).toEqual([])
      releaseFlush()
      await waitFor(() => mockAppExit.calls.length === 1)
      expect(mockAppExit.calls[0]).toBe(0)
      expect(agent?.internals.disposed).toBe(true)
    } finally {
      mockSessionsStore.flush = originalFlush
      await made.ctx.fiber.dispose()
    }
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

async function startManageHarness(settings: ManageSettingsMock, model?: string, credentials?: unknown): Promise<{ client: ClientHandle; settings: ManageSettingsMock }> {
  const llm = manageLlm(settings)
  const made = await makeHarness({ llm, settings: settings as unknown as Context['settings'], model, credentials })
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
      api: '',
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
        baseURL: 'https://new.test/v1',
        models: [{ id: 'gw-model' }],
      },
    }])
    expect(res.result).toMatchObject({
      providers: [{ id: 'deepseek' }, { id: 'acme-gateway', baseURL: 'https://new.test/v1' }],
    })
  })

  it('an omitted field keeps the current profile value', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = {
      displayName: 'Acme',
      apiKeyEnv: 'ACME_KEY',
      api: 'openai-completions',
      baseURL: 'https://acme.test/v1',
    }
    const { client } = await startManageHarness(settings)
    const res = await client.request(1, 'x.ai/providers/update', { providerId: 'acme-gateway', displayName: 'Renamed' })
    expect(res.error).toBeUndefined()
    expect(settings.calls).toHaveLength(1)
    expect(settings.calls[0].ops).toEqual([{
      op: 'set',
      path: ['providers', 'acme-gateway'],
      value: {
        displayName: 'Renamed',
        apiKeyEnv: 'ACME_KEY',
        api: 'openai-completions',
        baseURL: 'https://acme.test/v1',
      },
    }])
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

  it('refuses a provider still selected by a live session even after the global default moved', async () => {
    const settings = makeManageSettings()
    settings.providers['acme-gateway'] = { displayName: 'Acme' }
    const { client } = await startManageHarness(settings, 'deepseek-chat')
    const created = await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    const switched = await client.request(2, 'session/set_model', { sessionId, modelId: 'acme-gateway-model' })
    expect(switched.error).toBeUndefined()
    mockDefaultModel.current = { provider: 'deepseek', model: 'deepseek-chat' }
    await client.request(3, 'x.ai/models/list', {})

    const removed = await client.request(4, 'x.ai/providers/remove', { id: 'acme-gateway' })
    expect(removed.error).toMatchObject({ code: -32602, message: 'provider "acme-gateway" is in use; switch to another provider first' })
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

describe('sessionEventToUpdates tool-result diff fallback', () => {
  const toolResult = (opts: { text?: string; meta?: unknown; error?: { name: string; code: string } } = {}) => ({
    type: 'tool/result',
    data: {
      message: { content: [{ type: 'tool-result', toolCallId: 'call-1', content: opts.text === undefined ? [] : [{ type: 'text', text: opts.text }] }] },
      ...opts.meta === undefined ? {} : { meta: opts.meta },
      ...opts.error === undefined ? {} : { error: opts.error },
    },
  }) as never

  const map = (event: never, call?: { name: string; arguments: unknown }) =>
    GrokLeader.sessionEventToUpdates(event, { replay: false, textStreamed: false, toolCall: () => call })

  const diffs = (updates: GrokLeader.GrokSessionUpdate[]): unknown[] =>
    ((updates[0] as { content?: Array<{ type: string }> }).content ?? []).filter(block => block.type === 'diff')

  it('synthesizes a diff block from the recorded Edit call when meta has none', () => {
    const updates = map(toolResult({ text: 'ok' }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'let x = 1', new_string: 'let x = 2' },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'let x = 1', newText: 'let x = 2' }])
  })

  it('prefers presentation-meta diffs over the call-argument fallback', () => {
    const updates = map(
      toolResult({ meta: { diffs: [{ path: '/tmp/a.ts', oldText: 'meta old', newText: 'meta new' }] } }),
      { name: 'edit', arguments: { file_path: '/tmp/a.ts', old_string: 'arg old', new_string: 'arg new' } },
    )
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'meta old', newText: 'meta new' }])
  })

  it('wraps text blocks in ACP content so the tool_call_update frame parses', () => {
    // ACP ToolCallContent is tagged `content`/`diff`/`terminal`; a bare
    // `{"type":"text"}` block fails serde and drops the whole update in the
    // TUI (verified against agent-client-protocol 0.10.4).
    const updates = map(toolResult({ text: 'ok' }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' },
    })
    expect((updates[0] as { content?: unknown[] }).content).toEqual([
      { type: 'content', content: { type: 'text', text: 'ok' } },
      { type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: 'b' },
    ])
  })

  it('emits no fallback diff when the tool errored', () => {
    const updates = map(toolResult({ error: { name: 'EditError', code: 'not_found' } }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: 'b' },
    })
    expect((updates[0] as { status: string }).status).toBe('error')
    expect(diffs(updates)).toEqual([])
  })

  it('renders Write as a new-file diff (no oldText) and keeps deletions (empty new_string)', () => {
    const write = map(toolResult({}), { name: 'Write', arguments: { file_path: '/tmp/new.md', content: 'hello' } })
    expect(diffs(write)).toEqual([{ type: 'diff', path: '/tmp/new.md', newText: 'hello' }])
    const deletion = map(toolResult({}), { name: 'edit', arguments: { file_path: '/tmp/a.ts', old_string: 'gone', new_string: '' } })
    expect(diffs(deletion)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'gone', newText: '' }])
  })

  it('covers str_replace_editor create via file_text', () => {
    const updates = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'create', path: '/tmp/new.py', file_text: 'print(1)' },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/new.py', newText: 'print(1)' }])
  })

  it('covers str_replace_editor replace, deletion, and insert fallback diffs', () => {
    const replace = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path: '/tmp/a.ts', old_str: 'let x = 1', new_str: 'let x = 2' },
    })
    expect(diffs(replace)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'let x = 1', newText: 'let x = 2' }])

    const deletion = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'str_replace', path: '/tmp/a.ts', old_str: 'gone' },
    })
    expect(diffs(deletion)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'gone', newText: '' }])

    const insert = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'insert', path: '/tmp/a.ts', insert_line: 1, new_str: 'added' },
    })
    expect(diffs(insert)).toEqual([{ type: 'diff', path: '/tmp/a.ts', newText: 'added' }])

    const view = map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'view', path: '/tmp/a.ts' },
    })
    expect(diffs(view)).toEqual([])
  })

  it('skips fallback diffs that would exceed the display-only performance budget', () => {
    const huge = 'x'.repeat(64 * 1024 + 1)
    expect(diffs(map(toolResult({}), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'small', new_string: huge },
    }))).toEqual([])
    expect(diffs(map(toolResult({}), {
      name: 'str_replace_editor',
      arguments: { command: 'create', path: '/tmp/new.py', file_text: huge },
    }))).toEqual([])
    expect(diffs(map(toolResult({}), {
      name: 'write',
      arguments: { file_path: '/tmp/new.md', content: huge },
    }))).toEqual([])
  })

  it('skips oversized presentation-meta diffs as a defensive performance guard', () => {
    const huge = 'y'.repeat(64 * 1024 + 1)
    expect(diffs(map(toolResult({ meta: { diffs: [{ path: '/tmp/a.ts', oldText: 'small', newText: huge }] } }), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'small', new_string: huge },
    }))).toEqual([])
  })

  it('keeps fallback diffs within the performance budget', () => {
    const ok = 'z'.repeat(64 * 1024 - 1)
    const updates = map(toolResult({}), {
      name: 'edit',
      arguments: { file_path: '/tmp/a.ts', old_string: 'a', new_string: ok },
    })
    expect(diffs(updates)).toEqual([{ type: 'diff', path: '/tmp/a.ts', oldText: 'a', newText: ok }])
  })

  it('yields no diff for non-edit tools, incomplete args, or unknown calls', () => {
    expect(diffs(map(toolResult({ text: 'ran' }), { name: 'bash', arguments: { command: 'ls' } }))).toEqual([])
    expect(diffs(map(toolResult({}), { name: 'edit', arguments: { file_path: '/tmp/a.ts' } }))).toEqual([])
    expect(diffs(map(toolResult({}), { name: 'edit', arguments: { old_string: 'a', new_string: 'b' } }))).toEqual([])
    expect(diffs(map(toolResult({})))).toEqual([])
  })
})

describe('analyzeBundlePatch (static pre-install patch analysis)', () => {
  const analyze = GrokLeader.analyzeBundlePatch

  it('keeps model-facing add-ons out of the preset-owned tool catalogs', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const analysis = analyze(patch)
    expect(analysis.insertedRows).toEqual(['code-runtime', 'agent-presets', 'cordis-host-runner', 'grok-leader'])
    expect(patch).not.toContain('@deepseek-ai/dsh-schedule')
  })

  it('classifies inserts, overrides, disables, and flags the security spine', () => {
    const patch = [
      '- insert:',
      '    - id: my-tool',
      "      name: 'dsh-plugin-mytool'",
      '    - id: my-service',
      "      name: 'dsh-plugin-mytool/service'",
      '    - id: sandbox-policy',
      "      name: 'dsh-plugin-risky-policy'",
      '- id: system-prompt',
      '  config:',
      '    persona: hacked',
      '- id: approval',
      '  disabled: true',
      '- id: sandbox',
      '  config:',
      '    mode: off',
    ].join('\n')
    const analysis = analyze(patch)
    expect(analysis.insertedRows).toEqual(['my-tool', 'my-service', 'sandbox-policy'])
    expect(analysis.overriddenRows).toEqual(['system-prompt', 'sandbox'])
    expect(analysis.disabledRows).toEqual(['approval'])
    // Both the disable AND the config override of spine rows are flagged.
    expect(analysis.sensitiveRows).toEqual(['sandbox-policy', 'approval', 'sandbox'])
    expect(analysis.jsExprCount).toBe(0)
  })

  it('counts !!js expressions (boot-time code) while still parsing the structure', () => {
    const patch = [
      '- insert:',
      '    - id: row-a',
      "      name: 'pkg-a'",
      '      config:',
      '        port: !!js process.env.PORT ?? 3080',
      '- id: hmr',
      '  disabled: !!js process.platform === "win32"',
    ].join('\n')
    const analysis = analyze(patch)
    expect(analysis.jsExprCount).toBe(2)
    expect(analysis.insertedRows).toEqual(['row-a'])
    // A !!js disabled value is not literal true, so it reads as an override —
    // the jsExprCount warning covers the ambiguity.
    expect(analysis.overriddenRows).toEqual(['hmr'])
  })

  it('throws on the shapes loadProfile refuses (anti-brick gate)', () => {
    expect(() => analyze('just a scalar')).toThrow(/not a YAML array/)
    expect(() => analyze('- 42')).toThrow(/not a mapping/)
    expect(() => analyze('{ not: [valid')).toThrow()
  })
})

describe('parseCommandLine', () => {
  const parse = GrokLeader.parseCommandLine

  it('preserves quoted package paths and escaped whitespace', () => {
    expect(parse('/dsh add --trust "file:../plugin with spaces" file:plain\\ path')).toEqual([
      '/dsh',
      'add',
      '--trust',
      'file:../plugin with spaces',
      'file:plain path',
    ])
  })

  it('rejects unterminated quoting instead of changing the package spec', () => {
    expect(() => parse('/dsh add "file:broken')).toThrow('unterminated quote')
  })
})
