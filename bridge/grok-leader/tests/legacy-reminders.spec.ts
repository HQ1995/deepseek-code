import { describe, expect, it } from 'vitest'
import type { SessionEvent, SessionHeader, SessionLogOffset } from '@deepseek-ai/dsh-session'
import { legacyRemindersNotice, legacyRemindersProjection, type LegacyReminders } from '../src/legacy-reminders.ts'

const at = '2026-01-01T00:10:00.000Z'
const after = (id: string, prompt: string) => ({ version: 1, operation: 'create', schedule: { id, kind: 'after', prompt, afterSeconds: 600, scheduledAt: at } })
const every = (id: string, prompt: string) => ({ version: 1, operation: 'create', schedule: { id, kind: 'every', prompt, everySeconds: 300, scheduledAt: at } })
const fold = (changes: unknown[], inherited = 0, extra: SessionEvent[] = []): LegacyReminders => {
  const events = [...extra, ...changes.map((data, index) => ({ seq: extra.length + index, time: 1, type: 'schedule/change', data }) as SessionEvent)]
  const initial = legacyRemindersProjection.init({} as SessionHeader, inherited as SessionLogOffset)
  return events.reduce((state, event) => legacyRemindersProjection.apply(state, event), initial)
}

describe('legacy session-event reminders', () => {
  it('folds rc.1 create, delete and dispatch leniently and keeps only armed ones', () => {
    const state = fold([
      after('schedule-1', 'fired'), every('schedule-2', 'standup'), after('schedule-3', 'deleted'), after('schedule-4', 'armed\nsecond line'),
      { version: 1, operation: 'dispatch', id: 'schedule-1' },
      { version: 1, operation: 'dispatch', id: 'schedule-2', acceptedAt: at },
      { version: 1, operation: 'delete', id: 'schedule-3' },
      { version: 1, operation: 'delete', id: 'never-created' }, { version: 2, operation: 'create' }, null,
      after('schedule-4', 'reused id'),
    ])
    expect(state.active).toEqual([
      { id: 'schedule-2', kind: 'every', prompt: 'standup' }, { id: 'schedule-4', kind: 'after', prompt: 'armed\nsecond line' },
    ])
    expect(legacyRemindersProjection.stateSchema.parse(state)).toEqual(state)
  })

  it('returns the same state for unrelated events and ignores a fork-inherited prefix', () => {
    const initial = legacyRemindersProjection.init({} as SessionHeader, 0 as SessionLogOffset)
    expect(legacyRemindersProjection.apply(initial, { seq: 0, time: 1, type: 'session/title', data: {} } as unknown as SessionEvent)).toBe(initial)
    expect(fold([after('schedule-1', 'parent'), after('schedule-2', 'child')], 1).active.map(row => row.prompt)).toEqual(['child'])
  })

  it('tells the user once what no longer fires and how to recreate it', () => {
    expect(legacyRemindersNotice(undefined)).toBeUndefined()
    expect(legacyRemindersNotice({ inherited: 0, active: [] })).toBeUndefined()
    expect(legacyRemindersNotice(fold([every('schedule-1', 'standup\nat the desk')]))).toBe(
      'This session has a reminder created by an earlier dscode version ("standup"). It no longer fires and is not listed in /reminders. '
      + 'Recreate it with /reminders (for example: after 10m <message>, daily 09:00 <message>) or ask the agent to schedule it again.')
    const many = legacyRemindersNotice(fold(['a', 'b', 'c', 'd', 'x'.repeat(80)].map((prompt, index) => after('schedule-' + index, prompt))))!
    expect(many).toMatch(/^This session has 5 reminders created by an earlier dscode version \("a", "b", "c" and 2 more\)\. They no longer fire/)
    expect(many).toMatch(/schedule them again\.$/)
  })
})
