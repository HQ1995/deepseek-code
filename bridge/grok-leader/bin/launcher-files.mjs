// Shared launcher/update filesystem ownership; builtins only, no entry imports.
import { randomUUID } from 'node:crypto'
import { closeSync, constants, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
export const readJsonFile = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
export const syncDirectory = path => {
  const fd = openSync(path, constants.O_RDONLY)
  try { fsyncSync(fd) } finally { closeSync(fd) }
}
export const atomicWrite = (path, content, mode = (lstatSync(path, { throwIfNoEntry: false })?.mode ?? 0o600) & 0o777) => {
  const temporary = join(dirname(path), `.${basename(path)}-${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, content, { mode, flag: 'wx', flush: true })
    renameSync(temporary, path)
    syncDirectory(dirname(path))
  } finally { rmSync(temporary, { force: true }) }
}
/** Point ~/.local/bin/dscode at the profile install's launcher (the stable
 *  copy — an npx temp-store copy of this file may be garbage-collected), or
 *  at this file when the profile copy is absent. Retarget plugin launchers
 *  and the exact legacy binary that asked this managed launch to take over;
 *  anything else remains user-owned. */
export const healLauncherLink = ({ profile, packageName, sourceBin, legacyTargets = [] }) => {
  const link = join(homedir(), '.local', 'bin', 'dscode')
  const installed = join(profile, 'node_modules', ...packageName.split('/'), 'bin/dscode.mjs')
  const stable = join(profile, 'dscode.mjs')
  const bootstrap = join(sourceBin, 'bootstrap.mjs')
  let preferred = existsSync(installed) ? installed : join(sourceBin, 'dscode.mjs')
  try {
    if (existsSync(bootstrap)) {
      mkdirSync(profile, { recursive: true })
      const existing = lstatSync(stable, { throwIfNoEntry: false })
      if (existing && (!existing.isFile() || !readFileSync(stable, 'utf8').startsWith('#!/usr/bin/env node\n// Stable entrypoint outside'))) {
        throw new Error(`refusing to replace unowned file ${stable}`)
      }
      const content = readFileSync(bootstrap)
      if (!existing || !readFileSync(stable).equals(content)) atomicWrite(stable, content, 0o755)
      preferred = stable
    }
    const existing = lstatSync(link, { throwIfNoEntry: false })
    if (existing) {
      if (!existing.isSymbolicLink()) return
      const target = resolve(dirname(link), readlinkSync(link))
      if (target === preferred) return
      const legacyBin = process.env.DSCODE_LEGACY_BIN
      const legacy = legacyTargets.includes(target) || (legacyBin && existsSync(target) && existsSync(legacyBin)
        && realpathSync(target) === realpathSync(legacyBin))
      const plugin = target.endsWith('/bin/dscode.mjs') && readJsonFile(join(dirname(target), '..', 'package.json'))?.name === packageName
      if (!legacy && !plugin && target !== installed) return
    }
    mkdirSync(dirname(link), { recursive: true })
    const temporary = `${link}.install-${process.pid}`
    try { symlinkSync(preferred, temporary); renameSync(temporary, link) }
    finally { rmSync(temporary, { force: true }) }
  } catch (error) {
    console.error(`dscode: warning: could not repair ${link}: ${error instanceof Error ? error.message : String(error)}; launch with node ${JSON.stringify(installed)} instead`)
  }
}
