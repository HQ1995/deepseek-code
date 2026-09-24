import { afterEach, describe, expect, it, vi } from 'vitest'
import { symbols } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, type SessionHandle, type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import { createSessionDiscovery, type SessionProjectionCacheLike, type SessionQueryLike } from '../src/session-discovery.ts'
import { tick } from './support/async.ts'
import { event } from './support/session-events.ts'

const stops: Array<() => Promise<void>> = []
afterEach(async () => { await Promise.all(stops.splice(0).map(stop => stop())) })
/** The wrapper cordis puts in front of a service on every ctx lookup: a fresh
 * proxy per call whose only contract here is that symbols.original names the
 * instance it stands for. */
const traceable = <T extends object>(value: T): T => new Proxy(value, {
  get: (target, property, receiver) => property === symbols.original ? target : Reflect.get(target, property, receiver),
})
const prompt = (text: string, time = 1) => event('user/message', { source: { kind: 'user' }, content: [{ type: 'text', text }] }, time, time)
const title = (text: string, time = 2) => event('session/title', { title: text }, time, time)
function fixture(cleanupError?: string) {
  const headers = new Map<string, SessionHeader>(), logs = new Map<string, readonly SessionEvent[]>()
  const revisions = new Map<string, string>(), owned = new Set<Session>()
  let active = 0, peak = 0
  let listener!: (session: Session, event: SessionEvent) => void, announced!: (session: Session) => void
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
  // The host reads the service out of cordis, which answers every lookup with
  // a fresh proxy over the same instance. The plain object above never
  // reproduced that churn — and the identity caches only ever see wrappers in
  // production — so wrapLookups() hands out stacked wrappers like the runtime
  // can, and the instance underneath still has to be what those caches key on.
  let lookupWraps = false
  const query = vi.fn<SessionQueryLike['searchSessions']>(async () => ({ items: [] }))
  let engine: SessionQueryLike | undefined = { searchSessions: query }
  const unsubscribe = vi.fn(), unsubscribeCreated = vi.fn(), owns = vi.fn((session: Session) => owned.has(session))
  const persistence = vi.fn(() => store === undefined ? undefined : lookupWraps ? traceable(traceable(store)) : store)
  const queryEngine = vi.fn(() => engine)
  let cache: SessionProjectionCacheLike | undefined
  const projectionCache = vi.fn(() => cache)
  const warnings: string[] = []
  const discovery = createSessionDiscovery({ persistence, query: queryEngine, owns, projectionCache,
    log: message => { warnings.push(message) },
    onEvent: callback => { listener = callback; return unsubscribe },
    onCreated: callback => { announced = callback; return unsubscribeCreated } })
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
  const roster = async (params?: unknown) => ((await discovery.list('x.ai/sessions/list', params)) as {
    result: { sessions: Array<Record<string, unknown>> }
  }).result.sessions
  return { discovery, picker, roster, add, live, emit: (session: Session, event: SessionEvent) => listener(session, event),
    announce: (session: Session) => announced(session),
    read, open, close, list, query, owns, unsubscribe, unsubscribeCreated, headers, logs, revisions, persistence, queryEngine,
    projectionCache, warnings, provideCache: (next: SessionProjectionCacheLike | undefined) => { cache = next },
    store: () => store!, replace: (next: typeof store) => { store = next }, queryAvailable: (available: boolean) => { engine = available ? { searchSessions: query } : undefined },
    wrapLookups: () => { lookupWraps = true },
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

  it('lists conversations the user started, not subagent or teammate children, which still resume by exact id', async () => {
    const f = fixture()
    f.add('lead', '/work', [prompt('lead prompt')])
    const child = f.add('child', '/work', [prompt('<system-reminder> You are teammate')])
    f.headers.set('child', { ...child, parentSession: SessionId('lead'), origin: 'subagent', delegationDepth: 1 })
    const fork = f.add('fork', '/work', [prompt('forked prompt')])
    f.headers.set('fork', { ...fork, parentSession: SessionId('lead'), isSeeded: true })
    expect((await f.picker({ cwd: '/work' })).map(row => row.sessionId).sort()).toEqual(['fork', 'lead'])
    expect((await f.roster()).map(row => row.sessionId).sort()).toEqual(['fork', 'lead'])
    // Its log is not even opened for the listing.
    expect(f.open.mock.calls.map(call => call[0])).not.toContain('child')
    expect((await f.picker({ cwd: '/work', query: 'child' })).map(row => row.sessionId)).toEqual(['child'])
  })

  it('preserves both legacy list payloads without opening logs', async () => {
    const f = fixture(), a = f.add('a', '/work', [], 10), b = f.add('b', null, [], 20)
    await expect(f.discovery.list('session/list')).resolves.toEqual({ sessions: [{ sessionId: 'a', cwd: '/work', updatedAt: new Date(10).toISOString() }] })
    await expect(f.discovery.list('x.ai/sessions/list')).resolves.toEqual({ result: { sessions: [a, b].map(header => ({
      sessionId: header.id, cwd: header.cwd ?? '', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: header.createdAt,
    })) } })
    expect(f.open).not.toHaveBeenCalled()
  })

  it('fills roster titles from the projection cache without opening logs', async () => {
    const f = fixture()
    f.add('titled', '/work', [], 10)
    f.add('blank', '/work', [], 20)
    f.add('unknown', '/work', [], 30)
    const seen: Array<{ id: string; cut: number; keys: readonly string[] | undefined }> = []
    f.provideCache({
      cachedSnapshot: (header, cut, keys) => {
        seen.push({ id: String(header.id), cut: Number(cut), keys })
        if (header.id === SessionId('titled')) return { values: { title: '  Cached roster title  ' } }
        if (header.id === SessionId('blank')) return { values: { title: '   ' } }
        return undefined
      },
      cachedPredecessorTitle: () => undefined,
    })
    await expect(f.discovery.list('x.ai/sessions/list')).resolves.toEqual({ result: { sessions: [
      { sessionId: 'titled', cwd: '/work', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: 10, title: 'Cached roster title' },
      { sessionId: 'blank', cwd: '/work', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: 20 },
      { sessionId: 'unknown', cwd: '/work', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: 30 },
    ] } })
    expect(f.open).not.toHaveBeenCalled()
    expect(seen.map(entry => [entry.id, entry.cut])).toEqual([['titled', 0], ['blank', 0], ['unknown', 0]])
    expect(seen.map(entry => entry.keys)).toEqual([['title'], ['title'], ['title']])
    expect(f.warnings).toEqual([])
  })

  it('reads the predecessor title when only an older format left a record', async () => {
    const f = fixture()
    f.add('older', '/work', [], 10)
    const predecessor = vi.fn((header: SessionHeader) => header.id === SessionId('older') ? { values: { title: 'Predecessor title' } } : undefined)
    f.provideCache({ cachedSnapshot: () => undefined, cachedPredecessorTitle: predecessor })
    await expect(f.discovery.list('x.ai/sessions/list')).resolves.toMatchObject({ result: { sessions: [
      expect.objectContaining({ sessionId: 'older', title: 'Predecessor title' }),
    ] } })
    expect(predecessor).toHaveBeenCalledTimes(1)
  })

  it('keeps a seeded header titleless and a broken cache from failing the listing', async () => {
    const f = fixture()
    f.add('seeded', '/work', [], 10)
    f.add('broken', '/work', [], 20)
    f.headers.set('seeded', { ...f.headers.get('seeded')!, isSeeded: true })
    const cachedSnapshot = vi.fn((header: SessionHeader) => {
      if (header.id === SessionId('broken')) throw new Error('cache is not initialized')
      return { values: { title: 'must not be used' } }
    })
    const cachedPredecessorTitle = vi.fn(() => ({ values: { title: 'must not be used' } }))
    f.provideCache({ cachedSnapshot, cachedPredecessorTitle })
    await expect(f.discovery.list('x.ai/sessions/list')).resolves.toEqual({ result: { sessions: [
      { sessionId: 'seeded', cwd: '/work', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: 10 },
      { sessionId: 'broken', cwd: '/work', isWorktree: false, yolo: false, activity: 'dormant', resident: false, lastChangeUnixMs: 20 },
    ] } })
    expect(cachedSnapshot.mock.calls.map(call => String(call[0].id))).toEqual(['broken'])
    expect(cachedPredecessorTitle).not.toHaveBeenCalled()
    expect(f.warnings).toEqual([
      'grok-leader: roster title for "broken" failed; serving the row without it: Error: cache is not initialized',
    ])
  })

  it('answers every caller that lands during one durable listing from that listing', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.add('a', '/work', [prompt('kept')])
    const list = f.list.getMockImplementation()!
    f.list.mockImplementation(async options => { await gate.promise; return list(options) })
    const roster = f.discovery.list('x.ai/sessions/list')
    const legacy = f.discovery.list('session/list')
    const picker = f.picker({ cwd: '/work' })
    await tick(16)
    expect(f.list).toHaveBeenCalledTimes(1)
    gate.resolve()
    expect((await picker)[0]).toMatchObject({ sessionId: 'a', firstPrompt: 'kept' })
    await expect(roster).resolves.toMatchObject({ result: { sessions: [expect.objectContaining({ sessionId: 'a' })] } })
    await expect(legacy).resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: 'a' })] })
    expect(f.list).toHaveBeenCalledTimes(1)
    // The share belongs to the callers that were in flight; the settled
    // listing then keeps answering every list for its window, the picker
    // included — its row folds the header and revision that listing carried,
    // so it costs no second listing.
    expect((await f.roster()).map(row => row.sessionId)).toEqual(['a'])
    await expect(f.discovery.list('session/list')).resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: 'a' })] })
    expect(f.list).toHaveBeenCalledTimes(1)
    expect(await f.picker()).toHaveLength(1)
    expect(f.list).toHaveBeenCalledTimes(1)
  })

  it('keeps one settled listing answering the roster until its window expires', async () => {
    const f = fixture()
    f.add('a', '/work')
    // The listing stamps its own settle time, so the clock has to be pinned
    // before the call that settles it. Reading Date.now() afterwards hands the
    // window the gap between the two as time it had already spent, and a slow
    // enough worker then measures a deadline that never existed.
    const BASE = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(BASE)
    try {
      expect((await f.roster()).map(row => row.sessionId)).toEqual(['a'])
      expect(f.list).toHaveBeenCalledOnce()
      clock.mockReturnValue(BASE + 9_999)
      expect((await f.roster()).map(row => row.sessionId)).toEqual(['a'])
      await expect(f.discovery.list('session/list')).resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: 'a' })] })
      expect(f.list).toHaveBeenCalledOnce()
      // The deadline covers a store this process never hears about: a store
      // another process writes is re-listed, not reused.
      clock.mockReturnValue(BASE + 10_001)
      expect((await f.roster()).map(row => row.sessionId)).toEqual(['a'])
      expect(f.list).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })

  it('ends the window when the process announces a session and reopens it from the next listing', async () => {
    const f = fixture()
    f.add('a', '/work')
    expect(await f.roster()).toHaveLength(1)
    expect(await f.roster()).toHaveLength(1)
    expect(f.list).toHaveBeenCalledOnce()
    // An announced session is a row the listing never carried, so the next
    // poll must list again rather than answer without it.
    f.add('b', '/work')
    f.announce({ header: f.headers.get('b')! } as Session)
    expect((await f.roster()).map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(f.list).toHaveBeenCalledTimes(2)
    expect(await f.roster()).toHaveLength(2)
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('never opens the window from a listing that started before an announcement', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.add('a', '/work')
    const list = f.list.getMockImplementation()!
    f.list.mockImplementation(async options => { await gate.promise; return list(options) })
    const inFlight = f.roster()
    await tick(16)
    f.add('b', '/work')
    f.announce({ header: f.headers.get('b')! } as Session)
    gate.resolve()
    expect((await inFlight).map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(f.list).toHaveBeenCalledOnce()
    // The listing cannot prove which side of its own store read the announced
    // session's artifact fell on, so the next poll pays its own read.
    expect((await f.roster()).map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('never serves a settled listing to a remounted service', async () => {
    const f = fixture()
    f.add('a', '/work')
    await f.roster()
    expect(f.list).toHaveBeenCalledOnce()
    f.replace({ open: f.open, list: f.list })
    expect(await f.roster()).toHaveLength(1)
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('serves the picker from one settled listing and pays its own only past the window', async () => {
    const f = fixture()
    f.add('a', '/work', [prompt('kept', 9)], 9)
    const BASE = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(BASE)
    try {
      expect((await f.picker())[0]).toMatchObject({ sessionId: 'a', firstPrompt: 'kept' })
      expect(f.list).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce()
      // The row a settled listing serves the picker is folded from the header
      // and the revision that listing carried, which the resident index still
      // answers, so a repeat pass pays no listing and no log read.
      expect((await f.picker())[0]).toMatchObject({ sessionId: 'a', firstPrompt: 'kept' })
      expect(f.list).toHaveBeenCalledOnce(); expect(f.open).toHaveBeenCalledOnce()
      // A session another process wrote is a row this process never announced,
      // so nothing ends the window early: the set it settled stands until the
      // deadline, and the listing after that carries the row.
      f.add('b', '/work', [prompt('kept b', 5)], 5)
      expect((await f.picker()).map(row => row.sessionId)).toEqual(['a'])
      expect(f.list).toHaveBeenCalledOnce()
      clock.mockReturnValue(BASE + 10_001)
      expect((await f.picker()).map(row => row.sessionId)).toEqual(['a', 'b'])
      expect(f.list).toHaveBeenCalledTimes(2); expect(f.open).toHaveBeenCalledTimes(2)
    } finally { clock.mockRestore() }
  })

  it('ends the picker window when the process announces a session', async () => {
    const f = fixture()
    f.add('a', '/work', [prompt('kept', 9)], 9)
    expect(await f.picker()).toHaveLength(1)
    expect(await f.picker()).toHaveLength(1)
    expect(f.list).toHaveBeenCalledOnce()
    // An announced session is a row the listing never carried, so the next
    // picker call lists again rather than answer without it.
    f.add('b', '/work', [prompt('kept b', 5)], 5)
    f.announce({ header: f.headers.get('b')! } as Session)
    expect((await f.picker()).map(row => row.sessionId)).toEqual(['a', 'b'])
    expect(f.list).toHaveBeenCalledTimes(2)
    expect(await f.picker()).toHaveLength(2)
    expect(f.list).toHaveBeenCalledTimes(2)
  })

  it('keys the shared listing, the settled window and the picker index on the service a cordis lookup wraps', async () => {
    const f = fixture()
    f.wrapLookups()
    f.add('a', '/work', [prompt('kept'), title('Reviewed title', 20)])
    // Three lookups hand discovery three different wrappers over one service;
    // the callers in flight still share the one listing those wrappers paid for.
    const roster = f.discovery.list('x.ai/sessions/list')
    const legacy = f.discovery.list('session/list')
    const picker = f.picker({ cwd: '/work' })
    await expect(roster).resolves.toMatchObject({ result: { sessions: [expect.objectContaining({ sessionId: 'a' })] } })
    await expect(legacy).resolves.toMatchObject({ sessions: [expect.objectContaining({ sessionId: 'a' })] })
    expect(await picker).toMatchObject([{ sessionId: 'a', firstPrompt: 'kept', title: 'Reviewed title' }])
    expect(f.list).toHaveBeenCalledOnce()
    // The settled window covers the wrappers that arrive after it, the way it
    // covers repeat polls on one stable object.
    expect((await f.roster()).map(row => row.sessionId)).toEqual(['a'])
    expect(f.list).toHaveBeenCalledOnce()
    // The picker is answered by the same settled listing, and its resident
    // projections belong to the service, so neither a fresh wrapper nor the
    // window's reuse evicts the log read behind the row.
    expect(await f.picker({ cwd: '/work' })).toMatchObject([{ sessionId: 'a', firstPrompt: 'kept' }])
    expect(f.list).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledOnce()
  })

  it('still refuses a settled listing and the picker index when a remount brings a new service behind the wrappers', async () => {
    const f = fixture()
    f.wrapLookups()
    f.add('a', '/work', [prompt('kept')])
    await f.roster()
    // The picker inside the roster's window folds the same service's header
    // and revision: no second listing, and the resident index still owns the
    // one log read behind the row.
    await f.picker({ cwd: '/work' })
    expect(f.list).toHaveBeenCalledOnce()
    expect(f.open).toHaveBeenCalledOnce()
    // Same method references, new instance: identities handed out before the
    // remount describe revisions this store cannot vouch for.
    f.replace({ open: f.open, list: f.list })
    expect(await f.roster()).toHaveLength(1)
    expect(f.list).toHaveBeenCalledTimes(2)
    // The window the remount's own listing settled serves the picker its row,
    // but the index behind it was keyed on the old instance: the row is read
    // again from the new store rather than answered from the old projection.
    await f.picker({ cwd: '/work' })
    expect(f.list).toHaveBeenCalledTimes(2)
    expect(f.open).toHaveBeenCalledTimes(2)
  })

  it('never serves an in-flight listing to a remounted service', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.add('a', '/work')
    const list = f.list.getMockImplementation()!
    f.list.mockImplementation(async options => { await gate.promise; return list(options) })
    const first = f.discovery.list('x.ai/sessions/list')
    await tick(16)
    f.replace({ open: f.open, list: f.list })
    const second = f.discovery.list('x.ai/sessions/list')
    await tick(16)
    expect(f.list).toHaveBeenCalledTimes(2)
    gate.resolve()
    await expect(Promise.all([first, second])).resolves.toHaveLength(2)
  })

  it('caps rows after activity sorting while concurrent requests share cold loads and two handle lanes', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    for (let i = 0; i < 105; i++) f.add(String(i), '/work', [prompt('prompt ' + i, i)])
    const read = f.read.getMockImplementation()!
    f.read.mockImplementation(async id => { await gate.promise; return read(id) })
    const first = f.picker(), second = f.picker({ limit: 1_000 })
    await tick(16); const held = f.active
    gate.resolve()
    const [a, b] = await Promise.all([first, second])
    expect(held).toBe(2); expect(f.peak).toBe(2); expect(f.active).toBe(0)
    expect(f.open).toHaveBeenCalledTimes(105)
    expect(a).toEqual(b); expect(a).toHaveLength(50)
    expect(a[0]).toMatchObject({ sessionId: '104', firstPrompt: 'prompt 104' })
    expect((await f.picker({ query: 'prompt 0', limit: 1 }))[0]).toMatchObject({ sessionId: '0', firstPrompt: 'prompt 0' })
  })

  it('keeps a picker pass wider than the default cap resident instead of evicting itself', async () => {
    const f = fixture()
    for (let i = 0; i < 150; i++) f.add(String(i), '/work', [prompt('prompt ' + i, i)])
    const BASE = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(BASE)
    try {
      expect(await f.picker()).toHaveLength(50)
      expect(f.open).toHaveBeenCalledTimes(150)
      // A pass over the whole store must not evict its own earliest rows: both
      // a repeated pass and a cwd-scoped one reuse every unchanged session.
      await f.picker()
      await f.picker({ cwd: '/work', query: 'prompt 9' })
      expect(f.open).toHaveBeenCalledTimes(150)
      expect(f.active).toBe(0)
      // A durable revision no listing has reported yet is invisible to the
      // window that settled before it: the row it folded still answers.
      f.revisions.set('0', 'r2')
      expect((await f.picker({ query: 'prompt 0', limit: 1 }))[0]).toMatchObject({ sessionId: '0', firstPrompt: 'prompt 0' })
      expect(f.open).toHaveBeenCalledTimes(150)
      // The listing past the deadline reports it, and only that session reads.
      clock.mockReturnValue(BASE + 10_001)
      expect((await f.picker({ query: 'prompt 0', limit: 1 }))[0]).toMatchObject({ sessionId: '0', firstPrompt: 'prompt 0' })
      expect(f.open).toHaveBeenCalledTimes(151)
    } finally { clock.mockRestore() }
  })

  it('caches empty logs with unchanged revisions and refreshes changed revisions', async () => {
    const f = fixture(); f.add('a', '/work', [])
    const BASE = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(BASE)
    try {
      expect((await f.picker())[0]!.firstPrompt).toBe('')
      // The log moved but its revision did not, so the window's row stands.
      f.logs.set('a', [prompt('late prompt'), title('old')])
      expect((await f.picker())[0]!.firstPrompt).toBe('')
      expect(f.open).toHaveBeenCalledOnce()
      // A revision is only reported by a listing, so it is folded past the
      // deadline, and the listing that carried it settles the next window.
      f.revisions.set('a', 'r1.1')
      clock.mockReturnValue(BASE + 10_001)
      expect((await f.picker())[0]!.firstPrompt).toBe('late prompt')
      await f.picker(); expect(f.open).toHaveBeenCalledTimes(2)
      f.logs.set('a', [prompt('late prompt'), title('new', 3)]); f.revisions.set('a', 'r2')
      clock.mockReturnValue(BASE + 20_002)
      expect((await f.picker())[0]!.title).toBe('new')
      expect(f.open).toHaveBeenCalledTimes(3)
    } finally { clock.mockRestore() }
  })

  it.each([
    new SessionPersistenceNotFoundError(SessionId('a')),
    new SessionPersistenceCorruptionError('invalid log', {}),
    new SessionFormatUnsupportedError('future log'),
  ])('retries an unreadable artifact without swallowing operational failure: %s', async error => {
    const f = fixture(); f.add('a')
    const BASE = Date.now(), clock = vi.spyOn(Date, 'now').mockReturnValue(BASE)
    try {
      f.open.mockRejectedValueOnce(error)
      expect((await f.picker())[0]!.firstPrompt).toBe('')
      // An unreadable artifact was never folded, so the retry opens it again
      // inside the window rather than answer from the settled listing.
      expect((await f.picker())[0]!.firstPrompt).toBe('a')
      // A revision the settled listing never carried needs its own listing.
      f.revisions.set('a', 'r2')
      clock.mockReturnValue(BASE + 10_001)
      const operational = new Error('storage offline'); f.open.mockRejectedValueOnce(operational)
      await expect(f.picker()).rejects.toBe(operational)
    } finally { clock.mockRestore() }
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
    const f = fixture(), gate = Promise.withResolvers<void>(); f.add('a', '/work', [prompt('old'), title('old title')])
    const oldRead = f.read.getMockImplementation()!
    f.read.mockImplementationOnce(async id => { const result = await oldRead(id); await gate.promise; return result })
    const old = f.picker(); await tick(16)
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
    const f = fixture(), gate = Promise.withResolvers<void>(), header = f.add('a', '/work', [prompt('old'), title('old title')])
    await f.picker()
    f.query.mockImplementationOnce(async () => { await gate.promise; return { items: [{ header, bestMatch: { time: 10, snippet: 'old match', type: 'user/message' } }] } })
    const pending = f.discovery.search({ query: 'old' }); await tick(16)
    f.replace({ ...f.store() })
    f.query.mockResolvedValue({ items: [{ header, bestMatch: { time: 40, snippet: 'replacement match', type: 'user/message' } }] })
    const fresh = await f.discovery.search({ query: 'replacement' })
    gate.resolve(); const old = await pending
    expect(fresh).toMatchObject({ results: [{ summary: 'replacement match' }] })
    expect(old).toMatchObject({ results: [{ summary: 'old title' }] })
    expect(f.open).toHaveBeenCalledOnce(); expect(f.list).toHaveBeenCalledOnce()
  })

  it('returns exact inspection metadata only after close and preserves primary plus cleanup errors', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(); const header = f.add('a')
    f.close.mockImplementationOnce(async () => gate.promise)
    let done = false
    const read = f.discovery.inspect(SessionId('a')).then(value => { done = true; return value })
    await tick(16); const early = done; gate.resolve()
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
    const f = fixture(), gate = Promise.withResolvers<void>(), controller = new AbortController(); f.add('a')
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(async (...args) => { const handle = await open(...args); await gate.promise; return handle })
    const request = f.discovery.inspect(SessionId('a'), { signal: controller.signal }), failed = request.catch(error => error)
    await tick(16); controller.abort(new Error('caller closed'))
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
    const f = fixture(), events = Array.from({ length: 1030 }, (_, seq) => event('session/title', { title: 'body'.repeat(2048) }, seq, seq))
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
    const f = fixture(), gate = Promise.withResolvers<void>(), closeGate = Promise.withResolvers<void>(), controller = new AbortController()
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
    const gate = Promise.withResolvers<void>(), controller = new AbortController()
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
    const f = fixture(), gate = Promise.withResolvers<void>(); f.add('a')
    const list = f.list.getMockImplementation()!
    f.list.mockImplementationOnce(async options => { await gate.promise; return list(options) })
    const request = f.picker(), rejected = expect(request).rejects.toThrow('disposed')
    await tick(16)
    const signal = f.list.mock.calls[0]![0]!.signal!
    let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(16); const early = done
    gate.resolve(); await rejected; await disposal
    expect(signal.aborted).toBe(true); expect(early).toBe(false)
    expect(f.open).not.toHaveBeenCalled(); expect(f.unsubscribe).toHaveBeenCalledOnce()
  })

  it('closes a late open without reading it and waits for its asynchronous close', async () => {
    const f = fixture(), openGate = Promise.withResolvers<void>(), closeGate = Promise.withResolvers<void>(); f.add('a')
    const open = f.open.getMockImplementation()!
    f.open.mockImplementationOnce(async (...args) => { const handle = await open(...args); await openGate.promise; return handle })
    f.close.mockImplementationOnce(async () => closeGate.promise)
    const request = f.discovery.inspect(SessionId('a')), rejected = expect(request).rejects.toThrow('disposed')
    await tick(16); let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    openGate.resolve(); await tick(16); const early = done
    closeGate.resolve(); await rejected; await disposal
    expect(early).toBe(false); expect(f.read).not.toHaveBeenCalled(); expect(f.close).toHaveBeenCalledOnce()
  })

  it('drains sibling and queued inspections after the parent list already rejected', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>(), failure = new Error('first read failed')
    for (let i = 0; i < 12; i++) f.add(String(i))
    const read = f.read.getMockImplementation()!
    f.read.mockImplementation(async id => { if (id === '0') throw failure; await gate.promise; return read(id) })
    await expect(f.picker()).rejects.toBe(failure)
    const opened = f.open.mock.calls.length
    let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(16); const early = done
    gate.resolve(); await disposal
    expect(early).toBe(false); expect(f.active).toBe(0)
    expect(f.open).toHaveBeenCalledTimes(opened)
    expect(f.close).toHaveBeenCalledTimes(opened)
  })

  it('publishes one disposal before unsubscribe reentry and retains late cleanup errors', async () => {
    const f = fixture('session discovery cleanup failed'), gate = Promise.withResolvers<void>(); f.add('a')
    const unsubscribe = new Error('unsubscribe failed'), createdFeed = new Error('creation unsubscribe failed'), close = new Error('close failed')
    f.read.mockImplementationOnce(async () => { await gate.promise; return { events: [], eventState: 'owned' } })
    f.close.mockRejectedValueOnce(close)
    const request = f.discovery.inspect(SessionId('a')), failed = request.catch(error => error)
    await tick(16)
    let reentered!: Promise<void>
    f.unsubscribe.mockImplementationOnce(() => { reentered = f.discovery.dispose(); throw unsubscribe })
    f.unsubscribeCreated.mockImplementationOnce(() => { throw createdFeed })
    const disposal = f.discovery.dispose(), cleanup = expect(disposal).rejects.toMatchObject({ errors: [unsubscribe, createdFeed, close] })
    expect(reentered).toBe(disposal); expect(f.discovery.dispose()).toBe(disposal)
    gate.resolve(); await failed; await cleanup
    expect(f.unsubscribeCreated).toHaveBeenCalledOnce()
    await expect(f.discovery.search({ query: 'x' })).rejects.toThrow('disposed')
    await expect(f.picker()).rejects.toThrow('disposed')
    expect(f.query).not.toHaveBeenCalled()
  })

  it('owns pending search and guards reentrant native getters before starting work', async () => {
    const f = fixture(), gate = Promise.withResolvers<void>()
    f.query.mockImplementationOnce(async () => { await gate.promise; return { items: [] } })
    const request = f.discovery.search({ query: 'query' }), rejected = expect(request).rejects.toThrow('disposed')
    await tick(16); let done = false; const disposal = f.discovery.dispose().then(() => { done = true })
    await tick(16); const early = done
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
