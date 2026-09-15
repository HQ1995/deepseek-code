// Synthetic history through the actual output module and framed writable sink.
// Measures replay/transport work, not disk loading, model latency or TUI paint.
import assert from 'node:assert/strict'
import { createHook } from 'node:async_hooks'
import { createHash } from 'node:crypto'
import { Writable } from 'node:stream'
import { performance } from 'node:perf_hooks'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [modulePath, countArg = '20000', mode = 'text'] = process.argv.slice(2)
assert.ok(modulePath, 'usage: node --expose-gc bench-session-output.mjs <src/session-output.ts> [events=20000] [text|metadata|slow] [--count-promises]')
const count = Number(countArg)
assert.ok(Number.isSafeInteger(count) && count > 0)
assert.ok(['text', 'metadata', 'slow'].includes(mode))
const url = pathToFileURL(resolve(modulePath))
const { createSessionOutput } = await import(url.href)
const { writeJsonFrame, waitForDrain } = await import(new URL('./codec.ts', url))
const events = Array.from({ length: count }, (_, seq) => ({ seq, time: seq + 1000,
  type: mode === 'metadata' ? 'fixture/no-output' : 'user/message',
  data: { source: { kind: 'user' }, content: [{ type: 'text', text: String(seq) + ' ' + 'history '.repeat(16) }] },
}))
let frames = 0, bytes = 0, peakQueuedBytes = 0, firstUpdateMs, promises = 0
const wireHash = createHash('sha256')
const sink = new Writable({ highWaterMark: 16 * 1024, write(chunk, _encoding, done) {
  bytes += chunk.length
  wireHash.update(chunk)
  if (mode === 'slow') setImmediate(done)
  else done()
} })
sink.on('error', error => { throw error })
const output = createSessionOutput({ sessionId: 'fixture', cwd: () => '/fixture', isLive: () => true,
  promptId: () => undefined, contextValues: () => ({}),
  projectImages: async () => { throw new Error('text replay must not hydrate images') },
  logger: { warn(message) { throw new Error(message) } },
  notify(method, params) {
    firstUpdateMs ??= performance.now() - start
    assert.equal(params._meta.eventSeq, ++frames)
    assert.equal(params.update.content.text, events[frames - 1].data.content[0].text)
    writeJsonFrame(sink, { method, params })
    peakQueuedBytes = Math.max(peakQueuedBytes, sink.writableLength)
  },
  drain: () => sink.writableNeedDrain ? waitForDrain(sink) : undefined,
})
global.gc?.()
const initialHeap = process.memoryUsage().heapUsed
const hook = createHook({ init(_id, type) { if (type === 'PROMISE') promises++ } })
if (process.argv.includes('--count-promises')) hook.enable()
const start = performance.now()
const replay = output.restore(events)
const admissionMs = performance.now() - start
const admissionHeapMiB = (process.memoryUsage().heapUsed - initialHeap) / 1024 ** 2
await replay
await new Promise(resolve => sink.end(resolve))
const completionMs = performance.now() - start
await output.dispose()
hook.disable()
assert.equal(frames, mode === 'metadata' ? 0 : count)
sink.destroy()
console.log(JSON.stringify({ node: process.version, module: resolve(modulePath), count, mode, instrumented: process.argv.includes('--count-promises'),
  admissionMs, completionMs, firstUpdateMs, admissionHeapMiB, frames, bytes, peakQueuedBytes, wireSha256: wireHash.digest('hex'),
  ...(process.argv.includes('--count-promises') ? { promises } : {}),
}))
