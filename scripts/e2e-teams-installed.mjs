#!/usr/bin/env node
/** Installed dscode over ACP: the `teams` preset beside the others, against a
 * loopback Messages fixture through the native DeepSeek provider. Keyless.
 * Usage: e2e-teams-installed.mjs <extracted-runtime> <fresh-dsh-home-with-dscode>
 * DSCODE_TEAMS_SMOKE_HOST_TOOLS=1 is the negative control: a host-level Team
 * tools row (as upstream's agent-team profile adds) must fail the isolation check. */
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { existsSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startLeader, writeMessagesReply } from './acp-leader.mjs'

const [runtime, profileHome] = process.argv.slice(2)
if (!runtime || !profileHome) throw new Error('usage: e2e-teams-installed.mjs <runtime> <dsh-home>')
const workspace = await mkdtemp(join(tmpdir(), 'dscode-teams-installed-'))
const KEY = 'loopback-fixture-only'
const TEAM_TOOLS = ['spawn_teammate', 'send_message', 'list_agents', 'wait_agent', 'interrupt_agent', 'team_task_create', 'team_task_list', 'team_task_get', 'team_task_update']
const LEGACY = ['subagent', 'subagent_fork', 'workflow', 'ralph']
const POLICY = /create teammates only when the user explicitly asks to use Agent Teams or teammates/
const MARKER = 'TEAMMATE-FIXTURE'
let phase, step = 0, failure, teammateTurns = 0, task, nestedRefused = false
const checks = []

const server = createServer((request, response) => {
  void (async () => {
    assert.equal(request.url, '/anthropic/v1/messages')
    assert.equal(request.headers['x-api-key'], KEY)
    const chunks = []
    for await (const chunk of request) chunks.push(chunk)
    const body = JSON.parse(Buffer.concat(chunks))
    const names = body.tools.map(tool => tool.name)
    assert.equal(new Set(names).size, names.length, 'duplicate tool names: ' + names.join(', '))
    const last = JSON.stringify(body.messages.at(-1))
    let tool, args
    // The Lead's own requests carry MARKER inside its spawn_teammate call, so
    // only a conversation that opens with it is the teammate's.
    if (JSON.stringify(body.messages[0]).includes(MARKER)) {
      // The teammate's own turn: a Team member composed under the Lead's preset.
      assert.ok(TEAM_TOOLS.every(name => names.includes(name)), 'teammate tools: ' + names.join(', '))
      if (teammateTurns++ === 0) { tool = 'spawn_teammate'; args = { name: 'nested', description: 'Must be refused', prompt: 'Must be refused' } }
      else if (!nestedRefused) {
        assert.match(last, /"is_error":true/, 'a teammate must not spawn teammates')
        nestedRefused = true
      }
    } else if (phase === 'plain') {
      assert.ok(TEAM_TOOLS.slice(0, 1).concat(TEAM_TOOLS.slice(5)).every(name => !names.includes(name)), 'Team tools leaked into another preset: ' + names.join(', '))
      assert.ok(['subagent', 'send_message', 'list_agents'].every(name => names.includes(name)), 'standard delegation tools: ' + names.join(', '))
      assert.doesNotMatch(JSON.stringify(body.system), POLICY)
    } else {
      assert.ok(TEAM_TOOLS.every(name => names.includes(name)), 'Team tools: ' + names.join(', '))
      assert.ok(LEGACY.every(name => !names.includes(name)), 'legacy delegation beside Team tools: ' + names.join(', '))
      assert.match(JSON.stringify(body.system), POLICY)
      if (phase === 'team' && step === 0) { tool = 'team_task_create'; args = { subject: 'Check notes', description: 'Explicit test task', write_scopes: ['notes.md'] } }
      else if (phase === 'team' && step === 1) {
        assert.doesNotMatch(last, /"is_error":true/)
        task = JSON.parse(toolResultText(body))
        tool = 'team_task_update'; args = { task_id: task.id, expected_revision: task.revision, action: 'claim' }
      } else if (phase === 'team' && step === 2) {
        assert.doesNotMatch(last, /"is_error":true/)
        // The claim advanced the revision, so this update names a stale one.
        tool = 'team_task_update'; args = { task_id: task.id, expected_revision: task.revision, action: 'complete' }
      } else if (phase === 'team' && step === 3) {
        assert.match(last, /"is_error":true/, 'a stale task revision must be refused')
        tool = 'spawn_teammate'; args = { name: 'reviewer', description: 'Review notes', prompt: MARKER + ' Reply briefly.' }
      } else if (phase === 'team' && step === 4) assert.match(last, /reviewer/)
      // Later Lead turns are wake-ups for the teammate's deliveries; reply only.
      assert.ok(step++ < 8, 'unexpected model loop')
    }
    writeMessagesReply(response, { id: 'msg-' + (phase ?? 'x') + step, callId: 'call-' + phase + step, model: body.model, tool, args, text: 'Fixture reply' })
  })().catch(error => { failure ??= error; response.destroy(error) })
})
const toolResultText = body => {
  const block = body.messages.at(-1).content.find(item => item.type === 'tool_result')
  return typeof block.content === 'string' ? block.content : block.content.filter(item => item.type === 'text').map(item => item.text).join('')
}
server.listen(0, '127.0.0.1'); await once(server, 'listening')
const origin = `http://127.0.0.1:${server.address().port}`
// Test-only overlay: no title request, native tool calls. Never a deployment policy.
const testPatch = join(workspace, 'teams-test.patch.yml')
await writeFile(testPatch, '- id: session-title-llm\n  disabled: true\n- id: tools\n  config:\n    mode: native\n'
  + (process.env.DSCODE_TEAMS_SMOKE_HOST_TOOLS === '1' ? "- insert:\n    - id: host-tool-agent-team\n      name: '@deepseek-ai/dsh-experimental-tool-agent-team'\n" : ''))

async function launch(label) {
  const socketPath = `/tmp/dscode-teams-installed-${process.pid}-${label}.sock`
  assert.equal(existsSync(socketPath), false)
  const host = startLeader({ runtime, home: profileHome, socketPath, patches: [testPatch], clientType: 'teams-acceptance',
    onPermission: () => 'allow-once', failure: () => failure, rpcTimeoutMs: 45_000 })
  await host.ready
  return host
}

const nativeModel = async (host, sessionId) => {
  const model = (await host.rpc('x.ai/models/list', { sessionId })).availableModels.find(item => item._meta?.provider === 'deepseek-official')
  assert.ok(model, 'native DeepSeek model listed')
  await host.rpc('session/set_model', { sessionId, modelId: model.modelId })
}
const open = async (host, preset) => {
  const { sessionId } = await host.rpc('session/new', { cwd: workspace, mcpServers: [], ...preset === undefined ? {} : { _meta: { agentPreset: preset } } })
  await nativeModel(host, sessionId)
  return sessionId
}
const prompt = (host, sessionId, label) => { phase = label; step = 0; return host.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text: label }] }) }
const command = async (host, sessionId, text) => {
  const before = host.notes.length
  await host.rpc('session/prompt', { sessionId, prompt: [{ type: 'text', text }] })
  return host.notes.slice(before).filter(note => note.params?.sessionId === sessionId)
    .map(note => note.params?.update?.content?.text ?? '').join('\n')
}
const commandsOf = (host, sessionId) => host.notes.filter(note => note.params?.sessionId === sessionId && note.params?.update?.sessionUpdate === 'available_commands_update').at(-1)?.params.update
const until = async (label, predicate) => {
  for (let i = 0; i < 150; i++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 100)) }
  throw new Error('timed out waiting for ' + label)
}

let host = await launch('first')
try {
  const bootstrap = await host.rpc('session/new', { cwd: workspace, mcpServers: [] })
  await host.rpc('x.ai/providers/add', { id: 'deepseek-official', api: 'deepseek-native', apiKey: KEY, baseURL: origin + '/anthropic', credentialSource: 'saved' })
  const listed = (await host.rpc('x.ai/presets', { sessionId: bootstrap.sessionId, action: 'list' })).items.map(item => item.id)
  assert.deepEqual([...listed].sort(), ['cordis', 'history', 'lsp', 'minimal', 'ptc', 'standard', 'teams', 'terminal'])
  await host.rpc('session/close', { sessionId: bootstrap.sessionId })
  checks.push('teams is listed beside all seven dscode presets')

  const plain = await open(host)
  const doctor = (await host.rpc('x.ai/doctor', { sessionId: plain, tuiVersion: '0.0.14-alpha.12' })).text
  assert.equal(/\[WARN\] Agent Teams: Host-level Team tools/.test(doctor), process.env.DSCODE_TEAMS_SMOKE_HOST_TOOLS === '1', doctor)
  assert.equal((await prompt(host, plain, 'plain')).stopReason, 'end_turn')
  assert.ok(!commandsOf(host, plain).availableCommands.some(item => item.name === 'team'))
  checks.push('standard sessions keep legacy delegation and get no Team tools, policy or /team')

  const team = await open(host, 'teams')
  assert.equal((await prompt(host, team, 'team')).stopReason, 'end_turn')
  await until("the teammate's refused nested spawn", () => nestedRefused)
  const spawned = host.notes.find(note => note.params?.sessionId === team && note.params.update?.sessionUpdate === 'subagent_spawned')?.params.update
  assert.ok(spawned, 'teammate child notification')
  assert.equal(spawned.persona, 'reviewer'); assert.equal(spawned.role, 'teammate')
  const commands = commandsOf(host, team)
  assert.ok(commands.availableCommands.some(item => item.name === 'team'))
  assert.equal(commands._meta.capabilities.includes('subagents'), false, '/btw stays off in Teams')
  const board = await command(host, team, '/team')
  assert.match(board, /^- reviewer \(teammate [0-9a-f]{8}\) · /m)
  assert.match(board, /Check notes · in progress/)
  checks.push('teams: nine Team tools and policy, task claimed and a stale revision refused, teammate created and its nested spawn refused, persona on the child row, /team board, no /btw')

  const cleared = await command(host, team, '/subagents clear ' + spawned.subagent_id).catch(error => error.message)
  assert.match(cleared, /reviewer is an Agent Team member/)
  checks.push('queued Team deliveries cannot be cleared or edited by hand')

  // Sessions on different presets stay isolated, also across a live plugin-row reconcile.
  await command(host, plain, '/browser on --origin http://127.0.0.1:9')
  await command(host, plain, '/browser off')
  assert.equal((await prompt(host, plain, 'plain')).stopReason, 'end_turn')
  assert.equal((await prompt(host, team, 'team-again')).stopReason, 'end_turn')
  checks.push('isolation holds with both sessions live and after a live plugin-row reconcile')

  const blank = await open(host)
  await assert.rejects(command(host, blank, '/preset teams'), /attaches Agent Team tools when a session opens/)
  const blankTeam = await open(host, 'teams')
  assert.doesNotMatch(await command(host, blankTeam, '/team'), /Check notes|reviewer/, "another Lead's board")
  await assert.rejects(command(host, blankTeam, '/preset history'), /cannot be switched in place/)
  await assert.rejects(host.rpc('x.ai/presets', { sessionId: blank, action: 'copy', from: 'teams', id: 'teams-copy' }), /carries Agent Team tools/)
  // The TUI picker reopens the session with the chosen preset.
  await host.rpc('session/load', { sessionId: blank, cwd: workspace, mcpServers: [], _meta: { agentPreset: 'teams' } })
  await nativeModel(host, blank)
  assert.equal((await prompt(host, blank, 'team-again')).stopReason, 'end_turn')
  checks.push("another Lead sees none of this Team; in-place /preset switches and copies of teams are refused; reopening with teams attaches the tools")
  assert.doesNotMatch(host.diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  await host.stop()

  host = await launch('second')
  await host.rpc('session/load', { sessionId: team, cwd: workspace, mcpServers: [] })
  await nativeModel(host, team)
  assert.equal((await prompt(host, team, 'team-again')).stopReason, 'end_turn')
  const reloaded = await command(host, team, '/team')
  assert.match(reloaded, /^- reviewer \(teammate [0-9a-f]{8}\) · /m)
  assert.match(reloaded, /Check notes · in progress/)
  checks.push('a restarted leader reloads the Team session with its tools, durable roster and task board')
  assert.doesNotMatch(host.diagnostics, /failed to import|duplicate service|unresolved|did not activate/i)
  if (failure) throw failure
  console.log(JSON.stringify({ node: process.version, passed: true, checks, workspace }))
} catch (error) {
  throw new Error(`${error.message}\n--- leader diagnostics ---\n${host.diagnostics}`, { cause: error })
} finally {
  await host.stop()
  server.closeAllConnections(); await new Promise(resolve => server.close(resolve))
}
