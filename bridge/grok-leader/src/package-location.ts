import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// A single source of package provenance for source and compiled installations.
const packageDirectory = (): string => {
  let dir = dirname(fileURLToPath(import.meta.url))
  for (;;) {
    const candidate = join(dir, 'package.json')
    if (existsSync(candidate)) {
      const manifest = JSON.parse(readFileSync(candidate, 'utf8')) as { name?: string; version?: string }
      if (manifest.name === '@hqzhao95/dscode' && typeof manifest.version === 'string') return dir
    }
    const parent = dirname(dir)
    if (parent === dir) throw new Error('could not locate @hqzhao95/dscode package.json')
    dir = parent
  }
}

export const PACKAGE_DIRECTORY = packageDirectory()
export const PACKAGE_VERSION = (JSON.parse(readFileSync(join(PACKAGE_DIRECTORY, 'package.json'), 'utf8')) as { version: string }).version

type Updater = { withProfileLock<T>(profile: string, action: () => Promise<T>): Promise<T> }
let updater: Promise<Updater> | undefined
/** The launcher's updater module (and its tar/smol-toml dependencies) is only
 *  needed once a profile mutation actually runs, so resolve it from the
 *  package root on first use instead of at leader boot. The resolution works
 *  in both source and compiled installations. */
const loadUpdater = (): Promise<Updater> => {
  updater ??= import(pathToFileURL(join(PACKAGE_DIRECTORY, 'bin/update.mjs')).href).catch((error: unknown) => {
    updater = undefined
    throw error
  }) as Promise<Updater>
  return updater
}
export const withProfileLock = async <T>(profile: string, action: () => Promise<T>): Promise<T> =>
  (await loadUpdater()).withProfileLock(profile, action)
