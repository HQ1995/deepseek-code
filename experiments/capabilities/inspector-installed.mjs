/** Installed dscode ACP + native Messages + Inspector: absent by default, mounted with DSCODE_INSPECTOR=1.
 * Usage: inspector-installed.mjs <runtime> <dsh-home with dscode and the packed ../inspector bundle> */
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { encodeJsonFrame, FrameDecoder } from '../../bridge/grok-leader/src/codec.ts'

const [runtime, profileHome] = process.argv.slice(2)
const workspace = await mkdtemp(join(tmpdir(), 'dscode-inspector-installed-'))
let failure, turns = 0
const checks = []
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    assert.equal(request.url, '/anthropic/v1/messages')
    assert.equal(request.headers['x-api-key'], 'loopback-fixture-only')
    const body = JSON.parse(Buffer.concat(chunks))
    const names = body.tools.map(tool => tool.name)
    assert.equal(new Set(names).size, names.length)
    turns++
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-' + turns, model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Installed Inspector turn passed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
try {
  for (const enabled of [false, true]) {
    const socketPath = `/tmp/dscode-inspector-installed-${process.pid}-${Number(enabled)}.sock`
    assert.equal(existsSync(socketPath), false)
    let diagnostics = '', socket, inspectorHttp
    const leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode',
      '--patch', fileURLToPath(new URL('./inspector-test.patch.yml', import.meta.url))], {
      env: { ...process.env, DSH_HOME: profileHome, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1',
        DSCODE_INSPECTOR: enabled ? '1' : '0', DSCODE_INSPECTOR_UNSAFE_CAPTURE_FETCH: '0',
        DSCODE_NATIVE_DEEPSEEK_API_KEY: 'loopback-fixture-only', DSCODE_NATIVE_DEEPSEEK_BASE_URL: origin + '/anthropic' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    for (const stream of [leader.stdout, leader.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536) })
    try {
      for (let i = 0; !existsSync(socketPath); i++) {
        assert.ok(i < 100 && leader.exitCode === null, diagnostics || 'leader startup timeout')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      socket = net.createConnection(socketPath)
      const decoder = new FrameDecoder(), pending = new Map()
      let nextId = 0
      const send = message => socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', ...message }) }))
      socket.on('data', chunk => {
        for (const bytes of decoder.push(chunk)) {
          const frame = JSON.parse(Buffer.from(bytes).toString())
          if (frame.type !== 'acp') continue
          const message = JSON.parse(frame.payload)
          if (message.method === 'session/request_permission') failure ??= new Error('unexpected permission request: ' + message.params.toolCall.displayName)
          else if (!message.method) {
            const result = pending.get(message.id); pending.delete(message.id)
            if (message.error) result?.reject(new Error(JSON.stringify(message.error)))
            else result?.resolve(message.result)
          }
        }
      })
      const rpc = (method, params = {}) => new Promise((resolve, reject) => {
        const id = ++nextId
        const timer = setTimeout(() => { pending.delete(id); reject(new Error('ACP timeout: ' + method)) }, 35_000)
        pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(failure ?? error) } })
        send({ id, method, params })
      })
      await once(socket, 'connect')
      socket.write(encodeJsonFrame({ type: 'register', client_type: 'inspector-acceptance', mode: 'stdio', capabilities: {} }))
      await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
      const { sessionId } = await rpc('session/new', { cwd: workspace, mcpServers: [] })
      const models = await rpc('x.ai/models/list', { sessionId })
      const model = models.availableModels.find(model => model._meta?.provider === 'deepseek-official' && model.modelId.endsWith('deepseek-flash'))
      assert.ok(model)
      await rpc('session/set_model', { sessionId, modelId: model.modelId })
      const doctor = await rpc('x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.12' })
      assert.equal(doctor.text.includes('Developer Inspector'), enabled)
      if (enabled) {
        assert.match(doctor.text, /Fetch capture off/)
        inspectorHttp = 'http://' + doctor.text.match(/ws=(127\.0\.0\.1:\d+)\//)[1] + '/json/list'
        assert.equal((await fetch(inspectorHttp)).status, 200)
      }
      const before = turns
      const result = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'hello' }] })
      assert.equal(result.stopReason, 'end_turn')
      assert.equal(turns, before + 1)
      if (enabled) checks.push('mounted Inspector: doctor DevTools URL, fetch capture off, CDP endpoint, ordinary turn')
      else {
        assert.doesNotMatch(diagnostics, /dsh inspector:/)
        checks.push('installed but not mounted: no Inspector finding or endpoint, ordinary turn')
      }
      await rpc('session/close', { sessionId })
      assert.doesNotMatch(diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
      if (failure) throw failure
    } finally {
      socket?.destroy()
      if (leader.exitCode === null) {
        const closed = once(leader, 'close')
        leader.kill('SIGTERM')
        const timer = setTimeout(() => leader.kill('SIGKILL'), 5000)
        try { await closed } finally { clearTimeout(timer) }
      }
      if (inspectorHttp) {
        await assert.rejects(fetch(inspectorHttp))
        checks.push('leader exit closes the Inspector endpoint')
      }
    }
  }
  console.log(JSON.stringify({ node: process.version, passed: true, checks, workspace }))
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
