/** Read-only TUI projection of the official tool-workflow durable records. */
import type { SessionEvent, SessionLogOffset } from '@deepseek-ai/dsh-session'

export interface LiveWorkflow {
  meta: { name: string; description: string; phases?: Array<{ title: string }> }
  phase?: string
}

type Member = { agent_id: string; label: string; phase?: string; state: string; started: number; duration_ms: number }
type Run = { name: string; started: number; time: number; status?: string; members: Map<number, Member> }
type WorkflowSource = {
  readonly seq: number
  snapshotEvents(from: SessionLogOffset, to: SessionLogOffset): readonly SessionEvent[]
}

/** Incremental projection for one append-only native session. Retains only
 * workflow state, never unrelated transcript bodies. Replacement/truncation
 * rebuilds, while elapsed times and live phases are recomputed on each read. */
export class WorkflowIndex {
  #source: WorkflowSource | undefined
  #offset = 0
  #runs = new Map<string, Run>()

  updates(source: WorkflowSource, live: ReadonlyMap<string, LiveWorkflow>, now: number, runId?: string) {
    const end = source.seq
    if (source !== this.#source || end < this.#offset) {
      this.#source = source
      this.#offset = 0
      this.#runs.clear()
    }
    while (this.#offset < end) {
      const next = Math.min(end, this.#offset + 512)
      for (const event of source.snapshotEvents(this.#offset as SessionLogOffset, next as SessionLogOffset)) foldEvent(this.#runs, event)
      this.#offset = next
    }
    if (runId !== undefined) {
      const run = this.#runs.get(runId)
      return run === undefined ? [] : [renderRun(runId, run, live, now)]
    }
    return [...this.#runs].map(([id, run]) => renderRun(id, run, live, now))
  }
}

/** Stateless projection retained for whole-log callers and compatibility. */
export function workflowUpdates(events: readonly SessionEvent[], live: ReadonlyMap<string, LiveWorkflow>, now: number) {
  const runs = new Map<string, Run>()
  for (const event of events) foldEvent(runs, event)
  return [...runs].map(([id, run]) => renderRun(id, run, live, now))
}

function foldEvent(runs: Map<string, Run>, event: SessionEvent): void {
  if (!String(event.type).startsWith('tool-workflow/')) return
  const data = event.data as { runId: string; name: string; seq: number; label: string; phase?: string; childId: string; outcome: string; stopReason: string }
  if (String(event.type) === 'tool-workflow/run-start') {
    runs.set(data.runId, { name: data.name, started: event.time, time: event.time, members: new Map() })
    return
  }
  const run = runs.get(data.runId)
  if (run === undefined) return
  run.time = event.time
  if (String(event.type) === 'tool-workflow/agent-start') {
    run.members.set(data.seq, { agent_id: data.childId, label: data.label, phase: data.phase, state: 'running', started: event.time, duration_ms: 0 })
  } else if (String(event.type) === 'tool-workflow/agent-end') {
    const member = run.members.get(data.seq)
    if (member !== undefined) {
      member.state = data.outcome === 'completed' ? 'done' : data.outcome
      member.duration_ms = Math.max(0, event.time - member.started)
    }
  } else if (String(event.type) === 'tool-workflow/run-end') {
    run.status = data.stopReason === 'completed' ? 'complete' : data.stopReason === 'cancelled' ? 'cancelled' : 'failed'
  }
}

function renderRun(id: string, run: Run, live: ReadonlyMap<string, LiveWorkflow>, now: number) {
  const active = live.get(id)
  const status = run.status ?? (active === undefined ? 'interrupted' : 'active')
  const agents = [...run.members].sort(([a], [b]) => a - b).map(([, { started, ...member }]) => ({
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
