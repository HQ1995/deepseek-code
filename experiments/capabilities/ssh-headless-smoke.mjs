/** Installed profile -> native Messages -> remote bash -> persisted headless result. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { readFile } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const [runtime, profileHome, configPath] = process.argv.slice(2)
const config = JSON.parse(await readFile(configPath, 'utf8'))
let calls = 0, failure
const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, '/anthropic/v1/messages')
    assert.equal(request.headers['x-api-key'], 'loopback-fixture-only')
    let bytes = ''
    for await (const chunk of request) bytes += chunk
    const body = JSON.parse(bytes)
    assert.equal(Object.hasOwn(body, 'dsh_session_log'), false)
    assert.equal(Object.hasOwn(body, 'dsh_plugin_packages'), false)
    assert.ok(++calls <= 2, 'unexpected retry or extra model invocation')
    const first = calls === 1
    if (first) assert.ok(body.tools.some(tool => tool.name === 'bash'), 'remote bash must be exposed')
    else {
      const result = body.messages.flatMap(message => message.content).find(block => block.type === 'tool_result')
      assert.ok(result, 'missing remote tool result')
      assert.notEqual(result.is_error, true, JSON.stringify(result))
      assert.ok(JSON.stringify(result).includes(config.workspace), JSON.stringify(result))
      assert.match(JSON.stringify(result), /Linux/)
    }
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const events = [
      { type: 'message_start', message: { id: 'msg-' + calls, model: body.model, usage: { input_tokens: 10, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: first ? { type: 'tool_use', id: 'ssh-pwd', name: 'bash', input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: first ? { type: 'input_json_delta', partial_json: JSON.stringify({ command: 'pwd; uname -s', description: 'Read isolated remote workspace identity', timeoutMs: 10_000 }) } : { type: 'text_delta', text: 'SSH installed profile passed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: first ? 'tool_use' : 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]
    for (const event of events) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { failure ??= error; response.destroy(error) })
})
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  const result = await promisify(execFile)(process.execPath, [join(runtime, 'bin/dsh'), '--profile', 'ssh',
    '--patch', fileURLToPath(new URL('../native-messages/cordis.patch.yml', import.meta.url)),
    '--patch', fileURLToPath(new URL('./ssh-headless-test.patch.yml', import.meta.url)),
    '--json', 'Read the working directory and operating system of this isolated SSH workspace.'], {
    env: { ...process.env, DSH_HOME: profileHome, DSH_TELEMETRY_DISABLED: '1', DSCODE_SSH_CONFIG: JSON.stringify(config),
      DSCODE_NATIVE_DEEPSEEK_API_KEY: 'loopback-fixture-only', DSCODE_NATIVE_DEEPSEEK_BASE_URL: `http://127.0.0.1:${server.address().port}/anthropic` },
    timeout: 60_000, maxBuffer: 10 * 1024 * 1024,
  }).catch(error => { throw failure ?? error })
  if (failure) throw failure
  assert.equal(calls, 2)
  assert.doesNotMatch(result.stderr, /failed to import|unresolved|duplicate service|did not activate/i)
  assert.match(result.stdout, /SSH installed profile passed/)
  console.log(JSON.stringify({ node: process.version, installedProfile: 'passed', nativeMessages: 'passed', remoteBash: 'passed', calls }))
} finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
