import { expect, it, vi } from 'vitest'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { WorkflowIndex, workflowUpdates, type LiveWorkflow } from '../src/workflows.ts'

const event = (type: string, time: number, data: object): SessionEvent => ({ type, time, data }) as SessionEvent
const sourceOf = (events: SessionEvent[]) => ({
  get seq() { return events.length },
  snapshotEvents: vi.fn((from: number, to: number) => events.slice(from, to)),
})
const live = (): Map<string, LiveWorkflow> => new Map([['run', {
  meta: { name: 'review', description: 'Review inputs', phases: [{ title: 'Read' }, { title: 'Write' }] }, phase: 'Read',
}]])

it('folds workflow deltas and replay into the same terminal result', () => {
  const history = [
    event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }),
    event('tool-workflow/agent-start', 20, { runId: 'run', seq: 1, label: 'check', childId: 'child', phase: 'review' }),
    event('tool-workflow/agent-end', 30, { runId: 'run', seq: 1, outcome: 'completed' }),
    event('tool-workflow/run-end', 40, { runId: 'run', stopReason: 'completed' }),
  ]
  const events = history.slice(0, 2), source = sourceOf(events), index = new WorkflowIndex()
  const active = new Map([['run', { meta: { name: 'review', description: 'inspect' }, phase: 'review' }]])
  expect(index.updates(source, active, 25, 'run')[0]).toMatchObject({ status: 'active', active_agents: 1, agents: [{ duration_ms: 5 }] })
  expect(index.has('run')).toBe(true)
  expect(index.updates(source, active, 25, 'other')).toEqual([])
  events.push(...history.slice(2)); active.clear()
  expect(index.updates(source, active, 50)).toEqual(new WorkflowIndex().updates(sourceOf(history), active, 50))
  expect(index.updates(source, active, 50)[0]).toMatchObject({ status: 'complete', active_agents: 0, elapsed_ms: 30, agents: [{ state: 'done', duration_ms: 10 }] })
})

it('reads each event once in bounded pages and rereads no unchanged history', () => {
  const events = Array.from({ length: 10000 }, () => event('assistant/message', 0, {}))
  events.push(event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }))
  const source = sourceOf(events), index = new WorkflowIndex(), active = live()
  expect(index.updates(source, active, 20)).toMatchObject([{ run_id: 'run', elapsed_ms: 10 }])
  const initialReads = source.snapshotEvents.mock.calls.length
  expect(initialReads).toBe(Math.ceil(events.length / 512))
  for (let i = 0; i < 100; i++) index.updates(source, active, 20 + i)
  expect(source.snapshotEvents).toHaveBeenCalledTimes(initialReads)
  events.push(event('tool-workflow/agent-start', 30, { runId: 'run', seq: 1, childId: 'a', label: 'A' }))
  expect(index.updates(source, active, 40)[0]!.agents).toMatchObject([{ agent_id: 'a', duration_ms: 10 }])
  expect(source.snapshotEvents.mock.calls.at(-1)).toEqual([10001, 10002])
  expect(source.snapshotEvents.mock.calls.every(([from, to]) => to - from <= 512)).toBe(true)
  expect(source.snapshotEvents.mock.calls.reduce((sum, [from, to]) => sum + to - from, 0)).toBe(events.length)
})

it('matches cold reconstruction across every parallel, phase, cancellation and completion transition', () => {
  const events: SessionEvent[] = [], source = sourceOf(events), index = new WorkflowIndex(), active = live()
  const history = [
    event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }),
    event('tool-workflow/agent-start', 11, { runId: 'run', seq: 2, childId: 'b', label: 'B', phase: 'Read' }),
    event('assistant/message', 12, {}),
    event('tool-workflow/agent-start', 13, { runId: 'run', seq: 1, childId: 'a', label: 'A', phase: 'Read' }),
    event('tool-workflow/agent-end', 14, { runId: 'run', seq: 2, outcome: 'cancelled' }),
    event('tool-workflow/agent-end', 15, { runId: 'run', seq: 1, outcome: 'completed' }),
    event('tool-workflow/run-end', 16, { runId: 'run', stopReason: 'cancelled' }),
    event('tool-workflow/run-start', 17, { runId: 'next', name: 'review' }),
  ]
  for (const next of history) {
    events.push(next)
    expect(index.updates(source, active, 100)).toEqual(workflowUpdates(events, active, 100))
  }
  expect(index.updates(source, active, 100, 'run')).toMatchObject([
    { status: 'cancelled', elapsed_ms: 6, agents: [{ agent_id: 'a', state: 'done' }, { agent_id: 'b', state: 'cancelled' }] },
  ])
  expect(index.updates(source, active, 100, 'missing')).toEqual([])
})

it('recomputes live phase and time without new events and isolates returned views from cached state', () => {
  const source = sourceOf([
    event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }),
    event('tool-workflow/agent-start', 20, { runId: 'run', seq: 1, childId: 'a', label: 'A', phase: 'Read' }),
  ])
  const index = new WorkflowIndex(), active = live()
  const [first] = index.updates(source, active, 30)
  first!.agents[0]!.state = 'corrupted by consumer'
  active.get('run')!.phase = 'Write'
  expect(index.updates(source, active, 50)[0]).toMatchObject({
    current_phase: 'Write', elapsed_ms: 40, agents: [{ state: 'running', duration_ms: 30 }],
  })
  active.clear()
  expect(index.updates(source, active, 100)[0]).toMatchObject({
    status: 'interrupted', elapsed_ms: 10, agents: [{ state: 'interrupted', duration_ms: 0 }],
  })
  expect(source.snapshotEvents).toHaveBeenCalledOnce()
})

it('rebuilds after truncation or source replacement, including replacement at the same length', () => {
  const events = [event('tool-workflow/run-start', 10, { runId: 'old', name: 'old' })]
  const source = sourceOf(events), index = new WorkflowIndex()
  expect(index.updates(source, new Map(), 20)[0]!.run_id).toBe('old')
  const replacement = sourceOf([event('tool-workflow/run-start', 11, { runId: 'new', name: 'new' })])
  expect(index.updates(replacement, new Map(), 20).map(run => run.run_id)).toEqual(['new'])
  index.updates(source, new Map(), 20)
  events.length = 0
  expect(index.updates(source, new Map(), 20)).toEqual([])
  events.push(event('tool-workflow/run-start', 30, { runId: 'after', name: 'after' }))
  expect(index.updates(source, new Map(), 40).map(run => run.run_id)).toEqual(['after'])
})
