import { expect, it } from 'vitest'
import { sessionEventToUpdates } from '../src/projection.ts'
import { workflowUpdates } from '../src/workflows.ts'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

it('orders parallel members by native sequence even when they publish in reverse order', () => {
  const events = [
    { type: 'tool-workflow/run-start', time: 10, data: { runId: 'run', name: 'parallel' } },
    { type: 'tool-workflow/agent-start', time: 20, data: { runId: 'run', seq: 2, childId: 'second', label: 'Second' } },
    { type: 'tool-workflow/agent-start', time: 21, data: { runId: 'run', seq: 1, childId: 'first', label: 'First' } },
  ] as unknown as SessionEvent[]
  expect(workflowUpdates(events, new Map(), 30)[0]!.agents.map(agent => agent.agent_id)).toEqual(['first', 'second'])
})

it('restores the same Todo state in live and replay paths, retaining completion until the next turn', () => {
  const events = [
    { type: 'turn/start', data: { turn: 0 } },
    { type: 'todo/write', data: { todos: [{ content: 'Verify restore', status: 'completed' }] } },
    { type: 'turn/end', data: { turn: 0, reason: { kind: 'completed' } } },
  ] as unknown as SessionEvent[]
  for (const replay of [false, true]) {
    const updates = events.flatMap(event => sessionEventToUpdates(event, { replay }))
    expect(updates).toEqual([
      { sessionUpdate: 'plan', entries: [] },
      { sessionUpdate: 'plan', entries: [{ content: 'Verify restore', status: 'completed', priority: 'medium' }] },
    ])
    expect(sessionEventToUpdates(events[0]!, { replay })).toEqual([{ sessionUpdate: 'plan', entries: [] }])
  }
})

it('keeps same-named native runs distinct and never treats an incomplete cold log as live', () => {
  const events = [
    { type: 'tool-workflow/run-start', time: 10, data: { runId: 'first', name: 'review' } },
    { type: 'tool-workflow/agent-start', time: 20, data: { runId: 'first', seq: 1, childId: 'child-a', label: 'A', phase: 'Read' } },
    { type: 'tool-workflow/agent-end', time: 30, data: { runId: 'first', seq: 1, outcome: 'completed' } },
    { type: 'tool-workflow/run-end', time: 40, data: { runId: 'first', stopReason: 'completed' } },
    { type: 'tool-workflow/run-start', time: 50, data: { runId: 'second', name: 'review' } },
    { type: 'tool-workflow/agent-start', time: 60, data: { runId: 'second', seq: 1, childId: 'child-b', label: 'B', phase: 'Read' } },
  ] as unknown as SessionEvent[]
  const live = new Map([['second', { meta: { name: 'review', description: 'Review changes' }, phase: 'Read' }]])
  expect(workflowUpdates(events, live, 80)).toMatchObject([
    { run_id: 'first', status: 'complete', elapsed_ms: 30, agents: [{ agent_id: 'child-a', state: 'done', duration_ms: 10 }] },
    { run_id: 'second', status: 'active', elapsed_ms: 30, active_agents: 1, phases: [{ title: 'Read', state: 'active' }] },
  ])
  const cold = workflowUpdates(events, new Map(), 9000)
  expect(cold[1]).toMatchObject({ status: 'interrupted', elapsed_ms: 10, active_agents: 0, agent_budget: null, agent_usage_incomplete: true, agents: [{ agent_id: 'child-b', state: 'interrupted' }] })
  expect(cold[1]!.agents[0]).not.toHaveProperty('tokens_used')
})
