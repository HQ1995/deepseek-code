import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { parseJsonObject } from './projection.ts'

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
 * Retains tool/turn metadata, never copies the full transcript into the bridge. */
export class ChildHistoryIndex {
  nextSeq = 0
  durableSeq = -1
  private readonly calls = new Map<string, Array<{ seq: number; name: string; arguments: unknown }>>()
  private readonly turns: Array<{ seq: number; time: number }> = []
  private start?: SessionEvent
  private end?: SessionEvent
  private revision?: string
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(action: () => Promise<T>): Promise<T> {
    const result = this.tail.then(action)
    this.tail = result.catch(() => {})
    return result
  }

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
}
