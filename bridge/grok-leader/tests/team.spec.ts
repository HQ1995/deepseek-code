import { describe, expect, it, vi } from 'vitest'
import { carriesTeamTools, TEAM_TOOLS_MODULE } from '../src/team-presets.ts'
import { createNativeTeam, describeTeam, type TeamServiceLike } from '../src/native-team.ts'

describe('Agent Team presets', () => {
  it('finds the Team tools in rows and enabled groups, skipping only literal disabled ones', () => {
    expect(carriesTeamTools([{ name: '@deepseek-ai/dsh-tool-bash' }, { name: TEAM_TOOLS_MODULE }])).toBe(true)
    expect(carriesTeamTools([{ name: 'cordis:group', group: true, config: [{ name: TEAM_TOOLS_MODULE }] }])).toBe(true)
    expect(carriesTeamTools([{ name: TEAM_TOOLS_MODULE, disabled: true }])).toBe(false)
    expect(carriesTeamTools([{ name: 'cordis:group', group: true, disabled: true, config: [{ name: TEAM_TOOLS_MODULE }] }])).toBe(false)
    // A conditional row may mount, so it counts.
    expect(carriesTeamTools([{ name: TEAM_TOOLS_MODULE, disabled: { expression: 'process.env.X' } }])).toBe(true)
    // Imported legacy presets resolve first-party modules to file URLs.
    expect(carriesTeamTools([{ name: 'file:///p/node_modules/@deepseek-ai/dsh-experimental-tool-agent-team/lib/index.js' }])).toBe(true)
    for (const plugins of [undefined, null, 'x', [], [null, 1, { name: '@deepseek-ai/dsh-experimental-agent-team' }]]) expect(carriesTeamTools(plugins)).toBe(false)
  })
})

describe('/team', () => {
  const members = [
    { id: 'lead', name: 'lead', role: 'lead' as const, status: 'running', diagnostics: [] },
    { id: 'child', name: 'reviewer', role: 'teammate' as const, status: 'inactive', context: 'fresh', model: 'deepseek-flash', description: 'Review the parser', diagnostics: ['last turn failed'] },
  ]
  const tasks = [
    { id: 't1', subject: 'Parse input', status: 'in_progress', ownerName: 'reviewer', ready: false, blockedBy: [], writeScopes: ['src/parse.ts'], writeScopeWarnings: [] },
    { id: 't2', subject: 'Write docs', status: 'pending', ready: false, blockedBy: ['t1'], writeScopes: [], writeScopeWarnings: ['overlaps t1'] },
  ]

  it('renders the roster and the task board', () => {
    const text = describeTeam(members, tasks)
    expect(text.startsWith('Agent Team\n\nMembers:\n- lead (lead) · running\n')).toBe(true)
    expect(text).toContain('\n- reviewer (teammate child) · idle · new context · model deepseek-flash · Review the parser\n  - ! last turn failed\n')
    expect(text).toContain('\n\nTasks:\n- t1 Parse input · in progress · owner reviewer · writes src/parse.ts\n')
    expect(text).toContain('- t2 Write docs · pending, blocked · after t1\n  - ! overlaps t1')
    expect(text.endsWith('\n\n`/subagents` controls a teammate by name, for example `/subagents stop reviewer`.')).toBe(true)
    expect(describeTeam(members.slice(0, 1), [])).toContain('- no teammates yet; they start only when you ask for them')
    expect(describeTeam(members.slice(0, 1), [])).toContain('Tasks:\n- none')
    expect(describeTeam(members.slice(0, 1), [])).not.toContain('/subagents')
  })

  it('reads the Lead agent only for Team sessions and refuses arguments', () => {
    const service: TeamServiceLike = { listMembers: vi.fn(() => members), listTasks: vi.fn(() => tasks) }
    const record = { agent: { id: 'lead-agent' } }, team = { value: true }
    const view = createNativeTeam({ service: () => service, hasTeam: () => team.value, agent: (r: typeof record) => r.agent })
    expect(view.execute(record, '/team')).toContain('Agent Team')
    expect(service.listMembers).toHaveBeenCalledWith(record.agent)
    expect(() => view.execute(record, '/team now')).toThrow('Usage: /team')
    team.value = false
    expect(view.execute(record, '/team')).toContain('no Agent Team')
    expect(service.listTasks).toHaveBeenCalledOnce()
    const missing = createNativeTeam({ service: () => undefined, hasTeam: () => true, agent: (r: typeof record) => r.agent })
    expect(() => missing.execute(record, '/team')).toThrow('Agent Team runtime is unavailable')
  })
})
