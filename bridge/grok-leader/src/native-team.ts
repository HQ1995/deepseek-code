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

const STATUS: Record<string, string> = { running: 'running', inactive: 'idle', provisioning: 'starting' }
const CONTEXT: Record<string, string> = { fresh: 'new context', fork: 'forked context' }
const TASK_STATUS: Record<string, string> = { in_progress: 'in progress' }

/** Markdown: the TUI joins single line breaks, so items are list entries. */
export function describeTeam(members: ReadonlyArray<TeamMemberRow>, tasks: ReadonlyArray<TeamTaskRow>): string {
  const lines = ['Agent Team', '', 'Members:']
  for (const member of members) {
    // A teammate's short id is the child conversation /subagents controls.
    const who = member.role === 'lead' ? member.name + ' (lead)' : member.name + ' (teammate ' + member.id.slice(0, 8) + ')'
    const facts = [STATUS[member.status] ?? member.status, member.context === undefined ? undefined : CONTEXT[member.context] ?? member.context,
      member.model === undefined || member.model === '' ? undefined : 'model ' + member.model, member.description]
      .filter((fact): fact is string => fact !== undefined && fact !== '')
    lines.push('- ' + who + ' · ' + facts.join(' · '))
    for (const diagnostic of member.diagnostics) lines.push('  - ! ' + diagnostic)
  }
  if (!members.some(member => member.role === 'teammate')) lines.push('- no teammates yet; they start only when you ask for them')
  lines.push('', 'Tasks:')
  if (tasks.length === 0) lines.push('- none')
  for (const task of tasks) {
    const facts = [(TASK_STATUS[task.status] ?? task.status) + (task.ready || task.status !== 'pending' ? '' : ', blocked'),
      ...task.ownerName === undefined ? [] : ['owner ' + task.ownerName],
      ...task.blockedBy.length === 0 ? [] : ['after ' + task.blockedBy.join(', ')],
      ...task.writeScopes.length === 0 ? [] : ['writes ' + task.writeScopes.join(', ')]]
    lines.push('- ' + task.id + ' ' + task.subject + ' · ' + facts.join(' · '))
    for (const warning of task.writeScopeWarnings) lines.push('  - ! ' + warning)
  }
  const teammate = members.find(member => member.role === 'teammate')
  if (teammate !== undefined) lines.push('', '`/subagents` controls a teammate by name, for example `/subagents stop ' + teammate.name + '`.')
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
