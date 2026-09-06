#!/usr/bin/env node
// Every model reply is live. The MCP fixture is a real tool, not a model mock.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { appendFileSync, mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { chmod, copyFile, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { createInterface } from 'node:readline'

export const name = 'dscode-live-observer'
export const inject = ['agents', 'sessionProjections', 'permissionPresets', 'goals', 'jobs', 'subagents']
export function apply(ctx) {
  const directory = process.env.DSCODE_LIVE_OBSERVER_DIR
  const workspace = process.env.DSCODE_LIVE_WORKSPACE
  if (!directory || !workspace) throw new Error('Live observer needs isolated output/workspace')
  mkdirSync(directory, { recursive: true, mode: 0o700 })
  const owned = session => session.header.cwd === workspace || session.header.cwd?.startsWith(workspace + sep)
  const metadata = new Map()
  ctx.on('session/event', (session, event) => {
    if (owned(session)) appendFileSync(join(directory, `${session.id}.events.jsonl`), JSON.stringify({ pid: process.pid, sessionId: session.id, event }) + '\n', { mode: 0o600 })
    if (owned(session) && event.type === 'turn/end') queueMicrotask(() => void sample())
  })
  let sampling = false
  const sample = async () => {
    if (sampling) return
    sampling = true
    try {
      for (const listed of ctx.agents.list()) {
        const agent = ctx.agents.get(listed.id)
        if (!agent || !owned(agent.session)) continue
        const selection = { provider: agent.options.provider, model: agent.options.model }, key = JSON.stringify(selection)
        if (!metadata.has(key)) {
          metadata.set(key, { status: 'unavailable' })
          try {
            const llm = agent.ctx.get('llm') ?? ctx.get('llm')
            if (llm?.resolveModelInfo && selection.provider && selection.model) {
              const info = await llm.resolveModelInfo(selection.provider, selection.model)
              metadata.set(key, { status: 'resolved', inputModalities: info.inputModalities, reasoning: info.reasoning, contextWindow: info.contextWindow, maxTokens: info.maxTokens })
            }
          } catch { metadata.set(key, { status: 'resolution-failed' }) }
        }
        const descendants = await ctx.subagents.listDescendants(agent.id)
        const value = { pid: process.pid, time: Date.now(), id: agent.id, status: agent.status, selection, metadata: metadata.get(key),
          policy: ctx.permissionPresets.resolve(ctx.permissionPresets.current(agent.session)), goal: ctx.goals.get(agent) ?? null,
          projections: ctx.sessionProjections.snapshot(agent.session, ['contextPressure', 'tokenUsage', 'goal']),
          descendants: descendants.map(child => ({ id: child.id, parentId: child.parentId, kind: child.kind, status: ctx.agents.get(child.id)?.status ?? null })),
          events: agent.session.snapshotEvents() }
        const path = join(directory, `${agent.id}.state.json`)
        writeFileSync(path + '.tmp', JSON.stringify(value), { mode: 0o600 }); renameSync(path + '.tmp', path)
      }
    } catch (error) { appendFileSync(join(directory, 'observer.errors.log'), String(error?.stack ?? error) + '\n', { mode: 0o600 }) }
    finally { sampling = false }
  }
  const timer = setInterval(sample, 100); timer.unref()
  ctx.on('dispose', () => clearInterval(timer)); void sample()
}

async function fixture(log) {
  const receipt = randomUUID()
  for await (const line of createInterface({ input: process.stdin })) {
    let request
    try { request = JSON.parse(line) } catch { continue }
    if (request.id === undefined) continue
    let result
    if (request.method === 'initialize') result = { protocolVersion: request.params?.protocolVersion ?? '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'live-acceptance-fixture', version: '1.0.0' } }
    else if (request.method === 'ping') result = {}
    else if (request.method === 'tools/list') result = { tools: [{ name: 'live_receipt', description: 'Return an opaque receipt and the SHA256 of supplied text.', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false } }] }
    else if (request.method === 'tools/call' && request.params?.name === 'live_receipt' && typeof request.params.arguments?.text === 'string') {
      const value = { receipt, sha256: createHash('sha256').update(request.params.arguments.text).digest('hex') }
      appendFileSync(log, JSON.stringify({ input: request.params.arguments.text, ...value }) + '\n', { mode: 0o600 })
      result = { content: [{ type: 'text', text: JSON.stringify(value) }] }
    } else { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } }) + '\n'); continue }
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n')
  }
}

async function main() {
  const names = ['coding', 'resume', 'question', 'approval', 'subagent', 'goals', 'history', 'mcp', 'visibility', 'compact-rewind']
  const args = {}
  for (let index = 2; index < process.argv.length; index += 2) {
    const key = process.argv[index]
    if (key === '--help') {
      console.log('Usage: node scripts/e2e-live-models.mjs --tui PATH --dsh PATH --home PATH --profile PATH --provider ID --model EXACT_ID --out PATH [--scenario NAME]\nScenarios: ' + names.join(', ') + '\nRequires isolated HOME/profiles/dscode, exact default provider, Node >=22.19, tmux and package manager. Auth: OCX_API_KEY; DSCODE_LIVE_AUTH_ENV may name comma-separated alternatives. DSCODE_LIVE_TIMEOUT_MS defaults to 240000, maximum 600000. Launch under required NUMA binding; children inherit it.')
      return
    }
    assert.ok(['--tui', '--dsh', '--home', '--profile', '--provider', '--model', '--out', '--scenario'].includes(key), 'Unknown argument')
    assert.ok(process.argv[index + 1] && !process.argv[index + 1].startsWith('--'), `Missing value for ${key}`)
    assert.equal(args[key.slice(2)], undefined, `Duplicate ${key}`); args[key.slice(2)] = process.argv[index + 1]
  }
  for (const key of ['tui', 'dsh', 'home', 'profile', 'provider', 'model', 'out']) assert.ok(args[key], `--${key} is required`)
  if (args.scenario) assert.ok(names.includes(args.scenario), 'Unknown scenario')
  const script = fileURLToPath(import.meta.url), repo = resolve(dirname(script), '..')
  for (const key of ['tui', 'dsh', 'home', 'profile']) args[key] = await realpath(args[key])
  await mkdir(resolve(args.out), { recursive: true, mode: 0o700 }); args.out = await realpath(resolve(args.out))
  assert.ok(args.out !== repo && !args.out.startsWith(repo + sep), '--out must be outside this repository')
  assert.ok(args.home !== repo && !args.home.startsWith(repo + sep), '--home must be an isolated home outside the repository')
  assert.equal(args.profile, await realpath(join(args.home, 'profiles/dscode')), 'TUI auto-spawns dscode; --profile must be isolated HOME/profiles/dscode')
  await chmod(args.out, 0o700)
  assert.deepEqual(await readdir(args.out), [], '--out must be empty; use a fresh directory for reruns')
  const workspace = join(args.out, 'workspace'), observer = join(args.out, 'observer')
  await mkdir(workspace, { mode: 0o700 }); await mkdir(observer, { mode: 0o700 })
  const timeout = Number(process.env.DSCODE_LIVE_TIMEOUT_MS ?? 240000)
  assert.ok(Number.isFinite(timeout) && timeout >= 10000 && timeout <= 600000, 'Invalid DSCODE_LIVE_TIMEOUT_MS')
  const baseEnv = {}
  const authNames = (process.env.DSCODE_LIVE_AUTH_ENV ?? 'OCX_API_KEY').split(',').filter(Boolean)
  for (const key of ['PATH', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ', ...authNames]) {
    assert.match(key, /^[A-Za-z_][A-Za-z0-9_]*$/, 'Invalid auth variable name')
    if (process.env[key] !== undefined) baseEnv[key] = process.env[key]
  }
  Object.assign(baseEnv, { HOME: args.home, DSH_HOME: args.home, DSC_HOME: join(args.out, 'dsc'), DSH_BIN: args.dsh,
    DSH_PROFILE_DIR: args.profile, DSCODE_HOME: args.profile, DSCODE_LIVE_OBSERVER_DIR: observer, DSCODE_LIVE_WORKSPACE: workspace,
    DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1', TERM: 'xterm-256color' })
  const processes = new Set(), servers = new Set(), sockets = new Set(), leaderIdentities = new Map()
  const report = { provider: args.provider, model: args.model, startedAt: new Date().toISOString(), timeoutMs: timeout,
    limits: { maxToolCallsPerProcess: 40, maxAssistantMessagesPerProcess: 32, maxOutputBytes: 16 * 1024 * 1024 },
    limitations: ['No provider CLI flag: provisioned provider is verified in actual agent options; exact --model is passed each launch.', 'Native --max-turns is not forwarded to DSH; external elapsed/tool/output bounds are enforced.', 'Headless paths are not visual coverage.'], scenarios: [] }
  const save = () => writeFile(join(args.out, 'results.json'), JSON.stringify(report, null, 2) + '\n', { mode: 0o600 })
  const json = async path => JSON.parse(await readFile(path, 'utf8'))
  const optional = async path => readFile(path, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error })
  const processIdentity = async pid => (await optional(`/proc/${pid}/stat`)).replace(/^.*\) /, '').split(' ')[19]
  const state = async id => {
    const value = await json(join(observer, `${id}.state.json`)).catch(error => { if (error.code === 'ENOENT') return null; throw error })
    if (value && !leaderIdentities.has(value.pid)) {
      const identity = await processIdentity(value.pid)
      if (identity) leaderIdentities.set(value.pid, identity)
    }
    return value
  }
  const journal = async id => {
    const text = await optional(join(observer, `${id}.events.jsonl`))
    return text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean).map(line => JSON.parse(line).event)
  }
  const calls = events => events.filter(event => event.type === 'tool/call')
  const resultFor = (events, call) => events.find(event => event.type === 'tool/result' && String(event.data.message?.content?.[0]?.toolCallId) === String(call.data.callId))
  function tools(events, required) {
    for (const name of required) assert.ok(calls(events).some(call => call.data.name === name && resultFor(events, call) && resultFor(events, call).data.error === undefined), `Missing successful real ${name} call/result pair`)
    return calls(events).map(call => ({ name: call.data.name, callId: call.data.callId, successful: Boolean(resultFor(events, call)) && resultFor(events, call).data.error === undefined }))
  }
  function exact(value) {
    assert.equal(value?.selection.provider, args.provider, 'Provider substitution or missing observation')
    assert.equal(value?.selection.model, args.model, 'Model substitution or missing observation')
  }
  async function waitFor(read, predicate, label, deadline = Date.now() + timeout) {
    while (Date.now() < deadline) { const value = await read(); if (predicate(value)) return value; await delay(150) }
    throw new Error(`${label} timed out`)
  }
  async function run(binary, argv, { cwd = workspace, env = baseEnv, label, limit = timeout, monitor } = {}) {
    const child = spawn(binary, argv, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] }); processes.add(child)
    let stdout = '', stderr = '', size = 0, failure, escalation
    const kill = () => {
      try { process.kill(-child.pid, 'SIGTERM') } catch {}
      escalation ??= setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL') } catch {} }, 3000)
    }
    const timer = setTimeout(() => { failure = new Error(`${label} exceeded ${limit}ms`); kill() }, limit)
    const consume = kind => chunk => {
      size += chunk.length
      if (size > report.limits.maxOutputBytes) { failure = new Error(`${label} exceeded output budget`); kill(); return }
      if (kind === 'stdout') stdout += chunk; else stderr += chunk
    }
    child.stdout.on('data', consume('stdout')); child.stderr.on('data', consume('stderr'))
    let checking = false
    const watch = monitor && setInterval(async () => {
      if (checking || failure) return
      checking = true
      try { await monitor() } catch (error) { failure = error; kill() } finally { checking = false }
    }, 200)
    try {
      const code = await new Promise((done, reject) => { child.once('error', reject); child.once('close', done) })
      if (label) {
        await writeFile(join(args.out, `${label}.stdout.log`), stdout, { mode: 0o600 })
        await writeFile(join(args.out, `${label}.stderr.log`), stderr, { mode: 0o600 })
      }
      if (failure) throw failure
      assert.equal(code, 0, `${label ?? binary} exited nonzero; see private logs`)
      return stdout
    } finally { clearTimeout(timer); clearTimeout(escalation); if (watch) clearInterval(watch); processes.delete(child) }
  }
  async function budgetCheck(id, baseline = 0) {
    const events = (await journal(id)).slice(baseline)
    assert.ok(calls(events).length <= report.limits.maxToolCallsPerProcess, 'Live tool-call budget exceeded')
    assert.ok(events.filter(event => event.type === 'assistant/message').length <= report.limits.maxAssistantMessagesPerProcess, 'Live assistant-message budget exceeded')
    const current = await state(id); if (current) exact(current)
  }
  async function leaderExit(socket) {
    await waitFor(async () => {
      const content = (await optional(socket.replace(/\.[^.]+$/, '.lock'))).trim()
      if (!content) return true
      const pid = Number(content); assert.ok(Number.isSafeInteger(pid) && pid > 1, 'Invalid owned leader lock')
      try { process.kill(pid, 0); return false } catch (error) { if (error.code === 'ESRCH') return true; throw error }
    }, Boolean, 'Owned leader shutdown', Date.now() + 15000)
  }
  async function cleanup() {
    for (const server of servers) await run('tmux', ['-L', server, '-f', '/dev/null', 'kill-server'], { limit: 5000 }).catch(() => {})
    servers.clear()
    for (const child of processes) { try { process.kill(-child.pid, 'SIGTERM') } catch {} }
    for (const socket of sockets) {
      const pid = Number((await optional(socket.replace(/\.[^.]+$/, '.lock'))).trim())
      if (!Number.isSafeInteger(pid) || pid <= 1) continue
      if (leaderIdentities.has(pid) && await processIdentity(pid) === leaderIdentities.get(pid)) {
        try { process.kill(-pid, 'SIGTERM') } catch { try { process.kill(pid, 'SIGTERM') } catch {} }
        await delay(300)
        if (await processIdentity(pid) === leaderIdentities.get(pid)) { try { process.kill(-pid, 'SIGKILL') } catch { try { process.kill(pid, 'SIGKILL') } catch {} } }
      }
    }
  }
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => {
    report.interrupted = signal; await cleanup(); await save(); process.exit(signal === 'SIGINT' ? 130 : 143)
  })
  let processNumber = 0
  const sessionArgs = (id, resume, preset = 'standard') => [resume ? '--resume' : '--session-id', id, '--agent', preset, '--model', args.model, '--no-plan']
  const rules = 'Work only in the current scratch workspace. Do not inspect home/configuration/credentials, use the network, install packages, or change provider/model. Use real available tools, never simulate results. Keep final response under 100 words. '
  async function headless(label, cwd, prompt, { id = randomUUID(), resume = false, preset = 'standard' } = {}) {
    const socket = join(args.out, `p${++processNumber}.sock`); sockets.add(socket)
    const baseline = (await journal(id)).length
    const stdout = await run(args.tui, [...sessionArgs(id, resume, preset), '--always-approve', '-p', rules + prompt, '--output-format', 'json'], {
      label, cwd, env: { ...baseEnv, DSCODE_SOCKET: socket, DSCODE_LOG: join(args.out, `${label}.leader.log`) }, monitor: () => budgetCheck(id, baseline) })
    await leaderExit(socket)
    const output = JSON.parse(stdout); assert.equal(output.sessionId, id, 'Headless session identity differs')
    const observed = await state(id); exact(observed)
    return { id, output, state: observed, events: (await journal(id)).slice(baseline), socket }
  }
  async function tui(label, cwd, { id = randomUUID(), resume = false, preset = 'standard' } = {}) {
    const server = `dscode-live-${randomUUID()}`, socket = join(args.out, `p${++processNumber}.sock`)
    sockets.add(socket); servers.add(server)
    const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`
    const launcher = join(args.out, `${label}.launch.sh`)
    await writeFile(launcher, `#!/bin/sh\ncd ${quote(cwd)}\nexec ${[args.tui, ...sessionArgs(id, resume, preset), '--always-approve'].map(quote).join(' ')}\n`, { mode: 0o700 })
    const env = { ...baseEnv, DSCODE_SOCKET: socket, DSCODE_LOG: join(args.out, `${label}.leader.log`) }
    const tmux = (...argv) => run('tmux', ['-L', server, '-f', '/dev/null', ...argv], { env, limit: 10000 })
    await tmux('new-session', '-d', '-s', 'live', '-n', 'main', '-x', '200', '-y', '60', launcher)
    const capture = () => tmux('capture-pane', '-p', '-t', 'live:main.0', '-S', '-300')
    const key = value => tmux('send-keys', '-t', 'live:main.0', value)
    const send = async text => { await tmux('send-keys', '-l', '-t', 'live:main.0', text); await key('Enter') }
    const baseline = (await journal(id)).length, deadline = Date.now() + timeout
    const wait = (read, predicate, why) => waitFor(async () => { await budgetCheck(id, baseline); return read() }, predicate, why, deadline)
    await wait(() => state(id), value => value?.id === id, 'TUI startup'); exact(await state(id))
    return { id, send, key, capture, wait, state: () => state(id), events: () => journal(id),
      async screen(suffix) { const text = await capture(); await writeFile(join(args.out, `${label}.${suffix}.screen.txt`), text, { mode: 0o600 }); return text },
      async turn(prompt) {
        const before = (await journal(id)).length; await send(rules + prompt)
        await wait(() => journal(id), events => events.slice(before).some(event => event.type === 'turn/end'), 'TUI turn completion')
        await wait(() => state(id), value => value?.status === 'idle', 'TUI idle'); return (await journal(id)).slice(before)
      },
      async stop() { await tmux('kill-server'); servers.delete(server); await leaderExit(socket) } }
  }
  const makeWorkspace = async name => { const cwd = join(workspace, name); await mkdir(cwd, { mode: 0o700 }); return cwd }
  async function scenario(name, fn) {
    if (args.scenario && args.scenario !== name) return
    const started = Date.now(), result = { name, provider: args.provider, model: args.model, status: 'fail', evidence: {} }
    report.scenarios.push(result)
    console.log(`RUN ${name} (${args.model})`)
    try { await fn(result); if (result.status === 'fail') result.status = 'pass' }
    catch (error) { result.error = error.message; await writeFile(join(args.out, `${name}.error.log`), String(error.stack ?? error), { mode: 0o600 }) }
    finally { result.elapsedMs = Date.now() - started; await cleanup(); await save(); console.log(`${result.status.toUpperCase()} ${name} (${result.elapsedMs}ms)`) }
  }
  await save()
  try {
    const plugin = join(args.out, 'observer-plugin'); await mkdir(plugin, { mode: 0o700 })
    await copyFile(script, join(plugin, 'index.mjs'))
    await writeFile(join(plugin, 'package.json'), JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'index.mjs', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    await writeFile(join(plugin, 'cordis.patch.yml'), '- insert:\n    - id: dscode-live-observer\n      name: dscode-live-observer\n')
    await run(args.dsh, ['plugin', '--profile', 'dscode', 'add', `file:${plugin}`], { label: 'observer-install', limit: 120000 })

    await scenario('coding', async result => {
      const cwd = await makeWorkspace('coding')
      await writeFile(join(cwd, 'sum.mjs'), 'export function sum(values) { return values.length }\n')
      await writeFile(join(cwd, 'check.mjs'), "import assert from 'node:assert/strict'; import { sum } from './sum.mjs'; import { writeFileSync } from 'node:fs'; assert.equal(sum([3,8,-2]),9); assert.equal(sum([]),0); assert.equal(sum([0.5,1.5]),2); writeFileSync('verified.json',JSON.stringify({sum:sum([3,8,-2]),empty:sum([])}));\n")
      const checkHash = createHash('sha256').update(await readFile(join(cwd, 'check.mjs'))).digest('hex')
      const live = await headless('coding', cwd, 'Read sum.mjs and check.mjs using read. Fix sum.mjs using edit so sum adds numbers, including empty and negative inputs. Do not modify check.mjs. Run node check.mjs using bash and consume its result; stop once it succeeds.')
      result.evidence = { sessionId: live.id, surface: 'headless', tools: tools(live.events, ['read', 'edit', 'bash']) }
      assert.equal(createHash('sha256').update(await readFile(join(cwd, 'check.mjs'))).digest('hex'), checkHash, 'Model changed independent check')
      assert.deepEqual(await json(join(cwd, 'verified.json')), { sum: 9, empty: 0 })
      await run(process.execPath, ['check.mjs'], { cwd, label: 'coding-independent-check', limit: 10000 })
      result.evidence.artifact = { path: join(cwd, 'verified.json'), value: await json(join(cwd, 'verified.json')), independentlyExecuted: true }
    })
    await scenario('resume', async result => {
      const cwd = await makeWorkspace('resume'), fact = randomUUID()
      const first = await headless('resume-seed', cwd, `Remember this dispatch fact only in conversation: ${fact}. Do not put it in any file. Write prior.json with exactly {"revision":1,"count":7}. Briefly acknowledge the fact in your final response.`)
      assert.deepEqual(await json(join(cwd, 'prior.json')), { revision: 1, count: 7 })
      assert.deepEqual(await readdir(cwd), ['prior.json'], 'Seed stored extra files that could leak the memory fact')
      const second = await headless('resume-fresh', cwd, 'Recall the dispatch fact given in our earlier turn, without searching history files. Read prior.json and edit it to revision 2 and count 12. Write recalled.txt containing only the earlier dispatch fact. Do not guess a new fact.', { id: first.id, resume: true })
      assert.notEqual(first.state.pid, second.state.pid, 'Resume reused live leader')
      assert.equal((await readFile(join(cwd, 'recalled.txt'), 'utf8')).trim(), fact)
      assert.deepEqual(await json(join(cwd, 'prior.json')), { revision: 2, count: 12 })
      result.evidence = { sessionId: first.id, surface: 'headless', firstPid: first.state.pid, resumedPid: second.state.pid, fact, tools: tools(second.events, ['read', 'edit']), artifact: await json(join(cwd, 'prior.json')) }
    })
    await scenario('question', async result => {
      const cwd = await makeWorkspace('question'), ui = await tui('question', cwd)
      await ui.send(rules + 'Use ask_user_question now, exactly one single-select question: choose a tree, options Cedar first and Maple second. Wait for the real user answer. Then write answer.json with {"tree":<selected option label>}. Do not infer the answer before the tool returns.')
      await ui.wait(ui.events, events => calls(events).some(call => call.data.name === 'ask_user_question'), 'Native question call')
      await ui.wait(ui.capture, text => text.includes('Cedar') && text.includes('Maple'), 'Question options rendered')
      await ui.screen('pending'); assert.equal(await optional(join(cwd, 'answer.json')), '', 'Artifact appeared before answer')
      await ui.key('Down'); await ui.key('Enter')
      await ui.wait(() => optional(join(cwd, 'answer.json')), Boolean, 'Answer-dependent artifact')
      await ui.wait(ui.state, value => value?.status === 'idle', 'Question settled')
      assert.deepEqual(await json(join(cwd, 'answer.json')), { tree: 'Maple' })
      result.evidence = { sessionId: ui.id, surface: 'tmux TUI', selected: 'Maple', tools: tools(await ui.events(), ['ask_user_question']), artifact: await json(join(cwd, 'answer.json')) }
      await ui.screen('answered'); await ui.stop()
    })
    await scenario('approval', async result => {
      const cwd = await makeWorkspace('approval'), ui = await tui('approval', cwd)
      await ui.key('C-o'); await ui.wait(ui.state, value => value?.policy.approval === 'ask', 'Ask policy enabled')
      const observations = []
      for (const decision of ['deny', 'allow']) {
        const filename = `${decision}.txt`, path = join(cwd, filename), before = (await ui.events()).length
        await ui.send(rules + `Use bash with command printf '${decision}' > ${filename}, sandbox_permissions:'danger-full-access', and justification:'Exercise one-time approval for a safe scratch-only write'. Do not change anything outside this workspace. Do not use another tool or work around a refusal. If denied, stop without writing anything.`)
        await ui.wait(ui.capture, text => /No, reject \(type to add feedback\)/.test(text), `${decision} approval prompt`)
        assert.equal(await optional(path), '', 'Pending operation changed workspace')
        await ui.screen(`${decision}-pending`); await ui.key(decision === 'deny' ? '2' : '1')
        await ui.wait(ui.events, events => events.slice(before).some(event => event.type === 'turn/end'), `${decision} turn finished`)
        await ui.wait(ui.state, value => value?.status === 'idle', `${decision} idle`)
        assert.equal(await optional(path), decision === 'deny' ? '' : 'allow')
        assert.equal((await ui.state()).policy.approval, 'ask', 'One-time choice changed standing policy')
        const events = (await ui.events()).slice(before)
        assert.ok(calls(events).some(call => call.data.name === 'bash'), 'No actual bash approval call')
        if (decision === 'allow') tools(events, ['bash'])
        observations.push({ decision, exists: Boolean(await optional(path)), eventTypes: events.map(event => event.type) })
      }
      result.evidence = { sessionId: ui.id, surface: 'tmux TUI', observations }; await ui.screen('settled'); await ui.stop()
    })
    await scenario('subagent', async result => {
      const cwd = await makeWorkspace('subagent')
      const live = await headless('subagent', cwd, 'Delegate exactly one task using subagent, run_in_background:false, inheriting your exact current provider and model. Child must use bash to generate a fresh UUID with node crypto.randomUUID(), write child.txt with that UUID and return it. Parent must wait for the real child result then write parent.json with {"childReceipt":<the child UUID>,"incorporated":true}. Parent must not generate the UUID itself.')
      const childReceipt = (await readFile(join(cwd, 'child.txt'), 'utf8')).trim()
      assert.match(childReceipt, /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/)
      assert.deepEqual(await json(join(cwd, 'parent.json')), { childReceipt, incorporated: true })
      tools(live.events, ['subagent'])
      const descendants = live.state.descendants.filter(child => child.kind === 'child')
      assert.ok(descendants.length, 'No native child session exists')
      const activity = []
      for (const child of descendants) {
        const observed = await state(child.id); exact(observed)
        const events = await journal(child.id)
        assert.ok(events.some(event => event.type === 'turn/end'), 'Child did not finish a real turn')
        tools(events, ['bash']); assert.ok(JSON.stringify(events).includes(childReceipt), 'Child events omit receipt')
        activity.push({ id: child.id, selection: observed.selection, tools: tools(events, []) })
      }
      assert.ok(calls(live.events).filter(call => call.data.name === 'subagent').some(call => JSON.stringify(resultFor(live.events, call)).includes(childReceipt)), 'Parent did not receive child receipt')
      result.evidence = { sessionId: live.id, surface: 'headless', childReceipt, activity, parent: await json(join(cwd, 'parent.json')) }
    })
    await scenario('goals', async result => {
      const cwd = await makeWorkspace('goals'), marker = `receipt-${randomUUID()}`
      const live = await headless('goals', cwd, `Use native create_goal to create a small goal whose objective is: write goal.txt containing ${marker}. Then get_goal to obtain actual id/revision, update_goal to revise its objective to: verified ${marker}. Perform the file write, get_goal again and update_goal action complete using latest revision. Do not substitute markdown TODOs. Complete the goal before finishing; no repeated autonomous rounds are needed.`)
      assert.equal((await readFile(join(cwd, 'goal.txt'), 'utf8')).trim(), marker)
      tools(live.events, ['create_goal', 'get_goal', 'update_goal'])
      const updates = calls(live.events).filter(call => call.data.name === 'update_goal' && resultFor(live.events, call)?.data.error === undefined)
      assert.ok(updates.length >= 2, 'Goal was not updated and completed')
      const complete = updates.some(call => /"phase"\s*:\s*"complete"/.test(JSON.stringify(resultFor(live.events, call)).replaceAll('\\"', '"')))
      assert.ok(live.state.goal?.phase === 'complete' || complete, 'Native goal is not complete')
      result.evidence = { sessionId: live.id, surface: 'headless', goal: live.state.goal, updateResults: updates.map(call => resultFor(live.events, call)), marker }
    })
    await scenario('history', async result => {
      const cwd = await makeWorkspace('history'), marker = `history-${randomUUID()}`
      const seed = await headless('history-seed', cwd, `Keep this historical receipt only in conversation: ${marker}. Do not write any file. Reply by quoting it once.`)
      const live = await headless('history-query', cwd, `Use session_search to search real persisted previous sessions in this workspace. Locate session ${seed.id}, then session_event_search and session_event_read to retrieve its earlier historical receipt. Write history.json with {"sourceSession":"${seed.id}","receipt":<receipt retrieved from prior conversation>}. Do not read persistence files with filesystem tools.`, { preset: 'history' })
      tools(live.events, ['session_search', 'session_event_search', 'session_event_read'])
      assert.deepEqual(await json(join(cwd, 'history.json')), { sourceSession: seed.id, receipt: marker })
      assert.ok(calls(live.events).some(call => call.data.name === 'session_event_read' && JSON.stringify(resultFor(live.events, call)).includes(marker)), 'Receipt absent from real history result')
      result.evidence = { seedSessionId: seed.id, sessionId: live.id, surface: 'headless', tools: tools(live.events, []), artifact: await json(join(cwd, 'history.json')) }
    })
    await scenario('mcp', async result => {
      const cwd = await makeWorkspace('mcp'), input = randomUUID(), log = join(args.out, 'mcp-fixture.calls.jsonl')
      await run(args.tui, ['mcp', 'add', '--transport', 'stdio', 'live_acceptance', '--', process.execPath, script, '--live-mcp-fixture', log], { label: 'mcp-register', limit: 30000 })
      const live = await headless('mcp', cwd, `Call MCP tool mcp__live_acceptance__live_receipt with text ${input}. Consume its real result and write mcp.json containing exactly its receipt and sha256 fields. Do not invent a receipt or calculate a substitute.`)
      tools(live.events, ['mcp__live_acceptance__live_receipt'])
      const invocations = (await readFile(log, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
      const invocation = invocations.find(value => value.input === input); assert.ok(invocation, 'Fixture received no matching invocation')
      assert.deepEqual(await json(join(cwd, 'mcp.json')), { receipt: invocation.receipt, sha256: createHash('sha256').update(input).digest('hex') })
      result.evidence = { sessionId: live.id, surface: 'headless', invocation, artifact: await json(join(cwd, 'mcp.json')) }
    })
    await scenario('visibility', async result => {
      const cwd = await makeWorkspace('visibility'), ui = await tui('visibility', cwd)
      await ui.turn('Compute 19*23+11, explaining briefly how you checked it. Write arithmetic.txt with the numeric answer using a real tool.')
      assert.equal((await readFile(join(cwd, 'arithmetic.txt'), 'utf8')).trim(), '448')
      const observed = await ui.state(), events = await ui.events()
      const reasoning = events.some(event => event.type === 'assistant/message' && JSON.stringify(event.data).includes('reasoning'))
      const answerScreen = await ui.screen('answer')
      await ui.send('/usage'); await ui.wait(ui.capture, text => /tokens|Token|Context usage/i.test(text), 'Usage UI visible')
      const usageScreen = await ui.screen('usage'), usage = observed.projections.values.tokenUsage
      assert.ok(usage?.outputTokens > 0, 'No measured native output usage')
      assert.ok(!usageScreen.includes('Context usage unavailable'), 'Actual context usage not displayed')
      const modalities = observed.metadata?.inputModalities
      result.evidence = { sessionId: ui.id, surface: 'tmux TUI', usage,
        thinking: { nativeReasoningObserved: reasoning, visiblyRendered: /thinking|thought|reasoning/i.test(answerScreen), metadata: observed.metadata?.reasoning ?? null },
        images: { status: Array.isArray(modalities) ? modalities.includes('image') ? 'uncovered' : 'unsupported' : 'uncovered', inputModalities: modalities ?? null,
          reason: Array.isArray(modalities) && !modalities.includes('image') ? 'Exact native metadata declares no image input; no image request sent.' : 'Metadata only; image upload/understanding UI not exercised.' } }
      if (!reasoning || !result.evidence.thinking.visiblyRendered) { result.status = 'skip'; result.reason = 'Usage verified, but thinking rendering not observable; no visual thinking pass claimed.' }
      await ui.key('Escape'); await ui.stop()
    })
    await scenario('compact-rewind', async result => {
      const cwd = await makeWorkspace('compact-rewind'), ui = await tui('compact-rewind', cwd)
      const first = randomUUID(), second = randomUUID()
      await writeFile(join(cwd, 'activity.log'), Array.from({ length: 180 }, (_, index) => `job-${String(index).padStart(3, '0')}: processed 12 records; validation passed; retry count zero; no warnings; output committed successfully.\n`).join(''))
      await ui.turn(`Read all 180 lines of activity.log using read. Remember first receipt ${first} as important conversation state. Write first.txt with it. Briefly describe the job trace and what you wrote.`)
      await ui.turn(`Remember second receipt ${second}. Write second.txt with it. Briefly describe what you wrote.`)
      const before = (await ui.events()).length
      await ui.send('/compact')
      await ui.wait(ui.events, events => events.slice(before).some(event => event.type === 'command/done'), 'Native compaction completion')
      await ui.screen('compact')
      const compactEvents = (await ui.events()).slice(before), completion = compactEvents.find(event => event.type === 'command/done')
      const count = Number(completion?.data.text?.match(/Compacted (\d+) history items/)?.[1] ?? 0)
      const nativeCompaction = compactEvents.filter(event => /compact/.test(event.type))
      const succeeded = count > 0 && completion?.data.kind !== 'error' && nativeCompaction.some(event => event.type === 'compaction/end' && !event.data.error)
      result.evidence = { sessionId: ui.id, surface: 'tmux TUI', compact: { status: succeeded ? 'pass' : 'fail', items: count, eventTypes: nativeCompaction.map(event => event.type), command: completion?.data } }
      if (succeeded) {
        const recall = await ui.turn('Using only conversation memory, not reading first.txt or second.txt, write recovered.json with keys first and second containing the two receipts remembered earlier. Do not inspect any files to recover the values.')
        assert.ok(calls(recall).every(call => ['write', 'edit'].includes(call.data.name)), 'Recall used a tool that could inspect external state')
        assert.deepEqual(await json(join(cwd, 'recovered.json')), { first, second }, 'Compaction lost task-critical conversation state')
        result.evidence.compact.continuedWithPreservedState = true
      }
      await ui.send('/rewind')
      await ui.wait(ui.capture, text => text.includes('Rewind to which turn?'), 'Rewind picker')
      await ui.screen('rewind-picker'); await ui.key('Enter')
      await ui.wait(ui.capture, text => text.includes('Rewind conversation to'), 'Rewind confirmation')
      await ui.key('y')
      await ui.wait(ui.capture, text => /Reverted conversation/.test(text), 'Conversation rewind applied')
      await ui.screen('rewound')
      const old = await ui.state()
      const fresh = await waitFor(async () => {
        for (const file of (await readdir(observer)).filter(file => file.endsWith('.state.json'))) {
          const value = await json(join(observer, file)); if (value.id !== ui.id && value.pid === old.pid) return value
        }
        return null
      }, Boolean, 'Rewind fork state', Date.now() + 10000)
      exact(fresh); assert.ok(fresh.events.length > 0, 'Rewind fork is empty')
      assert.ok(fresh.events.filter(event => event.type === 'user/message').length < old.events.filter(event => event.type === 'user/message').length, 'Rewind did not shorten conversation')
      assert.equal((await readFile(join(cwd, 'second.txt'), 'utf8')).trim(), second, 'Conversation-only rewind changed files')
      result.evidence.rewind = { status: 'pass', newSessionId: fresh.id, mode: 'conversation_only', filesPreserved: true }
      assert.equal(result.evidence.compact.status, 'pass', 'Nonempty live compaction did not succeed; see native command evidence')
      await ui.stop()
    })
  } catch (error) { report.setupError = error.message; process.exitCode = 1 }
  finally {
    await cleanup(); report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.parse(report.finishedAt) - Date.parse(report.startedAt); await save()
    if (report.scenarios.some(result => result.status === 'fail')) process.exitCode = 1
    console.log(JSON.stringify({ provider: args.provider, model: args.model, results: join(args.out, 'results.json'), scenarios: report.scenarios.map(({ name, status }) => ({ name, status })), setupFailed: Boolean(report.setupError) }))
  }
}

if (process.argv[2] === '--live-mcp-fixture') await fixture(process.argv[3])
else if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main().catch(() => { console.error('Live acceptance setup failed; check arguments and private output. No credentials or configuration were printed.'); process.exitCode = 1 })
}
