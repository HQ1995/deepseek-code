// Deterministic workload plus observational timings; no provider, files or PTYs.
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import * as projection from '../bridge/grok-leader/src/workflows.ts'

const historySize = Number(process.argv[2] ?? 100000)
const members = Number(process.argv[3] ?? 200)
assert.ok(Number.isSafeInteger(historySize) && historySize >= 0)
assert.ok(Number.isSafeInteger(members) && members > 0)
const history = Array.from({ length: historySize }, (_, seq) => ({
  seq, type: 'assistant/message', time: seq, data: { text: 'unrelated transcript entry' },
}))
const transitions = [{ type: 'tool-workflow/run-start', data: { runId: 'run', name: 'parallel review' } },
  ...Array.from({ length: members }, (_, seq) => ({ type: 'tool-workflow/agent-start', data: { runId: 'run', seq, childId: `child-${seq}`, label: `Reader ${seq}`, phase: 'Read' } })),
  ...Array.from({ length: members }, (_, seq) => ({ type: 'tool-workflow/agent-end', data: { runId: 'run', seq, outcome: 'completed' } })),
  { type: 'tool-workflow/run-end', data: { runId: 'run', stopReason: 'completed' } },
]
const live = new Map([['run', { meta: { name: 'parallel review', description: 'Read independent inputs' }, phase: 'Read' }]])
function run(incremental) {
  let visits = 0, reads = 0
  const events = [...history]
  const source = { get seq() { return events.length }, snapshotEvents(from = 0, to = events.length) {
    visits += to - from; reads++; return events.slice(from, to)
  } }
  const index = incremental ? new projection.WorkflowIndex() : undefined
  let last
  const start = performance.now()
  for (const event of transitions) {
    events.push({ ...event, seq: events.length, time: events.length })
    last = index ? index.updates(source, live, events.length, 'run')
      : projection.workflowUpdates(source.snapshotEvents(), live, events.length).filter(run => run.run_id === 'run')
  }
  return { ms: +(performance.now() - start).toFixed(2), eventsRead: visits, reads, last }
}
const baseline = run(false)
const incremental = projection.WorkflowIndex ? run(true) : undefined
if (incremental) assert.deepEqual(incremental.last, baseline.last)
const summarize = ({ last, ...result }) => ({ ...result, finalMembers: last[0].agents.length })
console.log(JSON.stringify({ node: process.version, platform: `${process.platform}-${process.arch}`, historySize, members,
  baseline: summarize(baseline), ...(incremental ? { incremental: summarize(incremental) } : {}),
}, null, 2))
