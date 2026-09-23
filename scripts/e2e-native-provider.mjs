#!/usr/bin/env node
// Keyless acceptance for the native DeepSeek provider: add, list, remove, add,
// prompt, in-use refusal and persistence across a leader restart, through the
// installed bridge and the real plugin manager against a loopback Messages
// fixture. Usage: e2e-native-provider.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import net from 'node:net'
import { join } from 'node:path'
import { encodeJsonFrame, FrameDecoder } from '../bridge/grok-leader/src/codec.ts'

const [runtime, home] = process.argv.slice(2)
if (!runtime || !home) throw new Error('usage: e2e-native-provider.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>')
const KEY = 'native-provider-fixture-key'
const NATIVE = 'deepseek-official'
const requests = []
let failure

const server = createServer((request, response) => {
  void (async () => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.method === 'GET' && request.url === '/v1/models') {
      // The pi-ai route that keeps another provider current.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }))
      return
    }
    requests.push({ url: request.url, key: request.headers['x-api-key'], body: JSON.parse(body || '{}') })
    assert.equal(request.url, '/anthropic/v1/messages')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-native', model: 'fixture', usage: { input_tokens: 5, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native provider fixture reply' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const baseURL = `http://127.0.0.1:${server.address().port}/anthropic`

async function withLeader(run) {
  const socketPath = `/tmp/dscode-native-provider-${process.pid}-${Date.now()}.sock`
  let diagnostics = ''
  const env = { ...process.env, DSH_HOME: home, HOME: home, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1' }
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS']) delete env[name]
  const leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode'], { env, stdio: ['ignore', 'pipe', 'pipe'] })
  for (const stream of [leader.stdout, leader.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536) })
  try {
    for (let i = 0; !existsSync(socketPath); i++) {
      assert.ok(i < 150 && leader.exitCode === null, diagnostics || 'leader did not start')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    const socket = net.createConnection(socketPath)
    await once(socket, 'connect')
    const decoder = new FrameDecoder(), pending = new Map()
    let nextId = 0
    socket.on('data', chunk => {
      for (const bytes of decoder.push(chunk)) {
        const frame = JSON.parse(Buffer.from(bytes).toString())
        if (frame.type !== 'acp') continue
        const message = JSON.parse(frame.payload)
        const waiter = message.id == null ? undefined : pending.get(message.id)
        if (waiter === undefined) continue
        pending.delete(message.id)
        if (message.error) waiter.reject(new Error(JSON.stringify(message.error)))
        else waiter.resolve(message.result)
      }
    })
    const rpc = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      pending.set(id, { resolve, reject })
      socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }))
    })
    socket.write(encodeJsonFrame({ type: 'register', client_type: 'native-provider-test', mode: 'stdio', capabilities: {} }))
    await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
    const session = await rpc('session/new', { cwd: home, mcpServers: [] })
    try { return await run(rpc, session.sessionId) } finally {
      await rpc('session/close', { sessionId: session.sessionId }).catch(() => {})
      socket.destroy()
    }
  } catch (error) {
    throw new Error(`${error.message}\n--- leader diagnostics ---\n${diagnostics}`)
  } finally {
    if (leader.exitCode === null) {
      const closed = once(leader, 'close')
      leader.kill('SIGTERM')
      const force = setTimeout(() => leader.kill('SIGKILL'), 5000)
      try { await closed } finally { clearTimeout(force) }
    }
    assert.doesNotMatch(diagnostics, /did not activate|failed to import|duplicate service/i)
  }
}

const nativeModels = list => list.availableModels.filter(model => model._meta?.provider === NATIVE)
const prompt = async (rpc, sessionId, list) => {
  const model = nativeModels(list)[0]
  assert.ok(model, 'native DeepSeek models are listed')
  await rpc('session/set_model', { sessionId, modelId: model.modelId })
  const before = requests.length
  const completion = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply briefly.' }] })
  assert.equal(completion.stopReason, 'end_turn')
  // The first turn also titles the session through the same route (no tools).
  const turn = requests.slice(before)
  assert.equal(turn.filter(request => (request.body.tools?.length ?? 0) > 0).length, 1, 'one agent turn request')
  assert.ok(turn.every(request => request.key === KEY), 'the pasted key reaches the adapter through the credentials service')
  return model
}

try {
  await withLeader(async (rpc, sessionId) => {
    assert.deepEqual(nativeModels(await rpc('x.ai/models/list', { sessionId })), [], 'the adapter starts disabled')
    // Another route stays current, so the native one can be removed while unused.
    await rpc('x.ai/providers/add', { id: 'fixture', displayName: 'Fixture', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture', credentialSource: 'saved' })
    const fixture = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(model => model._meta?.provider === 'fixture')
    assert.ok(fixture, 'the fixture route is listed')
    await rpc('session/set_model', { sessionId, modelId: fixture.modelId })
    const added = await rpc('x.ai/providers/add', { id: NATIVE, api: 'deepseek-native', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: KEY, baseURL, credentialSource: 'saved' })
    assert.match(JSON.stringify(added), /deepseek-official/)
    assert.ok(nativeModels(await rpc('x.ai/models/list', { sessionId })).length > 0, 'enabling applies without a restart')
    await rpc('x.ai/providers/remove', { id: NATIVE })
    assert.deepEqual(nativeModels(await rpc('x.ai/models/list', { sessionId })), [], 'removal disables the adapter live')
    await rpc('x.ai/providers/add', { id: NATIVE, api: 'deepseek-native', apiKey: KEY, baseURL, credentialSource: 'saved' })
    await prompt(rpc, sessionId, await rpc('x.ai/models/list', { sessionId }))
    await assert.rejects(rpc('x.ai/providers/remove', { id: NATIVE }), /is in use/)
  })
  const patch = readFileSync(join(home, 'profiles/dscode/cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: llm-deepseek[\s\S]*?disabled: false/, 'the enabled row is persisted in the profile patch')
  await withLeader(async (rpc, sessionId) => {
    await prompt(rpc, sessionId, await rpc('x.ai/models/list', { sessionId }))
  })
  if (failure) throw failure
  assert.ok(requests.every(request => request.url === '/anthropic/v1/messages'))
  console.log(JSON.stringify({ node: process.version, nativeProvider: 'passed', turns: requests.length, persisted: true }))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
