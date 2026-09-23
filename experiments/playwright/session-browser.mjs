/** Launch-only adapter over native SessionResources, Scope and MCP lifecycle owners. */
import { BrowserUseProviderName } from '@deepseek-ai/dsh-browser-use/brand'
import { SessionResources } from '@deepseek-ai/dsh-experimental-browser-use-runtime'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import { browserOperation } from './operation.mjs'
import { prefix } from './policy.mjs'

export function mountBrowserSessions(ctx, options) {
  const clients = new Map()
  let resources
  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName('playwright-mcp'))
    resources = new SessionResources(ctx, {
      label: 'dscode-playwright', exclusive: false,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        let closing
        const state = { closed: false, close: () => closing ??= scope.dispose() }
        const cancel = () => { state.closed = true; void state.close().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio', serverName: 'playwright-mcp', command: process.execPath,
            args: options.args, env: options.env, cwd: agent.session.header.cwd,
            toolCallTimeoutMs: options.toolCallTimeoutMs,
            failOnStartupError: true, reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          clients.set(agent, state)
          return { value: state, async close() { state.closed = true; await state.close(); clients.delete(agent) } }
        } catch (error) { await state.close(); throw error }
        finally { signal.removeEventListener('abort', cancel) }
      },
    })
    yield () => resources.dispose()
  }, 'dscode-playwright.sessions')
  ctx.on('agent/created', async ({ agent, signal }) => { await resources.get(agent, signal) }, { prepend: true })
  ctx.on('tools/execute', async (exec, next) => {
    const resource = ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'].includes(exec.name)
      && exec.arguments?.server === 'playwright-mcp'
    if (!exec.name.startsWith(prefix) && !resource) return next()
    const agent = exec.agent
    if (!agent || !clients.has(agent)) throw new Error('Browser tool belongs to another live Session')
    return resources.run(agent, exec.signal, (state, signal) => browserOperation(state, signal, async combined => {
      const original = exec.signal
      exec.signal = combined
      try { return await next() } finally { exec.signal = original }
    }, options.toolCallTimeoutMs))
  })
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    if (!agent || !clients.get(agent)?.closed) return assembly
    return { ...assembly, sections: assembly.sections.filter(section => section.name !== 'mcp:playwright-mcp') }
  })
}
