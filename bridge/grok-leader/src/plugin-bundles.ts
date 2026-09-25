/** dsh plugin bundles: patch analysis, the isolated npm audit, and install
 * verification with rollback. No command parsing: /dsh verbs live in
 * profile-plugins, which owns the profile lock. */
import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import {
  evaluatePluginCompatibility, pluginCompatibilityWarning, readProfileCompatibility, readProfileManifest as readPackageManifest,
  resolveBundleDir, type PluginCompatibility,
} from '@deepseek-ai/dsh-app-boot'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { load as loadYaml } from 'js-yaml'

/** dsh-base row ids a third-party layer should not touch silently: the
 *  sandbox/approval/permission spine and the rows that hold, obtain or spend
 *  credentials. Patch layers apply AFTER dsh-base, so an installed bundle can
 *  disable, reconfigure or (for the account route dscode disables) re-enable
 *  these — legal in dsh, but /dsh add flags them before the layer is
 *  registered. Ids, not module names: `permission` loads dsh-permission-presets. */
export const SENSITIVE_ROW_IDS: ReadonlySet<string> = new Set([
  'sandbox', 'sandbox-policy', 'approval', 'permission', 'settings',
  'credentials', 'authorization', 'deepseek-account', 'llm-deepseek-account',
])

/** What one bundle's cordis.patch.yml does to the composition. */
export interface BundlePatchAnalysis {
  insertedRows: string[]
  overriddenRows: string[]
  disabledRows: string[]
  sensitiveRows: string[]
  /** Packages named by inserted rows, group members included: DSH checks their
   * peers too and disables an incompatible row at boot. */
  insertedPackages: string[]
  jsExprCount: number
}

/** The package a row's plugin name loads, or undefined for local and builtin rows. */
function rowPackage(name: unknown): string | undefined {
  if (typeof name !== 'string' || name.startsWith('.') || name.startsWith('/') || name.includes(':')) return undefined
  return name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
}

function collectRowPackages(rows: unknown[], into: Set<string>): void {
  for (const row of rows) {
    if (row === null || typeof row !== 'object') continue
    const r = row as { name?: unknown; group?: unknown; config?: unknown }
    if (r.group === true && Array.isArray(r.config)) collectRowPackages(r.config, into)
    const pkg = rowPackage(r.name)
    if (pkg !== undefined) into.add(pkg)
  }
}

/** Statically analyze a bundle patch. Throws on anything loadProfile would
 *  choke on (non-array, non-mapping entries) — /dsh add uses that to refuse
 *  registration BEFORE the layer can brick the next boot. `!!js` tags are
 *  neutralized for parsing but counted: they are code that runs in the
 *  leader process at boot, before any plugin module loads. */
export function analyzeBundlePatch(patchText: string): BundlePatchAnalysis {
  const jsExprCount = (patchText.match(/!!js\b/g) ?? []).length
  const doc = loadYaml(patchText.replace(/!!js\b/g, ''))
  if (!Array.isArray(doc)) throw new Error('the patch is not a YAML array (loadProfile would refuse to boot this profile)')
  const analysis: BundlePatchAnalysis = { insertedRows: [], overriddenRows: [], disabledRows: [], sensitiveRows: [], insertedPackages: [], jsExprCount }
  const packages = new Set<string>()
  for (const entry of doc) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('a patch entry is not a mapping (loadProfile would refuse to boot this profile)')
    }
    const patch = entry as Record<string, unknown>
    if (Array.isArray(patch.insert)) {
      collectRowPackages(patch.insert, packages)
      for (const row of patch.insert) {
        const r = row as { id?: unknown; name?: unknown } | null
        const id = String(r?.id ?? r?.name ?? '?')
        analysis.insertedRows.push(id)
        if (SENSITIVE_ROW_IDS.has(id)) analysis.sensitiveRows.push(id)
      }
      continue
    }
    if (typeof patch.id === 'string') {
      if (patch.disabled === true) analysis.disabledRows.push(patch.id)
      else analysis.overriddenRows.push(patch.id)
      if (SENSITIVE_ROW_IDS.has(patch.id)) analysis.sensitiveRows.push(patch.id)
    }
  }
  analysis.insertedPackages = [...packages]
  return analysis
}

export const CORE_PLUGIN_NAMES: ReadonlySet<string> = new Set(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dscode', '@deepseek-ai/dsh-grok-leader'])

export type BundleInspection =
  | { kind: 'plain'; compatibility: PluginCompatibility[] }
  | { kind: 'bundle'; analysis: BundlePatchAnalysis; compatibility: PluginCompatibility[] }
  | { kind: 'broken'; error: string }

export interface StagedPackage { name: string; info: BundleInspection }

/** An incompatible package the profile has not exempted: the runtime would skip or disable it. */
export const refusedCompatibility = (info: BundleInspection): PluginCompatibility | undefined =>
  info.kind === 'broken' ? undefined : info.compatibility.find(issue => !issue.exempted)

export const bundleRequiresTrust = (info: BundleInspection): boolean => info.kind === 'bundle'

/** Human summary of a bundle's composition delta. */
export const describeAnalysis = (name: string, analysis: BundlePatchAnalysis): string => {
  const lines = [name + ' contributes a composition layer:']
  if (analysis.insertedRows.length > 0) lines.push('  + inserts ' + String(analysis.insertedRows.length) + ' row(s): ' + analysis.insertedRows.join(', '))
  if (analysis.overriddenRows.length > 0) lines.push('  ~ overrides: ' + analysis.overriddenRows.join(', '))
  if (analysis.disabledRows.length > 0) lines.push('  - disables: ' + analysis.disabledRows.join(', '))
  if (analysis.sensitiveRows.length > 0) lines.push('  ⚠ touches security rows: ' + analysis.sensitiveRows.join(', ') + ' (sandbox, approval or credential spine — make sure you trust this)')
  if (analysis.jsExprCount > 0) lines.push('  ⚠ contains ' + String(analysis.jsExprCount) + ' !!js expression(s) — code that runs at leader boot')
  if (lines.length === 1) lines.push('  (empty layer)')
  return lines.join('\n')
}

export const readProfileManifest = async (dir: string): Promise<{ dependencies: Record<string, string>; bundles: string[]; raw: Record<string, unknown> }> => {
  const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
  const dependencies = (raw.dependencies ?? {}) as Record<string, string>
  const dsh = (raw.dsh ?? {}) as { profile?: { bundles?: string[] } }
  return { dependencies, bundles: dsh.profile?.bundles ?? [], raw }
}

/** The files a failed install must restore: npm rewrites both. */
const MANIFEST_FILES = ['package.json', 'package-lock.json'] as const
const snapshotManifest = async (dir: string): Promise<Array<[string, Buffer | undefined]>> => Promise.all(MANIFEST_FILES.map(async file => {
  try { return [file, await readFile(join(dir, file))] as [string, Buffer] } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [file, undefined] as [string, undefined]
    throw error
  }
}))
const restoreManifest = async (dir: string, snapshot: Array<[string, Buffer | undefined]>): Promise<void> => {
  for (const [file, bytes] of snapshot) {
    const target = join(dir, file)
    if (bytes === undefined) { await rm(target, { force: true }); continue }
    const temporary = join(dir, '.' + file + '.' + String(process.pid) + '.' + randomUUID() + '.tmp')
    try {
      await writeFile(temporary, bytes)
      await rename(temporary, target)
    } catch (error) {
      await rm(temporary, { force: true }).catch(() => undefined)
      throw error
    }
  }
}

export const writeProfileBundles = async (dir: string, raw: Record<string, unknown>, bundles: string[]): Promise<void> => {
  const dsh = (raw.dsh ?? (raw.dsh = {})) as Record<string, unknown>
  const profile = (dsh.profile ?? (dsh.profile = {})) as Record<string, unknown>
  profile.bundles = bundles
  const target = join(dir, 'package.json')
  const temporary = join(dir, '.package.json.' + String(process.pid) + '.' + randomUUID() + '.tmp')
  try {
    await writeFile(temporary, JSON.stringify(raw, null, 2) + '\n')
    await rename(temporary, target)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined)
    throw error
  }
}

const normalizeAuditSpec = (profileDir: string, spec: string): string => {
  if (spec.startsWith('file:')) {
    const path = spec.slice('file:'.length)
    return 'file:' + (isAbsolute(path) ? path : resolve(profileDir, path))
  }
  if (spec.startsWith('./') || spec.startsWith('../')) return resolve(profileDir, spec)
  return spec
}

export interface PluginBundleDependencies {
  /** External npm process; tests supply an installer confined to their fixture. */
  exec?: (file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<unknown>
  /** DSH peer check for one installed manifest. Defaults to the runtime's own
   * boot rule (dsh 0.1.7-rc.2, as rc.1, skips an incompatible bundle whole) and the
   * profile's exact-version exemptions. */
  compatibility?: (manifest: object, profileDir: string) => PluginCompatibility | undefined
  /** The running DSH installation's package.json (profileContext.installAnchor).
   * Rows resolve there before the bundle's own dependencies, as at boot. */
  installAnchor?: () => string | undefined
}

export type PluginBundles = ReturnType<typeof createPluginBundles>

/** npm, compatibility and inspection over one profile directory. The caller
 * holds the profile lock around every mutation. */
export function createPluginBundles(dependencies: PluginBundleDependencies) {
  const execFileAsync = dependencies.exec ?? promisify(execFile)
  const compatibilityOf = dependencies.compatibility
    ?? ((manifest: object, profileDir: string) => evaluatePluginCompatibility(manifest, readProfileCompatibility(profileDir).exemptions))

  /** Every package a bundle inserts, resolved as boot resolves it (the DSH
   * installation first, then the bundle's own dependencies). A row this
   * profile cannot resolve is the loader's failure to report, not a refusal. */
  const componentIssues = (pkgDir: string, names: readonly string[], profileDir: string): PluginCompatibility[] => {
    const anchor = dependencies.installAnchor?.() ?? join(pkgDir, 'package.json')
    const issues: PluginCompatibility[] = []
    for (const name of names) {
      let dir: string
      try { dir = resolveBundleDir('dscode', name, anchor, pkgDir) } catch { continue }
      const issue = compatibilityOf(readPackageManifest('dscode', dir), profileDir)
      if (issue !== undefined) issues.push(issue)
    }
    return issues
  }

  /** Inspect one freshly installed package: plain dependency, valid bundle
   *  (with its patch analysis), or a bundle whose patch would brick the boot. */
  const inspectInstalledBundle = async (
    dir: string,
    name: string,
    profileDir: string,
  ): Promise<BundleInspection> => {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'))
    try {
      const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string | string[] } } }
      const own = compatibilityOf(manifest, profileDir)
      const compatibility = own === undefined ? [] : [own]
      const patchRel = manifest.dsh?.bundle?.patch
      if (patchRel === undefined) return { kind: 'plain', compatibility }
      const files = typeof patchRel === 'string' ? [patchRel] : patchRel
      if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) throw new Error('dsh.bundle.patch must be a file path or a list of file paths')
      const analysis: BundlePatchAnalysis = { insertedRows: [], overriddenRows: [], disabledRows: [], sensitiveRows: [], insertedPackages: [], jsExprCount: 0 }
      for (const file of files) {
        const next = analyzeBundlePatch(await readFile(join(pkgDir, file), 'utf8'))
        for (const key of ['insertedRows', 'overriddenRows', 'disabledRows', 'sensitiveRows', 'insertedPackages'] as const) analysis[key].push(...next[key])
        analysis.jsExprCount += next.jsExprCount
      }
      for (const issue of componentIssues(pkgDir, [...new Set(analysis.insertedPackages)], profileDir)) {
        // A bundle whose rows load its own package reports that package once.
        if (!compatibility.some(known => known.name === issue.name && known.version === issue.version)) compatibility.push(issue)
      }
      return { kind: 'bundle', analysis, compatibility }
    } catch (error) {
      return { kind: 'broken', error: errorChain(error) }
    }
  }

  const npmInstall = async (dir: string, specs: string[]): Promise<void> => {
    await execFileAsync('npm', [
      'install',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      ...specs,
    ], { cwd: dir, timeout: 180_000 })
  }

  const npmUninstall = async (dir: string, names: string[]): Promise<void> => {
    await execFileAsync('npm', [
      'uninstall',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      '--legacy-peer-deps',
      ...names,
    ], { cwd: dir, timeout: 180_000 })
  }

  /** Install without lifecycle scripts into an isolated directory and inspect
   * every requested root package before the real profile is mutated. */
  const auditPluginSpecs = async (
    profileDir: string,
    specs: string[],
  ): Promise<StagedPackage[]> => {
    const stage = await mkdtemp(join(tmpdir(), 'dscode-plugin-audit-'))
    try {
      await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n')
      await npmInstall(stage, specs.map(spec => normalizeAuditSpec(profileDir, spec)))
      const manifest = await readProfileManifest(stage)
      const names = Object.keys(manifest.dependencies)
      if (names.length === 0) throw new Error('npm installed no root package for: ' + specs.join(', '))
      return await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(stage, name, profileDir) })))
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  /** Install audited specs into the real profile, then re-inspect what npm
   * actually installed: a difference from the stage rolls the install back,
   * or disables every touched root when the rollback cannot complete. */
  const installAudited = async (dir: string, specs: string[], staged: StagedPackage[], trusted: boolean): Promise<string> => {
    const snapshot = await snapshotManifest(dir)
    await npmInstall(dir, specs)
    const manifest = await readProfileManifest(dir)
    const names = staged.map(entry => entry.name)
    const actual = await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(dir, name, dir) })))
    const invalid = actual.find(entry => entry.info.kind === 'broken' || refusedCompatibility(entry.info) !== undefined
      || (!trusted && bundleRequiresTrust(entry.info)))
    if (invalid !== undefined) {
      const incompatible = refusedCompatibility(invalid.info)
      const reason = invalid.info.kind === 'broken'
        ? invalid.info.error
        : incompatible !== undefined
          ? pluginCompatibilityWarning(incompatible)
          : 'the installed package introduced an executable bundle after staging'
      // The staged and real package differed. Restore the previous
      // manifest and modules; if that fails, disable every touched root
      // so an existing bundle cannot brick the next boot.
      try {
        await restoreManifest(dir, snapshot)
        await npmInstall(dir, [])
        return 'Rolled back ' + names.join(', ') + ' because post-install verification failed for ' + invalid.name + ':\n' + reason
      } catch (error) {
        const current = await readProfileManifest(dir)
        await writeProfileBundles(dir, current.raw, current.bundles.filter(bundle => !names.includes(bundle)))
        return 'Installed dependency was left disabled because post-install verification failed for ' + invalid.name
          + ' and the rollback did not complete (' + errorChain(error) + '):\n' + reason
      }
    }
    const bundles = new Set(manifest.bundles)
    const report: string[] = []
    for (const { name, info } of actual) {
      if (info.kind === 'plain') {
        bundles.delete(name)
        report.push(name + ': declares no dsh.bundle — installed as a plain dependency, not a profile layer.')
        continue
      }
      if (info.kind === 'broken') continue
      bundles.add(name)
      report.push(describeAnalysis(name, info.analysis))
      for (const issue of info.compatibility) report.push('  ⚠ ' + pluginCompatibilityWarning(issue))
    }
    await writeProfileBundles(dir, manifest.raw, [...bundles])
    return 'Installed or updated ' + names.join(', ') + '.\n\n' + report.join('\n\n') + '\n\nRestart dscode to load it (the leader exits with its last client).'
  }

  return { auditPluginSpecs, installAudited, npmUninstall }
}
