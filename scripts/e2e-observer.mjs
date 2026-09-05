// Test-only Cordis plugin. Never mutates agents, projections, permissions or jobs.
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
export const name = 'dscode-e2e-observer'
export const inject = ['agents', 'sessionProjections', 'permissionPresets', 'goals', 'jobs', 'subagents']
export function apply(ctx) {
  const directory = process.env.DSCODE_E2E_OBSERVER_DIR
  if (!directory) throw new Error('DSCODE_E2E_OBSERVER_DIR is required by the test observer')
  mkdirSync(directory, { recursive: true })
  let sampling = false
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      const agents = []
      for (const listed of ctx.agents.list()) {
        const agent = ctx.agents.get(listed.id)
        if (!agent) continue
        const permission = ctx.permissionPresets.current(agent.session)
        const descendants = await ctx.subagents.listDescendants(agent.id)
        agents.push({
          id: agent.id, status: agent.status,
          permission, policy: ctx.permissionPresets.resolve(permission),
          goal: ctx.goals.get(agent) ?? null,
          projections: ctx.sessionProjections.snapshot(agent.session,
            ['contextPressure', 'tokenUsage', 'contextBreakdown', 'goal', 'permissions']),
          jobs: ctx.jobs.list(agent),
          descendants: descendants.map(child => ({ ...child,
            status: ctx.agents.get(child.id)?.status ?? null })),
        })
      }
      const value = { pid: process.pid, time: Date.now(), agents }
      const file = join(directory, `${process.pid}.json`)
      writeFileSync(`${file}.tmp`, JSON.stringify(value))
      renameSync(`${file}.tmp`, file)
    } catch (error) {
      writeFileSync(join(directory, `${process.pid}.error`), String(error?.stack ?? error))
    } finally { sampling = false }
  }
  const timer = setInterval(sample, 100)
  timer.unref()
  ctx.on('dispose', () => clearInterval(timer))
  void sample()
}
