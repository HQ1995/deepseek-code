#!/usr/bin/env node
// Keyless acceptance for the native DeepSeek provider: add, list, remove, add,
// prompt, in-use refusal and persistence across a leader restart, through the
// installed bridge and the real plugin manager against a loopback Messages
// fixture. Usage: e2e-native-provider.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { startLeader, writeMessagesReply } from './acp-leader.mjs'

const [runtime, home] = process.argv.slice(2)
if (!runtime || !home) throw new Error('usage: e2e-native-provider.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>')
const KEY = 'native-provider-fixture-key'
const NATIVE = 'deepseek-official'
const requests = []
let failure

const server = createServer((request, response) => {
  void (async () => {
    let body = ''
    for await (const chunk of request) body += chunk
    if (request.method === 'GET' && request.url === '/v1/models') {
      // The pi-ai route that keeps another provider current.
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ data: [{ id: 'fixture-chat' }] }))
      return
    }
    requests.push({ url: request.url, key: request.headers['x-api-key'], body: JSON.parse(body || '{}') })
    assert.equal(request.url, '/anthropic/v1/messages')
    writeMessagesReply(response, { id: 'msg-native', model: 'fixture', text: 'native provider fixture reply', inputTokens: 5, outputTokens: 4 })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1')
await once(server, 'listening')
const baseURL = `http://127.0.0.1:${server.address().port}/anthropic`

async function withLeader(run) {
  const host = startLeader({ runtime, home, socketPath: `/tmp/dscode-native-provider-${process.pid}-${Date.now()}.sock`, clientType: 'native-provider-test' })
  try {
    await host.ready
    const session = await host.rpc('session/new', { cwd: home, mcpServers: [] })
    try { return await run(host.rpc, session.sessionId) } finally {
      await host.rpc('session/close', { sessionId: session.sessionId }).catch(() => {})
    }
  } catch (error) {
    throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`)
  } finally {
    await host.stop()
    assert.doesNotMatch(host.diagnostics, /did not activate|failed to import|duplicate service/i)
  }
}

const nativeModels = list => list.availableModels.filter(model => model._meta?.provider === NATIVE)
const prompt = async (rpc, sessionId, list) => {
  const model = nativeModels(list)[0]
  assert.ok(model, 'native DeepSeek models are listed')
  await rpc('session/set_model', { sessionId, modelId: model.modelId })
  const before = requests.length
  const completion = await rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: 'Reply briefly.' }] })
  assert.equal(completion.stopReason, 'end_turn')
  // The first turn also titles the session through the same route (no tools).
  const turn = requests.slice(before)
  assert.equal(turn.filter(request => (request.body.tools?.length ?? 0) > 0).length, 1, 'one agent turn request')
  assert.ok(turn.every(request => request.key === KEY), 'the pasted key reaches the adapter through the credentials service')
  return model
}

try {
  await withLeader(async (rpc, sessionId) => {
    const initial = await rpc('x.ai/models/list', { sessionId })
    assert.deepEqual(nativeModels(initial), [], 'the adapter starts disabled')
    // 0.1.7-rc.2 ships a default-on account route; dscode's patch keeps it off.
    assert.ok(!initial._meta.providers.some(provider => provider.id === 'deepseek-account'), 'no DeepSeek Account row in the roster')
    // Another route stays current, so the native one can be removed while unused.
    await rpc('x.ai/providers/add', { id: 'fixture', displayName: 'Fixture', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.address().port}/v1`, apiKeyEnv: 'FIXTURE_KEY', apiKey: 'fixture', credentialSource: 'saved' })
    const fixture = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(model => model._meta?.provider === 'fixture')
    assert.ok(fixture, 'the fixture route is listed')
    await rpc('session/set_model', { sessionId, modelId: fixture.modelId })
    const added = await rpc('x.ai/providers/add', { id: NATIVE, api: 'deepseek-native', apiKeyEnv: 'DEEPSEEK_API_KEY', apiKey: KEY, baseURL, credentialSource: 'saved' })
    assert.match(JSON.stringify(added), /deepseek-official/)
    assert.ok(nativeModels(await rpc('x.ai/models/list', { sessionId })).length > 0, 'enabling applies without a restart')
    await rpc('x.ai/providers/remove', { id: NATIVE })
    assert.deepEqual(nativeModels(await rpc('x.ai/models/list', { sessionId })), [], 'removal disables the adapter live')
    await rpc('x.ai/providers/add', { id: NATIVE, api: 'deepseek-native', apiKey: KEY, baseURL, credentialSource: 'saved' })
    await prompt(rpc, sessionId, await rpc('x.ai/models/list', { sessionId }))
    await assert.rejects(rpc('x.ai/providers/remove', { id: NATIVE }), /is in use/)
  })
  const patch = readFileSync(join(home, 'profiles/dscode/cordis.patch.yml'), 'utf8')
  assert.match(patch, /id: llm-deepseek[\s\S]*?disabled: false/, 'the enabled row is persisted in the profile patch')
  await withLeader(async (rpc, sessionId) => {
    await prompt(rpc, sessionId, await rpc('x.ai/models/list', { sessionId }))
  })
  if (failure) throw failure
  assert.ok(requests.every(request => request.url === '/anthropic/v1/messages'))
  console.log(JSON.stringify({ node: process.version, nativeProvider: 'passed', turns: requests.length, persisted: true }))
} finally {
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
}
