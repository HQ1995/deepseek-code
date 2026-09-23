/** Installed dscode ACP + native Messages + approval + Chromium + Inspector. */
import assert from 'node:assert/strict'
import net from 'node:net'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { encodeJsonFrame, FrameDecoder } from '../../bridge/grok-leader/src/codec.ts'

const [runtime, profileHome, executablePath] = process.argv.slice(2)
const workspace = await mkdtemp(join(tmpdir(), 'dscode-browser-installed-'))
const prefix = 'mcp__playwright-mcp__'
let phase = 'off', step = 0, failure, slowResponse, slowReady
const pageRequests = [], checks = []
const server = createServer((request, response) => {
  void (async () => {
    if (!request.url.startsWith('/anthropic/')) {
      pageRequests.push(request.url)
      if (request.url === '/slow') { slowResponse = response; slowReady.resolve(); return }
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end('<title>Installed browser</title><h1>Browser wire fixture</h1><p>Saved: <script>document.write(localStorage.getItem("marker") || "empty");localStorage.setItem("marker","set")</script></p>')
      return
    }
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (request.url === '/anthropic/v1/files') {
      const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData()
      const file = form.get('file')
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ id: 'file-browser-fixture', type: 'file', filename: file.name, mime_type: file.type, size_bytes: file.size, created_at: new Date().toISOString(), downloadable: false }))
      return
    }
    assert.equal(request.url, '/anthropic/v1/messages')
    assert.equal(request.headers['x-api-key'], 'loopback-fixture-only')
    const body = JSON.parse(bytes)
    const names = body.tools.map(tool => tool.name)
    assert.equal(names.some(name => name.startsWith(prefix)), phase !== 'off')
    assert.equal(new Set(names).size, names.length)
    let tool, args
    if (phase === 'off') assert.equal(step, 0)
    else if (step === 0) {
      tool = 'browser_navigate'
      args = { url: origin + (phase === 'cancel' ? '/slow' : phase === 'deny' ? '/denied' : '/fixture') }
    } else if (phase === 'normal' && step === 1) { tool = 'browser_take_screenshot'; args = {} }
    else if (phase === 'resume' && step === 1) { tool = 'browser_snapshot'; args = {} }
    else if (phase === 'resume') {
      const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
      assert.match(JSON.stringify(results.at(-1)), /Saved: empty/)
    }
    assert.ok(step++ < 4, 'unexpected model loop')
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-' + phase + step, model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: 'call-' + phase + step, name: prefix + tool, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text: 'Installed ' + phase + ' passed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
try {
  for (const enabled of [false, true]) {
    const socketPath = `/tmp/dscode-browser-installed-${process.pid}-${Number(enabled)}.sock`
    assert.equal(existsSync(socketPath), false)
    let diagnostics = '', socket, inspectorHttp
    const leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode',
      '--patch', fileURLToPath(new URL('../native-messages/cordis.patch.yml', import.meta.url)),
      '--patch', fileURLToPath(new URL('./browser-inspector-test.patch.yml', import.meta.url))], {
      env: { ...process.env, DSH_HOME: profileHome, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1',
        DSCODE_INSPECTOR: enabled ? '1' : '0', DSCODE_INSPECTOR_UNSAFE_CAPTURE_FETCH: '0',
        DSCODE_BROWSER: enabled ? '1' : '0', DSCODE_BROWSER_EXECUTABLE: executablePath, DSCODE_BROWSER_ORIGINS: JSON.stringify([origin]),
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
      const decoder = new FrameDecoder(), pending = new Map(), notes = []
      let nextId = 0, approve = true, approvals = 0
      const send = message => socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', ...message }) }))
      socket.on('data', chunk => {
        for (const bytes of decoder.push(chunk)) {
          const frame = JSON.parse(Buffer.from(bytes).toString())
          if (frame.type !== 'acp') continue
          const message = JSON.parse(frame.payload)
          if (message.method === 'session/request_permission') {
            assert.ok(message.params.toolCall.displayName.startsWith(prefix))
            approvals++
            send({ id: message.id, result: { outcome: { outcome: 'selected', optionId: approve ? 'allow-once' : 'reject-once' } } })
          } else if (message.method) notes.push(message)
          else {
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
      socket.write(encodeJsonFrame({ type: 'register', client_type: 'browser-acceptance', mode: 'stdio', capabilities: {} }))
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
      const prompt = label => { phase = label; step = 0; return rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: label }] }) }
      assert.equal((await prompt(enabled ? 'normal' : 'off')).stopReason, 'end_turn')
      if (enabled) {
        assert.equal(approvals, 2)
        const paths = notes.flatMap(note => note.params?.update?.rawOutput?.dscodeImages ?? [])
        assert.ok(paths.length > 0, 'screenshot must reach the pager image wire')
        assert.ok((await readFile(paths[0])).length > 100)
        checks.push('installed browser native approvals and durable screenshot wire')
        approve = false
        await prompt('deny')
        assert.equal(pageRequests.includes('/denied'), false)
        approve = true
        slowReady = Promise.withResolvers()
        const cancelled = prompt('cancel').then(result => ({ result }), error => ({ error }))
        const timeout = setTimeout(() => slowReady.reject(new Error('slow navigation did not start')), 10_000)
        try { await slowReady.promise } finally { clearTimeout(timeout) }
        send({ method: 'session/cancel', params: { sessionId } })
        const outcome = await cancelled
        assert.equal(outcome.result?.stopReason, 'cancelled', String(outcome.error))
        slowResponse.end('<script>fetch("/after-cancel")</script>')
        await new Promise(resolve => setTimeout(resolve, 400))
        assert.equal(pageRequests.includes('/after-cancel'), false)
        checks.push('installed permission rejection and ACP cancellation without late page effects')
        await rpc('session/close', { sessionId })
        await rpc('session/load', { sessionId, cwd: workspace, mcpServers: [] })
        assert.equal((await prompt('resume')).stopReason, 'end_turn')
        checks.push('persisted session resumes with fresh isolated browser storage')
      } else {
        assert.equal(approvals, 0)
        assert.doesNotMatch(diagnostics, /dsh inspector:/)
        checks.push('installed but disabled: no browser tools or Inspector endpoint')
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
      if (inspectorHttp) await assert.rejects(fetch(inspectorHttp))
    }
  }
  console.log(JSON.stringify({ node: process.version, passed: true, checks, workspace }))
} finally {
  slowResponse?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
