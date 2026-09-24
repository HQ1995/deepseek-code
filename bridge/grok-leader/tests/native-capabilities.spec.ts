import { describe, expect, it, vi } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createNativeCapabilities, type NativeToolSchemas } from '../src/native-capabilities.ts'

function fixture() {
  const record = { agent: {} as Agent }, rows: Array<{ name: string }> = []
  const tools = { schemas: vi.fn<NativeToolSchemas['schemas']>(() => rows) }
  const services = new Set<string>()
  const host = { tools: vi.fn((_record: typeof record): NativeToolSchemas | undefined => tools),
    hasService: vi.fn((_record: typeof record, name: string) => services.has(name)) }
  const views = createNativeCapabilities(host)
  return { record, rows, tools, services, host, views }
}

describe('native tool capability views', () => {
  it('is lazy and scopes schema reads to the exact native agent', () => {
    const f = fixture(); expect(f.host.tools).not.toHaveBeenCalled()
    f.rows.push({ name: 'todo_write' }, { name: 'todo_write' })
    expect([...f.views.toolNames(f.record)]).toEqual(['todo_write'])
    expect(f.host.tools).toHaveBeenCalledWith(f.record)
    expect(f.tools.schemas).toHaveBeenCalledExactlyOnceWith(f.record.agent)
    expect(f.host.hasService).not.toHaveBeenCalled()
  })

  it.each([
    ['subagents', 'subagents', ['subagent', 'subagent_fork', 'list_agents', 'send_message']],
    ['skills', 'skills', ['skill']], ['plan', 'planMode', ['exit_plan_mode']],
    ['goal', 'goals', ['get_goal', 'create_goal', 'update_goal']],
    ['jobs', 'jobs', ['job_output', 'job_list', 'job_kill']], ['workflow', 'workflowEngine', ['workflow', 'ralph']],
  ] as const)('advertises %s only when a selected native tool and its service both exist', (capability, service, names) => {
    const f = fixture(); f.services.add(service)
    expect(f.views.capabilities(f.record)).toEqual([]); expect(f.host.hasService).not.toHaveBeenCalled()
    for (const name of names) {
      f.rows.splice(0, f.rows.length, { name }); f.services.clear()
      expect(f.views.capabilities(f.record)).toEqual([])
      f.services.add(service); expect(f.views.capabilities(f.record)).toEqual([capability])
      expect(f.host.hasService).toHaveBeenLastCalledWith(f.record, service)
    }
  })

  it('keeps canonical ordering and does not require extra services for tool-owned todo or schedule', () => {
    const f = fixture()
    for (const name of ['schedule_create', 'todo_write', 'ralph', 'job_kill', 'get_goal', 'exit_plan_mode', 'skill', 'subagent', 'subagent_fork']) f.rows.push({ name })
    for (const name of ['workflowEngine', 'jobs', 'goals', 'planMode', 'skills', 'subagents']) f.services.add(name)
    expect(f.views.capabilities(f.record)).toEqual(['subagents', 'skills', 'plan', 'goal', 'jobs', 'workflow', 'todo', 'schedule'])
    expect(f.host.hasService.mock.calls.map(call => call[1])).toEqual(['subagents', 'skills', 'planMode', 'goals', 'jobs', 'workflowEngine'])
  })

  it('reports an Agent Team instead of subagents when the Team tools are present', () => {
    const f = fixture()
    for (const name of ['spawn_teammate', 'send_message', 'list_agents', 'skill']) f.rows.push({ name })
    f.services.add('subagents'); f.services.add('skills')
    // Team members answer list_agents/send_message; /btw children would be taken for Leads.
    expect(f.views.capabilities(f.record)).toEqual(['team', 'skills'])
    expect(f.host.hasService.mock.calls.map(call => call[1])).toEqual(['skills'])
  })

  it('reflects preset recomposition and service replacement without retaining old views', () => {
    const f = fixture(); f.rows.push({ name: 'skill' }); f.services.add('skills')
    const first = f.views.capabilities(f.record); first.push('mutated client view')
    f.services.clear(); expect(f.views.capabilities(f.record)).toEqual([])
    f.rows.splice(0, 1, { name: 'schedule_create' }); expect(f.views.capabilities(f.record)).toEqual(['schedule'])
    f.host.tools.mockReturnValue(undefined); expect(f.views.capabilities(f.record)).toEqual([])
  })

  it('preserves native schema and service errors instead of caching a fabricated capability view', () => {
    const f = fixture(), error = new Error('native unavailable')
    f.tools.schemas.mockImplementationOnce(() => { throw error })
    expect(() => f.views.toolNames(f.record)).toThrow(error)
    f.rows.push({ name: 'skill' }); f.host.hasService.mockImplementationOnce(() => { throw error })
    expect(() => f.views.capabilities(f.record)).toThrow(error)
    f.services.add('skills'); expect(f.views.capabilities(f.record)).toEqual(['skills'])
  })
})
