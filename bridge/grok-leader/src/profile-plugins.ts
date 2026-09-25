import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import { getDshRuntimeVersion, pluginCompatibilityWarning, readProfileCompatibility, setProfileVersionExemption } from '@deepseek-ai/dsh-app-boot'
import { withProfileLock } from './package-location.ts'
import { invalidParams } from './acp.ts'
import { confirmation, type SelectOption } from './command-options.ts'
import { errorMessage } from './guards.ts'
import {
  CORE_PLUGIN_NAMES, bundleRequiresTrust, createPluginBundles, describeAnalysis, readProfileManifest, refusedCompatibility, writeProfileBundles,
  type PluginBundleDependencies, type PluginBundles,
} from './plugin-bundles.ts'
import type { SettingsLike } from './native-seams.ts'
import type { BundleLike, PluginManagerLike, PluginRows } from './plugin-rows.ts'
import { CONFIG_USAGE, createPluginSettings } from './plugin-settings.ts'
import { bundleDetail, bundleTitle, managementText, outcomeText, pluginTable, shownBundles, type SkippedBundle } from './plugin-status.ts'

export { SENSITIVE_ROW_IDS, analyzeBundlePatch, type BundlePatchAnalysis } from './plugin-bundles.ts'

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

export interface ProfilePluginDependencies extends PluginBundleDependencies {
  inspectRuntime(name: string): string | undefined
  directory?: () => string | undefined
  /** The running leader's DSH plugin manager; absent outside a leader. */
  pluginManager?: () => PluginManagerLike | undefined
  /** Switches bundles and rows through that manager and applies them live. */
  switches?: Pick<PluginRows, 'switchBundle' | 'switchRow'>
  /** Bundles this leader's start skipped, with why. */
  skipped?: () => readonly SkippedBundle[]
  /** DSH's settings service, which `/dsh config` reads and writes through. */
  settings?: () => SettingsLike | undefined
}

// Inline code: the TUI renders replies as Markdown, where a bare `<name>` is HTML.
const USAGE = 'Usage: `/dsh plugins` | `/dsh enable <bundle>[#row]` | `/dsh disable <bundle>[#row]` | `/dsh add [--trust] <package|git-url|file:path>`'
  + ' | `/dsh remove <name>` | `/dsh inspect <name>` | `/dsh allow-version <package@version> --accept-risk` | `/dsh revoke-version <package@version>`'
  + ' | ' + CONFIG_USAGE

/** Verbs that mutate the profile, and so run under its lock. */
const LOCKED_VERBS: ReadonlySet<string | undefined> = new Set(['add', 'remove', 'enable', 'disable', 'allow-version', 'revoke-version'])

/** The live plugin manager a leader offers /dsh, with what its start skipped. */
interface PluginCatalog {
  readonly manager: PluginManagerLike
  readonly switches: Pick<PluginRows, 'switchBundle' | 'switchRow'> | undefined
  skipped(): readonly SkippedBundle[]
}

/** One parsed /dsh command against an installed profile directory. */
interface PluginVerb {
  readonly dir: string
  readonly verb: string | undefined
  readonly rest: string[]
  notify(message: string): void
  readonly bundles: PluginBundles
  inspectRuntime(name: string): string | undefined
  readonly catalog: PluginCatalog | undefined
}

async function listPlugins({ dir, catalog }: PluginVerb): Promise<string> {
  const { dependencies, bundles } = await readProfileManifest(dir)
  let note = ''
  if (catalog !== undefined) {
    try {
      const [listed, plugins] = await Promise.all([catalog.manager.listBundles(), catalog.manager.listPlugins()])
      return pluginTable({ dir, bundles: listed, plugins, order: bundles, core: CORE_PLUGIN_NAMES, skipped: catalog.skipped() }) + '\n\n' + USAGE
    } catch (error) {
      note = '\n\nThe DSH plugin manager could not list the bundles (' + errorMessage(error) + '); this is the profile manifest.'
    }
  }
  const lines = bundles.map(name => {
    const core = CORE_PLUGIN_NAMES.has(name) ? ' (core)' : ''
    const version = dependencies[name] === undefined ? '' : ' ' + dependencies[name]
    return '- ' + name + version + core
  })
  return 'Plugins in ' + dir + ':\n' + lines.join('\n') + note + '\n\n' + USAGE
}

/** `/dsh enable|disable <bundle>[#row]` through the DSH plugin manager, as its
 * Plugins page switches them; dscode's own bundles and their rows stay on. */
async function switchPlugin({ verb, rest, catalog }: PluginVerb): Promise<string> {
  const enabled = verb === 'enable'
  if (rest.length !== 1) return 'Usage: `/dsh ' + String(verb) + ' <bundle>[#row]`'
  if (catalog?.switches === undefined) return 'Switching plugins needs the DSH plugin manager, which this leader does not run. Restart dscode and retry.'
  const target = rest[0]!
  const hash = target.indexOf('#')
  const name = hash === -1 ? target : target.slice(0, hash)
  const rowId = hash === -1 ? undefined : target.slice(hash + 1)
  const bundle = (await catalog.manager.listBundles()).find(candidate => candidate.name === name)
  if (bundle === undefined) return name + ' is not a bundle of this profile. /dsh plugins lists them; /dsh add installs one.'
  const title = bundleTitle(bundle)
  const core = CORE_PLUGIN_NAMES.has(name)
  if (rowId === undefined) {
    if (!enabled && core) return name + ' is part of dscode itself; turning it off would stop dscode from starting.'
    if (bundle.readOnlyReason !== undefined) return title + ': ' + managementText({ code: bundle.readOnlyReason })
    if (bundle.enabled === enabled) return title + ' is already ' + (enabled ? 'on' : 'off') + '.'
    // A bundle DSH cannot read cannot be switched on; a selected one can be deselected.
    if (enabled && bundle.error !== undefined) return 'Could not enable: ' + managementText(bundle.error)
    return outcomeText(await catalog.switches.switchBundle(name, enabled, bundle.rows.map(row => row.rowId)), enabled, title + ' (' + name + ')', false)
  }
  const row = bundle.rows.find(candidate => candidate.rowId === rowId)
  if (row === undefined) return title + ' has no component "' + rowId + '". Components: ' + (bundle.rows.map(candidate => candidate.rowId).join(', ') || 'none') + '.'
  if (!enabled && core) return rowId + ' is part of dscode itself; use the command that owns it (/browser, /provider) or edit cordis.patch.yml.'
  if (!bundle.enabled) return title + ' is off; turn it on first with /dsh enable ' + name + '.'
  const entry = row.entryId === undefined ? undefined : (await catalog.manager.listPlugins()).find(candidate => candidate.entryId === row.entryId)
  if (entry === undefined) return rowId + ' has no live entry in this leader, so it cannot be switched. Restart dscode and retry.'
  if (entry.readOnlyReason !== undefined || entry.patchId === undefined) return rowId + ': ' + managementText({ code: entry.readOnlyReason ?? 'unaddressable' })
  if (entry.enabled === enabled) return 'The component ' + rowId + ' is already ' + (enabled ? 'on' : 'off') + '.'
  return outcomeText(await catalog.switches.switchRow({ entryId: entry.entryId, patchId: entry.patchId }, enabled), enabled, rowId + ' of ' + title, true)
}

/** Audit in an isolated stage, refuse core, broken or incompatible packages and
 * untrusted bundles, then install and verify what npm actually installed. */
async function addPlugins({ dir, rest, notify, bundles: pluginBundles }: PluginVerb): Promise<string> {
  const trusted = rest.includes('--trust')
  const specs = rest.filter(part => part !== '--trust' && part.length > 0)
  if (specs.length === 0) return 'Missing package. ' + USAGE
  const option = specs.find(spec => spec.startsWith('-'))
  if (option !== undefined) return 'Unsupported npm option "' + option + '". Package specs may not start with "-".'
  notify('Auditing ' + specs.join(' ') + ' in an isolated npm stage (install scripts disabled)...')
  const staged = await pluginBundles.auditPluginSpecs(dir, specs)
  const core = staged.find(entry => CORE_PLUGIN_NAMES.has(entry.name))
  if (core !== undefined) return core.name + ' is a core component; use dscode update instead of /dsh add.'
  const broken = staged.find(entry => entry.info.kind === 'broken')
  if (broken !== undefined && broken.info.kind === 'broken') {
    return 'Refused ' + broken.name + ' before profile mutation: its bundle cannot be inspected.\n' + broken.info.error
  }
  const incompatible = staged.map(entry => refusedCompatibility(entry.info)).find(issue => issue !== undefined)
  if (incompatible !== undefined) {
    const key = incompatible.name + '@' + incompatible.version
    const problems = readProfileCompatibility(dir).warnings
    return 'Refused ' + key + ' before profile mutation: the dsh runtime would not load it.\n'
      + pluginCompatibilityWarning(incompatible)
      + (problems.length > 0 ? '\nThe profile compatibility file has problems, so no exemption applies:\n' + problems.join('\n') : '')
      + '\nTo accept the risk for this exact version: /dsh allow-version ' + key + ' --accept-risk, then rerun /dsh add.'
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
  return await pluginBundles.installAudited(dir, specs, staged, trusted)
}

async function inspectPlugin({ dir, rest, inspectRuntime, catalog }: PluginVerb): Promise<string> {
  const name = rest[0]
  if (name === undefined) return 'Missing plugin name. ' + USAGE
  const runtime = inspectRuntime(name)
  const bundle = (await catalog?.manager.listBundles().catch(() => undefined))?.find(candidate => candidate.name === name)
  if (bundle !== undefined) {
    const detail = bundleDetail(bundle, await catalog!.manager.listPlugins(), CORE_PLUGIN_NAMES)
    return runtime === undefined ? detail : runtime + '\n\n' + detail
  }
  if (runtime !== undefined) return runtime
  const manifest = await readProfileManifest(dir)
  if (manifest.dependencies[name] !== undefined) {
    return name + ' is installed but has no live plugin instance in this leader (restart dscode to load it, or it is a plain dependency / composition-only bundle).'
  }
  return name + ' is not installed. Installed: ' + Object.keys(manifest.dependencies).join(', ')
}

/** allow-version / revoke-version: one exact-version exemption on this DSH version. */
async function versionExemption({ dir, verb, rest }: PluginVerb): Promise<string> {
  const allow = verb === 'allow-version'
  const acceptRisk = rest.includes('--accept-risk')
  const keys = rest.filter(part => part !== '--accept-risk')
  if (keys.length !== 1 || (!allow && acceptRisk)) return 'Usage: `/dsh allow-version <package@version> --accept-risk` | `/dsh revoke-version <package@version>`'
  if (allow && !acceptRisk) {
    return 'Running a plugin whose dsh peers this runtime does not satisfy can crash dscode or corrupt data. '
      + 'The exemption covers only ' + keys[0] + ' on this exact DSH version. Rerun with --accept-risk to grant it.'
  }
  const runtimeVersion = getDshRuntimeVersion()
  await setProfileVersionExemption(dir, keys[0]!, runtimeVersion, allow, acceptRisk)
  return (allow ? 'Allowed ' : 'Revoked ') + keys[0] + ' for DSH ' + runtimeVersion + '. Restart dscode to apply it.'
}

async function removePlugin({ dir, rest, bundles: pluginBundles }: PluginVerb): Promise<string> {
  const name = rest[0]
  if (name === undefined) return 'Missing plugin name. ' + USAGE
  if (rest.length !== 1) return 'Usage: `/dsh remove <name>`'
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
    await pluginBundles.npmUninstall(dir, [name])
  } catch (error) {
    return 'Unregistered ' + name + ', but npm could not remove the inert dependency: '
      + errorMessage(error)
  }
  return 'Removed ' + name + '.\nRestart dscode to unload it.'
}

/** `/dsh` choices: the verbs a pick completes, then the bundles `enable`,
 * `disable`, `inspect` or `remove` applies to, by title with the package as
 * detail; `config` asks `plugin-settings` for its namespaces. Adding a package
 * and version trust need typed text. */
async function pluginOptions(dir: string, query: string, manager: PluginManagerLike | undefined, configurable: boolean): Promise<SelectOption[]> {
  if (query === '') {
    return [{ id: 'plugins', label: 'List plugins', detail: 'Every bundle, its state and problems' },
      ...manager === undefined ? [] : [{ id: 'enable', label: 'Turn a plugin on', next: true } as const, { id: 'disable', label: 'Turn a plugin off', next: true } as const],
      { id: 'inspect', label: 'Inspect a plugin', next: true }, { id: 'remove', label: 'Remove a plugin', next: true },
      ...configurable ? [{ id: 'config', label: 'Configure a plugin', detail: 'The settings each loaded plugin serves', next: true } as const] : []]
  }
  const bundles = shownBundles(await manager?.listBundles() ?? [], CORE_PLUGIN_NAMES)
  const row = (bundle: BundleLike): SelectOption => ({ id: query + ' ' + bundle.name, label: bundleTitle(bundle),
    detail: bundle.name + (bundle.version === undefined ? '' : '@' + bundle.version) })
  const switchable = (bundle: BundleLike) => bundle.readOnlyReason === undefined && !CORE_PLUGIN_NAMES.has(bundle.name)
  switch (query) {
    case 'enable': return bundles.filter(bundle => switchable(bundle) && !bundle.enabled && bundle.error === undefined).map(row)
    case 'disable': return bundles.filter(bundle => switchable(bundle) && bundle.enabled).map(row)
    case 'inspect': return bundles.map(row)
    case 'remove': {
      const { dependencies } = await readProfileManifest(dir)
      return Object.keys(dependencies).filter(name => !CORE_PLUGIN_NAMES.has(name)).map(name => {
        const bundle = bundles.find(candidate => candidate.name === name), title = bundle === undefined ? name : bundleTitle(bundle)
        return { id: 'remove ' + name, label: title, detail: name + '@' + String(dependencies[name]),
          confirmation: confirmation('Remove ' + title + '?', 'npm uninstalls it from this profile; restart dscode to unload it.', 'Remove') }
      })
    }
    default: return []
  }
}

async function runVerb(command: PluginVerb): Promise<string> {
  switch (command.verb) {
    case undefined:
    case 'plugins':
    case 'list': return await listPlugins(command)
    case 'add': return await addPlugins(command)
    case 'inspect': return await inspectPlugin(command)
    case 'enable':
    case 'disable': return await switchPlugin(command)
    case 'allow-version':
    case 'revoke-version': return await versionExemption(command)
    case 'remove': return await removePlugin(command)
    default:
      return 'Unknown /dsh subcommand "' + String(command.verb) + '". ' + USAGE
  }
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

  const bundles = createPluginBundles(dependencies)
  const settings = createPluginSettings({
    settings: () => dependencies.settings?.(),
    bundles: async () => await dependencies.pluginManager?.()?.listBundles() ?? [],
  })

  const executeCommand = async (text: string, notify: (message: string) => void = () => {}): Promise<string> => {
    // Settings edits go through DSH's settings service, which locks and
    // validates them itself; the raw line keeps a JSON value's quotes.
    if (settings.matches(text)) {
      try { return await settings.execute(text) } catch (error: unknown) { throw invalidParams('/dsh config failed: ' + errorMessage(error)) }
    }
    let words: string[]
    try {
      words = parseCommandLine(text).slice(1)
    } catch (error) {
      return 'Could not parse /dsh command: ' + errorMessage(error)
    }
    const [verb, ...rest] = words
    const dir = dshProfileDir()
    if (dir === undefined) {
      return 'dsh plugin management is unavailable: no installed leader profile was found (running from a source checkout?). Use: dsh plugin --profile dscode add <package>'
    }
    const manager = dependencies.pluginManager?.()
    const catalog = manager === undefined ? undefined
      : { manager, switches: dependencies.switches, skipped: () => dependencies.skipped?.() ?? [] }
    const execute = (): Promise<string> => runVerb({ dir, verb, rest, notify, bundles, inspectRuntime: name => dependencies.inspectRuntime(name), catalog })
    try {
      return LOCKED_VERBS.has(verb) ? await withProfileLock(dir, execute) : await execute()
    } catch (error: unknown) {
      throw invalidParams('/dsh ' + String(verb) + ' failed: ' + errorMessage(error))
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
    /** `x.ai/commands/options` for `/dsh`: reads only, outside the profile lock. */
    async options(query: string): Promise<SelectOption[]> {
      if (closed) throw new Error('profile plugin management has been disposed')
      if (query === 'config' || query.startsWith('config ')) return await settings.options(query)
      const dir = dshProfileDir()
      return dir === undefined ? [] : await pluginOptions(dir, query, dependencies.pluginManager?.(), dependencies.settings?.()?.describe !== undefined)
    },
    /** Let an accepted locked mutation finish its post-install verification;
     * exiting midway could leave a dependency enabled without that check. */
    async dispose(): Promise<void> {
      closed = true
      await Promise.allSettled([...pending])
    },
  }
}
