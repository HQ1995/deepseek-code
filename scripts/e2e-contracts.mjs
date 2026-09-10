import { prepareNextSix, nextSixAcceptance } from './e2e-next-six.mjs'
import { archiveTerminalAcceptance } from './e2e-archive-terminal.mjs'
import { kittyImageAcceptance } from './e2e-kitty-images.mjs'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as settle } from 'node:timers/promises'
import { goalAcceptance, goalStreamAcceptance } from './e2e-goals.mjs'
import { historyAcceptance } from './e2e-history.mjs'
import { nativeTuiAcceptance } from './e2e-native-tui.mjs'
import { nativeControlsAcceptance } from './e2e-native-controls.mjs'

const execute = promisify(execFile)
const env = process.env
for (const key of ['DSCODE_E2E_SCRATCH', 'DSCODE_E2E_ARTIFACTS', 'DSCODE_E2E_RUN_ID', 'DSCODE_E2E_MOCK_LOG', 'DSCODE_E2E_OBSERVER_DIR', 'DSCODE_TUI_BIN', 'DSH_BIN']) assert.ok(env[key], `${key} is required`)
const scratch = resolve(env.DSCODE_E2E_SCRATCH)
const artifacts = join(resolve(env.DSCODE_E2E_ARTIFACTS), `contracts-${env.DSCODE_E2E_RUN_ID}`)
await mkdir(artifacts, { recursive: true })
const cwd = join(scratch, 'contract-workspace')
await mkdir(cwd, { recursive: true })
await prepareNextSix(cwd)
const session = `dscode-contract-${env.DSCODE_E2E_RUN_ID}`
const id = randomUUID()
let activeId = id
const peerId = randomUUID()
let generation = 0
const extraOnly = env.DSCODE_E2E_EXTRA_ONLY === '1'
let socket
const sockets = []
const children = []
// Keep the real media Open action observable without launching a host GUI.
const mediaOpenerLog = join(artifacts, 'media-open.log')
const openerBin = join(artifacts, 'open-bin')
await mkdir(openerBin, { recursive: true })
for (const name of ['xdg-open', 'open']) await writeFile(join(openerBin, name),
  `#!/usr/bin/env node\nrequire('node:fs').appendFileSync(${JSON.stringify(mediaOpenerLog)}, JSON.stringify(process.argv.slice(2)) + '\\n')\n`, { mode: 0o755 })
const baseEnv = { ...env, BROWSER: join(openerBin, 'xdg-open'), VISUAL: join(scratch, 'e2e-bin/prompt-editor'), EDITOR: join(scratch, 'e2e-bin/prompt-editor'), PATH: `${openerBin}:${env.PATH}`, HOME: scratch, DSH_HOME: scratch, DSC_HOME: join(scratch, 'dsc-contract'), FAKE_KEY: 'e2e-key', DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', TERM: 'xterm-256color' }
const artifact = async (name, value) => writeFile(join(artifacts, `${name}.json`), JSON.stringify(value, null, 2) + '\n')
const tmux = async (...args) => (await execute('tmux', ['-L', session, '-f', '/dev/null', ...args], { timeout: 10000, maxBuffer: 8 * 1024 * 1024 })).stdout
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
const capture = () => tmux('capture-pane', '-p', '-t', `${session}:main.0`)
const key = async value => { await tmux('send-keys', '-t', `${session}:main.0`, value) }
const send = async text => {
  // Separate navigation, bracketed paste and explicit submit. Mixed bursts are
  // deliberately merged by the TUI to recover fragmented terminal pastes.
  await settle(100)
  await tmux('set-buffer', '-b', 'contract-prompt', '--', text)
  await tmux('paste-buffer', '-b', 'contract-prompt', '-p', '-t', `${session}:main.0`)
  await settle(100)
  await key('Enter')
}
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
async function state(sessionId = activeId) {
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
async function boot(resume = false, preset) {
  socket = join(artifacts, `leader-${++generation}.sock`)
  sockets.push(socket)
  const command = [env.DSCODE_TUI_BIN, ...(resume ? ['--resume', activeId] : ['--session-id', activeId]), ...(preset ? ['--agent', preset] : []), '--model', 'fake-model', '--no-plan', '--always-approve']
  const commandEnv = { ...baseEnv, DSCODE_SOCKET: socket, DSCODE_LOG: join(artifacts, `leader-${generation}.log`), GROK_DEBUG_LOG: join(artifacts, `tui-${generation}.log`) }
  const shell = `cd ${quote(cwd)} && exec ${command.map(quote).join(' ')}`
  await execute('tmux', ['-L', session, '-f', '/dev/null', 'new-session', '-d', '-s', session, '-n', 'main', '-x', '200', '-y', '60', shell],
    { env: commandEnv, timeout: 10000, maxBuffer: 8 * 1024 * 1024 })
  // Release builds can ask for trust before creating the isolated test session.
  const screen = await wait(/Do you trust the contents of this directory\?|fake-model|Fake Model/, 30000)
  if (screen.includes('Do you trust the contents of this directory?')) await key('y')
  await wait(/fake-model|Fake Model/, 30000)
  await waitState(value => value.id === activeId, 'exact-session-observer', 30000)
  // Native agent creation precedes the TUI's load completion. Sending input
  // before this event races the restore that resets focused overlays.
  await waitFor(() => readFile(join(artifacts, `tui-${generation}.log`), 'utf8'),
    log => log.includes(`"msg":"session.${resume ? 'load' : 'create'}.done"`), 'tui-session-ready', 30000)
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
  assert.equal(expected, '0.1.5-rc.2', 'Acceptance targets the requested upstream runtime');
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
  const pidFile = env.DSCODE_E2E_CONTAINMENT === '1' ? join(artifacts, 'escaped-child.pid') : undefined
  await send('DSCODE_TASKS_PROBE' + (pidFile ? ':' + Buffer.from(pidFile).toString('base64url') : ''))
  await wait(/DSCODE_TASKS_READY/, 30000)
  const running = await waitState(value => value.jobs.some(job => job.status === 'running') && value.descendants.some(child => child.status && child.status !== 'idle'), 'real-background-services', 30000)
  const job = running.jobs.find(job => job.status === 'running')
  const child = running.descendants.find(child => child.status && child.status !== 'idle')
  let escapedPid
  if (pidFile) {
    escapedPid = Number(await waitFor(() => readFile(pidFile, 'utf8').catch(error => {
      if (error.code === 'ENOENT') return ''; throw error
    }), Boolean, 'escaped-child-started'))
    assert.ok(Number.isSafeInteger(escapedPid) && escapedPid > 1)
    const cgroup = await readFile(`/proc/${escapedPid}/cgroup`, 'utf8')
    const procStat = await readFile(`/proc/${escapedPid}/stat`, 'utf8')
    const status = await readFile(`/proc/${escapedPid}/status`, 'utf8')
    assert.match(cgroup, /dsh-subprocess-.*\.scope/, 'The real detached descendant must be contained by the new Linux scope')
    const fields = procStat.slice(procStat.lastIndexOf(')') + 2).split(' ')
    assert.equal(Number(fields[3]), escapedPid, 'Fixture must escape into its own POSIX session')
    await artifact('subprocess-containment-running', { escapedPid, cgroup, procStat, status })
  }
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
  if (escapedPid) {
    await waitFor(async () => {
      try { await stat(`/proc/${escapedPid}`); return false }
      catch (error) { if (error.code === 'ENOENT') return true; throw error }
    }, Boolean, 'escaped-child-reaped')
    await artifact('subprocess-containment-stopped', { escapedPid, reaped: true })
  }
  await key('h')
  await key('x')
  await settle(300)
  assert.equal((await state()).jobs.find(row => row.id === job.id)?.status, 'killed', 'Already-ended control cannot restart a job')
  await artifact('tasks-ended', { state: ended, screen: await capture() })
  await key('C-g')
  await send('/tasks')
  await waitFor(capture, screen => /(?:cancelled|killed)\s+Task/.test(screen)
    && screen.includes(pidFile ? 'dscode-containment' : 'DSCODE controlled background job'), 'terminal-native-job-row')
  assert.match(await capture(), /(?:idle|done|cancelled|stopped)\s+[^\n]*DSCODE controlled child/)
  await artifact('tasks-terminal-snapshot', { state: await state(), screen: await capture() })
  return child.id
}
async function childControlsAcceptance(childId) {
  const beforeRequests = (await readRequests()).length
  const child = () => state(childId)
  const waitChild = (predicate, label) => waitFor(child, value => value && predicate(value), label)
  const pending = value => [...value.inbox.nextTurn, ...value.inbox.nextStep]
  const text = message => message.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
  const control = async command => { await send(`/subagents ${command}`) }
  await control(`queue ${childId.slice(0, 8)} DSCODE_CHILD_CONTROL_HOLD`)
  await waitChild(value => value.status === 'running', 'child-native-resume')
  await waitFor(readRequests, requests => requests.slice(beforeRequests).some(body =>
    JSON.stringify(body.messages).includes('DSCODE_CHILD_CONTROL_HOLD')), 'child-model-resumed')
  await send('/tasks')
  await wait(/running[^\n]*DSCODE controlled child/)
  await send('exercise live screen switch')
  await wait(/DSCODE_MODE_RUNNING/)
  await waitState(value => value.status === 'running', 'parent-held-during-child-control')

  await control(`queue ${childId} DSCODE_CHILD_CLEAR`)
  await waitChild(value => pending(value).length === 1, 'child-queue-before-clear')
  await control(`clear ${childId}`)
  await waitChild(value => pending(value).length === 0, 'child-queue-cleared')
  for (const [index, token] of ['REMOVED', 'EDIT_OLD', 'KEEP_1', 'KEEP_2'].entries()) {
    await control(`queue ${childId} DSCODE_CHILD_${token}`)
    await waitChild(value => value.inbox.nextTurn.length === index + 1, `child-queued-${token}`)
  }
  const queued = await waitChild(value => value.inbox.nextTurn.length === 4, 'child-real-queued-input')
  const edited = queued.inbox.nextTurn.find(message => text(message) === 'DSCODE_CHILD_EDIT_OLD')
  const removed = queued.inbox.nextTurn.find(message => text(message) === 'DSCODE_CHILD_REMOVED')
  for (const message of queued.inbox.nextTurn) {
    assert.equal(message.source.kind, 'user')
    assert.ok(message.source.rpcId, 'Human child admission must retain native RPC provenance')
  }
  await control(`edit ${childId} ${edited.id.slice(0, 8)} DSCODE_CHILD_EDITED`)
  const afterEdit = await waitChild(value => pending(value).some(message => text(message) === 'DSCODE_CHILD_EDITED'), 'child-queue-edited')
  assert.deepEqual(pending(afterEdit).find(message => message.id === edited.id).source, edited.source)
  await control(`remove ${childId} ${removed.id}`)
  await waitChild(value => pending(value).length === 3, 'child-queue-removed')
  await control(`pending ${childId}`)
  await wait(/DSCODE_CHILD_EDITED/)
  await control(`steer-queued ${childId} ${edited.id}`)
  await waitChild(value => value.inbox.nextStep.length === 1 && value.inbox.nextTurn.length === 2, 'child-steer-one')
  await control(`steer-queued ${childId} all`)
  await waitChild(value => value.inbox.nextStep.length === 3 && value.inbox.nextTurn.length === 0, 'child-steer-all')
  await control(`steer ${childId} DSCODE_CHILD_DIRECT_STEER`)
  const steering = await waitChild(value => value.inbox.nextStep.length === 4, 'child-direct-steer')
  assert.equal((await state()).status, 'running', 'Child controls must preserve the held parent turn')
  await artifact('child-controls-steering', { child: steering, parent: await state(), screen: await capture() })

  await control(`stop ${childId}`)
  await wait(/stopped; queued input is preserved/)
  const stopped = await waitChild(value => value.status === 'idle', 'child-stop-with-pending')
  assert.deepEqual(pending(stopped), pending(steering), 'Stop must preserve exact pending message IDs, content and provenance')
  assert.equal((await state()).status, 'running', 'Child Stop must not complete or cancel the parent')
  await artifact('child-controls-stopped', { child: stopped, parent: await state(), screen: await capture() })
  await control(`queue ${childId} DSCODE_CHILD_RESUME`)
  await waitFor(readRequests, requests => requests.slice(beforeRequests).some(body =>
    JSON.stringify(body.messages).includes('DSCODE_CHILD_RESUME')), 'child-resume-delivered')
  await waitState(value => value.descendants.some(row => row.id === childId && row.activity === 'inactive'), 'child-resume-finished')
  const requests = (await readRequests()).slice(beforeRequests)
  const modelInput = JSON.stringify(requests.map(body => body.messages.filter(message => message.role === 'user')))
  for (const token of ['EDITED', 'KEEP_1', 'KEEP_2', 'DIRECT_STEER', 'RESUME']) assert.ok(modelInput.includes(`DSCODE_CHILD_${token}`), `Missing delivered child input: ${token}`)
  for (const token of ['EDIT_OLD', 'REMOVED', 'CLEAR']) assert.ok(!modelInput.includes(`DSCODE_CHILD_${token}`), `Cancelled or superseded child input reached the model: ${token}`)
  await send('/tasks')
  await wait(/(?:idle|done|completed)[^\n]*DSCODE controlled child/)
  assert.equal((await state()).status, 'running')
  const response = await fetch(`${env.DSCODE_E2E_GATEWAY}/preset-probe/release`, { method: 'POST' })
  assert.ok(response.ok)
  await waitState(value => value.status === 'idle', 'parent-completed-after-child-controls')
  // Slash results page the viewport to their own output. Check the full TUI
  // transcript so an earlier streaming block cannot disappear unnoticed.
  const transcriptPath = join(artifacts, 'child-controls-parent.md')
  await send(`/export ${transcriptPath}`)
  const transcript = await waitFor(() => readFile(transcriptPath, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error
  }), Boolean, 'child-controls-parent-export')
  for (const token of ['DSCODE_MODE_RUNNING', 'DSCODE_MODE_COMPLETE']) assert.equal(transcript.split(token).length - 1, 1, `Parent stream lost or repeated ${token}`)
  await artifact('child-controls-complete', { parent: await state(), requests, transcriptPath, screen: await capture() })
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

async function childHistoryAcceptance(childId) {
  const open = async (fresh = false) => {
    await key('C-g')
    if (fresh) {
      await key('h')
      await wait(/h:hide done/)
    }
    await key('Home')
    await key('Right')
    await key('/')
    await wait(/search:/)
    await key('C-u')
    await tmux('send-keys', '-l', '-t', `${session}:main.0`, 'DSCODE controlled child')
    await key('Enter')
    await settle(150)
    await key('Enter')
    await wait(/DSCODE controlled child[^\n]*\[✗\]/)
  }
  const close = async () => { await key('Escape'); await key('C-g') }
  await send(`/subagents queue ${childId} DSCODE_CHILD_HISTORY_LIVE`)
  await waitFor(() => state(childId), value => value?.status === 'running', 'history-live-child')
  await waitFor(readRequests, requests => requests.some(body => JSON.stringify(body.messages).includes('DSCODE_CHILD_HISTORY_TOOL')), 'history-child-real-tool')
  await open()
  await tmux('send-keys', '-N', '10', '-t', `${session}:main.0`, 'NPage')
  await wait(/DSCODE_CHILD_HISTORY_TOOL/)
  await artifact('child-history-running', { screen: await capture() })
  const release = await fetch(`${env.DSCODE_E2E_GATEWAY}/preset-probe/release?key=child-history`, { method: 'POST' })
  assert.ok(release.ok)
  await wait(/DSCODE_CHILD_HISTORY_START[\s\S]*DSCODE_CHILD_HISTORY_END/)
  await waitState(value => value.descendants.some(row => row.id === childId && row.activity === 'inactive'), 'history-child-complete')
  await artifact('child-history-refreshed', { screen: await capture() })
  await close()
  for (const fresh of [false, true]) {
    if (fresh) { await stop(); await boot(true) }
    await open(fresh)
    await tmux('send-keys', '-N', '10', '-t', `${session}:main.0`, 'NPage')
    await wait(/DSCODE_CHILD_HISTORY_START[\s\S]*DSCODE_CHILD_HISTORY_END/)
    const tail = await capture()
    assert.equal(tail.split('DSCODE_CHILD_HISTORY_END').length - 1, 1)
    await tmux('send-keys', '-N', '10', '-t', `${session}:main.0`, 'PPage')
    await wait(/DSCODE_CHILD_HOLD/)
    await artifact(`child-history-${fresh ? 'restarted' : 'reopened'}`, { head: await capture(), tail })
    await close()
  }
  await key('Space')
  await tmux('send-keys', '-l', '-t', `${session}:main.0`, 'parent quote draft')
  const beforeQuote = (await readRequests()).length
  await open()
  await tmux('send-keys', '-N', '10', '-t', `${session}:main.0`, 'NPage')
  // The child frame appears before its asynchronous history replay completes.
  await wait(/DSCODE_CHILD_HISTORY_START[\s\S]*DSCODE_CHILD_HISTORY_END/)
  await key('C-f')
  await wait(/Enter:quote/)
  await key('Enter')
  await wait(/parent quote draft[\s\S]*> DSCODE_CHILD_HISTORY_START/)
  assert.equal((await readRequests()).length, beforeQuote, 'Child quote must only edit the parent draft')
  await artifact('child-viewer-quote-parent', { screen: await capture() })
  await key('C-z')
  await waitFor(capture, screen => screen.includes('parent quote draft') && !screen.includes('> DSCODE_CHILD_HISTORY_START'), 'child-quote-undo')
  await key('C-u')
}
async function slashRecencyAcceptance() {
  await send('/queue')
  // MRU timestamps have one-second resolution; establish a real newer command.
  await settle(1100)
  const copied = join(artifacts, 'mru-copy.md')
  await send(`/copy ${copied}`)
  await waitFor(() => readFile(copied, 'utf8').catch(error => {
    if (error.code === 'ENOENT') return ''; throw error
  }), Boolean, 'mru-copy-command')
  for (const fresh of [false, true]) {
    if (fresh) { await stop(); await boot(true) }
    await tmux('send-keys', '-l', '-t', `${session}:main.0`, '/')
    const screen = await waitFor(capture, value => value.includes('/copy') && value.includes('/queue'), 'recent-slash-menu')
    assert.ok(screen.lastIndexOf('/copy') < screen.lastIndexOf('/queue'), 'Bare slash menu must show the more recently used command first')
    await artifact(`slash-recency-${fresh ? 'restored' : 'live'}`, { screen })
    await key('Escape')
    await key('C-u')
  }
}
let cleaning
function cleanup() {
  return cleaning ??= (async () => {
    for (const child of children) if (child.exitCode === null) child.kill('SIGTERM')
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
  let childId
  if (env.DSCODE_E2E_NEXT_SIX_ONLY !== '1' && !extraOnly) {
    await contextAcceptance()
    await permissionAcceptance()
    await autoAcceptance()
    childId = await tasksAcceptance()
    await childControlsAcceptance(childId)
    await childHistoryAcceptance(childId)
  }
  const goalUi = {
    send, key, wait, capture, state, waitState, settle, artifact,
    restart: async (delay = 0) => { await stop(); if (delay) await settle(delay); await boot(true) },
    captureHistory: () => tmux('capture-pane', '-p', '-S', '-', '-t', `${session}:main.0`),
    releaseModel: async () => {
      const response = await fetch(`${env.DSCODE_E2E_GATEWAY}/preset-probe/release`, { method: 'POST' })
      assert.ok(response.ok, `Controlled stream release failed: ${response.status}`)
    },
  }
  let history, nativeTui, nativeControls
  if (env.DSCODE_E2E_NEXT_SIX_ONLY !== '1' && !extraOnly) {
    await goalStreamAcceptance(goalUi)
    await goalAcceptance(goalUi)
    await slashRecencyAcceptance()
    nativeTui = await nativeTuiAcceptance({ ...goalUi, waitFor, readRequests, runHeadless, cwd,
      type: text => tmux('send-keys', '-l', '-t', `${session}:main.0`, text),
    })
    nativeControls = await nativeControlsAcceptance({ ...goalUi, waitFor, readRequests, cwd, childId,
      mediaOpenerLog,
      click: (x, y) => {
        const mouse = `\x1b[<0;${x + 1};${y + 1}M\x1b[<0;${x + 1};${y + 1}m`
        return tmux('send-keys', '-t', `${session}:main.0`, '-H', ...Buffer.from(mouse).toString('hex').match(/../g))
      },
      type: text => tmux('send-keys', '-l', '-t', `${session}:main.0`, text),
      paste: async text => {
        await tmux('set-buffer', '-b', 'controls', '--', text)
        await tmux('paste-buffer', '-b', 'controls', '-p', '-t', `${session}:main.0`)
      },
    })
  }
  const nextSix = extraOnly ? undefined : await nextSixAcceptance({ ...goalUi, waitFor, readRequests, runHeadless, cwd, scratch,
    mediaOpenerLog,
    click: (x, y, modifiers = 0) => {
      const mouse = `\x1b[<${modifiers};${x + 1};${y + 1}M\x1b[<${modifiers};${x + 1};${y + 1}m`
      return tmux('send-keys', '-t', `${session}:main.0`, '-H', ...Buffer.from(mouse).toString('hex').match(/../g))
    },
    type: text => tmux('send-keys', '-l', '-t', `${session}:main.0`, text),
    resize: async (width, height) => {
      await tmux('resize-window', '-t', `${session}:main`, '-x', String(width), '-y', String(height))
      await waitFor(capture, screen => screen.split('\n').some(line => line.trimStart().startsWith('╭') && Array.from(line).length === width - 2), `resize-${width}-${height}`)
    },
  })
  const archiveTerminal = await archiveTerminalAcceptance({ ...goalUi, waitFor, readRequests, cwd,
    fresh: async preset => { await stop(); activeId = randomUUID(); await boot(false, preset) },
    type: text => tmux('send-keys', '-l', '-t', `${session}:main.0`, text),
  })
  await stop()
  const kittyImages = env.DSCODE_E2E_KITTY_BIN ? await kittyImageAcceptance({
    kittyBin: env.DSCODE_E2E_KITTY_BIN, tuiBin: env.DSCODE_TUI_BIN, baseEnv, cwd, artifacts, waitFor, artifact, sockets, children,
  }) : { skipped: 'DSCODE_E2E_KITTY_BIN is not configured' }
  if (env.DSCODE_E2E_NEXT_SIX_ONLY !== '1' && !extraOnly) history = await historyAcceptance({ runHeadless, readRequests, scratch, artifactDir: artifacts })
  await artifact('PASS', { sessionId: id, history, nativeTui, nativeControls, nextSix, archiveTerminal, kittyImages })
  console.log(`PASS runtime acceptance: ${artifacts}`)
} catch (error) {
  await artifact('FAIL', { error: error.stack ?? String(error), state: await state().catch(() => null), screen: await capture().catch(() => '') })
  throw error
} finally {
  await cleanup()
}
