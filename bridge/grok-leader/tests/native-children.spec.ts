import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { ProjectedUpdate } from '../src/projection.ts'
import { createNativeChildren } from '../src/native-children.ts'
import { createSessionWork } from '../src/session-work.ts'
import { workflowProjection } from '../src/workflows.ts'

type Row = { kind: 'child' | 'diagnostic'; id: string; mode: 'continuable' | 'one-shot'; label?: string; parentId?: string; activity?: 'running' | 'inactive' }
function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
function fixture() {
  const listeners = new Map<string, Set<(...args: unknown[]) => void>>()
  const stops: Array<ReturnType<typeof vi.fn>> = []
  const emit = (name: string, ...args: unknown[]) => { for (const listener of listeners.get(name) ?? []) listener(...args) }
  const agents = new Map<SessionId, Agent>()
  const logs = new Map<string, SessionEvent[]>()
  const readers = new Map<string, ReturnType<typeof vi.fn>>()
  const makeAgent = (id: string, status: Agent['status'] = 'running') => {
    const events: SessionEvent[] = []
    logs.set(id, events)
    const nextTurn: Array<{ id: string; content: Array<{ type: 'text'; text: string }> }> = []
    const nextStep: typeof nextTurn = []
    const snapshotEvents = vi.fn((from = 0, to = events.length) => events.slice(from, to))
    readers.set(id, snapshotEvents)
    const inbox = { nextTurn, nextStep,
      clear: vi.fn(() => { nextTurn.length = 0; nextStep.length = 0 }),
      remove: vi.fn((id: string) => {
        for (const queue of [nextTurn, nextStep]) { const index = queue.findIndex(row => row.id === id); if (index >= 0) queue.splice(index, 1) }
      }),
      replace: vi.fn((id: string, value: typeof nextTurn[number]) => {
        for (const queue of [nextTurn, nextStep]) { const index = queue.findIndex(row => row.id === id); if (index >= 0) queue[index] = value }
      }),
    }
    const agent = { id, status, session: { id: SessionId(id), header: { id: SessionId(id), cwd: '/workspace', createdAt: 1000 },
      get seq() { return events.length }, snapshotEvents, ownEvents: () => events }, inbox, steer: vi.fn() } as unknown as Agent
    agents.set(SessionId(id), agent)
    return agent
  }
  const record = (id: string, clientId: number) => {
    const value = { clientId, agent: makeAgent(id, 'idle'), output: { notify: vi.fn() },
      work: createSessionWork({ isLive: () => sessions.get(SessionId(id)) === value, assertReady: () => {} }) }
    return value
  }
  const root = record('root', 1), other = record('other', 2)
  const sessions = new Map([[root.agent.session.id, root], [other.agent.session.id, other]])
  const rows = new Map<string, Row[]>([['root', []], ['other', []]])
  const add = (id: string, owner = root, mode: Row['mode'] = 'continuable') => {
    const child = makeAgent(id)
    rows.get(owner.agent.session.id)!.push({ kind: 'child', id, mode, label: 'worker ' + id })
    return child
  }
  const append = (agent: Agent, type: string, data: unknown, time = 1000) => {
    const events = logs.get(agent.session.id)!
    const event = { seq: events.length, type, data, time } as SessionEvent
    events.push(event); emit('session/event', agent.session, event)
    return event
  }
  const service = {
    listDescendants: vi.fn(async (id: SessionId, _signal?: AbortSignal): Promise<Row[]> => rows.get(id) ?? []),
    interrupt: vi.fn(),
    prompt: vi.fn(async (_request: unknown, _signal: AbortSignal) => ({ messageId: 'accepted' })),
  }
  const read = vi.fn(async (id: string, offset = 0, length?: number, _options?: { signal?: AbortSignal }) => ({ events: logs.get(id)!.slice(offset, length === undefined ? undefined : offset + length) }))
  const close = vi.fn(async () => {})
  const store = {
    stat: vi.fn(async (id: string, _options?: { signal?: AbortSignal }) => ({ eventCount: logs.get(id)!.length, revision: String(logs.get(id)!.length) })),
    open: vi.fn(async (id: string, _mode?: string, _options?: { signal?: AbortSignal }) => ({ header: { id, cwd: '/workspace', createdAt: 1000 }, read: (offset?: number, length?: number, options?: { signal?: AbortSignal }) => read(id, offset, length, options), close })),
  }
  const notify = vi.fn(), warn = vi.fn(), flush = vi.fn(async (_session: unknown) => {})
  const projectImages = vi.fn(async (_event: SessionEvent, updates: ProjectedUpdate[]) => updates)
  const host = { sessions, owned: (clientId: number, id: SessionId | undefined) => {
    const record = id === undefined ? undefined : sessions.get(id)
    return record?.clientId === clientId ? record : undefined
  }, agent: (id: SessionId) => agents.get(id), subagents: () => service,
  workflow: (record: typeof root) => logs.get(record.agent.session.id)!.reduce(workflowProjection.apply, { runs: [] }),
  persistence: () => store as unknown as Pick<SessionPersistence, 'open' | 'stat'>, flush, projectImages, notify,
  teamMembers: vi.fn((_record: typeof root): ReadonlyArray<{ id: string; name: string }> | undefined => undefined),
  logger: { warn } }
  const children = createNativeChildren({ ...host, on: (name, listener) => {
    const set = listeners.get(name) ?? new Set()
    listeners.set(name, set); set.add(listener as (...args: unknown[]) => void)
    const stop = vi.fn(() => { set.delete(listener as (...args: unknown[]) => void) })
    stops.push(stop); return stop
  } })
  const command = (text: string, extra: object = {}) => children.command(1, { sessionId: 'root', prompt: [{ type: 'text', text }], ...extra })
  const notes = () => root.output.notify.mock.calls.map(call => (call[1] as { update: Record<string, unknown> }).update)
  return { children, host, root, other, sessions, agents, rows, logs, readers, add, append, emit, listeners, stops, service, store, read, close, notify, warn, flush, projectImages, command, notes }
}
afterEach(() => vi.useRealTimers())

describe('native child/workflow ownership', () => {
  it('does not combine a pre-settlement history cut with post-settlement idle status', async () => {
    const f = fixture(), child = f.add('child'), gate = deferred<void>()
    f.logs.get('child')!.push(
      { seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent,
      { seq: 1, time: 1001, type: 'turn/end', data: { turn: 0, reason: { kind: 'aborted' } } } as SessionEvent,
    )
    Object.assign(child, { status: 'idle' })
    await f.children.snapshot(f.root)
    f.root.output.notify.mockClear()
    f.flush.mockImplementationOnce(() => gate.promise)
    Object.assign(child, { status: 'running' })
    f.append(child, 'turn/start', { turn: 1 })
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledTimes(2))
    f.append(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    Object.assign(child, { status: 'idle' })
    f.emit('agent/status', { agent: child, status: 'idle' })
    gate.resolve()
    await f.children.snapshot(f.root)
    expect(f.notes().filter(note => note.sessionUpdate === 'subagent_finished').map(note => note.status)).toEqual(['completed'])
    expect(f.notes().filter(note => note.sessionUpdate === 'subagent_spawned')).toHaveLength(1)
    await f.children.dispose()
  })

  it('reports how long a settled run took, live and when rebuilt from the log', async () => {
    const f = fixture(), child = f.add('child')
    await f.children.snapshot(f.root)
    Object.assign(child, { status: 'running' })
    f.append(child, 'turn/start', { turn: 1 }, 5000)
    f.append(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } }, 9200)
    Object.assign(child, { status: 'idle' })
    await vi.waitFor(() => expect(f.notes()).toContainEqual(expect.objectContaining({ sessionUpdate: 'subagent_finished', duration_ms: 4200 })))
    const meta = f.root.output.notify.mock.calls.find(call => (call[1] as { update: { sessionUpdate: string } }).update.sessionUpdate === 'subagent_finished')![2]
    expect(meta).toMatchObject({ subagentMetricsAvailable: false, subagentDurationAvailable: true })
    // A fresh view (after a restart) derives the same length from the durable log.
    const g = fixture(), settled = g.add('child')
    g.logs.get('child')!.push(
      { seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent,
      { seq: 1, time: 3500, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } } as SessionEvent,
    )
    Object.assign(settled, { status: 'idle' })
    await g.children.snapshot(g.root)
    expect(g.notes()).toContainEqual(expect.objectContaining({ sessionUpdate: 'subagent_finished', status: 'completed', duration_ms: 2500 }))
    await f.children.dispose(); await g.children.dispose()
  })

  it('cancels descendant listing with the session and host shutdown signals', async () => {
    const f = fixture(), listing = deferred<Row[]>()
    let seen: AbortSignal | undefined
    f.service.listDescendants.mockImplementationOnce(async (_id, signal) => {
      seen = signal
      return listing.promise
    })
    const refresh = f.children.snapshot(f.root)
    await Promise.resolve()
    expect(seen).toBeInstanceOf(AbortSignal)
    expect(seen!.aborted).toBe(false)
    const closing = f.children.dispose()
    await Promise.resolve()
    expect(seen!.aborted).toBe(true)
    listing.resolve([])
    await Promise.all([refresh, closing])
  })

  it('keeps a descendant running from native activity when no live agent exists', async () => {
    const f = fixture()
    f.rows.get('root')!.push({ kind: 'child', id: 'orphan', mode: 'continuable', label: 'orphan', activity: 'running' })
    f.logs.set('orphan', [])
    await f.children.snapshot(f.root)
    expect(f.notes().filter(note => note.sessionUpdate === 'subagent_spawned')).toHaveLength(1)
    expect(f.notes().filter(note => note.sessionUpdate === 'subagent_finished')).toEqual([])
    await f.children.dispose()
  })

  it('preserves image offload as a system notice in paged child history', async () => {
    const f = fixture(), child = f.add('child')
    f.append(child, 'image/offload', { targets: [{ imageIndexes: [0, 2] }] })
    const result = await f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    expect(result).toMatchObject({ nextSeq: 1, entries: [{ imageNotes: [expect.stringContaining('2 older image occurrence(s)')] }] })
    await expect(f.children.history(1, { sessionId: 'root', childSessionId: 'child', after: 1 })).resolves.toMatchObject({ entries: [] })
    await f.children.dispose()
  })

  it('session cancellation prevents a delayed descendant lookup from mutating the same live owner', async () => {
    const f = fixture(), child = f.add('child'), lookup = deferred<Row[]>()
    f.service.listDescendants.mockReturnValueOnce(lookup.promise)
    const command = f.command('/subagents queue child late')
    f.root.work.cancel()
    lookup.resolve(f.rows.get('root')!)
    await expect(command).resolves.toMatchObject({ result: { kind: 'error' } })
    expect(f.service.prompt).not.toHaveBeenCalled()
    expect(child.inbox.nextTurn).toEqual([])
    await f.root.work.settle()
    await expect(f.command('/subagents queue child fresh')).resolves.toMatchObject({ result: { kind: 'success' } })
    expect(f.service.prompt).toHaveBeenCalledOnce()
    await f.children.dispose()
  })

  it('observes an interruption cancellation when native interrupt reenters session cancellation and throws', async () => {
    const f = fixture(), child = f.add('child'), failure = new Error('interrupt failed')
    f.append(child, 'turn/start', { turn: 0 })
    f.service.interrupt.mockImplementationOnce(() => { f.root.work.cancel(); throw failure })
    await expect(f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })).rejects.toBe(failure)
    await f.root.work.settle(); await f.children.dispose()
  })

  it('drains a history lookup that reenters disposal before its first await', async () => {
    const f = fixture(), held = deferred<Row[]>(), entered = deferred<void>()
    let disposal!: Promise<void>, done = false
    f.service.listDescendants.mockImplementationOnce(async () => {
      disposal = f.children.dispose()
      void disposal.then(() => { done = true })
      entered.resolve()
      return held.promise
    })
    const read = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    const rejected = expect(read).rejects.toThrow('session closed')
    await entered.promise; await Promise.resolve()
    try { expect(done).toBe(false) } finally { held.resolve([]) }
    await rejected; await disposal
    expect(f.store.open).not.toHaveBeenCalled()
  })

  it('restores child views before publishing persisted workflow membership on a fresh attachment', async () => {
    const f = fixture(), child = f.add('child')
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    f.logs.get('root')!.push(
      { seq: 0, time: 1000, type: 'tool-workflow/run-start', data: { runId: 'run', name: 'review' } } as SessionEvent,
      { seq: 1, time: 1001, type: 'tool-workflow/agent-start', data: { runId: 'run', seq: 0, childId: child.session.id, label: 'worker' } } as SessionEvent,
    )
    await f.children.snapshot(f.root, true)
    const spawn = f.notes().findIndex(note => note.sessionUpdate === 'subagent_spawned')
    const workflow = f.notes().findIndex(note => note.sessionUpdate === 'workflow_updated')
    expect(spawn).toBeGreaterThanOrEqual(0)
    expect(workflow).toBeGreaterThan(spawn)
    await f.children.dispose()
  })

  it('publishes a newly discovered child view before its live workflow membership', async () => {
    const f = fixture()
    f.emit('workflow/start', { id: 'run', meta: { name: 'review', description: 'review it' } })
    f.append(f.root.agent, 'tool-workflow/run-start', { runId: 'run', name: 'review' })
    f.append(f.root.agent, 'tool-workflow/agent-start', { runId: 'run', seq: 0, childId: 'child', label: 'worker' })
    await f.children.snapshot(f.root)
    expect(f.notes().some(note => Array.isArray(note.agents) && note.agents.length > 0)).toBe(false)
    const child = f.add('child')
    f.append(child, 'turn/start', { turn: 1 })
    f.children.poll(); await f.children.snapshot(f.root)
    const spawn = f.notes().findIndex(note => note.sessionUpdate === 'subagent_spawned')
    const workflow = f.notes().findIndex(note => Array.isArray(note.agents) && note.agents.length > 0)
    expect(spawn).toBeGreaterThanOrEqual(0)
    expect(workflow).toBeGreaterThan(spawn)
    expect(f.notes()[workflow]).toMatchObject({ run_id: 'run', status: 'active', agents: [{ agent_id: 'child' }] })
    await f.children.dispose()
  })

  it('coalesces refreshes and stops discovery retries at the existing deadline', async () => {
    vi.useFakeTimers()
    const f = fixture(), listing = deferred<Row[]>()
    f.service.listDescendants.mockImplementationOnce(() => listing.promise)
    const first = f.children.snapshot(f.root)
    await Promise.resolve()
    const again = f.children.snapshot(f.root)
    expect(f.service.listDescendants).toHaveBeenCalledOnce()
    listing.resolve([]); await Promise.all([first, again])
    expect(f.service.listDescendants).toHaveBeenCalledTimes(2)
    f.append(f.root.agent, 'tool-workflow/run-start', { runId: 'run', name: 'review' })
    f.append(f.root.agent, 'tool-workflow/agent-start', { runId: 'run', seq: 0, childId: 'missing', label: 'worker' })
    await f.children.snapshot(f.root)
    await vi.advanceTimersByTimeAsync(30000)
    f.children.poll()
    const calls = f.service.listDescendants.mock.calls.length
    f.children.poll(); f.children.poll()
    expect(f.service.listDescendants).toHaveBeenCalledTimes(calls)
    expect(f.warn).toHaveBeenCalledWith(expect.stringContaining('discovery timed out'))
    await f.children.dispose()
  })

  it('waits for the exact child turn end rather than holder completion or an older attempt', async () => {
    const f = fixture(), child = f.add('child')
    f.append(child, 'turn/start', { turn: 2 })
    await f.children.snapshot(f.root)
    const cancellation = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    await vi.waitFor(() => expect(f.service.interrupt).toHaveBeenCalledOnce())
    expect(f.service.interrupt).toHaveBeenCalledWith('child', { kind: 'ancestor', agent: f.root.agent })
    let finished = false
    void cancellation.then(() => { finished = true })
    f.emit('subagent/end', { id: 'child', stopReason: 'completed', lastAssistantMessage: 'holder output' })
    f.append(child, 'turn/end', { turn: 1, reason: { kind: 'completed' } })
    await Promise.resolve()
    expect(finished).toBe(false)
    f.append(child, 'turn/end', { turn: 2, reason: { kind: 'aborted' } })
    await expect(cancellation).resolves.toMatchObject({ result: { cancelled: true, outcome: { kind: 'cancelled' } } })
    expect(f.notes()).toContainEqual(expect.objectContaining({ sessionUpdate: 'subagent_finished', status: 'cancelled' }))
    await f.children.dispose()
  })

  it('contains interruption timeouts without inventing a cancelled result', async () => {
    vi.useFakeTimers()
    const f = fixture(), child = f.add('child')
    f.append(child, 'turn/start', { turn: 0 })
    const cancellation = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    const failure = expect(cancellation).rejects.toThrow('no terminal turn observed')
    await vi.advanceTimersByTimeAsync(5000); await failure
    expect(vi.getTimerCount()).toBe(0)
    await f.children.dispose()
  })

  it('rejects controls outside the native descendant scope before reading or mutating them', async () => {
    const f = fixture(); f.add('mine'); f.add('foreign', f.other); f.add('oneshot', f.root, 'one-shot')
    await expect(f.children.history(2, { sessionId: 'root', childSessionId: 'mine' })).rejects.toThrow('unknown session')
    await expect(f.children.history(1, { sessionId: 'root', childSessionId: 'foreign' })).rejects.toThrow('unknown subagent')
    await expect(f.children.cancel(1, { sessionId: 'root', subagentId: 'foreign' })).resolves.toMatchObject({ result: { outcome: { kind: 'not_found' } } })
    await expect(f.children.cancel(1, { sessionId: 'root', subagentId: 'oneshot' })).rejects.toThrow('one-shot')
    await expect(f.command('/subagents queue foreign nope')).resolves.toMatchObject({ result: { kind: 'error' } })
    expect(f.service.interrupt).not.toHaveBeenCalled()
    expect(f.service.prompt).not.toHaveBeenCalled()
    expect(f.store.open).not.toHaveBeenCalled()
    await f.children.dispose()
  })

  it('pages history through bounded readers and verifies a settled live tail before claiming durability', async () => {
    const f = fixture(), child = f.add('child')
    const events = f.logs.get('child')!
    for (let seq = 0; seq < 600; seq++) events.push({ seq, time: seq, type: 'assistant/message', data: { turn: 0, step: seq, stream: [], message: { role: 'assistant', content: [{ type: 'text', text: 'line ' + seq }] } } } as SessionEvent)
    const request = { sessionId: 'root', childSessionId: 'child', after: 256 }
    await expect(f.children.history(1, request)).resolves.toMatchObject({ nextSeq: 512, totalSeq: 600, durable: false })
    expect(f.read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, 256], [256, 256], [512, 88], [256, 256]])
    const previous = f.read.mock.calls.length
    await f.children.history(1, request)
    expect(f.read).toHaveBeenCalledTimes(previous + 1)
    expect(f.readers.get('child')).not.toHaveBeenCalled()
    Object.assign(child, { status: 'idle' })
    await expect(f.children.history(1, request)).resolves.toMatchObject({ durable: true })
    expect(f.flush).toHaveBeenCalledWith(child.session)
    expect(f.read).toHaveBeenLastCalledWith('child', 599, 1, { signal: expect.any(AbortSignal) })
    expect(f.close).toHaveBeenCalledTimes(3)
    await f.children.history(1, request)
    expect(f.flush).toHaveBeenCalledTimes(4)
    expect(f.store.open).toHaveBeenCalledTimes(4)
    await expect(f.children.history(1, { ...request, after: 601 })).rejects.toThrow('ahead of')
    await f.children.dispose()
  })

  it('closes cold history handles after projection errors and rejects results after owner withdrawal', async () => {
    const f = fixture(), child = f.add('child')
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'tool/ptc-dispatch', data: {
      subCallId: 'image', name: 'read', content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }],
    } } as unknown as SessionEvent)
    f.agents.delete(child.session.id)
    const request = { sessionId: 'root', childSessionId: 'child' }
    f.projectImages.mockRejectedValueOnce(new Error('preview failed'))
    await expect(f.children.history(1, request)).rejects.toThrow('preview failed')
    expect(f.close).toHaveBeenCalledOnce()
    const preview = deferred<ProjectedUpdate[]>()
    f.projectImages.mockImplementationOnce(() => preview.promise)
    const history = f.children.history(1, request)
    const rejected = expect(history).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.projectImages).toHaveBeenCalledTimes(2))
    f.sessions.delete(f.root.agent.session.id)
    preview.resolve([]); await rejected
    expect(f.close).toHaveBeenCalledTimes(2)
    await f.children.dispose()
  })

  it('fixes the live prefix before flush and only indexes new events on the next request', async () => {
    const f = fixture(), child = f.add('child'), gate = deferred<void>()
    const events = f.logs.get('child')!
    events.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    f.readers.get('child')!.mockImplementation(() => { throw new Error('no synchronous child reads') })
    f.flush.mockImplementationOnce(() => gate.promise)
    const first = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
    events.push({ seq: 1, time: 1001, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } } as SessionEvent)
    gate.resolve()
    await expect(first).resolves.toMatchObject({ nextSeq: 1, totalSeq: 1, durable: false })
    expect(f.read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, 1], [0, 1]])
    f.read.mockClear()
    await expect(f.children.history(1, { sessionId: 'root', childSessionId: 'child', after: 1 }))
      .resolves.toMatchObject({ nextSeq: 2, totalSeq: 2, entries: [{ turnEnded: true }] })
    expect(f.read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[1, 1], [1, 1]])
    expect(f.store.open).toHaveBeenCalledTimes(2); expect(f.close).toHaveBeenCalledTimes(2)
    await f.children.dispose()
  })

  it('serializes through cleanup and re-resolves a queued live child after it becomes cold', async () => {
    const f = fixture(), child = f.add('child'), gate = deferred<void>()
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    f.flush.mockImplementation(async () => { if (!f.agents.has(child.session.id)) throw new Error('not live in this store') })
    f.close.mockImplementationOnce(() => gate.promise)
    const request = { sessionId: 'root', childSessionId: 'child' }
    const first = f.children.history(1, request)
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
    const second = f.children.history(1, request)
    await vi.waitFor(() => expect(f.service.listDescendants).toHaveBeenCalledTimes(2))
    expect(f.store.open).toHaveBeenCalledOnce()
    f.agents.delete(child.session.id); gate.resolve()
    await expect(first).resolves.toMatchObject({ totalSeq: 1 })
    await expect(second).resolves.toMatchObject({ totalSeq: 1, durable: true })
    expect(f.flush).toHaveBeenCalledOnce(); expect(f.store.stat).toHaveBeenCalledOnce()
    expect(f.store.open).toHaveBeenCalledTimes(2); expect(f.close).toHaveBeenCalledTimes(2)
    f.read.mockRejectedValueOnce(new Error('offline'))
    await expect(f.children.history(1, request)).rejects.toThrow('offline')
    await expect(f.children.history(1, request)).resolves.toMatchObject({ totalSeq: 1, durable: true })
    await f.children.dispose()
  })

  it.each(['short', 'oversized', 'gap'])('rejects a %s requested page even with an already cached index', async kind => {
    const f = fixture(); f.add('child')
    const event = { seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent
    f.logs.get('child')!.push(event)
    const request = { sessionId: 'root', childSessionId: 'child' }
    await f.children.history(1, request)
    f.read.mockResolvedValueOnce({ events: kind === 'short' ? [] : kind === 'oversized' ? [event, event] : [{ ...event, seq: 1 } as SessionEvent] })
    await expect(f.children.history(1, request)).rejects.toThrow(kind === 'gap' ? 'noncontiguous page' : 'required page')
    expect(f.close).toHaveBeenCalledTimes(2)
    await expect(f.children.history(1, request)).resolves.toMatchObject({ nextSeq: 1, totalSeq: 1 })
    await f.children.dispose()
  })

  it.each(['open', 'read', 'close'])('cancels an uncooperative %s but drains the actual read handle before disposal', async phase => {
    const f = fixture(), gate = deferred<void>(); f.add('child')
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    const open = f.store.open.getMockImplementation()!, read = f.read.getMockImplementation()!
    if (phase === 'open') f.store.open.mockImplementationOnce(async (...args) => { await gate.promise; return open(...args) })
    if (phase === 'read') f.read.mockImplementationOnce(async (...args) => { await gate.promise; return read(...args) })
    if (phase === 'close') f.close.mockImplementationOnce(() => gate.promise)
    const request = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    const rejected = expect(request).rejects.toThrow('session closed')
    const entered = phase === 'open' ? f.store.open : phase === 'read' ? f.read : f.close
    await vi.waitFor(() => expect(entered).toHaveBeenCalled())
    let done = false
    const disposal = f.children.dispose().then(() => { done = true })
    expect(f.store.open.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    if (phase !== 'open') expect(f.read.mock.calls[0]![3]!.signal!.aborted).toBe(true)
    await Promise.resolve(); expect(done).toBe(false)
    gate.resolve(); await rejected; await disposal
    expect(f.close).toHaveBeenCalledOnce(); expect(done).toBe(true)
    if (phase === 'open') expect(f.read).not.toHaveBeenCalled()
  })

  it('cancels a live-owner read after flush without opening storage and accepts a fresh request', async () => {
    const f = fixture(), gate = deferred<void>(); f.add('child')
    f.flush.mockImplementationOnce(() => gate.promise)
    const request = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    const rejected = expect(request).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.flush).toHaveBeenCalledOnce())
    f.root.work.cancel(); gate.resolve(); await rejected; await f.root.work.settle()
    expect(f.store.open).not.toHaveBeenCalled()
    await expect(f.children.history(1, { sessionId: 'root', childSessionId: 'child' })).resolves.toMatchObject({ nextSeq: 0, entries: [] })
    await f.children.dispose()
  })

  it('preserves read and close failures, including cleanup that finishes after disposal starts', async () => {
    const f = fixture(), gate = deferred<void>(); f.add('child')
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    const failure = new Error('read failed'), cleanup = new Error('close failed')
    f.read.mockRejectedValueOnce(failure)
    f.close.mockImplementationOnce(async () => { await gate.promise; throw cleanup })
    const request = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    const rejected = expect(request).rejects.toMatchObject({ errors: [failure, cleanup] })
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
    const disposal = f.children.dispose(), rejectedDisposal = expect(disposal).rejects.toMatchObject({ errors: [cleanup] })
    gate.resolve(); await rejected; await rejectedDisposal
  })

  it('stops projecting subsequent images when the live owner cancels during an image read', async () => {
    const f = fixture(), gate = deferred<ProjectedUpdate[]>(); f.add('child')
    for (let seq = 0; seq < 2; seq++) f.logs.get('child')!.push({ seq, time: 1000, type: 'tool/ptc-dispatch', data: {
      subCallId: `image-${seq}`, name: 'read', content: [{ type: 'image', mimeType: 'image/png', data: 'fixture' }],
    } } as unknown as SessionEvent)
    f.projectImages.mockImplementationOnce(() => gate.promise)
    const request = f.children.history(1, { sessionId: 'root', childSessionId: 'child' })
    const rejected = expect(request).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.projectImages).toHaveBeenCalledOnce())
    f.root.work.cancel(); gate.resolve([]); await rejected; await f.root.work.settle()
    expect(f.projectImages).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce()
    await f.children.dispose()
  })

  it('interrupts the latest exact attempt when a new turn starts while its history handle closes', async () => {
    const f = fixture(), child = f.add('child'), gate = deferred<void>()
    f.logs.get('child')!.push({ seq: 0, time: 1000, type: 'turn/start', data: { turn: 0 } } as SessionEvent)
    f.readers.get('child')!.mockImplementation(() => { throw new Error('no synchronous interruption read') })
    f.close.mockImplementationOnce(() => gate.promise)
    const request = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
    f.append(child, 'turn/end', { turn: 0, reason: { kind: 'completed' } })
    f.append(child, 'turn/start', { turn: 1 })
    gate.resolve()
    await vi.waitFor(() => expect(f.service.interrupt).toHaveBeenCalledOnce())
    let done = false
    void request.then(() => { done = true })
    f.emit('session/event', child.session, { seq: 1, time: 1001, type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } })
    await Promise.resolve(); expect(done).toBe(false)
    f.append(child, 'turn/end', { turn: 1, reason: { kind: 'aborted' } })
    await expect(request).resolves.toMatchObject({ result: { cancelled: true } })
    await f.children.dispose()
  })

  it.each(['finished', 'replaced'])('does not interrupt a child that was %s during the storage read', async kind => {
    const f = fixture(), child = f.add('child'), gate = deferred<void>()
    f.close.mockImplementationOnce(() => gate.promise)
    const request = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
    if (kind === 'finished') Object.assign(child, { status: 'idle' })
    else f.agents.set(child.session.id, { ...child } as Agent)
    gate.resolve()
    await expect(request).resolves.toMatchObject({ result: { cancelled: false, outcome: { kind: 'already_finished' } } })
    expect(f.service.interrupt).not.toHaveBeenCalled()
    await f.children.dispose()
  })

  it('preserves native child input admission, unique prefixes and compare-before-edit semantics', async () => {
    const f = fixture(), child = f.add('child-one')
    f.add('child-two')
    await expect(f.command('/subagents queue child hello')).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('Ambiguous') } })
    await f.command('/subagents queue child-one hello\nworld')
    expect(f.service.prompt).toHaveBeenCalledWith(expect.objectContaining({ parentSessionId: 'root', childSessionId: 'child-one', mode: 'continuable', delivery: 'queue', content: [{ type: 'text', text: 'hello\nworld' }] }), expect.any(AbortSignal))
    const queue = child.inbox.nextTurn as unknown as Array<{ id: string; content: Array<{ type: 'text'; text: string }> }>
    queue.push({ id: 'message-one', content: [{ type: 'text', text: 'original' }] })
    await expect(f.command('/subagents edit child-one message changed', { expectedText: 'stale' })).resolves.toMatchObject({ result: { kind: 'error' } })
    expect(child.inbox.replace).not.toHaveBeenCalled()
    await f.command('/subagents edit child-one message changed', { expectedText: 'original' })
    expect(queue[0]!.content).toEqual([{ type: 'text', text: 'changed' }])
    await expect(f.children.inbox(1, { sessionId: 'root', childId: 'child-one' })).resolves.toMatchObject({ items: [{ id: 'message-one', text: 'changed', editable: true }] })
    await f.command('/subagents steer-queued child-one all')
    expect(queue).toEqual([])
    expect(child.steer).toHaveBeenCalledOnce()
    await f.children.dispose()
  })

  it('names Agent Team teammates and protects their Team mailbox deliveries', async () => {
    const f = fixture(), child = f.add('mate')
    f.host.teamMembers.mockReturnValue([{ id: 'mate', name: 'reviewer' }])
    await f.children.snapshot(f.root)
    expect(f.notes().find(note => note.sessionUpdate === 'subagent_spawned')).toMatchObject({ persona: 'reviewer', role: 'teammate', description: 'worker mate' })
    const queue = child.inbox.nextTurn as unknown as Array<{ id: string; content: Array<{ type: 'text'; text: string }> }>
    queue.push({ id: 'delivery', content: [{ type: 'text', text: 'Team message' }] })
    for (const text of ['/subagents edit mate delivery changed', '/subagents remove mate delivery', '/subagents clear mate', '/subagents steer-queued mate all']) {
      await expect(f.command(text)).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('reviewer is an Agent Team member') } })
    }
    expect(queue).toHaveLength(1)
    expect(child.inbox.clear).not.toHaveBeenCalled()
    await expect(f.children.inbox(1, { sessionId: 'root', childId: 'mate' })).resolves.toMatchObject({ items: [{ id: 'delivery', editable: false }] })
    // Viewing, a new message and stopping stay available.
    await expect(f.command('/subagents pending mate')).resolves.toMatchObject({ result: { kind: 'success' } })
    await expect(f.command('/subagents queue mate hello')).resolves.toMatchObject({ result: { kind: 'success' } })
    // /team shows names, so the name selects the teammate too, and the list names it.
    await expect(f.command('/subagents queue reviewer hello')).resolves.toMatchObject({ result: { kind: 'success', text: expect.stringContaining('Queued child mate') } })
    await expect(f.command('/subagents clear reviewer')).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('reviewer is an Agent Team member') } })
    await expect(f.command('/subagents list')).resolves.toMatchObject({ result: { kind: 'success', text: expect.stringContaining('mate  running  continuable  reviewer (teammate) · worker mate') } })
    await f.children.dispose()
  })

  it('drains an accepted refresh while suppressing late work and releasing every subscription', async () => {
    const f = fixture(), listing = deferred<Row[]>()
    f.service.listDescendants.mockImplementationOnce(() => listing.promise)
    const refresh = f.children.snapshot(f.root)
    await Promise.resolve()
    let disposed = false
    const closing = f.children.dispose().then(() => { disposed = true })
    expect(f.stops).toHaveLength(7)
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
    expect(disposed).toBe(false)
    listing.resolve([{ kind: 'child', id: 'late', mode: 'continuable' }])
    await Promise.all([refresh, closing])
    expect(f.store.open).not.toHaveBeenCalled()
    expect(f.notes()).toEqual([])
    f.emit('subagent/start', { id: 'late' }); f.children.poll()
    await expect(f.children.command(1, { sessionId: 'root' })).rejects.toThrow('unknown session')
    await f.children.dispose()
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
  })

  it('aborts pending native admission and interruption waits during disposal', async () => {
    vi.useFakeTimers()
    const f = fixture(), child = f.add('child')
    f.append(child, 'turn/start', { turn: 0 })
    f.service.prompt.mockImplementationOnce((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('admission aborted')), { once: true })
    }))
    const command = f.command('/subagents queue child later')
    const cancel = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    const rejected = expect(cancel).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.service.interrupt).toHaveBeenCalledOnce())
    f.emit('workflow/end', { id: 'run' })
    expect(vi.getTimerCount()).toBe(2)
    await f.children.dispose(); await rejected
    await expect(command).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('admission aborted') } })
    expect(vi.getTimerCount()).toBe(0)
  })

  it('releases all subscriptions and pending refreshes even if one unsubscribe fails', async () => {
    const f = fixture()
    f.stops[0]!.mockImplementation(() => { throw new Error('unsubscribe failed') })
    await expect(f.children.dispose()).rejects.toThrow('subscription or read cleanup failed')
    expect(f.stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
    f.emit('subagent/start', { id: 'late' }); f.children.poll()
    expect(f.service.listDescendants).not.toHaveBeenCalled()
  })

  it('uses the shared heartbeat to abort admission and interruption for a withdrawn owner', async () => {
    vi.useFakeTimers()
    const f = fixture(), child = f.add('child')
    f.append(child, 'turn/start', { turn: 0 })
    f.service.prompt.mockImplementationOnce((_request, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('owner withdrawn')), { once: true })
    }))
    const command = f.command('/subagents queue child later')
    const cancel = f.children.cancel(1, { sessionId: 'root', subagentId: 'child' })
    const rejected = expect(cancel).rejects.toThrow('session closed')
    await vi.waitFor(() => expect(f.service.interrupt).toHaveBeenCalledOnce())
    f.sessions.delete(f.root.agent.session.id)
    f.children.poll()
    await rejected
    await expect(command).resolves.toMatchObject({ result: { kind: 'error', text: expect.stringContaining('owner withdrawn') } })
    expect(vi.getTimerCount()).toBe(0)
    await f.children.dispose()
  })

  it('rolls back partial subscription setup when construction cannot complete', async () => {
    const f = fixture()
    await f.children.dispose()
    const stops: Array<ReturnType<typeof vi.fn>> = []
    expect(() => createNativeChildren({ ...f.host, on: () => {
      if (stops.length === 3) throw new Error('event source unavailable')
      const stop = vi.fn(); stops.push(stop); return stop
    } })).toThrow('subscription setup failed')
    expect(stops).toHaveLength(3)
    expect(stops.every(stop => stop.mock.calls.length === 1)).toBe(true)
  })
})
