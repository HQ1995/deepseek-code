// Session-picker scaling against a real durable store. One `x.ai/session/list`
// is the pager's session selector: it folds every durable session it can see
// before sorting and slicing, so its cost tracks the number of stored
// sessions, not the size of the answer. This harness drives the production
// discovery module over a real JSONL persistence root and counts every
// durable log open and event read, separating the unavoidable cold pass from
// what a later call over unchanged sessions repeats.
//
// Usage:
//   node --experimental-transform-types [--expose-gc] scripts/bench-session-list.mjs \
//     <sessions> [bridgeRoot] [--events=120] [--projects=1] [--lists=3] [--touch=1] [--sweep=true]
//
// The bridge root supplies the pinned SDK dependencies, exactly like the
// shipped plugin; the benchmark itself stays in scripts/.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

const argv = process.argv.slice(2)
const positional = argv.filter(arg => !arg.startsWith('--'))
const flags = new Map(argv.filter(arg => arg.startsWith('--')).map(arg => {
  const [key, value] = arg.split('=')
  return [key.slice(2), value ?? 'true']
}))
const sessionCount = Number(positional[0] ?? 300)
const bridgeArg = positional[1] ?? '../bridge/grok-leader/'
const eventsPerSession = Number(flags.get('events') ?? 120)
const projects = Number(flags.get('projects') ?? 1)
const listCount = Number(flags.get('lists') ?? 3)
const touchCount = Number(flags.get('touch') ?? 1)
assert.ok(Number.isSafeInteger(sessionCount) && sessionCount > 0)
assert.ok(Number.isSafeInteger(eventsPerSession) && eventsPerSession > 0)
assert.ok(Number.isSafeInteger(projects) && projects > 0)
const bridgeRoot = new URL(bridgeArg.endsWith('/') ? bridgeArg : `${bridgeArg}/`, import.meta.url)
const require = createRequire(new URL('package.json', bridgeRoot))
const load = async name => import(pathToFileURL(require.resolve(name)).href)
const { Context } = await load('@deepseek-ai/cordis')
const { SessionId, SESSION_FORMAT_VERSION, adoptSessionEvent } = await load('@deepseek-ai/dsh-session')
const { default: JsonlSessionPersistence } = await load('@deepseek-ai/dsh-session-persistence-jsonl')
const { createSessionDiscovery } = await import(new URL('src/session-discovery.ts', bridgeRoot))

// One realistic coding turn in the exact stored shape the product persists:
// prompt, four tool round trips with 3KB results, the answer, the turn
// boundary, and a periodic title. Every event passes the SDK's own stored-event
// validator before it is written, so a template that drifts from the durable
// contract fails here rather than inside the benchmark.
const TOOL_STEPS = 4
const outputFor = (turn, step) => Array.from({ length: 48 }, (_, line) =>
  `line ${line} of turn ${turn} step ${step}: ${'result row '.repeat(4)}`).join('\n')
const templateEvents = []
const push = event => {
  event.seq = templateEvents.length
  templateEvents.push(adoptSessionEvent(event))
}
const turns = Math.ceil((eventsPerSession - 1) / (4 + TOOL_STEPS * 3))
for (let turn = 0; turn < turns; turn += 1) {
  push({ type: 'turn/start', time: 0, data: { turn } })
  push({
    type: 'user/message', time: 0, surfaceOp: 'append',
    data: {
      content: [{ type: 'text', text: `turn ${turn}: keep going on the current objective, step by step` }],
      source: { kind: 'user' }, role: 'user', id: `bench-prompt-turn-${turn}`,
    },
  })
  for (let step = 1; step <= TOOL_STEPS; step += 1) {
    const callId = `call-${turn}-${step}`
    push({ type: 'step/start', time: 0, data: { turn, step } })
    push({
      type: 'tool/call', time: 0,
      data: {
        turn, step, callId, name: step % 2 === 1 ? 'bash' : 'read',
        arguments: JSON.stringify({ command: `sed -n '1,120p' file-${turn}-${step}.ts`, workdir: '/workspace' }),
      },
    })
    push({
      type: 'tool/result', time: 0, surfaceOp: 'append',
      data: {
        turn, step,
        message: {
          source: { kind: 'tool', callId },
          content: [{ type: 'tool-result', toolCallId: callId, content: [{ type: 'text', text: outputFor(turn, step) }], isError: false }],
          role: 'user', id: `bench-result-turn-${turn}-step-${step}`,
        },
      },
    })
  }
  push({
    type: 'assistant/message', time: 0, surfaceOp: 'append',
    data: {
      turn, step: TOOL_STEPS, stream: [], usage: { inputTokens: 900, outputTokens: 120 },
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Turn ${turn} summary: ${'changed one concern and re-ran its check. '.repeat(16)}` }],
        source: { kind: 'model', provider: 'deepseek', model: 'deepseek-v4-flash' },
        id: `bench-answer-turn-${turn}`,
      },
    },
  })
  push({ type: 'turn/end', time: 0, data: { turn, reason: { kind: 'completed' } } })
  if (turn % 20 === 19) push({ type: 'session/title', time: 0, data: { title: `session covering turns through ${turn}`, messageSeqs: [], source: { kind: 'fallback' } } })
}
const template = templateEvents.slice(0, eventsPerSession)
assert.equal(template.length, eventsPerSession, 'the template covers the requested event count')

const root = await mkdtemp(join(tmpdir(), 'dscode-bench-list-'))
const ctx = new Context()
const persistence = new JsonlSessionPersistence(ctx, { root })
const base = Date.now() - sessionCount * 60_000
const sessionIds = []
const seedStarted = process.hrtime.bigint()
for (let index = 0; index < sessionCount; index += 1) {
  const createdAt = base + index * 60_000
  const id = SessionId(`bench-${String(index).padStart(4, '0')}`)
  const cwd = `/bench/project-${index % projects}`
  sessionIds.push({ id, createdAt, cwd })
  const events = structuredClone(template).map((event, seq) => ({ ...event, seq, time: createdAt + seq }))
  const handle = await persistence.create({ version: SESSION_FORMAT_VERSION, id, createdAt, cwd, isSeeded: false })
  await handle.append(events)
  await handle.flush()
  await handle.close()
}
const seedMs = Number(process.hrtime.bigint() - seedStarted) / 1e6

// Count every durable read the picker path performs, including through the
// handle it opens; the discovery module itself is untouched.
// The peak starts at zero here, after seeding, so it covers the picker phases.
const counters = { list: 0, open: 0, read: 0, events: 0, peakRss: 0 }
const sampleRss = () => { counters.peakRss = Math.max(counters.peakRss, process.memoryUsage().rss) }
const observed = new Proxy(persistence, {
  get(target, property) {
    if (property === 'list') return async (...args) => { counters.list += 1; return target.list(...args) }
    if (property === 'open') return async (...args) => {
      counters.open += 1
      const handle = await target.open(...args)
      return new Proxy(handle, {
        get(source, key) {
          if (key === 'read') return async (...readArgs) => {
            counters.read += 1
            const result = await source.read(...readArgs)
            counters.events += result.events.length
            sampleRss()
            return result
          }
          const value = Reflect.get(source, key, source)
          return typeof value === 'function' ? value.bind(source) : value
        },
      })
    }
    const value = Reflect.get(target, property, target)
    return typeof value === 'function' ? value.bind(target) : value
  },
})
const discovery = createSessionDiscovery({
  persistence: () => observed,
  query: () => undefined,
  owns: () => false,
  onEvent: () => () => {},
})

const heapNow = async () => {
  await new Promise(resolve => setImmediate(resolve))
  global.gc?.()
  global.gc?.()
  return process.memoryUsage().heapUsed
}
const listCwd = sessionIds[0].cwd
const candidates = sessionIds.filter(entry => entry.cwd === listCwd).length
const phases = []
const measure = async (cwd) => {
  const before = { ...counters }
  const started = process.hrtime.bigint()
  const result = await discovery.list('x.ai/session/list', { cwd, limit: 30 })
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  return {
    ms: +ms.toFixed(1), rows: result.sessions.length,
    opens: counters.open - before.open, reads: counters.read - before.read, events: counters.events - before.events,
  }
}
const listOnce = async (label, cwd = listCwd) => {
  const phase = await measure(cwd)
  phases.push({
    label, ...phase,
  })
  return phase
}
const snapshotMs = async () => {
  const started = process.hrtime.bigint()
  const snapshots = await persistence.list({})
  return { ms: +(Number(process.hrtime.bigint() - started) / 1e6).toFixed(1), snapshots: snapshots.length }
}
// The lifecycle asks "is this stored id still in use" when a client pins one.
// It answers with the backend point query; time that against the store listing
// above so the difference is measured, not assumed. Median of five.
const pointQueryMs = async id => {
  const samples = []
  for (let index = 0; index < 5; index += 1) {
    const started = process.hrtime.bigint()
    await persistence.stat(id, {})
    samples.push(Number(process.hrtime.bigint() - started) / 1e6)
  }
  samples.sort((left, right) => left - right)
  return +samples[2].toFixed(1)
}
const heapBefore = await heapNow()
const snapshots = await snapshotMs()
const pointQueries = { stored: await pointQueryMs(sessionIds[0].id), absent: await pointQueryMs(SessionId('bench-absent')) }
const first = await listOnce('cold')
for (let index = 2; index <= listCount; index += 1) await listOnce(`warm ${index - 1}`)
const heapWarm = await heapNow()

// A later client advances one stored session: exactly that row must re-read.
for (let index = 0; index < touchCount; index += 1) {
  const entry = sessionIds[index]
  const handle = await persistence.open(entry.id, 'write')
  await handle.append([{
    type: 'session/title', seq: eventsPerSession + index, time: entry.createdAt + 10_000 + index,
    data: { title: `retitled ${index}`, messageSeqs: [], source: { kind: 'user' } },
  }])
  await handle.flush()
  await handle.close()
}
await listOnce('after external change')

// The picker also opens other working directories. Everything a previous pass
// folded must stay resident, or switching projects pays the cold cost again.
const sweepPhases = []
if (flags.get('sweep') === 'true') {
  const dirs = [...new Set(sessionIds.map(entry => entry.cwd))]
  for (const pass of [1, 2]) for (const cwd of dirs) sweepPhases.push({ pass, cwd, ...await measure(cwd) })
}

assert.equal(first.rows, Math.min(30, candidates))
// Report every phase even when a limit is exceeded: the counts are the
// measurement, and `--strict` only turns a missed expectation into an exit
// code so a scaling run still records its full profile.
const violations = []
if (phases[0].opens !== candidates) violations.push(`cold list opened ${phases[0].opens} logs for ${candidates} candidates`)
for (const phase of phases.slice(1, -1)) {
  if (phase.opens !== 0) violations.push(`${phase.label} re-opened ${phase.opens} unchanged logs`)
}
if (phases.at(-1).opens !== touchCount) {
  violations.push(`after external change opened ${phases.at(-1).opens} logs for ${touchCount} changed sessions`)
}
for (const phase of sweepPhases) {
  const stored = sessionIds.filter(entry => entry.cwd === phase.cwd).length
  if (phase.pass === 2 ? phase.opens !== 0 : phase.opens > stored) {
    violations.push(`sweep pass ${phase.pass} opened ${phase.opens} logs for ${stored} stored sessions in ${phase.cwd}`)
  }
}
for (const violation of violations) console.error(`violation: ${violation}`)
console.log(JSON.stringify({
  node: process.version, platform: `${process.platform}-${process.arch}`,
  sessions: sessionCount, eventsPerSession, projects, candidates, limit: 30,
  seedMs: +seedMs.toFixed(1), rootBytes: Number(execFileSync('du', ['-sk', root]).toString().split('\t')[0]) * 1024,
  snapshotMs: snapshots.ms, snapshotCount: snapshots.snapshots,
  pointQueryMs: pointQueries,
  peakRssMiB: +(counters.peakRss / 1024 / 1024).toFixed(1),
  indexRetainedKiB: global.gc === undefined ? undefined : +((heapWarm - heapBefore) / 1024).toFixed(1),
  phases, ...sweepPhases.length === 0 ? {} : { sweepPhases }, violations,
}, null, 2))
if (flags.get('strict') === 'true' && violations.length > 0) process.exitCode = 1
await discovery.dispose()
await ctx.fiber.dispose()
