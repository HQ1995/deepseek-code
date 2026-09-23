/** dscode's opt-in browser: an isolated headless Chromium per top-level
 * Session through Playwright MCP, a reviewed operation allowlist, native
 * approval for every call and cleanup on cancellation. Shipped disabled;
 * `/browser on` enables the row. It does not confine network or host access. */
import Schema from '@deepseek-ai/schemastery'
import { importRuntime, playwrightMcpCli } from './runtime-modules.mjs'
import { browserLaunchArgs, resolveBrowserExecutable } from './executable.mjs'
import { browserDenial, navigationPolicy, prefix } from './policy.mjs'
import { mountBrowserSessions } from './session-browser.mjs'

export const name = 'dscode-browser'
export const inject = ['agents', 'tools', 'systemPrompt']
// Volatile fields change live through the settings service (/browser):
// origins apply to the next call, the executable and sandbox to the next Session.
export const Config = Schema.object({
  executablePath: Schema.string().volatile(),
  navigationOrigins: Schema.array(Schema.string()).default([]).volatile(),
  anyOrigin: Schema.boolean().default(false).volatile(),
  sandbox: Schema.boolean().default(true).volatile(),
  toolCallTimeoutMs: Schema.number().min(1).max(2_147_483_647).default(30_000),
})

export async function apply(ctx, config) {
  /** An invalid saved origin denies navigation instead of disabling the plugin. */
  const policy = () => {
    try { return { policy: navigationPolicy(config.navigationOrigins.get() ?? [], config.anyOrigin.get()) } }
    catch (error) { return { error: error.message } }
  }
  const denial = exec => {
    const current = policy()
    if (current.error === undefined) return browserDenial(exec, current.policy)
    return browserDenial(exec, navigationPolicy()) ?? (exec.name.startsWith(prefix) ? current.error : undefined)
  }
  ctx.tools.guard(denial)
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!exec.name.startsWith(prefix) || decision.kind !== 'allow') return decision
    const reason = denial(exec)
    if (reason !== undefined) return { kind: 'deny', reason }
    return { kind: 'ask', reason: 'Browser action. Browser state is isolated per Session; network and host access are not confined.' }
  }, { prepend: true })
  const cli = playwrightMcpCli()
  const { default: BrowserUse } = await importRuntime('@deepseek-ai/dsh-browser-use')
  const env = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(key => [key, '']))
  let sessions = 0, lastError
  const executable = () => resolveBrowserExecutable(config.executablePath.get())
  ctx.effect(() => ctx.provide('dscodeBrowser', {
    status: () => {
      const current = policy(), found = executable()
      return {
        executable: found.path, executableSource: found.source, executableError: found.error,
        sandbox: config.sandbox.get() !== false,
        anyOrigin: config.anyOrigin.get() === true,
        origins: [...config.navigationOrigins.get() ?? []],
        ...current.error === undefined ? {} : { originError: current.error },
        sessions,
        ...lastError === undefined ? {} : { lastError },
      }
    },
  }))
  await ctx.plugin(BrowserUse)
  await ctx.plugin({ name: 'dscode-browser-sessions', inject: ['browserUse', 'agents', 'tools', 'systemPrompt'], async apply(owner) {
    mountBrowserSessions(owner, {
      launch: outputDir => {
        const found = executable()
        if (found.error !== undefined) throw new Error(found.error)
        // Validated again here: a hand-edited profile value never reaches Playwright unchecked.
        const current = navigationPolicy(config.navigationOrigins.get() ?? [], config.anyOrigin.get())
        return browserLaunchArgs({ cli, executablePath: found.path, sandbox: config.sandbox.get(), outputDir,
          origins: [...current.origins], anyOrigin: current.any })
      },
      env, toolCallTimeoutMs: config.toolCallTimeoutMs,
      onChange: count => { sessions = count; if (count > 0) lastError = undefined },
      onError: message => { lastError = message; ctx.logger?.warn?.('dscode browser: ' + message) },
    })
  } })
}
