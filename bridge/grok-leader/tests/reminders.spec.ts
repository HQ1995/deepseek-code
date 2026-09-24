import { describe, expect, it } from 'vitest'
import { MAX_TITLE_LENGTH, ScheduleId, type ScheduleCatalogEntry, type ScheduleRecord } from '@deepseek-ai/dsh-schedule'
import { SessionId } from '@deepseek-ai/dsh-session'
import { REMINDER_USAGE, localTimeZone, parseReminder, reminderItem, reminderSchedule, reminderTitle, reminderWhen } from '../src/reminders.ts'

const zone = 'Asia/Shanghai'
const base = { id: ScheduleId('schedule-1'), title: 'check', prompt: 'check', scheduledAt: '2030-01-01T01:00:00.000Z' }
const records: Array<[ScheduleRecord, string, string]> = [
  [{ ...base, kind: 'after', afterSeconds: 600 }, 'after 10m', 'once'],
  [{ ...base, kind: 'at' }, 'at 2030-01-01T01:00:00.000Z', 'once'],
  [{ ...base, kind: 'every', everySeconds: 5400 }, 'every 90m', 'every 90m'],
  [{ ...base, kind: 'daily', time: '09:00:00.000', timeZone: zone }, 'daily 09:00 Asia/Shanghai', 'daily 09:00 Asia/Shanghai'],
  [{ ...base, kind: 'weekly', time: '17:30:15.000', timeZone: zone, weekdays: [1, 3, 7] }, 'weekly Mon,Wed,Sun 17:30:15 Asia/Shanghai', 'weekly Mon,Wed,Sun 17:30:15 Asia/Shanghai'],
  [{ ...base, kind: 'cron', expression: '*/15 9-17 * * 1-5', timeZone: 'UTC' }, 'cron "*/15 9-17 * * 1-5" UTC', 'cron "*/15 9-17 * * 1-5" UTC'],
]

describe('/reminders syntax', () => {
  it('keeps after, every and at, and derives the required title from the first line', () => {
    expect(parseReminder('after 10m check\nthe build', zone)).toEqual({ after_seconds: 600, prompt: 'check\nthe build', title: 'check' })
    expect(parseReminder('  every 5m   check  ', zone)).toEqual({ every_seconds: 300, prompt: 'check', title: 'check' })
    expect(parseReminder('at 2030-01-01T00:00:00Z check', zone)).toEqual({ at: '2030-01-01T00:00:00Z', prompt: 'check', title: 'check' })
    expect(parseReminder('EVERY 1d stretch', zone)).toMatchObject({ every_seconds: 86400 })
  })

  it('adds daily, weekly and cron in the local zone', () => {
    expect(parseReminder('daily 9:05 stand up', zone)).toEqual({ daily: { time: '09:05:00', time_zone: zone }, prompt: 'stand up', title: 'stand up' })
    expect(parseReminder('daily 23:59:30 wrap up', zone)).toMatchObject({ daily: { time: '23:59:30' } })
    expect(parseReminder('weekly mon,wed 09:00 review', zone)).toEqual({ weekly: { weekdays: [1, 3], time: '09:00:00', time_zone: zone }, prompt: 'review', title: 'review' })
    expect(parseReminder('weekly fri,Monday,tue-thu,7 18:00 x', zone)).toMatchObject({ weekly: { weekdays: [1, 2, 3, 4, 5, 7] } })
    expect(parseReminder('cron "*/15 9-17 * * 1-5" poll the queue', zone)).toEqual({
      cron: { expression: '*/15 9-17 * * 1-5', time_zone: zone }, prompt: 'poll the queue', title: 'poll the queue',
    })
    expect(parseReminder("cron '0 9 * * *' morning", zone)).toMatchObject({ cron: { expression: '0 9 * * *' } })
    expect(parseReminder('daily 09:00 x')).toMatchObject({ daily: { time_zone: localTimeZone() } })
    expect(localTimeZone()).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('rejects malformed entries with a usage hint that no longer shows sub-minute examples', () => {
    const cases: Array<[string, RegExp]> = [
      ['every 30s check', /at least 1m/], ['every 0m check', /positive/], ['after 999999999999999999d check', /safe/],
      ['after 1h', /^Use: /], ['weekly check', /^Use: /], ['after soon check', /duration such as 10m/],
      ['daily 25:00 check', /24-hour/], ['daily 9am check', /24-hour/], ['weekly mon-sun-tue 09:00 x', /weekdays/],
      ['weekly fri-mon 09:00 x', /weekdays/], ['weekly funday 09:00 x', /weekdays/], ['cron 0 9 * * * check', /Quote the five cron fields/],
    ]
    for (const [text, message] of cases) expect(() => parseReminder(text, zone), text).toThrow(message)
    expect(REMINDER_USAGE).not.toMatch(/30s|\b5m\b/)
    expect(REMINDER_USAGE).toMatch(/daily 09:00 <message>, weekly mon,wed 09:00 <message>, or cron "0 9 \* \* 1-5" <message>/)
    expect(() => parseReminder('every 59s check', zone)).toThrow(/at least 1m/)
    expect(parseReminder('every 60s check', zone)).toMatchObject({ every_seconds: 60 })
  })

  it('cuts long titles to the native limit with an ellipsis, without splitting a surrogate pair', () => {
    expect(reminderTitle('  short title \n body')).toBe('short title')
    expect(reminderTitle('x'.repeat(MAX_TITLE_LENGTH))).toBe('x'.repeat(MAX_TITLE_LENGTH))
    const long = reminderTitle('word '.repeat(60))
    expect(long.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
    expect(long).toMatch(/word…$/)
    const emoji = reminderTitle('a' + '😀'.repeat(80))
    expect(emoji.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH)
    expect(emoji.endsWith('😀…')).toBe(true)
    expect(reminderTitle('   ')).toBe('Reminder')
  })
})

describe('reminder rendering', () => {
  it.each(records)('renders %# by kind for the panel and the Tasks pane', (record, when, schedule) => {
    expect(reminderWhen(record)).toBe(when)
    expect(reminderSchedule(record)).toBe(schedule)
  })

  it('lists title and prompt, status and the next or last moment', () => {
    const entry = (record: ScheduleRecord, extra: Partial<ScheduleCatalogEntry> = {}): ScheduleCatalogEntry =>
      ({ ...record, sessionId: SessionId('owner'), status: 'active', ...extra }) as ScheduleCatalogEntry
    expect(reminderItem(entry({ ...records[2]![0], title: 'Stretch', prompt: 'Stand up and stretch' }))).toEqual({
      id: 'schedule-1', text: 'Stretch\nStand up and stretch', detail: 'active · every 90m · next 2030-01-01T01:00:00.000Z', editable: false,
    })
    expect(reminderItem(entry(records[1]![0])).detail).toBe('active · at 2030-01-01T01:00:00.000Z')
    expect(reminderItem(entry({ ...records[0]![0], prompt: 'check\nthe build' })).text).toBe('check\nthe build')
    const delivered = { scheduledAt: base.scheduledAt, deliveredAt: '2030-01-01T01:00:01.000Z', messageId: 'm' as never }
    expect(reminderItem(entry(records[0]![0], { status: 'inactive', lastDelivery: delivered }))).toMatchObject({
      text: 'check', detail: 'inactive · after 10m · delivered 2030-01-01T01:00:01.000Z',
    })
    expect(reminderItem(entry(records[5]![0], { status: 'inactive' })).detail).toBe('inactive · cron "*/15 9-17 * * 1-5" UTC · ended')
  })
})
