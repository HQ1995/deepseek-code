import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import { load } from 'js-yaml'
import { getDshRuntimeVersion } from '@deepseek-ai/dsh-app-boot'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-plugin-manager'
import { analyzeBundlePatch, createProfilePlugins, SENSITIVE_ROW_IDS } from '../src/profile-plugins.ts'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })

async function fixture(options: { name?: string; stagedPatch?: string | string[]; installedPatch?: string | string[]; uninstallFails?: boolean
  peers?: Record<string, string>; installedPeers?: Record<string, string>; components?: Record<string, Record<string, string>> } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dscode-profile-test-'))
  roots.push(root)
  const name = options.name ?? 'test-plugin'
  const manifest = { private: true, dependencies: { '@hqzhao95/dscode': '0.0.0' } as Record<string, string>,
    dsh: { profile: { bundles: ['@hqzhao95/dscode'] } }, untouched: { keep: true } }
  await writeFile(join(root, 'package.json'), JSON.stringify(manifest))
  const read = async () => JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as typeof manifest
  const exec = vi.fn(async (file: string, args: string[], options_: { cwd: string; timeout: number }) => {
    expect(file).toBe('npm')
    expect(args.slice(1, 5)).toEqual(['--ignore-scripts', '--no-audit', '--no-fund', '--legacy-peer-deps'])
    expect(options_.timeout).toBe(180_000)
    const target = join(options_.cwd, 'package.json')
    const data = JSON.parse(await readFile(target, 'utf8')) as typeof manifest
    data.dependencies ??= {}
    if (args[0] === 'uninstall') {
      // Even a failed cleanup must already be unregistered durably.
      expect((await read()).dsh.profile.bundles).not.toContain(name)
      if (options.uninstallFails) throw new Error('simulated npm cleanup failure')
      delete data.dependencies[name]
    } else if (args.length === 5) {
      // A spec-less install resynchronizes node_modules with a restored manifest.
      await rm(join(options_.cwd, 'node_modules', name), { recursive: true, force: true })
      return
    } else {
      data.dependencies[name] = 'file:fixture'
      const dir = join(options_.cwd, 'node_modules', name)
      await mkdir(dir, { recursive: true })
      const patch = options_.cwd === root ? options.installedPatch ?? options.stagedPatch : options.stagedPatch
      const peers = options_.cwd === root ? options.installedPeers ?? options.peers : options.peers
      for (const [component, componentPeers] of Object.entries(options.components ?? {})) {
        await mkdir(join(options_.cwd, 'node_modules', component), { recursive: true })
        await writeFile(join(options_.cwd, 'node_modules', component, 'package.json'), JSON.stringify({ name: component, version: '2.0.0', peerDependencies: componentPeers }))
      }
      const patches = Array.isArray(patch) ? patch : patch === undefined ? [] : [patch]
      const paths = patches.map((_, i) => `cordis-${i}.patch.yml`)
      await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0',
        ...peers === undefined ? {} : { peerDependencies: peers },
        ...patch === undefined ? {} : { dsh: { bundle: { patch: Array.isArray(patch) ? paths : paths[0] } } } }))
      for (const [i, content] of patches.entries()) await writeFile(join(dir, paths[i]!), content)
    }
    await writeFile(target, JSON.stringify(data))
  })
  const inspectRuntime = vi.fn((name: string) => name === 'live-plugin' ? 'live plugin report' : undefined)
  const plugins = createProfilePlugins({ directory: () => root, exec, inspectRuntime })
  return { root, exec, plugins, read, inspectRuntime }
}

describe('profile plugin operations', () => {
  it('lists the installed composition and prefers the live runtime inspection without writes', async () => {
    const f = await fixture()
    expect(await f.plugins.execute('/dsh plugins')).toContain('@hqzhao95/dscode 0.0.0 (core)')
    expect(await f.plugins.execute('/dsh inspect live-plugin')).toBe('live plugin report')
    expect(await f.plugins.execute('/dsh inspect @hqzhao95/dscode')).toContain('no live plugin instance')
    expect(await f.plugins.execute('/dsh inspect missing')).toContain('is not installed')
    expect(f.exec).not.toHaveBeenCalled()
  })

  it('preserves quoted/escaped local specs and installs a plain dependency without enabling it', async () => {
    const f = await fixture()
    const notes: string[] = []
    expect(await f.plugins.execute('/dsh add "file:../plugin with spaces" file:plain\\ path', text => notes.push(text)))
      .toContain('installed as a plain dependency')
    expect(f.exec.mock.calls[0]![1].slice(5)).toEqual(['file:' + resolve(f.root, '../plugin with spaces'), 'file:' + join(f.root, 'plain path')])
    expect(f.exec.mock.calls[1]![1].slice(5)).toEqual(['file:../plugin with spaces', 'file:plain path'])
    expect((await f.read()).dsh.profile.bundles).toEqual(['@hqzhao95/dscode'])
    expect((await f.read()).untouched).toEqual({ keep: true })
    expect(notes).toHaveLength(2)
    await expect(readFile(join(f.exec.mock.calls[0]![2].cwd, 'package.json'))).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('reports every composition change and requires trust before a profile mutation', async () => {
    const f = await fixture({ stagedPatch: '- insert:\n    - id: my-tool\n    - id: sandbox-policy\n- id: system-prompt\n  config: {}\n- id: approval\n  disabled: true\n- id: sandbox\n  config:\n    port: !!js 3080\n- id: hmr\n  disabled: !!js false\n' })
    const before = await readFile(join(f.root, 'package.json'), 'utf8')
    const report = await f.plugins.execute('/dsh add plugin')
    expect(report).toContain('Not installed')
    expect(report).toContain('inserts 2 row(s): my-tool, sandbox-policy')
    expect(report).toContain('overrides: system-prompt, sandbox, hmr')
    expect(report).toContain('disables: approval')
    expect(report).toContain('security rows: sandbox-policy, approval, sandbox (sandbox, approval or credential spine')
    expect(report).toContain('2 !!js expression(s)')
    expect(await readFile(join(f.root, 'package.json'), 'utf8')).toBe(before)
    expect(f.exec).toHaveBeenCalledTimes(1)
    expect(await f.plugins.execute('/dsh add --trust plugin')).toContain('Installed or updated test-plugin')
    expect((await f.read()).dsh.profile.bundles).toEqual(['@hqzhao95/dscode', 'test-plugin'])
  })

  it('flags security rows by the ids the installed base ships, not by their module names', () => {
    const base = load(readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8')
      .replace(/!!js\b/g, '')) as Array<{ insert?: Array<{ id?: string }> }>
    const ids = new Set(base.flatMap(entry => entry.insert ?? []).map(row => row.id))
    // A stale id (like `permission-presets`, the module of row `permission`) never matches anything.
    expect([...SENSITIVE_ROW_IDS].filter(id => !ids.has(id))).toEqual([])
    const analysis = analyzeBundlePatch([
      '- id: permission', '  config: {}', '- id: llm-deepseek-account', '  disabled: false',
      '- id: permission-presets', '  disabled: true', '- insert:', '    - id: deepseek-account',
    ].join('\n'))
    expect(analysis.sensitiveRows).toEqual(['permission', 'llm-deepseek-account', 'deepseek-account'])
    expect(analysis.overriddenRows).toEqual(['permission', 'llm-deepseek-account'])
  })

  it('refuses a package whose dsh peers the runtime does not satisfy before profile mutation', async () => {
    const f = await fixture({ stagedPatch: '- insert:\n    - id: my-tool\n', peers: { '@deepseek-ai/dsh-agent': '0.1.0', react: '19' } })
    const before = await f.read()
    const runtime = getDshRuntimeVersion()
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('Refused test-plugin@1.0.0 before profile mutation')
    expect(report).toContain(`is incompatible with dsh ${runtime}: peerDependencies {"@deepseek-ai/dsh-agent":"0.1.0"}`)
    expect(report).toContain('/dsh allow-version test-plugin@1.0.0 --accept-risk, then rerun /dsh add')
    expect(await f.read()).toEqual(before)
    expect(f.exec).toHaveBeenCalledTimes(1)
  })

  it('installs an incompatible package only under its exact-version exemption and says so', async () => {
    const f = await fixture({ stagedPatch: '- insert:\n    - id: my-tool\n', peers: { '@deepseek-ai/dsh-agent': '0.1.0' } })
    await writeFile(join(f.root, 'compatibility.json'), JSON.stringify({ 'test-plugin@1.0.0': [getDshRuntimeVersion()] }))
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('Installed or updated test-plugin')
    expect(report).toContain('Exact-version exemption: active')
    expect((await f.read()).dsh.profile.bundles).toEqual(['@hqzhao95/dscode', 'test-plugin'])
  })

  it('refuses a bundle whose inserted row loads a package the runtime would disable', async () => {
    const f = await fixture({ stagedPatch: '- insert:\n    - id: team\n      name: component-pkg\n', components: { 'component-pkg': { '@deepseek-ai/dsh-agent': '0.1.0' } } })
    const before = await f.read()
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('Refused component-pkg@2.0.0 before profile mutation')
    expect(report).toContain('/dsh allow-version component-pkg@2.0.0 --accept-risk')
    expect(await f.read()).toEqual(before)
  })

  it('names an unreadable compatibility file instead of implying no exemption was granted', async () => {
    const f = await fixture({ stagedPatch: '[]', peers: { '@deepseek-ai/dsh-agent': '0.1.0' } })
    await writeFile(join(f.root, 'compatibility.json'), '{ torn')
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('compatibility file has problems')
    expect(report).toContain('is not valid JSON')
  })

  it('grants and revokes an exact-version exemption only with explicit risk acceptance', async () => {
    const f = await fixture({ stagedPatch: '[]', peers: { '@deepseek-ai/dsh-agent': '0.1.0' } })
    const runtime = getDshRuntimeVersion()
    expect(await f.plugins.execute('/dsh allow-version test-plugin@1.0.0')).toContain('Rerun with --accept-risk')
    expect(await f.plugins.execute('/dsh revoke-version test-plugin@1.0.0 --accept-risk')).toContain('Usage:')
    await expect(readFile(join(f.root, 'compatibility.json'))).rejects.toMatchObject({ code: 'ENOENT' })
    expect(await f.plugins.execute('/dsh allow-version test-plugin@1.0.0 --accept-risk')).toBe(`Allowed test-plugin@1.0.0 for DSH ${runtime}. Restart dscode to apply it.`)
    expect(JSON.parse(await readFile(join(f.root, 'compatibility.json'), 'utf8'))).toEqual({ 'test-plugin@1.0.0': [runtime] })
    expect(await f.plugins.execute('/dsh add --trust plugin')).toContain('Exact-version exemption: active')
    expect(await f.plugins.execute('/dsh revoke-version test-plugin@1.0.0')).toContain('Revoked test-plugin@1.0.0')
    expect(f.exec).toHaveBeenCalledTimes(2)
  })

  it('rolls back a package that passed staging but installs incompatible', async () => {
    const f = await fixture({ stagedPatch: '[]', peers: { '@deepseek-ai/dsh-agent': '>=0.1.0-0' }, installedPeers: { '@deepseek-ai/dsh-agent': '0.1.0' } })
    const before = await readFile(join(f.root, 'package.json'), 'utf8')
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('Rolled back test-plugin because post-install verification failed')
    expect(report).toContain('is incompatible with dsh')
    expect(await readFile(join(f.root, 'package.json'), 'utf8')).toBe(before)
  })

  it('installs a package whose dsh peer range includes the running prerelease', async () => {
    const f = await fixture({ stagedPatch: '- insert:\n    - id: my-tool\n', peers: { '@deepseek-ai/dsh-agent': '>=0.1.0-0' } })
    const report = await f.plugins.execute('/dsh add --trust plugin')
    expect(report).toContain('Installed or updated test-plugin')
    expect(report).not.toContain('incompatible')
  })

  it.each(['just a scalar', '- 42', '{ not: [valid'])('refuses a malformed bundle before mutation: %s', async stagedPatch => {
    const f = await fixture({ stagedPatch })
    const before = await f.read()
    expect(await f.plugins.execute('/dsh add --trust plugin')).toContain('before profile mutation')
    expect(await f.read()).toEqual(before)
    expect(f.exec).toHaveBeenCalledTimes(1)
  })

  it('audits every ordered patch and refuses a malformed later patch before installation', async () => {
    const f = await fixture({ stagedPatch: ['- insert:\n    - id: my-tool\n', '- id: approval\n  disabled: true\n- id: sandbox\n  config:\n    enabled: !!js false\n'] })
    const report = await f.plugins.execute('/dsh add plugin')
    expect(report).toContain('my-tool')
    expect(report).toContain('disables: approval')
    expect(report).toContain('1 !!js expression(s)')
    expect((await f.read()).dsh.profile.bundles).toEqual(['@hqzhao95/dscode'])
    expect(await f.plugins.execute('/dsh add --trust plugin')).toContain('Installed or updated test-plugin')
    const malformed = await fixture({ stagedPatch: ['[]', '- 42'] })
    expect(await malformed.plugins.execute('/dsh add --trust plugin')).toContain('before profile mutation')
    expect(malformed.exec).toHaveBeenCalledTimes(1)
  })

  it.each(['- 42', '[]'])('disables an untrusted root when the installed package differs from its plain audit: %s', async installedPatch => {
    const f = await fixture({ installedPatch })
    const before = await readFile(join(f.root, 'package.json'), 'utf8')
    expect(await f.plugins.execute('/dsh add plugin')).toContain('Rolled back test-plugin because post-install verification failed')
    expect(await readFile(join(f.root, 'package.json'), 'utf8')).toBe(before)
    expect(f.exec.mock.calls.at(-1)![1]).toHaveLength(5)
  })

  it.each([false, true])('unregisters before npm cleanup even if removal fails: %s', async uninstallFails => {
    const f = await fixture({ stagedPatch: '[]', uninstallFails })
    await f.plugins.execute('/dsh add --trust plugin')
    const report = await f.plugins.execute('/dsh remove test-plugin')
    expect(report).toContain(uninstallFails ? 'Unregistered test-plugin, but npm could not remove' : 'Removed test-plugin')
    const after = await f.read()
    expect(after.dsh.profile.bundles).toEqual(['@hqzhao95/dscode'])
    expect(after.dependencies['test-plugin'] !== undefined).toBe(uninstallFails)
  })

  it('protects core packages, rejects option injection and invalid syntax without installing', async () => {
    const f = await fixture()
    for (const text of ['/dsh remove @hqzhao95/dscode', '/dsh add --registry=x', '/dsh add "broken', '/dsh remove a b', '/dsh add']) {
      expect(await f.plugins.execute(text)).toMatch(/core component|Unsupported npm option|Could not parse|Usage:|Missing package/)
    }
    expect(f.exec).not.toHaveBeenCalled()
    const core = await fixture({ name: '@hqzhao95/dscode' })
    expect(await core.plugins.execute('/dsh add --trust core')).toContain('use dscode update')
    expect(core.exec).toHaveBeenCalledTimes(1)
  })

  it('keeps profile discovery optional without invoking an installer', async () => {
    const exec = vi.fn()
    const plugins = createProfilePlugins({ directory: () => undefined, exec, inspectRuntime: () => undefined })
    expect(plugins.directory()).toBeUndefined()
    expect(await plugins.execute('/dsh add plugin')).toContain('no installed leader profile')
    expect(exec).not.toHaveBeenCalled()
  })

  it('drains an accepted mutation through verification and blocks new work during disposal', async () => {
    const f = await fixture({ stagedPatch: '[]' })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const install = f.exec.getMockImplementation()!
    f.exec.mockImplementationOnce(async (...args) => { await gate; return install(...args) })
    const operation = f.plugins.execute('/dsh add --trust plugin')
    await vi.waitFor(() => expect(f.exec).toHaveBeenCalledTimes(1))
    let drained = false
    const disposal = f.plugins.dispose().then(() => { drained = true })
    await expect(f.plugins.execute('/dsh add another')).rejects.toThrow('disposed')
    expect(drained).toBe(false)
    release(); await expect(operation).resolves.toContain('Installed or updated')
    await disposal
    expect((await f.read()).dsh.profile.bundles).toContain('test-plugin')
  })
})

/** A leader profile with the rc.2 plugin manager over it: dscode's core
 * bundles, one optional bundle shipped off, one third-party bundle. */
async function managed() {
  const root = await mkdtemp(join(tmpdir(), 'dscode-profile-switch-'))
  roots.push(root)
  await writeFile(join(root, 'package.json'), JSON.stringify({ private: true, dependencies: { '@hqzhao95/dscode': '0.0.0', 'dsh-plugin-mine': '1.0.0' },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dsh-plugin-mine'] } } }))
  const bundles: BundleInfo[] = [
    { name: '@deepseek-ai/dsh-base', version: '0.1.7-rc.2', enabled: true, installed: false, optional: false, removable: false, readOnlyReason: 'management-required',
      rows: [{ rowId: 'llm', moduleName: '@deepseek-ai/dsh-llm', entryId: 'include:llm' }] as BundleInfo['rows'], overrides: [] },
    { name: '@hqzhao95/dscode', version: '0.0.0', enabled: true, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'dscode-browser', moduleName: '@hqzhao95/dscode/browser', entryId: 'include:dscode-browser' }] as BundleInfo['rows'], overrides: [] },
    { name: '@deepseek-ai/dsh-experimental-auto-review', version: '0.1.7-rc.2', meta: { title: { en: 'Auto Authorization Review', zh: '自动授权审查' } },
      enabled: false, installed: false, optional: true, removable: false, rows: [{ rowId: 'auto-review', moduleName: '@deepseek-ai/dsh-experimental-auto-review' }], overrides: [] },
    { name: 'dsh-plugin-mine', version: '1.0.0', enabled: true, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'mine', moduleName: 'dsh-plugin-mine', entryId: 'include:mine' }, { rowId: 'shared', moduleName: 'dsh-plugin-mine/shared', entryId: 'include:shared' }] as BundleInfo['rows'], overrides: [] },
    { name: 'dsh-plugin-broken', enabled: false, installed: true, optional: false, removable: true, error: { code: 'not-bundle' }, rows: [], overrides: [] },
  ]
  const plugins: PluginInfo[] = [
    { entryId: 'include:llm', moduleName: '@deepseek-ai/dsh-llm', enabled: true, fiberPhase: 'active', patchId: 'llm' },
    { entryId: 'include:dscode-browser', moduleName: '@hqzhao95/dscode/browser', enabled: false, fiberPhase: null, patchId: 'dscode-browser' },
    { entryId: 'include:mine', moduleName: 'dsh-plugin-mine', enabled: true, fiberPhase: 'active', patchId: 'mine' },
    { entryId: 'include:shared', moduleName: 'dsh-plugin-mine/shared', enabled: true, fiberPhase: 'active', readOnlyReason: 'unaddressable' },
  ] as PluginInfo[]
  const manager = {
    listBundles: vi.fn(async () => structuredClone(bundles)),
    listPlugins: vi.fn(async () => structuredClone(plugins)),
    setPluginEnabled: vi.fn(async () => ({ application: 'failed' })),
  }
  const plugins_ = createProfilePlugins({ directory: () => root, exec: vi.fn(), inspectRuntime: () => undefined, pluginManager: () => manager,
    skipped: () => [{ packageName: 'dsh-plugin-gone', reason: 'cannot resolve it' }] })
  return { root, manager, plugins: plugins_ }
}

describe('/dsh plugins over the plugin manager', () => {
  it('lists every bundle with its kind, rows and problems', async () => {
    const f = await managed()
    const text = await f.plugins.execute('/dsh plugins')
    expect(text).toContain('| on | **dscode** | `@hqzhao95/dscode@0.0.0` | core | 1 row · 1 off |')
    expect(text).toContain('| off | **Auto Authorization Review** | `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2` | official · optional · experimental | 1 row |')
    expect(text).toContain('- `dsh-plugin-broken`: This package declares no bundle, so it cannot be managed as a plugin.')
    expect(text).toContain('- `dsh-plugin-gone`: skipped at startup: cannot resolve it')
    expect(await f.plugins.execute('/dsh inspect dsh-plugin-mine')).toContain('- `shared` dsh-plugin-mine/shared · running · locked: The profile patch cannot address this one uniquely.')
  })
})
