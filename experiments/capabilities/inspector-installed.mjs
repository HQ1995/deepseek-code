/** Installed dscode ACP + native Messages + Inspector: absent by default, mounted with DSCODE_INSPECTOR=1.
 * Usage: inspector-installed.mjs <runtime> <dsh-home with dscode and the packed ../inspector bundle> */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { startLeader, writeMessagesReply } from '../../scripts/acp-leader.mjs'

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
    writeMessagesReply(response, { id: 'msg-' + turns, model: body.model, text: 'Installed Inspector turn passed' })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
try {
  for (const enabled of [false, true]) {
    const socketPath = `/tmp/dscode-inspector-installed-${process.pid}-${Number(enabled)}.sock`
    assert.equal(existsSync(socketPath), false)
    let inspectorHttp
    const host = startLeader({ runtime, socketPath, patches: [fileURLToPath(new URL('./inspector-test.patch.yml', import.meta.url))],
      env: { ...process.env, DSH_HOME: profileHome, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1',
        DSCODE_INSPECTOR: enabled ? '1' : '0', DSCODE_INSPECTOR_UNSAFE_CAPTURE_FETCH: '0',
        DSCODE_NATIVE_DEEPSEEK_API_KEY: 'loopback-fixture-only', DSCODE_NATIVE_DEEPSEEK_BASE_URL: origin + '/anthropic' },
      clientType: 'inspector-acceptance', startupPolls: 100, failure: () => failure, rpcTimeoutMs: 35_000,
      onPermission: message => { failure ??= new Error('unexpected permission request: ' + message.params.toolCall.displayName) } })
    const { rpc } = host
    try {
      await host.ready
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
        assert.doesNotMatch(host.diagnostics, /dsh inspector:/)
        checks.push('installed but not mounted: no Inspector finding or endpoint, ordinary turn')
      }
      await rpc('session/close', { sessionId })
      assert.doesNotMatch(host.diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
      if (failure) throw failure
    } finally {
      await host.stop()
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
