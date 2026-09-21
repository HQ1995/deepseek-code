#!/usr/bin/env node
// Stable entrypoint outside the directories replaced by an update. Only Node
// builtins are usable until an interrupted tuple has been recovered.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const profile = resolve(process.env.DSCODE_HOME || dirname(fileURLToPath(import.meta.url)))
const plugin = 'node_modules/@hqzhao95/dscode/bin'
process.env.DSCODE_HOME = profile
/** Same spelling the updater journals: a stage is only ours when the two agree. */
const canonicalProfile = () => existsSync(profile)
  ? realpathSync(profile)
  : join(realpathSync(dirname(profile)), basename(profile))

try {
  const deadline = performance.now() + 60000
  let recovered = false
  while (!recovered) {
    const candidates = [join(profile, plugin, 'update.mjs')]
    let needsRecovery = false
    // An in-flight swap can hide the profile for a moment; keep retrying
    // rather than aborting the launcher with a raw ENOENT.
    let canonical = profile
    try { canonical = canonicalProfile() } catch { /* the unresolved spelling still scans its own parent */ }
    const parents = [...new Set([dirname(profile), dirname(canonical)])]
    const seen = new Set()
    for (const parent of parents) {
      let names
      try { names = readdirSync(parent) } catch { continue }
      for (const name of names) {
        if (!name.startsWith('.dscode-update-')) continue
        const stage = join(parent, name)
        if (seen.has(stage)) continue
        seen.add(stage)
        try {
          const stat = lstatSync(stage)
          if (!stat.isDirectory() || stat.uid !== process.getuid()) continue
          const transaction = JSON.parse(readFileSync(join(stage, 'transaction.json'), 'utf8'))
          if (transaction.schema !== 1 || transaction.profile !== canonical) continue
          needsRecovery ||= transaction.state === 'pending'
          candidates.push(join(stage, 'plugin/package/bin/update.mjs'), join(stage, 'profile', plugin, 'update.mjs'), join(stage, 'backup', plugin, 'update.mjs'))
        } catch { /* An unrecognized staging directory is not ours to recover. */ }
      }
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        const { withProfileLock, RECOVERY_VERSION } = await import(pathToFileURL(candidate).href)
        if (needsRecovery && RECOVERY_VERSION !== 1) continue
        // Only interrupted tuple recovery needs the native binding here.
        // Normal startup owns its own lock and must first be allowed to repair
        // a missing binding using a freshly downloaded, validated runtime.
        if (needsRecovery) await withProfileLock(profile, () => {})
        recovered = true
        break
      } catch (error) {
        if (error.code !== 'ENOENT' && error.code !== 'ERR_MODULE_NOT_FOUND') throw error
      }
    }
    if (!recovered) {
      if (performance.now() >= deadline) throw new Error('launcher unavailable; reinstall with npx @hqzhao95/dscode')
      await delay(100)
    }
  }
  const { main } = await import(pathToFileURL(join(profile, plugin, 'dscode.mjs')).href)
  if (typeof main === 'function') await main()
  else {
    // Releases predating this stable entrypoint invoke themselves directly.
    const { spawn } = await import('node:child_process')
    const child = spawn(process.execPath, [join(profile, plugin, 'dscode.mjs'), ...process.argv.slice(2)], { stdio: 'inherit' })
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
    child.once('error', error => { console.error(`dscode: ${error.message}`); process.exitCode = 1 })
    child.once('exit', (code, signal) => { process.exitCode = code ?? (signal === 'SIGINT' ? 130 : 1) })
  }
} catch (error) {
  console.error(`dscode: ${error.message}`)
  process.exitCode = 1
}
