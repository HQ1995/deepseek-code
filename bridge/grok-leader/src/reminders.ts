/** Human reminder input; validation and durable mutations stay in dsh-schedule. */
export function parseReminder(input: string): Record<string, unknown> {
  const match = /^(after|every|at)\s+(\S+)\s+([\s\S]+)$/.exec(input.trim())
  if (match === null) throw new Error('Use: after 10m <message>, every 5m <message>, or at <ISO date-time with timezone> <message>')
  const [, rule, when, prompt] = match
  if (rule === 'at') return { at: when, prompt }
  const duration = /^(\d+)([smhd])$/.exec(when!)
  if (duration === null) throw new Error('Use a duration such as 30s, 10m, 2h or 1d.')
  const seconds = Number(duration[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[duration[2]!] ?? 0)
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new Error('Duration must be a positive, safe number of seconds.')
  return { [rule === 'every' ? 'every_seconds' : 'after_seconds']: seconds, prompt }
}
