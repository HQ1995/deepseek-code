import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as settle } from 'node:timers/promises'
import { goalAcceptance } from './e2e-goals.mjs'
import { historyAcceptance } from './e2e-history.mjs'

const execute = promisify(execFile)
const env = process.env
for (const key of ['DSCODE_E2E_SCRATCH', 'DSCODE_E2E_ARTIFACTS', 'DSCODE_E2E_RUN_ID', 'DSCODE_E2E_MOCK_LOG', 'DSCODE_E2E_OBSERVER_DIR', 'DSCODE_TUI_BIN', 'DSH_BIN']) assert.ok(env[key], `${key} is required`)
const scratch = resolve(env.DSCODE_E2E_SCRATCH)
const artifacts = join(resolve(env.DSCODE_E2E_ARTIFACTS), `contracts-${env.DSCODE_E2E_RUN_ID}`)
await mkdir(artifacts, { recursive: true })
const cwd = join(scratch, 'contract-workspace')
await mkdir(cwd, { recursive: true })
const session = `dscode-contract-${env.DSCODE_E2E_RUN_ID}`
const id = randomUUID()
const peerId = randomUUID()
let generation = 0
let socket
const sockets = []
const baseEnv = { ...env, HOME: scratch, DSH_HOME: scratch, DSC_HOME: join(scratch, 'dsc-contract'), FAKE_KEY: 'e2e-key', DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', TERM: 'xterm-256color' }
const artifact = async (name, value) => writeFile(join(artifacts, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
const tmux = async (...args) => (await execute('tmux', ['-L', session, '-f', '/dev/null', ...args], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const capture = () => tmux('capture-pane', '-p', '-t', `${session}:main.0`)
const key = async value => { await tmux('send-keys', '-t', `${session}:main.0`, value) }
const send = async text => { await tmux('send-keys', '-l', '-t', `${session}:main.0`, text); await key('Enter') }
async function waitFor(read, predicate, label, timeout = 20000) {
  const deadline = Date.now() + timeout
  let value
  while (Date.now() < deadline) {
    value = await read()
    if (predicate(value)) return value
    await settle(100)
  }
  await artifact(`timeout-${label.replaceAll(/[^a-z0-9-]/gi, '-')}`, { value, screen: await capture().catch(() => '') })
  throw new Error(`${label} timed out after ${timeout}ms: ${JSON.stringify(value)}`)
}
async function state(sessionId = id) {
  const candidates = []
  for (const file of await readdir(env.DSCODE_E2E_OBSERVER_DIR)) {
    if (!file.endsWith('.json')) continue
    const sample = JSON.parse(await readFile(join(env.DSCODE_E2E_OBSERVER_DIR, file), 'utf8'))
    if (Date.now() - sample.time > 3000) continue
    const agent = sample.agents.find(agent => agent.id === sessionId)
    if (agent) candidates.push({ ...agent, observerPid: sample.pid, observedAt: sample.time })
  }
  return candidates.sort((a, b) => b.observedAt - a.observedAt)[0] ?? null
}
const waitState = (predicate, label, timeout) => waitFor(state, value => value && predicate(value), label, timeout)
const wait = (pattern, timeout) => waitFor(capture, screen => pattern.test(screen), String(pattern), timeout)
async function stop() {
  await tmux('kill-server').catch(() => {})
  if (socket) await waitFor(async () => {
    try { const pid = Number(await readFile(socket.replace(/\.[^.]+$/, '.lock'), 'utf8')); process.kill(pid, 0); return false }
    catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error }
  }, Boolean, 'fresh-leader-exit', 15000)
}
async function boot(resume = false) {
  socket = join(artifacts, `leader-${++generation}.sock`)
  sockets.push(socket)
  const command = [env.DSCODE_TUI_BIN, ...(resume ? ['--resume', id] : ['--session-id', id]), '--model', 'fake-model', '--no-plan', '--always-approve']
  const commandEnv = { ...baseEnv, DSCODE_SOCKET: socket, DSCODE_LOG: join(artifacts, `leader-${generation}.log`) }
  const shell = `cd ${quote(cwd)} && exec env ${Object.entries(commandEnv).map(([k,v]) => `${k}=${quote(v)}`).join(' ')} ${command.map(quote).join(' ')}`
  await tmux('new-session', '-d', '-s', session, '-n', 'main', '-x', '200', '-y', '60', shell)
  await wait(/fake-model|Fake Model/, 30000)
  await waitState(value => value.id === id, 'exact-session-observer', 30000)
}
const readRequests = async () => (await readFile(env.DSCODE_E2E_MOCK_LOG, 'utf8')).split('\n')
  .map(line => line.match(/^POST \S*\/chat\/completions (.*)$/)).filter(Boolean).map(match => JSON.parse(match[1]))
  .filter(body => !JSON.stringify(body).includes('Create a concise title'))
let headlessCount = 0
async function runHeadless({ cwd: workdir, preset, prompt, sessionId, resume }) {
  const number = ++headlessCount
  const headlessSocket = join(artifacts, `headless-${number}.sock`)
  sockets.push(headlessSocket)
  const args = ['-p', prompt, '--output-format', 'json', '--agent', preset, '--model', 'fake-model', '--no-plan', '--always-approve']
  if (resume) args.push('--resume', sessionId)
  else args.push('--session-id', sessionId ?? randomUUID())
  try {
    const result = await execute(env.DSCODE_TUI_BIN, args, { cwd: workdir, env: { ...baseEnv, DSCODE_SOCKET: headlessSocket, DSCODE_LOG: join(artifacts, `headless-${number}.leader.log`) }, timeout: 90000, maxBuffer: 16 * 1024 * 1024 })
    await writeFile(join(artifacts, `headless-${number}.stdout.json`), result.stdout)
    await writeFile(join(artifacts, `headless-${number}.stderr.log`), result.stderr)
    await waitFor(async () => {
      try { const pid = Number(await readFile(headlessSocket.replace(/\.[^.]+$/, '.lock'), 'utf8')); process.kill(pid, 0); return false }
      catch (error) { if (error.code === 'ENOENT' || error.code === 'ESRCH') return true; throw error }
    }, Boolean, `headless-${number}-leader-exit`, 15000)
    return JSON.parse(result.stdout)
  } catch (error) {
    await artifact(`headless-${number}-failure`, { message: error.message, stdout: error.stdout, stderr: error.stderr })
    throw error
  }
}
async function packaging() {
  const profile = join(scratch, 'profiles/dscode')
  const require = createRequire(join(profile, 'package.json'))
  const entry = await realpath(require.resolve('@hqzhao95/dscode'))
  assert.ok(!relative(profile, entry).startsWith('..'), 'Bridge must resolve inside the isolated profile, never the checkout')
  let packageDir = dirname(entry)
  while (true) {
    try { const value = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8')); if (value.name === '@hqzhao95/dscode') break } catch (error) { if (error.code !== 'ENOENT') throw error }
    const parent = dirname(packageDir); assert.notEqual(parent, packageDir, 'Bridge package manifest missing'); packageDir = parent
  }
  const manifest = JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  const expected = manifest.dsh.testedVersion
  assert.equal(expected, '0.1.3-alpha.1', 'Acceptance targets the requested upstream runtime');
  const cli = await execute(env.DSH_BIN, ['--version'], { env: baseEnv, timeout: 10000 })
  assert.equal(cli.stdout.trim().split('\n')[0], expected)
  let runtimeModules
  for (let directory = dirname(await realpath(env.DSH_BIN)); directory !== dirname(directory); directory = dirname(directory)) {
    if (basename(directory) === 'node_modules') runtimeModules = directory
  }
  assert.ok(runtimeModules, 'CLI must resolve inside an installed node_modules tree');
  const seen = new Set(), packages = []
  async function visit(directory, root) {
    const canonical = await realpath(directory)
    if (seen.has(canonical)) return
    seen.add(canonical)
    assert.ok(!relative(root, canonical).startsWith('..'), `Installed dependency points outside its installation: ${canonical}`)
    for (const item of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, item.name)
      if (item.isDirectory() || (item.isSymbolicLink() && (await stat(path)).isDirectory())) { if (item.name !== '.bin') await visit(path, root) }
      else if (item.name === 'package.json') {
        const value = JSON.parse(await readFile(path, 'utf8'))
        if (value.name === '@deepseek-ai/dsh' || value.name?.startsWith('@deepseek-ai/dsh-')) {
          assert.equal(value.version, expected, `Target family drift at ${path}`);
          packages.push({ name: value.name, version: value.version, path })
        }
      }
    }
  }
  await visit(join(profile, 'node_modules'), profile)
  await visit(runtimeModules, runtimeModules)
  assert.ok(packages.some(value => value.name === '@deepseek-ai/dsh-agent'))
  await artifact('packaging', { entry, expected, runtimeModules, packages })
}
async function permissionAcceptance() {
  const initial = await waitState(value => value.policy.approval === 'never', 'initial-always-approve')
  assert.equal(initial.permission, 'danger-full-access')
  assert.equal(initial.policy.sandbox, 'danger-full-access')
  const command = [env.DSCODE_TUI_BIN, '--session-id', peerId, '--model', 'fake-model', '--no-plan', '--always-approve']
  const shell = `cd ${quote(cwd)} && exec env ${Object.entries({ ...baseEnv, DSCODE_SOCKET: socket }).map(([k,v]) => `${k}=${quote(v)}`).join(' ')} ${command.map(quote).join(' ')}`
  await tmux('new-window', '-d', '-t', session, '-n', 'peer', shell)
  const peerBefore = await waitFor(() => state(peerId), value => value?.policy.approval === 'never', 'second-live-session')
  const approved = join(scratch, 'permission-approved')
  await send(`DSCODE_PERMISSION_PROBE:${Buffer.from(approved).toString('base64url')}`)
  await wait(/DSCODE_PERMISSION_DONE/, 30000)
  assert.equal(await readFile(approved, 'utf8'), 'approved')
  await key('C-o')
  const asking = await waitState(value => value.policy.approval === 'ask', 'toggle-live-ask')
  assert.equal(asking.permission, 'workspace-write')
  assert.equal(asking.policy.sandbox, 'workspace-write')
  assert.notEqual(asking.permission, initial.permission)
  const peerAfter = await state(peerId)
  assert.equal(peerAfter.permission, peerBefore.permission, 'Permission toggle must not mutate another live session')
  assert.deepEqual(peerAfter.policy, peerBefore.policy)
  const denied = join(scratch, 'permission-denied')
  await send(`DSCODE_PERMISSION_ESCALATED:${Buffer.from(denied).toString('base64url')}`)
  await wait(/No, reject \(type to add feedback\)/, 30000)
  await settle(700)
  await assert.rejects(readFile(denied), { code: 'ENOENT' }, 'Ask must hold the real shell operation pending approval')
  await artifact('permission-pending', { initial, asking, peerBefore, peerAfter, screen: await capture() })
  await key('2')
  await waitState(value => value.status === 'idle', 'approval-rejected', 30000)
  await assert.rejects(readFile(denied), { code: 'ENOENT' })
  assert.equal((await state()).policy.approval, 'ask')
  const accepted = join(scratch, 'permission-accepted')
  await send(`DSCODE_PERMISSION_ESCALATED:${Buffer.from(accepted).toString('base64url')}`)
  await wait(/No, reject \(type to add feedback\)/, 30000)
  await assert.rejects(readFile(accepted), { code: 'ENOENT' })
  await key('1')
  await waitFor(async () => readFile(accepted, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error }), value => value === 'approved', 'approval-allowed-once', 30000)
  await waitState(value => value.status === 'idle', 'approved-turn-settled', 30000)
  assert.equal((await state()).policy.approval, 'ask', 'One-time approval must not change standing policy')
  assert.equal((await state(peerId)).permission, peerBefore.permission)
  await key('C-o')
  await waitState(value => value.policy.approval === 'never', 'restore-always-approve')
  await tmux('kill-window', '-t', `${session}:peer`)
}
async function contextAcceptance() {
  // Before the first measured prompt, no sample is preferable to invented usage.
  const unknown = await state()
  await send('/usage')
  await wait(/Context usage unavailable/)
  const initialScreen = await capture()
  const before = unknown.projections.values.contextPressure
  assert.equal(before?.projectedTokens, undefined, 'Fresh session must have no invented prompt measurement')
  assert.match(initialScreen, /Context usage unavailable/)
  await artifact('context-initial', { state: unknown, screen: initialScreen })
  await key('Escape')
  for (let n = 0; n < 3; n++) {
    const previousOutput = (await state()).projections.values.tokenUsage.outputTokens
    await send(`DSCODE_CONTEXT_PROBE ${n}`)
    await waitState(value => value.status === 'idle' && value.projections.values.tokenUsage.outputTokens > previousOutput && value.projections.values.contextPressure?.projectedTokens != null, `context-sample-${n}`, 30000)
    await wait(/DSCODE_CONTEXT_DONE/)
    await settle(300)
  }
  const current = await state()
  const pressure = current.projections.values.contextPressure
  assert.equal(pressure.contextWindow, 32768)
  assert.ok(pressure.projectedTokens > 0)
  const usage = current.projections.values.tokenUsage
  const cumulative = usage.uncachedInputTokens + usage.outputTokens + usage.cacheReadTokens + usage.cacheWriteTokens
  assert.ok(cumulative > pressure.projectedTokens * 2, 'Fixture must distinguish cumulative billed usage from current pressure')
  await send('/usage')
  const compact = number => number >= 1000000 ? `${(number / 1000000).toFixed(1)}m`
    : number >= 99500 ? `${Math.floor((number + 500) / 1000)}k`
    : number >= 1000 ? `${(number / 1000).toFixed(1)}k` : String(number)
  const expectedUsage = `${compact(pressure.projectedTokens)} / ${compact(pressure.contextWindow)} tokens (${(pressure.projectedTokens / pressure.contextWindow * 100).toFixed(2)}%)`
  const screen = await waitFor(capture, value => value.includes(expectedUsage), 'authoritative-context-usage')
  assert.ok(screen.includes(expectedUsage), `Usage must render current native pressure/capacity: ${expectedUsage}`)
  await key('2')
  await waitFor(capture, value => value.includes('Session ID') && value.includes(id), 'usage-session-identity')
  assert.ok((await capture()).includes(id), 'Usage session information must preserve the actual session id')
  assert.equal((await state()).id, id)
  await artifact('context-measured', { state: current, screen, sessionScreen: await capture() })
  await key('Escape')
}
async function tasksAcceptance() {
  const empty = await state()
  assert.equal(empty.jobs.length, 0)
  assert.equal(empty.descendants.length, 0)
  await key('C-g')
  await key('x')
  await settle(300)
  assert.deepEqual((await state()).jobs, empty.jobs, 'Empty task control must not manufacture or route a job')
  assert.deepEqual((await state()).descendants, empty.descendants)
  await artifact('tasks-absent-control', { state: await state(), screen: await capture() })
  await key('C-g')
  await send('DSCODE_TASKS_PROBE')
  await wait(/DSCODE_TASKS_READY/, 30000)
  const running = await waitState(value => value.jobs.some(job => job.status === 'running') && value.descendants.some(child => child.status && child.status !== 'idle'), 'real-background-services', 30000)
  const job = running.jobs.find(job => job.status === 'running')
  const child = running.descendants.find(child => child.status && child.status !== 'idle')
  await key('C-g')
  await wait(/DSCODE controlled background job/)
  await wait(/DSCODE controlled child/)
  await artifact('tasks-running', { state: running, screen: await capture() })
  // Navigate the genuine pane selection; group-header x is intentionally a no-op.
  // Two expansions expose root jobs and descendant rows without a test control RPC.
  await key('Home')
  for (let step = 0; step < 30; step++) {
    await key('Right')
    await key('x')
    await settle(200)
    const value = await state()
    if (value.jobs.find(row => row.id === job.id)?.status === 'killed' && value.descendants.some(row => row.id === child.id && row.activity === 'inactive')) break
    if (step % 5 === 4) await key('Home')
    else await key('Down')
    if (step === 29) throw new Error('Tasks pane controls did not kill the actual job and interrupt the actual descendant')
  }
  const ended = await waitState(value => value.jobs.find(row => row.id === job.id)?.status === 'killed' && value.descendants.some(row => row.id === child.id && row.activity === 'inactive'), 'tasks-terminal-services')
  await key('h')
  await key('x')
  await settle(300)
  assert.equal((await state()).jobs.find(row => row.id === job.id)?.status, 'killed', 'Already-ended control cannot restart a job')
  await artifact('tasks-ended', { state: ended, screen: await capture() })
  await key('C-g')
  await send('/tasks')
  await wait(/(?:cancelled|killed)\s+Task.*DSCODE controlled background job/)
  assert.match(await capture(), /(?:idle|done|cancelled|stopped)\s+[^\n]*DSCODE controlled child/)
  await artifact('tasks-terminal-snapshot', { state: await state(), screen: await capture() })
}
async function autoAcceptance() {
  const before = await state()
  const requests = (await readRequests()).length
  await send('/auto')
  await wait(/not supported|unsupported|permission.classifier/i)
  assert.equal((await state()).permission, before.permission, '/auto must not change permission')
  assert.equal((await readRequests()).length, requests, '/auto must fail closed before model I/O')
  await artifact('auto-fail-closed', { state: await state(), screen: await capture() })
}
let cleaning
function cleanup() {
  return cleaning ??= (async () => {
    await tmux('kill-server').catch(() => {})
    // Each lock belongs to this run; SIGTERM invokes DSH's bounded service disposal,
    // including native jobs and descendants. Never signal an unrelated global dsh.
    for (const owned of sockets) {
      try { const pid = Number(await readFile(owned.replace(/\.[^.]+$/, '.lock'), 'utf8')); if (Number.isSafeInteger(pid) && pid > 1) process.kill(pid, 'SIGTERM') }
      catch (error) { if (!['ENOENT', 'ESRCH'].includes(error.code)) console.error(error) }
    }
  })()
}
process.once('SIGINT', () => { void cleanup().finally(() => process.exit(130)) })
process.once('SIGTERM', () => { void cleanup().finally(() => process.exit(143)) })
try {
  await packaging()
  await boot()
  await contextAcceptance()
  await permissionAcceptance()
  await autoAcceptance()
  await tasksAcceptance()
  await goalAcceptance({ send, key, wait, capture, state, waitState, restart: async () => { await stop(); await boot(true) }, settle, artifact })
  await stop()
  const history = await historyAcceptance({ runHeadless, readRequests, scratch, artifactDir: artifacts })
  await artifact('PASS', { sessionId: id, history })
  console.log(`PASS runtime acceptance: ${artifacts}`)
} catch (error) {
  await artifact('FAIL', { error: error.stack ?? String(error), state: await state().catch(() => null), screen: await capture().catch(() => '') })
  throw error
} finally {
  await cleanup()
}
