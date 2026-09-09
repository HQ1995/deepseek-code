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
 *   evicted past the limit. A '' miss is deliberately NOT cached so the same
 *   session is retried on the next list (it may be prompted between reads).
 * - durable title: latest non-empty session/title for the picker row.
 * - activity: latest event.time, floored at the session's createdAt.
 *
 * Concurrent inspections share one promise per session.
 */
export class SessionListIndex {
  private readonly firstPromptCache = new Map<string, string>()
  private readonly sessionTitleCache = new Map<string, string>()
  private readonly sessionActivityCache = new Map<string, number>()
  private readonly inspections = new Map<string, Promise<SessionProjection>>()
  private readonly inspectionTails = Array.from({ length: 4 }, () => Promise.resolve())
  private nextInspection = 0
  private readonly firstPromptSeen = new Set<string>()
  private readonly firstPromptCacheLimit: number

  constructor(firstPromptCacheLimit: number = DEFAULT_FIRST_PROMPT_CACHE_LIMIT) {
    this.firstPromptCacheLimit = firstPromptCacheLimit
  }

  /** Store a first prompt, evicting the LRU oldest past the cap. An empty
   * value is never stored so the miss retries on a later inspection. */
  private cacheFirstPrompt(sessionId: string, title: string): void {
    this.firstPromptCache.delete(sessionId)
    if (title === '') return
    this.firstPromptSeen.add(sessionId)
    this.firstPromptCache.set(sessionId, title)
    while (this.firstPromptCache.size > this.firstPromptCacheLimit) {
      const oldest = this.firstPromptCache.keys().next().value as string | undefined
      if (oldest === undefined) break
      this.firstPromptCache.delete(oldest)
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

  /** Share cold reads across requests and cap open logs at four. The returned
   * snapshot belongs to the request, so LRU eviction cannot change its rows. */
  inspect(sessionId: string, createdAt: number, load: () => Promise<readonly SessionEvent[] | undefined>): Promise<SessionProjection> {
    const pending = this.inspections.get(sessionId)
    if (pending !== undefined) return pending
    if (this.firstPromptCache.has(sessionId)) {
      return Promise.resolve(this.projection(sessionId, createdAt))
    }
    const lane = this.nextInspection++ % this.inspectionTails.length
    const result = this.inspectionTails[lane]!.then(async () => {
      const events = await load()
      if (events !== undefined) this.recordInspection(sessionId, createdAt, events)
      return this.projection(sessionId, createdAt)
    }).finally(() => this.inspections.delete(sessionId))
    this.inspections.set(sessionId, result)
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
