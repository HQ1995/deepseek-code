/** Launch-only adapter over native SessionResources, Scope and MCP lifecycle
 * owners: one isolated headless browser per top-level Session. */
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importRuntime } from '../shared/runtime-modules.mjs'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import { browserOperation } from './operation.mjs'
import { prefix, serverName } from './policy.mjs'

const { BrowserUseProviderName } = await importRuntime('@deepseek-ai/dsh-browser-use/brand')
const { SessionResources } = await importRuntime('@deepseek-ai/dsh-experimental-browser-use-runtime')

/** Subagents and forks share their parent's tools but never start a browser. */
const topLevel = agent => agent.session?.header?.parentSession === undefined

/**
 * @param options.launch - per-open launch arguments from the live config; throws a user-facing error.
 * @param options.onChange - observes the live session count.
 * @param options.onError - receives why a Session's browser could not start.
 */
export function mountBrowserSessions(ctx, options) {
  const clients = new Map()
  let resources
  ctx.effect(function* () {
    yield ctx.browserUse.register(BrowserUseProviderName('playwright-mcp'))
    resources = new SessionResources(ctx, {
      label: 'dscode-browser', exclusive: false,
      async open(agent, signal) {
        const scope = createScope(ctx, agent)
        const outputDir = await mkdtemp(join(tmpdir(), 'dscode-browser-'))
        let closing
        // One cleanup: the MCP scope (and its browser), then the private artifacts.
        const state = { closed: false, close: () => closing ??= (async () => {
          try { await scope.dispose() } finally { await rm(outputDir, { recursive: true, force: true }) }
        })() }
        const cancel = () => { state.closed = true; void state.close().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio', serverName, command: process.execPath,
            args: options.launch(outputDir), env: options.env, cwd: agent.session.header.cwd,
            toolCallTimeoutMs: options.toolCallTimeoutMs,
            failOnStartupError: true, reconnect: { enabled: false },
          }))
          signal.throwIfAborted()
          clients.set(agent, state)
          options.onChange?.(clients.size)
          return { value: state, async close() {
            state.closed = true
            await state.close()
            clients.delete(agent)
            options.onChange?.(clients.size)
          } }
        } catch (error) { await state.close(); throw error }
        finally { signal.removeEventListener('abort', cancel) }
      },
    })
    yield () => resources.dispose()
  }, 'dscode-browser.sessions')
  // A browser that cannot start must not fail Session creation: the Session
  // keeps working without browser tools and the reason is reported.
  ctx.on('agent/created', async ({ agent, signal }) => {
    if (!topLevel(agent)) return
    try { await resources.get(agent, signal) } catch (error) {
      if (signal?.aborted) throw error
      options.onError?.(error instanceof Error ? error.message : String(error))
    }
  }, { prepend: true })
  ctx.on('tools/execute', async (exec, next) => {
    if (!exec.name.startsWith(prefix)) return next()
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
