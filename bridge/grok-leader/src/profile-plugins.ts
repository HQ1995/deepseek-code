import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import type { Context } from '@deepseek-ai/cordis'
import { errorChain } from '@deepseek-ai/dsh-llm'
import { load as loadYaml } from 'js-yaml'
import { withProfileLock } from './package-location.ts'

/** Composition rows a third-party layer should not touch silently: the
 *  sandbox/approval/permission spine. Patch layers apply AFTER dsh-base, so
 *  an installed bundle can disable or reconfigure these — legal in dsh, but
 *  the user must see it before the layer is registered. */
const SENSITIVE_ROW_IDS = new Set(['sandbox', 'sandbox-policy', 'approval', 'permission-presets', 'credentials', 'settings'])

/** What one bundle's cordis.patch.yml does to the composition. */
export interface BundlePatchAnalysis {
  insertedRows: string[]
  overriddenRows: string[]
  disabledRows: string[]
  sensitiveRows: string[]
  jsExprCount: number
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
  const analysis: BundlePatchAnalysis = { insertedRows: [], overriddenRows: [], disabledRows: [], sensitiveRows: [], jsExprCount }
  for (const entry of doc) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('a patch entry is not a mapping (loadProfile would refuse to boot this profile)')
    }
    const patch = entry as Record<string, unknown>
    if (Array.isArray(patch.insert)) {
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
  return analysis
}

/** Minimal shell-style tokenizer for slash commands (quotes and backslash). */
export function parseCommandLine(input: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | undefined
  let escaped = false
  let started = false
  for (const char of input) {
    if (escaped) {
      token += char
      escaped = false
      started = true
      continue
    }
    if (char === '\\' && quote !== "'") {
      escaped = true
      started = true
      continue
    }
    if (quote !== undefined) {
      if (char === quote) quote = undefined
      else token += char
      started = true
      continue
    }
    if (char === '"' || char === "'") {
      quote = char
      started = true
      continue
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(token)
        token = ''
        started = false
      }
      continue
    }
    token += char
    started = true
  }
  if (escaped) throw new Error('unterminated escape')
  if (quote !== undefined) throw new Error('unterminated quote')
  if (started) tokens.push(token)
  return tokens
}

/** Structural view of cordis internals for runtime capability attribution.
 *  All public in cordis 4.x (reflect.store, registry, fiber.getEffects) —
 *  the same recipe the harness's own tool-cordis inspect helpers use. */
interface FiberLike {
  name?: string
  state?: unknown
  parent?: { fiber?: FiberLike }
  getEffects?(): Array<{ label?: string; children?: unknown[] }>
}
interface CordisInternals {
  reflect: { store: Record<symbol, { name: string; fiber: FiberLike; value: unknown }> }
  registry: Map<unknown, { name?: string; fibers: Iterable<FiberLike> }>
}

/** Service names dscode has a rendering rail for, with the human meaning. */
const KNOWN_RAILS: Record<string, string> = {
  llm: 'LLM providers/models (surface in /provider and /model)',
  commands: 'slash commands (auto-surface in the TUI)',
  userQuestions: 'interactive questions (TUI pickers)',
  tools: 'model-facing tools (approval-gated)',
  agentPresets: 'agent presets (/preset)',
}

/** Fiber-parentage subtree test — object identity, never uid (uids collide
 *  across registries; see agent-presets mount.ts). */
function withinFiber(fiber: FiberLike, root: FiberLike): boolean {
  let current: FiberLike | undefined = fiber
  while (current !== undefined) {
    if (current === root) return true
    const parent: FiberLike | undefined = current.parent?.fiber
    if (parent === undefined || parent === current) return false
    current = parent
  }
  return false
}

/** Two-layer runtime capability report for one loaded plugin: the mechanical
 *  layer lists every service its fibers provided (semantics unknown, named
 *  as-is); the rail layer expands the subset dscode understands. Returns
 *  undefined when no live fiber matches (not loaded yet, or a plain dep). */
export function inspectPluginRuntime(ctx: Context, packageName: string): string | undefined {
  const internals = ctx as unknown as CordisInternals
  const roots: FiberLike[] = []
  for (const runtime of internals.registry.values()) {
    const name = runtime.name
    if (name === undefined) continue
    if (name !== packageName && !name.startsWith(packageName + '/')) continue
    for (const fiber of runtime.fibers) roots.push(fiber)
  }
  if (roots.length === 0) return undefined
  const store = internals.reflect.store
  const provided: string[] = []
  for (const key of Object.getOwnPropertySymbols(store)) {
    const impl = store[key]
    if (impl !== undefined && roots.some(root => withinFiber(impl.fiber, root))) {
      provided.push(impl.name)
    }
  }
  const effectLabels = new Map<string, number>()
  for (const root of roots) {
    for (const effect of root.getEffects?.() ?? []) {
      const label = effect.label ?? '(unlabeled)'
      effectLabels.set(label, (effectLabels.get(label) ?? 0) + 1)
    }
  }
  const lines = [packageName + ' — live in this leader (' + String(roots.length) + ' plugin instance(s)):']
  if (provided.length > 0) {
    lines.push('  provides services: ' + provided.join(', '))
    for (const name of provided) {
      if (KNOWN_RAILS[name] !== undefined) lines.push('    · ' + name + ' → ' + KNOWN_RAILS[name])
    }
  } else {
    lines.push('  provides no services (consumer-only plugin)')
  }
  if (effectLabels.size > 0) {
    const shown = [...effectLabels.entries()].slice(0, 12)
      .map(([label, count]) => count > 1 ? label + ' ×' + String(count) : label)
    lines.push('  registered effects: ' + shown.join(', ') + (effectLabels.size > 12 ? ', …' : ''))
  }
  return lines.join('\n')
}

export interface ProfilePluginDependencies {
  inspectRuntime(name: string): string | undefined
  /** External npm process; tests supply an installer confined to their fixture. */
  exec?: (file: string, args: string[], options: { cwd: string; timeout: number }) => Promise<unknown>
  directory?: () => string | undefined
}

/** Owns profile inspection and locked package mutations, independent of sessions
 * and wire settlement. Only explicit /dsh add or remove reaches an installer. */
export function createProfilePlugins(dependencies: ProfilePluginDependencies) {
  let closed = false
  const pending = new Set<Promise<string>>()
  /** The dsh profile directory this bridge is installed in: the directory
   *  holding the node_modules we were loaded from, a DSH_PROFILE_DIR
   *  override (tests), or the default dscode profile. `undefined`
   *  in a source checkout with no installed profile. */
  const dshProfileDir = dependencies.directory ?? ((): string | undefined => {
    const override = process.env.DSH_PROFILE_DIR
    if (override !== undefined && override.length > 0) return override
    const self = fileURLToPath(import.meta.url)
    const marker = sep + 'node_modules' + sep
    const idx = self.indexOf(marker)
    if (idx > 0) return self.slice(0, idx)
    const fallback = join(homedir(), '.dsh', 'profiles', 'dscode')
    return existsSync(join(fallback, 'package.json')) ? fallback : undefined
  })

  const execFileAsync = dependencies.exec ?? promisify(execFile)

  const readProfileManifest = async (dir: string): Promise<{ dependencies: Record<string, string>; bundles: string[]; raw: Record<string, unknown> }> => {
    const raw = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as Record<string, unknown>
    const dependencies = (raw.dependencies ?? {}) as Record<string, string>
    const dsh = (raw.dsh ?? {}) as { profile?: { bundles?: string[] } }
    return { dependencies, bundles: dsh.profile?.bundles ?? [], raw }
  }

  const writeProfileBundles = async (dir: string, raw: Record<string, unknown>, bundles: string[]): Promise<void> => {
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

  type BundleInspection =
    | { kind: 'plain' }
    | { kind: 'bundle'; analysis: BundlePatchAnalysis }
    | { kind: 'broken'; error: string }

  const CORE_PLUGIN_NAMES = new Set(['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dscode', '@deepseek-ai/dsh-grok-leader'])

  /** Inspect one freshly installed package: plain dependency, valid bundle
   *  (with its patch analysis), or a bundle whose patch would brick the boot. */
  const inspectInstalledBundle = async (
    dir: string,
    name: string,
  ): Promise<BundleInspection> => {
    const pkgDir = join(dir, 'node_modules', ...name.split('/'))
    try {
      const manifest = JSON.parse(await readFile(join(pkgDir, 'package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
      const patchRel = manifest.dsh?.bundle?.patch
      if (patchRel === undefined) return { kind: 'plain' }
      const patchText = await readFile(join(pkgDir, patchRel), 'utf8')
      return { kind: 'bundle', analysis: analyzeBundlePatch(patchText) }
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

  const normalizeAuditSpec = (profileDir: string, spec: string): string => {
    if (spec.startsWith('file:')) {
      const path = spec.slice('file:'.length)
      return 'file:' + (isAbsolute(path) ? path : resolve(profileDir, path))
    }
    if (spec.startsWith('./') || spec.startsWith('../')) return resolve(profileDir, spec)
    return spec
  }

  /** Install without lifecycle scripts into an isolated directory and inspect
   * every requested root package before the real profile is mutated. */
  const auditPluginSpecs = async (
    profileDir: string,
    specs: string[],
  ): Promise<Array<{ name: string; info: BundleInspection }>> => {
    const stage = await mkdtemp(join(tmpdir(), 'dscode-plugin-audit-'))
    try {
      await writeFile(join(stage, 'package.json'), JSON.stringify({ private: true }, null, 2) + '\n')
      await npmInstall(stage, specs.map(spec => normalizeAuditSpec(profileDir, spec)))
      const manifest = await readProfileManifest(stage)
      const names = Object.keys(manifest.dependencies)
      if (names.length === 0) throw new Error('npm installed no root package for: ' + specs.join(', '))
      return await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(stage, name) })))
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
  }

  const bundleRequiresTrust = (info: BundleInspection): boolean => info.kind === 'bundle'

  /** Human summary of a bundle's composition delta. */
  const describeAnalysis = (name: string, analysis: BundlePatchAnalysis): string => {
    const lines = [name + ' contributes a composition layer:']
    if (analysis.insertedRows.length > 0) lines.push('  + inserts ' + String(analysis.insertedRows.length) + ' row(s): ' + analysis.insertedRows.join(', '))
    if (analysis.overriddenRows.length > 0) lines.push('  ~ overrides: ' + analysis.overriddenRows.join(', '))
    if (analysis.disabledRows.length > 0) lines.push('  - disables: ' + analysis.disabledRows.join(', '))
    if (analysis.sensitiveRows.length > 0) lines.push('  ⚠ touches security rows: ' + analysis.sensitiveRows.join(', ') + ' (sandbox/approval spine — make sure you trust this)')
    if (analysis.jsExprCount > 0) lines.push('  ⚠ contains ' + String(analysis.jsExprCount) + ' !!js expression(s) — code that runs at leader boot')
    if (lines.length === 1) lines.push('  (empty layer)')
    return lines.join('\n')
  }

  const executeCommand = async (text: string, notify: (message: string) => void = () => {}): Promise<string> => {
    const usage = 'Usage: /dsh plugins | /dsh add [--trust] <package|git-url|file:path> | /dsh remove <name> | /dsh inspect <name>'
    let words: string[]
    try {
      words = parseCommandLine(text).slice(1)
    } catch (error) {
      return 'Could not parse /dsh command: ' + (error instanceof Error ? error.message : String(error))
    }
    const [verb, ...rest] = words
    const dir = dshProfileDir()
    if (dir === undefined) {
      return 'dsh plugin management is unavailable: no installed leader profile was found (running from a source checkout?). Use: dsh plugin --profile dscode add <package>'
    }
    const execute = async (): Promise<string> => {
      switch (verb) {
        case undefined:
        case 'plugins':
        case 'list': {
          const { dependencies, bundles } = await readProfileManifest(dir)
          const lines = bundles.map(name => {
            const core = name === '@deepseek-ai/dsh-base' || name === '@hqzhao95/dscode' || name === 'dscode' || name === '@deepseek-ai/dsh-grok-leader' ? ' (core)' : ''
            const version = dependencies[name] === undefined ? '' : ' ' + dependencies[name]
            return '- ' + name + version + core
          })
          return 'Plugins in ' + dir + ':\n' + lines.join('\n') + '\n\n' + usage
        }
        case 'add': {
          const trusted = rest.includes('--trust')
          const specs = rest.filter(part => part !== '--trust' && part.length > 0)
          if (specs.length === 0) return 'Missing package. ' + usage
          const option = specs.find(spec => spec.startsWith('-'))
          if (option !== undefined) return 'Unsupported npm option "' + option + '". Package specs may not start with "-".'
          notify('Auditing ' + specs.join(' ') + ' in an isolated npm stage (install scripts disabled)...')
          const staged = await auditPluginSpecs(dir, specs)
          const core = staged.find(entry => CORE_PLUGIN_NAMES.has(entry.name))
          if (core !== undefined) return core.name + ' is a core component; use dscode update instead of /dsh add.'
          const broken = staged.find(entry => entry.info.kind === 'broken')
          if (broken !== undefined && broken.info.kind === 'broken') {
            return 'Refused ' + broken.name + ' before profile mutation: its bundle cannot be inspected.\n' + broken.info.error
          }
          const stagedReport = staged.map(({ name, info }) => info.kind === 'plain'
            ? name + ': declares no dsh.bundle — it will remain a plain dependency.'
            : info.kind === 'bundle'
              ? describeAnalysis(name, info.analysis)
              : '').filter(Boolean)
          const executableBundle = staged.some(entry => bundleRequiresTrust(entry.info))
          if (executableBundle && !trusted) {
            return 'Not installed. Review the requested composition changes:\n\n'
              + stagedReport.join('\n\n')
              + '\n\nIf you trust this code, rerun: /dsh add --trust ' + specs.map(spec => JSON.stringify(spec)).join(' ')
          }
          notify('Installing audited package(s) into the leader profile with npm (lifecycle scripts disabled)...')
          await npmInstall(dir, specs)
          const manifest = await readProfileManifest(dir)
          const names = staged.map(entry => entry.name)
          const actual = await Promise.all(names.map(async name => ({ name, info: await inspectInstalledBundle(dir, name) })))
          const invalid = actual.find(entry => entry.info.kind === 'broken' || (!trusted && bundleRequiresTrust(entry.info)))
          if (invalid !== undefined) {
            // The staged and real package differed. Disable every touched root
            // before returning so an existing bundle cannot brick the next boot.
            await writeProfileBundles(dir, manifest.raw, manifest.bundles.filter(bundle => !names.includes(bundle)))
            const reason = invalid.info.kind === 'broken'
              ? invalid.info.error
              : 'the installed package introduced an executable bundle after staging'
            return 'Installed dependency was left disabled because post-install verification failed for ' + invalid.name + ':\n' + reason
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
          }
          await writeProfileBundles(dir, manifest.raw, [...bundles])
          return 'Installed or updated ' + names.join(', ') + '.\n\n' + report.join('\n\n') + '\n\nRestart dscode to load it (the leader exits with its last client).'
        }
        case 'inspect': {
          const name = rest[0]
          if (name === undefined) return 'Missing plugin name. ' + usage
          const runtime = dependencies.inspectRuntime(name)
          if (runtime !== undefined) return runtime
          const manifest = await readProfileManifest(dir)
          if (manifest.dependencies[name] !== undefined) {
            return name + ' is installed but has no live plugin instance in this leader (restart dscode to load it, or it is a plain dependency / composition-only bundle).'
          }
          return name + ' is not installed. Installed: ' + Object.keys(manifest.dependencies).join(', ')
        }
        case 'remove': {
          const name = rest[0]
          if (name === undefined) return 'Missing plugin name. ' + usage
          if (rest.length !== 1) return 'Usage: /dsh remove <name>'
          if (CORE_PLUGIN_NAMES.has(name)) {
            return name + ' is a core component of this leader; refusing to remove it.'
          }
          const manifest = await readProfileManifest(dir)
          if (manifest.dependencies[name] === undefined) {
            return name + ' is not installed. Installed: ' + Object.keys(manifest.dependencies).join(', ')
          }
          // Unregister first: a failed npm cleanup then leaves an inert package,
          // never a profile entry pointing at a missing dependency.
          await writeProfileBundles(dir, manifest.raw, manifest.bundles.filter(bundle => bundle !== name))
          try {
            await npmUninstall(dir, [name])
          } catch (error) {
            return 'Unregistered ' + name + ', but npm could not remove the inert dependency: '
              + (error instanceof Error ? error.message : String(error))
          }
          return 'Removed ' + name + '.\nRestart dscode to unload it.'
        }
        default:
          return 'Unknown /dsh subcommand "' + String(verb) + '". ' + usage
      }
    }
    try {
      return verb === 'add' || verb === 'remove' ? await withProfileLock(dir, execute) : await execute()
    } catch (error: unknown) {
      return '/dsh ' + String(verb) + ' failed: ' + (error instanceof Error ? error.message : String(error))
    }
  }

  return {
    directory: dshProfileDir,
    async execute(text: string, notify?: (message: string) => void): Promise<string> {
      if (closed) throw new Error('profile plugin management has been disposed')
      const operation = executeCommand(text, notify)
      pending.add(operation)
      try { return await operation } finally { pending.delete(operation) }
    },
    /** Let an accepted locked mutation finish its post-install verification;
     * exiting midway could leave a dependency enabled without that check. */
    async dispose(): Promise<void> {
      closed = true
      await Promise.allSettled([...pending])
    },
  }
}
