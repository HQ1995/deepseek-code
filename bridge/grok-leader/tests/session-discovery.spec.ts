import { afterEach, describe, expect, it, vi } from 'vitest'
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, type SessionHandle, type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import { createSessionDiscovery, type SessionQueryLike } from '../src/session-discovery.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())) })
function deferred<T = void>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(yes => { resolve = yes })
  return { promise, resolve }
}
const tick = async () => { for (let i = 0; i < 16; i++) await Promise.resolve() }
const event = (type: string, data: unknown, time: number): SessionEvent => ({ type, data, time, seq: time }) as SessionEvent
const prompt = (text: string, time = 1) => event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }, time)
const title = (text: string, time = 2) => event('session/title', { title: text }, time)
function fixture(cleanupError?: string) {
  const headers = new Map<string, SessionHeader>(), logs = new Map<string, readonly SessionEvent[]>()
  const revisions = new Map<string, string>(), owned = new Set<Session>()
  let active = 0, peak = 0, listener!: (session: Session, event: SessionEvent) => void
  const read = vi.fn(async (id: string, offset = 0, length = Number.MAX_SAFE_INTEGER, _options?: { signal?: AbortSignal }) => ({ events: (logs.get(id) ?? []).slice(offset, offset + length), eventState: 'owned' as const }))
  const close = vi.fn(async (_id: string) => { active-- })
  const open = vi.fn(async (id: SessionId, access: string, _options?: { signal?: AbortSignal }): Promise<SessionHandle> => {
    if (!headers.has(id)) throw new SessionPersistenceNotFoundError(id)
    expect(access).toBe('read')
    peak = Math.max(peak, ++active)
    return {
      id, header: headers.get(id)!, inheritedEventCount: SessionLogOffset(3), access: 'read',
      read: async (...args) => read(id, ...args), close: () => close(id), [Symbol.asyncDispose]: () => close(id),
      append: async () => { throw new Error('unexpected write') }, flush: async () => { throw new Error('unexpected flush') },
    }
  })
  const list = vi.fn(async (_options?: { signal?: AbortSignal }) => [...headers.values()].map(header => ({
    header, revision: SessionPersistenceRevision(revisions.get(header.id) ?? 'r1'),
  })))
  let store: Pick<SessionPersistence, 'open' | 'list'> | undefined = { open, list }
  const query = vi.fn<SessionQueryLike['searchSessions']>(async () => ({ items: [] }))
  let engine: SessionQueryLike | undefined = { searchSessions: query }
  const unsubscribe = vi.fn(), owns = vi.fn((session: Session) => owned.has(session))
  const persistence = vi.fn(() => store), queryEngine = vi.fn(() => engine)
  const discovery = createSessionDiscovery({ persistence, query: queryEngine, owns,
    onEvent: callback => { listener = callback; return unsubscribe } })
  stops.push(async () => {
    if (cleanupError === undefined) await discovery.dispose()
    else await expect(discovery.dispose()).rejects.toThrow(cleanupError)
  })
  const add = (id: string, cwd: string | null = '/work', events: readonly SessionEvent[] = [prompt(id)], createdAt = 0) => {
    const header: SessionHeader = { id: SessionId(id), createdAt, version: 0, isSeeded: false, ...cwd === null ? {} : { cwd } }
    headers.set(id, header); logs.set(id, events)
    return header
  }
  const live = (id: string) => { const session = { header: headers.get(id)! } as Session; owned.add(session); return session }
  const picker = async (params: unknown = {}) => (await discovery.list('x.ai/session/list', params)).sessions as Array<{
    sessionId: string; cwd: string; firstPrompt: string; title: string; summary: string; updatedAt: string;
  }>
  return { discovery, picker, add, live, emit: (session: Session, event: SessionEvent) => listener(session, event),
    read, open, close, list, query, owns, unsubscribe, headers, logs, revisions, persistence, queryEngine,
    store: () => store!, replace: (next: typeof store) => { store = next }, queryAvailable: (available: boolean) => { engine = available ? { searchSessions: query } : undefined },
    get active() { return active }, get peak() { return peak } }
}

describe('owned session discovery', () => {
  it('filters cwd before reading, backfills prompt/title before search, and retains exact-id cross-cwd resume', async () => {
    const f = fixture()
    f.add('local', '/work', [prompt('Needle prompt'), title('Reviewed title', 20)])
    f.add('foreign', '/other', [prompt('foreign prompt')])
    expect(await f.picker({ cwd: '/work', query: 'needle' })).toEqual([expect.objectContaining({
      sessionId: 'local', firstPrompt: 'Needle prompt', title: 'Reviewed title', summary: 'Reviewed title',
      updatedAt: new Date(20).toISOString(), _meta: { 'x.ai/session': { kind: 'chat' } },
    })])
    expect(f.open.mock.calls.map(call => call[0])).toEqual(['local'])
    expect((await f.picker({ cwd: '/work', query: 'FOREIGN' })).map(row => row.sessionId)).toEqual(['foreign'])
  })

  it('preserves both legacy list payloads without opening logs', async () => {
    const f = fixture(), a = f.add('a', '/work', [], 10), b = f.add('b', null, [], 20)
    await expect(f.discovery.list('session/list')).resolves.toEqual({ sessions: [{ sessionId: 'a', cwd: '/work', updatedAt: new Date(10).toISOString() }] })
    await expect(f.discovery.list('x.ai/sessions/list')).resolves.toEqual({ result: { sessions: [a, b].map(header => ({
      sessionId: header.id, cwd: header.cwd ?? '', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: header.createdAt,
    })) } })
    expect(f.open).not.toHaveBeenCalled()
  })

  it('answers every caller that lands during one durable listing from that listing', async () => {
    const f = fixture(), gate = deferred()
    f.add('a', '/work', [prompt('kept')])
    const list = f.list.getMockImplementation()!
    f.list.mockImplementation(async options => { await gate.promise; return list(options) })
    const roster = f.discovery.list('x.ai/sessions/list')
    const legacy = f.discovery.list('session/list')
    const picker = f.picker({ cwd: '/work' })
    await tick()
    expect(f.list).toHaveBeenCalledTimes(1)
    gate.resolve()
    expect((await picker)[0]).toMatchObject({ sessionId: 'a', firstPrompt: 'kept' })
    await expect(roster).resolves.toMatchObject({ result: { sessions: [expect.objectContaining({ sessionId: 'a' })] } })
    await expect(legacy).resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: 'a' })] })
    expect(f.list).toHaveBeenCalledTimes(1)
    // The shared listing belongs to the callers that were in flight; the next
    // caller after it settles pays its own read rather than reusing it.
    await f.discovery.list('x.ai/sessions/list')
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('never serves an in-flight listing to a remounted service', async () => {
    const f = fixture(), gate = deferred()
    f.add('a', '/work')
    const list = f.list.getMockImplementation()!
    f.list.mockImplementation(async options => { await gate.promise; return list(options) })
    const first = f.discovery.list('x.ai/sessions/list')
    await tick()
    f.replace({ open: f.open, list: f.list })
    const second = f.discovery.list('x.ai/sessions/list')
    await tick()
    expect(f.list).toHaveBeenCalledTimes(2)
    gate.resolve()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('caps rows after activity sorting while concurrent requests share cold loads and four handle lanes', async () => {
    const f = fixture(), gate = deferred()
    for (let i = 0; i < 105; i++) f.add(String(i), '/work', [prompt('prompt ' + i, i)])
    const read = f.read.getMockImplementation()!
    f.read.mockImplementation(async id => { await gate.promise; return read(id) })
    const first = f.picker(), second = f.picker({ limit: 1_000 })
    await tick(); const held = f.active
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(held).toBe(4); expect(f.peak).toBe(4); expect(f.active).toBe(0)
    expect(f.open).toHaveBeenCalledTimes(105)
    expect(a).toEqual(b); expect(a).toHaveLength(50)
    expect(a[0]).toMatchObject({ sessionId: '104', firstPrompt: 'prompt 104' })
    expect((await f.picker({ query: 'prompt 0', limit: 1 }))[0]).toMatchObject({ sessionId: '0', firstPrompt: 'prompt 0' })
  })

  it('keeps a picker pass wider than the default cap resident instead of evicting itself', async () => {
    const f = fixture()
    for (let i = 0; i < 150; i++) f.add(String(i), '/work', [prompt('prompt ' + i, i)])
    expect(await f.picker()).toHaveLength(50)
    expect(f.open).toHaveBeenCalledTimes(150)
    // A pass over the whole store must not evict its own earliest rows: both a
    // repeated pass and a cwd-scoped one reuse every unchanged session.
    await f.picker()
    await f.picker({ cwd: '/work', query: 'prompt 9' })
    expect(f.open).toHaveBeenCalledTimes(150)
    expect(f.active).toBe(0)
    // Only a changed revision re-reads, and only that session.
    f.revisions.set('0', 'r2')
    expect((await f.picker({ query: 'prompt 0', limit: 1 }))[0]).toMatchObject({ sessionId: '0', firstPrompt: 'prompt 0' })
    expect(f.open).toHaveBeenCalledTimes(151)
  })

  it('caches empty logs with unchanged revisions and refreshes changed revisions', async () => {
    const f = fixture(); f.add('a', '/work', [])
    expect((await f.picker())[0]!.firstPrompt).toBe('')
    f.logs.set('a', [prompt('late prompt'), title('old')])
    expect((await f.picker())[0]!.firstPrompt).toBe('')
    expect(f.open).toHaveBeenCalledOnce()
    f.revisions.set('a', 'r1.1')
    expect((await f.picker())[0]!.firstPrompt).toBe('late prompt')
    await f.picker(); expect(f.open).toHaveBeenCalledTimes(2)
    f.logs.set('a', [prompt('late prompt'), title('new', 3)]); f.revisions.set('a', 'r2')
    expect((await f.picker())[0]!.title).toBe('new')
    expect(f.open).toHaveBeenCalledTimes(3)
  })

  it.each([
    new SessionPersistenceNotFoundError(SessionId('a')),
    new SessionPersistenceCorruptionError('invalid log', {}),
    new SessionFormatUnsupportedError('future log'),
  ])('retries an unreadable artifact without swallowing operational failure: %s', async error => {
    const f = fixture(); f.add('a')
    f.open.mockRejectedValueOnce(error)
    expect((await f.picker())[0]!.firstPrompt).toBe('')
    expect((await f.picker())[0]!.firstPrompt).toBe('a')
    f.revisions.set('a', 'r2')
    const operational = new Error('storage offline'); f.open.mockRejectedValueOnce(operational)
    await expect(f.picker()).rejects.toBe(operational)
  })

  it('never treats handle cleanup failure as a retryable missing artifact', async () => {
    const f = fixture(), failure = new SessionPersistenceNotFoundError(SessionId('a'))
    f.add('a'); f.close.mockImplementationOnce(async () => { throw failure })
    await expect(f.picker()).rejects.toBe(failure)
  })

  it('keeps exact owned live projections and native ranking without opening search hits', async () => {
    const f = fixture(), a = f.add('a'), b = f.add('b')
    const owned = f.live('a')
    f.emit({ header: a } as Session, title('foreign same id', 50))
    f.emit(owned, title('live title', 40))
    f.query.mockResolvedValue({ items: [
      { header: b, bestMatch: { time: 20, snippet: 'ranked first', type: 'tool/result' } },
      { header: a, bestMatch: { time: 10, snippet: 'ranked second', type: 'user/message' } },
    ], nextCursor: 'next' })
    await expect(f.discovery.search({ query: ' needle ', limit: 1_000, cursor: 'cursor', includeContent: true })).resolves.toEqual({
      results: [
        { sessionId: 'b', cwd: '/work', summary: 'ranked first', updatedAt: new Date(20).toISOString(), score: 0, matchedFields: ['content'], snippet: 'ranked first' },
        { sessionId: 'a', cwd: '/work', summary: 'live title', updatedAt: new Date(40).toISOString(), score: 0, matchedFields: ['content'], snippet: 'ranked second' },
      ], nextCursor: 'next', nextOffset: null, totalEstimate: null, bootstrapping: false,
    })
    expect(f.query).toHaveBeenCalledWith({ query: 'needle', limit: 100, cursor: 'cursor' }, { signal: expect.any(AbortSignal) })
    expect(f.open).not.toHaveBeenCalled(); expect(f.list).not.toHaveBeenCalled()
  })

  it('does not reuse another persistence instance revision or let its late read overwrite the replacement index', async () => {
    const f = fixture(), gate = deferred(); f.add('a', '/work', [prompt('old'), title('old title')])
    const oldRead = f.read.getMockImplementation()!
    f.read.mockImplementationOnce(async id => { const result = await oldRead(id); await gate.promise; return result })
    const old = f.picker(); await tick()
    const store = f.store()
    f.replace({ list: store.list, open: async (...args) => {
      const handle = await store.open(...args)
      return { ...handle, read: async () => ({ events: [prompt('new'), title('new title', 30)], eventState: 'owned' }) }
    } })
    const fresh = await f.picker()
    gate.resolve(); const stale = await old
    expect(fresh[0]!.title).toBe('new title'); expect(stale[0]!.title).toBe('old title')
    expect((await f.picker())[0]!.title).toBe('new title')
    expect(f.open).toHaveBeenCalledTimes(2)
  })

  it('invalidates old picker titles before direct search after a storage remount without rereading logs', async () => {
    const f = fixture(), gate = deferred(), header = f.add('a', '/work', [prompt('old'), title('old title')])
    await f.picker()
    f.query.mockImplementationOnce(async () => { await gate.promise; return { items: [{ header, bestMatch: { time: 10, snippet: 'old match', type: 'user/message' } }] } })
    const pending = f.discovery.search({ query: 'old' }); await tick()
    f.replace({ ...f.store() })
    f.query.mockResolvedValue({ items: [{ header, bestMatch: { time: 40, snippet: 'replacement match', type: 'user/message' } }] })
    const fresh = await f.discovery.search({ query: 'replacement' })
    gate.resolve(); const old = await pending
    expect(fresh).toMatchObject({ results: [{ summary: 'replacement match' }] })
    expect(old).toMatchObject({ results: [{ summary: 'old title' }] })
    expect(f.open).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce()
  })

  it('returns exact inspection metadata only after close and preserves primary plus cleanup errors', async () => {
    const f = fixture(), gate = deferred(); const header = f.add('a')
    f.close.mockImplementationOnce(async () => gate.promise)
    let done = false
    const read = f.discovery.inspect(SessionId('a')).then(value => { done = true; return value })
    await tick(); const early = done; gate.resolve()
    expect(await read).toEqual({ meta: header, inheritedEventCount: 3, events: [prompt('a')] })
    expect(early).toBe(false)
    const failure = new Error('read failed'), close = new Error('close failed')
    f.read.mockRejectedValueOnce(failure); f.close.mockRejectedValueOnce(close)
    await expect(f.discovery.inspect(SessionId('a'))).rejects.toMatchObject({ errors: [failure, close] })
  })

  it('reads an explicit complete prefix and refuses a short prefix instead of returning partial history', async () => {
    const f = fixture(); f.add('a', '/work', [prompt('first'), title('later')])
    await expect(f.discovery.inspect(SessionId('a'), { end: SessionLogOffset(1) })).resolves.toMatchObject({ events: [prompt('first')] })
    expect(f.read).toHaveBeenCalledWith('a', undefined, 1, { signal: expect.any(AbortSignal) })
    await expect(f.discovery.inspect(SessionId('a'), { end: SessionLogOffset(3) })).rejects.toThrow('required durable prefix')
    await expect(f.discovery.inspect(SessionId('a'), { end: SessionLogOffset(0) })).resolves.toMatchObject({ events: [] })
    expect(f.active).toBe(0); expect(f.close).toHaveBeenCalledTimes(3)
  })

  it('honors caller cancellation after a late open, closes its handle, and keeps other inspections usable', async () => {
    const f = fixture(), gate = deferred(), controller = new AbortController(); f.add('a')
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(async (...args) => { const handle = await open(...args); await gate.promise; return handle })
    const request = f.discovery.inspect(SessionId('a'), { signal: controller.signal }), failed = request.catch(error => error)
    await tick(); controller.abort(new Error('caller closed'))
    expect(f.open.mock.calls[0]![2]!.signal!.aborted).toBe(true)
    gate.resolve(); expect(await failed).toMatchObject({ message: 'caller closed' })
    expect(f.read).not.toHaveBeenCalled(); expect(f.active).toBe(0)
    await expect(f.discovery.inspect(SessionId('a'))).resolves.toMatchObject({ events: [prompt('a')] })
  })

  it('rejects an already-cancelled inspection before native open', async () => {
    const f = fixture(), controller = new AbortController(); f.add('a')
    controller.abort(new Error('not admitted'))
    await expect(f.discovery.inspect(SessionId('a'), { signal: controller.signal })).rejects.toThrow('not admitted')
    expect(f.open).not.toHaveBeenCalled()
  })

  it('selects compact values from bounded contiguous pages with one handle and a fixed end', async () => {
    const f = fixture(), events = Array.from({ length: 1030 }, (_, seq) => event('session/title', { title: 'body'.repeat(2048) }, seq))
    f.add('a', '/work', events)
    const selected = await f.discovery.select(SessionId('a'), { end: SessionLogOffset(1027) }, event => event.seq % 256 === 0 ? event.seq : undefined)
    expect(selected).toEqual([0, 256, 512, 768, 1024])
    expect(f.read.mock.calls.map(([, offset, length]) => [offset, length])).toEqual([[0, 256], [256, 256], [512, 256], [768, 256], [1024, 3]])
    expect(f.open).toHaveBeenCalledOnce(); expect(f.close).toHaveBeenCalledOnce()
    expect(f.peak).toBe(1); expect(f.active).toBe(0); expect(f.query).not.toHaveBeenCalled()
  })

  it.each(['short', 'oversized', 'gap'])('rejects a %s page without publishing partial selected history', async kind => {
    const f = fixture(); f.add('a', '/work', [])
    const events = Array.from({ length: kind === 'short' ? 1 : kind === 'oversized' ? 3 : 2 }, (_, seq) => title('value', kind === 'gap' ? seq + 1 : seq))
    f.read.mockResolvedValueOnce({ events, eventState: 'owned' })
    await expect(f.discovery.select(SessionId('a'), { end: SessionLogOffset(2) }, event => event.seq)).rejects.toThrow(kind === 'gap' ? 'noncontiguous page' : 'required durable page')
    expect(f.close).toHaveBeenCalledOnce(); expect(f.active).toBe(0)
  })

  it('cancels between pages, waits for an uncooperative read and close, and never projects the cancelled page', async () => {
    const f = fixture(), gate = deferred(), closeGate = deferred(), controller = new AbortController()
    f.add('a', '/work', Array.from({ length: 300 }, (_, seq) => title('value', seq)))
    const read = f.read.getMockImplementation()!
    f.read.mockImplementation(async (...args) => { if (args[1] === 256) await gate.promise; return read(...args) })
    f.close.mockImplementationOnce(async () => closeGate.promise)
    const project = vi.fn((event: SessionEvent) => event.seq)
    let done = false
    const request = f.discovery.select(SessionId('a'), { end: SessionLogOffset(300), signal: controller.signal }, project)
    const failed = request.catch(error => { done = true; return error })
    try {
      await vi.waitFor(() => expect(f.read).toHaveBeenCalledTimes(2))
      controller.abort(new Error('caller closed'))
      expect(f.read.mock.calls[1]![3]!.signal!.aborted).toBe(true)
      expect(done).toBe(false); expect(project).toHaveBeenCalledTimes(256)
      gate.resolve(); await vi.waitFor(() => expect(f.close).toHaveBeenCalledOnce())
      expect(done).toBe(false); expect(project).toHaveBeenCalledTimes(256)
      closeGate.resolve(); expect(await failed).toMatchObject({ message: 'caller closed' })
    } finally { gate.resolve(); closeGate.resolve() }
  })

  it('retains projection and cleanup errors and checks cancellation after asynchronous close', async () => {
    const f = fixture(); f.add('a', '/work', [title('value', 0)])
    const failure = new Error('projection failed'), cleanup = new Error('cleanup failed')
    f.close.mockRejectedValueOnce(cleanup)
    await expect(f.discovery.select(SessionId('a'), { end: SessionLogOffset(1) }, () => { throw failure }))
      .rejects.toMatchObject({ errors: [failure, cleanup] })
    const gate = deferred(), controller = new AbortController()
    f.close.mockImplementationOnce(async () => gate.promise)
    const request = f.discovery.select(SessionId('a'), { end: SessionLogOffset(1), signal: controller.signal }, event => event.seq)
    const failed = request.catch(error => error)
    await vi.waitFor(() => expect(f.close).toHaveBeenCalledTimes(2))
    controller.abort(new Error('closed before publication')); gate.resolve()
    expect(await failed).toMatchObject({ message: 'closed before publication' })
  })

  it('supports an empty prefix and rejects invalid cursors before opening storage', async () => {
    const f = fixture(); f.add('a')
    await expect(f.discovery.select(SessionId('a'), { end: SessionLogOffset(0) }, () => 'unreachable')).resolves.toEqual([])
    expect(f.read).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
    for (const end of [-1, NaN, Infinity, 1.5]) {
      await expect(f.discovery.select(SessionId('a'), { end: end as SessionLogOffset }, () => 0)).rejects.toThrow('invalid session inspection end')
    }
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('cancels listing before any subsequent log open but waits for an uncooperative backend', async () => {
    const f = fixture(), gate = deferred(); f.add('a')
    const list = f.list.getMockImplementation()!
    f.list.mockImplementationOnce(async options => { await gate.promise; return list(options) })
    const request = f.picker(), rejected = expect(request).rejects.toThrow('disposed')
    await tick()
    const signal = f.list.mock.calls[0]![0]!.signal!
    let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve(); await rejected; await disposal
    expect(signal.aborted).toBe(true); expect(early).toBe(false)
    expect(f.open).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('closes a late open without reading it and waits for its asynchronous close', async () => {
    const f = fixture(), openGate = deferred(), closeGate = deferred(); f.add('a')
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(async (...args) => { const handle = await open(...args); await openGate.promise; return handle })
    f.close.mockImplementationOnce(async () => closeGate.promise)
    const request = f.discovery.inspect(SessionId('a')), rejected = expect(request).rejects.toThrow('disposed')
    await tick(); let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    openGate.resolve(); await tick(); const early = done
    closeGate.resolve(); await rejected; await disposal
    expect(early).toBe(false); expect(f.read).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
  })

  it('drains sibling and queued inspections after the parent list already rejected', async () => {
    const f = fixture(), gate = deferred(), failure = new Error('first read failed')
    for (let i = 0; i < 12; i++) f.add(String(i))
    const read = f.read.getMockImplementation()!
    f.read.mockImplementation(async id => { if (id === '0') throw failure; await gate.promise; return read(id) })
    await expect(f.picker()).rejects.toBe(failure)
    const opened = f.open.mock.calls.length
    let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve(); await disposal
    expect(early).toBe(false); expect(f.active).toBe(0)
    expect(f.open).toHaveBeenCalledTimes(opened)
    expect(f.close).toHaveBeenCalledTimes(opened)
  })

  it('publishes one disposal before unsubscribe reentry and retains late cleanup errors', async () => {
    const f = fixture('session discovery cleanup failed'), gate = deferred(); f.add('a')
    const unsubscribe = new Error('unsubscribe failed'), close = new Error('close failed')
    f.read.mockImplementationOnce(async () => { await gate.promise; return { events: [], eventState: 'owned' } })
    f.close.mockRejectedValueOnce(close)
    const request = f.discovery.inspect(SessionId('a')), failed = request.catch(error => error)
    await tick()
    let reentered!: Promise<void>
    f.unsubscribe.mockImplementationOnce(() => { reentered = f.discovery.dispose(); throw unsubscribe })
    const disposal = f.discovery.dispose(), cleanup = expect(disposal).rejects.toMatchObject({ errors: [unsubscribe, close] })
    expect(reentered).toBe(disposal); expect(f.discovery.dispose()).toBe(disposal)
    gate.resolve(); await failed; await cleanup
    await expect(f.discovery.search({ query: 'x' })).rejects.toThrow('disposed')
    await expect(f.picker()).rejects.toThrow('disposed')
    expect(f.query).not.toHaveBeenCalled()
  })

  it('owns pending search and guards reentrant native getters before starting work', async () => {
    const f = fixture(), gate = deferred()
    f.query.mockImplementationOnce(async () => { await gate.promise; return { items: [] } })
    const request = f.discovery.search({ query: 'query' }), rejected = expect(request).rejects.toThrow('disposed')
    await tick(); let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(); const early = done
    gate.resolve(); await rejected; await disposal
    expect(early).toBe(false); expect(f.query.mock.calls[0]![1]!.signal!.aborted).toBe(true)
    const other = fixture()
    other.queryEngine.mockImplementationOnce(() => { void other.discovery.dispose(); return { searchSessions: other.query } })
    await expect(other.discovery.search({ query: 'query' })).rejects.toThrow('disposed')
    expect(other.query).not.toHaveBeenCalled()
  })

  it('resolves optional services lazily and validates search before native calls', async () => {
    const f = fixture(); f.replace(undefined); f.queryAvailable(false)
    await expect(f.picker()).rejects.toThrow('persistence is not configured')
    await expect(f.discovery.search({ query: ' ' })).rejects.toThrow('non-empty query')
    await expect(f.discovery.search({ query: 'ok' })).rejects.toThrow('search is not configured')
    f.queryAvailable(true)
    await expect(f.discovery.search({ query: 'ok', limit: NaN })).resolves.toMatchObject({ results: [], nextCursor: null })
    expect(f.query).toHaveBeenCalledWith({ query: 'ok', limit: 20 }, { signal: expect.any(AbortSignal) })
  })
})
