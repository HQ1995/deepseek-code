// Real compiled clients against an owned socket fixture. No provider credentials,
// production profile, or synthetic production test hooks are needed.
import assert from 'node:assert/strict'
import { spawn, execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { setTimeout as delay } from 'node:timers/promises'
import { FrameDecoder, encodeJsonFrame } from '../bridge/grok-leader/src/codec.ts'
import { fixtureEnvironment } from '../bridge/grok-leader/tests/fixtures/environment.ts'

const execute = promisify(execFile)
const root = resolve(import.meta.dirname, '..')
const binary = resolve(process.env.DSCODE_TUI_BIN ?? join(root, 'third_party/grok-build/target/release/dscode'))
const out = resolve(process.env.DSCODE_E2E_ACK_OUT ?? await mkdtemp(join(tmpdir(), 'dscode-ack-')))
await mkdir(out, { recursive: true })
const version = (await readFile(join(root, 'VERSION'), 'utf8')).trim()
const report = []
const quote = text => `'${String(text).replaceAll("'", "'\\''")}'`
const waitFor = async (read, accept, label, timeout = 15000) => {
  const end = Date.now() + timeout
  let value
  while (Date.now() < end) {
    value = await read()
    if (accept(value)) return value
    await delay(50)
  }
  throw new Error(`${label} timed out: ${JSON.stringify(value)}`)
}

async function fixture(name, mode) {
  const home = join(out, name)
  await mkdir(home, { recursive: true })
  const socketPath = join(home, 'leader.sock'), sockets = new Set(), timers = new Set(), requests = []
  const after = (ms, fn) => { const timer = setTimeout(() => { timers.delete(timer); fn() }, ms); timers.add(timer) }
  let sequence = 0, promptId, promptRequest, sendAcp, done = false, serverError
  const modelState = { currentModelId: 'ack-model', availableModels: [{ modelId: 'ack-model', name: 'Ack Model' }] }
  const server = createServer(socket => {
    sockets.add(socket); socket.on('close', () => sockets.delete(socket)); socket.on('error', () => {})
    const decoder = new FrameDecoder()
    const send = value => { if (!socket.destroyed) socket.write(encodeJsonFrame(value)) }
    const acp = value => send({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', ...value }) })
    sendAcp = acp
    const notify = (method, params) => acp({ method: method.startsWith('session/') ? method : '_' + method, params })
    const finish = request => {
      if (done) return
      done = true
      notify('session/update', { sessionId: 'ack-session', _meta: { promptId },
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACK_FIXTURE_DONE' } } })
      acp({ id: request.id, result: { stopReason: 'end_turn', _meta: { sessionId: 'ack-session', promptId } } })
    }
    socket.on('data', chunk => {
      try {
      for (const frame of decoder.push(chunk)) {
        const envelope = JSON.parse(new TextDecoder().decode(frame))
        if (envelope.type === 'register') {
          send({ type: 'registered', client_id: 1, ready: true, leader_protocol_version: 1, leader_binary_version: version })
          continue
        }
        if (envelope.type === 'ping') { send({ type: 'pong' }); continue }
        if (envelope.type !== 'acp') continue
        const request = JSON.parse(envelope.payload)
        if (!request.method) continue
        const method = request.method.replace(/^_/, '')
        requests.push({ ...request, method })
        let result = {}
        if (method === 'initialize') result = {
          protocolVersion: 1,
          agentCapabilities: { loadSession: true, promptCapabilities: { image: true }, sessionCapabilities: { list: {}, close: {} } },
          authMethods: [{ id: 'xai.api_key', name: 'API key' }], agentInfo: { name: 'dscode-ack-fixture', version },
          _meta: { grokShell: true, cancelRewind: false, sessionRecap: false, modelState },
        }
        else if (method === 'session/new') result = { sessionId: 'ack-session', models: modelState }
        else if (method === 'x.ai/models/list') result = modelState
        else if (method === 'session/list') result = { sessions: [] }
        else if (method === 'x.ai/session/info') result = { sessionId: 'ack-session' }
        else if (method === 'session/prompt') {
          promptRequest = request
          promptId = request.params._meta?.promptId
          if (!promptId && process.env.DSCODE_E2E_ACK_BASELINE === '1') promptId = 'legacy'
          assert.ok(promptId, 'every sent prompt must carry its minted id')
          if (mode === 'queue') notify('x.ai/queue/changed', { sessionId: 'ack-session', seq: ++sequence,
            entries: [{ id: promptId, version: 0, kind: 'prompt', text: 'accepted in queue', position: 0 }] })
          if (mode === 'update') notify('session/update', { sessionId: 'ack-session', _meta: { promptId },
            update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'ACK_ACCEPTED' } } })
          if (mode === 'terminal') notify('x.ai/session/prompt_complete', { sessionId: 'ack-session', promptId, stopReason: 'end_turn' })
          if (['queue', 'update', 'terminal'].includes(mode)) after(6500, () => finish(request))
          else {
            // These must not acknowledge the current prompt, even in a busy stream.
            const noise = () => {
              if (socket.destroyed || done) return
              notify('session/update', { sessionId: 'ack-session', _meta: { promptId, isReplay: true },
                update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } } })
              notify('x.ai/queue/changed', { sessionId: 'other-session', seq: ++sequence, entries: [], runningPromptId: promptId })
              notify('x.ai/queue/changed', { sessionId: 'ack-session', seq: ++sequence,
                entries: [{ id: 'other-prompt', version: 0, kind: 'prompt', text: 'unrelated queued input', position: 0 }] })
              after(100, noise)
            }
            noise()
          }
          continue
        } else if (method === 'x.ai/session/cancel_prompt') {
          assert.equal(request.params.promptId, promptId)
          assert.equal(request.params.sessionId, 'ack-session')
          if (mode === 'old') { acp({ id: request.id, error: { code: -32601, message: 'method not found' } }); continue }
          if (mode === 'silent-cancel') continue
          result = { status: 'cancelled' }
        }
        if (request.id !== undefined) acp({ id: request.id, result })
      }
      } catch (error) { serverError = error; socket.destroy() }
    })
  })
  await new Promise((yes, no) => { server.once('error', no); server.listen(socketPath, yes) })
  const env = fixtureEnvironment(home, { DSCODE_SOCKET: socketPath, DSCODE_HOME: join(home, 'profile'),
    DSCODE_MANAGED_LAUNCHER: '1', DSCODE_PROMPT_ACK_TIMEOUT_SECS: '5', DSH_TELEMETRY_DISABLED: '1',
    TERM: 'xterm-256color', NO_COLOR: '1' })
  return { home, env, requests, get promptId() { return promptId },
    lateFailure() { sendAcp({ id: promptRequest.id, error: { code: -32603, message: 'late old prompt failure' } }) },
    async close() {
      for (const timer of timers) clearTimeout(timer)
      for (const socket of sockets) socket.destroy()
      await new Promise(resolve => server.close(resolve))
      await writeFile(join(home, 'requests.json'), JSON.stringify(requests, null, 2))
      if (serverError) throw serverError
    },
  }
}

async function headless(mode) {
  const f = await fixture('headless-' + mode, mode)
  const start = Date.now()
  let child, stdout = '', stderr = ''
  try {
    child = spawn(binary, ['--leader', '--trust', '--no-auto-update', '--model', 'ack-model', '-p', 'ack test', '--output-format', 'json'], { cwd: f.home, env: f.env })
    child.stdout.on('data', data => { stdout += data })
    child.stderr.on('data', data => { stderr += data })
    const result = await new Promise((yes, no) => {
      const timer = setTimeout(() => { child.kill('SIGTERM'); no(new Error('headless exceeded 15s')) }, 15000)
      child.once('error', error => { clearTimeout(timer); no(error) })
      child.once('exit', (code, signal) => { clearTimeout(timer); yes({ code, signal }) })
    })
    const accepted = ['queue', 'update', 'terminal'].includes(mode)
    assert.equal(result.code === 0, accepted, `${mode}: ${stdout}\n${stderr}`)
    assert.equal((stdout + stderr).includes('prompt_ack_timeout'), !accepted, stdout + stderr)
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1)
    assert.equal(f.requests.filter(r => r.method === 'session/cancel').length, 0)
    assert.equal(f.requests.filter(r => r.method === 'x.ai/session/cancel_prompt').length, accepted ? 0 : 1)
    if (accepted) assert.ok(Date.now() - start >= 6000, 'acknowledged model work must outlive the ack deadline')
    report.push({ surface: 'headless', mode, ...result, elapsedMs: Date.now() - start })
  } finally {
    if (child?.exitCode === null) child.kill('SIGTERM')
    await writeFile(join(f.home, 'stdout.txt'), stdout)
    await writeFile(join(f.home, 'stderr.txt'), stderr)
    await f.close()
  }
}

async function tui(newDraft, mode = 'none') {
  const name = `tui-${mode}-${newDraft ? 'draft' : 'empty'}`, f = await fixture(name, mode)
  const session = `dscode-ack-${process.pid}-${name}`
  const tmux = async (...args) => (await execute('tmux', ['-L', session, '-f', '/dev/null', ...args], { env: f.env, timeout: 10000 })).stdout
  const capture = () => tmux('capture-pane', '-p', '-t', session)
  try {
    const command = [binary, '--leader', '--trust', '--no-auto-update', '--model', 'ack-model', '--no-plan',
      '--session-id', '00000000-0000-4000-8000-000000000001']
    await tmux('new-session', '-d', '-s', session, '-x', '160', '-y', '45', `cd ${quote(f.home)} && exec ${command.map(quote).join(' ')}`)
    await waitFor(capture, screen => /ack-model|Ack Model/.test(screen), 'TUI ready')
    await tmux('send-keys', '-t', session, '-l', 'ORIGINAL_ACK_TEST')
    await delay(150); await tmux('send-keys', '-t', session, 'Enter')
    await waitFor(() => f.requests, rows => rows.some(r => r.method === 'session/prompt'), 'prompt sent')
    if (mode === 'queue') {
      const final = await waitFor(capture, screen => screen.includes('ACK_FIXTURE_DONE'), 'acknowledged TUI completion')
      assert.ok(!final.includes('No acknowledgment received'), 'queue receipt must disarm the TUI watch')
      assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1)
      assert.equal(f.requests.filter(r => r.method.includes('cancel')).length, 0)
      await writeFile(join(f.home, 'screen.txt'), final)
      report.push({ surface: 'tui', mode, acknowledgedLongTurn: true })
      return
    }
    if (newDraft) await tmux('send-keys', '-t', session, '-l', 'NEWER_DRAFT')
    const timedOut = await waitFor(capture, screen => screen.includes('No acknowledgment received within 5s'), 'TUI recovery')
    const inputArea = timedOut.split('\n').slice(-12).join('\n')
    assert.ok(inputArea.includes('ORIGINAL_ACK_TEST'), 'original must be in the composer, not only scrollback')
    if (newDraft) assert.ok(inputArea.includes('NEWER_DRAFT'))
    await waitFor(() => f.requests, rows => rows.some(r => r.method === 'x.ai/session/cancel_prompt'), 'targeted cancel')
    assert.equal(f.requests.filter(r => r.method === 'session/prompt').length, 1, 'no automatic resend')
    assert.equal(f.requests.filter(r => r.method === 'session/cancel').length, 0, 'no broad cancellation')
    if (mode === 'old') await waitFor(capture, screen => screen.includes('Cancellation unconfirmed'), 'old bridge warning')
    f.lateFailure(); await delay(250)
    const final = await capture()
    assert.ok(!final.includes('late old prompt failure'), 'late failure must not replace recovered input')
    await writeFile(join(f.home, 'screen.txt'), final)
    report.push({ surface: 'tui', mode, draft: newDraft ? 'newer' : 'empty', lateFailureIgnored: true })
  } finally { await tmux('kill-server').catch(() => {}); await f.close() }
}

for (const mode of ['none', 'old', 'silent-cancel', 'queue', 'update', 'terminal']) {
  console.log(`[prompt-ack] headless ${mode}`)
  await headless(mode)
}
for (const draft of [false, true]) { console.log(`[prompt-ack] TUI ${draft ? 'draft' : 'empty'}`); await tui(draft) }
for (const mode of ['queue', 'old']) { console.log(`[prompt-ack] TUI ${mode}`); await tui(false, mode) }
await writeFile(join(out, 'PASS.json'), JSON.stringify({ binary, cases: report }, null, 2))
console.log(`PASS prompt-ack acceptance: ${out}`)
