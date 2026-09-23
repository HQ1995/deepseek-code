import assert from 'node:assert/strict'
import net from 'node:net'
import { once } from 'node:events'
import { encodeJsonFrame, FrameDecoder } from '../../bridge/grok-leader/src/codec.ts'

const socket = net.createConnection(process.argv[2])
const decoder = new FrameDecoder()
const pending = new Map()
let nextId = 0
socket.on('data', chunk => {
  for (const bytes of decoder.push(chunk)) {
    const frame = JSON.parse(Buffer.from(bytes).toString())
    if (frame.type !== 'acp') continue
    const message = JSON.parse(frame.payload)
    if (message.id == null) continue
    const result = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) result?.reject(new Error(JSON.stringify(message.error)))
    else result?.resolve(message.result)
  }
})
const deadline = setTimeout(() => socket.destroy(new Error('ACP acceptance timeout')), 30_000)
socket.on('error', error => { for (const result of pending.values()) result.reject(error) })
function rpc(method, params = {}) {
  const id = ++nextId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', id, method, params }) }))
  })
}
try {
  await once(socket, 'connect')
  socket.write(encodeJsonFrame({ type: 'register', client_type: 'capability-test', mode: 'stdio', capabilities: {} }))
  const init = await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  assert.ok(init)
  const session = await rpc('session/new', { cwd: process.cwd(), mcpServers: [], _meta: { agentPreset: 'teams' } })
  assert.equal(typeof session.sessionId, 'string')
  const presets = await rpc('x.ai/presets', { sessionId: session.sessionId, action: 'list' })
  assert.match(JSON.stringify(presets), /teams/)
  const models = await rpc('x.ai/models/list', { sessionId: session.sessionId })
  assert.match(JSON.stringify(models), /deepseek-official/)
  const status = await rpc('x.ai/bundle/status', { sessionId: session.sessionId })
  if (process.argv[3] === '--prompt') {
    const model = models.availableModels.find(model => model._meta?.provider === 'deepseek-official')
    assert.ok(model)
    await rpc('session/set_model', { sessionId: session.sessionId, modelId: model.modelId })
    const completion = await rpc('session/prompt', { sessionId: session.sessionId, prompt: [{ type: 'text', text: 'Reply briefly. Do not create any teammates.' }] })
    assert.equal(completion.stopReason, 'end_turn')
  }
  console.log(JSON.stringify({ session: session.sessionId, presets, status, nativeMessagesRoute: 'visible' }))
  await rpc('session/close', { sessionId: session.sessionId })
} finally {
  clearTimeout(deadline)
  socket.destroy()
}
