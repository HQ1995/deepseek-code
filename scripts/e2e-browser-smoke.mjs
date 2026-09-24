#!/usr/bin/env node
/** Keyless, real Chromium + extracted SDK check of dscode's browser plugin
 * (bridge/grok-leader/browser). Never attaches an existing browser.
 * Usage: e2e-browser-smoke.mjs <extracted-runtime> <absolute Chromium executable>
 * Link bridge/grok-leader/node_modules to the runtime's node_modules first. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import * as Browser from '../bridge/grok-leader/browser/index.mjs'
import { releaseSdk } from './release-sdk.mjs'
import { allowedTools, prefix } from '../bridge/grok-leader/browser/policy.mjs'

const runtime = resolve(process.argv[2])
const executablePath = process.argv[3]
assert.ok(executablePath?.startsWith('/'), 'Pass an absolute Chromium executable path')
const { sdk } = releaseSdk(runtime, { modulesOf: fileURLToPath(new URL('../bridge/grok-leader', import.meta.url)) })
const { Context } = await sdk('@deepseek-ai/cordis')
const { LlmAdapter, ToolCallId } = await sdk('@deepseek-ai/dsh-llm')
const root = await mkdtemp(join(tmpdir(), 'dscode-browser-smoke-'))
const workspace = join(root, 'workspace')
await mkdir(workspace)
const ctx = new Context()
const requests = []
const slow = Promise.withResolvers()
const ptcReady = Promise.withResolvers()
let slowResponse
let timeoutResponse
let ptcResponse
// A second origin the page references but the allowlist omits.
const outsideHits = []
const outside = createServer((request, response) => { outsideHits.push(request.url); response.writeHead(204); response.end() })
const server = createServer((request, response) => {
  requests.push(request.url)
  if (request.url === '/slow') { slowResponse = response; slow.resolve(); return }
  if (request.url === '/timeout') { timeoutResponse = response; return }
  if (request.url === '/ptc-slow') { ptcResponse = response; ptcReady.resolve(); return }
  response.writeHead(200, { 'Content-Type': 'text/html' })
  response.end(`<!doctype html><title>Private browser fixture</title>
    <label>Name<input aria-label="Name"></label><button onclick="document.querySelector('output').textContent='Hello '+document.querySelector('input').value;localStorage.setItem('marker','first')">Greet</button>
    <output>Fresh</output><p>Saved: <script>document.write(localStorage.getItem('marker') || 'empty')</script></p>
    <img alt="outside" src="http://127.0.0.1:${outside.address().port}/probe.png">`)
})
const owners = []
const evidence = { node: process.version, runtime, checks: [] }
const check = label => { evidence.checks.push(label); console.log('PASS', label) }
let callNumber = 0
const call = (agent, name, args = {}, signal = AbortSignal.timeout(25_000)) => ctx.tools.execute({
  agent, name: prefix + name, arguments: args, callId: ToolCallId('browser-' + ++callNumber), signal,
})
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const success = result => { assert.equal(result.isError, false, text(result)); return result }
// A busy host's full process table outgrows execFileSync's 1 MiB default.
const table = () => execFileSync('/bin/ps', ['-axo', 'pid=,ppid=,args='], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
const children = () => {
  const rows = table().split('\n').map(line => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/)).filter(Boolean)
  const pids = new Set([process.pid])
  let size
  do { size = pids.size; for (const row of rows) if (pids.has(Number(row[2]))) pids.add(Number(row[1])) } while (pids.size !== size)
  return rows.filter(row => pids.has(Number(row[1])) && /[p]laywright|[C]hrome|[c]hromium/.test(row[3]) && Number(row[1]) !== process.pid)
}
try {
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  outside.listen(0, '127.0.0.1')
  await once(outside, 'listening')
  const origin = `http://127.0.0.1:${server.address().port}`
  const modules = new Map()
  for (const name of ['system-prompt', 'tools', 'llm', 'session', 'agent', 'agent-loop', 'session-projection', 'user-approval', 'attachment-local', 'fs-local', 'subprocess-local', 'sandbox-local', 'sandbox-policy', 'ptc-runtime-node']) {
    const mod = await sdk('@deepseek-ai/dsh-' + name)
    modules.set(name, mod.default ?? mod)
  }
  class Model extends LlmAdapter {
    async resolveModel(provider, id) { return { provider, id, name: id, inputModalities: id === 'text-only' ? ['text'] : ['text', 'image'] } }
    async *stream() { throw new Error('No external model calls are allowed in this smoke') }
  }
  modules.set('fixture-model', { inject: ['llm'], apply(ctx) { ctx.effect(() => ctx.llm.registerAdapter(['fixture'], new Model())) } })
  modules.set('browser', Browser)
  const config = [...modules.keys()].map(name => ({ id: name, name, config:
    name === 'agent-loop' ? { agents: [] } : name === 'attachment-local' ? { dshHome: root } :
      name === 'sandbox-policy' ? { mode: 'read-only', workspaceRoot: workspace } :
      name === 'browser' ? { executablePath, navigationOrigins: [origin], toolCallTimeoutMs: 5000,
        // Negative control only: without the allowlist the outside request must happen.
        ...process.env.DSCODE_BROWSER_SMOKE_ANY_ORIGIN === '1' ? { anyOrigin: true } : {} } : {} }))
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, JSON.stringify(config))
  const { default: Loader } = await sdk('@deepseek-ai/cordis-plugin-loader')
  const { default: Include } = await sdk('@deepseek-ai/cordis-plugin-include')
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  ctx.loader.internal = { version: 'v2', async import(name) {
    assert.ok(modules.has(name), 'Unexpected composition import: ' + name)
    return modules.get(name)
  } }
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  const create = async (id, model = 'fixture') => {
    const owner = await ctx.agents.create({ sessionId: id, meta: { cwd: workspace }, agentOptions: { provider: 'fixture', model } })
    owners.push(owner)
    await owner.agent.whenIdle()
    owner.agent.session.append('turn/start', { turn: 1 })
    return owner
  }
  const first = await create('browser-first')
  const agent = first.agent
  if (process.env.DSCODE_BROWSER_SMOKE_DEBUG) console.log('STATUS', JSON.stringify(ctx.dscodeBrowser.status()))
  const catalog = ctx.tools.schemas(agent)
  evidence.catalog = catalog.map(tool => tool.name)
  await writeFile(join(root, 'catalog.json'), JSON.stringify(catalog, null, 2))
  // The pinned catalog is advertised whole; operations outside the reviewed
  // allowlist are refused by the guard below.
  assert.equal(catalog.filter(tool => tool.name.startsWith(prefix)).length, 24)
  assert.ok([...allowedTools].every(tool => catalog.some(entry => entry.name === prefix + tool)))
  check('Loader composition discovers the pinned 24-tool catalog')
  const denied = await call(agent, 'browser_run_code_unsafe', { code: 'async () => { throw new Error("must not execute") }' })
  assert.equal(denied.isError, true)
  assert.match(text(denied), /disabled/)
  // A later policy allow cannot undo the monotonic guard.
  const forceAllow = ctx.on('tools/pre-execute', async () => ({ kind: 'allow' }), { prepend: true })
  assert.match(text(await call(agent, 'browser_run_code_unsafe', { code: 'async () => 42' })), /disabled/)
  assert.match(text(await call(agent, 'browser_take_screenshot', { filename: join(root, 'forbidden.png') })), /disabled/)
  assert.equal((await call(agent, 'browser_navigate', { url: 'file:///tmp/forbidden' })).isError, true)
  assert.equal((await call(agent, 'browser_snapshot', { _meta: { cwd: root } })).isError, true)
  const restorePresentation = agent.ctx.tools.presentAs('both')
  const ptc = await ctx.tools.execute({
    agent, name: 'run_code', callId: ToolCallId('ptc-denial'), signal: AbortSignal.timeout(25_000),
    arguments: { code: `try { await tools[${JSON.stringify(prefix + 'browser_run_code_unsafe')}]({code:'async () => 42'}); return 'unexpected allow'; } catch (error) { return error.message; }`, description: 'Check browser denial through PTC' },
  })
  assert.equal(ptc.isError, false, text(ptc))
  assert.match(text(ptc), /disabled/)
  restorePresentation()
  forceAllow()
  check('Native and real PTC executors hard-deny unsafe code despite a policy allow')
  assert.equal((await call(agent, 'browser_navigate', { url: origin })).isError, true)
  assert.equal(requests.length, 0)
  check('missing approval answerer fails closed before navigation')
  const answer = ctx.on('approval/request', async () => 'allowed-once')
  const navigated = success(await call(agent, 'browser_navigate', { url: origin }))
  assert.match(text(navigated), /Private browser fixture/)
  check('approved navigation reads the controlled page')
  assert.deepEqual(outsideHits, [], 'page requests to an origin outside the allowlist are blocked')
  check('page requests outside the allowed origins are blocked by Playwright routing')
  await writeFile(join(root, 'navigation.txt'), text(navigated))
  // Use upstream's advertised target selectors rather than injecting page JavaScript.
  success(await call(agent, 'browser_fill_form', { fields: [{ name: 'Name', type: 'textbox', target: 'getByRole("textbox", { name: "Name" })', value: 'dscode' }] }))
  success(await call(agent, 'browser_click', { target: 'getByRole("button", { name: "Greet" })' }))
  const clicked = success(await call(agent, 'browser_snapshot'))
  assert.match(text(clicked), /Hello dscode/)
  check('fill and click reuse the same browser state')
  const screenshot = success(await call(agent, 'browser_take_screenshot', {}))
  const image = screenshot.content.find(block => block.type === 'image')
  assert.ok(image?.attachment, text(screenshot))
  const stored = await ctx.attachments.readImage(image.attachment)
  assert.ok(stored.data.byteLength > 100)
  evidence.image = { bytes: stored.data.byteLength, mediaType: stored.ref.mediaType }
  await writeFile(join(root, 'screenshot.png'), stored.data)
  const { createImageOutputProjector } = await import('../bridge/grok-leader/lib/types/image-output.js')
  // Session format V4 (DSH 0.1.7): a tool message carries its result blocks directly.
  const event = { type: 'tool/result', data: { message: { role: 'tool', toolCallId: 'screenshot', content: screenshot.content } } }
  const projected = await createImageOutputProjector(ctx)(event, [{ sessionUpdate: 'tool_call_update' }])
  assert.deepEqual(projected[0].rawOutput.dscodeImageErrors, [])
  assert.deepEqual(await readFile(projected[0].rawOutput.dscodeImages[0]), Buffer.from(stored.data))
  check('MCP screenshot reaches the attachment authority and dscode viewer path')
  assert.equal(existsSync(join(workspace, '.playwright-mcp')), false, 'browser artifacts stay out of the workspace')
  assert.deepEqual({ ...ctx.dscodeBrowser.status(), executable: undefined }, {
    executable: undefined, executableSource: 'configured', executableError: undefined, sandbox: true, anyOrigin: false, origins: [origin], sessions: 1,
  })
  check('artifacts stay in a private directory and the status service reports the sandboxed Session')
  const firstOwnedProcesses = children().map(row => Number(row[1]))
  const second = await create('browser-second', 'text-only')
  success(await call(second.agent, 'browser_navigate', { url: origin }))
  const separate = success(await call(second.agent, 'browser_snapshot'))
  assert.match(text(separate), /Saved: empty/)
  assert.doesNotMatch(text(separate), /Hello dscode/)
  success(await call(agent, 'browser_navigate', { url: origin }))
  assert.match(text(success(await call(agent, 'browser_snapshot'))), /Saved: first/)
  check('second live Session has independent storage and page state')
  const noImage = success(await call(second.agent, 'browser_take_screenshot'))
  assert.equal(noImage.content.some(block => block.type === 'image'), false)
  assert.match(text(noImage), /does not declare image input/)
  check('text-only models receive an explicit image-unavailable diagnostic')
  const controller = new AbortController()
  let returned = false
  const pending = call(agent, 'browser_navigate', { url: origin + '/slow' }, controller.signal).then(result => { returned = true; return result })
  const slowTimer = setTimeout(() => slow.reject(new Error('Slow navigation did not start')), 10_000)
  try { await slow.promise } finally { clearTimeout(slowTimer) }
  const queuedController = new AbortController()
  const queued = call(agent, 'browser_navigate', { url: origin + '/queued' }, queuedController.signal)
  queuedController.abort(new Error('Cancel queued navigation'))
  controller.abort(new Error('Controlled cancellation'))
  const cancelled = await pending
  const returnedBeforeResponse = returned
  assert.equal(cancelled.isError, true)
  const aliveAfterCancel = firstOwnedProcesses.filter(pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code !== 'ESRCH') throw error; return false } })
  assert.deepEqual(aliveAfterCancel, [], 'cancel must await the owned MCP and Chromium processes, not only their RPC')
  slowResponse.end('<!doctype html><title>After cancellation</title><script>fetch("/after-cancel")</script>')
  assert.equal((await queued).isError, true)
  await new Promise(resolve => setTimeout(resolve, 750))
  evidence.cancellation = { returnedBeforeResponse, aliveAfterCancel, pageEffectAfterCancel: requests.includes('/after-cancel'), result: text(cancelled) }
  assert.equal(requests.includes('/queued'), false)
  check('cancelled queued navigation never reaches the fixture')
  console.log('CANCELLATION', JSON.stringify(evidence.cancellation))
  assert.equal(ctx.tools.schemas(agent).filter(tool => tool.name.startsWith(prefix)).length, 0)
  success(await call(second.agent, 'browser_snapshot'))
  check('cancel removes only the affected Session browser; the second Session remains usable')
  const beforeTimeout = new Set(children().map(row => Number(row[1])))
  const third = await create('browser-timeout')
  success(await call(third.agent, 'browser_navigate', { url: origin }))
  const timedProcesses = children().map(row => Number(row[1])).filter(pid => !beforeTimeout.has(pid))
  assert.ok(timedProcesses.length > 0)
  const timed = await call(third.agent, 'browser_navigate', { url: origin + '/timeout' })
  assert.equal(timed.isError, true)
  assert.match(text(timed), /timed out/)
  for (const pid of timedProcesses) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  timeoutResponse.end('<script>fetch("/after-timeout")</script>')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(requests.includes('/after-timeout'), false)
  check('configured timeout also closes the owned MCP/Chromium range before returning')
  const beforePtc = new Set(children().map(row => Number(row[1])))
  const fourth = await create('browser-ptc-cancel')
  success(await call(fourth.agent, 'browser_navigate', { url: origin }))
  const ptcProcesses = children().map(row => Number(row[1])).filter(pid => !beforePtc.has(pid))
  assert.ok(ptcProcesses.length > 0)
  const presentation = fourth.agent.ctx.tools.presentAs('both')
  const ptcController = new AbortController()
  const ptcPending = ctx.tools.execute({
    agent: fourth.agent, name: 'run_code', callId: ToolCallId('ptc-cancel'), signal: ptcController.signal,
    arguments: { code: `await tools[${JSON.stringify(prefix + 'browser_navigate')}]({url:${JSON.stringify(origin + '/ptc-slow')}}); return 'unexpected completion';`, description: 'Cancel held browser operation through PTC' },
  })
  const ptcTimer = setTimeout(() => ptcReady.reject(new Error('PTC navigation did not start')), 10_000)
  try { await ptcReady.promise } finally { clearTimeout(ptcTimer) }
  ptcController.abort(new Error('Cancel PTC browser operation'))
  assert.equal((await ptcPending).isError, true)
  for (const pid of ptcProcesses) assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' })
  ptcResponse.end('<script>fetch("/after-ptc-cancel")</script>')
  await new Promise(resolve => setTimeout(resolve, 250))
  assert.equal(requests.includes('/after-ptc-cancel'), false)
  presentation()
  success(await call(second.agent, 'browser_snapshot'))
  check('real PTC cancellation drains browser cleanup and preserves a sibling Session')
  answer()
  const ownedProcesses = children().map(row => Number(row[1]))
  assert.ok(ownedProcesses.length > 0)
  await first.dispose()
  assert.equal(ctx.tools.schemas(agent).length, 0)
  const browserFiber = [...ctx.loader.entries()].find(entry => entry.options.id === 'browser').fiber
  await browserFiber.dispose()
  assert.equal(ctx.tools.schemas(second.agent).length, 0)
  for (const owner of owners.splice(0)) await owner.dispose()
  await ctx.fiber.dispose()
  const remaining = () => ownedProcesses.filter(pid => { try { process.kill(pid, 0); return true } catch (error) { if (error.code !== 'ESRCH') throw error; return false } })
  const deadline = Date.now() + 10_000
  while (remaining().length > 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 100))
  assert.deepEqual(remaining(), [])
  evidence.closedProcessCount = ownedProcesses.length
  check('Session disposal and provider unload remove tools and exit owned MCP/Chromium processes')
  // Returning before a held HTTP response is correct if the browser has exited.
  evidence.promotionReady = evidence.cancellation.aliveAfterCancel.length === 0 && !evidence.cancellation.pageEffectAfterCancel
  if (!evidence.promotionReady) process.exitCode = 2
} catch (error) {
  evidence.error = error.stack
  throw error
} finally {
  slowResponse?.destroy()
  timeoutResponse?.destroy()
  ptcResponse?.destroy()
  for (const owner of owners) await owner.dispose()
  await ctx.fiber.dispose()
  server.closeAllConnections()
  await new Promise(resolve => server.close(resolve))
  outside.closeAllConnections()
  await new Promise(resolve => outside.close(resolve))
  await writeFile(join(root, 'result.json'), JSON.stringify(evidence, null, 2))
  console.log('EVIDENCE', root)
}
