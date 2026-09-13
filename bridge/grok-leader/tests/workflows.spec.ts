import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { expect, it } from 'vitest'
import { WorkflowIndex } from '../src/workflows.ts'

it('folds workflow deltas and replay into the same terminal result', () => {
  const event = (type: string, time: number, data: object) => ({ type, time, data: { runId: 'run', ...data } }) as SessionEvent
  const events = [
    event('tool-workflow/run-start', 10, { name: 'review' }),
    event('tool-workflow/agent-start', 20, { seq: 1, label: 'check', childId: 'child', phase: 'review' }),
    event('tool-workflow/agent-end', 30, { seq: 1, outcome: 'completed' }),
    event('tool-workflow/run-end', 40, { stopReason: 'completed' }),
  ]
  const live = new Map([['run', { meta: { name: 'review', description: 'inspect' }, phase: 'review' }]])
  const index = new WorkflowIndex()
  index.append(events.slice(0, 2))
  expect(index.updates(live, 25, 'run')[0]).toMatchObject({ status: 'active', active_agents: 1, agents: [{ duration_ms: 5 }] })
  expect(index.has('run')).toBe(true)
  expect(index.updates(live, 25, 'other')).toEqual([])
  index.append(events.slice(2))
  live.clear()
  const replay = new WorkflowIndex()
  replay.append(events)
  expect(index.updates(live, 50)).toEqual(replay.updates(live, 50))
  expect(index.updates(live, 50)[0]).toMatchObject({ status: 'complete', active_agents: 0, elapsed_ms: 30, agents: [{ state: 'done', duration_ms: 10 }] })
})
