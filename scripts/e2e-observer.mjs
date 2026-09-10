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
        if (ctx.agents.get(listed.id) !== agent) continue
        agents.push({
          id: agent.id, status: agent.status,
          cwd: agent.session.header.cwd,
          skills: await (ctx.get('agentPresets')?.serviceFor(agent, 'skills') ?? ctx.get('skills'))?.list({ cwd: agent.session.header.cwd, scope: agent }),
          inbox: { nextTurn: agent.inbox.nextTurn, nextStep: agent.inbox.nextStep },
          permission, policy: ctx.permissionPresets.resolve(permission),
          goal: ctx.goals.get(agent) ?? null,
          workflows: agent.session.snapshotEvents().filter(event => String(event.type).startsWith('tool-workflow/')),
          schedules: agent.session.ownEvents().filter(event => event.type === 'schedule/change'),
          deliveries: agent.session.snapshotEvents().filter(event => event.type === 'deliverables/presented'),
          feedback: agent.session.ownEvents().filter(event => event.type === 'feedback/record'),
          images: agent.session.snapshotEvents().flatMap(event => event.type !== 'tool/result' ? [] :
            event.data.message.content.flatMap(result => result.type !== 'tool-result' ? [] :
              result.content.filter(block => block.type === 'image').map(block => ({
                callId: result.toolCallId, attachment: block.attachment,
                path: ctx.get('attachments')?.imageHostPath(block.attachment),
              })))),
          projections: ctx.sessionProjections.snapshot(agent.session,
            ['contextPressure', 'tokenUsage', 'contextBreakdown', 'goal', 'permissions', 'schedule', 'subagentCatalog']),
          jobs: ctx.jobs.list(agent),
          terminals: ctx.get('terminals')?.list(agent) ?? [],
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
  ctx.effect(() => () => clearInterval(timer))
  void sample()
}
