import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the supplied release closure, never source aliases or a second SDK. */
export function releaseSdk(root) {
  const require = createRequire(join(resolve(root), 'node_modules/@deepseek-ai/dsh/package.json'))
  const sdk = name => import(pathToFileURL(require.resolve(name)).href)
  return { sdk, resolve: name => require.resolve(name),
    async mount(ctx, name, config = {}) {
      const module = await sdk('@deepseek-ai/dsh-' + name)
      return await ctx.plugin(module.default ?? module, config)
    } }
}
