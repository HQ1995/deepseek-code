import { SessionId, SessionLogOffset, type Session, type SessionEvent, type SessionHeader } from '@deepseek-ai/dsh-session'
import {
  SessionFormatUnsupportedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  type SessionHandle, type SessionInspection, type SessionPersistence, type SessionPersistenceSnapshot,
} from '@deepseek-ai/dsh-session-persistence'
import { internalError, invalidParams, paramRecord } from './acp.ts'
import { SessionListIndex } from './session-list.ts'
import { nativeInstance } from './native-seams.ts'

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
/** The one value the roster reads out of a projection cut. */
export interface SessionProjectionCutLike {
  readonly values: { readonly title?: unknown }
}
/** Structural capability of the optional persisted projection cache
 * (`ctx.sessionProjectionCache`): the synchronous zero-I/O listing read of a
 * session's durable projection values, plus the narrower predecessor-format
 * title hint. */
export interface SessionProjectionCacheLike {
  cachedSnapshot(meta: SessionHeader, inheritedEventCount: SessionLogOffset, keys?: readonly string[]): SessionProjectionCutLike | undefined
  cachedPredecessorTitle(meta: SessionHeader, inheritedEventCount: SessionLogOffset): SessionProjectionCutLike | undefined
}
type DiscoveryPersistence = Pick<SessionPersistence, 'list' | 'open'>
type ListMethod = 'session/list' | 'x.ai/session/list' | 'x.ai/sessions/list'
interface InspectionOptions {
  /** Complete prefix required by a live lifecycle snapshot, never a moving tail. */
  readonly end?: SessionLogOffset
  readonly signal?: AbortSignal
}
type ReadOperation<T> = (handle: SessionHandle, signal: AbortSignal, assertActive: () => void) => Promise<T>
interface DiscoveryHost {
  persistence(): DiscoveryPersistence | undefined
  query(): SessionQueryLike | undefined
  projectionCache(): SessionProjectionCacheLike | undefined
  /** Diagnostics for a hint the cache could not supply; every other missing
   * hint is ordinary and stays silent. */
  log?(message: string): void
  owns(session: Session): boolean
  onEvent(listener: (session: Session, event: SessionEvent) => void): () => void
  /** Announced sessions: one that reached this process's store is a row a
   * listing taken before it can never carry. */
  onCreated(listener: (session: Session) => void): () => void
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
  /** Cordis answers a service lookup with a fresh traceable proxy over the
   * same instance, so a lookup is not a new service. Every identity this
   * module caches — the settled listing, the listing in flight, the picker's
   * resident index — belongs to the instance underneath those wrappers: one
   * live service keeps one identity across any number of lookups, and a
   * remount still brings a different one. */
  const serviceIdentity = (store: DiscoveryPersistence): DiscoveryPersistence => nativeInstance(store)
  const lookupPersistence = (): DiscoveryPersistence | undefined => {
    assertOpen()
    const store = host.persistence()
    assertOpen()
    return store === undefined ? undefined : serviceIdentity(store)
  }
  const persistence = (): DiscoveryPersistence => {
    const store = lookupPersistence()
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
  /** One durable listing serves every caller that arrives while it is in
   * flight, the way one inspection already serves every pass over the same
   * session: two windows' dashboard polls and the picker behind them land on
   * the same second, and the store read they share is the whole cost of the
   * answer. The snapshot array is shared read-only — callers map or filter it
   * into their own rows and never mutate it.
   *
   * A settled listing keeps answering every list for LISTING_REUSE_MS as
   * well. None of those rows is invented: the roster and the bare session
   * list read the immutable header the listing carried plus the projection
   * cache's current title, and the picker folds that same header against the
   * revision the listing carried, which its resident index answers when the
   * revision is unchanged and re-reads when it changed. So the only row such a
   * listing cannot answer is a session it never saw, and a row whose durable
   * artifact moved behind it is at most as stale as the listing itself, which
   * is what the deadline bounds. An announcement ends the window, and a
   * listing that started before one never opens it — it cannot prove which
   * side of its own store read the session's durable artifact fell on, so the
   * next poll pays a listing rather than trust a set that may miss the new
   * row. The deadline covers what no local event does: a store another process
   * writes, and a durable artifact that lands after the listing's read. A
   * remounted service is a different store with incomparable revisions, so its
   * listing is never reused here. */
  const LISTING_REUSE_MS = 10_000
  let sharedListing: { store: DiscoveryPersistence; snapshots: Promise<readonly SessionPersistenceSnapshot[]> } | undefined
  let settledListing: { store: DiscoveryPersistence; snapshots: readonly SessionPersistenceSnapshot[]; settledAt: number } | undefined
  let announcements = 0
  const listStore = (store: DiscoveryPersistence): Promise<readonly SessionPersistenceSnapshot[]> => {
    // An in-flight listing is the freshest answer there is and is already
    // paid for, so a caller that arrives inside it shares it instead.
    if (sharedListing !== undefined && sharedListing.store === store) return sharedListing.snapshots
    const settled = settledListing
    if (settled !== undefined && settled.store === store && Date.now() - settled.settledAt < LISTING_REUSE_MS) {
      return Promise.resolve(settled.snapshots)
    }
    const announcedBefore = announcements
    const requested = store.list({ signal: shutdown.signal })
    const shared = requested.then(
      value => {
        if (sharedListing?.snapshots === shared) sharedListing = undefined
        if (announcements === announcedBefore) settledListing = { store, snapshots: value, settledAt: Date.now() }
        return value
      },
      error => { if (sharedListing?.snapshots === shared) sharedListing = undefined; throw error },
    )
    sharedListing = { store, snapshots: shared }
    return shared
  }
  const unavailableArtifact = (error: unknown) => error instanceof SessionPersistenceNotFoundError
    || error instanceof SessionPersistenceCorruptionError || error instanceof SessionFormatUnsupportedError
  function read<T>(store: DiscoveryPersistence, id: SessionId, options: InspectionOptions, operation: ReadOperation<T>): Promise<T>
  function read<T>(store: DiscoveryPersistence, id: SessionId, options: InspectionOptions, operation: ReadOperation<T>, skipUnavailable: true): Promise<T | undefined>
  async function read<T>(store: DiscoveryPersistence, id: SessionId, options: InspectionOptions, operation: ReadOperation<T>, skipUnavailable = false): Promise<T | undefined> {
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
    let result: T | undefined
    try {
      assertActive()
      result = await operation(handle, signal, assertActive)
      assertActive()
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
    return result!
  }
  /** Full materialization is deliberate for replay/fork and the cold picker. */
  const inspection = (end?: SessionLogOffset): ReadOperation<SessionInspection> => async (handle, signal, assertActive) => {
    const { events } = await handle.read(undefined, end, { signal })
    assertActive()
    if (end !== undefined && events.length !== end) throw internalError('session history does not contain the required durable prefix')
    return { meta: handle.header, inheritedEventCount: handle.inheritedEventCount, events }
  }
  /** One handle and a fixed prefix; only selected values survive each page.
   * Projection is synchronous and must not publish partial results. */
  const select = <T>(id: SessionId, { end, signal }: InspectionOptions & { end: SessionLogOffset }, project: (event: SessionEvent) => T | undefined): Promise<T[]> =>
    accepted(() => read(persistence(), id, { end, signal }, async (handle, signal, assertActive) => {
      const selected: T[] = []
      for (let offset = 0; offset < end;) {
        assertActive()
        const length = Math.min(256, end - offset)
        const { events } = await handle.read(offset, length, { signal })
        assertActive()
        if (events.length !== length) throw internalError('session history does not contain the required durable page')
        for (const event of events) {
          assertActive()
          if (event.seq !== offset++) throw internalError('session history returned a noncontiguous page')
          const value = project(event)
          if (value !== undefined) selected.push(value)
        }
      }
      return selected
    }))
  /** Title hint for one roster row, read from the persisted projection cache
   * without opening the session log. An unseeded listing knows its inherited
   * cut is exactly zero and can prove the cache identity; a seeded header-only
   * listing cannot name its cut and stays titleless until an authoritative
   * read supplies it. An absent, not yet initialized or unprovable cache row
   * is a missing hint, never a failed listing, and only a cache that throws is
   * reported. */
  const cachedTitle = (cache: SessionProjectionCacheLike | undefined, header: SessionHeader): string | undefined => {
    if (cache === undefined || header.isSeeded) return undefined
    try {
      // The current lifecycle first; a record an older format generation left
      // behind still contributes its format-invariant title.
      const cut = cache.cachedSnapshot(header, SessionLogOffset(0), ['title'])
        ?? cache.cachedPredecessorTitle(header, SessionLogOffset(0))
      const title = cut?.values.title
      return typeof title === 'string' && title.trim().length > 0 ? title.trim() : undefined
    } catch (error) {
      // The row is still a row: it is served without the hint, the way an
      // unseeded header is, and the failure is reported rather than swallowed.
      host.log?.('grok-leader: roster title for "' + String(header.id) + '" failed; serving the row without it: ' + String(error))
      return undefined
    }
  }
  const list = async (method: ListMethod, params: unknown) => {
    const p = method === 'x.ai/session/list' ? paramRecord(params, method) : {}
    const store = persistence(), projectionIndex = indexFor(store)
    // Every list shares the in-flight listing and reuses the settled one; the
    // three callers differ only in the rows they fold from the snapshots.
    const snapshots = await listStore(store)
    assertOpen()
    if (method === 'session/list') {
      // Bare ACP remains deliberately minimal; the pager uses the richer name.
      return { sessions: snapshots.map(item => item.header).filter(header => header.cwd !== undefined).map(header => ({
        sessionId: header.id, cwd: header.cwd, updatedAt: new Date(header.createdAt).toISOString(),
      })) }
    }
    // Subagent and teammate children belong to their parent's /subagents and
    // /tasks views; the pager's session lists show conversations the user started.
    const started = snapshots.filter(({ header }) => header.origin !== 'subagent')
    if (method === 'x.ai/sessions/list') {
      const cache = host.projectionCache()
      return { result: { sessions: started.map(({ header }) => {
        const title = cachedTitle(cache, header)
        return {
          sessionId: header.id, cwd: header.cwd ?? '', isWorktree: false, yolo: false,
          activity: 'dormant', resident: false, lastChangeUnixMs: header.createdAt,
          ...title === undefined ? {} : { title },
        }
      }) } }
    }
    const query = typeof p.query === 'string' ? p.query.toLowerCase() : undefined
    const cwd = typeof p.cwd === 'string' ? p.cwd : undefined
    const requested = typeof p.limit === 'number' && p.limit > 0 ? Math.floor(p.limit) : 50
    const limit = Math.min(requested, 50)
    // Filter before opening logs; retain exact-id resume, across cwds and of a child.
    const exact = (id: string) => query !== undefined && id.toLowerCase() === query
    const candidates = snapshots.filter(({ header }) => exact(header.id)
      || (header.origin !== 'subagent' && (cwd === undefined || header.cwd === cwd)))
    // One pass over the candidates must stay resident: a cap below the pass
    // size evicts its own earliest entries and every later list re-reads them.
    projectionIndex.retainFirstPrompts(candidates.length)
    const projections = await Promise.all(candidates.map(({ header, revision }) => accepted(() =>
      projectionIndex.inspect(header.id, header.createdAt,
        async () => (await read(store, SessionId(header.id), {}, inspection(), true))?.events, revision))))
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
    const store = lookupPersistence()
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
  const unsubscribeCreated = host.onCreated(() => { settledListing = undefined; announcements += 1 })
  return {
    inspect: (id: SessionId, { end, signal }: InspectionOptions = {}) => accepted(() => read(persistence(), id, { end, signal }, inspection(end))),
    select,
    list: (method: ListMethod, params?: unknown) => accepted(() => list(method, params)),
    search: (params: unknown) => accepted(() => search(params)),
    dispose(): Promise<void> {
      if (disposal !== undefined) return disposal
      closed = true
      disposal = Promise.resolve().then(async () => {
        // A failed parent list may leave sibling/queued inspections in flight.
        while (pending.size > 0) await Promise.allSettled([...pending])
        index = new SessionListIndex(); indexedStore = undefined; sharedListing = undefined; settledListing = undefined
        if (cleanupFailures.length > 0) throw new AggregateError(cleanupFailures, 'session discovery cleanup failed')
      })
      try { unsubscribe() } catch (error) { cleanupFailures.push(error) }
      try { unsubscribeCreated() } catch (error) { cleanupFailures.push(error) }
      shutdown.abort()
      return disposal
    },
  }
}
