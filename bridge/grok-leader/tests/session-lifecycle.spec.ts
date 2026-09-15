import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent, AgentHandle, CreateAgentOptions, ResumeAgentOptions } from '@deepseek-ai/dsh-agent'
import { SessionId, SessionLogOffset, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection } from '@deepseek-ai/dsh-session-persistence'
import { createSessionLifecycle, type PersistenceLike, type SessionRecord } from '../src/session-lifecycle.ts'
import { createSessionRegistry } from '../src/session-registry.ts'
import { createSessionDiscovery } from '../src/session-discovery.ts'
import type { SessionModel } from '../src/session-models.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())) })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const event = (type: string, data: unknown = {}, seq = 0) => ({ type, data, seq, time: 1 }) as SessionEvent
function fixture() {
  const order: string[] = [], notify = vi.fn(), client = { closed: false, notify }
  const clients = new Map([[1, client], [2, { closed: false, notify: vi.fn() }]])
  const native = new Map<string, Agent>(), durable = new Map<string, SessionInspection>()
  const histories = new WeakMap<Agent['session'], readonly SessionEvent[]>()
  const nativeDisposals = new Map<string, ReturnType<typeof vi.fn>>()
  const sessions = createSessionRegistry<SessionRecord>({
    clientIsLive: id => clients.get(id)?.closed === false,
    flush: async session => flush(session), cancelRequests: vi.fn(), logger: { warn: vi.fn() },
  })
  const flush = vi.fn(async (session: Agent['session']) => {
    order.push('flush:' + session.id)
    durable.set(session.id, { meta: session.header, inheritedEventCount: session.inheritedEventCount, events: [...histories.get(session)!] })
  })
  stops.push(() => sessions.dispose())
  const closeRead = vi.fn(async () => { order.push('close read') })
  const read = vi.fn(async (id: string, offset = 0, length = Number.MAX_SAFE_INTEGER, _options?: { signal?: AbortSignal }) => ({ events: durable.get(id)!.events.slice(offset, offset + length) }))
  const persistence = {
    list: vi.fn(async () => [...durable.values()].map(inspection => ({ header: inspection.meta }))),
    open: vi.fn(async (id: string) => ({ header: durable.get(id)!.meta, inheritedEventCount: durable.get(id)!.inheritedEventCount, read: (offset?: number, length?: number, options?: { signal?: AbortSignal }) => read(id, offset, length, options), close: closeRead })),
    stat: vi.fn(),
  }
  const install = vi.fn((ctx: Context) => { order.push('model install'); void ctx })
  const modelHandles: SessionModel[] = []
  const models = {
    prepare: vi.fn(async (_meta?: Record<string, unknown> | null, _events?: readonly SessionEvent[]): Promise<SessionModel> => {
      const model = {
        current: undefined, agentOptions: { provider: 'fixture', model: 'model' }, install,
        settle: vi.fn(async () => { order.push('model settle') }),
        dispose: vi.fn(async () => { order.push('model dispose') }),
      }
      modelHandles.push(model); return model
    }),
  }
  const mount = vi.fn(async () => { order.push('preset mount') })
  const commit = vi.fn(async (_record: SessionRecord) => { order.push('preset commit') })
  const presets = {
    prepare: vi.fn(async () => ({ agentPreset: 'standard', mount, commit })),
    retire: vi.fn(async (_record: SessionRecord) => { order.push('preset retire') }),
    assertReady: vi.fn(),
  }
  async function create(options: CreateAgentOptions, inspection?: SessionInspection): Promise<AgentHandle> {
    const id = options.sessionId, ctx = new Context()
    const events = [...(inspection?.events ?? options.seed ?? [])]
    const header = inspection?.meta ?? { id, createdAt: 1, version: 3, isSeeded: false, ...options.meta }
    const session = { id, header, inheritedEventCount: inspection?.inheritedEventCount ?? options.inheritedEventCount ?? SessionLogOffset(0),
      get seq() { return SessionLogOffset(events.length) },
      snapshotEvents: () => events, append: (type: string, data: unknown) => { const next = event(type, data, events.length); events.push(next); return next } }
    const agent = { id, session, ctx, options: options.agentOptions, status: 'idle', cancel: vi.fn(),
      followup: vi.fn(), steer: vi.fn(), whenIdle: vi.fn(async () => {}) } as unknown as Agent
    histories.set(agent.session, events)
    await options.setup?.(ctx, agent)
    native.set(id, agent)
    const dispose = vi.fn(async () => { order.push('native dispose:' + id); if (native.get(id) === agent) native.delete(id) })
    nativeDisposals.set(id, dispose)
    return { agent, dispose }
  }
  const agents = {
    get: (id: string) => native.get(id),
    create: vi.fn((options: CreateAgentOptions) => create(options)),
    resume: vi.fn((options: ResumeAgentOptions) => create({ sessionId: options.resumeSessionId, agentOptions: options.agentOptions, setup: options.setup }, durable.get(options.resumeSessionId))),
  }
  const views = {
    status: vi.fn((_record: SessionRecord, _replay?: boolean) => { order.push('status') }),
    children: vi.fn(async (_record: SessionRecord, _replay: boolean) => { order.push('children') }),
    tasks: vi.fn((_record: SessionRecord) => { order.push('tasks') }),
    commands: vi.fn((_record: SessionRecord) => { order.push('commands') }),
  }
  const permissions = vi.fn((_record: SessionRecord, _meta: unknown) => { order.push('permissions') })
  const discovery = createSessionDiscovery({ persistence: () => persistence as never, query: () => undefined,
    owns: () => false, onEvent: () => () => {} })
  stops.push(() => discovery.dispose())
  const host = { discovery, agents, registry: sessions, models, presets, flush, persistence: (): PersistenceLike | undefined => persistence as unknown as PersistenceLike,
    client: (id: number) => clients.get(id), queue: { combineQueued: false, followUpSteer: false },
    permissions: { validateMeta: vi.fn(), apply: permissions, assertReady: vi.fn() }, views, contextValues: () => ({}), projectImages: vi.fn(async (_event: SessionEvent, updates: unknown[]) => updates) as never,
    logger: { warn: vi.fn() } }
  const lifecycle = createSessionLifecycle(host)
  const add = async (id = 'root', meta: Record<string, unknown> = {}) => {
    await lifecycle.new(1, { cwd: '/tmp/workspace', mcpServers: [], _meta: { sessionId: id, ...meta } })
    return sessions.records.get(SessionId(id))!
  }
  return { lifecycle, sessions, native, nativeDisposals, durable, agents, models, modelHandles, install, presets, mount, commit,
    permissions, views, persistence, closeRead, read, flush, clients, client, notify, host, order, add }
}

describe('session lifecycle ownership', () => {
  it('installs model and preset before adoption, validates permissions before committing, and releases once', async () => {
    const f = fixture(), record = await f.add('root', { yoloMode: true })
    expect(record.yolo).toBe(true)
    expect(f.order.slice(0, 8)).toEqual(['model install', 'preset mount', 'permissions', 'preset commit', 'status', 'children', 'tasks', 'commands'])
    expect(f.agents.create).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'root', meta: { cwd: '/tmp/workspace', agentPreset: 'standard' }, agentOptions: { provider: 'fixture', model: 'model' } }))
    expect(f.lifecycle.writable(1, SessionId('root'))).toBe(record)
    expect(f.lifecycle.writable(2, SessionId('root'))).toBeUndefined()
    await f.lifecycle.close(1, { sessionId: 'root' })
    const first = record.dispose(); expect(record.dispose()).toBe(first); await first
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledTimes(1)
    expect(f.order.slice(-4)).toEqual(['flush:root', 'preset retire', 'model dispose', 'native dispose:root'])
    expect(f.sessions.records.size).toBe(0); expect(record.mcpInitTimer).toBeUndefined()
  })

  it('rejects unsupported workspace declarations before native composition and respects pinned durable ids', async () => {
    const f = fixture()
    await expect(f.lifecycle.new(1, { cwd: 'relative' })).rejects.toThrow('absolute path')
    await expect(f.lifecycle.new(1, { cwd: '/tmp', additionalDirectories: ['/elsewhere'] })).rejects.toThrow('additionalDirectories')
    const record = await f.add()
    await f.lifecycle.close(1, { sessionId: 'root' })
    await expect(f.add()).rejects.toThrow('already in use')
    expect(f.agents.create).toHaveBeenCalledTimes(1)
    expect(record.model.dispose).toHaveBeenCalledTimes(1)
  })

  it('reserves pinned ids across asynchronous native construction without blocking unrelated sessions', async () => {
    const f = fixture(), gate = deferred(), create = f.agents.create.getMockImplementation()!
    f.agents.create.mockImplementationOnce(async options => { await gate.promise; return create(options) })
    const first = f.add()
    await vi.waitFor(() => expect(f.agents.create).toHaveBeenCalledTimes(1))
    await expect(f.add()).rejects.toThrow('already being initialized')
    await f.add('other')
    gate.resolve(); await first
    expect(f.sessions.records.size).toBe(2)
  })

  it('cleans a prepared model if native construction throws synchronously and releases the reservation', async () => {
    const f = fixture(), failure = new Error('factory failed')
    f.agents.create.mockImplementationOnce(() => { throw failure })
    await expect(f.add()).rejects.toBe(failure)
    expect(f.modelHandles[0]!.dispose).toHaveBeenCalledOnce()
    expect(f.sessions.records.size).toBe(0)
    await f.add()
  })

  it('disposes all adopted resources after permission failure without remembering the preset', async () => {
    const f = fixture(), failure = new Error('permissions unavailable')
    f.permissions.mockImplementationOnce(() => { throw failure })
    await expect(f.add()).rejects.toBe(failure)
    expect(f.commit).not.toHaveBeenCalled()
    expect(f.presets.retire).toHaveBeenCalledOnce(); expect(f.modelHandles[0]!.dispose).toHaveBeenCalledOnce()
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
    expect(f.sessions.records.size).toBe(0)
  })

  it('retains construction and cleanup failures while still trying every native release', async () => {
    const f = fixture(), failure = new Error('commit failed'), release = new Error('model release failed')
    f.commit.mockRejectedValueOnce(failure)
    const prepare = f.models.prepare.getMockImplementation()!
    f.models.prepare.mockImplementationOnce(async (...args) => {
      const model = await prepare(...args)
      vi.mocked(model.dispose).mockRejectedValueOnce(release)
      return model
    })
    await expect(f.add()).rejects.toMatchObject({ errors: [failure, release] })
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
  })

  it.each(['children', 'tasks'] as const)('keeps reads owned but input blocked until %s replay completes, then publishes readiness', async view => {
    const f = fixture(), gate = deferred()
    f.views[view].mockImplementationOnce(() => gate.promise)
    let completed = false
    const creation = f.add().then(record => { completed = true; return record })
    await vi.waitFor(() => expect(f.views[view]).toHaveBeenCalledOnce())
    const record = f.sessions.records.get(SessionId('root'))!
    expect(f.sessions.owned(1, record.agent.session.id)).toBe(record)
    expect(() => f.lifecycle.writable(1, SessionId('root'))).toThrow('initializing')
    await expect(record.work.read(async () => 'initial snapshot')).resolves.toBe('initial snapshot')
    await expect(record.work.run(async () => 'not yet')).rejects.toThrow('initializing')
    expect(completed).toBe(false); expect(record.mcpInitTimer).toBeUndefined()
    gate.resolve(); await creation
    f.lifecycle.assertReady(record)
    expect(record.mcpInitTimer).toBeDefined()
  })

  it('denies async native work when the native registry replaced the agent or its client disconnected', async () => {
    const f = fixture(), record = await f.add(), execute = vi.fn(async () => 'native')
    f.native.set('root', { ...record.agent })
    await expect(record.work.run(execute)).rejects.toThrow('session closed')
    expect(execute).not.toHaveBeenCalled()
    f.native.set('root', record.agent)
    f.client.closed = true
    await expect(record.work.read(execute)).rejects.toThrow('session closed')
    expect(execute).not.toHaveBeenCalled()
    f.client.closed = false
    await expect(record.work.run(execute)).resolves.toBe('native')
  })

  it.each(['children', 'tasks'] as const)('retires a partially published session if initial %s projections fail', async view => {
    const f = fixture(), failure = new Error('child history failed')
    f.views[view].mockImplementationOnce(() => Promise.reject(failure))
    await expect(f.add()).rejects.toBe(failure)
    expect(f.sessions.records.size).toBe(0)
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
    expect(f.order).toContain('flush:root')
  })

  it.each(['children', 'tasks'] as const)('does not acknowledge or arm a timer when the client closes during %s initialization', async view => {
    const f = fixture(), gate = deferred()
    f.views[view].mockImplementationOnce(() => gate.promise)
    const creation = f.add(), failure = expect(creation).rejects.toThrow('session closed during initialization')
    await vi.waitFor(() => expect(f.views[view]).toHaveBeenCalledOnce())
    const record = f.sessions.records.get(SessionId('root'))!
    await f.lifecycle.close(1, { sessionId: 'root' })
    gate.resolve(); await failure
    expect(record.mcpInitTimer).toBeUndefined(); expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
  })

  it('drains pending task history and retains both errors when a sibling startup view fails', async () => {
    const f = fixture(), gate = deferred(), sibling = new Error('commands failed'), reader = new Error('task history failed')
    f.views.tasks.mockImplementationOnce(record => record.work.read(async () => { await gate.promise; throw reader }))
    f.views.commands.mockImplementationOnce(() => { throw sibling })
    const creation = f.add(), rejected = expect(creation).rejects.toMatchObject({ errors: [sibling, reader] })
    await vi.waitFor(() => expect(f.views.commands).toHaveBeenCalledOnce())
    expect(f.nativeDisposals.get('root')).not.toHaveBeenCalled()
    gate.resolve(); await rejected
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
    expect(f.sessions.records.size).toBe(0)
  })

  it('drains late native creators when their callback synchronously starts global shutdown', async () => {
    const f = fixture(), gate = deferred(), create = f.agents.create.getMockImplementation()!
    let shutdown: Promise<void> | undefined, stopped = false
    f.agents.create.mockImplementationOnce(async options => {
      shutdown = f.sessions.dispose(); void shutdown.then(() => { stopped = true })
      await gate.promise; return create(options)
    })
    const creation = f.add(), failure = expect(creation).rejects.toThrow('disposed')
    await vi.waitFor(() => expect(shutdown).toBeDefined()); expect(stopped).toBe(false)
    gate.resolve(); await failure; await shutdown
    expect(stopped).toBe(true); expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
    expect(f.permissions).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
    expect(f.sessions.records.size).toBe(0)
  })

  it('does not apply permissions or remember defaults for a creator whose client disconnected', async () => {
    const f = fixture(), create = f.agents.create.getMockImplementation()!
    f.agents.create.mockImplementationOnce(async options => {
      const handle = await create(options)
      f.client.closed = true
      return handle
    })
    await expect(f.add()).rejects.toThrow('client disconnected')
    expect(f.permissions).not.toHaveBeenCalled(); expect(f.commit).not.toHaveBeenCalled()
    expect(f.modelHandles[0]!.dispose).toHaveBeenCalledOnce()
    expect(f.nativeDisposals.get('root')).toHaveBeenCalledOnce()
  })

  it('settles accepted model work before reload flush/capture while refusing new input, and reopens after failure', async () => {
    const f = fixture(), record = await f.add(), gate = deferred()
    vi.mocked(record.model.settle).mockImplementationOnce(async () => {
      await gate.promise
      record.agent.session.append('model/selection', { provider: 'changed', model: 'later' })
    })
    const reload = f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace', mcpServers: [] })
    await vi.waitFor(() => expect(record.model.settle).toHaveBeenCalledOnce())
    expect(() => f.lifecycle.writable(1, SessionId('root'))).toThrow('reloading')
    expect(f.sessions.ownedAgent(record.agent)).toBe(record)
    gate.resolve(); await reload
    expect(f.models.prepare.mock.calls.at(-1)?.[1]?.at(-1)).toMatchObject({ type: 'model/selection', data: { provider: 'changed' } })
    const current = f.sessions.records.get(SessionId('root'))!
    f.flush.mockRejectedValueOnce(new Error('storage unavailable'))
    await expect(f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace' })).rejects.toThrow('storage unavailable')
    expect(f.sessions.ownedAgent(current.agent)).toBe(current)
    f.lifecycle.assertReady(current)
  })

  it('restores prompt history without transcript replay for a headless load, and refuses foreign live owners', async () => {
    const f = fixture(), record = await f.add()
    record.agent.session.append('user/message', { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    record.agent.session.append('user/message', { content: [{ type: 'text', text: 'automation' }], source: { kind: 'system' } })
    await expect(f.lifecycle.load(2, { sessionId: 'root', cwd: '/tmp/workspace' })).rejects.toThrow('unknown session')
    await f.lifecycle.close(1, { sessionId: 'root' }); f.notify.mockClear()
    await f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace', _meta: { noReplay: true } })
    expect(f.lifecycle.history(1, { session_id: 'root' })).toEqual({ prompts: ['first'] })
    expect(f.notify).not.toHaveBeenCalled()
    expect(f.closeRead).toHaveBeenCalledOnce()
  })

  it('forks a complete prefix and rewinds before the selected turn without changing durable source history', async () => {
    const f = fixture(), source = await f.add()
    source.agent.session.append('turn/start', { turn: 0 })
    source.agent.session.append('user/message', { content: [{ type: 'text', text: 'first' }], source: { kind: 'user' } })
    source.agent.session.append('turn/end', { turn: 0, reason: { kind: 'completed' } })
    source.agent.session.append('turn/start', { turn: 1 })
    source.agent.session.append('user/message', { content: [{ type: 'text', text: 'second' }], source: { kind: 'user' } })
    source.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    const rewind = await f.lifecycle.rewind(1, { sessionId: 'root', targetPromptIndex: 1 })
    expect(rewind).toMatchObject({ mode: 'conversation_only', promptText: 'second', revertedFiles: [] })
    const options = f.agents.create.mock.calls.at(-1)![0]
    expect(options.seed).toHaveLength(3)
    expect(options.inheritedEventCount).toBe(3)
    expect(options.meta).toMatchObject({ parentSession: 'root', isSeeded: true, cwd: '/tmp/workspace' })
    expect(source.agent.session.snapshotEvents()).toHaveLength(6)
    source.agent.session.append('turn/start', { turn: 2 })
    await expect(f.lifecycle.fork(1, { sourceSessionId: 'root' })).rejects.toThrow('turn is open')
  })

  it('reloads from a flushed storage snapshot without any live transcript reads', async () => {
    const f = fixture(), source = await f.add()
    source.agent.session.append('model/selection', { provider: 'saved', model: 'choice' })
    vi.spyOn(source.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('no live history reads') })
    await f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace' })
    expect(f.read).toHaveBeenCalledWith('root', undefined, 1, { signal: expect.any(AbortSignal) })
    expect(f.models.prepare.mock.calls.at(-1)?.[1]).toEqual([expect.objectContaining({ type: 'model/selection' })])
    expect(f.order.indexOf('flush:root')).toBeLessThan(f.order.indexOf('close read'))
    expect(f.order.indexOf('close read')).toBeLessThan(f.order.indexOf('native dispose:root'))
  })

  it('fixes a live fork at its pre-flush cursor even when the source appends during storage work', async () => {
    const f = fixture(), source = await f.add(), gate = deferred()
    source.agent.session.append('session/title', { title: 'captured' })
    vi.spyOn(source.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('no live history reads') })
    const flush = f.flush.getMockImplementation()!
    f.flush.mockImplementationOnce(async session => { await gate.promise; return flush(session) })
    const fork = f.lifecycle.fork(1, { sourceSessionId: 'root', newSessionId: 'fork' })
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
    source.agent.session.append('turn/start', { turn: 0 })
    gate.resolve(); await fork
    expect(f.agents.create.mock.calls.at(-1)![0]).toMatchObject({ inheritedEventCount: 1, seed: [expect.objectContaining({ type: 'session/title' })] })
    expect(f.read).toHaveBeenCalledWith('root', undefined, 1, { signal: expect.any(AbortSignal) })
  })

  it.each(['load', 'fork', 'points'] as const)('keeps the live source usable after a %s storage short read', async kind => {
    const f = fixture(), source = await f.add()
    source.agent.session.append('session/title', { title: 'required prefix' })
    f.read.mockResolvedValueOnce({ events: [] })
    const request = kind === 'load' ? f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace' })
      : kind === 'fork' ? f.lifecycle.fork(1, { sourceSessionId: 'root' }) : f.lifecycle.points(1, { sessionId: 'root' })
    await expect(request).rejects.toThrow(/required durable (prefix|page)/)
    expect(f.sessions.ownedAgent(source.agent)).toBe(source)
    f.lifecycle.assertReady(source)
    expect(f.nativeDisposals.get('root')).not.toHaveBeenCalled()
    expect(f.agents.resume).not.toHaveBeenCalled(); expect(f.agents.create).toHaveBeenCalledOnce()
    expect(f.closeRead).toHaveBeenCalledOnce()
  })

  it.each(['load', 'fork', 'points'] as const)('cancels a %s storage read on close but drains its real read and handle cleanup', async kind => {
    const f = fixture(), source = await f.add(), readGate = deferred(), closeGate = deferred()
    source.agent.session.append('session/title', { title: 'read required' })
    const read = f.read.getMockImplementation()!
    f.read.mockImplementationOnce(async (...args) => { await readGate.promise; return read(...args) })
    f.closeRead.mockImplementationOnce(async () => { await closeGate.promise; f.order.push('closed delayed read') })
    const request = kind === 'load' ? f.lifecycle.load(1, { sessionId: 'root', cwd: '/tmp/workspace' })
      : kind === 'fork' ? f.lifecycle.fork(1, { sourceSessionId: 'root' }) : f.lifecycle.points(1, { sessionId: 'root' })
    const failed = request.catch(error => error)
    try {
      await vi.waitFor(() => expect(f.read).toHaveBeenCalledOnce())
      const closing = f.lifecycle.close(1, { sessionId: 'root' })
      expect(f.read.mock.calls[0]![3]!.signal!.aborted).toBe(true)
      expect(f.nativeDisposals.get('root')).not.toHaveBeenCalled()
      readGate.resolve()
      await vi.waitFor(() => expect(f.closeRead).toHaveBeenCalledOnce())
      expect(f.nativeDisposals.get('root')).not.toHaveBeenCalled()
      closeGate.resolve(); expect(await failed).toBeInstanceOf(Error); await closing
      expect(f.order.indexOf('closed delayed read')).toBeLessThan(f.order.indexOf('native dispose:root'))
      expect(f.agents.resume).not.toHaveBeenCalled(); expect(f.agents.create).toHaveBeenCalledOnce()
    } finally { readGate.resolve(); closeGate.resolve() }
  })

  it('enumerates rewind points across page boundaries without live reads and preserves fork/resume parity', async () => {
    const f = fixture(), source = await f.add(), userSeqs = [255, 256, 767, 1029]
    for (let seq = 0; seq < 1030; seq++) {
      if (userSeqs.includes(seq) || seq === 500) source.agent.session.append('user/message', {
        source: { kind: seq === 500 ? 'system' : 'user' }, content: [{ type: 'text', text: `prompt-${seq}\n` }, { type: 'text', text: '尾' }],
      })
      else source.agent.session.append('session/title', { title: 'irrelevant'.repeat(1024) })
    }
    vi.spyOn(source.agent.session, 'snapshotEvents').mockImplementation(() => { throw new Error('must page durable history') })
    const expected = { rewindPoints: userSeqs.map((seq, promptIndex) => ({ promptIndex, createdAt: new Date(1).toISOString(),
      numFileSnapshots: 0, promptPreview: `prompt-${seq}\n尾`, hasFileChanges: false })) }
    await expect(f.lifecycle.points(1, { sessionId: 'root' })).resolves.toEqual(expected)
    expect(f.read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, 256], [256, 256], [512, 256], [768, 256], [1024, 6]])
    expect(f.closeRead).toHaveBeenCalledOnce()
    await f.lifecycle.fork(1, { sourceSessionId: 'root', newSessionId: 'fork' })
    await expect(f.lifecycle.points(1, { sessionId: 'fork' })).resolves.toEqual(expected)
    await f.lifecycle.close(1, { sessionId: 'fork' })
    await f.lifecycle.load(1, { sessionId: 'fork', cwd: '/tmp/workspace' })
    await expect(f.lifecycle.points(1, { sessionId: 'fork' })).resolves.toEqual(expected)
  })

  it('excludes prompts appended during a rewind-point flush and rejects foreign owners before I/O', async () => {
    const f = fixture(), source = await f.add(), gate = deferred()
    source.agent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'captured' }] })
    await expect(f.lifecycle.points(2, { sessionId: 'root' })).rejects.toThrow('unknown session')
    expect(f.flush).not.toHaveBeenCalled(); expect(f.read).not.toHaveBeenCalled()
    const flush = f.flush.getMockImplementation()!
    f.flush.mockImplementationOnce(async session => { await gate.promise; return flush(session) })
    const request = f.lifecycle.points(1, { sessionId: 'root' })
    source.agent.session.append('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'too late' }] })
    gate.resolve()
    await expect(request).resolves.toMatchObject({ rewindPoints: [{ promptIndex: 0, promptPreview: 'captured' }] })
    expect(f.read).toHaveBeenCalledWith('root', 0, 1, { signal: expect.any(AbortSignal) })
  })
})
