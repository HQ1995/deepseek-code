/** Read-only TUI projection of the official tool-workflow durable records. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'

export interface LiveWorkflow {
  meta: { name: string; description: string; phases?: Array<{ title: string }> }
  phase?: string
}

const memberSchema = z.object({
  seq: z.number(), agent_id: z.string(), label: z.string(), phase: z.string().optional(),
  state: z.string(), started: z.number(), duration_ms: z.number(),
})
const runSchema = z.object({
  id: z.string(), name: z.string(), started: z.number(), time: z.number(),
  status: z.string().optional(), members: z.array(memberSchema),
})
type Run = z.infer<typeof runSchema>
export interface WorkflowHistory { runs: Run[] }
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { dscodeWorkflows: WorkflowHistory }
}

/** Native drive owns seed/tail/checkpoint lifetime. State is plain JSON and
 * contains only workflow metadata; liveness and wall-clock time stay outside. */
export const workflowProjection: ProjectionDefinition<'dscodeWorkflows'> = {
  key: 'dscodeWorkflows', stateVersion: 1,
  stateSchema: z.object({ runs: z.array(runSchema) }),
  init: () => ({ runs: [] }),
  apply: foldEvent,
}

export function workflowUpdates(state: WorkflowHistory, live: ReadonlyMap<string, LiveWorkflow>, now: number, runId?: string) {
  return state.runs.filter(run => runId === undefined || run.id === runId).map(run => renderRun(run.id, run, live, now))
}

function foldEvent(state: WorkflowHistory, event: SessionEvent): WorkflowHistory {
  if (!String(event.type).startsWith('tool-workflow/')) return state
  const data = event.data as { runId: string; name: string; seq: number; label: string; phase?: string; childId: string; outcome: string; stopReason: string }
  const position = state.runs.findIndex(run => run.id === data.runId)
  if (String(event.type) === 'tool-workflow/run-start') {
    const next = { id: data.runId, name: data.name, started: event.time, time: event.time, members: [] }
    // Like Map.set, restarting an existing ID preserves its insertion order.
    return { runs: position < 0 ? [...state.runs, next] : state.runs.map((run, index) => index === position ? next : run) }
  }
  const before = state.runs[position]
  if (before === undefined) return state
  const run = { ...before, time: event.time }
  if (String(event.type) === 'tool-workflow/agent-start') {
    const next = { seq: data.seq, agent_id: data.childId, label: data.label, ...data.phase === undefined ? {} : { phase: data.phase }, state: 'running', started: event.time, duration_ms: 0 }
    const member = run.members.findIndex(member => member.seq === data.seq)
    run.members = member < 0 ? [...run.members, next] : run.members.map((value, index) => index === member ? next : value)
  } else if (String(event.type) === 'tool-workflow/agent-end') {
    run.members = run.members.map(member => member.seq === data.seq ? {
      ...member, state: data.outcome === 'completed' ? 'done' : data.outcome, duration_ms: Math.max(0, event.time - member.started),
    } : member)
  } else if (String(event.type) === 'tool-workflow/run-end') {
    run.status = data.stopReason === 'completed' ? 'complete' : data.stopReason === 'cancelled' ? 'cancelled' : 'failed'
  }
  return { runs: state.runs.map((value, index) => index === position ? run : value) }
}

function renderRun(id: string, run: Run, live: ReadonlyMap<string, LiveWorkflow>, now: number) {
  const active = live.get(id)
  const status = run.status ?? (active === undefined ? 'interrupted' : 'active')
  const agents = [...run.members].sort((a, b) => a.seq - b.seq).map(({ seq: _seq, started, ...member }) => ({
    ...member,
    state: member.state === 'running' && status !== 'active' ? 'interrupted' : member.state,
    duration_ms: member.state === 'running' && status === 'active' ? Math.max(0, now - started) : member.duration_ms,
  }))
  const titles = [...new Set([...(active?.meta.phases?.map(phase => phase.title) ?? []),
    ...agents.flatMap(agent => agent.phase === undefined ? [] : [agent.phase]),
    ...active?.phase === undefined ? [] : [active.phase]])]
  return {
    sessionUpdate: 'workflow_updated' as const,
    run_id: id, name: run.name, objective: active?.meta.description ?? '', status,
    foreground: status === 'active',
    phases: titles.map(title => {
      const members = agents.filter(agent => agent.phase === title)
      const state = members.some(agent => agent.state === 'running') || (status === 'active' && title === active?.phase) ? 'active'
        : members.some(agent => agent.state === 'failed') ? 'failed'
          : members.some(agent => agent.state === 'interrupted' || agent.state === 'cancelled') ? 'interrupted'
            : members.length > 0 && members.every(agent => agent.state === 'done') ? 'done' : 'pending'
      return { title, state }
    }),
    current_phase: status === 'active' ? active?.phase : undefined,
    agent_budget: null, agents_used: agents.length, agents_reserved: 0,
    // Published members are observable; accepted but unpublished calls and
    // per-child token counts are not part of these durable records.
    agent_usage_incomplete: true,
    elapsed_ms: Math.max(0, (status === 'active' ? now : run.time) - run.started),
    active_agents: agents.filter(agent => agent.state === 'running').length,
    agents,
  }
}
