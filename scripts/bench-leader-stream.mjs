#!/usr/bin/env node
// Streaming throughput of one real leader: an installed bridge in a fresh
// profile, driven over its socket as an ACP client, against a loopback
// OpenAI-compatible gateway that streams each reply as many small deltas, the
// way a real model does. Reports the leader's own CPU time for the prompt
// phase (boot and session setup excluded), per-turn wall time, and the wire
// notifications the client received, by kind and size.
//
// Usage: node scripts/bench-leader-stream.mjs <extracted-runtime> <dscode-plugin.tgz>
//   [--turns=12] [--deltas=1500] [--reasoning=300] [--chunk=4] [--tools=0] [--load]
//   [--prof=DIR] [--home=DIR]
// --tools=K makes every turn read a 200-line workspace file K times before its
// reply, so tool cards and their presenter views are projected. --load then
// closes the session and loads it again, timing the replay of that history.
// --prof writes the leader's --cpu-prof profile to DIR (summarize with
// summarize-cpu-prof.mjs). Wall times on a shared host are noisy; compare CPU
// across interleaved runs of the two builds instead.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { startLeader } from './acp-leader.mjs'

const { positionals, values } = parseArgs({ allowPositionals: true, options: {
  turns: { type: 'string', default: '12' }, deltas: { type: 'string', default: '1500' },
  reasoning: { type: 'string', default: '300' }, chunk: { type: 'string', default: '4' },
  tools: { type: 'string', default: '0' }, load: { type: 'boolean', default: false },
  prof: { type: 'string' }, home: { type: 'string' },
} })
const [runtimeArg, pluginArg] = positionals
if (!runtimeArg || !pluginArg) throw new Error('usage: bench-leader-stream.mjs <extracted-runtime> <dscode-plugin.tgz> [--turns=N] [--deltas=N] [--reasoning=N] [--chunk=N] [--prof=DIR]')
const runtime = resolve(runtimeArg), plugin = resolve(pluginArg)
const TURNS = Number(values.turns), DELTAS = Number(values.deltas), REASONING = Number(values.reasoning), CHUNK = Number(values.chunk)
const TOOLS = Number(values.tools)
const MODEL = 'bench-model'

// Fresh profile with the bridge installed exactly as a user install does.
const home = values.home ? resolve(values.home) : mkdtempSync(join(tmpdir(), 'dscode-bench-stream-'))
execFileSync(process.execPath, [join(runtime, 'bin/dsh'), 'plugin', '--profile', 'dscode', 'add', 'file:' + plugin],
  { env: { ...process.env, DSH_HOME: home, HOME: home, NODE_OPTIONS: '' }, stdio: ['ignore', 'ignore', 'pipe'] })

// Distinct files, so DSH's repeated-call reminder never joins the conversation.
const fixtureFiles = Array.from({ length: Math.max(TOOLS, 1) }, (_, index) => join(home, `bench-fixture-${index}.ts`))
for (const [index, file] of fixtureFiles.entries()) {
  writeFileSync(file, Array.from({ length: 200 }, (_, line) => `export const value${index}_${line} = ${line} // bench fixture line`).join('\n') + '\n')
}
const piece = 'abcdefghijklmnopqrstuvwxyz'.slice(0, CHUNK)
const envelope = delta => JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', created: 1, model: MODEL,
  choices: [{ index: 0, delta, finish_reason: null }] })
let modelRequests = 0
const server = createServer((request, response) => {
  void (async () => {
    let body = ''
    for await (const part of request) body += part
    if (request.method === 'GET' && request.url === '/v1/models') {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: MODEL }] }))
      return
    }
    assert.equal(request.url, '/v1/chat/completions')
    const title = body.includes('Create a concise title')
    if (!title) modelRequests++
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' })
    const lines = []
    // Tool results since this bench's own prompt decide the next step.
    const messages = title ? [] : JSON.parse(body).messages
    const prompt = messages.findLastIndex(message => message.role === 'user' && /bench turn|warm up/.test(JSON.stringify(message.content)))
    const results = messages.slice(prompt + 1).filter(message => message.role === 'tool').length
    if (!title && results < TOOLS) {
      const args = JSON.stringify({ file_path: fixtureFiles[results] })
      lines.push(envelope({ role: 'assistant', content: null, tool_calls: [{ index: 0, id: `call-${modelRequests}`, type: 'function', function: { name: 'read', arguments: '' } }] }))
      for (let i = 0; i < args.length; i += 16) lines.push(envelope({ tool_calls: [{ index: 0, function: { arguments: args.slice(i, i + 16) } }] }))
      lines.push(JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', created: 1, model: MODEL,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 2400, completion_tokens: 20 } }))
      response.write(lines.map(line => 'data: ' + line + '\n\n').join(''))
      response.end('data: [DONE]\n\n')
      return
    }
    if (!title) for (let i = 0; i < REASONING; i++) lines.push(envelope({ role: 'assistant', reasoning_content: piece }))
    const text = title ? 1 : DELTAS
    for (let i = 0; i < text; i++) lines.push(envelope({ role: 'assistant', content: title ? 'Bench session' : piece + (i % 16 === 15 ? '\n' : ' ') }))
    lines.push(JSON.stringify({ id: 'bench', object: 'chat.completion.chunk', created: 1, model: MODEL,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 2400, completion_tokens: text + REASONING } }))
    // Several deltas per socket write, a tick apart, as a provider's stream arrives.
    for (let i = 0; i < lines.length; i += 8) {
      response.write(lines.slice(i, i + 8).map(line => 'data: ' + line + '\n\n').join(''))
      await new Promise(done => setImmediate(done))
    }
    response.end('data: [DONE]\n\n')
  })().catch(error => response.destroy(error))
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const baseURL = `http://127.0.0.1:${server.address().port}/v1`

const socketPath = join(tmpdir(), `dscode-bench-stream-${process.pid}.sock`)
const env = { ...process.env, DSH_HOME: home, HOME: home, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1', NODE_OPTIONS: '' }
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL']) delete env[name]
if (values.prof) env.NODE_OPTIONS = `--cpu-prof --cpu-prof-dir=${resolve(values.prof)}`
const host = startLeader({ runtime, home, socketPath, env, clientType: 'bench-stream', rpcTimeoutMs: 600_000, killAfterMs: 30_000,
  onPermission: request => request.params.options.find(option => String(option.kind).startsWith('allow'))?.optionId })
const cpuMs = () => {
  const fields = readFileSync(`/proc/${host.leader.pid}/stat`, 'utf8').split(') ')[1].split(' ')
  return (Number(fields[11]) + Number(fields[12])) * 10 // utime + stime, clock ticks of 10ms
}
try {
  await host.ready
  await host.rpc('x.ai/providers/add', { id: 'bench', displayName: 'Bench', api: 'openai-completions', baseURL,
    apiKeyEnv: 'BENCH_KEY', apiKey: 'bench-key', credentialSource: 'saved' })
  const models = await host.rpc('x.ai/models/list', {})
  const model = models.availableModels.find(entry => entry._meta?.provider === 'bench')
  assert.ok(model, 'the bench route is listed')
  const { sessionId } = await host.rpc('session/new', { cwd: home, mcpServers: [] })
  await host.rpc('session/set_model', { sessionId, modelId: model.modelId })
  // One untimed turn warms the model route, the title request and the JIT.
  await host.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'warm up' }] })
  await new Promise(done => setTimeout(done, 500))
  host.notes.length = 0
  const cpuBefore = cpuMs(), walls = []
  for (let turn = 0; turn < TURNS; turn++) {
    const started = performance.now()
    const settled = await host.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: `bench turn ${turn}` }] })
    assert.equal(settled.stopReason, 'end_turn')
    walls.push(performance.now() - started)
  }
  const cpu = cpuMs() - cpuBefore
  const notes = host.notes.slice()
  const kinds = {}
  let bytes = 0
  for (const note of notes) {
    const kind = note.params?.update?.sessionUpdate ?? note.method
    kinds[kind] = (kinds[kind] ?? 0) + 1
    bytes += JSON.stringify(note).length
  }
  const text = kinds.agent_message_chunk ?? 0
  assert.ok(text >= TURNS * DELTAS, `every text delta reached the client (${text} < ${TURNS * DELTAS})`)
  assert.ok((kinds.tool_call ?? 0) >= TURNS * TOOLS, `every tool call reached the client (${kinds.tool_call ?? 0} < ${TURNS * TOOLS})`)
  walls.sort((a, b) => a - b)
  let load
  if (values.load) {
    await host.rpc('session/close', { sessionId })
    await new Promise(done => setTimeout(done, 500))
    host.notes.length = 0
    const loadCpu = cpuMs(), started = performance.now()
    await host.rpc('session/load', { sessionId, cwd: home, mcpServers: [] })
    load = { wallMs: +(performance.now() - started).toFixed(1), leaderCpuMs: cpuMs() - loadCpu, replayed: host.notes.length }
  }
  console.log(JSON.stringify({
    plugin, turns: TURNS, deltasPerTurn: DELTAS, reasoningPerTurn: REASONING, modelRequests,
    leaderCpuMs: cpu, cpuUsPerNotification: +(cpu * 1000 / notes.length).toFixed(1),
    wallMs: { median: +walls[Math.floor(walls.length / 2)].toFixed(1), p90: +walls[Math.floor(walls.length * 0.9)].toFixed(1) },
    notifications: notes.length, wireBytes: bytes, bytesPerNotification: Math.round(bytes / notes.length), kinds,
    ...load === undefined ? {} : { load },
  }))
} finally {
  await host.stop()
  server.closeAllConnections()
  server.close()
  if (!values.home) rmSync(home, { recursive: true, force: true })
}
