import { afterEach, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { SessionId, SessionLogOffset, SessionStore, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionProjectionRegistry } from '@deepseek-ai/dsh-session-projection'
import { workflowProjection, workflowUpdates, type LiveWorkflow } from '../src/workflows.ts'

const contexts: Context[] = []
afterEach(async () => { for (const ctx of contexts.splice(0)) await ctx.fiber.dispose() })
const event = (type: string, time: number, data: object): SessionEvent => ({ type, time, data }) as SessionEvent
function fixture() {
  const ctx = new Context(); contexts.push(ctx)
  const store = new SessionStore(ctx), projections = new SessionProjectionRegistry(ctx)
  const stop = projections.register(workflowProjection)
  const source = store.create(SessionId('root'))
  const state = (session = source) => projections.stateOf(session, 'dscodeWorkflows')!
  const append = (value: SessionEvent) => {
    const time = vi.spyOn(Date, 'now').mockReturnValue(value.time)
    try { source.append(value.type, value.data as never) } finally { time.mockRestore() }
  }
  const render = (live: ReadonlyMap<string, LiveWorkflow>, now: number, runId?: string, session: Session = source) => workflowUpdates(state(session), live, now, runId)
  return { store, projections, stop, source, append, state, render }
}
const live = (): Map<string, LiveWorkflow> => new Map([['run', {
  meta: { name: 'review', description: 'Review inputs', phases: [{ title: 'Read' }, { title: 'Write' }] }, phase: 'Read',
}]])

it('folds native workflow deltas and fresh replay into the same terminal result', () => {
  const f = fixture(), active = live()
  f.append(event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }))
  f.append(event('tool-workflow/agent-start', 20, { runId: 'run', seq: 1, label: 'check', childId: 'child', phase: 'Read' }))
  expect(f.render(active, 25, 'run')[0]).toMatchObject({ status: 'active', active_agents: 1, agents: [{ duration_ms: 5 }] })
  expect(f.render(active, 25, 'other')).toEqual([])
  const before = f.state()
  f.append(event('tool-workflow/agent-end', 30, { runId: 'run', seq: 1, outcome: 'completed' }))
  f.append(event('tool-workflow/run-end', 40, { runId: 'run', stopReason: 'completed' }))
  active.clear()
  expect(before.runs[0]!.members[0]!.state).toBe('running')
  const resumed = f.store.create(SessionId('resumed'), { seed: f.source.snapshotEvents() })
  expect(f.render(active, 50)).toEqual(f.render(active, 50, undefined, resumed))
  expect(f.render(active, 50)[0]).toMatchObject({ status: 'complete', active_agents: 0, elapsed_ms: 30, agents: [{ state: 'done', duration_ms: 10 }] })
})

it('reuses unchanged native state and never rereads warm history', () => {
  const f = fixture(), active = live(), initial = f.state()
  const snapshots = vi.spyOn(f.source, 'snapshotEvents'), at = vi.spyOn(f.source, 'eventAt')
  for (let i = 0; i < 10000; i++) f.source.append('session/title', { title: 'unrelated body ' + i })
  expect(f.state()).toBe(initial)
  f.append(event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }))
  const changed = f.state()
  for (let i = 0; i < 100; i++) expect(f.render(active, 20 + i)[0]!.elapsed_ms).toBe(10 + i)
  expect(f.state()).toBe(changed)
  expect(snapshots).not.toHaveBeenCalled(); expect(at).not.toHaveBeenCalled()
  expect(JSON.stringify(changed)).not.toContain('unrelated body')
  expect(f.projections.snapshot(f.source).values).not.toHaveProperty('dscodeWorkflows')
})

it('matches replay across parallel, phase, cancellation and repeated-name transitions', () => {
  const f = fixture(), active = live()
  const history = [
    event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }),
    event('tool-workflow/agent-start', 11, { runId: 'run', seq: 2, childId: 'b', label: 'B', phase: 'Read' }),
    event('session/title', 12, { title: 'not a workflow' }),
    event('tool-workflow/agent-start', 13, { runId: 'run', seq: 1, childId: 'a', label: 'A', phase: 'Read' }),
    event('tool-workflow/agent-end', 14, { runId: 'run', seq: 2, outcome: 'cancelled' }),
    event('tool-workflow/agent-end', 15, { runId: 'run', seq: 1, outcome: 'completed' }),
    event('tool-workflow/run-end', 16, { runId: 'run', stopReason: 'cancelled' }),
    event('tool-workflow/run-start', 17, { runId: 'next', name: 'review' }),
  ]
  for (const [index, next] of history.entries()) {
    f.append(next)
    const resumed = f.store.create(SessionId('replay-' + index), { seed: f.source.snapshotEvents() })
    expect(f.render(active, 100)).toEqual(f.render(active, 100, undefined, resumed))
  }
  expect(f.render(active, 100, 'run')).toMatchObject([
    { status: 'cancelled', elapsed_ms: 6, agents: [{ agent_id: 'a', state: 'done' }, { agent_id: 'b', state: 'cancelled' }] },
  ])
  expect(f.render(active, 100).map(run => run.run_id)).toEqual(['run', 'next'])
  expect(f.render(active, 100, 'missing')).toEqual([])
})

it('recomputes phase and time without new events and isolates rendered views', () => {
  const f = fixture(), active = live()
  f.append(event('tool-workflow/run-start', 10, { runId: 'run', name: 'review' }))
  f.append(event('tool-workflow/agent-start', 20, { runId: 'run', seq: 1, childId: 'a', label: 'A', phase: 'Read' }))
  const [first] = f.render(active, 30)
  first!.agents[0]!.state = 'corrupted by consumer'
  active.get('run')!.phase = 'Write'
  expect(f.render(active, 50)[0]).toMatchObject({ current_phase: 'Write', elapsed_ms: 40, agents: [{ state: 'running', duration_ms: 30 }] })
  active.clear()
  expect(f.render(active, 100)[0]).toMatchObject({ status: 'interrupted', elapsed_ms: 10, agents: [{ state: 'interrupted', duration_ms: 0 }] })
})

it('preserves inherited workflow history and rebuilds shortened, replaced and remounted sessions', () => {
  const f = fixture()
  f.append(event('tool-workflow/run-start', 10, { runId: 'old', name: 'old' }))
  const seed = f.source.snapshotEvents()
  const fork = f.store.create(SessionId('fork'), { seed, inheritedEventCount: SessionLogOffset(seed.length), meta: { parentSession: f.source.id, isSeeded: true } })
  expect(f.state(fork)).toEqual(f.state())
  const shortened = f.store.create(SessionId('shortened'), { seed: [] })
  expect(f.state(shortened)).toEqual({ runs: [] })
  const replaced = f.store.create(SessionId('replaced'), { seed: [{ ...seed[0]!, data: { runId: 'new', name: 'new' } } as SessionEvent] })
  expect(f.state(replaced).runs.map(run => run.id)).toEqual(['new'])
  f.stop(); expect(f.state()).toBeUndefined()
  f.projections.register(workflowProjection)
  expect(f.state().runs.map(run => run.id)).toEqual(['old'])
})

it('round-trips JSON checkpoints, rejects invalid cached state and keeps checkpoints detached', () => {
  const f = fixture()
  f.append(event('tool-workflow/run-start', 10, { runId: '__proto__', name: 'safe ID' }))
  f.append(event('tool-workflow/agent-start', 20, { runId: '__proto__', seq: 0, childId: 'child', label: 'worker' }))
  const seed = f.source.snapshotEvents(), checkpoint = JSON.parse(JSON.stringify(f.projections.checkpoint(f.source)))
  const restore = (value: typeof checkpoint) => f.projections.restore(value, seed, SessionLogOffset(0), f.source.header, SessionLogOffset(0)).checkpoint.dscodeWorkflows!.val
  expect(restore(checkpoint)).toEqual(f.state())
  checkpoint.dscodeWorkflows.val.runs[0].name = 'detached'
  expect(f.state().runs[0]!.name).toBe('safe ID')
  checkpoint.dscodeWorkflows.ver++
  expect(restore(checkpoint)).toEqual(f.state())
  checkpoint.dscodeWorkflows.ver--; checkpoint.dscodeWorkflows.val = { runs: 'invalid' }
  expect(() => restore(checkpoint)).toThrow()
})

it('preserves existing-ID replacement order and ignores unknown members/runs', () => {
  const f = fixture()
  for (const [id, time] of [['a', 10], ['b', 20], ['a', 30]] as const) f.append(event('tool-workflow/run-start', time, { runId: id, name: id }))
  f.append(event('tool-workflow/agent-end', 35, { runId: 'missing', seq: 9, outcome: 'failed' }))
  f.append(event('tool-workflow/agent-end', 40, { runId: 'a', seq: 9, outcome: 'failed' }))
  for (const label of ['first', 'replacement']) f.append(event('tool-workflow/agent-start', 50, { runId: 'a', seq: 0, childId: 'child', label }))
  expect(f.state().runs.map(run => run.id)).toEqual(['a', 'b'])
  expect(f.render(new Map(), 100, 'a')).toMatchObject([{ agents_used: 1, agents: [{ label: 'replacement' }] }])
})
