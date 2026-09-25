import { expect, it } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { ChildHistoryIndex, CHILD_HISTORY_PAGE_SIZE } from '../src/child-history.ts'

it('indexes a long child once, reads only appended events, and preserves tool/turn/command metadata across pages', async () => {
  const index = new ChildHistoryIndex()
  const events: SessionEvent[] = Array.from({ length: 4096 }, (_, seq) => ({ type: 'session/title', seq, time: seq, data: { title: 'event' } } as SessionEvent))
  events[0] = { type: 'turn/start', seq: 0, time: 100, data: { turn: 0 } } as SessionEvent
  events[255] = { type: 'tool/call', seq: 255, time: 101, data: { callId: 'cross-page', name: 'bash', arguments: '{"command":"pwd"}' } } as SessionEvent
  events[254] = { type: 'command/run', seq: 254, time: 101, data: { commandId: 'cmd-1', name: 'goal', args: ' pause', source: { kind: 'user' } } } as unknown as SessionEvent
  let returned = 0
  const read = async (offset: number, length: number) => {
    expect(length).toBeLessThanOrEqual(CHILD_HISTORY_PAGE_SIZE)
    const result = events.slice(offset, offset + length)
    returned += result.length
    return result
  }
  for (let after = 0; after < events.length; after += CHILD_HISTORY_PAGE_SIZE) {
    await index.sync(read, 'r1')
    await read(after, CHILD_HISTORY_PAGE_SIZE)
  }
  expect(returned).toBe(events.length * 2)
  expect(index.toolCallAt('cross-page', 256)).toEqual({ name: 'bash', arguments: { command: 'pwd' } })
  // A later page's command/done pairs with a run an earlier page indexed.
  expect(index.commandRun('cmd-1')).toEqual({ name: 'goal', args: ' pause' })
  expect(index.commandRun('unknown')).toBeUndefined()
  expect(index.turnStartAt(256)).toBe(100)
  events.push({ type: 'turn/start', seq: events.length, time: 900, data: { turn: 1 } } as SessionEvent)
  await index.sync(read, 'r2')
  expect(returned).toBe(8193)
  expect(index.nextSeq).toBe(4097)
  expect(index.turnStartAt(4095)).toBe(100)
  expect(index.turnStartAt(4096)).toBe(900)
  events.push({ type: 'tool/call', seq: events.length, time: 901, data: { callId: 'cross-page', name: 'read_file', arguments: '{"path":"new"}' } } as SessionEvent)
  await index.sync(read, 'r3')
  expect(index.toolCallAt('cross-page', 256)).toEqual({ name: 'bash', arguments: { command: 'pwd' } })
  expect(index.toolCallAt('cross-page', 4097)).toEqual({ name: 'read_file', arguments: { path: 'new' } })
})
