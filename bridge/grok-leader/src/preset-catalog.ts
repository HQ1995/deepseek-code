/** Native preset registry plus dscode's editable, local preset bundles. */
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { dump, load } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import { symbols, type Context } from '@deepseek-ai/cordis'
import { entryListProblem, type AgentPresetRegistry, type PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type {} from '@deepseek-ai/dsh-config-editor'
import type {} from '@deepseek-ai/dsh-app-boot'
import type { AgentPresetsLike } from './session-presets.ts'
import type { SettingsLike } from './model-catalog.ts'

const yamlOptions = { schema: entryListSchema, noRefs: true, lineWidth: -1 }
const readYaml = async (path: string): Promise<unknown> => load(await readFile(path, 'utf8'), yamlOptions)
const directories = async (root: string): Promise<string[]> => {
  try { return (await readdir(root, { withFileTypes: true })).filter(row => row.isDirectory()).map(row => row.name).sort() }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []; throw error }
}

/** Resolve relative plugin modules before moving a declaration to another bundle. */
function anchorPlugins(plugins: PresetDefinition['plugins'], base: string): PresetDefinition['plugins'] {
  return plugins.map(row => ({ ...row,
    ...(row.name?.startsWith('.') ? { name: new URL(row.name, base).href } : {}),
    ...(row.group && Array.isArray(row.config) ? { config: anchorPlugins(row.config, base) } : {}),
  }))
}

/** Legacy directories live outside the installed profile's resolution tree.
 * First-party modules must use the profile's shared SDK, while relative custom
 * modules and their configuration retain the legacy declaration's base URL. */
function anchorHostPlugins(plugins: PresetDefinition['plugins'], profileDir: string): PresetDefinition['plugins'] {
  const require = createRequire(join(profileDir, 'package.json'))
  return plugins.map(row => ({ ...row,
    ...(row.name?.startsWith('@deepseek-ai/') ? { name: pathToFileURL(require.resolve(row.name)).href } : {}),
    ...(row.group && Array.isArray(row.config) ? { config: anchorHostPlugins(row.config, profileDir) } : {}),
  }))
}

/** Owned drafts use the released declaration format. Old directory presets are
 * imported read-only into the native registry so existing sessions still open. */
const registryIdentity = (native: AgentPresetRegistry): AgentPresetRegistry => {
  let identity = native
  while ((identity as AgentPresetRegistry & { [symbols.original]?: AgentPresetRegistry })[symbols.original] !== undefined) {
    identity = (identity as AgentPresetRegistry & { [symbols.original]: AgentPresetRegistry })[symbols.original]
  }
  return identity
}

export function createPresetCatalog(ctx: Context): () => AgentPresetsLike | undefined {
  const catalogs = new WeakMap<AgentPresetRegistry, AgentPresetsLike>()
  let closed = false
  ctx.effect(() => () => { closed = true })
  return () => {
    const native = ctx.get('agentPresets')
    if (native === undefined) return undefined
    const identity = registryIdentity(native)
    let catalog = catalogs.get(identity)
    if (catalog === undefined) {
      catalog = nativeCatalog(ctx, native, () => {
        if (closed) throw new Error('Preset catalog is disposed')
        const current = ctx.get('agentPresets')
        if (current === undefined || registryIdentity(current) !== identity) throw new Error('Preset registry was replaced; retry the operation')
      })
      catalogs.set(identity, catalog)
    }
    return catalog
  }
}

function nativeCatalog(ctx: Context, native: AgentPresetRegistry, assertOpen: () => void): AgentPresetsLike {
  const drafts = new Map<string, { definition: PresetDefinition; path: string }>()
  const diagnostics = new Map<string, string>()
  let initialized: Promise<void> | undefined
  const current = () => ctx.get('agentPresets')
  const profile = () => ctx.get('profileContext')
  const register = async (native: AgentPresetRegistry, definition: PresetDefinition, path: string, legacy = false) => {
    assertOpen()
    const problem = entryListProblem(definition.plugins)
    if (problem !== undefined) throw new Error(problem)
    // The public registry captures the caller's module base for relative imports.
    const scoped = ctx.extend({ baseUrl: pathToFileURL(path).href }).get('agentPresets')!
    if (scoped === undefined || current() === undefined) throw new Error('Preset registry is unavailable')
    const dispose = await scoped.register(legacy ? { ...definition, plugins: anchorHostPlugins(definition.plugins, profile()!.dir) } : definition)
    try {
      assertOpen()
      const row = await native.resolve(definition.id)
      assertOpen()
      if (row.broken !== undefined) throw new Error(row.broken)
      ctx.effect(() => dispose)
    } catch (error) { await dispose(); throw error }
    drafts.set(definition.id, { definition, path })
  }
  const importOne = async (id: string, work: () => Promise<void>) => {
    try { await work() }
    catch (error) { assertOpen(); diagnostics.set(id, error instanceof Error ? error.message : String(error)) }
  }
  const migrateDefault = async (native: AgentPresetRegistry) => {
    const paths = profile(), settings: SettingsLike | undefined = ctx.get('settings')
    if (paths === undefined || settings === undefined) return
    await settings.ready
    assertOpen()
    const marker = join(paths.dir, 'preset-default.imported')
    try { await readFile(marker); return }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    let legacy: unknown
    for (const file of ['settings.yaml.imported', 'settings.yaml']) {
      try { legacy = await readYaml(join(paths.home, file)); break }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const selected = (legacy as { 'agent-presets'?: { default?: unknown } } | undefined)?.['agent-presets']?.default
    if (typeof selected !== 'string') return
    const user = settings.describe?.().find(entry => entry.ns === 'agent-preset-registry')?.user as { selectedDefault?: unknown } | undefined
    if (user?.selectedDefault === undefined) {
      const row = await native.resolve(selected)
      if (row.broken !== undefined) throw new Error(`Legacy default ${selected}: ${row.broken}`)
      assertOpen()
      await settings.mutate('agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: selected }])
    }
    await mkdir(paths.dir, { recursive: true })
    await writeFile(marker, selected + '\n', { mode: 0o600 })
  }
  const initialize = (): Promise<void> => {
    assertOpen()
    if (initialized !== undefined) return initialized
    const work = (async () => {
      const paths = profile()
      if (paths === undefined) return
      const root = join(paths.dir, 'preset-bundles')
      for (const id of await directories(root)) {
        await importOne(id, async () => {
          const path = join(root, id, 'cordis.patch.yml')
          const patches = await readYaml(path) as Array<{ insert?: Array<{ name?: string; config?: PresetDefinition }> }>
          const rows = patches.flatMap(patch => patch.insert ?? [])
          if (rows.length !== 1 || rows[0]?.name !== '@deepseek-ai/dsh-agent-preset' || rows[0].config?.id !== id) throw new Error(`Invalid preset bundle: ${path}`)
          await register(native, rows[0].config, path)
        })
      }
      const legacyRoot = join(paths.home, '.agent-presets')
      for (const id of await directories(legacyRoot)) {
        if (drafts.has(id) || diagnostics.has(id)) continue
        await importOne(id, async () => {
          const path = join(legacyRoot, id, 'agent.cordis.yml')
          const metadata = await readYaml(join(legacyRoot, id, 'preset.yml')) as { name?: string; description?: string; order?: number }
          const definition: PresetDefinition = { ...metadata, id, plugins: await readYaml(path) as PresetDefinition['plugins'] }
          await register(native, definition, path, true)
        })
      }
      try { await migrateDefault(native) }
      catch (error) { assertOpen(); ctx.logger.warn('Could not import the old preset default: %s', String(error)) }
    })()
    return initialized = work
  }
  const definition = (id: string): { definition: PresetDefinition; path: string } => {
    const draft = drafts.get(id)
    if (draft !== undefined) return draft
    const entry = ctx.get('configEditor')?.entries().find(entry => entry.options.name === '@deepseek-ai/dsh-agent-preset'
      && (entry.options.config as { id?: string } | undefined)?.id === id)
    if (entry === undefined) throw new Error(`Preset declaration is unavailable: ${id}`)
    const base = entry.parent.tree.ctx.baseUrl ?? pathToFileURL(join(profile()!.dir, 'cordis.patch.yml')).href
    return { definition: entry.options.config as PresetDefinition, path: base }
}
return {
    async list() {
      await initialize()
      const rows = (await native.list()).map(row => ({ ...row,
        ...(diagnostics.has(row.id) ? { description: [row.description, `Local preset was not loaded: ${diagnostics.get(row.id)}`].filter(Boolean).join('\n') } : {}),
        trust: drafts.has(row.id) ? 'user' as const : 'system' as const }))
      return [...rows, ...[...diagnostics].filter(([id]) => !rows.some(row => row.id === id))
        .map(([id, broken]) => ({ id, description: `Unavailable: ${broken}`, broken, trust: 'user' as const }))]
    },
    async resolve(id) {
      await initialize()
      const row = await native.resolve(id).catch(error => {
        if (id !== undefined && diagnostics.has(id)) throw new Error(`Preset ${id}: ${diagnostics.get(id)}`)
        throw error
      }), draft = drafts.get(row.id)
      if (row.broken !== undefined) throw new Error(`Preset ${row.id}: ${row.broken}`)
      return { ...row, trust: draft === undefined ? 'system' as const : 'user' as const, ...(draft === undefined ? {} : { path: draft.path }) }
    },
    async read(id) {
      await initialize()
      const row = definition(id)
      return drafts.has(id) ? readFile(row.path, 'utf8') : dump(row.definition, yamlOptions)
    },
    async copy(from, id) {
      await initialize()
      if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error('Invalid preset id')
      if (diagnostics.has(id) || (await native.list()).some(row => row.id === id)) throw new Error(`Preset ${id} already exists`)
      const paths = profile()
      if (paths === undefined) throw new Error('Preset editing requires an installed profile')
      const source = definition(from), root = join(paths.dir, 'preset-bundles'), directory = join(root, id)
      const path = join(directory, 'cordis.patch.yml')
      const base = source.path.startsWith('file:') ? source.path : pathToFileURL(source.path).href
      const next = { ...source.definition, id, name: id, plugins: anchorPlugins(source.definition.plugins, base) }
      await mkdir(root, { recursive: true })
      await mkdir(directory)
      try {
        await writeFile(path, dump([{ insert: [{ id: `preset-${id}`, name: '@deepseek-ai/dsh-agent-preset', config: next }] }], yamlOptions), { flag: 'wx', mode: 0o600 })
        await writeFile(join(directory, 'package.json'), JSON.stringify({ name: `dscode-preset-${id}`, version: '1.0.0', private: true, dsh: { bundle: { patch: './cordis.patch.yml' } } }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
        await register(native, next, path)
      } catch (error) { await rm(directory, { recursive: true, force: true }); throw error }
    },
    async mount(context, id) { await initialize(); return native.mount(context, id) },
    async recompose(context, id) { await initialize(); return native.recompose(context, id) },
    composedPreset: context => native.composedPreset?.(context),
    serviceFor: (agent, name) => native.serviceFor?.(agent, name as keyof Context & string),
  }
}
