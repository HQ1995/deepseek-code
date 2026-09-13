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

  it('reflects preset recomposition and service replacement without retaining old views', () => {
    const f = fixture(); f.rows.push({ name: 'skill' }); f.services.add('skills')
    const first = f.views.capabilities(f.record); first.push('mutated client view')
    f.services.clear(); expect(f.views.capabilities(f.record)).toEqual([])
    f.rows.splice(0, 1, { name: 'schedule_create' }); expect(f.views.capabilities(f.record)).toEqual(['schedule'])
    f.host.tools.mockReturnValue(undefined); expect(f.views.capabilities(f.record)).toEqual([])
  })

  it('groups MCP schemas by the final delimiter and preserves wire shape, order and schema counts', () => {
    const f = fixture()
    for (const name of ['mcp__first__read', 'mcp__team__remote__one', 'mcp__first__write', 'mcp__first__write']) f.rows.push({ name })
    expect(f.views.mcp(f.record)).toEqual({ servers: [
      { name: 'first', displayName: 'first', source: 'local', sourceLabel: 'plugin: dsh',
        session: { enabled: true, status: 'connected', tools: [], authRequired: false, setupRequired: false }, _meta: { toolCount: 3 } },
      { name: 'team__remote', displayName: 'team__remote', source: 'local', sourceLabel: 'plugin: dsh',
        session: { enabled: true, status: 'connected', tools: [], authRequired: false, setupRequired: false }, _meta: { toolCount: 1 } },
    ] })
    expect(f.tools.schemas).toHaveBeenCalledExactlyOnceWith(f.record.agent)
    expect(f.host.hasService).not.toHaveBeenCalled()
  })

  it('does not infer MCP servers from malformed names, unrelated tools or an absent owner', () => {
    const f = fixture()
    for (const name of ['mcp__', 'mcp__server', 'mcp__server__', 'mcp____tool', 'prefix_mcp__server__tool', 'mcp_server_tool']) f.rows.push({ name })
    expect(f.views.mcp(undefined)).toEqual({ servers: [] }); expect(f.host.tools).not.toHaveBeenCalled()
    expect(f.views.mcp(f.record)).toEqual({ servers: [] })
    f.host.tools.mockReturnValue(undefined); expect(f.views.mcp(f.record)).toEqual({ servers: [] })
  })

  it('builds fresh MCP views without mutating the borrowed native schemas', () => {
    const f = fixture(); f.rows.push(Object.freeze({ name: 'mcp__native__one' }))
    const first = f.views.mcp(f.record); first.servers[0]!.name = 'changed'; first.servers[0]!._meta.toolCount = 99
    expect(f.views.mcp(f.record).servers[0]).toMatchObject({ name: 'native', _meta: { toolCount: 1 } })
    expect(f.rows).toEqual([{ name: 'mcp__native__one' }])
  })

  it('preserves native schema and service errors instead of caching a fabricated capability view', () => {
    const f = fixture(), error = new Error('native unavailable')
    f.tools.schemas.mockImplementationOnce(() => { throw error })
    expect(() => f.views.mcp(f.record)).toThrow(error)
    f.rows.push({ name: 'skill' }); f.host.hasService.mockImplementationOnce(() => { throw error })
    expect(() => f.views.capabilities(f.record)).toThrow(error)
    f.services.add('skills'); expect(f.views.capabilities(f.record)).toEqual(['skills'])
  })
})
