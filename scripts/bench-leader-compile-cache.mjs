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
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const argv = process.argv.slice(2)
const census = argv.includes('--census')
const [dshBin, home, pairsArg] = argv.filter(value => !value.startsWith('--'))
assert.ok(dshBin && home, 'usage: node scripts/bench-leader-compile-cache.mjs <dsh-bin> <dsh-home> [pairs=8] [--census]')
const pairs = Number(pairsArg ?? 8)
assert.ok(existsSync(join(home, 'profiles/dscode/package.json')), `${home} lacks an installed dscode profile`)

const scratch = mkdtempSync(join(tmpdir(), 'dscbcc-'))
const cache = join(scratch, 'compile-cache')
const hook = join(scratch, 'census.mjs')
writeFileSync(hook, `
import Module from 'node:module'
import { writeFileSync } from 'node:fs'
const rows = []
Module.registerHooks({ load(url, context, nextLoad) {
  const r = nextLoad(url, context)
  const bytes = !r.source ? 0 : typeof r.source === 'string' ? Buffer.byteLength(r.source) : r.source.byteLength
  rows.push({ url, bytes })
  return r
} })
process.on('exit', () => writeFileSync(process.env.DSCODE_BENCH_LOADS, JSON.stringify(rows)))
`)

const frame = body => {
  const json = Buffer.from(JSON.stringify(body)), head = Buffer.alloc(4)
  head.writeUInt32BE(json.length)
  return Buffer.concat([head, json])
}

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
  const socket = join(scratch, `${label}.sock`)
  rmSync(socket, { force: true })
  const env = {
    ...process.env, HOME: home, DSH_HOME: home, DSCODE_SOCKET: socket, DSCODE_LOG: join(scratch, `${label}.log`),
    DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NODE_COMPILE_CACHE: cache,
    ...(enabled ? {} : { NODE_DISABLE_COMPILE_CACHE: '1' }),
  }
  delete env.NODE_OPTIONS
  const args = [dshBin, '--profile', 'dscode']
  if (loads) { env.DSCODE_BENCH_LOADS = loads; args.unshift('--import', hook) }
  const before = cacheStats(cache)
  const log = openSync(env.DSCODE_LOG, 'a')
  const start = performance.now()
  const child = spawn(process.execPath, args, { env, stdio: ['ignore', log, log], detached: true })
  child.unref()
  while (!existsSync(socket)) {
    if (child.exitCode !== null) throw new Error(`${label}: leader exited before listening; see ${env.DSCODE_LOG}`)
    await new Promise(next => setTimeout(next, 2))
  }
  const socketMs = performance.now() - start
  const conn = connect(socket)
  await new Promise((ok, fail) => { conn.once('connect', ok); conn.once('error', fail) })
  conn.write(frame({ type: 'register', client_type: 'bench', mode: 'stdio', capabilities: { client_version: '0.0.0' } }))
  const registered = await new Promise((ok, fail) => {
    let buf = Buffer.alloc(0)
    conn.on('data', data => {
      buf = Buffer.concat([buf, data])
      if (buf.length >= 4 && buf.length >= 4 + buf.readUInt32BE(0)) ok(JSON.parse(buf.subarray(4, 4 + buf.readUInt32BE(0)).toString()))
    })
    conn.once('error', fail)
    setTimeout(() => fail(new Error(`${label}: no registration reply`)), 60000)
  })
  const registeredMs = performance.now() - start
  conn.destroy()
  const exited = new Promise(done => child.once('exit', done))
  try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill('SIGTERM') }
  // The boot is already measured; a short grace keeps the run bounded while
  // still letting the leader take its own shutdown path when it is quick.
  await Promise.race([exited, new Promise(next => setTimeout(next, 1500))])
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  await exited
  assert.equal(registered.type, 'registered', `${label}: unexpected reply ${JSON.stringify(registered)}`)
  const after = cacheStats(cache)
  if (!enabled) assert.equal(after.files, before.files, `${label}: the disabled cache still changed (${before.files} -> ${after.files})`)
  else if (before.files === 0) assert.ok(after.files > 0, `${label}: the enabled cache stayed empty, so the boot never used it`)
  // The census pass injects a module of its own, so only the plain warm boots
  // must reuse the directory without changing it.
  else if (!loads) assert.equal(after.files, before.files, `${label}: a warm boot rewrote the cache (${before.files} -> ${after.files})`)
  return {
    socketMs: +socketMs.toFixed(1), registeredMs: +registeredMs.toFixed(1),
    cacheFilesBefore: before.files, cacheFilesAfter: after.files,
    version: registered.leader_binary_version,
  }
}

const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), mid = (sorted.length - 1) / 2
  return +((sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2).toFixed(1)
}
const summarize = rows => ({
  socketMedianMs: median(rows.map(row => row.socketMs)),
  registeredMedianMs: median(rows.map(row => row.registeredMs)),
  minRegisteredMs: Math.min(...rows.map(row => row.registeredMs)),
  maxRegisteredMs: Math.max(...rows.map(row => row.registeredMs)),
  boots: rows.length,
})

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
