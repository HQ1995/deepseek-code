// Retained memory of one long-lived session in the leader, measured on the
// production append path. Not a throughput benchmark: every mode appends the
// same realistic turn mix and reports the heap the session still holds after
// two forced collections, so the numbers are retention, not allocation churn.
//
// Modes separate the three layers a live session owns in the leader:
//   log         the pinned DSH Session log alone
//   projections the two bridge projections the leader registers and reads
//   leader      plus the session-list index fed by each observed event and one
//               full snapshotEvents() read, as the history/rewind readers do
//
// Usage: node --expose-gc bench-session-memory.mjs <turns> [bridgeRoot] [mode]
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const turns = Number(process.argv[2] ?? 2000)
const bridgeArg = process.argv[3] ?? '../bridge/grok-leader/'
const bridgeRoot = new URL(bridgeArg.endsWith('/') ? bridgeArg : `${bridgeArg}/`, import.meta.url)
const mode = process.argv[4] ?? 'leader'
assert.ok(Number.isSafeInteger(turns) && turns > 0)
assert.ok(['log', 'projections', 'leader'].includes(mode))
assert.ok(global.gc, 'run with --expose-gc: retained memory cannot be measured without it')
// The IDE-agnostic packages resolve from the bridge package's own install,
// exactly like the shipped plugin; the benchmark itself stays in scripts/.
const require = createRequire(new URL('package.json', bridgeRoot))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { SessionId, SessionStore } = await load('@deepseek-ai/dsh-session')
const { SessionProjectionRegistry } = await load('@deepseek-ai/dsh-session-projection')
const { workflowProjection } = await import(new URL('src/workflows.ts', bridgeRoot))
const { presetHistoryProjection } = await import(new URL('src/preset-history.ts', bridgeRoot))
const { SessionListIndex } = await import(new URL('src/session-list.ts', bridgeRoot))

// One coding turn: prompt, four tool round trips, the assistant answer, the
// turn boundary. Sizes are the shapes a real transcript carries, not payload
// extremes: a 3KB command result, a 700-char answer, 150-char call arguments.
const TOOL_STEPS = 4
const eventsPerTurn = 4 + TOOL_STEPS * 2
// Retained heap, not allocation churn: the drain first lets the SDK's
// per-listener containment promises and Cordis dispatch callbacks finish, so a
// synchronous append loop cannot park them in the microtask queue and inflate
// the reading as if they were live.
const heapNow = async () => {
  await new Promise(resolve => setImmediate(resolve))
  global.gc()
  global.gc()
  return process.memoryUsage().heapUsed
}
const outputFor = (turn, step) => Array.from({ length: 48 }, (_, line) =>
  `line ${line} of turn ${turn} step ${step}: ${'result row '.repeat(4)}`).join('\n')
const appendTurn = (session, turn) => {
  session.append('turn/start', { turn })
  session.append('user/message', {
    content: [{ type: 'text', text: `turn ${turn}: keep going on the current objective, step by step` }],
    source: { kind: 'user' },
  }, { surfaceOp: 'append' })
  for (let step = 0; step < TOOL_STEPS; step++) {
    const callId = `call-${turn}-${step}`
    session.append('tool/call', {
      turn, step, callId, name: step % 2 === 0 ? 'bash' : 'read',
      arguments: JSON.stringify({ command: `sed -n '1,120p' file-${turn}-${step}.ts`, workdir: '/workspace' }),
    })
    session.append('tool/result', {
      turn, step,
      message: { content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: outputFor(turn, step) }] }] },
    }, { surfaceOp: 'append' })
  }
  session.append('assistant/message', {
    turn, step: TOOL_STEPS,
    stream: [],
    message: {
      content: [{ type: 'text', text: `Turn ${turn} summary: ${'changed one concern and re-ran its check. '.repeat(16)}` }],
      source: { provider: 'deepseek', model: 'chat' },
    },
  }, { surfaceOp: 'append' })
  session.append('turn/end', { turn, reason: { kind: 'completed' } })
  if (turn % 20 === 19) session.append('session/title', { title: `session covering turns through ${turn}` })
}
const eventsAfter = turnCount => turnCount * eventsPerTurn + Math.floor(turnCount / 20)

const ctx = new Context()
const store = new SessionStore(ctx)
const projections = mode === 'log' ? undefined : new SessionProjectionRegistry(ctx)
if (projections !== undefined) {
  projections.register(presetHistoryProjection)
  projections.register(workflowProjection)
}
const listIndex = mode === 'leader' ? new SessionListIndex() : undefined
const source = store.create(SessionId('bench'))

// Warm the SDK's lazy folds, the registered projections and the index on a
// throwaway session, so the measured deltas belong to the workload.
const warm = store.create(SessionId('warm'))
for (let turn = 0; turn < 8; turn++) appendTurn(warm, turn)
projections?.stateOf(warm, 'dscodeWorkflows')
listIndex?.recordEvent('warm', warm.header.createdAt, warm.snapshotEvents().at(-1))

const baseline = await heapNow()
const checkpoints = []
for (let turn = 0; turn < turns; turn++) {
  const before = source.seq
  appendTurn(source, turn)
  assert.equal(source.seq - before, eventsPerTurn + (turn % 20 === 19 ? 1 : 0))
  if (listIndex !== undefined) {
    for (const event of source.snapshotEvents(before, source.seq)) listIndex.recordEvent('bench', source.header.createdAt, event)
  }
  if (projections !== undefined) {
    projections.stateOf(source, 'dscodeWorkflows')
    projections.stateOf(source, 'dscodePresetHistory')
  }
  if (turn === Math.floor(turns / 2) - 1 || turn === turns - 1) {
    checkpoints.push({ turn: turn + 1, events: source.seq, heapMiB: +(((await heapNow()) - baseline) / 1024 ** 2).toFixed(3) })
  }
}
if (mode === 'leader') source.snapshotEvents()
const retained = (await heapNow()) - baseline

assert.equal(source.seq, eventsAfter(turns))
assert.ok(retained > 0, 'a long session must retain memory')
const half = checkpoints[0]
const full = checkpoints[1]
const firstSlope = half.heapMiB / half.events
const secondSlope = (full.heapMiB - half.heapMiB) / (full.events - half.events)
// Retention must stay linear in appended events; a super-linear slope means a
// layer accumulates per-event state beyond the log itself.
assert.ok(secondSlope < firstSlope * 1.25 + 0.0005, `second-half retention slope ${secondSlope} exceeds the first half ${firstSlope}`)
await ctx.fiber.dispose()

console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}-${process.arch}`, mode, turns, events: source.seq,
  eventsPerTurn, heapMiB: +(retained / 1024 ** 2).toFixed(3),
  bytesPerEvent: +(retained / source.seq).toFixed(1),
  bytesPerTurn: +(retained / turns).toFixed(1),
  checkpointSlopesMiBPerKEvent: [+(firstSlope * 1000).toFixed(3), +(secondSlope * 1000).toFixed(3)],
}, null, 2))
