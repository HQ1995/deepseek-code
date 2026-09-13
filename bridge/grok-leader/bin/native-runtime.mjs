import { accessSync, constants, existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { isAbsolute, join, relative, resolve } from 'node:path'

// Read the installed family's contract: frozen launchers must also accept an
// upstream package rename. Keep this dependency-free for release bootstrapping.
export const nativePackages = runtime => {
  const scope = join(runtime, 'node_modules', '@deepseek-ai')
  const current = name => name === 'node-addon-system' || name.startsWith('node-addon-system-')
  return (existsSync(scope) ? readdirSync(scope) : [])
    .filter(name => name.startsWith('node-addon-'))
    .sort((a, b) => Number(current(b)) - Number(current(a)) || a.localeCompare(b))
}

export const validateNativeArtifacts = (runtime, platform = process.platform, arch = process.arch) => {
  const target = `${platform}-${arch}`
  const name = nativePackages(runtime).find(name => name.endsWith(`-${target}`))
  if (!name) throw new Error('runtime native helper metadata mismatch')
  const directory = join(runtime, 'node_modules', '@deepseek-ai', name)
  // Never let an intact legacy helper mask damaged current-family metadata.
  const helper = { directory, prebuilds: JSON.parse(readFileSync(join(directory, 'prebuilds.json'), 'utf8')) }
  if (helper.prebuilds?.platform !== target || !Array.isArray(helper.prebuilds.binaries) || !helper.prebuilds.binaries.length) throw new Error('runtime native helper metadata mismatch')
  for (const binary of helper.prebuilds.binaries) {
    if (typeof binary?.path !== 'string' || !binary.path || isAbsolute(binary.path)) throw new Error('runtime native helper metadata malformed')
    const path = resolve(helper.directory, binary.path)
    const local = relative(helper.directory, path)
    if (local === '..' || local.startsWith('../') || !statSync(path).isFile()) throw new Error('runtime native helper artifact invalid')
    accessSync(path, ['static-musl', 'executable'].includes(binary.kind) ? constants.X_OK : constants.R_OK)
  }
  return helper
}
