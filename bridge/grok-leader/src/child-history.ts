import type { Agent } from '@deepseek-ai/dsh-agent'
import { SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import type { SessionInspection, SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import { internalError, invalidParams } from './acp.ts'
import { commandRun, type CommandRun } from './command-results.ts'
import { parseJsonObject } from './projection.ts'
import type { SessionOperation } from './session-work.ts'

export const CHILD_HISTORY_PAGE_SIZE = 256
export type ChildEventReader = (offset: number, length: number) => Promise<readonly SessionEvent[]>

const atOrBefore = <T extends { seq: number }>(values: readonly T[], seq: number): T | undefined => {
  let low = 0, high = values.length
  while (low < high) {
    const mid = Math.floor((low + high) / 2)
    if (values[mid]!.seq <= seq) low = mid + 1
    else high = mid
  }
  return values[low - 1]
}

/** Append-only projections shared by lifecycle snapshots and history pages.
 * Retains tool/turn/command metadata, never copies the full transcript into the bridge. */
export class ChildHistoryIndex {
  nextSeq = 0
  durableSeq = -1
  private readonly calls = new Map<string, Array<{ seq: number; name: string; arguments: unknown }>>()
  /** Command runs by commandId, so a page pairs a settlement with a run an earlier page read. */
  private readonly commands = new Map<string, CommandRun>()
  private readonly turns: Array<{ seq: number; time: number }> = []
  private start?: SessionEvent
  private end?: SessionEvent
  private revision?: string

  get overviewEvents(): readonly SessionEvent[] {
    return [this.start, this.end].filter((event): event is SessionEvent => event !== undefined)
  }

  async sync(read: ChildEventReader, revision?: string, count?: number): Promise<void> {
    if (revision !== undefined && this.revision === revision) return
    if (count !== undefined && count < this.nextSeq) throw new Error('child log moved behind its observed prefix')
    while (count === undefined || this.nextSeq < count) {
      const length = Math.min(CHILD_HISTORY_PAGE_SIZE, count === undefined ? CHILD_HISTORY_PAGE_SIZE : count - this.nextSeq)
      const events = await read(this.nextSeq, length)
      if (events.length > length) throw new Error('child reader exceeded the requested page')
      for (const event of events) {
        if (event.seq !== this.nextSeq) throw new Error('child reader returned a noncontiguous prefix')
        if (event.type === 'turn/start') {
          this.start = event
          this.turns.push({ seq: event.seq, time: event.time })
        } else if (event.type === 'turn/end') this.end = event
        else if (event.type === 'tool/call' || event.type === 'tool/ptc-dispatch-start') {
          const id = String(event.type === 'tool/call' ? event.data.callId : event.data.subCallId)
          const calls = this.calls.get(id) ?? []
          calls.push({ seq: event.seq, name: event.data.name, arguments: event.type === 'tool/call' ? parseJsonObject(event.data.arguments) : event.data.arguments })
          this.calls.set(id, calls)
        } else {
          const started = commandRun(event)
          if (started !== undefined) this.commands.set(started.commandId, started.run)
        }
        this.nextSeq++
      }
      if (events.length < length) {
        if (count !== undefined) throw new Error('child reader ended before its observed prefix')
        break
      }
    }
    this.revision = revision
  }

  turnStartAt(seq: number): number | undefined {
    return atOrBefore(this.turns, seq)?.time
  }

  toolCallAt(id: string, seq: number): { name: string; arguments: unknown } | undefined {
    const call = atOrBefore(this.calls.get(id) ?? [], seq)
    return call === undefined ? undefined : { name: call.name, arguments: call.arguments }
  }

  /** The run a command's settlement pairs with; commandIds are unique per log. */
  commandRun(id: string): CommandRun | undefined {
    return this.commands.get(id)
  }
}

/** What serialized child-log reads need from the module that owns the views. */
export interface ChildLogHost<R> {
  /** Aborted when the owner shuts down. */
  signal: AbortSignal
  isLive(record: R): boolean
  agent(id: SessionId): Agent | undefined
  persistence(): Pick<SessionPersistence, 'open' | 'stat'> | undefined
  flush(session: Agent['session']): Promise<unknown>
  /** A read handle failed to close; the owner reports it once disposal started. */
  closeFailed(error: unknown): void
}

/** Serialized reads of one root's child logs through a bounded cache of
 * metadata indexes: each read syncs the child's index to a fixed cut of its
 * live or stored log, then runs `action` over an owned read handle. */
export function createChildLogs<R extends object>(host: ChildLogHost<R>) {
  const childLogs = new WeakMap<R, Map<string, { source?: object; index: ChildHistoryIndex; tail: Promise<unknown> }>>()
  return async <T>(record: R, id: string, scope: SessionOperation,
    action: (index: ChildHistoryIndex, meta: SessionInspection['meta'], read: ChildEventReader, status?: Agent['status']) => Promise<T> | T,
  ): Promise<T> => {
    const signal = AbortSignal.any([scope.signal, host.signal])
    const assertActive = () => {
      if (!host.isLive(record) || signal.aborted) throw invalidParams('session closed')
      scope.assertActive()
    }
    assertActive()
    let cache = childLogs.get(record)
    if (cache === undefined) { cache = new Map(); childLogs.set(record, cache) }
    const cached = cache.get(id) ?? { index: new ChildHistoryIndex(), tail: Promise.resolve() }
    cache.delete(id)
    cache.set(id, cached)
    // ponytail: bound metadata to 64 children per root; evicted histories rebuild on demand.
    if (cache.size > 64) cache.delete(cache.keys().next().value!)
    const work = cached.tail.then(async () => {
      assertActive()
      // Resolve after earlier reads/cleanup settle: a completed child can
      // leave the native store while this operation is waiting in the queue.
      // Serialization belongs to the child entry, not its replaceable index.
      const live = host.agent(SessionId(id)), store = host.persistence()
      if (store === undefined) throw internalError('session persistence is not configured')
      const source = live?.session ?? store
      if (cached.source !== source) { cached.source = source; cached.index = new ChildHistoryIndex() }
      const index = cached.index
      assertActive()
      // Fix the live prefix before flushing; later appends belong to the next
      // refresh. Cold storage uses its revision/count and the same read owner.
      let count: number | undefined, revision: string | undefined
      // Pair activity with the same cut, before any I/O. A child can settle
      // during flush: combining its new idle status with this older prefix
      // would invent a cancelled finish before its real turn/end is indexed.
      const status = live?.status
      if (live !== undefined) {
        count = live.session.seq
        revision = String(count)
        await host.flush(live.session)
      } else {
        const snapshot = await store.stat(SessionId(id), { signal })
        count = snapshot?.eventCount
        revision = snapshot?.revision
      }
      assertActive()
      const handle = await store.open(SessionId(id), 'read', { signal })
      const failures: unknown[] = []
      let result!: T
      try {
        assertActive()
        const read: ChildEventReader = async (offset, length) => {
          assertActive()
          if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(length) || length < 0 || length > CHILD_HISTORY_PAGE_SIZE
            || (count !== undefined && offset + length > count)) throw internalError('invalid child history page')
          if (length === 0) return []
          const { events } = await handle.read(offset, length, { signal })
          assertActive()
          if (events.length > length || (count !== undefined && events.length !== length)) throw internalError('child reader did not return the required page')
          if (events.some((event, position) => event.seq !== offset + position)) throw internalError('child reader returned a noncontiguous page')
          return events
        }
        await index.sync(read, revision, count)
        // Unknown cold lengths become fixed after the index reaches EOF.
        count = index.nextSeq
        result = await action(index, handle.header, read, status)
        assertActive()
      } catch (error) { failures.push(error) }
      // Close is deliberately uncancellable and always awaited, even after a
      // late open or projection failure. Preserve both errors when it fails.
      try { await handle.close() } catch (error) {
        failures.push(error)
        host.closeFailed(error)
      }
      if (failures.length === 1) throw failures[0]
      if (failures.length > 1) throw new AggregateError(failures, 'child history read and cleanup failed')
      assertActive()
      return result
    })
    cached.tail = work.catch(() => {})
    return work
  }
}
