/** Reminders an earlier dscode (DSH 0.1.7-rc.1) recorded as `schedule/change`
 * session events. The Host Schedule service never migrates or fires them; this
 * host-only projection keeps just enough to tell the user once per open. */
import { z } from 'zod'
import { decodeScheduleChange } from '@deepseek-ai/dsh-schedule'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface LegacyReminder { id: string; kind: string; prompt: string }
export interface LegacyReminders {
  /** Fork-inherited prefix: a parent's reminders were never this session's. */
  inherited: number
  /** Active legacy reminders in creation order. */
  active: LegacyReminder[]
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    dscodeLegacyReminders: LegacyReminders
  }
}

const decode = (data: unknown): ReturnType<typeof decodeScheduleChange> | undefined => {
  try { return decodeScheduleChange(data) } catch { return undefined }
}

/** The version-1 transitions, applied leniently: an undecodable or
 * out-of-order change is skipped instead of failing the whole session. */
function apply(state: LegacyReminders, event: SessionEvent): LegacyReminders {
  if (String(event.type) !== 'schedule/change' || event.seq < state.inherited) return state
  const change = decode(event.data)
  if (change === undefined) return state
  if (change.operation === 'create') {
    const { id, kind, prompt } = change.schedule
    if (state.active.some(row => row.id === id)) return state
    return { ...state, active: [...state.active, { id, kind, prompt }] }
  }
  const { id } = change
  const row = state.active.find(candidate => candidate.id === id)
  // A dispatched one-shot ended; a dispatched `every` stayed armed.
  if (row === undefined || (change.operation === 'dispatch' && row.kind === 'every')) return state
  return { ...state, active: state.active.filter(candidate => candidate !== row) }
}

export const legacyRemindersProjection: ProjectionDefinition<'dscodeLegacyReminders'> = {
  key: 'dscodeLegacyReminders',
  stateVersion: 1,
  stateSchema: z.object({
    inherited: z.number().int().nonnegative(),
    active: z.array(z.object({ id: z.string(), kind: z.string(), prompt: z.string() })),
  }),
  init: (_header, inheritedEventCount) => ({ inherited: inheritedEventCount, active: [] }),
  apply,
}

const quote = (prompt: string): string => {
  const line = prompt.trim().split(/\r?\n/, 1)[0]!.trim()
  return '"' + (line.length > 60 ? line.slice(0, 59).trimEnd() + '…' : line) + '"'
}

/** One notice for a session holding legacy reminders, or undefined when it has none. */
export function legacyRemindersNotice(state: LegacyReminders | undefined): string | undefined {
  const active = state?.active ?? []
  if (active.length === 0) return undefined
  const shown = active.slice(0, 3).map(row => quote(row.prompt)).join(', ')
  const more = active.length > 3 ? ` and ${active.length - 3} more` : ''
  const one = active.length === 1
  return `This session has ${one ? 'a reminder' : `${active.length} reminders`} created by an earlier dscode version (${shown}${more}). `
    + `${one ? 'It no longer fires and is' : 'They no longer fire and are'} not listed in /reminders. `
    + `Recreate ${one ? 'it' : 'the ones you still need'} with /reminders (for example: after 10m <message>, daily 09:00 <message>) or ask the agent to schedule ${one ? 'it' : 'them'} again.`
}
