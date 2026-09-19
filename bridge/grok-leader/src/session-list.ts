/** Session-picker metadata shared by durable reads and live events. */

import type { SessionEvent } from '@deepseek-ai/dsh-session'

export interface SessionProjection {
  /** First user-authored prompt text; '' when none is known yet. */
  firstPrompt: string
  /** Latest non-empty durable session/title; '' when none is known yet. */
  title: string
  /** Latest activity timestamp in epoch ms; falls back to the session's createdAt. */
  updatedAt: number
}

/** Default cap on the first-prompt LRU: the oldest entry is evicted over it. */
const DEFAULT_FIRST_PROMPT_CACHE_LIMIT = 100

/**
 * Concurrent lanes one cold fold runs its durable reads on.
 *
 * More lanes are not faster here. The JSONL store hands the log it parsed
 * during `open()` to the `read()` that follows it through a two-entry memo
 * (`COLD_LOG_MEMO_MAX_ENTRIES`), so a fold whose lanes outnumber those entries
 * evicts the handoff before its own read arrives and every log is read, parsed
 * and validated twice. Two lanes keep each handoff resident and still overlap
 * the directory walks and file reads that frame the parse.
 *
 * Measured over one store on this machine (docs/performance.md): the coldest
 * pass at 10000 sessions of 120 events takes 6893ms and 13.9s CPU on two lanes
 * against 7343ms and 15.7s CPU on four, after 2000 sessions had already shown
 * the read phase alone going 0.6s -> 1.5s and 8 lanes 6.0s.
 */
const INSPECTION_LANES = 2

/**
 * Fold the first non-empty user-authored text block from an event log.
 * Only `user/message` events whose `source.kind === 'user'` count (plugin and
 * tool injections are not the human's first prompt). Returns '' when absent.
 */
export const firstUserPrompt = (events: readonly SessionEvent[]): string => {
  for (const event of events) {
    if (event.type !== 'user/message') continue
    const data = event.data as { source?: unknown; content?: unknown }
    if ((data.source as { kind?: unknown } | undefined)?.kind !== 'user') continue
    if (!Array.isArray(data.content)) continue
    for (const block of data.content) {
      const b = block as { type?: unknown; text?: unknown }
      if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) return b.text.trim()
    }
  }
  return ''
}

/**
 * Fold the latest non-empty durable session/title from an event log, scanning
 * backwards so the newest title wins. Returns '' when none is present.
 */
export const foldedSessionTitle = (events: readonly SessionEvent[]): string => {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index] as { type: string; data: unknown } | undefined
    if (event?.type !== 'session/title') continue
    const title = (event.data as { title?: unknown }).title
    if (typeof title === 'string' && title.trim().length > 0) return title.trim()
  }
  return ''
}

/**
 * Per-session index of display metadata for the session picker and live log.
 *
 * Holds three caches:
 * - first prompt: an LRU whose reads refresh recency and whose oldest entry is
 *   evicted past the limit. Empty results are reusable only with an unchanged
 *   durable revision; unversioned reads still retry on the next list.
 * - durable title: latest non-empty session/title for the picker row.
 * - activity: latest event.time, floored at the session's createdAt.
 *
 * Concurrent inspections share one promise per session.
 */
export class SessionListIndex {
  private readonly firstPromptCache = new Map<string, string>()
  private readonly sessionTitleCache = new Map<string, string>()
  private readonly sessionActivityCache = new Map<string, number>()
  private readonly inspections = new Map<string, { revision?: string; result: Promise<SessionProjection> }>()
  private readonly revisions = new Map<string, string>()
  private readonly inspectionTails = Array.from({ length: INSPECTION_LANES }, () => Promise.resolve())
  private nextInspection = 0
  private readonly firstPromptSeen = new Set<string>()
  /** Monotone cap; raising it never invalidates a resident entry. */
  private firstPromptCacheLimit: number

  constructor(firstPromptCacheLimit: number = DEFAULT_FIRST_PROMPT_CACHE_LIMIT) {
    this.firstPromptCacheLimit = firstPromptCacheLimit
  }

  /** Store the inspected prompt (including absence), evicting the LRU oldest. */
  private cacheFirstPrompt(sessionId: string, title: string): void {
    this.firstPromptCache.delete(sessionId)
    if (title !== '') this.firstPromptSeen.add(sessionId)
    this.firstPromptCache.set(sessionId, title)
    while (this.firstPromptCache.size > this.firstPromptCacheLimit) {
      const oldest = this.firstPromptCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.firstPromptCache.delete(oldest)
      this.revisions.delete(oldest)
    }
  }

  /** Read a cached first prompt, refreshing its LRU recency. */
  private cachedFirstPrompt(sessionId: string): string | undefined {
    const title = this.firstPromptCache.get(sessionId)
    if (title === undefined) return undefined
    this.firstPromptCache.delete(sessionId)
    this.firstPromptCache.set(sessionId, title)
    return title
  }

  /**
   * Raise the first-prompt cap so one picker pass over `candidates` sessions
   * cannot evict entries that pass, or a later pass over the same store, must
   * reuse: the pass inserts at most one entry per candidate, and everything
   * already resident may be revisited by the next list — including after a
   * switch to another working directory. A cap smaller than the pass makes the
   * pass evict its own earliest entries, and every following list then reopens
   * and refolds those logs, so the retained set tracks the picking working set
   * instead of a fixed count.
   */
  retainFirstPrompts(candidates: number): void {
    if (!Number.isSafeInteger(candidates) || candidates <= 0) return
    const needed = this.firstPromptCache.size + candidates
    if (needed > this.firstPromptCacheLimit) this.firstPromptCacheLimit = needed
  }

  /** Share cold reads across requests and cap open logs at INSPECTION_LANES. The returned
   * snapshot belongs to the request, so LRU eviction cannot change its rows. */
  inspect(sessionId: string, createdAt: number, load: () => Promise<readonly SessionEvent[] | undefined>, revision?: string): Promise<SessionProjection> {
    const pending = this.inspections.get(sessionId)
    if (pending !== undefined) return pending.revision === revision ? pending.result
      : pending.result.then(() => this.inspect(sessionId, createdAt, load, revision))
    if (revision !== undefined && this.revisions.get(sessionId) === revision && this.firstPromptCache.has(sessionId)) {
      return Promise.resolve(this.projection(sessionId, createdAt))
    }
    const lane = this.nextInspection++ % this.inspectionTails.length
    const result = this.inspectionTails[lane]!.then(async () => {
      const events = await load()
      if (events !== undefined) {
        this.recordInspection(sessionId, createdAt, events)
        if (revision !== undefined && this.firstPromptCache.has(sessionId)) this.revisions.set(sessionId, revision)
      }
      return this.projection(sessionId, createdAt)
    }).finally(() => this.inspections.delete(sessionId))
    this.inspections.set(sessionId, { revision, result })
    this.inspectionTails[lane] = result.then(() => {}, () => {})
    return result
  }

  /**
   * Fold a durable session's full event log into the index: cache its first
   * prompt (a '' miss retries), fold its latest non-empty title (clearing a
   * stale title when none survives), record its activity as the max event time
   * floored at `createdAt`.
   */
  recordInspection(sessionId: string, createdAt: number, events: readonly SessionEvent[]): void {
    this.revisions.delete(sessionId)
    this.cacheFirstPrompt(sessionId, firstUserPrompt(events))
    const title = foldedSessionTitle(events)
    if (title === '') this.sessionTitleCache.delete(sessionId)
    else this.sessionTitleCache.set(sessionId, title)
    const latest = events.reduce((time, event) => Math.max(time, event.time), createdAt)
    this.sessionActivityCache.set(sessionId, latest)
  }

  /**
   * Fold one live `session/event` into the index: keep the activity max,
   * trim and cache a non-empty session/title, and
   * cache only the FIRST user prompt (a later user/message will not replace an
   * already-cached one).
   */
  recordEvent(sessionId: string, createdAt: number, event: SessionEvent): void {
    this.sessionActivityCache.set(sessionId, Math.max(
      this.sessionActivityCache.get(sessionId) ?? createdAt,
      event.time,
    ))
    const rawEvent = event as { type: string; data: unknown }
    if (rawEvent.type === 'session/title') {
      const title = (rawEvent.data as { title?: unknown }).title
      if (typeof title === 'string' && title.trim().length > 0) {
        this.sessionTitleCache.set(sessionId, title.trim())
      }
    } else if (event.type === 'user/message' && !this.firstPromptSeen.has(sessionId)) {
      this.cacheFirstPrompt(sessionId, firstUserPrompt([event]))
    }
  }

  /**
   * Build the current picker projection for `sessionId`. Reading the first
   * prompt refreshes its LRU recency, keeping recently-read sessions from being
   * evicted first. `createdAt` floors the activity timestamp.
   */
  projection(sessionId: string, createdAt: number): SessionProjection {
    return {
      firstPrompt: this.cachedFirstPrompt(sessionId) ?? '',
      title: this.sessionTitleCache.get(sessionId) ?? '',
      updatedAt: this.sessionActivityCache.get(sessionId) ?? createdAt,
    }
  }
}
