#!/usr/bin/env node
/** Installed dscode over ACP: /browser on/off (reaching the running session
 * and its tool-change notices), native approval, real Chromium, screenshots,
 * rejection, cancellation and resume, against a loopback Messages fixture
 * through the native DeepSeek provider. Keyless.
 * Usage: e2e-browser-installed.mjs <extracted-runtime> <fresh-dsh-home-with-dscode> <chromium-executable|discover>
 * `discover` leaves the executable to dscode's discovery and requires it to succeed. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLeader, writeMessagesReply } from './acp-leader.mjs'

const [runtime, profileHome, executablePath] = process.argv.slice(2)
const discover = executablePath === 'discover'
if (!runtime || !profileHome || !(discover || executablePath?.startsWith('/'))) throw new Error('usage: e2e-browser-installed.mjs <runtime> <dsh-home> <absolute chromium|discover>')
const workspace = await mkdtemp(join(tmpdir(), 'dscode-browser-installed-'))
const prefix = 'mcp__playwright-mcp__'
const KEY = 'loopback-fixture-only'
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
    assert.equal(request.headers['x-api-key'], KEY)
    const body = JSON.parse(bytes)
    const names = body.tools.map(tool => tool.name)
    assert.equal(names.some(name => name.startsWith(prefix)), phase !== 'off', 'browser tools present only in browser phases: ' + phase)
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
    writeMessagesReply(response, { id: 'msg-' + phase + step, callId: 'call-' + phase + step, model: body.model, tool: tool && prefix + tool, args, text: 'Installed ' + phase + ' passed' })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
// Test-only overlay: no title request, native tool calls. Never a deployment policy.
const testPatch = join(workspace, 'browser-test.patch.yml')
await writeFile(testPatch, '- id: session-title-llm\n  disabled: true\n- id: tools\n  config:\n    mode: native\n')
let approve = true, approvals = 0
const host = startLeader({ runtime, home: profileHome, socketPath: `/tmp/dscode-browser-installed-${process.pid}.sock`, patches: [testPatch],
  clientType: 'browser-acceptance', failure: () => failure, rpcTimeoutMs: 45_000,
  onPermission: message => {
    assert.ok(message.params.toolCall.displayName.startsWith(prefix))
    approvals++
    return approve ? 'allow-once' : 'reject-once'
  } })
const { rpc, send, notes } = host
try {
  await host.ready
  const open = async () => {
    const { sessionId } = await rpc('session/new', { cwd: workspace, mcpServers: [] })
    const model = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(item => item._meta?.provider === 'deepseek-official')
    assert.ok(model, 'native DeepSeek model listed')
    await rpc('session/set_model', { sessionId, modelId: model.modelId })
    return sessionId
  }
  const prompt = (sessionId, label, text = label) => { phase = label; step = 0; return rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] }) }
  // A command's reply is its own `command_result` block.
  const command = async (sessionId, text) => {
    const before = notes.length
    await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
    return notes.slice(before).filter(note => note.params?.update?.sessionUpdate === 'command_result')
      .map(note => note.params.update.text ?? '').join('\n')
  }
  // DSH records a tool-list change in the conversation; the bridge shows it as a system notice.
  const toolNotices = id => notes.filter(note => /x\.ai\/session_notification$/.test(note.method) && note.params?.sessionId === id
    && note.params?.update?.sessionUpdate === 'image_dropped').flatMap(note => note.params.update.notes).filter(line => line.startsWith('Tools '))
  const bootstrap = await rpc('session/new', { cwd: workspace, mcpServers: [] })
  await rpc('x.ai/providers/add', { id: 'deepseek-official', api: 'deepseek-native', apiKey: KEY, baseURL: origin + '/anthropic', credentialSource: 'saved' })
  await rpc('session/close', { sessionId: bootstrap.sessionId })

  const first = await open()
  assert.match(await command(first, '/browser'), /Browser: off/)
  assert.equal((await prompt(first, 'off')).stopReason, 'end_turn')
  assert.equal(approvals, 0)
  checks.push('shipped disabled: no browser tools until /browser on')

  const on = await command(first, `/browser on ${discover ? '' : `--executable "${executablePath}" `}--origin ${origin}`)
  assert.match(on, /Browser turned on/)
  assert.match(on, new RegExp('allowed origins: ' + origin.replace(/[.:/]/g, '\\$&')))
  // The reply comes after the running session's browser started.
  assert.match(on, /Browser: on \(1 open\)/)
  assert.deepEqual(toolNotices(first), [])
  assert.equal((await prompt(first, 'running', 'use the browser now')).stopReason, 'end_turn')
  assert.equal(approvals, 1)
  assert.ok(pageRequests.includes('/fixture'), 'the running session navigated with its new browser')
  assert.equal(toolNotices(first).length, 1)
  // Canonical tool order, so the browser names may follow other newly added tools.
  assert.match(toolNotices(first)[0], /^Tools added: .*\bmcp__playwright-mcp__browser_\w+/)
  checks.push('/browser on reaches the running session: its next step calls a browser tool, with a tool-change notice')

  const sessionId = await open()
  const doctor = await rpc('x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.12' })
  // Two open: the running session's browser and this new one.
  assert.match(doctor.text, discover ? /\[OK\] Browser: on \(2 open\); executable: \/\S.* \(discovered\);/ : /\[OK\] Browser: on \(2 open\); executable: \//)
  assert.match(doctor.text, /sandbox: on/)
  assert.equal((await prompt(sessionId, 'normal')).stopReason, 'end_turn')
  assert.equal(approvals, 3)
  // A session that started with the browser has no tool change to announce.
  assert.deepEqual(toolNotices(sessionId), [])
  const paths = notes.flatMap(note => note.params?.update?.rawOutput?.dscodeImages ?? [])
  assert.ok(paths.length > 0, 'screenshot must reach the pager image wire')
  assert.ok((await readFile(paths[0])).length > 100)
  assert.equal(existsSync(join(workspace, '.playwright-mcp')), false, 'browser artifacts stay out of the workspace')
  checks.push('installed browser: native approvals, sandboxed launch, private artifacts and screenshot wire')

  approve = false
  await prompt(sessionId, 'deny')
  assert.equal(pageRequests.includes('/denied'), false)
  approve = true
  slowReady = Promise.withResolvers()
  const cancelled = prompt(sessionId, 'cancel').then(result => ({ result }), error => ({ error }))
  const timeout = setTimeout(() => slowReady.reject(new Error('slow navigation did not start')), 15_000)
  try { await slowReady.promise } finally { clearTimeout(timeout) }
  send({ method: 'session/cancel', params: { sessionId } })
  const outcome = await cancelled
  assert.equal(outcome.result?.stopReason, 'cancelled', String(outcome.error))
  slowResponse.end('<script>fetch("/after-cancel")</script>')
  await new Promise(resolve => setTimeout(resolve, 400))
  assert.equal(pageRequests.includes('/after-cancel'), false)
  checks.push('permission rejection and ACP cancellation without late page effects')
  await rpc('session/close', { sessionId })
  await rpc('session/load', { sessionId, cwd: workspace, mcpServers: [] })
  assert.equal((await prompt(sessionId, 'resume')).stopReason, 'end_turn')
  checks.push('persisted session resumes with fresh isolated browser storage')

  assert.match(await command(sessionId, '/browser off'), /Browser turned off/)
  const after = await open()
  assert.equal((await prompt(after, 'off', 'after off')).stopReason, 'end_turn')
  assert.doesNotMatch((await rpc('x.ai/doctor', { sessionId: after, tuiVersion: '0.0.14-alpha.12' })).text, /\] Browser:/)
  // The running session loses the tools at its next step, and says so.
  assert.equal((await prompt(first, 'off', 'running after off')).stopReason, 'end_turn')
  assert.equal(toolNotices(first).length, 2)
  assert.match(toolNotices(first)[1], /^Tools removed: .*\bmcp__playwright-mcp__browser_\w+/)
  checks.push('/browser off removes browser tools, from running sessions too, and the doctor finding')
  for (const id of [first, sessionId, after]) await rpc('session/close', { sessionId: id }).catch(() => {})
  assert.doesNotMatch(host.diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  if (failure) throw failure
  console.log(JSON.stringify({ node: process.version, passed: true, checks, workspace }))
} catch (error) {
  throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`, { cause: error })
} finally {
  await host.stop()
  slowResponse?.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
