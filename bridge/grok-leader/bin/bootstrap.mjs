#!/usr/bin/env node
// Stable entrypoint outside the directories replaced by an update. Only Node
// builtins are usable until an interrupted tuple has been recovered.
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const profile = resolve(process.env.DSCODE_HOME || dirname(fileURLToPath(import.meta.url)))
const plugin = 'node_modules/@hqzhao95/dscode/bin'
process.env.DSCODE_HOME = profile

try {
  const deadline = performance.now() + 60000
  let recovered = false
  while (!recovered) {
    const candidates = [join(profile, plugin, 'update.mjs')]
    let needsRecovery = false
    for (const name of readdirSync(dirname(profile))) {
      if (!name.startsWith('.dscode-update-')) continue
      const stage = join(dirname(profile), name)
      try {
        const stat = lstatSync(stage)
        if (!stat.isDirectory() || stat.uid !== process.getuid()) continue
        const transaction = JSON.parse(readFileSync(join(stage, 'transaction.json'), 'utf8'))
        if (transaction.schema !== 1 || transaction.profile !== realpathSync(profile)) continue
        needsRecovery ||= transaction.state === 'pending'
        candidates.push(join(stage, 'plugin/package/bin/update.mjs'), join(stage, 'profile', plugin, 'update.mjs'), join(stage, 'backup', plugin, 'update.mjs'))
      } catch { /* An unrecognized staging directory is not ours to recover. */ }
    }
    for (const candidate of candidates) {
      if (!existsSync(candidate)) continue
      try {
        const { withProfileLock, RECOVERY_VERSION } = await import(pathToFileURL(candidate).href)
        if (needsRecovery && RECOVERY_VERSION !== 1) continue
        await withProfileLock(profile, () => {})
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
