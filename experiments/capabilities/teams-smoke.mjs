/** Native Team tools, persistence, cross-team isolation and task CAS; no external LLM. */
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { releaseSdk } from './runtime.mjs'

const { sdk, mount } = releaseSdk(process.argv[2])
const { Context } = await sdk('@deepseek-ai/cordis')
const { LlmAdapter, ToolCallId } = await sdk('@deepseek-ai/dsh-llm')
const root = await mkdtemp(join(tmpdir(), 'dscode-teams-'))
const ctx = new Context()
const owners = []
let sequence = 0
const call = (agent, name, args = {}) => ctx.tools.execute({ agent, name, arguments: args,
  callId: ToolCallId('team-' + ++sequence), signal: AbortSignal.timeout(15_000) })
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const value = result => { assert.equal(result.isError, false, text(result)); return JSON.parse(text(result)) }
const firstTurn = Promise.withResolvers()
let holdFirstTurn = true
class Model extends LlmAdapter {
  async resolveModel(provider, id) { return { provider, id, name: id } }
  async *stream() {
    if (holdFirstTurn) await firstTurn.promise
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: 'Teammate finished.' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Teammate finished.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}
try {
  for (const name of ['system-prompt', 'tools', 'llm', 'session', 'agent', 'session-projection', 'subagent']) await mount(ctx, name)
  await mount(ctx, 'session-persistence-jsonl', { root: join(root, 'sessions') })
  await mount(ctx, 'agent-loop', { agents: [] })
  await mount(ctx, 'subagent-spawn-in-process', { providerName: 'spawn' })
  await mount(ctx, 'subagent-fork-in-process', { providerName: 'fork' })
  await mount(ctx, 'experimental-agent-team', { maxMembers: 8 })
  await mount(ctx, 'experimental-tool-agent-team')
  ctx.llm.registerAdapter(['fixture'], new Model())
  for (const sessionId of ['team-lead', 'other-lead']) owners.push(await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: { provider: 'fixture', model: 'fixture' } }))
  let lead = owners[0].agent
  const other = owners[1].agent
  const names = ctx.tools.schemas(lead).map(tool => tool.name)
  assert.equal(names.length, 9)
  assert.equal(new Set(names).size, 9)
  assert.equal(ctx.agentTeams.listMembers(lead).length, 1, 'merely enabling Teams must not create teammates')
  const task = value(await call(lead, 'team_task_create', { subject: 'Check fixture', description: 'Explicit test task', write_scopes: ['fixture.txt'] }))
  const claimed = value(await call(lead, 'team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'claim' }))
  assert.equal(claimed.status, 'in_progress')
  assert.equal((await call(lead, 'team_task_update', { task_id: task.id, expected_revision: task.revision, action: 'complete' })).isError, true)
  assert.equal((await call(other, 'team_task_get', { task_id: task.id })).isError, true)
  const completed = value(await call(lead, 'team_task_update', { task_id: task.id, expected_revision: claimed.revision, action: 'complete' }))
  assert.equal(completed.status, 'completed')
  const { member: teammate } = value(await call(lead, 'spawn_teammate', { name: 'reviewer', description: 'Review fixture only', prompt: 'Explicitly requested test teammate. Reply briefly.' }))
  // alpha.2 addresses members by name; the model-facing view carries no session id.
  assert.equal(teammate.target, 'reviewer')
  assert.equal(Object.hasOwn(teammate, 'id'), false)
  const child = ctx.agents.get(ctx.agentTeams.listMembers(lead).find(member => member.name === 'reviewer')?.id)
  assert.ok(child, JSON.stringify(teammate))
  assert.equal((await call(child, 'spawn_teammate', { name: 'nested', description: 'Must deny', prompt: 'Must deny' })).isError, true)
  holdFirstTurn = false; firstTurn.resolve()
  await child.whenIdle()
  const receipt = value(await call(lead, 'send_message', { target: 'reviewer', message: 'One follow-up; do not resend.' }))
  assert.ok(['accepted', 'queued'].includes(receipt.status), JSON.stringify(receipt))
  await child.whenIdle()
  await ctx.sessions.flush(lead.session)
  await owners[0].dispose()
  const resumed = await ctx.agents.resume({ resumeSessionId: 'team-lead', agentOptions: { provider: 'fixture', model: 'fixture' } })
  owners[0] = resumed; lead = resumed.agent
  const restored = value(await call(lead, 'team_task_get', { task_id: task.id }))
  assert.equal(restored.status, 'completed')
  assert.equal(restored.revision, completed.revision)
  assert.equal(value(await call(lead, 'list_agents')).length, 2)
  console.log(JSON.stringify({ node: process.version, tools: 9, taskCas: 'passed', isolation: 'passed', leadAuthority: 'passed', teammate: 'passed', messaging: 'passed', resume: 'passed' }))
} finally {
  firstTurn.resolve()
  for (const owner of owners.reverse()) await owner.dispose()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true })
}
