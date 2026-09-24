#!/usr/bin/env node
/** SDK-level acceptance of the shipped SSH execution world
 * (bridge/grok-leader/ssh) against one approved POSIX host.
 * Usage: e2e-ssh-smoke.mjs <extracted-runtime> <config.json>, config as for
 * e2e-remote-installed.mjs. Link bridge/grok-leader/node_modules to the
 * runtime's node_modules first. */
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { releaseSdk } from './release-sdk.mjs'
// The shipped adapter; its runtime packages resolve beside the bridge's node_modules.
import * as Remote from '../bridge/grok-leader/ssh/index.mjs'

const { sdk, mount } = releaseSdk(process.argv[2], { modulesOf: fileURLToPath(new URL('../bridge/grok-leader', import.meta.url)) })
const { Context } = await sdk('@deepseek-ai/cordis')
const config = JSON.parse(await readFile(process.argv[3], 'utf8'))
const ctx = new Context()
const signal = AbortSignal.timeout(60_000)
const runId = 'acceptance-' + randomUUID()
const cwd = config.workspace
const pids = []
const checks = []
const pass = name => { checks.push(name); console.log('PASS', name) }
const execute = promisify(execFile)
const remotePs = async () => (await execute('ssh', ['-o', 'BatchMode=yes', config.host, 'ps -eo pid,comm'], { timeout: 10_000, maxBuffer: 2 * 1024 * 1024 })).stdout
const processSpec = argv => ({ argv, cwd, graceMs: 1000, signal, stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } } })
try {
  await mount(ctx, 'session-projection')
  await mount(ctx, 'sandbox-policy', { mode: 'workspace-write', workspaceRoot: cwd })
  await ctx.plugin(Remote, config)
  assert.equal((await ctx.ssh.ready).workspace, cwd)
  assert.equal(ctx.ssh.nodeExecutable, config.node)
  pass('verified SSH helper and remote execution coordinates')
  const target = await ctx.fs.resolve(runId + '.txt')
  const created = await ctx.fs.writeText(target, 'first', { kind: 'createIfAbsent' }, signal)
  assert.equal(await ctx.fs.readText(target, signal), 'first')
  await assert.rejects(ctx.fs.writeText(target, 'stale', { kind: 'replaceIfVersion', version: 'stale' }, signal), { code: 'FS_STALE_VERSION' })
  await ctx.fs.writeText(target, 'second', { kind: 'replaceIfVersion', version: created.version }, signal)
  await assert.rejects(ctx.fs.writeText(target, 'denied', undefined, signal, { mode: 'read-only', workspaceRoot: cwd }), { code: 'FS_SANDBOX_DENIED' })
  assert.equal(await ctx.fs.readText(target, signal), 'second')
  assert.equal(ctx.fs.processPathFromHostPath('/Users/local/file'), undefined)
  pass('remote FS read/write, stale version and read-only denial')
  const run = request => ctx.ptcRuntime.run(ctx.ptcRuntime.resolve({ cwd, signal, ...request }))
  const result = await run({ program: 'return {cwd: process.cwd(), platform: process.platform, env: Object.keys(process.env)};', bindings: [] })
  assert.equal(result.error, undefined, JSON.stringify(result.error))
  assert.deepEqual(result.value, { cwd, platform: 'linux', env: [] })
  pass('real remote Node PTC with empty environment')
  const denied = await run({ program: `await (await import('node:fs/promises')).writeFile(${JSON.stringify(runId + '.txt')}, 'bad');`, bindings: [], sandboxPolicy: { mode: 'read-only', workspaceRoot: cwd } })
  assert.ok(denied.error, 'read-only direct Node write must fail')
  assert.equal(await ctx.fs.readText(target, signal), 'second')
  pass('real remote PTC file-effect sandbox')
  const processHandle = ctx.subprocess.spawn(processSpec([config.node, '-e', 'process.stdout.write(process.cwd()); process.stderr.write("stderr-ok")']))
  assert.equal((await processHandle.done).exitCode, 0)
  assert.equal(await processHandle.waitForExit(signal), true)
  assert.equal(processHandle.collected.stdout.readFrom(0).text, cwd)
  assert.equal(processHandle.collected.stderr.readFrom(0).text, 'stderr-ok')
  pass('ordinary subprocess output collection and range settlement')
  const terminal = await ctx.subprocess.spawnTerminal({ argv: ['/bin/sh'], cwd, rows: 24, cols: 80, terminalType: 'xterm', graceMs: 1000, signal })
  let terminalOutput = ''
  terminal.output.on('data', bytes => { terminalOutput += bytes })
  await terminal.resize(100, 30)
  await terminal.write('pwd; stty size; exit\n')
  assert.equal((await terminal.done).exitCode, 0)
  await terminal.terminate()
  assert.ok(terminalOutput.includes(cwd), terminalOutput)
  assert.match(terminalOutput, /30 100/)
  pass('real remote PTY, input, resize, output and cleanup')
  const cancel = new AbortController()
  // bwrap gives every program namespace PID 2. Observe the host PID by a
  // unique, short comm name instead of mistaking the next program for it.
  const title = 'ds' + randomUUID().replaceAll('-', '').slice(0, 10)
  const cancelled = await run({ program: `process.title = ${JSON.stringify(title)}; await tools.ready({}); await new Promise(() => {});`,
    signal: cancel.signal, bindings: [{ global: 'tools', functions: { ready: async () => {
      const stdout = await remotePs()
      const rows = stdout.split('\n').map(line => line.trim().split(/\s+/)).filter(row => row[1] === title)
      assert.equal(rows.length, 1)
      pids.push(Number(rows[0][0])); cancel.abort(); return null
    } } }] })
  assert.equal(cancelled.error?.kind, 'abort')
  await assert.rejects(ctx.fs.readText(await ctx.fs.resolve(`/proc/${pids[0]}/stat`), signal), { code: 'FS_NOT_FOUND' })
  pass('cancel returns only after remote host PID disappears')
  const cleanup = await run({ program: `await (await import('node:fs/promises')).unlink(${JSON.stringify(runId + '.txt')}); return true;`, bindings: [] })
  assert.equal(cleanup.value, true)
  // Kill only this test process's unique SSH master. No shared/user SSH
  // connection is touched; an independent read-only channel observes cleanup.
  const disconnectedTitle = 'ds' + randomUUID().replaceAll('-', '').slice(0, 10)
  const disconnected = ctx.subprocess.spawn(processSpec([config.node, '-e', `process.title = ${JSON.stringify(disconnectedTitle)}; console.log('ready'); setInterval(() => {}, 1000)`]))
  const disconnectedOutcome = disconnected.done.then(() => null, error => error)
  for (let i = 0; !disconnected.collected.stdout.readFrom(0).text.includes('ready'); i++) {
    assert.ok(i < 100, 'remote disconnect probe did not start')
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  const { stdout: localPs } = await execute('ps', ['-axo', 'pid,ppid,command'])
  const masters = localPs.split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(row => row && Number(row[2]) === process.pid && row[3].startsWith('ssh -T -M -S ') && row[3].includes(config.helper))
  assert.equal(masters.length, 1, 'must identify exactly one owned SSH master')
  process.kill(Number(masters[0][1]), 'SIGKILL')
  assert.ok(await disconnectedOutcome, 'transport loss must reject, never report successful execution')
  await assert.rejects(ctx.fs.readText(target, signal), /closed|disconnect|connection/i)
  for (let i = 0; (await remotePs()).split('\n').some(line => line.trim().split(/\s+/)[1] === disconnectedTitle); i++) {
    assert.ok(i < 40, 'remote process survived lease expiry')
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  pass('abrupt owned transport loss rejects operations and remote lease cleans process')
  console.log(JSON.stringify({ node: process.version, host: config.host, checks, pids }))
} finally { await ctx.fiber.dispose() }
