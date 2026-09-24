/** Human reminder input and display; validation and durable writes stay in the native Schedule service. */
import { MAX_TITLE_LENGTH, MIN_EVERY_INTERVAL_SECONDS } from '@deepseek-ai/dsh-schedule'
import type { ScheduleCatalogEntry, ScheduleCreateRequest, ScheduleRecord } from '@deepseek-ai/dsh-schedule'

export const REMINDER_USAGE = 'Use: after 10m <message>, every 1h <message>, at <ISO date-time with offset> <message>, '
  + 'daily 09:00 <message>, weekly mon,wed 09:00 <message>, or cron "0 9 * * 1-5" <message>.'
const UNITS = { s: 1, m: 60, h: 3600, d: 86400 } as const
const DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const
const FULL_DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const

/** The zone recurring wall-clock reminders are created in: this computer's IANA zone. */
export function localTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
}

/** The required task title: the prompt's first line, cut to the native limit with an ellipsis. */
export function reminderTitle(prompt: string): string {
  const line = prompt.trim().split(/\r?\n/, 1)[0]!.trim()
  if (line.length === 0) return 'Reminder'
  if (line.length <= MAX_TITLE_LENGTH) return line
  // Count UTF-16 units like the native check, without splitting a surrogate pair.
  let cut = ''
  for (const char of line) {
    if (cut.length + char.length > MAX_TITLE_LENGTH - 1) break
    cut += char
  }
  return cut.trimEnd() + '…'
}

const duration = (value: string, every: boolean): number => {
  const match = /^(\d+)([smhd])$/.exec(value)
  if (match === null) throw new Error('Use a duration such as 10m, 2h or 1d.')
  const seconds = Number(match[1]) * UNITS[match[2] as keyof typeof UNITS]
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Duration must be a positive, safe number of seconds.')
  if (every && seconds < MIN_EVERY_INTERVAL_SECONDS) throw new Error('A repeating reminder needs an interval of at least 1m.')
  return seconds
}

const clock = (value: string): string => {
  const match = /^(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(value)
  if (match === null || Number(match[1]) > 23 || Number(match[2]) > 59 || Number(match[3] ?? 0) > 59) {
    throw new Error('Use a 24-hour time such as 09:00 or 17:30.')
  }
  return `${match[1]!.padStart(2, '0')}:${match[2]}:${match[3] ?? '00'}`
}

const weekday = (token: string): number => {
  const name = token.toLowerCase()
  const index = /^[1-7]$/.test(name) ? Number(name) - 1 : Math.max(DAYS.indexOf(name as never), FULL_DAYS.indexOf(name as never))
  if (index < 0) throw new Error('Use weekdays such as mon,wed or mon-fri.')
  return index + 1
}
const weekdays = (value: string): number[] => {
  const days = new Set<number>()
  for (const part of value.split(',')) {
    const [first, last, ...rest] = part.split('-')
    if (first === undefined || first === '' || rest.length > 0) throw new Error('Use weekdays such as mon,wed or mon-fri.')
    const start = weekday(first), end = last === undefined ? start : weekday(last)
    if (end < start) throw new Error('Use weekdays such as mon,wed or mon-fri.')
    for (let day = start; day <= end; day++) days.add(day)
  }
  return [...days].sort((a, b) => a - b)
}

/**
 * Parse one `/reminders` entry into a native create request. `after`, `every`
 * and `at` keep their original spelling; `daily`, `weekly` and `cron` run in
 * this computer's zone.
 */
export function parseReminder(input: string, timeZone = localTimeZone()): ScheduleCreateRequest {
  const text = input.trim()
  const request = (prompt: string, selector: Partial<ScheduleCreateRequest>): ScheduleCreateRequest =>
    ({ ...selector, prompt, title: reminderTitle(prompt) })
  const simple = /^(after|every|at)\s+(\S+)\s+([\s\S]+)$/i.exec(text)
  if (simple !== null) {
    const [, rule, when, prompt] = simple
    const kind = rule!.toLowerCase()
    if (kind === 'at') return request(prompt!, { at: when })
    return request(prompt!, kind === 'every' ? { every_seconds: duration(when!, true) } : { after_seconds: duration(when!, false) })
  }
  const daily = /^daily\s+(\S+)\s+([\s\S]+)$/i.exec(text)
  if (daily !== null) return request(daily[2]!, { daily: { time: clock(daily[1]!), time_zone: timeZone } })
  const weekly = /^weekly\s+(\S+)\s+(\S+)\s+([\s\S]+)$/i.exec(text)
  if (weekly !== null) {
    return request(weekly[3]!, { weekly: { weekdays: weekdays(weekly[1]!), time: clock(weekly[2]!), time_zone: timeZone } })
  }
  const cron = /^cron\s+(["'])([^"'\n]+)\1\s+([\s\S]+)$/i.exec(text)
  if (cron !== null) return request(cron[3]!, { cron: { expression: cron[2]!.trim(), time_zone: timeZone } })
  if (/^cron\s/i.test(text)) throw new Error('Quote the five cron fields, for example: cron "0 9 * * 1-5" <message>.')
  throw new Error(REMINDER_USAGE)
}

const compact = (seconds: number): string => {
  for (const [unit, size] of [['d', 86400], ['h', 3600], ['m', 60]] as const) {
    if (seconds % size === 0) return String(seconds / size) + unit
  }
  return String(seconds) + 's'
}
const shortTime = (time: string): string => time.replace(/(?::00)?(?:\.0+)?$/, '')
const dayNames = (days: readonly number[]): string =>
  days.map(day => DAYS[day - 1]!.charAt(0).toUpperCase() + DAYS[day - 1]!.slice(1)).join(',')

/** When a reminder fires, per kind; one-shot targets read from `scheduledAt`. */
export function reminderWhen(record: ScheduleRecord): string {
  switch (record.kind) {
    case 'after': return 'after ' + compact(record.afterSeconds)
    case 'at': return 'at ' + record.scheduledAt
    case 'every': return 'every ' + compact(record.everySeconds)
    case 'daily': return `daily ${shortTime(record.time)} ${record.timeZone}`
    case 'weekly': return `weekly ${dayNames(record.weekdays)} ${shortTime(record.time)} ${record.timeZone}`
    case 'cron': return `cron "${record.expression}" ${record.timeZone}`
  }
}

/** The Tasks-pane schedule label: one-shots stay `once` as before. */
export function reminderSchedule(record: ScheduleRecord): string {
  return record.kind === 'after' || record.kind === 'at' ? 'once' : reminderWhen(record)
}

/** One `/reminders` row: title first, the full prompt in the detail pane. */
export function reminderItem(entry: ScheduleCatalogEntry): { id: string; text: string; detail: string; editable: false } {
  const moment = entry.status === 'active' ? entry.kind === 'at' ? [] : ['next ' + entry.scheduledAt]
    : [entry.lastDelivery === undefined ? 'ended' : 'delivered ' + entry.lastDelivery.deliveredAt]
  return {
    id: entry.id,
    // The row shows the first line: the title, unless it already opens the prompt.
    text: entry.prompt.trim().split(/\r?\n/, 1)[0]!.trim() === entry.title ? entry.prompt : entry.title + '\n' + entry.prompt,
    detail: [entry.status, reminderWhen(entry), ...moment].join(' · '),
    editable: false,
  }
}
