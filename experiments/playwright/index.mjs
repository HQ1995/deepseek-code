/** Opt-in launch-only browser composition. Does not confine network or host access. */
import Schema from '@deepseek-ai/schemastery'
import BrowserUse from '@deepseek-ai/dsh-browser-use'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { browserDenial, navigationOrigins, prefix } from './policy.mjs'
import { mountBrowserSessions } from './session-browser.mjs'

export const name = 'dscode-experimental-playwright'
export const inject = ['agents', 'tools', 'systemPrompt']
export const Config = Schema.object({
  executablePath: Schema.string().pattern(/^\//u).required(),
  navigationOrigins: Schema.array(Schema.string()).required(),
  toolCallTimeoutMs: Schema.number().min(1).max(2_147_483_647).default(30_000),
})

/** Own mandatory policy and native resource/MCP composition together; never attach. */
export async function apply(ctx, config) {
  const origins = navigationOrigins(config.navigationOrigins)
  ctx.tools.guard(exec => browserDenial(exec, origins))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (!exec.name.startsWith(prefix) || decision.kind !== 'allow') return decision
    const reason = browserDenial(exec, origins)
    if (reason !== undefined) return { kind: 'deny', reason }
    return { kind: 'ask', reason: 'Experimental browser action; browser state is isolated, network and host access are not confined.' }
  }, { prepend: true })
  const cli = join(dirname(fileURLToPath(import.meta.resolve('@playwright/mcp/package.json'))), 'cli.js')
  const env = Object.fromEntries(Object.keys(process.env).filter(key => key.toUpperCase().startsWith('PLAYWRIGHT_MCP_')).map(key => [key, '']))
  await ctx.plugin(BrowserUse)
  await ctx.plugin({ name: 'dscode-playwright-sessions', inject: ['browserUse', 'agents', 'tools', 'systemPrompt'], async apply(owner) {
    mountBrowserSessions(owner, {
      args: [cli, '--browser', 'chromium', '--isolated', '--headless', '--executable-path', config.executablePath],
      env, toolCallTimeoutMs: config.toolCallTimeoutMs,
    })
  } })
}
