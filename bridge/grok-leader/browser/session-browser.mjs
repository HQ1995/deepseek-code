/** Launch-only adapter over native SessionResources, Scope and MCP lifecycle
 * owners: one isolated headless browser per top-level Session. */
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importRuntime } from '../shared/runtime-modules.mjs'
import * as McpClient from '@deepseek-ai/dsh-mcp-client'
import { createScope } from '@deepseek-ai/dsh-scope'
import { browserOperation } from './operation.mjs'
import { hiddenTool, OUTPUT_PREFIX, prefix, serverName, withoutAnsi } from './policy.mjs'

const { BrowserUseProviderName } = await importRuntime('@deepseek-ai/dsh-browser-use/brand')
const { SessionResources } = await importRuntime('@deepseek-ai/dsh-experimental-browser-use-runtime')

/** Subagents and forks share their parent's tools but never start a browser. */
const topLevel = agent => agent.session?.header?.parentSession === undefined

/**
 * @param options.launch - per-open `{ args, policy }` from the live config; throws a user-facing error.
 * @param options.onChange - observes the live session count.
 * @param options.onError - receives why a Session's browser could not start.
 * @returns `launched(agent)`: the origin policy that agent's open browser started with.
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
        // Resolved: Playwright names its files relative to its cwd, and a
        // symlinked temp dir (macOS /var -> /private/var) would print each
        // name as a climb to the root through this private path.
        const outputDir = await realpath(await mkdtemp(join(tmpdir(), OUTPUT_PREFIX)))
        let closing
        // One cleanup: the MCP scope (and its browser), then the private artifacts.
        const state = { closed: false, close: () => closing ??= (async () => {
          try { await scope.dispose() } finally { await rm(outputDir, { recursive: true, force: true }) }
        })() }
        const cancel = () => { state.closed = true; void state.close().catch(() => {}) }
        signal.addEventListener('abort', cancel, { once: true })
        try {
          signal.throwIfAborted()
          const { args, policy } = options.launch(outputDir)
          state.policy = policy
          // The private output directory is also the server's working and file root.
          await scope.ctx.plugin(McpClient, McpClient.Config({
            transport: 'stdio', serverName, command: process.execPath,
            args, env: options.env, cwd: outputDir,
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
    return withoutAnsi(await resources.run(agent, exec.signal, (state, signal) => browserOperation(state, signal, async combined => {
      const original = exec.signal
      exec.signal = combined
      try { return await next() } finally { exec.signal = original }
    }, options.toolCallTimeoutMs)))
  })
  // The model sees only the reviewed operations; a closed browser drops its instructions.
  ctx.on('system-prompt/assemble', async (_assembly, { agent }, next) => {
    const assembly = await next()
    const closed = agent !== undefined && clients.get(agent)?.closed === true
    if (!closed && !assembly.tools.some(tool => hiddenTool(tool.name))) return assembly
    return { ...assembly,
      sections: closed ? assembly.sections.filter(section => section.name !== 'mcp:playwright-mcp') : assembly.sections,
      tools: assembly.tools.filter(tool => !hiddenTool(tool.name)) }
  })
  return { launched: agent => clients.get(agent)?.policy }
}
