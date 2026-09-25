/**
 * The standard preset's tool rows, mounted as the preset mounts them, for
 * specs that need the real rc.2 tools and their presenters. Execution
 * services are stubs: presenters read only a call's arguments and its
 * durable result.
 */
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import { importRuntime } from '../../shared/runtime-modules.mjs'

const TOOL_ROWS = ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-web']

export async function mountStandardTools(ctx: Context): Promise<void> {
  const { default: SystemPrompt } = await importRuntime('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await importRuntime('@deepseek-ai/dsh-tools')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  for (const service of ['shell', 'shellEnv', 'fs', 'subprocess', 'web']) ctx.provide(service as never, {} as never)
  const patch = load(readFileSync(new URL('../../presets/standard.patch.yml', import.meta.url), 'utf8').replace(/!!js\b/g, '')) as
    Array<{ insert: Array<{ config: { plugins: Array<{ id: string; name: string; config?: unknown }> } }> }>
  const rows = patch[0]!.insert[0]!.config.plugins
  for (const id of TOOL_ROWS) {
    const row = rows.find(entry => entry.id === id)!
    await ctx.plugin(await importRuntime(row.name), row.config ?? {})
  }
}
