// Compare fresh-process import cost with and without Node's built-in code cache.
// This measures a module graph, not time to an interactive TUI or a model reply.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { performance } from 'node:perf_hooks'

if (!process.argv[2]) throw new Error('usage: node scripts/bench-startup.mjs <compiled-bridge-entry>')
const entry = pathToFileURL(resolve(process.argv[2])).href
const cache = mkdtempSync(join(tmpdir(), 'dscode-compile-bench-'))
const env = { ...process.env }
delete env.NODE_OPTIONS
delete env.NODE_DISABLE_COMPILE_CACHE
const script = `import {getCompileCacheDir} from 'node:module'; const start=performance.now(); await import(${JSON.stringify(entry)}); console.log(JSON.stringify({importMs:performance.now()-start,rss:process.memoryUsage().rss,cacheEnabled:getCompileCacheDir()!==undefined}));`
function run(cached) {
  const start = performance.now()
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...env, ...cached ? {} : { NODE_DISABLE_COMPILE_CACHE: '1' }, NODE_COMPILE_CACHE: cache },
    encoding: 'utf8', timeout: 30000, maxBuffer: 1024 * 1024,
  })
  assert.ifError(result.error)
  assert.equal(result.status, 0, result.stderr)
  const sample = JSON.parse(result.stdout.trim().split('\n').at(-1))
  assert.equal(sample.cacheEnabled, cached, 'Benchmark must actually enable/disable the cache')
  return { ...sample, processMs: performance.now() - start }
}
const coldCache = run(true), uncached = [], warmed = []
for (let i = 0; i < 6; i++) {
  // Alternate order to reduce systematic page-cache / machine-load bias.
  if (i % 2) { warmed.push(run(true)); uncached.push(run(false)) }
  else { uncached.push(run(false)); warmed.push(run(true)) }
}
const summary = samples => Object.fromEntries(['importMs', 'processMs', 'rss'].map(key => {
  const sorted = samples.map(sample => sample[key]).sort((a, b) => a - b)
  return [key, +((sorted[2] + sorted[3]) / 2).toFixed(2)]
}))
console.log(JSON.stringify({ node: process.version, entry, cache, coldCache, uncachedMedian: summary(uncached), warmCacheMedian: summary(warmed), uncached, warmed }, null, 2))
