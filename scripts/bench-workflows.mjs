// Deterministic workload plus observational timings; no provider, files or PTYs.
// Drives the production path: SessionStore appends feed the registered
// dscodeWorkflows projection, and every workflow query renders one run from the
// cached state instead of re-reading the transcript.
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { pathToFileURL } from 'node:url'

const historySize = Number(process.argv[2] ?? 100000)
const members = Number(process.argv[3] ?? 200)
const bridgeRoot = new URL(process.argv[4] ?? '../bridge/grok-leader/', import.meta.url)
assert.ok(Number.isSafeInteger(historySize) && historySize >= 0)
assert.ok(Number.isSafeInteger(members) && members > 0)
// The IDE-agnostic packages resolve from the bridge package's own install,
// exactly like the shipped plugin; the benchmark itself stays in scripts/.
const require = createRequire(new URL('package.json', bridgeRoot))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { SessionId, SessionStore } = await load('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { workflowProjection, workflowUpdates } = await import(new URL('src/workflows.ts', bridgeRoot))

const PHASES = ['Read', 'Write', 'Verify', 'Report']
const live = new Map([['run', { meta: { name: 'parallel review', description: 'Read independent inputs' }, phase: 'Read' }]])
const transitions = [{ type: 'tool-workflow/run-start', data: { runId: 'run', name: 'parallel review' } },
  ...Array.from({ length: members }, (_, seq) => ({ type: 'tool-workflow/agent-start', data: { runId: 'run', seq, childId: `child-${seq}`, label: `Reader ${seq}`, phase: PHASES[seq % PHASES.length] } })),
  ...Array.from({ length: members }, (_, seq) => ({ type: 'tool-workflow/agent-end', data: { runId: 'run', seq, outcome: 'completed' } })),
  { type: 'tool-workflow/run-end', data: { runId: 'run', stopReason: 'completed' } },
]
// A warm query must come from retained state; any transcript read is counted.
const countReads = session => {
  const counts = { snapshotEvents: 0, eventAt: 0, ownEvents: 0 }
  for (const name of Object.keys(counts)) {
    const original = session[name].bind(session)
    session[name] = (...args) => { counts[name]++; return original(...args) }
  }
  return counts
}
const median = values => {
  const sorted = [...values].sort((a, b) => a - b), middle = sorted.length >> 1
  return sorted.length % 2 === 1 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
}

const ctx = new Context()
const store = new SessionStore(ctx)
const projections = new SessionProjectionRegistry(ctx)
projections.register(workflowProjection)
const source = store.create(SessionId('root'))
const state = (session = source) => {
  const value = projections.stateOf(session, 'dscodeWorkflows')
  assert.ok(value !== undefined, 'the dscodeWorkflows projection state is unavailable')
  return value
}
const reads = countReads(source)

const historyStart = performance.now()
for (let seq = 0; seq < historySize; seq++) source.append('session/title', { title: 'unrelated transcript entry ' + seq })
const historyMs = +(performance.now() - historyStart).toFixed(2)

const queryMs = []
let last
for (const event of transitions) {
  const appendStart = performance.now()
  source.append(event.type, event.data)
  const appendMs = +(performance.now() - appendStart).toFixed(3)
  const renderStart = performance.now()
  last = workflowUpdates(state(), live, Date.now(), 'run')
  queryMs.push({ appendMs, renderMs: +(performance.now() - renderStart).toFixed(3) })
}
const warmReads = { ...reads }

// Resuming from durable history must rebuild the same terminal view.
const seed = source.snapshotEvents()
const now = Date.now()
const replayStart = performance.now()
const resumed = store.create(SessionId('resumed'), { seed })
const replayed = workflowUpdates(state(resumed), live, now, 'run')
const replayMs = +(performance.now() - replayStart).toFixed(2)

assert.equal(last.length, 1)
assert.equal(last[0].agents.length, members)
assert.equal(last[0].status, 'complete')
assert.deepEqual(replayed, workflowUpdates(state(), live, now, 'run'))
assert.deepEqual(warmReads, { snapshotEvents: 0, eventAt: 0, ownEvents: 0 })
await ctx.fiber.dispose()

const column = key => queryMs.map(entry => entry[key])
console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}-${process.arch}`, historySize, members, transitions: transitions.length,
  historyMs, historyPerEventUs: historySize === 0 ? null : +(historyMs * 1000 / historySize).toFixed(3),
  appendMedianMs: +median(column('appendMs')).toFixed(3), appendMaxMs: Math.max(...column('appendMs')),
  renderMedianMs: +median(column('renderMs')).toFixed(3), renderMaxMs: Math.max(...column('renderMs')),
  warmReads, replayMs, replayPerEventUs: +(replayMs * 1000 / (historySize + transitions.length)).toFixed(3),
  phases: PHASES, finalMembers: last[0].agents.length, finalStatus: last[0].status,
}, null, 2))
