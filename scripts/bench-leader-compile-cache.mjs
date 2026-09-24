#!/usr/bin/env node
// Compare a real leader boot (spawn -> socket -> registered reply) with Node's
// compile cache disabled, cold and warm, alternating fresh processes. The
// leader is the only Node process a dscode launch waits on for module
// compilation, so this is the launch share the cache can move; it is not time
// to an interactive TUI or a model reply.
//
// The cache directory is asserted, not assumed: the disabled condition sets
// NODE_DISABLE_COMPILE_CACHE next to NODE_COMPILE_CACHE and the boot must leave
// the directory empty, so a silently ignored switch cannot be reported as a
// measurement. The first enabled boot starts from an empty directory (the cold
// population the first launch on a machine pays) and every later one is warm;
// --census additionally records every module the leader loads on the way to its
// first registration reply.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootLeader, censusHook, summarizeBoots } from './bench-leader.mjs'

const argv = process.argv.slice(2)
const census = argv.includes('--census')
const [dshBin, home, pairsArg] = argv.filter(value => !value.startsWith('--'))
assert.ok(dshBin && home, 'usage: node scripts/bench-leader-compile-cache.mjs <dsh-bin> <dsh-home> [pairs=8] [--census]')
const pairs = Number(pairsArg ?? 8)
assert.ok(existsSync(join(home, 'profiles/dscode/package.json')), `${home} lacks an installed dscode profile`)

const scratch = mkdtempSync(join(tmpdir(), 'dscbcc-'))
const cache = join(scratch, 'compile-cache')
const hook = censusHook(scratch)

function cacheStats(dir) {
  let files = 0, bytes = 0
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else { files += 1; bytes += statSync(child).size }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes }
}

async function boot(label, enabled, loads) {
  const before = cacheStats(cache)
  // The boot is already measured; a short grace keeps the run bounded while
  // still letting the leader take its own shutdown path when it is quick.
  const row = await bootLeader({ dshBin, home, scratch, label, hook, loads, graceMs: 1500,
    env: { NODE_COMPILE_CACHE: cache, ...(enabled ? {} : { NODE_DISABLE_COMPILE_CACHE: '1' }) } })
  const after = cacheStats(cache)
  if (!enabled) assert.equal(after.files, before.files, `${label}: the disabled cache still changed (${before.files} -> ${after.files})`)
  else if (before.files === 0) assert.ok(after.files > 0, `${label}: the enabled cache stayed empty, so the boot never used it`)
  // The census pass injects a module of its own, so only the plain warm boots
  // must reuse the directory without changing it.
  else if (!loads) assert.equal(after.files, before.files, `${label}: a warm boot rewrote the cache (${before.files} -> ${after.files})`)
  return {
    socketMs: row.socketMs, registeredMs: row.registeredMs,
    cacheFilesBefore: before.files, cacheFilesAfter: after.files,
    version: row.version,
  }
}

const summarize = rows => ({ ...summarizeBoots(rows), boots: rows.length })

const result = { node: process.version, dshBin, home, pairs, cache, off: [], cold: null, warm: [], coldRepeat: null, warmAfterRepeat: null }
for (let i = 0; i < pairs; i++) {
  // Alternate order to spread page-cache and background-load bias across both sides.
  const order = i % 2 ? ['on', 'off'] : ['off', 'on']
  for (const side of order) {
    if (side === 'off') result.off.push(await boot(`off-${i}`, false))
    else {
      const row = await boot(`on-${i}`, true)
      // The first enabled boot starts from an empty directory: that is the
      // population the first launch on a machine pays, not steady state.
      if (result.cold === null) result.cold = row
      else result.warm.push(row)
    }
  }
}
// A second population, after deleting the warm directory, separates the
// one-time cost from noise in the first sample.
rmSync(cache, { recursive: true, force: true })
result.coldRepeat = await boot('cold-repeat', true)
result.warmAfterRepeat = await boot('warm-after-repeat', true)
result.summary = { off: summarize(result.off), warmCache: summarize(result.warm) }
result.cacheAfterRun = cacheStats(cache)
if (census) {
  const out = join(scratch, 'warm-loads.json')
  await boot('census-warm', true, out)
  const rows = JSON.parse(readFileSync(out, 'utf8')).filter(row => !row.url.startsWith('node:'))
  result.census = { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), loads: out }
}
console.log(JSON.stringify(result, null, 2))
