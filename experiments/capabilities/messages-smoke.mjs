/** Keyless native Messages + Files/offload exercise against a loopback gateway. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseSdk } from '../../scripts/release-sdk.mjs'

const { sdk, mount } = releaseSdk(process.argv[2])
const { Context } = await sdk('@deepseek-ai/cordis')
const { createUserMessage } = await sdk('@deepseek-ai/dsh-llm')
const { admitEncodedImages } = await sdk('@deepseek-ai/dsh-attachment')
const root = await mkdtemp(join(tmpdir(), 'dscode-messages-'))
const priorHome = process.env.DSH_HOME
const priorKey = process.env.DSCODE_NATIVE_DEEPSEEK_API_KEY
process.env.DSH_HOME = root
process.env.DSCODE_NATIVE_DEEPSEEK_API_KEY = 'loopback-fixture-only'
const requests = []
let files = 0, rejectFiles = false
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const bytes = Buffer.concat(chunks)
    if (request.url === '/anthropic/v1/files') {
      files++
      const form = await new Response(bytes, { headers: { 'content-type': request.headers['content-type'] } }).formData()
      const file = form.get('file')
      response.writeHead(rejectFiles ? 503 : 200, { 'content-type': 'application/json' })
      response.end(JSON.stringify(rejectFiles ? { error: { message: 'fixture unavailable' } } : {
        id: 'file-fixture-' + files, type: 'file', filename: file.name, mime_type: file.type, size_bytes: file.size, created_at: new Date().toISOString(), downloadable: false,
      }))
      return
    }
    assert.equal(request.url, '/anthropic/v1/messages')
    assert.equal(request.headers['x-api-key'], 'loopback-fixture-only')
    const body = JSON.parse(bytes.toString())
    requests.push(body)
    assert.equal(Object.hasOwn(body, 'dsh_session_log'), false)
    assert.equal(Object.hasOwn(body, 'dsh_plugin_packages'), false)
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    for (const event of [
      { type: 'message_start', message: { id: 'msg-fixture', model: body.model, usage: { input_tokens: 12, output_tokens: 1 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'native messages passed' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } },
      { type: 'message_stop' },
    ]) response.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    response.end()
  })().catch(error => { response.destroy(error); console.error(error); process.exitCode = 1 })
})
const ctx = new Context()
const handles = []
try {
  server.listen(0, '127.0.0.1'); await once(server, 'listening')
  for (const name of ['system-prompt', 'tools', 'llm', 'session', 'agent', 'session-projection']) await mount(ctx, name)
  await mount(ctx, 'session-persistence-jsonl', { root: join(root, 'sessions') })
  await mount(ctx, 'attachment-local', { dshHome: root })
  await mount(ctx, 'deepseek-llm-api-extensions')
  await mount(ctx, 'session-log-deepseek', { enabled: false })
  await mount(ctx, 'plugin-package-inventory-deepseek', { enabled: false })
  await mount(ctx, 'compaction-image-offload')
  await mount(ctx, 'llm-deepseek', { apiKeyEnv: 'DSCODE_NATIVE_DEEPSEEK_API_KEY',
    baseURL: `http://127.0.0.1:${server.address().port}/anthropic`, maxImagesPerRequest: 1, imageOffloadCountQuantum: 1, filesApiTimeoutMs: 1000 })
  await mount(ctx, 'agent-loop', { agents: [] })
  let owner = await ctx.agents.create({ sessionId: 'native-images', meta: { cwd: root },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  handles.push(owner)
  const sharp = (await sdk('sharp')).default
  const png = (await sharp({ create: { width: 4, height: 4, channels: 3, background: '#ff0000' } }).png().toBuffer()).toString('base64')
  const [image] = await admitEncodedImages(ctx.attachments, [{ data: png, mediaType: 'image/png' }])
  const send = async (images = []) => {
    owner.agent.followup(createUserMessage({ source: { kind: 'user' }, content: [{ type: 'text', text: 'describe' }, ...images.map(attachment => ({ type: 'image', attachment }))] }))
    await owner.agent.whenIdle()
    assert.equal(owner.agent.session.snapshotEvents().at(-1).data.reason.kind, 'completed')
  }
  await send([image]); await send()
  assert.equal(files, 1, 'Files id should be reused for the same retained image')
  assert.match(JSON.stringify(requests[0]), /file-fixture-1/)
  await send([image])
  const offloads = owner.agent.session.snapshotEvents().filter(event => event.type === 'image/offload')
  assert.equal(offloads.length, 1)
  assert.equal(offloads[0].data.targets[0].imageIndexes.length, 1)
  assert.equal(files, 1, 'new occurrence may reuse bytes while older occurrence is durably offloaded')
  assert.match(JSON.stringify(requests.at(-1)), /offload|omitted/i)
  await ctx.sessions.flush(owner.agent.session)
  await handles.pop().dispose()
  owner = await ctx.agents.resume({ resumeSessionId: 'native-images', agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash' } })
  handles.push(owner)
  await send()
  assert.equal(owner.agent.session.snapshotEvents().filter(event => event.type === 'image/offload').length, 1)
  assert.match(JSON.stringify(requests.at(-1)), /offload|omitted/i)
  const blue = (await sharp({ create: { width: 4, height: 4, channels: 3, background: '#0000ff' } }).png().toBuffer()).toString('base64')
  const [newImage] = await admitEncodedImages(ctx.attachments, [{ data: blue, mediaType: 'image/png' }])
  rejectFiles = true
  await send([newImage])
  const fallback = JSON.stringify(requests.at(-1))
  assert.match(fallback, /base64/)
  assert.doesNotMatch(fallback, /file_id/)
  console.log(JSON.stringify({ node: process.version, messages: 'passed', filesReuse: 'passed', durableOffload: 'passed', resume: 'passed', inlineFallback: 'passed', noRawLog: 'passed', calls: requests.length }))
} finally {
  for (const handle of handles.reverse()) await handle.dispose()
  await ctx.fiber.dispose()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  if (priorHome === undefined) delete process.env.DSH_HOME; else process.env.DSH_HOME = priorHome
  if (priorKey === undefined) delete process.env.DSCODE_NATIVE_DEEPSEEK_API_KEY; else process.env.DSCODE_NATIVE_DEEPSEEK_API_KEY = priorKey
  await rm(root, { recursive: true })
}
