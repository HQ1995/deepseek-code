// Real macOS inspector and PTY teardown, not an application/model benchmark.
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { pathToFileURL } from 'node:url'

const [sourceArg, repeatsArg = '6'] = process.argv.slice(2)
assert.ok(sourceArg, 'usage: node --experimental-transform-types scripts/bench-macos-process.mjs <installed DSH source checkout> [repeats=6]')
assert.equal(process.platform, 'darwin')
const repeats = Number(repeatsArg)
assert.ok(Number.isSafeInteger(repeats) && repeats > 0 && repeats <= 100)
const source = resolve(sourceArg)
const pkg = join(source, 'packages/subprocess/subprocess-local')
const { createProcessInspector } = await import(pathToFileURL(join(pkg, 'src/process-inspector.ts')))
const { LocalTerminalHandle } = await import(pathToFileURL(join(pkg, 'src/terminal.ts')))
const pty = createRequire(join(pkg, 'package.json'))('node-pty')
let queries = []
const inspector = createProcessInspector('darwin', process.arch, {
  readFile: file => fs.readFileSync(file, 'utf8'), readDir: fs.readdirSync,
  readLink: file => fs.readlinkSync(file, 'utf8'), stat: fs.statSync,
  open: file => fs.openSync(file, 'r'), read: (fd, buffer, length, offset) => fs.readSync(fd, buffer, 0, length, offset),
  close: fs.closeSync, kill: (pid, signal) => process.kill(pid, signal),
  exec(file, args) {
    const start = performance.now()
    try { return execFileSync(file, args, { encoding: 'utf8' }) }
    finally { queries.push({ kind: args[0] === '-axo' ? 'table' : 'point', ms: performance.now() - start }) }
  },
})
const summarize = () => Object.fromEntries(['table', 'point'].map(kind => {
  const rows = queries.filter(row => row.kind === kind)
  return [kind, { count: rows.length, ms: rows.reduce((sum, row) => sum + row.ms, 0) }]
}))
// A real absent PID must be false, while identity timestamps still fence signals.
const child = spawn('/bin/sleep', ['30'])
const exited = once(child, 'exit')
let identity
try {
  identity = inspector.snapshot().tree(child.pid).find(row => row.pid === child.pid)
  assert.ok(identity)
  assert.equal(inspector.isAlive(identity), true)
  assert.equal(inspector.isAlive({ ...identity, started: 'not this process' }), false)
} finally {
  child.kill('SIGTERM')
  await exited
}
assert.equal(inspector.isAlive(identity), false)

for (let run = 0; run < repeats; run++) {
  const terminal = pty.spawn('/bin/bash', ['--noprofile', '--norc', '-c',
    'for i in 1 2 3 4 5 6 7 8; do /bin/sleep 30 & done; printf "READY\\n"; wait'],
  { cwd: source, env: { PATH: '/usr/bin:/bin', TERM: 'xterm' }, cols: 80, rows: 24 })
  const handle = new LocalTerminalHandle(terminal, inspector, 1000)
  let output = ''
  const ready = Promise.withResolvers()
  handle.output.on('data', data => { output += data; if (output.includes('READY')) ready.resolve() })
  const timeout = setTimeout(() => ready.reject(new Error('PTY readiness timed out')), 10000)
  try {
    await ready.promise
    const owned = inspector.snapshot().tree(terminal.pid)
    assert.ok(owned.length >= 9, `expected shell and eight children; got ${owned.length}`)
    handle.inspectForeground()
    queries = []
    const start = performance.now()
    await handle.terminate()
    await handle.done
    const teardownMs = performance.now() - start
    const inspection = summarize()
    for (const member of owned) assert.equal(inspector.isAlive(member), false, `survivor ${member.pid}`)
    console.log(JSON.stringify({ source, node: process.version, run, owned: owned.length, teardownMs, inspection }))
  } finally {
    clearTimeout(timeout)
    await handle.terminate()
  }
}
