// Compare leader boot (spawn -> socket -> registered) between two installed
// dscode profile homes, alternating fresh processes. Optionally record every
// module the leader loads on the way to its first registration reply.
// This measures the dsh leader process only, not time to an interactive TUI.
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { bootLeader, censusHook, summarizeBoots } from './bench-leader.mjs'

const [dshBin, beforeHome, afterHome, pairsArg] = process.argv.slice(2)
assert.ok(dshBin && beforeHome && afterHome,
  'usage: node scripts/bench-leader-boot.mjs <dsh-bin> <before-home> <after-home> [pairs=8] [--census]')
const pairs = Number(pairsArg && !pairsArg.startsWith('--') ? pairsArg : 8)
const census = process.argv.includes('--census')
for (const home of [beforeHome, afterHome]) {
  assert.ok(existsSync(join(home, 'profiles/dscode/package.json')), `${home} lacks an installed dscode profile`)
}
// Unix socket paths are length-limited on macOS; keep them short.
const scratch = mkdtempSync(join(tmpdir(), 'dscb-'))
const hook = censusHook(scratch)
// Compile caching off: both sides compile every module they load.
const boot = (home, label, loads) => bootLeader({ dshBin, home, scratch, label, hook, loads,
  env: { NODE_DISABLE_COMPILE_CACHE: '1', NODE_COMPILE_CACHE: undefined } })
const summarize = samples => ({ ...summarizeBoots(samples), version: samples[0].version })

const result = { node: process.version, pairs, before: [], after: [] }
for (let i = 0; i < pairs; i++) {
  // Alternate order to spread page-cache and background-load bias across both sides.
  const order = i % 2 ? ['after', 'before'] : ['before', 'after']
  for (const side of order) result[side].push(await boot(side === 'before' ? beforeHome : afterHome, side))
}
result.summary = { before: summarize(result.before), after: summarize(result.after) }
if (census) {
  result.census = {}
  for (const [side, home] of [['before', beforeHome], ['after', afterHome]]) {
    const out = join(scratch, `${side}-loads.json`)
    await boot(home, `${side}-census`, out)
    const rows = JSON.parse(readFileSync(out, 'utf8')).filter(row => !row.url.startsWith('node:'))
    result.census[side] = { files: rows.length, bytes: rows.reduce((sum, row) => sum + row.bytes, 0), loads: out }
  }
}
console.log(JSON.stringify(result, null, 2))
