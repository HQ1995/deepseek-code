#!/usr/bin/env node
/** The real dscode TUI binary against an installed remote profile, headless
 * and then interactive (tmux): sessions open in the remote workspace, a local
 * project's stdio MCP server is never sent, bash runs on the remote host, and
 * the interactive header names the remote workspace, not this directory.
 * Keyless loopback Messages fixture; needs the same approved host setup as
 * e2e-remote-installed.
 * Usage: e2e-remote-tui.mjs <extracted-runtime> <fresh-dsh-home> <config.json> <dscode-tui> */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { execFile, execFileSync } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { startLeader, writeMessagesReply } from './acp-leader.mjs'

const [runtime, home, configPath, tui] = process.argv.slice(2)
if (!runtime || !home || !configPath || !tui) throw new Error('usage: e2e-remote-tui.mjs <runtime> <dsh-home> <config.json> <dscode-tui>')
const config = JSON.parse(await readFile(configPath, 'utf8'))
const execute = promisify(execFile)
// The workspace as the host resolves it: init stores that path, and remote tools report it.
const workspace = (await execute('ssh', ['-o', 'BatchMode=yes', config.host, `cd ${JSON.stringify(config.workspace)} && pwd -P`])).stdout.trim()
const KEY = 'loopback-fixture-only', MARKER = 'REMOTE_HEADLESS_OK'
const local = await mkdtemp(join(tmpdir(), 'dscode-remote-tui-'))
let step = 0, failure, toolResult = ''
const server = createServer((request, response) => {
  void (async () => {
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const results = body.messages.flatMap(message => Array.isArray(message.content) ? message.content : []).filter(block => block.type === 'tool_result')
    // Session-title requests carry no tools; answer them outside the turn.
    const title = (body.tools ?? []).length === 0
    const tool = !title && step === 0 ? 'bash' : undefined
    if (!title && step === 1) toolResult = JSON.stringify(results.at(-1))
    if (!title) assert.ok(step++ < 2, 'unexpected model loop')
    writeMessagesReply(response, { id: 'msg-' + step, callId: 'call-' + step, model: body.model, tool,
      args: { command: 'pwd; uname -s', description: 'Show the remote workspace' }, text: title ? 'Remote title' : MARKER })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
const baseEnv = { ...process.env, DSH_HOME: home, HOME: home, DSH_TELEMETRY_DISABLED: '1' }
for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_BASE_URL', 'NODE_OPTIONS', 'DSCODE_SOCKET']) delete baseEnv[name]
try {
  // Profile preparation as a user would do it: remote rows, then the provider.
  const launcher = join(home, 'profiles/dscode/node_modules/@hqzhao95/dscode/bin/dscode.mjs')
  await execute(process.execPath, [launcher, 'remote', 'init', '--host', config.host, '--workspace', config.workspace, '--node', config.node,
    '--helper', config.helper, '--helper-hash', config.helperHash, '--bootstrap', config.bootstrapPath, '--bootstrap-hash', config.bootstrapHash], { env: baseEnv })
  const modelId = await prepareProvider()
  await writeFile(join(local, '.mcp.json'), JSON.stringify({ mcpServers: { local: { command: '/usr/bin/true' } } }))
  const socket = `/tmp/dscode-remote-headless-${process.pid}.sock`
  const { stdout } = await execute(tui, ['-p', 'remote headless', '--output-format', 'json', '--always-approve', '--model', modelId], {
    cwd: local, timeout: 180_000, maxBuffer: 8 * 1024 * 1024,
    env: { ...baseEnv, DSC_HOME: join(home, 'dsc'), DSH_BIN: join(runtime, 'bin/dsh'), DSCODE_SOCKET: socket, TERM: 'xterm-256color', NO_COLOR: '1' },
  }).catch(error => { throw new Error('headless run failed: ' + (error.stderr || error.message) + (failure ? '\nfixture: ' + (failure.stack ?? failure) : '')) })
  if (failure) throw failure
  assert.equal(JSON.parse(stdout).text, MARKER)
  assert.match(toolResult, new RegExp(workspace.replace(/[/.]/g, '\\$&') + '[\\s\\S]*Linux'))
  const checks = ['headless: the session opened in the remote workspace (a local stdio MCP server would have been refused)', 'headless: bash ran on the remote host']
  await interactive(modelId)
  checks.push('interactive: the header names the remote workspace and a remote turn completes')
  console.log(JSON.stringify({ node: process.version, passed: true, checks }))
} finally {
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
  await rm(local, { recursive: true, force: true })
}

/** Boot the interactive TUI in tmux from the local project and run one turn. */
async function interactive(modelId) {
  step = 0; toolResult = ''
  const session = 'dscode-remote-tui-' + process.pid
  const tmux = (...args) => execFileSync('tmux', ['-L', session, '-f', '/dev/null', ...args], { encoding: 'utf8' })
  const vars = { DSH_HOME: home, HOME: home, DSC_HOME: join(home, 'dsc'), DSH_BIN: join(runtime, 'bin/dsh'), DSCODE_SOCKET: `/tmp/dscode-remote-tui-${process.pid}.sock`,
    DSH_TELEMETRY_DISABLED: '1', TERM: 'xterm-256color', NO_COLOR: '1', PATH: process.env.PATH }
  const command = ['exec', 'env', ...Object.entries(vars).map(([key, value]) => `${key}=${JSON.stringify(value)}`), JSON.stringify(tui), '--always-approve', '--model', JSON.stringify(modelId)].join(' ')
  tmux('new-session', '-d', '-s', session, '-x', '160', '-y', '40', '-c', local, command)
  const capture = () => tmux('capture-pane', '-p', '-t', session + ':0.0')
  const wait = async (pattern, label) => {
    for (let elapsed = 0; elapsed < 120_000; elapsed += 250) {
      const screen = capture()
      if (pattern.test(screen)) return screen
      await new Promise(resolve => setTimeout(resolve, 250))
    }
    throw new Error('interactive TUI never showed ' + label + '\n' + capture())
  }
  try {
    // Nothing is loaded from this directory, so no trust question may appear.
    const boot = await wait(/always-approve|trust the contents/, 'its composer footer')
    assert.doesNotMatch(boot, /trust the contents/, 'a remote workspace must not ask to trust the local directory')
    tmux('send-keys', '-t', session + ':0.0', 'remote interactive', 'Enter')
    const screen = await wait(new RegExp(MARKER), 'the fixture reply')
    if (failure) throw failure
    const header = screen.split('\n').find(line => line.trim().length > 0) ?? ''
    assert.ok(header.includes(workspace), 'header must name the remote workspace: ' + header)
    assert.ok(!screen.includes(local), 'the local launch directory must not appear: ' + header)
    assert.match(toolResult, new RegExp(workspace.replace(/[/.]/g, '\\$&') + '[\\s\\S]*Linux'))
  } finally {
    try { tmux('kill-server') } catch { /* already gone */ }
  }
}

/** Start a leader for the profile, add the loopback native provider, and stop it. */
async function prepareProvider() {
  const socketPath = `/tmp/dscode-remote-prep-${process.pid}.sock`
  const host = startLeader({ runtime, socketPath, env: { ...baseEnv, DSCODE_SOCKET: socketPath }, clientType: 'remote-prep', startupPolls: 300, killAfterMs: Infinity })
  const { rpc } = host
  try {
    await host.ready
    const { sessionId } = await rpc('session/new', { cwd: workspace, mcpServers: [] })
    await rpc('x.ai/providers/add', { id: 'deepseek-official', api: 'deepseek-native', apiKey: KEY, baseURL: origin + '/anthropic', credentialSource: 'saved' })
    const model = (await rpc('x.ai/models/list', { sessionId })).availableModels.find(item => item._meta?.provider === 'deepseek-official')
    assert.ok(model, 'native model listed')
    await rpc('session/close', { sessionId })
    return model.modelId
  } finally {
    await host.stop()
  }
}
