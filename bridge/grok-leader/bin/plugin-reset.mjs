// `dscode doctor --reset-plugins`: safe mode for a profile a plugin broke.
// DSH's own recovery (app-boot `sanitizeProfile`, behind the Desktop's
// "disable third-party plugins") moves the profile patch aside and selects
// only the shipped bundles; installed packages stay. dscode runs it on its
// profile under the profile lock and says what changed and how to undo it.
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { load } from 'js-yaml'
import { dshInstallAnchor } from './doctor.mjs'
import { remoteSettings } from './remote.mjs'
import { withProfileLock } from './update.mjs'

/** The bundles a fresh dscode profile selects: DSH's base layer, then dscode. */
export const shippedBundles = packageName => ['@deepseek-ai/dsh-base', packageName]

const readManifest = (binName, profileDir) => {
  const path = join(profileDir, 'package.json')
  let parsed
  try { parsed = JSON.parse(readFileSync(path, 'utf8')) } catch (error) { throw new Error(`${binName}: failed to read profile manifest ${path}: ${String(error)}`) }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${binName}: profile manifest ${path} must hold a JSON object`)
  return parsed
}

/** app-boot 0.1.7-rc.2 `sanitizeProfile`, for a runtime whose app-boot cannot
 * be loaded: rename the patch to `<patch>.bak-<ms>[-n]` and write the bundles. */
export const mirrorSanitizeProfile = (binName, profileDir, bundles) => {
  const manifest = existsSync(join(profileDir, 'package.json')) ? readManifest(binName, profileDir) : undefined
  const patchPath = join(profileDir, 'cordis.patch.yml')
  const backupBase = `${patchPath}.bak-${Date.now()}`
  let backupPath = backupBase
  let ordinal = 0
  while (existsSync(backupPath)) backupPath = `${backupBase}-${++ordinal}`
  try { renameSync(patchPath, backupPath) } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    backupPath = undefined
  }
  if (manifest !== undefined) {
    const updated = { ...manifest, dsh: { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles: [...bundles] } } }
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify(updated, undefined, 2) + '\n')
  }
  return backupPath
}

/** The installed runtime's own `sanitizeProfile`, resolved as boot resolves app-boot. */
export const runtimeSanitizer = async anchor => {
  if (anchor === undefined) return undefined
  try {
    const boot = await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')).href)
    return typeof boot.sanitizeProfile === 'function' ? boot.sanitizeProfile : undefined
  } catch { return undefined }
}

/** What a profile patch saved, by row id: switches, settings and inserted rows. */
export const patchSummary = text => {
  let entries
  try { entries = load(text.replace(/!!js\b/g, '')) } catch (error) { return `text that is not readable YAML (${error.message.split('\n')[0]})` }
  if (!Array.isArray(entries)) return entries === null || entries === undefined ? 'nothing' : 'a value that is not a YAML list'
  const switches = [], settings = [], inserted = []
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') continue
    if (Array.isArray(entry.insert)) { inserted.push(...entry.insert.map(row => String(row?.id ?? row?.name ?? '?'))); continue }
    if (typeof entry.id !== 'string') continue
    if (typeof entry.disabled === 'boolean') switches.push(`${entry.id} ${entry.disabled ? 'off' : 'on'}`)
    if (entry.config !== undefined) settings.push(entry.id)
  }
  const parts = [
    ...switches.length > 0 ? [`row switches ${switches.join(', ')}`] : [],
    ...settings.length > 0 ? [`settings of ${[...new Set(settings)].join(', ')}`] : [],
    ...inserted.length > 0 ? [`inserted rows ${inserted.join(', ')}`] : [],
  ]
  return parts.length > 0 ? parts.join('; ') : 'nothing'
}

const quote = path => `'${path.replace(/'/g, "'\\''")}'`

/** Reset `profile` to the shipped bundles and no profile patch, under the lock. */
export const resetPlugins = async ({ profile, packageName, dshBin, log = message => { console.log(message) }, lock = withProfileLock }) => {
  if (!existsSync(join(profile, 'package.json'))) throw new Error(`no dscode profile at ${profile}`)
  const run = async () => {
    const before = readManifest('dscode', profile).dsh?.profile?.bundles ?? []
    const bundles = shippedBundles(packageName)
    const patchPath = join(profile, 'cordis.patch.yml')
    const patch = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : undefined
    if (patch === undefined && JSON.stringify(before) === JSON.stringify(bundles)) {
      log(`Nothing to reset in ${profile}: it selects only dscode's shipped bundles (${bundles.join(', ')}) and has no profile patch.`)
      return { changed: false, before, bundles }
    }
    const anchor = dshBin ? dshInstallAnchor(dshBin) : undefined
    const sanitize = await runtimeSanitizer(anchor) ?? mirrorSanitizeProfile
    const backup = sanitize('dscode', profile, bundles)
    const dropped = before.filter(name => !bundles.includes(name))
    const remote = patch === undefined ? undefined : remoteSettings(patch)
    const lines = [`Reset the plugins of the dscode profile ${profile}:`,
      `- Bundles: ${before.join(', ') || '(none)'} -> ${bundles.join(', ')}`]
    if (dropped.length > 0) lines.push(`- No longer selected: ${dropped.join(', ')}; installed packages stay. Turn one back on inside dscode with /dsh enable <bundle>.`)
    if (backup !== undefined) {
      lines.push(`- Profile patch moved to ${backup}; it held ${patchSummary(patch ?? '')}.`, '',
        'Warning: what that patch saved is off until you restore it: row switches such as the native DeepSeek route',
        '(llm-deepseek, turned on by /provider) and /browser on, provider and model settings, MCP servers added',
        'with /mcp, a dscode remote workspace, and hand edits. API keys in the DSH credential store are kept.', '',
        ...remote === undefined ? [] : [`This home's remote workspace (ssh ${remote.host}:${remote.workspace}) was in that patch:`,
          'until you restore it, tools, shells and file edits run on this computer.', ''],
        'To restore it, close dscode and run:', `  mv ${quote(backup)} ${quote(patchPath)}`,
        'then turn bundles back on inside dscode with /dsh enable <bundle>.')
    }
    lines.push('Installed packages were kept. Close every dscode window before starting it again:',
      'a running leader keeps its current plugins until it exits.')
    log(lines.join('\n'))
    return { changed: true, before, bundles, backup }
  }
  try { return await lock(profile, run) } catch (error) {
    // Without a runtime lock binding no leader or update can run in this
    // home either (both need that runtime), so nothing else writes it now.
    if (error?.code !== 'DSCODE_PROFILE_LOCK_UNAVAILABLE') throw error
    return await run()
  }
}
