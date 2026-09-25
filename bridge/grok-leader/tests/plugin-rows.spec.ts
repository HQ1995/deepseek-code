/** Bundle and row switches through the DSH plugin manager, applied live. */
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { BundleInfo, ChangeResult, PluginInfo } from '@deepseek-ai/dsh-plugin-manager'
import { createPluginRows, type PluginManagerLike } from '../src/plugin-rows.ts'

/** A plugin manager with the rc.2 record shapes and a startup-only profile:
 * every saved change reports `restart-required`, as dscode (no hmr) sees it. */
function fixture(options: { application?: ChangeResult['application']; error?: ChangeResult['error']; reloadFails?: (required: readonly string[]) => boolean
  revertFails?: boolean; overriddenRow?: boolean } = {}) {
  const saved = { bundle: false, row: true }
  const row: PluginInfo = { entryId: 'include:auto-review' as PluginInfo['entryId'], moduleName: '@deepseek-ai/dsh-experimental-auto-review', enabled: true,
    fiberPhase: 'active', patchId: 'auto-review' }
  const change = (target: string, enabled: boolean): ChangeResult => ({ changed: true, stage: 'enable', target, enabled,
    application: options.application ?? 'restart-required', ...options.error === undefined ? {} : { error: options.error }, warnings: [] })
  const manager = {
    listPlugins: vi.fn(async (): Promise<PluginInfo[]> => [{ ...row, enabled: options.overriddenRow === true ? !saved.row : saved.row }]),
    listBundles: vi.fn(async (): Promise<BundleInfo[]> => []),
    setPluginEnabled: vi.fn(async (id: string, enabled: boolean) => {
      if (options.application === undefined && options.error === undefined) saved.row = enabled
      return change(id, enabled)
    }),
    setBundleEnabled: vi.fn(async (name: string, enabled: boolean) => {
      if (!enabled && options.revertFails === true) return { ...change(name, enabled), application: 'failed' as const, error: { code: 'operation-error' as const, diagnostic: 'disk full' } }
      if (options.application === undefined && options.error === undefined) saved.bundle = enabled
      return change(name, enabled)
    }),
  } satisfies PluginManagerLike
  const reload = vi.fn(async (required: readonly string[]) => {
    if (options.reloadFails?.(required) === true) throw new Error('dscode: warning: 1 entry did not activate\nauto-review (@deepseek-ai/dsh-experimental-auto-review): boom')
  })
  const rows = createPluginRows({ pluginManager: () => manager, reload })
  return { rows, manager, reload, saved }
}

describe('plugin switches', () => {
  it('compiles the runtime plugin manager against the structural seam it is read through', () => {
    const file = fileURLToPath(new URL('./plugin-manager-seam.mts', import.meta.url))
    const source = `
      import type { PluginManager } from '@deepseek-ai/dsh-plugin-manager'
      import type { PluginManagerLike } from '../src/plugin-rows.ts'
      export const seam = (manager: PluginManager): PluginManagerLike => manager
    `
    const options: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, types: ['node'] }
    const host = ts.createCompilerHost(options), read = host.getSourceFile.bind(host)
    host.getSourceFile = (path, ...args) => path === file ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true) : read(path, ...args)
    const program = ts.createProgram([file], options, host)
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('selects a bundle and applies it to the live Loader, requiring its rows', async () => {
    const f = fixture()
    expect(await f.rows.switchBundle('@deepseek-ai/dsh-experimental-auto-review', true, ['auto-review'])).toEqual({ kind: 'applied', warnings: [] })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledExactlyOnceWith('@deepseek-ai/dsh-experimental-auto-review', true)
    expect(f.reload).toHaveBeenCalledExactlyOnceWith(['auto-review'])
    expect(await f.rows.switchBundle('@deepseek-ai/dsh-experimental-auto-review', false, ['auto-review'])).toEqual({ kind: 'applied', warnings: [] })
    expect(f.reload).toHaveBeenLastCalledWith([])
  })

  it('switches a bundle that cannot start off again, so the next start is unaffected', async () => {
    const f = fixture({ reloadFails: required => required.length > 0 })
    const outcome = await f.rows.switchBundle('b', true, ['auto-review'])
    expect(outcome).toMatchObject({ kind: 'failed', saved: 'reverted', detail: expect.stringContaining('auto-review (@deepseek-ai/dsh-experimental-auto-review): boom') })
    expect(f.manager.setBundleEnabled.mock.calls).toEqual([['b', true], ['b', false]])
    expect(f.reload.mock.calls).toEqual([[['auto-review']], [[]]])
    expect(f.saved.bundle).toBe(false)
  })

  it('reports an unknown saved state when the rollback fails too', async () => {
    const f = fixture({ reloadFails: required => required.length > 0, revertFails: true })
    expect(await f.rows.switchBundle('b', true, ['auto-review'])).toMatchObject({ kind: 'failed', saved: 'unknown', detail: expect.stringContaining('turning it off again also failed: disk full') })
  })

  it('keeps a saved disable whose live apply failed, for the next start', async () => {
    const f = fixture({ reloadFails: () => true })
    expect(await f.rows.switchBundle('b', false, ['auto-review'])).toMatchObject({ kind: 'failed', saved: 'changed' })
    expect(f.manager.setBundleEnabled).toHaveBeenCalledOnce()
  })

  it('passes manager refusals through without reloading', async () => {
    const f = fixture({ application: 'failed', error: { code: 'management-required' } })
    expect(await f.rows.switchBundle('@deepseek-ai/dsh-base', false, [])).toEqual({ kind: 'failed', error: { code: 'management-required' }, saved: 'unchanged' })
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('trusts a profile with hmr to have applied the change itself', async () => {
    const f = fixture({ application: 'applied' })
    expect(await f.rows.switchRow({ entryId: 'include:auto-review', patchId: 'auto-review' }, false)).toEqual({ kind: 'applied', warnings: [] })
    expect(f.reload).not.toHaveBeenCalled()
  })

  it('switches a row live and says when a higher layer overrides the saved value', async () => {
    const f = fixture()
    expect(await f.rows.switchRow({ entryId: 'include:auto-review', patchId: 'auto-review' }, false)).toEqual({ kind: 'applied', warnings: [] })
    expect(f.manager.setPluginEnabled).toHaveBeenCalledExactlyOnceWith('include:auto-review', false)
    expect(f.reload).toHaveBeenCalledExactlyOnceWith([])
    const overridden = fixture({ overriddenRow: true })
    expect(await overridden.rows.switchRow({ entryId: 'include:auto-review', patchId: 'auto-review' }, true)).toEqual({ kind: 'overridden' })
    expect(overridden.reload).toHaveBeenCalledExactlyOnceWith(['auto-review'])
  })

  it('turns a row that cannot start off again', async () => {
    const f = fixture({ reloadFails: required => required.length > 0 })
    expect(await f.rows.switchRow({ entryId: 'include:auto-review', patchId: 'auto-review' }, true)).toMatchObject({ kind: 'failed', saved: 'reverted' })
    expect(f.manager.setPluginEnabled.mock.calls).toEqual([['include:auto-review', true], ['include:auto-review', false]])
  })
})
