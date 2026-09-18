#!/usr/bin/env node
// Launch-level companion to bench-leader-compile-cache.mjs: the whole path a
// user waits through, driven by the real TUI and a loopback gateway, with the
// leader's Node compile cache off, cold and warm. The TUI is a Rust binary, so
// the cache can only move the leader share; everything measured here is local
// loopback, not provider latency.
//
// Each launch is a fresh TUI process (tmux pane) against an installed profile
// home, and the fixture is self-contained: the script writes the workspace, the
// dsc-tui config and the provider settings it needs, and removes exactly those
// session directories afterwards. Markers are asserted, not assumed: the
// disabled condition must leave the cache directory untouched, the first
// enabled launch must populate it from empty, and every warm launch must reuse
// it without rewriting it.
//
// usage: node scripts/bench-launch-compile-cache.mjs <tui-bin> <dsh-bin> <dsh-home> [pairs=6] [--port=N] [--out=DIR]
//   <dsh-home> must hold an installed dscode profile (profiles/dscode) and no
//   settings.yaml of its own; the TUI and dsh binaries are used as given.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

const argv = process.argv.slice(2)
const option = name => { const hit = argv.find(value => value.startsWith(`--${name}=`)); return hit?.slice(name.length + 3) }
const [tuiBin, dshBin, home, pairsArg] = argv.filter(value => !value.startsWith('--'))
assert.ok(tuiBin && dshBin && home, 'usage: node scripts/bench-launch-compile-cache.mjs <tui-bin> <dsh-bin> <dsh-home> [pairs=6] [--port=N] [--out=DIR]')
const pairs = Number(pairsArg ?? 6)
assert.ok(existsSync(join(home, 'profiles/dscode/package.json')), `${home} lacks an installed dscode profile`)
const settingsPath = join(home, 'settings.yaml')
assert.ok(!existsSync(settingsPath), `${settingsPath} already exists; refusing to overwrite provider settings`)
const out = option('out') ?? join(tmpdir(), `dsclcc-${process.pid}`)
const port = Number(option('port') ?? 26000 + (process.pid % 16000))
const timeoutMs = Number(option('timeout') ?? 120000)
const ws = join(out, 'ws')
const dscTui = join(out, 'dsc-tui')
const cache = join(out, 'compile-cache')
const gatewayLog = join(out, 'gateway.log')
const reply = 'CC_LAUNCH_OK'
assert.ok(spawnSync('tmux', ['-V']).status === 0, 'tmux is required')
mkdirSync(out, { recursive: true })
mkdirSync(ws, { recursive: true })
mkdirSync(dscTui, { recursive: true })
spawnSync('git', ['init', '-q'], { cwd: ws })
writeFileSync(join(dscTui, 'trusted_folders.toml'), `[folders."${ws}"]\ntrusted = true\ndecided_at = 0\n`)
writeFileSync(join(dscTui, 'config.toml'), '[cli]\nauto_update = false\n')
writeFileSync(settingsPath, `llm-pi-ai:
  providers:
    fake:
      displayName: Fake Gateway
      apiKeyEnv: FAKE_KEY
      api: openai-completions
      baseURL: http://127.0.0.1:${port}/v1
      models:
        - name: Fake Model
          id: fake-model
          contextWindow: 32768
          input:
            - text
agent-default-model:
  provider: fake
  model: fake-model
`)

// Minimal OpenAI-compatible stream: one reply per turn, timestamped, so the
// driver can separate client render from provider wait. Loopback only.
const gatewayPath = join(out, 'gateway.mjs')
writeFileSync(gatewayPath, `import { appendFileSync } from 'node:fs'
import http from 'node:http'
const [portText, logPath, reply] = process.argv.slice(2)
const envelope = choices => JSON.stringify({ id: 'launch-bench', object: 'chat.completion.chunk', created: 1, model: 'fake-model', choices })
const text = (value, finish = null, usage) => envelope([{ index: 0, delta: value === '' ? {} : { role: 'assistant', content: value }, finish_reason: finish }], usage)
http.createServer((request, response) => {
  let body = ''
  request.on('data', part => { body += part })
  request.on('end', () => {
    const path = request.url?.split('?')[0] ?? ''
    appendFileSync(logPath, 'REQ ' + request.method + ' ' + path + ' ' + Date.now() + '\\n')
    if (request.method !== 'POST' || !path.endsWith('/chat/completions')) { response.writeHead(404); response.end(); return }
    const title = body.includes('Create a concise title')
    appendFileSync(logPath, (title ? 'TITLE ' : 'TURN ') + Date.now() + '\\n')
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    response.write('data: ' + text(title ? 'CC Session' : reply) + '\\n\\n')
    response.write('data: ' + text('', 'stop', { prompt_tokens: 24, completion_tokens: 4 }) + '\\n\\n')
    response.end('data: [DONE]\\n\\n')
  })
}).listen(Number(portText), '127.0.0.1', () => appendFileSync(logPath, 'READY\\n'))
`)

writeFileSync(gatewayLog, '')
const gateway = spawn(process.execPath, [gatewayPath, String(port), gatewayLog, reply], { stdio: ['ignore', 'ignore', 'inherit'] })
// The gateway must not hold the event loop open: it is stopped from cleanup().
gateway.unref()
const sessions = []
const tmux = (args, server) => spawnSync('tmux', ['-L', server, ...args], { encoding: 'utf8' })
const killLeader = pid => { if (!Number.isInteger(pid)) return; try { process.kill(pid, 'SIGKILL') } catch {} }
const cleanup = () => {
  gateway.kill('SIGTERM')
  rmSync(settingsPath, { force: true })
  // Only the sessions this run created are removed, so a home that is not a
  // scratch copy keeps its own history.
  for (const id of sessions) {
    for (const root of existsSync(join(home, 'sessions')) ? readdirSync(join(home, 'sessions')) : []) {
      const dir = join(home, 'sessions', root, id)
      rmSync(dir, { recursive: true, force: true })
    }
  }
}
process.on('exit', cleanup)

const waitFor = async (test, timeoutMs, label, tick = 5) => {
  const start = performance.now()
  for (;;) {
    const hit = test()
    if (hit) return hit
    if (performance.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`)
    await new Promise(next => setTimeout(next, tick))
  }
}
await waitFor(() => readFileSync(gatewayLog, 'utf8').includes('READY'), 10000, 'gateway READY')

const cacheStats = dir => {
  let files = 0, bytes = 0
  const walk = path => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) walk(child)
      else { files += 1; bytes += statSync(child).size }
    }
  }
  if (existsSync(dir)) walk(dir)
  return { files, bytes }
}

async function launch(label, enabled) {
  const server = `dsclcc-${process.pid}-${label}`
  const socket = join(out, `${label}.sock`)
  const lock = `${socket.slice(0, -5)}.lock`
  const log = join(out, `${label}.leader.log`)
  for (const path of [socket, lock, log]) rmSync(path, { force: true })
  tmux(['kill-server'], server)
  const sessionId = spawnSync(process.execPath, ['-e', 'console.log(crypto.randomUUID())'], { encoding: 'utf8' }).stdout.trim()
  sessions.push(sessionId)
  const env = [
    `HOME=${home}`, `DSH_HOME=${home}`, `DSC_HOME=${dscTui}`, `DSCODE_SOCKET=${socket}`, `DSCODE_LOG=${log}`,
    `DSH_BIN=${dshBin}`, 'FAKE_KEY=launch-bench', 'DSH_TELEMETRY_DISABLED=1', 'NO_COLOR=1', 'TERM=xterm-256color', 'TERM_PROGRAM=WezTerm',
    `NODE_COMPILE_CACHE=${cache}`, ...(enabled ? [] : ['NODE_DISABLE_COMPILE_CACHE=1']),
  ]
  const before = cacheStats(cache)
  writeFileSync(gatewayLog, '')
  const started = performance.now()
  const startedWall = Date.now()
  const at = () => +(performance.now() - started).toFixed(1)
  writeFileSync(log, '')
  const session = tmux(['new-session', '-d', '-s', 'launch', '-x', '120', '-y', '40', '-c', ws, 'env', ...env,
    tuiBin, '--model', 'fake-model', '--no-plan', '--session-id', sessionId, 'say hello'], server)
  assert.equal(session.status, 0, `${label}: tmux new-session failed (${session.status}): ${(session.stderr ?? '').trim()}`)
  // The pane is watched, not driven: a client connection during boot would
  // change the thing being measured.
  const capture = () => tmux(['capture-pane', '-p', '-t', 'launch:0.0'], server)
  // A pane whose command cannot start closes silently, and a bare timeout
  // would hide that: report what the pane, the leader and the gateway did.
  const diagnose = reason => {
    const pane = capture()
    console.error('LAUNCH-FAILURE ' + JSON.stringify({
      label, reason, elapsedMs: at(), socketExists: existsSync(socket), lockExists: existsSync(lock),
      tmuxSessions: (tmux(['list-sessions'], server).stdout ?? '').trim(),
      paneStatus: pane.status, paneText: (pane.stdout ?? '').slice(0, 300), paneError: (pane.stderr ?? '').trim(),
      leaderLog: readFileSync(log, 'utf8').slice(0, 300), gatewayLog: readFileSync(gatewayLog, 'utf8').trim(),
    }))
  }
  // Two independent clocks: the leader's listening moment, and the first
  // painted frame (what a user sees). Both are watched, never driven.
  let socketMs, frameMs, turnMs, renderMs
  try {
    ;[socketMs, frameMs] = await Promise.all([
      waitFor(() => existsSync(socket) ? at() : undefined, timeoutMs, `${label}: leader socket`),
      waitFor(() => /\S/.test(capture().stdout ?? '') ? at() : undefined, timeoutMs, `${label}: first frame`, 20),
    ])
    turnMs = await waitFor(() => readFileSync(gatewayLog, 'utf8').includes('TURN ') ? at() : undefined, timeoutMs, `${label}: turn request`)
    renderMs = await waitFor(() => {
      return (capture().stdout ?? '').includes(reply) ? at() : undefined
    }, timeoutMs, `${label}: rendered reply`, 20)
  } catch (error) {
    diagnose(String(error?.message ?? error))
    throw error
  }
  writeFileSync(join(out, `${label}.pane.txt`), capture().stdout ?? '')
  tmux(['kill-server'], server)
  const leaderPid = Number(readFileSync(lock, 'utf8').trim())
  const deadline = performance.now() + 4000
  while (performance.now() < deadline) {
    try { process.kill(leaderPid, 0) } catch { break }
    await new Promise(next => setTimeout(next, 50))
  }
  killLeader(leaderPid)
  for (const path of [socket, lock]) rmSync(path, { force: true })
  const after = cacheStats(cache)
  if (!enabled) assert.equal(after.files, before.files, `${label}: the disabled cache still changed (${before.files} -> ${after.files})`)
  else if (before.files === 0) assert.ok(after.files > 0, `${label}: the enabled cache stayed empty, so the launch never used it`)
  else assert.equal(after.files, before.files, `${label}: a warm launch rewrote the cache (${before.files} -> ${after.files})`)
  // Per-launch gateway timeline, in milliseconds from this launch's start, so
  // the window between the leader's socket and the first frame can be
  // attributed to the requests the product actually makes.
  const requests = readFileSync(gatewayLog, 'utf8').split('\n').filter(line => line.startsWith('REQ '))
    .map(line => { const [, method, path, ts] = line.split(' '); return { method, path, ms: +(Number(ts) - startedWall).toFixed(1) } })
  return { label, socketMs, frameMs, turnMs, renderMs, requests, cache: after }
}

const result = { node: process.version, tuiBin, dshBin, home, pairs, cache, off: [], cold: null, warm: [] }
// One throwaway launch per side settles page cache and first-run state before
// the measured pairs alternate order.
await launch('warmup-off', false)
result.cold = await launch('cold', true)
await launch('warmup-warm', true)
for (let i = 0; i < pairs; i++) {
  for (const side of i % 2 ? ['warm', 'off'] : ['off', 'warm']) {
    result[side].push(await launch(`${side}-${i}`, side === 'warm'))
  }
}
const median = values => {
  const sorted = values.slice().sort((a, b) => a - b), mid = (sorted.length - 1) / 2
  return +((sorted[Math.floor(mid)] + sorted[Math.ceil(mid)]) / 2).toFixed(1)
}
const summarize = rows => ({
  socketMedianMs: median(rows.map(row => row.socketMs)),
  frameMedianMs: median(rows.map(row => row.frameMs)),
  turnMedianMs: median(rows.map(row => row.turnMs)),
  renderMedianMs: median(rows.map(row => row.renderMs)),
  renderMinMs: Math.min(...rows.map(row => row.renderMs)),
  renderMaxMs: Math.max(...rows.map(row => row.renderMs)),
  launches: rows.length,
})
result.summary = { off: summarize(result.off), warm: summarize(result.warm) }
cleanup()
writeFileSync(join(out, 'launch-ab.json'), JSON.stringify(result, null, 2))
console.log(JSON.stringify(result, null, 2))
