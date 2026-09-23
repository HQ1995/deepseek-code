import { Context, Service } from '@deepseek-ai/cordis'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import { load } from 'js-yaml'
import { mkdtemp, mkdir, readFile, writeFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { expect, it, vi } from 'vitest'
import { createPresetCatalog } from '../src/preset-catalog.ts'

async function fixture(root?: string) {
  const directory = root ?? await mkdtemp(join(tmpdir(), 'dscode-presets-'))
  const ctx = new Context(), definitions = new Map<string, PresetDefinition>(), bases = new Map<string, string | undefined>()
  const register = vi.fn(function (this: { ctx: Context }, definition: PresetDefinition) {
    if (definitions.has(definition.id)) throw new Error('duplicate: ' + definition.id)
    definitions.set(definition.id, definition); bases.set(definition.id, this.ctx.baseUrl)
    return Promise.resolve(async () => { definitions.delete(definition.id) })
  })
  Object.assign(new (class extends Service {})(ctx, 'agentPresets'), {
    register,
    list: async () => [...definitions.values()].map(({ id, name, description }) => ({ id, name, description })),
    resolve: async (id: string) => { if (!definitions.has(id)) throw new Error('missing'); return { id } },
  })
  ctx.provide('profileContext', { home: directory, dir: join(directory, 'profiles/dscode') } as never)
  const catalog = createPresetCatalog(ctx)
  return { ctx, directory, definitions, bases, register, catalog, async dispose() { await ctx.fiber.dispose() } }
}

it('imports old user presets without rewriting them and preserves module paths in copied declarations', async () => {
  const f = await fixture()
  try {
    const legacy = join(f.directory, '.agent-presets/my-tools')
    await mkdir(legacy, { recursive: true })
    const source = "- name: './tool.mjs'\n  disabled: !!js process.platform === 'win32'\n"
    await writeFile(join(legacy, 'agent.cordis.yml'), source)
    await writeFile(join(legacy, 'preset.yml'), 'name: My tools\ndescription: User-owned\n')
    await writeFile(join(legacy, 'tool.mjs'), 'export const name = "my-tool"\n')
    expect(await f.catalog()!.list()).toMatchObject([{ id: 'my-tools', name: 'My tools', trust: 'user' }])
    await f.catalog()!.resolve('my-tools'); await f.catalog()!.list()
    expect(f.register).toHaveBeenCalledTimes(1)
    expect(f.bases.get('my-tools')).toBe(pathToFileURL(join(legacy, 'agent.cordis.yml')).href)
    await f.catalog()!.copy!('my-tools', 'my-copy')
    const path = join(f.directory, 'profiles/dscode/preset-bundles/my-copy/cordis.patch.yml')
    const text = await readFile(path, 'utf8')
    expect(text).toContain('!!js')
    expect(text).toContain(pathToFileURL(join(legacy, 'tool.mjs')).href)
    const parsed = load(text, { schema: entryListSchema }) as Array<{ insert: Array<{ config: PresetDefinition }> }>
    expect(parsed[0]!.insert[0]!.config.id).toBe('my-copy')
    expect(await readFile(join(legacy, 'agent.cordis.yml'), 'utf8')).toBe(source)
    await expect(f.catalog()!.copy!('my-tools', 'my-copy')).rejects.toThrow('already exists')
    expect(await readFile(path, 'utf8')).toBe(text)
    await f.dispose()
    expect(f.definitions.size).toBe(0)
    const fresh = await fixture(f.directory)
    try {
      expect((await fresh.catalog()!.list()).map(row => row.id).sort()).toEqual(['my-copy', 'my-tools'])
      expect(await fresh.catalog()!.read!('my-copy')).toBe(text)
    } finally { await fresh.dispose() }
  } finally { await f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it('isolates malformed files and rolls back failed native activation without losing valid presets', async () => {
  const f = await fixture()
  try {
    for (const id of ['broken', 'good']) {
      const root = join(f.directory, '.agent-presets', id)
      await mkdir(root, { recursive: true })
      await writeFile(join(root, 'preset.yml'), `name: ${id}\n`)
      await writeFile(join(root, 'agent.cordis.yml'), id === 'broken' ? '- 42\n' : '- name: my-tool\n')
    }
    expect(await f.catalog()!.list()).toMatchObject([
      { id: 'good', trust: 'user' }, { id: 'broken', broken: expect.stringContaining('not a plugin row') },
    ])
    await expect(f.catalog()!.resolve('broken')).rejects.toThrow('not a plugin row')
    const resolve = f.ctx.agentPresets.resolve
    vi.spyOn(f.ctx.agentPresets, 'resolve').mockImplementation(async id => id === 'failed-copy'
      ? { id, broken: 'module did not activate' } : resolve(id))
    await expect(f.catalog()!.copy!('good', 'failed-copy')).rejects.toThrow('module did not activate')
    expect(f.definitions.has('failed-copy')).toBe(false)
    await expect(readFile(join(f.directory, 'profiles/dscode/preset-bundles/failed-copy/cordis.patch.yml'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect((await f.catalog()!.resolve('good')).id).toBe('good')
  } finally { await f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it('resolves legacy first-party modules from the shared profile without moving relative custom modules', async () => {
  const f = await fixture()
  try {
    const host = join(f.directory, 'profiles/dscode/node_modules/@deepseek-ai/fixture')
    await mkdir(host, { recursive: true })
    await writeFile(join(host, 'package.json'), JSON.stringify({ name: '@deepseek-ai/fixture', main: 'index.mjs' }))
    await writeFile(join(host, 'index.mjs'), 'export const name = "fixture"\n')
    const legacy = join(f.directory, '.agent-presets/old')
    await mkdir(legacy, { recursive: true })
    await writeFile(join(legacy, 'preset.yml'), 'name: Old\n')
    const source = '- name: "@deepseek-ai/fixture"\n- name: "./custom.mjs"\n'
    await writeFile(join(legacy, 'agent.cordis.yml'), source)
    expect((await f.catalog()!.resolve('old')).id).toBe('old')
    expect(f.register.mock.calls[0]![0].plugins.map(row => row.name)).toEqual([pathToFileURL(await realpath(join(host, 'index.mjs'))).href, './custom.mjs'])
    expect(f.bases.get('old')).toBe(pathToFileURL(join(legacy, 'agent.cordis.yml')).href)
    expect(await readFile(join(legacy, 'agent.cordis.yml'), 'utf8')).toBe(source)
  } finally { await f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it.each([undefined, 'standard'])('imports the old default once and preserves a new explicit choice: %s', async selectedDefault => {
  const f = await fixture()
  try {
    f.definitions.set('minimal', { id: 'minimal', plugins: [] })
    const original = 'agent-presets:\n  default: minimal\n'
    await writeFile(join(f.directory, 'settings.yaml.imported'), original)
    const mutate = vi.fn(async () => undefined)
    Object.assign(new (class extends Service {})(f.ctx, 'settings'), {
      describe: () => [{ ns: 'agent-preset-registry', user: { selectedDefault } }], mutate,
    })
    await f.catalog()!.list()
    expect(mutate).toHaveBeenCalledTimes(selectedDefault === undefined ? 1 : 0)
    if (selectedDefault === undefined) expect(mutate).toHaveBeenCalledWith('agent-preset-registry', [{ op: 'set', path: ['selectedDefault'], value: 'minimal' }])
    expect(await readFile(join(f.directory, 'settings.yaml.imported'), 'utf8')).toBe(original)
    await createPresetCatalog(f.ctx)()!.list()
    expect(mutate).toHaveBeenCalledTimes(selectedDefault === undefined ? 1 : 0)
  } finally { await f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})

it('rejects work after its owner is disposed', async () => {
  const f = await fixture(), catalog = f.catalog()!
  await f.dispose()
  await expect(catalog.list()).rejects.toThrow('disposed')
  await rm(f.directory, { recursive: true, force: true })
})

it('keeps a native preset usable when a local directory has a conflicting id', async () => {
  const f = await fixture()
  try {
    f.definitions.set('standard', { id: 'standard', plugins: [] })
    const root = join(f.directory, '.agent-presets/standard')
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'preset.yml'), 'name: Local standard\n')
    await writeFile(join(root, 'agent.cordis.yml'), '- name: fixture\n')
    expect(await f.catalog()!.resolve('standard')).toMatchObject({ id: 'standard', trust: 'system' })
    expect(await f.catalog()!.list()).toMatchObject([{ id: 'standard', description: expect.stringContaining('duplicate') }])
  } finally { await f.dispose(); await rm(f.directory, { recursive: true, force: true }) }
})
