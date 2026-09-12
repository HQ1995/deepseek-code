/**
 * Unit tests for the session-list index extracted from apply(): the first-
 * prompt / title / activity caches that back the x.ai/session/list picker and
 * the live session firehose. These cover the pure folds and the LRU/eviction/
 * dedup bookkeeping without spinning up the leader socket.
 *
 * Wire behavior is covered end-to-end in leader.spec.ts; this file pins the
 * index's own semantics.
 */
import { describe, expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionListIndex, firstUserPrompt, foldedSessionTitle } from '../src/session-list.ts'

it('retains request snapshots past eviction, shares cold loads, and bounds open logs', async () => {
  const index = new SessionListIndex(2)
  let active = 0, peak = 0, loads = 0
  const read = (id: string) => index.inspect(id, 0, async () => {
    loads += 1
    peak = Math.max(peak, ++active)
    await new Promise(resolve => setTimeout(resolve, 1))
    active -= 1
    return [userMessage(1, id)]
  })
  const first = Promise.all(Array.from({ length: 105 }, (_, i) => read(String(i))))
  const second = Promise.all(Array.from({ length: 105 }, (_, i) => read(String(i))))
  const [a, b] = await Promise.all([first, second])
  expect(a.map(row => row.firstPrompt)).toEqual(Array.from({ length: 105 }, (_, i) => String(i)))
  expect(b).toEqual(a)
  expect(loads).toBe(105)
  expect(peak).toBe(4)
  index.recordEvent('0', 0, userMessage(2, 'later prompt'))
  expect(index.projection('0', 0).firstPrompt).toBe('')
  expect((await read('0')).firstPrompt).toBe('0')
})

interface MessageLike {
  type: 'user/message'
  seq: number
  time: number
  data: {
    source: { kind: string }
    content: Array<{ type: string; text: string }>
  }
}

const userMessage = (time: number, text: string, sourceKind = 'user'): MessageLike => ({
  type: 'user/message',
  seq: time,
  time,
  data: { source: { kind: sourceKind as string }, content: [{ type: 'text', text }] },
})

const titleEvent = (time: number, title: string): SessionEvent => ({
  type: 'session/title',
  seq: time,
  time,
  data: { title },
} as SessionEvent)

describe('firstUserPrompt fold', () => {
  it('returns the first non-empty user-authored text block', () => {
    const events = [
      userMessage(1, '   '),
      userMessage(2, 'first prompt'),
      userMessage(3, 'second prompt'),
    ]
    expect(firstUserPrompt(events)).toBe('first prompt')
  })

  it('ignores plugin/tool source kinds and non-text blocks', () => {
    const plugin = userMessage(1, 'plugin notice', 'plugin')
    const tool = userMessage(2, 'tool result', 'tool')
    expect(firstUserPrompt([plugin, tool])).toBe('')
  })

  it('returns empty when there is no textual user prompt', () => {
    expect(firstUserPrompt([titleEvent(1, 'a title')])).toBe('')
  })

  it('trims the returned prompt', () => {
    expect(firstUserPrompt([userMessage(1, '  hello  ' as string)])).toBe('hello')
  })
})

describe('foldedSessionTitle fold', () => {
  it('returns the latest non-empty title scanning backwards', () => {
    const events = [
      titleEvent(1, 'first title'),
      titleEvent(2, ''),
      titleEvent(3, 'second title'),
    ]
    expect(foldedSessionTitle(events)).toBe('second title')
  })

  it('returns empty when all titles are empty', () => {
    expect(foldedSessionTitle([titleEvent(1, ' '), titleEvent(2, '  ')])).toBe('')
  })
})

describe('SessionListIndex recordEvent (live path)', () => {
  it('keeps the activity max and floors updatedAt at createdAt', () => {
    const index = new SessionListIndex()
    index.recordEvent('s', 100, userMessage(50, 'first'))
    expect(index.projection('s', 100).updatedAt).toBe(100) // floored at createdAt
    index.recordEvent('s', 100, userMessage(200, 'later'))
    expect(index.projection('s', 100).updatedAt).toBe(200)
  })

  it('caches only the FIRST live user prompt and does not replace it', () => {
    const index = new SessionListIndex()
    index.recordEvent('s', 0, userMessage(1, 'first prompt'))
    index.recordEvent('s', 0, userMessage(2, 'second prompt'))
    expect(index.projection('s', 0).firstPrompt).toBe('first prompt')
  })

  it('trims and caches a live non-empty title but ignores empty titles', () => {
    const index = new SessionListIndex()
    index.recordEvent('s', 0, titleEvent(1, '  live title  '))
    expect(index.projection('s', 0).title).toBe('live title')
    index.recordEvent('s', 0, titleEvent(2, '   '))
    expect(index.projection('s', 0).title).toBe('live title') // empty ignored, stale kept
  })

  it('does not cache an empty live first prompt, so it retries later', () => {
    const index = new SessionListIndex()
    index.recordEvent('s', 0, userMessage(1, '   ') as MessageLike) // whitespace-only -> miss
    expect(index.projection('s', 0).firstPrompt).toBe('')
    index.recordEvent('s', 0, userMessage(2, 'real prompt'))
    expect(index.projection('s', 0).firstPrompt).toBe('real prompt')
  })
})

describe('SessionListIndex inspect', () => {
  it('retries failed and empty reads, then reuses a cached projection', async () => {
    const index = new SessionListIndex()
    await expect(index.inspect('s', 0, async () => { throw new Error('read failed') })).rejects.toThrow('read failed')
    expect((await index.inspect('s', 0, async () => undefined)).firstPrompt).toBe('')
    expect((await index.inspect('s', 0, async () => [titleEvent(1, 'a title')])).firstPrompt).toBe('')
    const row = await index.inspect('s', 0, async () => [userMessage(2, 'now prompted')], 'revision-1')
    expect(row.firstPrompt).toBe('now prompted')
    expect(await index.inspect('s', 0, async () => { throw new Error('cached read') }, 'revision-1')).toEqual(row)
  })

  it('refreshes external changes by revision and never trusts an unversioned cache', async () => {
    const index = new SessionListIndex()
    const events = [userMessage(1, 'prompt'), titleEvent(2, 'old')]
    let reads = 0
    const load = async () => { reads++; return events }
    await index.inspect('s', 0, load, 'r1')
    await index.inspect('s', 0, load, 'r1')
    expect(reads).toBe(1)
    events.push(titleEvent(3, 'external change'))
    expect(await index.inspect('s', 0, load, 'r2')).toMatchObject({ title: 'external change', updatedAt: 3 })
    events.push(titleEvent(4, 'no revision available'))
    expect(await index.inspect('s', 0, load)).toMatchObject({ title: 'no revision available', updatedAt: 4 })
    expect(reads).toBe(3)
  })

  it('does not share an old in-flight inspection with a newer revision', async () => {
    const index = new SessionListIndex()
    let release!: (events: readonly SessionEvent[]) => void
    const held = new Promise<readonly SessionEvent[]>(resolve => { release = resolve })
    const old = index.inspect('s', 0, () => held, 'r1')
    const latest = index.inspect('s', 0, async () => [userMessage(1, 'prompt'), titleEvent(3, 'latest')], 'r2')
    release([userMessage(1, 'prompt'), titleEvent(2, 'old')])
    expect((await old).title).toBe('old')
    expect((await latest).title).toBe('latest')
  })
})

describe('SessionListIndex recordInspection (durable path)', () => {
  it('folds the first prompt, latest title, and max activity', () => {
    const index = new SessionListIndex()
    const events = [
      userMessage(10, 'durable prompt'),
      titleEvent(20, 'stale title'),
      titleEvent(30, 'latest title'),
      userMessage(40, 'followup'),
    ]
    index.recordInspection('s', 5, events as SessionEvent[])
    expect(index.projection('s', 5)).toEqual({
      firstPrompt: 'durable prompt',
      title: 'latest title',
      updatedAt: 40,
    })
  })

  it('clears a stale durable title when none survives in the log', () => {
    const index = new SessionListIndex()
    index.recordInspection('s', 0, [titleEvent(1, 'old title')])
    expect(index.projection('s', 0).title).toBe('old title')
    // Re-inspection with no surviving title clears the stale entry.
    index.recordInspection('s', 0, [userMessage(1, 'prompt only')])
    expect(index.projection('s', 0).title).toBe('')
  })
})

describe('SessionListIndex first-prompt LRU', () => {
  it('evicts the oldest entry past the cap and refreshes recency on read', () => {
    const index = new SessionListIndex(2)
    index.recordInspection('a', 0, [userMessage(1, 'a prompt')])
    index.recordInspection('b', 0, [userMessage(1, 'b prompt')])
    // Read 'a' -> refreshes its recency, so 'b' becomes oldest.
    expect(index.projection('a', 0).firstPrompt).toBe('a prompt')
    // Push past cap -> evicts 'b' (oldest), keeps 'a'.
    index.recordInspection('c', 0, [userMessage(1, 'c prompt')])
    expect(index.projection('a', 0).firstPrompt).toBe('a prompt')
    expect(index.projection('b', 0).firstPrompt).toBe('') // evicted
    expect(index.projection('c', 0).firstPrompt).toBe('c prompt')
  })
})
