/** `/team`: the roster and task board of the session's Agent Team, read from
 * the native Team runtime. Read-only; Team changes go through the Lead's tools. */
import { internalError, invalidParams } from './acp.ts'

/** Structural read of the native `agentTeams` service (dsh 0.1.7). */
export interface TeamServiceLike {
  listMembers(agent: unknown): ReadonlyArray<TeamMemberRow>
  listTasks(agent: unknown): ReadonlyArray<TeamTaskRow>
}
export interface TeamMemberRow {
  id: string
  name: string
  role: 'lead' | 'teammate'
  status: string
  description?: string
  context?: string
  model?: string
  diagnostics: readonly string[]
}
export interface TeamTaskRow {
  id: string
  subject: string
  status: string
  ownerName?: string
  ready: boolean
  blockedBy: readonly string[]
  writeScopes: readonly string[]
  writeScopeWarnings: readonly string[]
}

export interface NativeTeamHost<S> {
  service(): TeamServiceLike | undefined
  /** Whether the session's preset mounts the Team tools. */
  hasTeam(record: S): boolean
  agent(record: S): unknown
}

export const TEAM_USAGE = 'Usage: /team'

export function describeTeam(members: ReadonlyArray<TeamMemberRow>, tasks: ReadonlyArray<TeamTaskRow>): string {
  const lines = ['Agent Team', 'Members:']
  for (const member of members) {
    const facts = [member.role, member.status, member.context, member.model, member.description].filter(fact => fact !== undefined && fact !== '')
    lines.push('  ' + member.name + ' · ' + facts.join(' · '))
    for (const diagnostic of member.diagnostics) lines.push('    ! ' + diagnostic)
  }
  if (!members.some(member => member.role === 'teammate')) lines.push('  (no teammates yet; they start only when you ask for them)')
  lines.push('Tasks:')
  if (tasks.length === 0) lines.push('  none')
  for (const task of tasks) {
    const facts = [task.status + (task.ready || task.status !== 'pending' ? '' : ', blocked'),
      ...task.ownerName === undefined ? [] : ['owner ' + task.ownerName],
      ...task.blockedBy.length === 0 ? [] : ['after ' + task.blockedBy.join(', ')],
      ...task.writeScopes.length === 0 ? [] : ['writes ' + task.writeScopes.join(', ')]]
    lines.push('  ' + task.id + ' ' + task.subject + ' · ' + facts.join(' · '))
    for (const warning of task.writeScopeWarnings) lines.push('    ! ' + warning)
  }
  return lines.join('\n')
}

export function createNativeTeam<S>(host: NativeTeamHost<S>) {
  return {
    execute(record: S, text: string): string {
      if (text.trim() !== '/team') throw invalidParams(TEAM_USAGE)
      if (!host.hasTeam(record)) return 'This session has no Agent Team. Start a session with the teams preset to use one.'
      const service = host.service()
      if (service === undefined) throw internalError('the Agent Team runtime is unavailable; restart dscode and retry')
      const agent = host.agent(record)
      return describeTeam(service.listMembers(agent), service.listTasks(agent))
    },
  }
}

export type NativeTeam = ReturnType<typeof createNativeTeam>
