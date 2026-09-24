#!/usr/bin/env node
/** Installed dscode remote profile over ACP: one SSH workspace, driven by a
 * loopback Messages fixture through the native DeepSeek provider. Keyless.
 * Needs an approved POSIX host with the matching helper, Node and PTC bootstrap
 * installed (see `dscode remote init`), and a fresh DSH_HOME holding dscode.
 * Usage: e2e-remote-installed.mjs <extracted-runtime> <fresh-dsh-home> <config.json>
 * where config.json has host, workspace, node, helper, helperHash, bootstrapPath
 * and bootstrapHash. The run creates and removes one file in the workspace. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tmpdir } from 'node:os'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join, posix } from 'node:path'
import { startLeader, writeMessagesReply } from './acp-leader.mjs'

const [runtime, home, configPath] = process.argv.slice(2)
if (!runtime || !home || !configPath) throw new Error('usage: e2e-remote-installed.mjs <runtime> <dsh-home> <config.json>')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const execute = promisify(execFile)
const remote = async command => (await execute('ssh', ['-o', 'BatchMode=yes', config.host, command], { timeout: 20_000 })).stdout
// The workspace as the host resolves it: init stores that path, and remote tools report it.
const workspace = (await remote(`cd ${JSON.stringify(config.workspace)} && pwd -P`)).trim()
const KEY = 'loopback-fixture-only'
const canary = 'dscode-remote-canary-' + randomUUID() + '.txt'
const local = await mkdtemp(join(tmpdir(), 'dscode-remote-local-'))
const checks = []
let phase, step = 0, failure

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, '/anthropic/v1/messages')
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
    let tool, args
    if (phase === 'shell' && step === 0) { tool = 'bash'; args = { command: 'pwd; uname -s', description: 'Show the remote workspace' } }
    else if (phase === 'shell' && step === 1) assert.match(JSON.stringify(results.at(-1)), new RegExp(workspace.replace(/[/.]/g, '\\$&') + '[\\s\\S]*Linux'))
    else if (phase === 'write' && step === 0) { tool = 'write'; args = { file_path: posix.join(workspace, canary), content: 'REMOTE_CANARY' } }
    else if (phase === 'write' && step === 1) assert.doesNotMatch(JSON.stringify(results.at(-1)), /"is_error":true/)
    assert.ok(step++ < 3, 'unexpected model loop')
    writeMessagesReply(response, { id: 'msg-' + phase + step, callId: 'call-' + phase + step, model: body.model, tool, args, text: 'Remote fixture reply' })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`

// The installed launcher writes the profile rows, exactly as a user would run it.
const launcher = join(home, 'profiles/dscode/node_modules/@hqzhao95/dscode/bin/dscode.mjs')
const flags = ['--host', config.host, '--workspace', config.workspace, '--node', config.node, '--helper', config.helper,
  '--helper-hash', config.helperHash, '--bootstrap', config.bootstrapPath, '--bootstrap-hash', config.bootstrapHash]
await execute(process.execPath, [launcher, 'remote', 'init', ...flags], { env: { ...process.env, DSH_HOME: home } })
// Test-only overlay: no title request, native tool calls, and no approval prompts for the fixture's two calls.
const testPatch = join(local, 'remote-test.patch.yml')
await writeFile(testPatch, '- id: session-title-llm\n  disabled: true\n- id: tools\n  config:\n    mode: native\n')
const host = startLeader({ runtime, home, socketPath: `/tmp/dscode-remote-installed-${process.pid}.sock`, patches: [testPatch], clientType: 'remote-acceptance',
  onPermission: () => 'allow-once', failure: () => failure, rpcTimeoutMs: 60_000, startupPolls: 300, killAfterMs: 8000 })
const { rpc } = host
try {
  const init = await host.ready
  assert.deepEqual(init._meta.dscodeExecutionWorld, { kind: 'ssh', host: config.host, workspace })
  checks.push('initialize advertises the SSH world')

  await assert.rejects(rpc('session/new', { cwd: local, mcpServers: [] }), /remote workspace/)
  await assert.rejects(rpc('session/new', { cwd: workspace, mcpServers: [{ name: 'local', command: '/usr/bin/true', args: [], env: [] }] }), /Local stdio MCP servers/)
  const { sessionId } = await rpc('session/new', { cwd: workspace, mcpServers: [] })
  await rpc('x.ai/providers/add', { id: 'deepseek-official', api: 'deepseek-native', apiKey: KEY, baseURL: origin + '/anthropic', credentialSource: 'saved' })
  const model = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(item => item._meta?.provider === 'deepseek-official')
  await rpc('session/set_model', { sessionId, modelId: model.modelId })
  checks.push('host cwd and host stdio MCP refused; the session opens in the remote workspace')

  const prompt = label => { phase = label; step = 0; return rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: label }] }) }
  assert.equal((await prompt('shell')).stopReason, 'end_turn')
  checks.push('bash runs on the remote host in the workspace (Linux)')

  // The write lands on the remote host; nothing appears at that path here.
  const localTwin = join(workspace, canary)
  assert.equal((await prompt('write')).stopReason, 'end_turn')
  assert.equal((await remote(`cat ${JSON.stringify(localTwin)}`)).trim(), 'REMOTE_CANARY')
  assert.equal(existsSync(localTwin), false, 'the write must not land on this computer')
  checks.push('file writes land on the remote host only')

  const doctor = (await rpc('x.ai/doctor', { sessionId, tuiVersion: '0.0.14-alpha.12' })).text
  assert.match(doctor, new RegExp(`\\[INFO\\] Remote workspace: ssh ${config.host}:${workspace.replace(/[/.]/g, '\\$&')}; helper sha256 ${config.helperHash}`))
  const archive = 'remote-export-' + process.pid + '.zip'
  await rpc('x.ai/session/export', { sessionId, prompt: [{ type: 'text', text: archive }] })
  assert.ok(existsSync(join(home, archive)), 'relative export lands under the home directory on this computer')
  checks.push('doctor names the remote workspace; exports stay on this computer')
  assert.doesNotMatch(host.diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  if (failure) throw failure
  await rpc('session/close', { sessionId })
  console.log(JSON.stringify({ node: process.version, passed: true, checks, host: config.host }))
} catch (error) {
  throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`, { cause: error })
} finally {
  await host.stop()
  await remote(`rm -f ${JSON.stringify(join(workspace, canary))}`).catch(() => {})
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(local, { recursive: true, force: true })
}
