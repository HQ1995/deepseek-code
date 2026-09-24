/** Fixtures shared by the installed-leader acceptance scripts: one `dsh
 * --profile dscode` leader driven as an ACP client over its Unix socket, and
 * the loopback Anthropic Messages reply their fixtures stream back. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import net from 'node:net'
import { join } from 'node:path'
import { encodeJsonFrame, FrameDecoder } from '../bridge/grok-leader/src/codec.ts'

/** This process's environment pointed at `home` and `socketPath`, keyless and without NODE_OPTIONS. */
function leaderEnv(home, socketPath) {
  const env = { ...process.env, DSH_HOME: home, HOME: home, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1' }
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS']) delete env[name]
  return env
}

/** Spawn the leader and connect to it. Returns at once, so a failed start
 * still leaves `diagnostics` and `stop` to the caller; `ready` resolves to the
 * `initialize` result. `onPermission(request)` returns the optionId to select,
 * or nothing to leave the request unanswered (the default). Other
 * notifications collect in `notes`. `failure()` returns the fixture error an
 * ACP error response is reported as, when there is one. */
export function startLeader({ runtime, home, socketPath, patches = [], env = leaderEnv(home, socketPath), clientType,
  onPermission, failure, rpcTimeoutMs, startupPolls = 150, killAfterMs = 5000 }) {
  const leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode', ...patches.flatMap(patch => ['--patch', patch])],
    { env, stdio: ['ignore', 'pipe', 'pipe'] })
  let diagnostics = '', socket, nextId = 0
  for (const stream of [leader.stdout, leader.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536) })
  const pending = new Map(), notes = []
  const send = message => socket.write(encodeJsonFrame({ type: 'acp', payload: JSON.stringify({ jsonrpc: '2.0', ...message }) }))
  const rpc = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = rpcTimeoutMs && setTimeout(() => { pending.delete(id); reject(new Error('ACP timeout: ' + method)) }, rpcTimeoutMs)
    pending.set(id, { resolve: result => { clearTimeout(timer); resolve(result) }, reject: error => { clearTimeout(timer); reject(failure?.() ?? error) } })
    send({ id, method, params })
  })
  const ready = (async () => {
    for (let i = 0; !existsSync(socketPath); i++) {
      assert.ok(i < startupPolls && leader.exitCode === null, diagnostics || 'leader startup timeout')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
    socket = net.createConnection(socketPath)
    const decoder = new FrameDecoder()
    socket.on('data', chunk => {
      for (const bytes of decoder.push(chunk)) {
        const frame = JSON.parse(Buffer.from(bytes).toString())
        if (frame.type !== 'acp') continue
        const message = JSON.parse(frame.payload)
        if (message.method === 'session/request_permission') {
          const optionId = onPermission?.(message)
          if (optionId) send({ id: message.id, result: { outcome: { outcome: 'selected', optionId } } })
        } else if (message.method) notes.push(message)
        else {
          const result = pending.get(message.id); pending.delete(message.id)
          if (message.error) result?.reject(new Error(JSON.stringify(message.error)))
          else result?.resolve(message.result)
        }
      }
    })
    await once(socket, 'connect')
    socket.write(encodeJsonFrame({ type: 'register', client_type: clientType, mode: 'stdio', capabilities: {} }))
    return await rpc('initialize', { protocolVersion: 1, clientCapabilities: {} })
  })()
  /** SIGTERM, then SIGKILL after `killAfterMs` (never when it is Infinity). */
  const stop = async () => {
    socket?.destroy()
    if (leader.exitCode !== null) return
    const closed = once(leader, 'close')
    leader.kill('SIGTERM')
    const timer = Number.isFinite(killAfterMs) ? setTimeout(() => leader.kill('SIGKILL'), killAfterMs) : undefined
    try { await closed } finally { clearTimeout(timer) }
  }
  return { leader, ready, rpc, send, notes, get diagnostics() { return diagnostics }, stop }
}

/** Stream one Messages reply: a `tool` call with `args` when set, else `text`. */
export function writeMessagesReply(response, { id, callId, model, tool, args, text, inputTokens = 10, outputTokens = 5 }) {
  response.writeHead(200, { 'content-type': 'text/event-stream' })
  for (const event of [
    { type: 'message_start', message: { id, model, usage: { input_tokens: inputTokens, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: tool ? { type: 'tool_use', id: callId, name: tool, input: {} } : { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: tool ? 'tool_use' : 'end_turn' }, usage: { output_tokens: outputTokens } },
    { type: 'message_stop' },
  ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
  response.end()
}
