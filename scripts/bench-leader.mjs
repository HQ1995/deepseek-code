// Shared by bench-leader-boot.mjs and bench-leader-compile-cache.mjs: one real
// leader boot (spawn -> socket -> registered reply) in a fresh process, and an
// optional census of every module it loads on the way to that reply.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, openSync, rmSync, writeFileSync } from 'node:fs'
import { connect } from 'node:net'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

/** Write the census hook into scratch; boots given `loads` record there. */
export function censusHook(scratch) {
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
  return hook
}

const frame = body => {
  const json = Buffer.from(JSON.stringify(body)), head = Buffer.alloc(4)
  head.writeUInt32BE(json.length)
  return Buffer.concat([head, json])
}

/** Boot one leader and stop it. `env` entries set to undefined are removed;
 * `loads` with `hook` records the module census to that file. */
export async function bootLeader({ dshBin, home, scratch, label, env: overrides = {}, hook, loads, graceMs = 5000 }) {
  const socket = join(scratch, `${label}.sock`)
  rmSync(socket, { force: true })
  const env = {
    ...process.env, HOME: home, DSH_HOME: home, DSCODE_SOCKET: socket, DSCODE_LOG: join(scratch, `${label}.log`),
    DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', ...overrides,
  }
  delete env.NODE_OPTIONS
  for (const [key, value] of Object.entries(env)) if (value === undefined) delete env[key]
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
  await Promise.race([exited, new Promise(next => setTimeout(next, graceMs))])
  if (child.exitCode === null) { try { process.kill(-child.pid, 'SIGKILL') } catch {} }
  await exited
  assert.equal(registered.type, 'registered', `${label}: unexpected reply ${JSON.stringify(registered)}`)
  return { socketMs: +socketMs.toFixed(1), registeredMs: +registeredMs.toFixed(1), version: registered.leader_binary_version }
}

const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), mid = (sorted.length - 1) / 2
  return +((sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2).toFixed(1)
}

/** Medians and range of a set of boots. */
export const summarizeBoots = rows => ({
  socketMedianMs: median(rows.map(row => row.socketMs)),
  registeredMedianMs: median(rows.map(row => row.registeredMs)),
  minRegisteredMs: Math.min(...rows.map(row => row.registeredMs)),
  maxRegisteredMs: Math.max(...rows.map(row => row.registeredMs)),
})
