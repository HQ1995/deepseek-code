import { SessionId, type Session, type SessionEvent, type SessionHeader, type SessionLogOffset } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  type SessionInspection, type SessionPersistence,
} from '@deepseek-ai/dsh-session-persistence'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import { SessionListIndex } from './session-list.ts'

/** Structural capability of the optional native full-text query engine. */
export interface SessionQueryLike {
  searchSessions(request: { query: string; limit?: number; cursor?: string }, exec?: { signal?: AbortSignal }): Promise<{
    items: Array<{
      header: Pick<SessionHeader, 'id' | 'createdAt' | 'cwd'>
      bestMatch: { time: number; snippet: string; type: string }
    }>
    nextCursor?: string
  }>
}
type DiscoveryPersistence = Pick<SessionPersistence, 'list' | 'open'>
type ListMethod = 'session/list' | 'x.ai/session/list' | 'x.ai/sessions/list'
interface InspectionOptions {
  /** Complete prefix required by a live lifecycle snapshot, never a moving tail. */
  end?: SessionLogOffset
  signal?: AbortSignal
}
interface DiscoveryHost {
  persistence(): DiscoveryPersistence | undefined
  query(): SessionQueryLike | undefined
  owns(session: Session): boolean
  onEvent(listener: (session: Session, event: SessionEvent) => void): () => void
}
export type SessionDiscovery = ReturnType<typeof createSessionDiscovery>

/** Picker/search projection and cold inspections share one read owner, not a
 * published session. It owns subscriptions, cache generations, accepted reads
 * and read-handle cleanup; disposal never races a cancelled result against a
 * backend still using a handle. Native storage retains all write ownership. */
export function createSessionDiscovery(host: DiscoveryHost) {
  const shutdown = new AbortController(), pending = new Set<Promise<unknown>>()
  const cleanupFailures: unknown[] = []
  let index = new SessionListIndex(), indexedStore: DiscoveryPersistence | undefined
  let closed = false, disposal: Promise<void> | undefined
  const assertOpen = () => { if (closed) throw internalError('session discovery has been disposed') }
  const accepted = <T>(operation: () => Promise<T>): Promise<T> => {
    if (closed) return Promise.reject(internalError('session discovery has been disposed'))
    // Publish before optional native getters/callbacks can reenter disposal.
    const result = Promise.resolve().then(() => { assertOpen(); return operation() })
      .then(value => { assertOpen(); return value })
    pending.add(result)
    void result.then(() => pending.delete(result), () => pending.delete(result))
    return result
  }
  const persistence = (): DiscoveryPersistence => {
    assertOpen()
    const store = host.persistence()
    assertOpen()
    if (store === undefined) throw internalError('session persistence is not configured')
    return store
  }
  const indexFor = (store: DiscoveryPersistence | undefined) => {
    // Native revisions are only comparable within the same service instance.
    // In-flight requests retain their own index; an old read cannot overwrite
    // the replacement service's cache after an optional service remount.
    if (indexedStore !== undefined && indexedStore !== store) index = new SessionListIndex()
    indexedStore = store
    return index
  }
  const unavailableArtifact = (error: unknown) => error instanceof SessionPersistenceNotFoundError
    || error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError
  function inspect(store: DiscoveryPersistence, id: SessionId, skipUnavailable?: false, options?: InspectionOptions): Promise<SessionInspection>
  function inspect(store: DiscoveryPersistence, id: SessionId, skipUnavailable: true): Promise<SessionInspection | undefined>
  async function inspect(store: DiscoveryPersistence, id: SessionId, skipUnavailable = false, options: InspectionOptions = {}): Promise<SessionInspection | undefined> {
    const signal = options.signal === undefined ? shutdown.signal : AbortSignal.any([shutdown.signal, options.signal])
    const assertActive = () => { assertOpen(); signal.throwIfAborted() }
    assertActive()
    if (options.end !== undefined && (!Number.isSafeInteger(options.end) || options.end < 0)) throw internalError('invalid session inspection end')
    let handle: Awaited<ReturnType<DiscoveryPersistence['open']>>
    try { handle = await store.open(id, 'read', { signal }) }
    catch (error) {
      if (skipUnavailable && unavailableArtifact(error)) return
      throw error
    }
    const failures: unknown[] = []
    let cleanupFailed = false
    let inspection: SessionInspection | undefined
    try {
      assertActive()
      const { events } = await handle.read(undefined, options.end, { signal })
      assertActive()
      if (options.end !== undefined && events.length !== options.end) throw internalError('session history does not contain the required durable prefix')
      inspection = { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
    } catch (error) { failures.push(error) }
    // Even a late open after cancellation owns a real handle that must close.
    try { await handle.close() } catch (error) {
      cleanupFailed = true
      failures.push(error)
      if (closed) cleanupFailures.push(error)
    }
    // Only the artifact read may be skipped; cleanup errors remain failures
    // even when a backend happens to use the same error class for both phases.
    if (!cleanupFailed && failures.length === 1 && skipUnavailable && unavailableArtifact(failures[0])) return
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'session inspection and read-handle cleanup failed')
    assertActive()
    return inspection!
  }
  const list = async (method: ListMethod, params: unknown) => {
    const p = method === 'x.ai/session/list' ? paramRecord(params, method) : {}
    const store = persistence(), projectionIndex = indexFor(store)
    const snapshots = await store.list({ signal: shutdown.signal })
    assertOpen()
    if (method === 'session/list') {
      // Bare ACP remains deliberately minimal; the pager uses the richer name.
      return { sessions: snapshots.map(item => item.header).filter(header => header.cwd !== undefined).map(header => ({
        sessionId: header.id, cwd: header.cwd, updatedAt: new Date(header.createdAt).toISOString(),
      })) }
    }
    if (method === 'x.ai/sessions/list') {
      return { result: { sessions: snapshots.map(({ header }) => ({
        sessionId: header.id, cwd: header.cwd ?? '', isWorktree: false, yolo: false,
        activity: 'dormant', resident: false, lastChangeUnixMs: header.createdAt,
      })) } }
    }
    const query = typeof p.query === 'string' ? p.query.toLowerCase() : undefined
    const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
    const requested = typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : 50
    const limit = Math.min(requested, 50)
    // Filter before opening logs; retain exact-id cross-cwd resume.
    const candidates = cwd === undefined ? snapshots : snapshots.filter(({ header }) => header.cwd === cwd
      || (query !== undefined && header.id.toLowerCase() === query))
    const projections = await Promise.all(candidates.map(({ header, revision }) => accepted(() =>
      projectionIndex.inspect(header.id, header.createdAt,
        async () => (await inspect(store, SessionId(header.id), true))?.events, revision))))
    let rows = candidates.map(({ header }, position) => {
      const projection = projections[position]!
      return {
        sessionId: header.id, cwd: header.cwd ?? '',
        createdAt: new Date(header.createdAt).toISOString(), updatedAt: new Date(projection.updatedAt).toISOString(),
        firstPrompt: projection.firstPrompt, title: projection.title, summary: projection.title,
        _meta: { 'x.ai/session': { kind: 'chat' } },
      }
    })
    if (query !== undefined && query.length > 0) {
      rows = rows.filter(row => (row.sessionId + ' ' + row.cwd + ' ' + row.title + ' ' + row.firstPrompt).toLowerCase().includes(query))
    }
    rows.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
    return { sessions: rows.slice(0, limit) }
  }
  const search = async (params: unknown) => {
    const p = paramRecord(params, 'x.ai/session/search')
    const query = typeof p.query === 'string' ? p.query.trim() : ''
    if (query.length === 0) throw invalidParams('x.ai/session/search requires a non-empty query')
    const requested = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.floor(p.limit) : 20
    const limit = Math.min(Math.max(requested, 1), 100)
    const service = host.query()
    assertOpen()
    if (service === undefined) throw internalError('session full-text search is not configured')
    const store = host.persistence()
    assertOpen()
    const projectionIndex = indexFor(store)
    const cursor = typeof p.cursor === 'string' && p.cursor.length > 0 ? p.cursor : undefined
    const page = await service.searchSessions({ query, limit, ...cursor === undefined ? {} : { cursor } }, { signal: shutdown.signal })
    assertOpen()
    return {
      results: page.items.map(hit => {
        // Use the picker/live projection; direct search never rereads every hit.
        const projection = projectionIndex.projection(hit.header.id, hit.header.createdAt)
        return {
          sessionId: hit.header.id, cwd: hit.header.cwd ?? '', summary: projection.title || hit.bestMatch.snippet,
          updatedAt: new Date(Math.max(hit.bestMatch.time, projection.updatedAt)).toISOString(),
          score: 0, matchedFields: ['content'],
          ...p.includeContent === true ? { snippet: hit.bestMatch.snippet } : {},
        }
      }),
      nextCursor: page.nextCursor ?? null, nextOffset: null, totalEstimate: null, bootstrapping: false,
    }
  }
  const unsubscribe = host.onEvent((session, event) => {
    if (!closed && host.owns(session)) index.recordEvent(session.header.id, session.header.createdAt, event)
  })
  return {
    inspect: (id: SessionId, options?: InspectionOptions) => accepted(() => inspect(persistence(), id, false, options)),
    list: (method: ListMethod, params?: unknown) => accepted(() => list(method, params)),
    search: (params: unknown) => accepted(() => search(params)),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => {
        // A failed parent list may leave sibling/queued inspections in flight.
        while (pending.size > 0) await Promise.allSettled([...pending])
        index = new SessionListIndex(); indexedStore = undefined
        if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'session discovery cleanup failed')
      })
      try { unsubscribe() } catch (error) { cleanupFailures.push(error) }
      shutdown.abort()
      return disposal
    },
  }
}
