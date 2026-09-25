/** Read-only plugin views for `/dsh`: the plugin table over the DSH plugin
 * manager, English wording for its refusals (the copy of DSH's own Plugins
 * page), and the bundles boot skipped. No writes. */
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { errorMessage } from './guards.ts'
import type { BundleLike, LocalizedTextLike, ManagementErrorLike, PluginEntryLike } from './plugin-rows.ts'

/** English of a localized display text. */
export const english = (text: LocalizedTextLike | undefined): string | undefined =>
  text === undefined ? undefined : typeof text === 'string' ? text : text.en

/** What a person calls a package: unscoped, without the harness prefixes. */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** A bundle's display title: its locale title, else its short name. */
export function bundleTitle(bundle: Pick<BundleLike, 'name' | 'meta'>): string {
  const title = english(bundle.meta?.title)
  return title === undefined || title === bundle.name ? shortName(bundle.name) : title
}

const oneLine = (text: string, limit = 120): string => {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > limit ? line.slice(0, limit - 1).trimEnd() + '…' : line
}

/** The refusal sentences DSH's Plugins page words the manager's codes as. */
const REASONS: Record<string, string> = {
  'management-required': 'Plugin management needs it; it cannot be switched off or uninstalled.',
  unaddressable: 'The profile patch cannot address this one uniquely.',
  'unknown-plugin': 'No such plugin.',
  'not-bundle': 'This package declares no bundle, so it cannot be managed as a plugin.',
  'incompatible-version': 'This plugin is incompatible with the running DSH version; running it may cause crashes or data loss.',
}

/** One sentence for a management error: the code's sentence, one per package
 * an incompatibility names, or an operation error's own diagnostic. */
export function managementText(error: ManagementErrorLike | undefined): string {
  if (error?.code === 'incompatible-version' && error.incompatible !== undefined && error.incompatible.length > 0) {
    return error.incompatible.map(plugin => plugin.name + '@' + plugin.version + ' is incompatible with DSH ' + plugin.runtimeVersion
      + ' (requires ' + Object.entries(plugin.peers).map(([name, range]) => name + ' ' + range).join(', ')
      + '); running it may cause crashes or data loss. Install a plugin version compatible with this DSH.').join(' ')
  }
  const known = error?.code === undefined ? undefined : REASONS[error.code]
  if (known !== undefined) return known
  return error?.diagnostic !== undefined && error.diagnostic !== '' ? error.diagnostic : error?.code ?? 'The Host reported an error.'
}

/** A bundle's rows by state; the states only mean something while it is on. */
export function rowSummary(bundle: BundleLike, plugins: readonly PluginEntryLike[]): string {
  const total = String(bundle.rows.length) + (bundle.rows.length === 1 ? ' row' : ' rows')
  if (!bundle.enabled) return total
  let running = 0, off = 0, failed = 0, waiting = 0
  for (const row of bundle.rows) {
    const entry = row.entryId === undefined ? undefined : plugins.find(plugin => plugin.entryId === row.entryId)
    if (entry?.fiberPhase === 'failed') failed++
    else if (entry === undefined || !entry.enabled) off++
    else if (entry.fiberPhase === 'active') running++
    else waiting++
  }
  return [total, ...[[running, 'running'], [off, 'off'], [failed, 'failed'], [waiting, 'waiting']]
    .filter(([count]) => count !== 0).map(([count, label]) => String(count) + ' ' + String(label))].join(' · ')
}

/** Bundles every DSH installation ships as other applications' base layers;
 * DSH's Plugins page leaves them out, as dscode does unless one is selected. */
const BUILTIN_BUNDLES = new Set(['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', '@deepseek-ai/dsh-headless',
  '@deepseek-ai/dsh-sdk-app', '@deepseek-ai/dsh-acp-app', '@deepseek-ai/dsh-sdk-minimal'])

export interface SkippedBundle { packageName: string; reason: string }
export interface PluginTable {
  dir: string
  bundles: readonly BundleLike[]
  plugins: readonly PluginEntryLike[]
  /** `dsh.profile.bundles`, the layer order. */
  order: readonly string[]
  core: ReadonlySet<string>
  skipped: readonly SkippedBundle[]
}

const cell = (text: string): string => text.replace(/\|/g, '\\|').replace(/\s+/g, ' ')

/** The kind tags one bundle carries, most important first. */
function kinds(bundle: BundleLike, core: ReadonlySet<string>): string[] {
  return [
    ...core.has(bundle.name) ? ['core'] : bundle.optional ? ['official', 'optional'] : bundle.installed ? ['installed'] : [],
    ...bundle.name.startsWith('@deepseek-ai/dsh-experimental-') ? ['experimental'] : [],
    ...bundle.removable && !core.has(bundle.name) ? ['removable'] : [],
  ]
}

/** `/dsh plugins`: every bundle this profile runs, holds or may switch on, as
 * one aligned table, then the reason for each problem bundle. */
export function pluginTable({ dir, bundles, plugins, order, core, skipped }: PluginTable): string {
  const shown = bundles.filter(bundle => (core.has(bundle.name) && bundle.enabled)
    || (!BUILTIN_BUNDLES.has(bundle.name) && (bundle.installed || bundle.optional || bundle.error !== undefined)))
  const position = (bundle: BundleLike) => bundle.enabled && order.includes(bundle.name) ? order.indexOf(bundle.name) : order.length
  const group = (bundle: BundleLike) => bundle.enabled ? 0 : bundle.installed ? 1 : 2
  shown.sort((a, b) => group(a) - group(b) || position(a) - position(b) || shortName(a.name).localeCompare(shortName(b.name)))
  const problems = new Map<string, string>()
  for (const bundle of shown) if (bundle.error !== undefined) problems.set(bundle.name, managementText(bundle.error))
  for (const { packageName, reason } of skipped) problems.set(packageName, 'skipped at startup: ' + reason)
  const on = shown.filter(bundle => bundle.enabled).length
  const lines = ['Plugins in `' + dir + '`: ' + String(on) + ' on · ' + String(shown.length - on) + ' off'
    + (problems.size > 0 ? ' · ' + String(problems.size) + (problems.size === 1 ? ' problem' : ' problems') : ''), '',
  '| State | Plugin | Package | Kind | Rows |', '| --- | --- | --- | --- | --- |']
  for (const bundle of shown) {
    const description = english(bundle.meta?.description) ?? bundle.description
    lines.push('| ' + [
      (bundle.enabled ? 'on' : 'off') + (problems.has(bundle.name) ? ' · problem' : ''),
      '**' + cell(bundleTitle(bundle)) + '**' + (description === undefined || description === '' ? '' : ': ' + cell(oneLine(description))),
      '`' + bundle.name + (bundle.version === undefined ? '' : '@' + bundle.version) + '`',
      kinds(bundle, core).join(' · ') || '-',
      rowSummary(bundle, plugins),
    ].join(' | ') + ' |')
  }
  if (problems.size > 0) {
    lines.push('', 'Problems:')
    for (const [name, reason] of problems) lines.push('- `' + name + '`: ' + oneLine(reason, 400))
  }
  return lines.join('\n')
}

/** `/dsh inspect <bundle>`: its rows and their live state. */
export function bundleDetail(bundle: BundleLike, plugins: readonly PluginEntryLike[], core: ReadonlySet<string>): string {
  const description = english(bundle.meta?.description) ?? bundle.description
  const lines = ['**' + bundleTitle(bundle) + '** `' + bundle.name + (bundle.version === undefined ? '' : '@' + bundle.version) + '`: '
    + [bundle.enabled ? 'on' : 'off', ...kinds(bundle, core)].join(' · ')]
  if (description !== undefined && description !== '') lines.push('', oneLine(description, 400))
  if (bundle.error !== undefined) lines.push('', 'Problem: ' + managementText(bundle.error))
  lines.push('', 'Components (' + rowSummary(bundle, plugins) + '):')
  for (const row of bundle.rows) {
    const entry = row.entryId === undefined ? undefined : plugins.find(plugin => plugin.entryId === row.entryId)
    const state = !bundle.enabled || entry === undefined ? 'not loaded' : !entry.enabled ? 'off'
      : entry.fiberPhase === 'active' ? 'running' : entry.fiberPhase ?? 'not running'
    const locked = entry?.readOnlyReason === undefined ? '' : ' · locked: ' + managementText({ code: entry.readOnlyReason })
    lines.push('- `' + row.rowId + '` ' + row.moduleName + ' · ' + state + locked)
  }
  if (bundle.overrides.length > 0) lines.push('', 'Changes built-in rows: ' + bundle.overrides.join(', '))
  return lines.join('\n')
}

/** A boot skip reason without the error class, the CLI prefix, or DSH's pnpm
 * repair hint (dscode manages this profile with npm through /dsh). */
export const skipReason = (reason: string): string =>
  reason.replace(/^\w*Error: /, '').replace(/^(?:dsh|dscode): /, '').replace(/; run 'dsh plugin [^']*'.*$/, '')

/** Launcher facts of the running profile (`ProfileContext`). */
export interface ProfileContextLike { readonly dir: string; readonly installAnchor: string; readonly startedBundles: readonly string[] }
export interface PluginStatusDependencies {
  profile(): ProfileContextLike | undefined
  logger: { warn(message: string): void }
}

/** The bundles this leader's start skipped, read once from the profile. */
export function createPluginStatus(dependencies: PluginStatusDependencies) {
  let skipped: SkippedBundle[] | undefined
  const readSkipped = (): readonly SkippedBundle[] => {
    if (skipped !== undefined) return skipped
    const profile = dependencies.profile()
    if (profile === undefined) return (skipped = [])
    try {
      const started = new Set(profile.startedBundles)
      skipped = loadProfileDirectory('dscode', profile.dir, profile.installAnchor, { userLayer: false }).skippedBundles
        .filter(entry => !started.has(entry.packageName)).map(entry => ({ packageName: entry.packageName, reason: skipReason(entry.reason) }))
    } catch (error) {
      dependencies.logger.warn('grok-leader: cannot read the profile bundles: ' + errorMessage(error))
      skipped = []
    }
    return skipped
  }
  return { skipped: readSkipped }
}

export type PluginStatus = ReturnType<typeof createPluginStatus>
