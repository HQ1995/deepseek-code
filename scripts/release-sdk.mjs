import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the supplied release closure, never source aliases or a second SDK.
 * `modulesOf` names a package directory whose node_modules must be that same
 * closure: its modules and the SDK here would otherwise be two copies, and
 * service identity checks fail far from the cause. */
export function releaseSdk(root, { modulesOf } = {}) {
  if (modulesOf !== undefined) {
    const expected = realpathSync(join(resolve(root), 'node_modules'))
    let actual
    try { actual = realpathSync(join(modulesOf, 'node_modules')) } catch { actual = 'nothing' }
    if (actual !== expected) throw new Error(`${join(modulesOf, 'node_modules')} must link to ${expected} (it resolves to ${actual})`)
  }
  const require = createRequire(join(resolve(root), 'node_modules/@deepseek-ai/dsh/package.json'))
  const sdk = name => import(pathToFileURL(require.resolve(name)).href)
  return { sdk, resolve: name => require.resolve(name),
    async mount(ctx, name, config = {}) {
      const module = await sdk('@deepseek-ai/dsh-' + name)
      return await ctx.plugin(module.default ?? module, config)
    } }
}
