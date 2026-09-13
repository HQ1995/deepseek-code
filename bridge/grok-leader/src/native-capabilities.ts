import type { Agent } from '@deepseek-ai/dsh-agent'

export interface NativeToolSchemas { schemas(scope?: unknown): Array<{ name: string }> }
type CapabilityService = 'subagents' | 'skills' | 'planMode' | 'goals' | 'jobs' | 'workflowEngine'
interface ToolSession { agent: Agent }
interface CapabilityHost<S extends ToolSession> {
  tools(record: S): NativeToolSchemas | undefined
  hasService(record: S, name: CapabilityService): boolean
}

/** Read-only views of the current preset's native tools. No discovery, cached
 * services, connection ownership or second capability registry: every view is
 * derived from the actual scoped schemas and lazily mounted native services. */
export function createNativeCapabilities<S extends ToolSession>(host: CapabilityHost<S>) {
  const schemas = (record: S) => host.tools(record)?.schemas(record.agent) ?? []
  const toolNames = (record: S) => new Set(schemas(record).map(schema => schema.name))
  return {
    toolNames,
    capabilities(record: S): string[] {
      const names = toolNames(record), capabilities: string[] = []
      const present = (tools: readonly string[], name: CapabilityService) =>
        tools.some(tool => names.has(tool)) && host.hasService(record, name)
      if (present(['subagent', 'subagent_fork', 'list_agents', 'send_message'], 'subagents')) capabilities.push('subagents')
      if (present(['skill'], 'skills')) capabilities.push('skills')
      if (present(['exit_plan_mode'], 'planMode')) capabilities.push('plan')
      if (present(['get_goal', 'create_goal', 'update_goal'], 'goals')) capabilities.push('goal')
      if (present(['job_output', 'job_list', 'job_kill'], 'jobs')) capabilities.push('jobs')
      if (present(['workflow', 'ralph'], 'workflowEngine')) capabilities.push('workflow')
      if (names.has('todo_write')) capabilities.push('todo')
      if (names.has('schedule_create')) capabilities.push('schedule')
      return capabilities
    },
    mcp(record: S | undefined) {
      const counts = new Map<string, number>()
      for (const { name } of record === undefined ? [] : schemas(record)) {
        if (!name.startsWith('mcp__')) continue
        const rest = name.slice('mcp__'.length), separator = rest.lastIndexOf('__')
        if (separator <= 0 || separator + 2 >= rest.length) continue
        const server = rest.slice(0, separator)
        counts.set(server, (counts.get(server) ?? 0) + 1)
      }
      return { servers: [...counts].map(([name, toolCount]) => ({
        name, displayName: name, source: 'local', sourceLabel: 'plugin: dsh',
        session: { enabled: true, status: 'connected', tools: [], authRequired: false, setupRequired: false },
        _meta: { toolCount },
      })) }
    },
  }
}
