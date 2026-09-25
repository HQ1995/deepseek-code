import { randomUUID } from 'node:crypto'
import { isAbsolute } from 'node:path'
import type { Agent, AgentHandle, AgentRegistry, CreateAgentOptions } from '@deepseek-ai/dsh-agent'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceNotFoundError, type SessionInspection, type SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { internalError, invalidParams, paramRecord, sessionIdParam } from './acp.ts'
import { assertMcpTransports, sessionCwd, type ExecutionWorld } from './execution-world.ts'
import { AcpMcpConfigError, mountMcpConfigs, resolveAcpMcpConfigs, type McpClientConfig } from './mcp.ts'
import { createPromptQueues, type PromptQueue } from './prompt-queue.ts'
import { createSessionOutput, type SessionOutput, type SessionOutputHost } from './session-output.ts'
import type { SessionModel, createSessionModels } from './session-models.ts'
import type { createSessionPresets } from './session-presets.ts'
import type { createSessionRegistry } from './session-registry.ts'
import type { createNativeInteractions } from './native-interactions.ts'
import { createSessionWork, type SessionWork } from './session-work.ts'
import type { SessionDiscovery } from './session-discovery.ts'
import { textBlocks, type ContextProjectionValues } from './projection.ts'
import { registryPresenter } from './tool-views.ts'

/** Per-session protocol state. */
export interface SessionRecord {
  agent: Agent
  /** Exact owned-agent disposer; resolves after registry, loop, and session teardown. */
  dispose: () => Promise<void>
  /** Client that created or loaded this session; reverse requests route here. */
  clientId: number
  /** Owned model reference, durable choices and pending persistence writes. */
  model: SessionModel
  /** YOLO sessions pre-approve permission requests without a client roundtrip. */
  yolo: boolean
  output: SessionOutput
  /** Accepted user prompts, oldest first; served by x.ai/prompt_history. */
  prompts: string[]
  queue: PromptQueue
  work: SessionWork
  /** Deferred startup notification; cleared before session disposal. */
  mcpInitTimer: ReturnType<typeof setTimeout> | undefined
}


export type PersistenceLike = Pick<SessionPersistence, 'list' | 'stat'>
type Meta = Record<string, unknown> | null | undefined
type Presets = Pick<ReturnType<typeof createSessionPresets<SessionRecord>>, 'prepare' | 'retire' | 'assertReady'>
type Preset = Awaited<ReturnType<Presets['prepare']>>
type Creation = { kind: 'new' | 'fork'; options: Omit<CreateAgentOptions, 'setup' | 'agentOptions'> }
  | { kind: 'load'; sessionId: SessionId; noReplay: boolean }
interface LifecycleHost {
  agents: Pick<AgentRegistry, 'create' | 'resume' | 'get'>
  registry: ReturnType<typeof createSessionRegistry<SessionRecord>>
  models: Pick<ReturnType<typeof createSessionModels<SessionRecord>>, 'prepare'>
  presets: Presets
  persistence(): PersistenceLike | undefined
  flush(session: Agent['session']): Promise<unknown>
  discovery: Pick<SessionDiscovery, 'inspect' | 'select'>
  client(id: number): { readonly closed: boolean; notify(method: string, params: unknown): void; drain?(): Promise<void> | undefined } | undefined
  queue: { combineQueued: boolean; followUpSteer: boolean }
  /** Where this profile's tools run; remote sessions stay in the remote workspace. */
  world(): ExecutionWorld
  /** Why a remote workspace cannot take sessions (its SSH row did not connect). */
  remoteUnavailable?(): string | undefined
  permissions: Pick<ReturnType<typeof createNativeInteractions<SessionRecord>>, 'validateMeta' | 'apply' | 'assertReady'>
  contextValues(record: SessionRecord): ContextProjectionValues
  projectImages: SessionOutputHost['projectImages']
  messageProjection?: SessionOutputHost['messageProjection']
  logger: { warn(message: string): void }
  /** A published session finished initializing and accepts input. */
  unblocked(record: SessionRecord): void
  /** A leader-wide system note the next opened session shows once. */
  notice?: { pending(): boolean; take(): string | undefined }
  views: {
    status(record: SessionRecord, replay?: boolean): void
    mode(record: SessionRecord): void
    children(record: SessionRecord, replay: boolean): Promise<void>
    tasks(record: SessionRecord): void | Promise<void>
    commands(record: SessionRecord): void
  }
}

/** Native create/resume/fork and bridge resource adoption share one owner.
 * The registry owns publication/retirement; this module owns preparation,
 * reservations, initialization admission, replay ordering and failed adoption.
 * The native factory still owns its driver and unpublished setup rollback. */
export function createSessionLifecycle(host: LifecycleHost) {
  const { agents, registry, presets: sessionPresets, persistence } = host
  const sessions = registry.records, ownedRecord = registry.owned
  const attachPrompts = createPromptQueues({ ...host.queue, logger: host.logger })
  const initializing = new WeakSet<SessionRecord>(), reservations = new Set<SessionId>()
  const assertReady = (record: SessionRecord) => {
    registry.assertReady(record)
    if (initializing.has(record)) throw invalidParams('session is still initializing')
    sessionPresets.assertReady(record)
    host.permissions.assertReady(record)
  }
  const writable = (clientId: number, id: SessionId | undefined) => {
    const record = ownedRecord(clientId, id)
    if (record !== undefined) assertReady(record)
    return record
  }
  const reserved = async <R>(id: SessionId, operation: () => Promise<R>): Promise<R> => {
    if (reservations.has(id)) throw invalidParams('session id is already being initialized: ' + id)
    reservations.add(id)
    try { return await operation() } finally { reservations.delete(id) }
  }
  const persistedSessionIdInUse = async (id: SessionId) => {
    const store = persistence()
    if (store === undefined) throw internalError('session persistence is not configured')
    // One stored id is a point query: listing would walk every project and
    // session directory and header-read each log just to test membership, and
    // an unrelated unreadable log would fail the check for every pinned id.
    return (await store.stat(id)) !== undefined
  }
  const cleanup = async (steps: Array<() => Promise<unknown>>): Promise<void> => {
    const failures: unknown[] = []
    for (const step of steps) { try { await step() } catch (error) { failures.push(error) } }
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'session resource disposal failed: ' + failures.map(errorChain).join('; '))
  }
  const attach = (clientId: number, handle: AgentHandle, model: SessionModel, meta: Meta): SessionRecord => {
    let disposal: Promise<void> | undefined
    const record: SessionRecord = {
      agent: handle.agent, clientId, model, yolo: meta?.yoloMode === true,
      prompts: [], mcpInitTimer: undefined,
      dispose: () => disposal ??= Promise.resolve().then(() => cleanup([
        () => record.work.dispose(),
        () => sessionPresets.retire(record), () => model.dispose(),
        () => record.output.dispose(), () => handle.dispose(),
      ])),
      output: createSessionOutput({
        drain: () => host.client(clientId)?.drain?.(),
        sessionId: String(handle.agent.session.id), cwd: () => record.agent.session.header.cwd,
        isLive: () => registry.ownedAgent(record.agent) === record,
        promptId: () => record.queue.promptId,
        notify: (method, params) => host.client(clientId)?.notify(method, params),
        contextValues: () => host.contextValues(record), contextRevision: () => record.agent.session.seq,
        projectImages: host.projectImages, logger: host.logger,
        ...host.messageProjection === undefined ? {} : { messageProjection: host.messageProjection },
        presenter: registryPresenter(handle.agent),
      }),
      work: createSessionWork({
        isLive: () => registry.acceptsInput(record) && agents.get(record.agent.id) === record.agent && host.client(clientId)?.closed === false,
        assertReady: () => assertReady(record),
      }),
      queue: attachPrompts({
        sessionId: String(handle.agent.session.id), agent: handle.agent,
        isLive: () => registry.acceptsInput(record) && !initializing.has(record) && agents.get(record.agent.id) === record.agent,
        notify: (method, params) => host.client(clientId)?.notify(method, params),
        echo: text => record.output.update({ sessionUpdate: 'user_message_chunk', content: { type: 'text', text } }, false, Date.now()),
        flushOutput: () => record.output.flush(),
      }),
    }
    initializing.add(record)
    return record
  }
  const present = async (record: SessionRecord, creation: Creation, events: readonly SessionEvent[]) => {
    const { views } = host
    views.status(record, creation.kind === 'load' ? true : undefined)
    const pending: Promise<unknown>[] = []
    const startChildren = () => {
      const work = views.children(record, true)
      void work.catch(() => {})
      pending.push(work)
      return work
    }
    // Keep the load replay window open until transcript and all async views
    // finish, even if a sibling projection fails. Partial publication is retired
    // by activate(), not left as a stranded live session after an error response.
    const failures: unknown[] = []
    try {
      if (creation.kind === 'new') await startChildren()
      if (creation.kind === 'load') startChildren()
      const tasks = views.tasks(record)
      if (tasks !== undefined) { void tasks.catch(() => {}); pending.push(tasks) }
      views.commands(record)
      if (creation.kind === 'fork') startChildren()
      if (creation.kind === 'load') {
        for (const event of events) {
          if (event.type !== 'user/message' || (event.data as { source?: { kind?: unknown } }).source?.kind !== 'user') continue
          const text = textBlocks(event.data.content).map(block => block.text).join('')
          if (text.trim().length > 0) record.prompts.push(text)
        }
        const replay = record.output.restore(events, !creation.noReplay)
        void replay.catch(() => {})
        pending.push(replay)
      }
    } catch (error) { failures.push(error) }
    const results = await Promise.allSettled(pending)
    failures.push(...results.flatMap(result => result.status === 'rejected' ? [result.reason as unknown] : []))
    const unique = [...new Set(failures)]
    if (unique.length === 1) throw unique[0]
    if (unique.length > 1) throw new AggregateError(unique, 'session initialization projections failed')
    if (registry.ownedAgent(record.agent) !== record || host.client(record.clientId)?.closed !== false) throw invalidParams('session closed during initialization')
    initializing.delete(record)
    host.unblocked(record)
    const notice = record.model.notice
    if (creation.kind === 'load' && notice === undefined && host.notice?.pending() !== true) return
    // After the response: a new session's id is unknown to the client until then.
    const conn = host.client(record.clientId)!
    record.mcpInitTimer = setTimeout(() => {
      record.mcpInitTimer = undefined
      if (ownedRecord(record.clientId, record.agent.session.id) !== record || host.client(record.clientId) !== conn) return
      if (creation.kind !== 'load') { conn.notify('_x.ai/mcp_initialized', { sessionId: record.agent.session.id }); views.mode(record) }
      // The TUI's display-only system notes: this session's own, and a
      // leader-wide one only the first session to get here takes.
      const leader = host.notice?.take()
      const notes = [notice, leader].filter((note): note is string => note !== undefined)
      if (notes.length > 0) record.output.notify('x.ai/session_notification', { update: { sessionUpdate: 'image_dropped', notes } })
    }, 50)
  }
  const activate = async (clientId: number, meta: Meta, events: readonly SessionEvent[], preset: Preset, creation: Creation, mcpConfigs?: McpClientConfig[]): Promise<SessionRecord> => {
    const model = await host.models.prepare(meta, events)
    let handle: AgentHandle | undefined, record: SessionRecord | undefined, published = false
    const assertClient = () => {
      registry.assertOpen()
      if (host.client(clientId)?.closed !== false) throw invalidParams('client disconnected')
    }
    try {
      assertClient()
      const setup: NonNullable<CreateAgentOptions['setup']> = async agentCtx => {
        model.install(agentCtx)
        if (preset.mount !== undefined) await preset.mount(agentCtx)
        if (mcpConfigs !== undefined) await mountMcpConfigs(agentCtx, mcpConfigs)
      }
      handle = await (creation.kind === 'load'
        ? agents.resume({ resumeSessionId: creation.sessionId, agentOptions: model.agentOptions, setup })
        : agents.create({ ...creation.options, agentOptions: model.agentOptions, setup }))
      assertClient()
      record = attach(clientId, handle, model, meta)
      host.permissions.apply(record, meta)
      assertClient()
      await preset.commit(record)
      await registry.publish(record.agent.session.id, record)
      published = true
      await present(record, creation, events)
      return record
    } catch (error) {
      try {
        if (record !== undefined) {
          if (published) await registry.close(record)
          else await cleanup([() => record!.queue.dispose(), () => record!.dispose()])
        } else await cleanup([() => model.dispose(), async () => handle?.dispose()])
      } catch (release) { throw new AggregateError([error, release], 'session initialization and cleanup failed: ' + errorChain(error) + '; ' + errorChain(release)) }
      throw error
    }
  }
  /** Validate the workspace and translate its standard ACP MCP declarations
   * before creating or replacing an Agent. */
  const workspaceParams = async (p: Record<string, unknown>): Promise<{
    cwd: string
    mcpConfigs: McpClientConfig[]
  }> => {
    const requested = p.cwd
    if (typeof requested !== 'string' || !isAbsolute(requested)) throw invalidParams('cwd must be an absolute path: ' + String(requested))
    const world = host.world(), cwd = sessionCwd(world, requested)
    // Without its SSH providers a session would fail later with bare tool diagnostics.
    const unavailable = host.remoteUnavailable?.()
    if (unavailable !== undefined) throw invalidParams(unavailable)
    try {
      const mcpConfigs = await resolveAcpMcpConfigs(p.mcpServers, cwd)
      assertMcpTransports(world, mcpConfigs)
      return { cwd, mcpConfigs }
    } catch (error) {
      if (error instanceof AcpMcpConfigError) throw invalidParams(error.message)
      throw error
    }
  }


  const newSession = async (clientId: number, params: unknown) => {
    const p = paramRecord(params, 'session/new'), { cwd, mcpConfigs } = await workspaceParams(p)
    if (Array.isArray(p.additionalDirectories) && p.additionalDirectories.length > 0) throw invalidParams('additionalDirectories is not supported')
    const meta = p._meta as Meta
    host.permissions.validateMeta(meta, 'session/new')
    const suppliedId = meta?.sessionId
    const sessionId = typeof suppliedId === 'string' && suppliedId.length > 0 ? SessionId(suppliedId) : SessionId(randomUUID())
    return reserved(sessionId, async () => {
      if (sessions.has(sessionId) || (typeof suppliedId === 'string' && await persistedSessionIdInUse(sessionId))) throw invalidParams('session id is already in use: ' + sessionId)
      const preset = await sessionPresets.prepare({ kind: 'new', meta })
      await activate(clientId, meta, [], preset, { kind: 'new', options: { sessionId, meta: { cwd, ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset } } } }, mcpConfigs)
      return { sessionId }
    })
  }
  const loadSession = async (clientId: number, params: unknown) => {
    const p = paramRecord(params, 'session/load')
    const sessionId = sessionIdParam(p.sessionId)
    if (sessionId === undefined) throw invalidParams('session/load requires a sessionId')
    const { mcpConfigs } = await workspaceParams(p)
    return reserved(sessionId, async () => {
      const existing = sessions.get(sessionId)
      if (existing !== undefined && existing.clientId !== clientId && host.client(existing.clientId) !== undefined) throw invalidParams('unknown session: ' + sessionId)
      const meta = p._meta as Meta
      host.permissions.validateMeta(meta, 'session/load')
      if (persistence() === undefined) throw internalError('session persistence is not configured')
      // Live preset policy is already maintained; no preflight transcript copy.
      let inspection: SessionInspection = existing === undefined ? await host.discovery.inspect(sessionId)
        : { meta: existing.agent.session.header, inheritedEventCount: existing.agent.session.inheritedEventCount, events: [] }
      const preset = await sessionPresets.prepare({ kind: 'load', meta, source: { header: inspection.meta, events: inspection.events }, live: existing })
      if (existing !== undefined) inspection = await registry.reload(existing,
        signal => host.discovery.inspect(sessionId, { end: existing.agent.session.seq, signal }), () => existing.model.settle())
      await activate(clientId, meta, inspection.events, preset, { kind: 'load', sessionId, noReplay: meta?.noReplay === true }, mcpConfigs)
      return {}
    })
  }
  const forkSession = async (clientId: number, params: unknown): Promise<unknown> => {
    const p = paramRecord(params, 'x.ai/session/fork')
    host.permissions.validateMeta(p, 'x.ai/session/fork')
    const sourceId = sessionIdParam(p.sourceSessionId)
    if (sourceId === undefined) throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
    const liveSource = sessions.get(sourceId)
    if (liveSource !== undefined && ownedRecord(clientId, sourceId) !== liveSource) {
      throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
    }
    let sourceHeader: { agentPreset?: string; cwd?: string }
    let events: readonly SessionEvent[]
    if (liveSource !== undefined) {
      const inspection = await liveSource.work.read(async scope => {
        const { header, seq } = liveSource.agent.session
        await host.flush(liveSource.agent.session)
        scope.assertActive()
        const snapshot = await host.discovery.inspect(sourceId, { end: seq, signal: scope.signal })
        // Retain the request-time header and prefix even if the live source appends.
        return { ...snapshot, meta: header }
      })
      sourceHeader = inspection.meta
      events = inspection.events
    } else {
      const store = persistence()
      if (store === undefined) throw internalError('session persistence is not configured')
      try {
        const inspection = await host.discovery.inspect(sourceId)
        sourceHeader = inspection.meta
        events = inspection.events
      } catch (error) {
        if (error instanceof SessionPersistenceNotFoundError) throw invalidParams('unknown source session: ' + String(p.sourceSessionId))
        throw error
      }
    }
    let rewindPromptText: string | undefined
    if (p.targetPromptIndex !== undefined) {
      if (typeof p.targetPromptIndex !== 'number' || !Number.isInteger(p.targetPromptIndex) || p.targetPromptIndex < 0) {
        throw invalidParams('targetPromptIndex must be a non-negative integer')
      }
    }
    const targetPromptIndex = typeof p.targetPromptIndex === 'number' ? p.targetPromptIndex : undefined
    if (targetPromptIndex !== undefined) {
      const promptEvents = events
        .map((event, index) => ({ event, index }))
        .filter(({ event }) => event.type === 'user/message'
          && (event.data as { source?: { kind?: unknown } }).source?.kind === 'user')
      const target = promptEvents[targetPromptIndex]
      if (target === undefined) throw invalidParams('unknown targetPromptIndex: ' + targetPromptIndex)
      rewindPromptText = textBlocks((target.event.data as { content: unknown }).content).map(block => block.text).join('')
      let boundary = target.index
      for (let index = target.index - 1; index >= 0; index -= 1) {
        if (events[index]?.type === 'turn/start') {
          boundary = index
          break
        }
        if (events[index]?.type === 'turn/end') break
      }
      events = events.slice(0, boundary)
    }
    if (p.newCwd !== undefined && (typeof p.newCwd !== 'string' || !isAbsolute(p.newCwd))) {
      throw invalidParams('newCwd must be an absolute path')
    }
    const newCwd = typeof p.newCwd === 'string' ? p.newCwd : sourceHeader.cwd
    if (typeof newCwd !== 'string' || !isAbsolute(newCwd)) throw invalidParams('newCwd must be an absolute path')
    const suppliedId = typeof p.newSessionId === 'string' && p.newSessionId.length > 0 ? p.newSessionId : undefined
    const sessionId = suppliedId === undefined ? SessionId(randomUUID()) : SessionId(suppliedId)
    return reserved(sessionId, async () => {
      if (sessions.has(sessionId)
        || (suppliedId !== undefined && await persistedSessionIdInUse(sessionId))) {
        throw invalidParams('session id is already in use: ' + String(sessionId))
      }
      const lastTurnBoundary = events.findLast(event => event.type === 'turn/start' || event.type === 'turn/end')
      // Match the native fork boundary: no events from an unfinished turn are inherited.
      if (lastTurnBoundary?.type === 'turn/start') throw invalidParams('cannot fork while a turn is open')
      const seed = events
      const preset = await sessionPresets.prepare({ kind: 'fork', source: { header: sourceHeader, events } })
      await activate(clientId, p, events, preset, {
        kind: 'fork', options: {
          sessionId, seed, inheritedEventCount: SessionLogOffset(seed.length),
          meta: { cwd: newCwd, parentSession: sourceId, isSeeded: true, ...preset.agentPreset === undefined ? {} : { agentPreset: preset.agentPreset } },
        },
      })
      return {
        newSessionId: String(sessionId),
        ...rewindPromptText === undefined ? {} : { promptText: rewindPromptText },
      }
    })
  }

  const rewindPoints = async (clientId: number, params: unknown): Promise<Record<string, unknown>> => {
    const p = paramRecord(params, 'x.ai/rewind/points')
    const sessionId = sessionIdParam(p.sessionId)
    const record = ownedRecord(clientId, sessionId)
    if (sessionId === undefined || record === undefined) {
      throw invalidParams('unknown session: ' + String(p.sessionId))
    }
    return record.work.read(async scope => {
      const end = record.agent.session.seq
      await host.flush(record.agent.session)
      scope.assertActive()
      let promptIndex = 0
      const points = await host.discovery.select(sessionId, { end, signal: scope.signal }, event => {
        if (event.type !== 'user/message' || (event.data as { source?: { kind?: unknown } }).source?.kind !== 'user') return
        return {
          promptIndex: promptIndex++,
          createdAt: new Date(event.time).toISOString(),
          numFileSnapshots: 0,
          promptPreview: textBlocks((event.data as { content: unknown }).content).map(block => block.text).join(''),
          hasFileChanges: false,
        }
      })
      return { rewindPoints: points }
    })
  }

  const executeRewind = async (clientId: number, params: unknown): Promise<Record<string, unknown>> => {
    const p = paramRecord(params, 'x.ai/rewind/execute')
    const sourceSessionId = sessionIdParam(p.sessionId)
    const source = ownedRecord(clientId, sourceSessionId)
    if (sourceSessionId === undefined || source === undefined) {
      throw invalidParams('unknown session: ' + String(p.sessionId))
    }
    const targetPromptIndex = typeof p.targetPromptIndex === 'number' ? p.targetPromptIndex : Number.NaN
    if (!Number.isInteger(targetPromptIndex) || targetPromptIndex < 0) {
      throw invalidParams('targetPromptIndex must be a non-negative integer')
    }
    const forked = await forkSession(clientId, {
      sourceSessionId,
      newCwd: source.agent.session.header.cwd,
      targetPromptIndex,
    }) as { newSessionId: string; promptText?: string }
    return {
      success: true,
      targetPromptIndex,
      revertedFiles: [],
      cleanFiles: [],
      conflicts: [],
      mode: 'conversation_only',
      newSessionId: forked.newSessionId,
      ...forked.promptText === undefined ? {} : { promptText: forked.promptText },
    }
  }


  /** One session's accepted prompts, most-recent-first (scrollback/up-arrow). */
  const promptHistory = (clientId: number, params: unknown): { prompts: string[] } => {
    const p = paramRecord(params, 'x.ai/prompt_history')
    const scoped = typeof p.filter_session_id === 'string'
      ? SessionId(p.filter_session_id)
      : typeof p.session_id === 'string'
        ? SessionId(p.session_id)
        : undefined
    const record = ownedRecord(clientId, scoped)
    if (scoped !== undefined && record === undefined) throw invalidParams('unknown session: ' + String(scoped))
    return { prompts: record === undefined ? [] : [...record.prompts].reverse() }
  }


  return {
    new: (clientId: number, params: unknown) => registry.operation(clientId, () => newSession(clientId, params)),
    load: (clientId: number, params: unknown) => registry.operation(clientId, () => loadSession(clientId, params)),
    fork: (clientId: number, params: unknown) => registry.operation(clientId, () => forkSession(clientId, params)),
    rewind: (clientId: number, params: unknown) => registry.operation(clientId, () => executeRewind(clientId, params)),
    points: rewindPoints, history: promptHistory,
    assertReady, writable,
    async close(clientId: number, params: unknown) {
      const p = paramRecord(params, 'session/close')
      const record = ownedRecord(clientId, sessionIdParam(p.sessionId))
      if (record === undefined) throw invalidParams('unknown session: ' + String(p.sessionId))
      await registry.close(record)
      return {}
    },
  }
}
