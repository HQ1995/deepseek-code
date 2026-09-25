/** Read-only plugin views for `/dsh` and `/doctor`: the plugin table over the
 * DSH plugin manager, with each bundle's own title and description in the
 * process locale, English wording for its outcomes and refusals (the copy of
 * DSH's own Plugins page), Loader rows that did not activate, and the bundles
 * boot skipped with the one-time notice that names them. No writes. */
import { loadProfileDirectory } from '@deepseek-ai/dsh-app-boot'
import { errorMessage } from './guards.ts'
import { environmentLocale, pick } from './localized-text.ts'
import type { BundleLike, ManagementErrorLike, PluginEntryLike, PluginManagerLike, SwitchOutcome } from './plugin-rows.ts'

/** What a person calls a package: unscoped, without the harness prefixes. */
export function shortName(name: string): string {
  const unscoped = name.startsWith('@') ? name.slice(name.indexOf('/') + 1) : name
  return unscoped.replace(/^dsh-(?:host-|client-)?/, '')
}

/** A bundle's display title in `locale`: its localized title, else its short name. */
export function bundleTitle(bundle: Pick<BundleLike, 'name' | 'meta'>, locale: string | undefined = environmentLocale()): string {
  const title = pick(bundle.meta?.title, locale)
  return title === undefined || title === bundle.name ? shortName(bundle.name) : title
}

/** A bundle's description in `locale`: its localized one, else its package's. */
export const bundleDescription = (bundle: Pick<BundleLike, 'meta' | 'description'>, locale: string | undefined = environmentLocale()): string | undefined =>
  pick(bundle.meta?.description, locale) ?? pick(bundle.description, locale)

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
  /** Lower-case BCP 47 tag of the display text; defaults to the process locale. */
  locale?: string
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
export function pluginTable({ dir, bundles, plugins, order, core, skipped, locale = environmentLocale() }: PluginTable): string {
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
    const description = bundleDescription(bundle, locale)
    lines.push('| ' + [
      (bundle.enabled ? 'on' : 'off') + (problems.has(bundle.name) ? ' · problem' : ''),
      '**' + cell(bundleTitle(bundle, locale)) + '**' + (description === undefined ? '' : ': ' + cell(oneLine(description))),
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

/** `/dsh inspect <bundle>`: its rows, their live state and switch address. */
export function bundleDetail(bundle: BundleLike, plugins: readonly PluginEntryLike[], core: ReadonlySet<string>, locale: string | undefined = environmentLocale()): string {
  const description = bundleDescription(bundle, locale)
  const lines = ['**' + bundleTitle(bundle, locale) + '** `' + bundle.name + (bundle.version === undefined ? '' : '@' + bundle.version) + '`: '
    + [bundle.enabled ? 'on' : 'off', ...kinds(bundle, core)].join(' · ')]
  if (description !== undefined) lines.push('', oneLine(description, 400))
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
  lines.push('', 'Switch one component with `/dsh enable|disable ' + bundle.name + '#<row>`.')
  return lines.join('\n')
}

/** The sentence an outcome reads as, in the Plugins page's wording. */
export function outcomeText(outcome: SwitchOutcome, enabled: boolean, subject: string, component: boolean): string {
  const noun = component ? 'the component ' + subject : subject
  switch (outcome.kind) {
    case 'applied':
      return (enabled ? 'Enabled ' : 'Disabled ') + noun + '; applied to the running leader.'
        + (outcome.warnings.length > 0 ? '\nUnrelated rows that were already inactive:\n' + outcome.warnings.map(line => '- ' + line).join('\n') : '')
    case 'overridden':
      return subject + ' was saved, but a higher-priority configuration overrides it, so it is not in effect'
        + ' (a cordis.patch.yml in the DSH home, or a --patch overlay).'
    case 'failed': {
      const reason = outcome.detail ?? managementText(outcome.error)
      const lead = 'Could not ' + (enabled ? 'enable' : 'disable') + (component ? ' the component' : '') + ': ' + reason
      if (outcome.saved === 'changed') return lead + '\nThe choice is saved; the change takes effect at the next start.'
      if (outcome.saved === 'reverted') return lead + '\nIt was switched off again, so the next start is unaffected.'
      if (outcome.saved === 'unknown') return lead + '\nRun /dsh plugins to see what is saved.'
      return lead
    }
  }
}

/** The leader log the TUI opened for this leader (xai-grok-pager dsh_leader.rs):
 * DSCODE_LOG, else the socket path with a `.log` extension. */
export function leaderLogPath(env: Readonly<Record<string, string | undefined>> = process.env): string | undefined {
  if (env.DSCODE_LOG !== undefined && env.DSCODE_LOG !== '') return env.DSCODE_LOG
  const socket = env.DSCODE_SOCKET
  if (socket === undefined || socket === '') return undefined
  const slash = socket.lastIndexOf('/'), dot = socket.lastIndexOf('.')
  return (dot > slash + 1 ? socket.slice(0, dot) : socket) + '.log'
}

/** A boot skip reason without the error class, the CLI prefix, or DSH's pnpm
 * repair hint (dscode manages this profile with npm through /dsh). */
export const skipReason = (reason: string): string =>
  reason.replace(/^\w*Error: /, '').replace(/^(?:dsh|dscode): /, '').replace(/; run 'dsh plugin [^']*'.*$/, '')

/** The one-time system note for bundles this start skipped. */
export function skippedNotice(skipped: readonly SkippedBundle[], log: string | undefined): string {
  const one = skipped.length === 1
  const named = skipped.slice(0, 3).map(({ packageName, reason }) => packageName + ' (' + oneLine(reason, 160) + ')').join('; ')
  return 'dscode started without ' + (one ? 'a plugin bundle' : String(skipped.length) + ' plugin bundles') + ': ' + named
    + (skipped.length > 3 ? ' and ' + String(skipped.length - 3) + ' more' : '') + '. '
    + 'Run /doctor for details, or /dsh disable ' + (one ? skipped[0]!.packageName : '<bundle>') + ' to stop loading ' + (one ? 'it' : 'one') + '.'
    + (log === undefined ? '' : ' Leader log: ' + log)
}

/** Cordis `FiberState` is a const enum across packages; these mirror the
 * values DSH's own plugin inventory mirrors. */
const FIBER = { PENDING: 0, LOADING: 1, ACTIVE: 2, FAILED: 3 } as const
/** Structural read of one Loader entry. */
export interface LoaderEntryLike {
  readonly options: { readonly id?: string; readonly name?: string }
  readonly disabled: boolean
  readonly fiber?: { readonly state: number; await(): Promise<unknown>; readonly inject?: object; readonly ctx?: { get(name: string): unknown } }
}
export interface InactiveRow { id: string; module: string; state: 'failed' | 'waiting'; reason: string }

/** Enabled Loader entries that are not active, and why, as DSH's reload
 * reports them; plus how many are active. */
export async function inactiveRows(entries: Iterable<LoaderEntryLike>): Promise<{ active: number; inactive: InactiveRow[] }> {
  let active = 0
  const inactive: InactiveRow[] = []
  for (const entry of entries) {
    const row = { id: entry.options.id ?? '(no id)', module: entry.options.name ?? '(unnamed)' }
    let disabled: boolean
    try { disabled = entry.disabled } catch (error) {
      inactive.push({ ...row, state: 'failed', reason: 'its disabled expression failed: ' + errorMessage(error) })
      continue
    }
    if (disabled) continue
    const fiber = entry.fiber
    if (fiber === undefined) inactive.push({ ...row, state: 'failed', reason: 'failed to import' })
    else if (fiber.state === FIBER.ACTIVE) active++
    else if (fiber.state === FIBER.FAILED) {
      let reason = 'failed'
      try { await fiber.await() } catch (error) { reason = errorMessage(error) }
      inactive.push({ ...row, state: 'failed', reason })
    } else if (fiber.state === FIBER.PENDING) {
      const missing = Object.keys(fiber.inject ?? {}).filter(service => fiber.ctx?.get(service) === undefined)
      inactive.push({ ...row, state: 'waiting', reason: 'waiting for ' + (missing.length === 1 ? 'service' : 'services') + ': ' + (missing.join(', ') || 'unknown') })
    } else if (fiber.state === FIBER.LOADING) inactive.push({ ...row, state: 'waiting', reason: 'still loading' })
    else inactive.push({ ...row, state: 'failed', reason: 'fiber state ' + String(fiber.state) })
  }
  return { active, inactive }
}

export interface Finding { status: 'OK' | 'INFO' | 'WARN' | 'ERROR'; name: string; detail: string }
/** Launcher facts of the running profile (`ProfileContext`). */
export interface ProfileContextLike { readonly dir: string; readonly installAnchor: string; readonly startedBundles: readonly string[] }
export interface PluginStatusDependencies {
  manager(): PluginManagerLike | undefined
  loader(): { entries(): Iterable<LoaderEntryLike> } | undefined
  profile(): ProfileContextLike | undefined
  logger: { warn(message: string): void }
  env?: Readonly<Record<string, string | undefined>>
}

/** The live leader's plugin health: bundles its start skipped (read once),
 * the one-time note naming them, and the rows /doctor reports. */
export function createPluginStatus(dependencies: PluginStatusDependencies) {
  let skipped: SkippedBundle[] | undefined
  let delivered = false
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
  const pending = (): boolean => !delivered && readSkipped().length > 0
  return {
    skipped: readSkipped,
    /** Once per leader: the next opened session learns what this start skipped. */
    notice: {
      pending,
      take(): string | undefined {
        if (!pending()) return undefined
        delivered = true
        return skippedNotice(readSkipped(), leaderLogPath(dependencies.env))
      },
    },
    /** `/doctor`: every enabled row that did not activate, with its reason and owning bundle. */
    async findings(): Promise<Finding[]> {
      const loader = dependencies.loader()
      if (loader === undefined) return [{ status: 'INFO', name: 'Plugin rows', detail: 'Not checked: this leader runs no plugin Loader.' }]
      const { active, inactive } = await inactiveRows(loader.entries())
      let bundles: readonly BundleLike[] = []
      try { bundles = await dependencies.manager()?.listBundles() ?? [] } catch { /* attribution only */ }
      const findings: Finding[] = inactive.map(row => {
        const owner = bundles.find(bundle => bundle.enabled && bundle.rows.some(candidate => candidate.rowId === row.id))
        return { status: row.state === 'failed' ? 'ERROR' : 'WARN', name: 'Plugin row ' + row.id,
          detail: row.module + (row.state === 'failed' ? ' failed: ' : ' is ') + row.reason + '.'
            + (owner === undefined ? '' : ' It belongs to ' + owner.name + '; /dsh disable ' + owner.name + '#' + row.id + ' turns it off.') }
      })
      if (findings.length === 0) findings.push({ status: 'OK', name: 'Plugin rows', detail: String(active) + ' running; none failed or waiting for a service.' })
      return findings
    },
  }
}

export type PluginStatus = ReturnType<typeof createPluginStatus>
