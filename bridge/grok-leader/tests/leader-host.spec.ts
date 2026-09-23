/** Leader host lifecycle, shutdown drains and shipped bundle composition. */
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Service } from '@deepseek-ai/cordis'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import * as GrokLeader from '../src/index.ts'
import { makeClient, makeHarness, mockAppExit, mockLlm, mockSessionsStore, mockVisionLlm, register, sendRequest, waitFor, waitForId, type ClientHandle } from './support/leader-harness.ts'

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

describe('shipped composition', () => {
  const analyze = GrokLeader.analyzeBundlePatch

  it('mounts native session services before the preset catalog', () => {
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    const analysis = analyze(patch)
    expect(analysis.insertedRows).toEqual(['session-reference', 'schedule', 'terminals', 'terminal-bash', 'subagent-model-selection-settings', 'agent-preset-registry', 'cordis-host-runner', 'grok-leader'])
  })
})

describe('lifecycle boundary regressions', () => {
  it('host shutdown waits for an accepted provider credential write and its route continuation', async () => {
    let release!: () => void, started = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const mutate = vi.fn(async () => {})
    const made = await makeHarness({ settings: { mutate }, credentials: {
      set: async () => { started = true; await gate },
    } })
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      sendRequest(client, 1, 'x.ai/providers/add', { id: 'held', apiKey: 'fixture-only' })
      await waitFor(() => started)
      let closed = false
      const closing = made.pluginCtx.fiber.dispose().then(() => { closed = true })
      await waitFor(() => client.socket.destroyed)
      const closedBeforeWrite = closed
      release(); await closing
      expect(closedBeforeWrite).toBe(false)
      expect(mutate).toHaveBeenCalledWith('llm-pi-ai', [{ op: 'set', path: ['providers', 'held'], value: { apiKeyEnv: 'HELD_API_KEY' } }])
    } finally { release(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it('idle host exit waits for an accepted background model catalog write', async () => {
    mockAppExit.calls.length = 0
    let release!: () => void, started = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const made = await makeHarness({ idleExitMs: 5,
      llm: { ...mockLlm,
        listProviders: () => [{ id: 'custom' }],
        listModels: async () => [{ id: 'existing', name: 'Existing' }],
        discoverModels: async () => [{ id: 'discovered' }],
      },
      settings: {
        describe: () => [{ ns: 'llm-pi-ai', user: { providers: { custom: {
          api: 'openai-completions', baseURL: 'https://fixture.invalid/v1', models: [{ id: 'existing' }],
        } } } }],
        mutate: async () => { started = true; await gate },
      },
    })
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      await client.request(1, 'initialize', {})
      await waitFor(() => started)
      client.socket.destroy()
      // The existing real-socket idle-exit contract uses a grace observation;
      // completion still depends on releasing the actual persistence promise.
      await new Promise(resolve => setTimeout(resolve, 35))
      const exitedBeforeWrite = mockAppExit.calls.length
      release(); await waitFor(() => mockAppExit.calls.length === 1)
      expect(exitedBeforeWrite).toBe(0); expect(mockAppExit.calls).toEqual([0])
    } finally { release(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it('host shutdown drains an accepted terminal close before flushing and disposing its session', async () => {
    let release!: () => void, entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const flush = vi.fn(async () => {})
    const made = await makeHarness({ sessionsStore: { flush } })
    const list = vi.fn(() => [{ sessionId: 'pty', type: 'shell', status: { kind: 'running' } }])
    const kill = vi.fn(async () => { entered = true; await gate; return true })
    Object.assign(new (class extends Service {})(made.ctx, 'terminals'), { list, kill })
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      const created = await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId, agent = made.registry.byId.get(sessionId)!
      sendRequest(client, 2, 'x.ai/terminals', { sessionId, action: 'close', terminalId: 'pty' })
      await waitFor(() => entered)
      const closing = made.pluginCtx.fiber.dispose()
      await waitFor(() => client.socket.destroyed)
      expect(agent.internals.disposed).toBe(false); expect(flush).not.toHaveBeenCalled()
      release(); await closing
      expect(agent.internals.disposed).toBe(true); expect(flush).toHaveBeenCalledOnce()
      expect(kill).toHaveBeenCalledOnce(); expect(list).toHaveBeenCalledOnce()
    } finally { release(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it.each(['initialize', 'x.ai/commands/list'])('%s without a session keeps shutdown waiting for the accepted preset catalog read', async method => {
    let release!: () => void, entered = false, completed = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const made = await makeHarness({ presets: true })
    const presets = made.ctx.get('agentPresets')!
    const list = presets.list.bind(presets)
    vi.spyOn(presets, 'list').mockImplementation(async () => {
      entered = true; await gate; const result = await list(); completed = true; return result
    })
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      sendRequest(client, 1, method, {})
      await waitFor(() => entered)
      expect(made.registry.byId.size).toBe(0)
      let disposed = false
      const closing = made.pluginCtx.fiber.dispose().then(() => { disposed = true })
      await waitFor(() => client.socket.destroyed)
      const disposedEarly = disposed
      expect(completed).toBe(false)
      release(); await closing
      expect(disposedEarly).toBe(false); expect(completed).toBe(true)
      expect(client.all.some(message => message.id === 1 && message.error === undefined)).toBe(false)
    } finally { release(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it.each(['session/list', 'x.ai/session/list', 'x.ai/sessions/list', 'x.ai/session/search'])('%s without a published session still holds host shutdown until its native read finishes', async method => {
    let release!: () => void, entered = false, signal: AbortSignal | undefined
    const gate = new Promise<void>(resolve => { release = resolve })
    const made = await makeHarness({ sessionQuery: { searchSessions: async (_request: unknown, exec?: { signal?: AbortSignal }) => {
      signal = exec?.signal; entered = true; await gate; return { items: [] }
    } } })
    const list = made.persistence.list.bind(made.persistence)
    made.persistence.list = async (options?: { signal?: AbortSignal }) => {
      signal = options?.signal; entered = true; await gate; return list()
    }
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      sendRequest(client, 1, method, { query: 'needle' })
      await waitFor(() => entered)
      expect(made.registry.byId.size).toBe(0)
      let disposed = false
      const closing = made.pluginCtx.fiber.dispose().then(() => { disposed = true })
      await waitFor(() => client.socket.destroyed)
      const disposedEarly = disposed
      release(); await closing
      expect(disposedEarly).toBe(false)
      expect(signal?.aborted).toBe(true)
      expect(made.persistence.loaded).toEqual([])
      expect(client.all.some(message => message.id === 1 && message.error === undefined)).toBe(false)
    } finally { release(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it('host shutdown waits for a picker handle returned after cancellation to close without reading it', async () => {
    let releaseOpen!: () => void, releaseClose!: () => void, opened = false, closingRead = false, reads = 0
    const openGate = new Promise<void>(resolve => { releaseOpen = resolve })
    const closeGate = new Promise<void>(resolve => { releaseClose = resolve })
    const made = await makeHarness(), open = made.persistence.open.bind(made.persistence)
    made.persistence.open = async (...args) => {
      const handle = await open(...args); opened = true; await openGate
      return { ...handle, read: async () => { reads++; return handle.read() }, close: async () => {
        closingRead = true; await closeGate; await handle.close()
      } }
    }
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      sendRequest(client, 1, 'x.ai/session/list', {})
      await waitFor(() => opened)
      let disposed = false
      const closing = made.pluginCtx.fiber.dispose().then(() => { disposed = true })
      await waitFor(() => client.socket.destroyed)
      releaseOpen(); await waitFor(() => closingRead)
      const disposedEarly = disposed
      releaseClose(); await closing
      expect(disposedEarly).toBe(false); expect(reads).toBe(0)
      expect(made.persistence.closed).toEqual(['persisted-session'])
    } finally { releaseOpen(); releaseClose(); client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it('disposes live agents when shutdown persistence flush fails', async () => {
    let flushes = 0
    const made = await makeHarness({ sessionsStore: { async flush() {
      flushes += 1
      throw new Error('storage unavailable')
    } } })
    const client = await makeClient(made.socketPath)
    try {
      register(client); await client.next()
      const result = await client.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const agent = made.registry.byId.get((result.result as { sessionId: string }).sessionId)!
      await made.pluginCtx.fiber.dispose()
      expect(flushes).toBe(1)
      expect(agent.internals.disposed).toBe(true)
    } finally { client.socket.destroy(); await made.ctx.fiber.dispose() }
  })

  it('keeps a new client connected while an old idle-exit waits for flush', async () => {
    mockAppExit.calls.length = 0
    let releaseFlush!: () => void
    const gate = new Promise<void>(resolve => { releaseFlush = resolve })
    let flushes = 0
    const made = await makeHarness({ idleExitMs: 5, sessionsStore: { async flush() {
      if (++flushes === 1) await gate
      return true
    } } })
    const first = await makeClient(made.socketPath)
    let second: ClientHandle | undefined
    try {
      register(first); await first.next()
      const created = await first.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const oldAgent = made.registry.byId.get((created.result as { sessionId: string }).sessionId)!
      first.socket.destroy()
      await waitFor(() => flushes === 1)
      await new Promise(resolve => setTimeout(resolve, 30))
      expect(mockAppExit.calls).toEqual([])
      second = await makeClient(made.socketPath)
      register(second); await second.next()
      const reopened = await second.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      expect(reopened.error).toBeUndefined()
      releaseFlush()
      await waitFor(() => oldAgent.internals.disposed)
      await new Promise(resolve => setTimeout(resolve, 30))

      expect(mockAppExit.calls).toEqual([])
      expect(second.socket.destroyed).toBe(false)
    } finally {
      releaseFlush(); first.socket.destroy(); second?.socket.destroy()
      await made.ctx.fiber.dispose()
    }
  })


})


it('image upload accepted by TUI must not disconnect the session', async () => {
  const made = await makeHarness({ llm: mockVisionLlm })
  const c = await makeClient(made.socketPath)
  try {
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
    const sessionId = (created.result as { sessionId: string }).sessionId
    sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'image', mimeType: 'image/png', data: Buffer.alloc(7 * 1024 * 1024).toString('base64') }] })
    await waitFor(() => c.socket.destroyed || c.all.some(msg => msg.id === 2))

    expect(c.socket.destroyed).toBe(false)
  } finally {
    c.socket.destroy(); await made.ctx.fiber.dispose()
  }
})


it.each(['new', 'load', 'fork'])('disconnect during session %s must dispose the late agent', async operation => {
  const made = await makeHarness({ idleExitMs: 10 })
  const first = await makeClient(made.socketPath)
  const keeper = await makeClient(made.socketPath)
  let releaseCreate!: () => void
  const gate = new Promise<void>(resolve => { releaseCreate = resolve })
  let started = false
  if (operation === 'load') {
    const original = made.registry.resume
    made.registry.resume = async options => { started = true; await gate; return original(options) }
  } else {
    const original = made.registry.create
    made.registry.create = async options => { started = true; await gate; return original(options) }
  }
  try {
    register(first); await first.next()
    register(keeper); await keeper.next()
    sendRequest(first, 1, operation === 'fork' ? 'x.ai/session/fork' : 'session/' + operation, { cwd: process.cwd(), mcpServers: [], sessionId: made.persistence.header.id, sourceSessionId: made.persistence.header.id })
    await waitFor(() => started)
    first.socket.destroy()
    await new Promise(resolve => setTimeout(resolve, 30))
    releaseCreate()
    await waitFor(() => made.registry.created.length + made.registry.resumed.length === 1)
    await new Promise(resolve => setTimeout(resolve, 30))
    const live = [...made.registry.byId.values()]

    expect(live.length).toBe(0)
  } finally {
    releaseCreate(); first.socket.destroy(); keeper.socket.destroy(); await made.ctx.fiber.dispose()
  }
})

it('cold session query must not lose first prompts above the 100-entry cache', async () => {
  const made = await makeHarness()
  const c = await makeClient(made.socketPath)
  try {
    made.persistence.list = async () => Array.from({ length: 105 }, (_, i) => ({
      header: { ...made.persistence.header, id: SessionId('review-history-' + String(i)), createdAt: i },
      revision: SessionPersistenceRevision('review'),
    }))
    made.persistence.readEvents = async id => [{
      type: 'user/message', seq: 0, time: 1,
      data: { source: { kind: 'user' }, content: [{ type: 'text', text: id === 'review-history-0' ? 'unique-review-needle' : 'ordinary first prompt' }] },
    }] as unknown as SessionEvent[]
    register(c); await c.next()
    const response = await c.request(1, 'x.ai/session/list', { cwd: '/tmp/proj', query: 'unique-review-needle', limit: 1 })
    const listed = (response.result as { sessions: Array<{ sessionId: string }> }).sessions

    expect(listed.map(row => row.sessionId)).toEqual(['review-history-0'])
  } finally {
    c.socket.destroy(); await made.ctx.fiber.dispose()
  }
})

it('serves two windows polling the roster in the same second from one durable listing', async () => {
  const made = await makeHarness()
  const first = await makeClient(made.socketPath), second = await makeClient(made.socketPath)
  const clock = vi.spyOn(Date, 'now')
  let release!: () => void, listings = 0
  try {
    const stored = Array.from({ length: 3 }, (_, i) => ({
      header: { ...made.persistence.header, id: SessionId('roster-window-' + String(i)), createdAt: i },
      revision: SessionPersistenceRevision('roster'),
    }))
    const gate = new Promise<void>(resolve => { release = resolve })
    made.persistence.list = async () => { listings += 1; await gate; return stored }
    register(first); await first.next()
    register(second); await second.next()
    // One leader serves every window of a profile, so both dashboards tick on
    // the same second. The second tick lands on the listing the first already
    // paid for instead of listing the store again.
    sendRequest(first, 1, 'x.ai/sessions/list')
    sendRequest(second, 1, 'x.ai/sessions/list')
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(listings).toBe(1)
    release()
    // The pager unwraps `result` before reading `sessions` (the pinned
    // `parse_roster_list_response` contract), so the ext-response body is the
    // frame's `result.result`.
    const rows = async (client: ClientHandle) => ((await waitForId(client, 1)).result as { result: { sessions: Array<{ sessionId: string }> } }).result.sessions.map(row => row.sessionId)
    const expected = ['roster-window-0', 'roster-window-1', 'roster-window-2']
    expect(await rows(first)).toEqual(expected)
    expect(await rows(second)).toEqual(expected)
    // The settled listing then answers the same header-shaped poll for its
    // window, so the next second's tick is served from it, not from the store.
    await second.request(2, 'x.ai/sessions/list')
    expect(listings).toBe(1)
    // What no local event covers — a store another process writes — is the
    // window's deadline: the tick after it lists again.
    clock.mockReturnValue(Date.now() + 10_001)
    await second.request(3, 'x.ai/sessions/list')
    expect(listings).toBe(2)
  } finally {
    clock.mockRestore(); release(); first.socket.destroy(); second.socket.destroy(); await made.ctx.fiber.dispose()
  }
})

it('serves cached roster titles and keeps seeded headers titleless', async () => {
  const made = await makeHarness({ sessionProjectionCache: {
    cachedSnapshot: (meta: { id: unknown }) => String(meta.id) === 'roster-titled' ? { values: { title: 'Cached roster title' } } : undefined,
    cachedPredecessorTitle: () => undefined,
  } })
  const client = await makeClient(made.socketPath)
  try {
    made.persistence.list = async () => [
      { header: { ...made.persistence.header, id: SessionId('roster-titled'), createdAt: 1 }, revision: SessionPersistenceRevision('roster') },
      { header: { ...made.persistence.header, id: SessionId('roster-seeded'), createdAt: 2, isSeeded: true }, revision: SessionPersistenceRevision('roster') },
    ]
    register(client); await client.next()
    const response = await client.request(1, 'x.ai/sessions/list')
    const rows = (response.result as { result: { sessions: Array<Record<string, unknown>> } }).result.sessions
    expect(rows.map(row => [row.sessionId, row.title])).toEqual([
      ['roster-titled', 'Cached roster title'],
      ['roster-seeded', undefined],
    ])
  } finally { client.socket.destroy(); await made.ctx.fiber.dispose() }
})
