/** Switch profile bundles and rows through the DSH plugin manager and apply
 * the change to the live leader. The manager persists the choice: a bundle's
 * selection in the profile package.json, a row's `disabled` in the profile
 * patch. dscode runs without `hmr`, so the manager reports `restart-required`;
 * the caller's reload then reconciles the Loader now and fails if a required
 * row does not activate. An enable that cannot activate is turned off again. */
import { internalError } from './acp.ts'
import { errorMessage } from './guards.ts'

/** A refusal or failure as the plugin manager reports it (`ManagementError`). */
export interface ManagementErrorLike {
  code?: string
  diagnostic?: string
  incompatible?: ReadonlyArray<{ name: string; version: string; runtimeVersion: string; peers: Record<string, string> }>
}
/** Literal text, or translations with a required English fallback (`LocalizedText`). */
export type LocalizedTextLike = string | { readonly en: string; readonly [locale: string]: string }
/** Local package display metadata (`PluginLocalizedMeta`). */
export interface PluginMetaLike { readonly title?: LocalizedTextLike; readonly description?: LocalizedTextLike; readonly error?: string }
/** One Loader entry and its profile-patch address (`PluginInfo`). */
export interface PluginEntryLike {
  entryId: string
  moduleName: string
  enabled: boolean
  fiberPhase?: 'pending' | 'loading' | 'active' | 'failed' | 'unloading' | null
  patchId?: string
  readOnlyReason?: string
}
/** One installed or installation-provided bundle (`BundleInfo`). */
export interface BundleLike {
  name: string
  version?: string
  meta?: PluginMetaLike
  description?: string
  enabled: boolean
  installed: boolean
  optional: boolean
  removable: boolean
  readOnlyReason?: string
  error?: ManagementErrorLike
  rows: ReadonlyArray<{ rowId: string; moduleName: string; entryId?: string; meta?: PluginMetaLike }>
  overrides: readonly string[]
}
/** A saved change and its application outcome (`ChangeResult`). */
export interface ChangeLike { application: string; error?: ManagementErrorLike; warnings?: string[] }

/** Structural read of the DSH plugin manager (dsh 0.1.7-rc.2). A test
 * compiles the runtime's own `PluginManager` against it. */
export interface PluginManagerLike {
  listPlugins(): Promise<PluginEntryLike[]>
  listBundles(): Promise<BundleLike[]>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<ChangeLike>
  setBundleEnabled(name: string, enabled: boolean): Promise<ChangeLike>
}

export interface PluginRowDependencies {
  pluginManager(): PluginManagerLike | undefined
  /** Reconcile the live Loader with the saved profile patches, requiring these rows to activate. */
  reload(requiredIds: readonly string[]): Promise<void>
}

/** One addressable row: its patch id, the module it loads, and a label for errors. */
export interface PluginRow {
  id: string
  module: string
  label: string
}

/** What one switch did, in the plugin manager's own outcome terms. A failed
 * switch says what is saved now: nothing new, the new state (live apply
 * failed), the old state again (an enable rolled back), or unknown. */
export type SwitchOutcome =
  | { kind: 'applied'; warnings: string[] }
  | { kind: 'overridden' }
  | { kind: 'failed'; error?: ManagementErrorLike; detail?: string; saved: 'unchanged' | 'changed' | 'reverted' | 'unknown' }

export function createPluginRows(dependencies: PluginRowDependencies) {
  const manager = (): PluginManagerLike => {
    const service = dependencies.pluginManager()
    if (service === undefined) throw internalError('the DSH plugin manager is unavailable; restart dscode and retry')
    return service
  }
  const find = async (row: PluginRow) => {
    const found = (await manager().listPlugins()).find(item => item.patchId === row.id && item.moduleName === row.module)
    if (found === undefined) throw internalError('the installed runtime has no ' + row.module + ' row for the ' + row.label)
    return found
  }
  /** Apply a saved change to the live Loader. An enable whose rows do not
   * activate is switched off again, so it cannot fail the next start either. */
  const settle = async (change: ChangeLike, enabled: boolean, required: readonly string[],
    revert: () => Promise<ChangeLike>, observe?: () => Promise<boolean>): Promise<SwitchOutcome> => {
    if (change.application === 'failed' || change.application === 'cancelled' || change.error !== undefined) {
      return { kind: 'failed', ...change.error === undefined ? {} : { error: change.error }, saved: 'unchanged' }
    }
    if (change.application === 'overridden') return { kind: 'overridden' }
    // A profile with hmr recomposed already, and judged overrides itself.
    if (change.application === 'applied') return { kind: 'applied', warnings: change.warnings ?? [] }
    try {
      await dependencies.reload(enabled ? required : [])
    } catch (error) {
      if (!enabled) return { kind: 'failed', detail: errorMessage(error), saved: 'changed' }
      try {
        const back = await revert()
        if (back.application === 'failed' || back.error !== undefined) throw new Error(back.error?.diagnostic ?? back.error?.code ?? back.application)
      } catch (rollback) {
        return { kind: 'failed', detail: errorMessage(error) + '; turning it off again also failed: ' + errorMessage(rollback), saved: 'unknown' }
      }
      try { await dependencies.reload([]) } catch (reload) {
        return { kind: 'failed', detail: errorMessage(error) + '; restart dscode to unload what did start (' + errorMessage(reload) + ')', saved: 'reverted' }
      }
      return { kind: 'failed', detail: errorMessage(error), saved: 'reverted' }
    }
    // Without hmr the manager cannot see a higher layer override the saved row.
    if (observe !== undefined && !await observe()) return { kind: 'overridden' }
    return { kind: 'applied', warnings: change.warnings ?? [] }
  }
  return {
    async enabled(row: PluginRow): Promise<boolean> {
      return (await find(row)).enabled
    },
    /** Idempotent: an already matching row is left alone. */
    async set(row: PluginRow, enabled: boolean): Promise<void> {
      const target = await find(row)
      if (target.enabled === enabled) return
      const result = await manager().setPluginEnabled(target.entryId, enabled)
      if (result.application === 'failed' || result.error !== undefined) {
        throw internalError('could not ' + (enabled ? 'enable' : 'disable') + ' the ' + row.label + ': ' + (result.error?.code ?? result.application))
      }
      if (result.application === 'overridden') {
        throw internalError('the ' + row.label + ' row is overridden by a home patch or command-line overlay; edit that override instead')
      }
      if (result.application !== 'restart-required') return
      try {
        await dependencies.reload(enabled ? [row.id] : [])
      } catch (error) {
        if (!enabled) throw error
        // A row that cannot activate must not stay enabled for the next boot.
        try {
          await manager().setPluginEnabled(target.entryId, false)
          await dependencies.reload([])
        } catch (rollback) {
          throw internalError('the ' + row.label + ' did not start and could not be turned off again: '
            + errorMessage(error) + '; ' + errorMessage(rollback))
        }
        throw internalError('the ' + row.label + ' did not start and was turned off again: ' + errorMessage(error))
      }
    },
    /** Select or deselect a bundle layer (`/dsh enable|disable <bundle>`);
     * enabling requires the rows its patch inserts to activate. */
    async switchBundle(name: string, enabled: boolean, rows: readonly string[]): Promise<SwitchOutcome> {
      const service = manager()
      return settle(await service.setBundleEnabled(name, enabled), enabled, rows, () => service.setBundleEnabled(name, false))
    },
    /** Switch one Loader entry by its manager id (`/dsh enable|disable <bundle>#<row>`). */
    async switchRow(entry: { entryId: string; patchId: string }, enabled: boolean): Promise<SwitchOutcome> {
      const service = manager()
      return settle(await service.setPluginEnabled(entry.entryId, enabled), enabled, [entry.patchId],
        () => service.setPluginEnabled(entry.entryId, false),
        async () => (await service.listPlugins()).find(item => item.entryId === entry.entryId)?.enabled === enabled)
    },
  }
}

export type PluginRows = ReturnType<typeof createPluginRows>
