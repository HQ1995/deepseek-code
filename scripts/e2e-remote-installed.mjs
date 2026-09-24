#!/usr/bin/env node
/** Installed dscode remote profile over ACP: one SSH workspace, driven by a
 * loopback Messages fixture through the native DeepSeek provider. Keyless.
 * Needs an approved POSIX host with the matching helper, Node and PTC bootstrap
 * installed (see `dscode remote init`), and a fresh DSH_HOME holding dscode.
 * Usage: e2e-remote-installed.mjs <extracted-runtime> <fresh-dsh-home> <config.json>
 * where config.json has host, workspace, node, helper, helperHash, bootstrapPath
 * and bootstrapHash. The run creates and removes one file in the workspace. */
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { join, posix } from 'node:path'
import { encodeJsonFrame, FrameDecoder } from '../bridge/grok-leader/src/codec.ts'

const [runtime, home, configPath] = process.argv.slice(2)
if (!runtime || !home || !configPath) throw new Error('usage: e2e-remote-installed.mjs <runtime> <dsh-home> <config.json>')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const execute = promisify(execFile)
const remote = async command => (await execute('ssh', ['-o', 'BatchMode=yes', config.host, command], { timeout: 20_000 })).stdout
const KEY = 'loopback-fixture-only'
const canary = 'dscode-remote-canary-' + randomUUID() + '.txt'
const local = await mkdtemp(join(tmpdir(), 'dscode-remote-local-'))
const checks = []
let phase, step = 0, failure

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, '/anthropic/v1/messages')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
    let tool, args
    if (phase === 'shell' && step === 0) { tool = 'bash'; args = { command: 'pwd; uname -s', description: 'Show the remote workspace' } }
    else if (phase === 'shell' && step === 1) assert.match(JSON.stringify(results.at(-1)), new RegExp(config.workspace.replace(/[/.]/g, '\\$&') + '[\\s\\S]*Linux'))
    else if (phase === 'write' && step === 0) { tool = 'write'; args = { file_path: posix.join(config.workspace, canary), content: 'REMOTE_CANARY' } }
    else if (phase === 'write' && step === 1) assert.doesNotMatch(JSON.stringify(results.at(-1)), /"is_error":true/)
    assert.ok(step++ < 3, 'unexpected model loop')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-' + phase + step, model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-' + phase + step, name: tool, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: 'Remote fixture reply' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

// The installed launcher writes the profile rows, exactly as a user would run it.
const launcher = join(home, 'profiles/dscode/node_modules/@hqzhao95/dscode/bin/dscode.mjs')
const flags = ['--host', config.host, '--workspace', config.workspace, '--node', config.node, '--helper', config.helper,
  '--helper-hash', config.helperHash, '--bootstrap', config.bootstrapPath, '--bootstrap-hash', config.bootstrapHash]
await execute(process.execPath, [launcher, 'remote', 'init', ...flags], { env: { ...process.env, DSH_HOME: home } })
// Test-only overlay: no title request, native tool calls, and no approval prompts for the fixture's two calls.
const testPatch = join(local, 'remote-test.patch.yml')
await writeFile(testPatch, '- id: session-title-llm\n  disabled: true\n- id: tools\n  config:\n    mode: native\n')
const socketPath = `/tmp/dscode-remote-installed-${process.pid}.sock`
const env = { ...process.env, DSH_HOME: home, HOME: home, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1' }
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS']) delete env[name]
const leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode', '--patch', testPatch], { env, stdio: ['ignore', 'pipe', 'pipe'] })
let diagnostics = '', socket
for (const stream of [leader.stdout, leader.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536) })
try {
  for (let i = 0; !existsSync(socketPath); i++) {
    assert.ok(i < 300 && leader.exitCode === null, diagnostics || 'leader startup timeout')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  socket = net.createConnection(socketPath)
  const decoder = new FrameDecoder(), pending = new Map(), notes = []
  let nextId = 0
  const send = message => socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', ...message }) }))
  socket.on('data', chunk => {
    for (const bytes of decoder.push(chunk)) {
      const frame = JSON.parse(Buffer.from(bytes).toString())
      if (frame.type !== 'acp') continue
      const message = JSON.parse(frame.payload)
      if (message.method === 'session/request_permission') send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: 'allow-once' } } })
      else if (message.method) notes.push(message)
      else {
        const result = pending.get(message.id); pending.delete(message.id)
        if (message.error) result?.reject(new Error(JSON.stringify(message.error)))
        else result?.resolve(message.result)
      }
    }
  })
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('ACP timeout: ' + method)) }, 60_000)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(failure ?? error) } })
    send({ id, method, params })
  })
  await once(socket, 'connect')
  socket.write(encodeJsonFrame({ type: 'register', client_type: 'remote-acceptance', mode: 'stdio', capabilities: {} }))
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.deepEqual(init._meta.dscodeExecutionWorld, { kind: 'ssh', host: config.host, workspace: config.workspace })
  checks.push('initialize advertises the SSH world')

  await assert.rejects(rpc('session/new', { cwd: local, mcpServers: [] }), /remote workspace/)
  await assert.rejects(rpc('session/new', { cwd: config.workspace, mcpServers: [{ name: 'local', command: '/usr/bin/true', args: [], env: [] }] }), /Local stdio MCP servers/)
  const { sessionId } = await rpc('session/new', { cwd: config.workspace, mcpServers: [] })
  await rpc('x.ai/providers/add', { id: 'deepseek-official', api: 'deepseek-native', apiKey: KEY, baseURL: origin + '/anthropic', credentialSource: 'saved' })
  const model = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(item => item._meta?.provider === 'deepseek-official')
  await rpc('session/set_model', { sessionId, modelId: model.modelId })
  checks.push('host cwd and host stdio MCP refused; the session opens in the remote workspace')

  const prompt = label => { phase = label; step = 0; return rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: label }] }) }
  assert.equal((await prompt('shell')).stopReason, 'end_turn')
  checks.push('bash runs on the remote host in the workspace (Linux)')

  // The write lands on the remote host; nothing appears at that path here.
  const localTwin = join(config.workspace, canary)
  assert.equal((await prompt('write')).stopReason, 'end_turn')
  assert.equal((await remote(`cat ${JSON.stringify(localTwin)}`)).trim(), 'REMOTE_CANARY')
  assert.equal(existsSync(localTwin), false, 'the write must not land on this computer')
  checks.push('file writes land on the remote host only')

  const doctor = (await rpc('x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.12' })).text
  assert.match(doctor, new RegExp(`\\[INFO\\] Remote workspace: ssh ${config.host}:${config.workspace.replace(/[/.]/g, '\\$&')}; helper sha256 ${config.helperHash}`))
  const archive = 'remote-export-' + process.pid + '.zip'
  await rpc('x.ai/session/export', { sessionId, prompt: [{ type: 'text', text: archive }] })
  assert.ok(existsSync(join(home, archive)), 'relative export lands under the home directory on this computer')
  checks.push('doctor names the remote workspace; exports stay on this computer')
  assert.doesNotMatch(diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  if (failure) throw failure
  await rpc('session/close', { sessionId })
  console.log(JSON.stringify({ node: process.version, passed: true, checks, host: config.host }))
} catch (error) {
  throw new Error(`${error.message}\n--- leader diagnostics ---\n${diagnostics}`, { cause: error })
} finally {
  socket?.destroy()
  if (leader.exitCode === null) {
    const closed = once(leader, 'close')
    leader.kill('SIGTERM')
    const timer = setTimeout(() => leader.kill('SIGKILL'), 8000)
    try { await closed } finally { clearTimeout(timer) }
  }
  await remote(`rm -f ${JSON.stringify(join(config.workspace, canary))}`).catch(() => {})
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(local, { recursive: true, force: true })
}
