/** Turn one shipped-disabled profile row on or off for the live leader.
 * The plugin manager persists `disabled` in the profile patch. dscode runs
 * without `hmr`, so it reports `restart-required`; the caller's reload then
 * reconciles the Loader now and fails if a required row does not activate. */
import { internalError } from './acp.ts'

/** Structural read of the plugin manager's row toggle (dsh 0.1.7). */
export interface PluginManagerLike {
  listPlugins(): Promise<Array<{ entryId: string; moduleName: string; enabled: boolean; patchId?: string; readOnlyReason?: string }>>
  setPluginEnabled(entryId: string, enabled: boolean): Promise<{ application: string; error?: { code?: string }; warnings?: string[] }>
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
            + (error instanceof Error ? error.message : String(error)) + '; ' + (rollback instanceof Error ? rollback.message : String(rollback)))
        }
        throw internalError('the ' + row.label + ' did not start and was turned off again: ' + (error instanceof Error ? error.message : String(error)))
      }
    },
  }
}

export type PluginRows = ReturnType<typeof createPluginRows>
