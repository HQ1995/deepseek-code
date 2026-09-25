#!/usr/bin/env node
// Keyless acceptance for the generic remote channel on an installed leader over
// ACP: `x.ai/remote/invoke` reaches DSH's real
// sessionReferenceResolver/candidates through the in-process Typert gateway for
// an owned session, an unlisted endpoint (pluginManager/listPlugins) and a
// client-supplied identity are refused, another client cannot bind this
// client's session, and the retired x.ai/session/references route is gone.
// Usage: e2e-typert-remote.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>
import assert from 'node:assert/strict'
import { once } from 'node:events'
import net from 'node:net'
import { encodeJsonFrame, FrameDecoder } from '../bridge/grok-leader/src/codec.ts'
import { startLeader } from './acp-leader.mjs'

const [runtime, home] = process.argv.slice(2)
if (!runtime || !home) throw new Error('usage: e2e-typert-remote.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>')
const checks = [], samples = {}
const REFERENCES = 'sessionReferenceResolver/candidates'
// The TUI's wire form: an ACP extension request, whose top-level `method` param
// the leader would read as the wrapped method name (hence one `endpoint` field).
const INVOKE = '_x.ai/remote/invoke'

/** A second ACP client on the same leader socket; `request` answers the whole JSON-RPC reply. */
async function connect(socketPath, clientType) {
  const socket = net.createConnection(socketPath)
  await once(socket, 'connect')
  const decoder = new FrameDecoder(), pending = new Map()
  let nextId = 0
  socket.on('data', chunk => {
    for (const bytes of decoder.push(chunk)) {
      const frame = JSON.parse(Buffer.from(bytes).toString())
      if (frame.type !== 'acp') continue
      const message = JSON.parse(frame.payload)
      if (message.method === undefined && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id) }
    }
  })
  socket.write(encodeJsonFrame({ type: 'register', client_type: clientType, mode: 'stdio', capabilities: {} }))
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId, timer = setTimeout(() => { pending.delete(id); reject(new Error('ACP timeout: ' + method)) }, 60_000)
    pending.set(id, message => { clearTimeout(timer); resolve(message) })
    socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }))
  })
  return { request, close: () => socket.destroy() }
}

const socketPath = `/tmp/dscode-remote-${process.pid}-${Date.now()}.sock`
const host = startLeader({ runtime, home, socketPath, clientType: 'remote-acceptance', rpcTimeoutMs: 60_000 })
let other
try {
  const initialize = await host.ready
  assert.equal(initialize._meta?.dscodeRemote, 1, 'initialize advertises the remote channel')
  checks.push('initialize advertises dscodeRemote: 1')

  // A titled, closed session for the resolver to find.
  const title = `Remote channel source ${process.pid}`
  const source = (await host.rpc('session/new', { cwd: home, mcpServers: [] })).sessionId
  await host.rpc('x.ai/session/rename', { sessionId: source, title })
  await host.rpc('session/close', { sessionId: source })
  const sessionId = (await host.rpc('session/new', { cwd: home, mcpServers: [] })).sessionId
  const invoke = (args, endpoint = REFERENCES, id = sessionId) => host.rpc(INVOKE, { sessionId: id, endpoint, args })

  let found
  for (const deadline = Date.now() + 15_000; ;) {
    const result = await invoke({ query: source })
    assert.equal(result.ok, true, 'candidates answer ok: ' + JSON.stringify(result))
    found = result.value.find(candidate => candidate.sessionId === source)
    if (found !== undefined) { samples.candidates = result; break }
    assert.ok(Date.now() < deadline, 'the closed source session never became a candidate: ' + JSON.stringify(result))
    await new Promise(resolve => setTimeout(resolve, 250))
  }
  // DSH's canonical mention: the session id as base64url JSON.
  const token = found.mention.match(/^@\[.+\]\(dsh-session:([\w-]+)\)$/)?.[1]
  assert.equal(token === undefined ? undefined : JSON.parse(Buffer.from(token, 'base64url').toString()), source, found.mention)
  assert.equal(found.cwd, home)
  const all = await invoke({ query: '' })
  assert.equal(all.ok, true)
  assert.ok(all.value.some(candidate => candidate.sessionId === source))
  assert.ok(!all.value.some(candidate => candidate.sessionId === sessionId), 'a session never references itself')
  checks.push('sessionReferenceResolver/candidates answers {ok: true, value} through the gateway, with the source session and without self')

  const gatewayError = await invoke({ query: source, extra: 1 })
  assert.equal(gatewayError.ok, false)
  assert.equal(gatewayError.error.code, 'gateway/arguments-invalid')
  samples.gatewayError = gatewayError
  checks.push('the gateway validates the exact wire fields and answers its code in the result')

  const refusal = async (promise, pattern) => {
    const error = await promise.then(() => undefined, failure => JSON.parse(failure.message))
    assert.ok(error !== undefined, 'the call was not refused')
    assert.equal(error.code, -32602)
    assert.match(error.message, pattern)
    return error
  }
  samples.unlisted = await refusal(invoke({}, 'pluginManager/listPlugins'), /^remote endpoint is not allowed: pluginManager\/listPlugins$/)
  checks.push('pluginManager/listPlugins is refused: not allowlisted')
  samples.identity = await refusal(invoke({ query: '', agentId: source }), /agentId is bound by the bridge/)
  checks.push('a client-supplied agentId is refused')

  other = await connect(socketPath, 'remote-acceptance-foreign')
  const foreign = await other.request(INVOKE, { sessionId, endpoint: REFERENCES, args: { query: '' } })
  assert.equal(foreign.error?.code, -32602)
  assert.equal(foreign.error?.message, 'unknown session: ' + sessionId)
  const own = (await other.request('session/new', { cwd: home, mcpServers: [] })).result.sessionId
  const injected = await other.request(INVOKE, { sessionId: own, endpoint: REFERENCES, args: { query: '', agentId: sessionId } })
  assert.equal(injected.error?.code, -32602)
  samples.foreign = foreign.error
  checks.push("another client cannot bind this client's session, by sessionId or by agentId")

  const retired = await other.request('x.ai/session/references', { sessionId: own, query: '' })
  assert.equal(retired.error?.code, -32601)
  checks.push('x.ai/session/references is gone')
} catch (error) {
  throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`)
} finally {
  other?.close()
  await host.stop()
}
console.log(JSON.stringify({ node: process.version, remote: 'passed', checks, samples }, null, 2))
