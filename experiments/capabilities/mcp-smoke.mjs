/** Real stdio resource-only MCP, native and PTC calls, scope isolation and teardown. */
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { releaseSdk } from '../../scripts/release-sdk.mjs'

const { sdk, mount } = releaseSdk(process.argv[2])
const { Context } = await sdk('@deepseek-ai/cordis')
const { ToolCallId } = await sdk('@deepseek-ai/dsh-llm')
const root = await mkdtemp(join(tmpdir(), 'dscode-mcp-resources-'))
const ctx = new Context()
const handles = []
let sequence = 0
const call = (agent, name, args) => ctx.tools.execute({ agent, name, arguments: args,
  callId: ToolCallId('resource-' + ++sequence), signal: AbortSignal.timeout(15_000) })
const text = result => result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
const ok = result => { assert.equal(result.isError, false, text(result)); return text(result) }
try {
  await mkdir(join(root, 'workspace'))
  for (const name of ['system-prompt', 'tools', 'llm', 'session', 'agent', 'session-projection', 'fs-local', 'subprocess-local', 'sandbox-local', 'sandbox-policy', 'ptc-runtime-node', 'mcp-resources']) {
    await mount(ctx, name, name === 'sandbox-policy' ? { mode: 'read-only', workspaceRoot: root } : {})
  }
  await mount(ctx, 'agent-loop', { agents: [] })
  assert.equal(ctx.tools.schemas().some(tool => tool.name === 'read_mcp_resource'), false)
  for (const sessionId of ['resource-owner', 'resource-other']) {
    handles.push(await ctx.agents.create({ sessionId, meta: { cwd: root }, agentOptions: {} }))
  }
  const [owner, other] = handles.map(handle => handle.agent)
  const client = await mount(owner.ctx, 'mcp-client', { transport: 'stdio', serverName: 'documents',
    command: process.execPath, args: [fileURLToPath(new URL('../../bridge/grok-leader/tests/fixtures/mcp-server.mjs', import.meta.url)), '--resources-only'],
    cwd: root, env: {}, failOnStartupError: true })
  const names = ctx.tools.schemas(owner).map(tool => tool.name)
  assert.deepEqual(names.filter(name => name.includes('mcp')).sort(), ['list_mcp_resource_templates', 'list_mcp_resources', 'read_mcp_resource'])
  assert.equal(ctx.tools.schemas(other).some(tool => tool.name === 'read_mcp_resource'), false)
  assert.match(ok(await call(owner, 'list_mcp_resources', { server: 'documents' })), /fixture:\/\/readme/)
  assert.match(ok(await call(owner, 'list_mcp_resource_templates', { server: 'documents' })), /fixture:\/\/record\/\{id\}/)
  assert.match(ok(await call(owner, 'read_mcp_resource', { server: 'documents', uri: 'fixture://record/42' })), /Resource fixture:\/\/record\/42/)
  assert.equal((await call(other, 'read_mcp_resource', { server: 'documents', uri: 'fixture://readme' })).isError, true)
  const restore = owner.ctx.tools.presentAs('both')
  try {
    assert.match(ok(await call(owner, 'run_code', { code: "return await tools.read_mcp_resource({server: 'documents', uri: 'fixture://readme'});", description: 'Read resource through PTC' })), /Resource fixture:\/\/readme/)
  } finally { restore() }
  await client.dispose()
  assert.equal(ctx.tools.schemas(owner).some(tool => tool.name === 'read_mcp_resource'), false)
  console.log(JSON.stringify({ node: process.version, resourceOnly: true, native: 'passed', templates: 'passed', ptc: 'passed', isolation: 'passed', unmount: 'passed' }))
} finally {
  for (const handle of handles.reverse()) await handle.dispose()
  await ctx.fiber.dispose()
  await rm(root, { recursive: true })
}
