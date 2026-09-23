/**
 * Shared harness for the leader socket specs: a mocked agent registry, native
 * service mocks and a real unix-socket client, pinned to
 * tests/fixtures/grok-tui-messages.jsonl and docs/grok-leader-protocol.md.
 */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { resolve } from 'node:path'
import { afterEach, expect, vi } from 'vitest'
import { Context, Service } from '@deepseek-ai/cordis'
import type { Agent, AgentOptions } from '@deepseek-ai/dsh-agent'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { SessionPersistenceRevision, type SessionAccess, type SessionHandle, type SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { encodeJsonFrame, FrameDecoder } from '../../src/codec.ts'
import * as GrokLeader from '../../src/index.ts'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

export const packageVersion = (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version

export interface MockAgentInternals {
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

export type MockAgent = Agent & { internals: MockAgentInternals }

export interface MockRegistry {
  created: Array<{ sessionId: string; cwd?: string; agentPreset?: string }>
  resumed: Array<{ sessionId: string }>
  byId: Map<string, MockAgent>
  seeds: Map<string, readonly { type: string; data: unknown; seq: number; time: number }[]>
  create(options: unknown): Promise<{ agent: Agent; dispose: () => Promise<void> }>
  resume(options: unknown): Promise<{ agent: Agent; dispose: () => Promise<void> }>
  get(id: SessionId): Agent | undefined
}

export function makeMockRegistry(ctx: Context, manualIdle = false): MockRegistry {
  const created: Array<{ sessionId: string; cwd?: string }> = []
  const resumed: Array<{ sessionId: string }> = []
  const byId = new Map<string, MockAgent>()
  const seeds = new Map<string, readonly { type: string; data: unknown; seq: number; time: number }[]>()
  const makeAgent = (
    sessionId: SessionId,
    cwd: string | undefined,
    agentPreset?: string,
    options: AgentOptions = {},
  ): MockAgent => {
    const internals: MockAgentInternals = { cancelCalls: 0, followups: [], steered: [], messages: [], disposed: false, idleWaiters: [], status: 'idle' }
    const events: Array<{ type: string; data: unknown; seq: number; time: number }> = []
    const agent = {
      id: sessionId,
      options,
      session: {
        id: sessionId,
        header: { id: sessionId, version: 0, isSeeded: false, createdAt: 0, ...cwd === undefined ? {} : { cwd }, ...agentPreset === undefined ? {} : { agentPreset } },
        get seq() { return events.length },
        inheritedEventCount: SessionLogOffset(0),
        eventAt(seq: number) { return events[seq] },
        snapshotEvents(from = 0, to = events.length) { return events.slice(from, to) },
        ownEvents() { return [...events] },
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
    seeds,
    async create(options) {
      const o = options as { sessionId: SessionId; seed?: readonly { type: string; data: unknown; seq: number; time: number }[]; meta?: { cwd?: string; agentPreset?: string }; agentOptions?: AgentOptions; setup?: (agentCtx: Context) => unknown }
      created.push({
        sessionId: o.sessionId,
        ...o.meta?.cwd === undefined ? {} : { cwd: o.meta.cwd },
        ...o.meta?.agentPreset === undefined ? {} : { agentPreset: o.meta.agentPreset },
      })
      seeds.set(o.sessionId, o.seed ?? [])
      if (o.setup !== undefined) await o.setup(ctx)
      const agent = makeAgent(o.sessionId, o.meta?.cwd, o.meta?.agentPreset, o.agentOptions)
      return { agent, dispose: async () => { agent.internals.disposed = true; byId.delete(o.sessionId) } }
    },
    async resume(options) {
      const o = options as { resumeSessionId: SessionId; agentOptions?: AgentOptions; setup?: (agentCtx: Context) => unknown }
      resumed.push({ sessionId: o.resumeSessionId })
      if (o.setup !== undefined) await o.setup(ctx)
      const agent = makeAgent(o.resumeSessionId, undefined, undefined, o.agentOptions)
      return { agent, dispose: async () => { agent.internals.disposed = true; byId.delete(o.resumeSessionId) } }
    },
    get(id) { return byId.get(id) },
  }
}

export const mockLlm = {
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

export const mockVisionLlm = {
  listProviders: () => [{ id: 'vision', name: 'Vision Provider' }],
  listModels: async () => [{
    provider: 'vision',
    id: 'vision-model',
    name: 'Vision Model',
    inputModalities: ['text', 'image'],
  }],
  resolveModelInfo: async () => ({
    provider: 'vision',
    id: 'vision-model',
    name: 'Vision Model',
    inputModalities: ['text', 'image'],
  }),
}

/** Two providers that both list the id "shared": exercises the catalog dedup. */
export const collidingLlm = {
  listProviders: () => [{ id: 'a' }, { id: 'b' }],
  listModels: async (provider: string) => provider === 'a'
    ? [{ id: 'shared', name: 'Shared A' }, { id: 'only-a', name: 'Only A' }]
    : [{ id: 'shared', name: 'Shared B' }, { id: 'only-b', name: 'Only B' }],
}

export function makeMockPersistence() {
  const header = { version: 0, isSeeded: false, id: SessionId('persisted-session'), createdAt: 0, cwd: '/tmp/proj', agentPreset: 'standard' }
  const loaded: string[] = []
  const events: SessionEvent[] = []
  const closed: string[] = []
  const flushed = new Map<SessionId, { header: Agent['session']['header']; events: readonly SessionEvent[]; inheritedEventCount: SessionLogOffset }>()
  const persistence = {
    header,
    loaded,
    closed,
    events,
    capture(session: Agent['session']) {
      flushed.set(session.id, { header: session.header, events: session.snapshotEvents(), inheritedEventCount: session.inheritedEventCount ?? SessionLogOffset(0) })
    },
    list: async (): Promise<readonly SessionPersistenceSnapshot[]> => [{ header, revision: SessionPersistenceRevision('mock') }],
    stat: async (id: SessionId) => (await persistence.list()).find(snapshot => snapshot.header.id === id),
    readEvents: async (id: SessionId): Promise<readonly SessionEvent[]> => Object.freeze([...(flushed.get(id)?.events ?? events)]),
    open: async (id: SessionId, access: SessionAccess): Promise<SessionHandle> => {
      expect(access).toBe('read')
      loaded.push(id)
      const snapshot = (await persistence.list()).find(snapshot => snapshot.header.id === id)
      let isClosed = false
      const close = async (): Promise<void> => {
        await Promise.resolve()
        if (!isClosed) closed.push(id)
        isClosed = true
      }
      return {
        id,
        header: Object.freeze({ ...(flushed.get(id)?.header ?? snapshot?.header ?? header) }),
        inheritedEventCount: flushed.get(id)?.inheritedEventCount ?? SessionLogOffset(0),
        access,
        read: async (offset = 0, length = Number.MAX_SAFE_INTEGER) => {
          expect(isClosed).toBe(false)
          return { eventState: 'detached', events: (await persistence.readEvents(id)).slice(offset, offset + length) }
        },
        append: async () => { throw new Error('read handle must not append') },
        flush: async () => { throw new Error('read handle must not flush') },
        close,
        [Symbol.asyncDispose]: close,
      }
    },
  }
  return persistence
}

export function makeMockPresets() {
  const resolved: Array<string | undefined> = []
  const mounted: string[] = []
  const recomposed: string[] = []
  return {
    resolved,
    mounted,
    recomposed,
    serviceFor: vi.fn((agent: Agent, name: string) => agent.ctx.get(name)),
    list: async () => [
      { id: 'standard' },
      { id: 'ptc' },
      { id: 'minimal' },
      { id: 'cordis' },
    ],
    resolve: async (id?: string) => {
      resolved.push(id)
      const chosen = id ?? 'standard'
      if (chosen === 'standard' || chosen === 'ptc' || chosen === 'minimal' || chosen === 'cordis') return { id: chosen }
      throw new Error('agent-presets: preset "' + chosen + '" not found (available: standard, cordis, minimal, ptc)')
    },
    mount: async (_agentCtx: unknown, id?: string) => {
      mounted.push(id ?? 'standard')
      return { id: id ?? 'standard' }
    },
    recompose: async (_agentCtx: unknown, id: string) => {
      recomposed.push(id)
      return { id }
    },
  }
}

export const mockAppExit = {
  calls: [] as number[],
  exit: (code: number): void => { mockAppExit.calls.push(code) },
}

export const mockDefaultModel = {
  saved: [] as Array<{ provider: string; model: string; reasoningEffort?: string }>,
  current: undefined as { provider: string; model: string; reasoningEffort?: string } | undefined,
  currentSelection: () => mockDefaultModel.current,
  saveSelection: async (next: { provider: string; model: string; reasoningEffort?: string }) => {
    mockDefaultModel.saved.push(next)
    mockDefaultModel.current = next
  },
}

export const mockSessionsStore = {
  flushed: [] as unknown[],
  flush: async (session: object) => { mockSessionsStore.flushed.push(session); return true },
}

export const mockAttachments = {
  saveImages: async (inputs: ReadonlyArray<{ data: Uint8Array; mediaType: string }>) =>
    inputs.map((input, index) => ({
      attachmentId: 'test-image-' + String(index),
      mediaType: input.mediaType,
      bytes: input.data.byteLength,
      width: 1,
      height: 1,
    })),
}

export interface LeaderHarness {
  ctx: Context
  pluginCtx: Context
  socketPath: string
  registry: MockRegistry
  persistence: ReturnType<typeof makeMockPersistence>
  presets: ReturnType<typeof makeMockPresets> | undefined
  /** Stubbed `dsh-mcp-client` fibers backing `x.ai/mcp/list`; restored by teardown. */
  mcpFibers: { mockRestore(): void } | undefined
}

export interface HarnessOptions {
  presets?: boolean
  manualIdle?: boolean
  llm?: unknown
  model?: string
  settings?: unknown
  attachments?: unknown
  commands?: unknown
  userQuestions?: unknown
  credentials?: unknown
  permissionPresets?: unknown
  planMode?: unknown
  sessionsStore?: unknown
  tools?: unknown
  skills?: unknown
  subagents?: unknown
  goals?: unknown
  jobs?: unknown
  sessionProjections?: unknown
  sessionTitle?: unknown
  sessionQuery?: unknown
  sessionProjectionCache?: unknown
  /** MCP servers the stub host reports as mounted by the mcp-client plugin. */
  mcpServers?: Array<{ serverName: string; transport?: string }>
  combineQueuedPrompts?: boolean
  followUpBehavior?: 'queue' | 'steer'
  idleExitMs?: number
}

export interface ClientHandle {
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

export async function makeClient(socketPath: string): Promise<ClientHandle> {
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
      // Native lifecycle snapshots are ambient state, asserted through `all`.
      if (msg.method === 'x.ai/session_notification') continue
      // Ambient roster and activity updates stay out of the request/next()
      // queue; lifecycle assertions read them from `all`.
      const params = msg.params
      if (msg.method === 'session/update' && typeof params === 'object' && params !== null && 'update' in params) {
        const update = params.update
        if (typeof update === 'object' && update !== null && 'sessionUpdate' in update
          && (update.sessionUpdate === 'available_commands_update' || update.sessionUpdate === 'session_info_update')) continue
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
      const deferred: Record<string, unknown>[] = []
      for (;;) {
        const msg = await next()
        if (msg.id === id) {
          queue.unshift(...deferred)
          return msg
        }
        deferred.push(msg)
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
export async function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return
    if (Date.now() > deadline) throw new Error('waitFor timed out')
    await new Promise<void>((resolveTick) => { setTimeout(resolveTick, 1) })
  }
}

/** Fire a JSON-RPC request without awaiting its response (deferred-response tests). */
export function sendRequest(client: ClientHandle, id: number, method: string, params?: unknown): void {
  const payload: Record<string, unknown> = { jsonrpc: '2.0', id, method }
  if (params !== undefined) payload.params = params
  client.send({ type: 'acp', payload: JSON.stringify(payload) })
}

/** Consume frames until the response with id arrives, dropping the rest. */
export async function waitForId(client: ClientHandle, id: number): Promise<Record<string, unknown>> {
  for (;;) {
    const msg = await client.next()
    if (msg.id === id) return msg
  }
}

/** Consume frames until every requested id has been answered (order-independent). */
export async function collectIds(client: ClientHandle, ids: number[]): Promise<Map<number, Record<string, unknown>>> {
  const found = new Map<number, Record<string, unknown>>()
  while (found.size < ids.length) {
    const msg = await client.next()
    if (typeof msg.id === 'number' && ids.includes(msg.id)) found.set(msg.id, msg)
  }
  return found
}

export async function makeHarness(
  options: HarnessOptions = {},
): Promise<LeaderHarness> {
  const ctx = new Context()
  const registry = makeMockRegistry(ctx, options.manualIdle === true)
  const persistence = makeMockPersistence()
  const presets = options.presets === true ? makeMockPresets() : undefined
  ctx.provide('agents', registry as unknown as Context['agents'])
  ctx.provide('llm', options.llm ?? mockLlm as unknown as Context['llm'])
  ctx.provide('attachments', (options.attachments ?? mockAttachments) as unknown as Context['attachments'])
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
  if (options.goals !== undefined) ctx.provide('goals', options.goals as never)
  if (options.jobs !== undefined) Object.assign(new (class extends Service {})(ctx, 'jobs'), options.jobs)
  if (options.sessionTitle !== undefined) ctx.provide('sessionTitle', options.sessionTitle as never)
  if (options.sessionQuery !== undefined) ctx.provide('sessionQuery', options.sessionQuery as never)
  if (options.sessionProjectionCache !== undefined) ctx.provide('sessionProjectionCache', options.sessionProjectionCache as never)
  ctx.provide('sessionPersistence', persistence as unknown as Context['sessionPersistence'])
  const sessionsStore = (options.sessionsStore ?? mockSessionsStore) as typeof mockSessionsStore
  ctx.provide('sessions', { ...sessionsStore, flush: async (session: Agent['session']) => {
    const result = await sessionsStore.flush(session)
    persistence.capture(session)
    return result
  } } as unknown as Context['sessions'])
  Object.assign(new SessionProjectionRegistry(ctx), options.sessionProjections)
  if (presets !== undefined) Object.assign(new (class extends Service {})(ctx, 'agentPresets'), presets)
  ctx.provide('agentDefaultModel', mockDefaultModel as unknown as Context['agentDefaultModel'])
  ctx.provide('appExit', mockAppExit.exit)
  const socketPath = resolve('/tmp', 'dgl-' + String(process.pid) + '-' + randomUUID().slice(0, 12) + '.sock')
  // The bridge lists MCP servers from the mcp-client fibers that `session/new`
  // mounts, so a stub host with only a tool catalog must model that mount.
  const mcpFibers = options.mcpServers === undefined ? undefined : (() => {
    const get = ctx.registry.get.bind(ctx.registry)
    return vi.spyOn(ctx.registry, 'get').mockImplementation(plugin => plugin === McpClient
      ? { fibers: options.mcpServers!.map(server => ({ ctx, config: { ...server } })) } as never
      : get(plugin))
  })()
  let pluginCtx: Context | undefined
  await ctx.plugin({
    name: 'grok-leader-test',
    inject: [...GrokLeader.inject],
    apply: (inner: Context) => {
      pluginCtx = inner
      GrokLeader.apply(inner, { socketPath, ...options.model === undefined ? {} : { model: options.model }, ...options.combineQueuedPrompts === undefined ? {} : { combineQueuedPrompts: options.combineQueuedPrompts }, ...options.followUpBehavior === undefined ? {} : { followUpBehavior: options.followUpBehavior }, ...options.idleExitMs === undefined ? {} : { idleExitMs: options.idleExitMs } })
    },
  })
  return { ctx, pluginCtx: pluginCtx!, socketPath, registry, persistence, presets, mcpFibers }
}

export const register = (client: ClientHandle): void => {
  client.send({ type: 'register', client_type: 'grok-shell', mode: 'stdio' })
}

/** Per-describe socket harness. `start` builds a fresh leader and connected
 * client; after each test the client and native fiber are disposed and the
 * shared model/session mocks are reset. */
export function useLeaderHarness(): (options?: HarnessOptions) => Promise<LeaderHarness & { client: ClientHandle }> {
  let harness: LeaderHarness | undefined
  let client: ClientHandle | undefined
  afterEach(async () => {
    client?.socket.destroy()
    harness?.mcpFibers?.mockRestore()
    await harness?.ctx.fiber.dispose()
    harness = undefined
    client = undefined
    mockDefaultModel.saved.length = 0
    mockDefaultModel.current = undefined
    mockSessionsStore.flushed.length = 0
  })
  return async (options: HarnessOptions = {}) => {
    harness = await makeHarness(options)
    client = await makeClient(harness.socketPath)
    return { ...harness, client }
  }
}
