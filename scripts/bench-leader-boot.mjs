// Compare leader boot (spawn -> socket -> registered) between two installed
// dscode profile homes, alternating fresh processes. Optionally record every
// module the leader loads on the way to its first registration reply.
// This measures the dsh leader process only, not time to an interactive TUI.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { performance } from 'node:perf_hooks'

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
const hook = join(scratch, 'register.mjs')
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

async function boot(home, label, loads) {
  const socket = join(scratch, `${label}.sock`)
  rmSync(socket, { force: true })
  const env = {
    ...process.env, HOME: home, DSH_HOME: home, DSCODE_SOCKET: socket, DSCODE_LOG: join(scratch, `${label}.log`),
    DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', NODE_DISABLE_COMPILE_CACHE: '1',
  }
  delete env.NODE_OPTIONS
  delete env.NODE_COMPILE_CACHE
  const args = [dshBin, '--profile', 'dscode']
  if (loads) { env.DSCODE_BENCH_LOADS = loads; args.unshift('--import', hook) }
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
  await Promise.race([exited, new Promise(next => setTimeout(next, 5000))])
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  await exited
  assert.equal(registered.type, 'registered', `${label}: unexpected reply ${JSON.stringify(registered)}`)
  return { socketMs: +socketMs.toFixed(1), registeredMs: +registeredMs.toFixed(1), version: registered.leader_binary_version }
}

const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), mid = (sorted.length - 1) / 2
  return +((sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2).toFixed(1)
}
const summarize = samples => ({
  socketMedianMs: median(samples.map(sample => sample.socketMs)),
  registeredMedianMs: median(samples.map(sample => sample.registeredMs)),
  minRegisteredMs: Math.min(...samples.map(sample => sample.registeredMs)),
  maxRegisteredMs: Math.max(...samples.map(sample => sample.registeredMs)),
  version: samples[0].version,
})

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
