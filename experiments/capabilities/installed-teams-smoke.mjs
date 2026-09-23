/** Installed Teams composition, inspected at the real native Messages boundary. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const [runtime, profileHome] = process.argv.slice(2)
const socketPath = `/tmp/dscode-teams-acceptance-${process.pid}.sock`
let calls = 0, failure, leader, diagnostics = ''
const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, '/anthropic/v1/messages')
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes)
    assert.equal(++calls, 1, 'ordinary task must not create teammates or extra model turns')
    const names = body.tools.map(tool => tool.name)
    assert.equal(new Set(names).size, names.length, 'duplicate installed tool names')
    const teamTools = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
    assert.ok(teamTools.every(name => names.includes(name)), names.join(', '))
    assert.match(JSON.stringify(body.system), /create teammates only when the user explicitly asks to use Agent Teams or teammates/)
    assert.equal(Object.hasOwn(body, 'dsh_session_log'), false)
    assert.equal(Object.hasOwn(body, 'dsh_plugin_packages'), false)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-team', model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Teams installed profile passed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
try {
  assert.equal(existsSync(socketPath), false)
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  leader = spawn(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'dscode',
    '--patch', fileURLToPath(new URL('../native-messages/cordis.patch.yml', import.meta.url)),
    '--patch', fileURLToPath(new URL('./ssh-headless-test.patch.yml', import.meta.url))], {
    env: { ...process.env, DSH_HOME: profileHome, DSCODE_SOCKET: socketPath, DSH_TELEMETRY_DISABLED: '1',
      DSCODE_NATIVE_DEEPSEEK_API_KEY: 'loopback-fixture-only', DSCODE_NATIVE_DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic` },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  for (const stream of [leader.stdout, leader.stderr]) stream.on('data', bytes => { diagnostics = (diagnostics + bytes).slice(-65536) })
  for (let i = 0; !existsSync(socketPath); i++) {
    assert.ok(i < 100 && leader.exitCode === null, diagnostics || 'leader did not start')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const { stdout } = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('./installed-smoke.mjs', import.meta.url)), socketPath, '--prompt'], { timeout: 40_000 })
    .catch(error => { throw failure ?? error })
  if (failure) throw failure
  // The bundle disables every dscode preset row, so Teams is the only mode offered.
  const { presets } = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.deepEqual(presets.items.map(item => item.id), ['teams'])
  assert.equal(calls, 1)
  assert.doesNotMatch(diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  console.log(JSON.stringify({ node: process.version, installedTeams: 'passed', uniqueTeamTools: 9, onlyPreset: 'teams', nativeMessages: 'passed', delegationPrompt: 'passed' }))
} finally {
  if (leader && leader.exitCode === null) {
    const closed = once(leader, 'close')
    leader.kill('SIGTERM')
    const force = setTimeout(() => leader.kill('SIGKILL'), 5000)
    try { await closed } finally { clearTimeout(force) }
  }
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
