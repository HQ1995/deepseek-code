/** Keyless native Inspector test. Only an owned process and loopback fixture. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { releaseSdk } from '../../scripts/release-sdk.mjs'
import * as Inspector from './index.mjs'

const { sdk } = releaseSdk(process.argv[2], { modulesOf: fileURLToPath(new URL('.', import.meta.url)) })
const { Context } = await sdk('@deepseek-ai/cordis')
const originalFetch = globalThis.fetch
const server = createServer((request, response) => { request.resume(); response.end('inspector fixture response') })
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const fixtureUrl = `http://127.0.0.1:${server.address().port}/fixture`
const checks = []
try {
  for (const capture of [false, true]) {
    const ctx = new Context()
    let socket
    try {
      await ctx.plugin(Inspector, { unsafeCaptureFetch: capture })
      const status = ctx.get('dscodeInspector')
      assert.equal(status.captureFetch, capture)
      assert.equal(ctx.get('webServer'), undefined, 'TUI integration must not start a Web app')
      if (!capture) assert.equal(globalThis.fetch, originalFetch)
      const tree = await ctx.get('inspector').cordis.getTree()
      assert.ok(tree.host, JSON.stringify(tree))
      const [target] = await (await originalFetch(status.httpUrl + 'json/list')).json()
      assert.match(target.webSocketDebuggerUrl, /^ws:\/\/127\.0\.0\.1:\d+\//)
      socket = new WebSocket(target.webSocketDebuggerUrl)
      await once(socket, 'open')
      let id = 0
      const pending = new Map(), events = []
      socket.addEventListener('message', event => {
        const message = JSON.parse(event.data)
        if (message.id !== undefined) {
          const result = pending.get(message.id); pending.delete(message.id)
          if (message.error) result?.reject(new Error(JSON.stringify(message.error)))
          else result?.resolve(message.result)
        } else events.push(message)
      })
      const rpc = (method, params = {}) => new Promise((resolve, reject) => {
        const callId = ++id
        const timer = setTimeout(() => { pending.delete(callId); reject(new Error('CDP timeout: ' + method)) }, 5000)
        pending.set(callId, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(error) } })
        socket.send(JSON.stringify({ id: callId, method, params }))
      })
      await rpc('Runtime.enable')
      assert.equal((await rpc('Runtime.evaluate', { expression: '6 * 7', returnByValue: true })).result.value, 42)
      assert.ok((await rpc('DOM.getDocument')).root)
      await rpc('Network.enable')
      await (await fetch(fixtureUrl, { method: 'POST', headers: { authorization: 'Bearer inspector-fixture-only' }, body: 'fixture request body' })).text()
      const deadline = Date.now() + 2000
      while (capture && !events.some(event => event.method === 'Network.requestWillBeSent' && event.params.request.url === fixtureUrl) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
      const requests = events.filter(event => event.method === 'Network.requestWillBeSent' && event.params.request.url === fixtureUrl)
      assert.equal(requests.length, capture ? 1 : 0)
      if (capture) assert.match(JSON.stringify(requests[0]), /inspector-fixture-only/)
      const closed = once(socket, 'close')
      await ctx.fiber.dispose()
      await closed
      await assert.rejects(originalFetch(status.httpUrl + 'json/list'))
      assert.equal(ctx.get('dscodeInspector'), undefined)
      assert.equal(globalThis.fetch, originalFetch)
      checks.push(capture ? 'explicit raw capture + teardown restoration' : 'Host-only tree/CDP + no default fetch capture')
    } finally {
      socket?.close()
      await ctx.fiber.dispose()
    }
  }
  console.log(JSON.stringify({ node: process.version, checks, passed: true }))
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
