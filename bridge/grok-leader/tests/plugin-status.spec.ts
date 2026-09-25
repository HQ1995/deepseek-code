/** Plugin views: the /dsh plugins table over the installed runtime's own
 * bundles, outcome wording, inactive Loader rows and the skipped-bundle note. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { OPTIONAL_BUNDLES, bundlePatchPaths, composeEntries, loadOverlayPatches, readPluginMeta } from '@deepseek-ai/dsh-app-boot'
import type { BundleInfo, PluginInfo } from '@deepseek-ai/dsh-plugin-manager'
import {
  bundleDetail, createPluginStatus, inactiveRows, leaderLogPath, managementText, outcomeText, pluginTable, rowSummary, skipReason, skippedNotice,
  type LoaderEntryLike,
} from '../src/plugin-status.ts'

const CORE = new Set(['@deepseek-ai/dsh-base', '@hqzhao95/dscode'])
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

/** One bundle as the rc.2 manager lists it, read from the installed package:
 * locale display metadata and the rows its patch inserts. */
function installed(name: string, facts: Partial<BundleInfo> & { live?: boolean } = {}): BundleInfo {
  const manifestPath = fileURLToPath(new URL('../node_modules/' + name + '/package.json', import.meta.url))
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string; description: string; dsh: { bundle: { patch: string | string[] } } }
  const meta = readPluginMeta(name, pathToFileURL(manifestPath).href)
  const rows = composeEntries([bundlePatchPaths(dirname(manifestPath), manifest.dsh.bundle).flatMap(file => loadOverlayPatches('dscode', file))])
    .filter(row => typeof row.id === 'string').map(row => ({ rowId: row.id!, moduleName: row.name, ...facts.live === true ? { entryId: 'include:' + row.id! } : {} }))
  const { live: _live, ...rest } = facts
  return { name, version: manifest.version, description: manifest.description, ...meta === undefined ? {} : { meta },
    enabled: false, installed: false, optional: OPTIONAL_BUNDLES.includes(name), removable: false, rows: rows as BundleInfo['rows'], overrides: [], ...rest }
}
const entry = (id: string, moduleName: string, enabled = true, fiberPhase: PluginInfo['fiberPhase'] = 'active'): PluginInfo =>
  ({ entryId: 'include:' + id, moduleName, enabled, fiberPhase, patchId: id }) as PluginInfo

describe('the plugin table', () => {
  it('reads the optional bundles this runtime ships, with their English display text', () => {
    expect(OPTIONAL_BUNDLES).toEqual(['@deepseek-ai/dsh-experimental-agent-team-profile', '@deepseek-ai/dsh-experimental-voice-input-bundle', '@deepseek-ai/dsh-experimental-auto-review'])
    const review = installed('@deepseek-ai/dsh-experimental-auto-review')
    const dscode = { name: '@hqzhao95/dscode', version: '0.0.14', description: 'dscode bridge', enabled: true, installed: true, optional: false, removable: true,
      rows: [{ rowId: 'grok-leader', moduleName: '@hqzhao95/dscode', entryId: 'include:grok-leader' }, { rowId: 'dscode-browser', moduleName: '@hqzhao95/dscode/browser', entryId: 'include:dscode-browser' }],
      overrides: ['hmr'] } as BundleInfo
    const base = installed('@deepseek-ai/dsh-base', { enabled: true, readOnlyReason: 'management-required' })
    const broken = { name: 'dsh-plugin-broken', enabled: true, installed: true, optional: false, removable: true, rows: [], overrides: [],
      error: { code: 'incompatible-version', incompatible: [{ name: 'dsh-plugin-broken', version: '1.0.0', runtimeVersion: '0.1.7-rc.2', peers: { '@deepseek-ai/dsh-agent': '0.1.5' } }] } } as BundleInfo
    const mine = { name: 'dsh-plugin-mine', version: '2.0.0', enabled: false, installed: true, optional: false, removable: true, rows: [{ rowId: 'mine', moduleName: 'dsh-plugin-mine' }], overrides: [] } as BundleInfo
    const table = pluginTable({
      dir: '/p', order: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode', 'dsh-plugin-broken'], core: CORE,
      bundles: [installed('@deepseek-ai/dsh-web-app'), review, installed('@deepseek-ai/dsh-experimental-agent-team-profile'), broken, mine, dscode, base,
        installed('@deepseek-ai/dsh-experimental-voice-input-bundle')],
      plugins: [entry('grok-leader', '@hqzhao95/dscode'), entry('dscode-browser', '@hqzhao95/dscode/browser', false, null)],
      skipped: [{ packageName: 'dsh-plugin-gone', reason: 'cannot resolve profile bundle "dsh-plugin-gone"' }],
    })
    const lines = table.split('\n')
    expect(lines[0]).toBe('Plugins in `/p`: 3 on · 4 off · 2 problems')
    expect(lines.slice(2, 4)).toEqual(['| State | Plugin | Package | Kind | Rows |', '| --- | --- | --- | --- | --- |'])
    // Profile layer order first, then installed, then the official bundles shipped off; DSH's app bundles stay out.
    expect(lines.slice(4, 11).map(line => line.split(' | ')[2])).toEqual([
      '`@deepseek-ai/dsh-base@0.1.7-rc.2`', '`@hqzhao95/dscode@0.0.14`', '`dsh-plugin-broken`', '`dsh-plugin-mine@2.0.0`',
      '`@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2`', '`@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2`',
      '`@deepseek-ai/dsh-experimental-voice-input-bundle@0.1.7-rc.2`'])
    expect(table).not.toContain('dsh-web-app')
    expect(lines[5]).toBe('| on | **dscode**: dscode bridge | `@hqzhao95/dscode@0.0.14` | core | 2 rows · 1 running · 1 off |')
    expect(lines[4]).toMatch(/^\| on \| \*\*base\*\*: The shared dsh core as a profile bundle: .*… \| `@deepseek-ai\/dsh-base@0\.1\.7-rc\.2` \| core \| \d+ rows · \d+ off \|$/)
    expect(lines[6]).toBe('| on · problem | **plugin-broken** | `dsh-plugin-broken` | installed · removable | 0 rows |')
    expect(lines[7]).toBe('| off | **plugin-mine** | `dsh-plugin-mine@2.0.0` | installed · removable | 1 row |')
    expect(lines[9]).toBe('| off | **Auto Authorization Review**: Add an Auto review permission mode that uses the model to assess authorization before each tool call.'
      + ' | `@deepseek-ai/dsh-experimental-auto-review@0.1.7-rc.2` | official · optional · experimental | 1 row |')
    expect(lines[8]).toContain('| off | **Agent Teams**: Enable team collaboration')
    expect(table).toContain('Problems:\n- `dsh-plugin-broken`: dsh-plugin-broken@1.0.0 is incompatible with DSH 0.1.7-rc.2 (requires @deepseek-ai/dsh-agent 0.1.5); running it may cause crashes or data loss.')
    expect(table).toContain('- `dsh-plugin-gone`: skipped at startup: cannot resolve profile bundle "dsh-plugin-gone"')
  })

  it('counts a bundle\'s rows by state, as the Plugins page does', () => {
    const bundle = installed('@deepseek-ai/dsh-experimental-agent-team-profile', { enabled: true, live: true })
    expect(rowSummary(bundle, [entry('agent-team', 'x'), entry('tool-agent-team', 'x', false, null), entry('ui-agent-team', 'x', true, 'failed')]))
      .toBe('3 rows · 1 running · 1 off · 1 failed')
    expect(rowSummary(bundle, [entry('agent-team', 'x', true, 'pending')])).toBe('3 rows · 2 off · 1 waiting')
    // Rows of a bundle that is off belong to whoever else inserts that id.
    expect(rowSummary({ ...bundle, enabled: false }, [entry('agent-team', 'x')])).toBe('3 rows')
  })

  it('details a bundle\'s components with their switch address', () => {
    const bundle = installed('@deepseek-ai/dsh-experimental-agent-team-profile', { enabled: true, live: true, overrides: ['tool-subagent'] })
    const detail = bundleDetail(bundle, [entry('agent-team', '@deepseek-ai/dsh-experimental-agent-team'), { ...entry('tool-agent-team', 'x', false, null) },
      { ...entry('ui-agent-team', 'x'), readOnlyReason: 'unaddressable', patchId: undefined } as unknown as PluginInfo], CORE)
    expect(detail).toContain('**Agent Teams** `@deepseek-ai/dsh-experimental-agent-team-profile@0.1.7-rc.2`: on · official · optional · experimental')
    expect(detail).toContain('- `agent-team` @deepseek-ai/dsh-experimental-agent-team · running')
    expect(detail).toContain('- `tool-agent-team` @deepseek-ai/dsh-experimental-tool-agent-team · off')
    expect(detail).toContain('- `ui-agent-team` @deepseek-ai/dsh-experimental-client-ui-agent-team · running · locked: The profile patch cannot address this one uniquely.')
    expect(detail).toContain('Changes built-in rows: tool-subagent')
    expect(detail).toContain('/dsh enable|disable @deepseek-ai/dsh-experimental-agent-team-profile#<row>')
  })
})

describe('plugin wording', () => {
  it('words management codes as DSH\'s Plugins page does, and passes diagnostics through', () => {
    expect(managementText({ code: 'management-required' })).toBe('Plugin management needs it; it cannot be switched off or uninstalled.')
    expect(managementText({ code: 'not-bundle' })).toBe('This package declares no bundle, so it cannot be managed as a plugin.')
    expect(managementText({ code: 'operation-error', diagnostic: 'EACCES: package.json' })).toBe('EACCES: package.json')
    expect(managementText({ code: 'incompatible-version' })).toContain('incompatible with the running DSH version')
    expect(managementText(undefined)).toBe('The Host reported an error.')
  })

  it('reports each official outcome', () => {
    expect(outcomeText({ kind: 'applied', warnings: [] }, true, 'Auto Authorization Review', false)).toBe('Enabled Auto Authorization Review; applied to the running leader.')
    expect(outcomeText({ kind: 'applied', warnings: ['x (y): pending'] }, false, 'auto-review of R', true))
      .toBe('Disabled the component auto-review of R; applied to the running leader.\nUnrelated rows that were already inactive:\n- x (y): pending')
    expect(outcomeText({ kind: 'overridden' }, true, 'auto-review', true))
      .toMatch(/^auto-review was saved, but a higher-priority configuration overrides it, so it is not in effect/)
    expect(outcomeText({ kind: 'failed', error: { code: 'management-required' }, saved: 'unchanged' }, false, 'base', false))
      .toBe('Could not disable: Plugin management needs it; it cannot be switched off or uninstalled.')
    expect(outcomeText({ kind: 'failed', detail: 'boom', saved: 'reverted' }, true, 'R', true)).toBe('Could not enable the component: boom\nIt was switched off again, so the next start is unaffected.')
    expect(outcomeText({ kind: 'failed', detail: 'boom', saved: 'changed' }, false, 'R', false)).toBe('Could not disable: boom\nThe choice is saved; the change takes effect at the next start.')
    expect(outcomeText({ kind: 'failed', detail: 'boom', saved: 'unknown' }, true, 'R', false)).toContain('Run /dsh plugins to see what is saved.')
  })

  it('finds the leader log the TUI opened for this leader', () => {
    expect(leaderLogPath({ DSCODE_SOCKET: '/tmp/dscode-1000-abc.sock' })).toBe('/tmp/dscode-1000-abc.log')
    expect(leaderLogPath({ DSCODE_SOCKET: '/tmp/a.b/leader' })).toBe('/tmp/a.b/leader.log')
    expect(leaderLogPath({ DSCODE_SOCKET: '/tmp/.hidden' })).toBe('/tmp/.hidden.log')
    expect(leaderLogPath({ DSCODE_SOCKET: '/tmp/x.sock', DSCODE_LOG: '/var/log/d.log' })).toBe('/var/log/d.log')
    expect(leaderLogPath({})).toBeUndefined()
  })

  it('names skipped bundles once, without DSH\'s pnpm repair hint', () => {
    expect(skipReason('Error: dsh: cannot resolve profile bundle "x" from the dsh installation or /p; run \'dsh plugin --profile dscode install\' if its dependency is not installed'))
      .toBe('cannot resolve profile bundle "x" from the dsh installation or /p')
    expect(skippedNotice([{ packageName: 'x', reason: 'gone' }], '/tmp/l.log'))
      .toBe('dscode started without a plugin bundle: x (gone). Run /doctor for details, or /dsh disable x to stop loading it. Leader log: /tmp/l.log')
    expect(skippedNotice(['a', 'b', 'c', 'd'].map(packageName => ({ packageName, reason: 'r' })), undefined))
      .toBe('dscode started without 4 plugin bundles: a (r); b (r); c (r) and 1 more. Run /doctor for details, or /dsh disable <bundle> to stop loading one.')
  })
})

describe('plugin health', () => {
  const fiber = (state: number, extra: object = {}) => ({ state, await: async () => undefined, ...extra })
  const loaderEntry = (id: string, value: Partial<LoaderEntryLike> = {}): LoaderEntryLike => ({ options: { id, name: '@x/' + id }, disabled: false, fiber: fiber(2), ...value })

  it('reads the Loader rows that did not activate, and why', async () => {
    const rows = await inactiveRows([
      loaderEntry('ok'),
      loaderEntry('off', { disabled: true, fiber: undefined }),
      loaderEntry('crash', { fiber: { state: 3, await: async () => { throw new Error('apply threw') } } }),
      loaderEntry('wait', { fiber: fiber(0, { inject: { llm: {}, speech: {} }, ctx: { get: (name: string) => name === 'llm' ? {} : undefined } }) }),
      loaderEntry('missing', { fiber: undefined }),
      { options: { id: 'expr', name: 'e' }, get disabled(): boolean { throw new Error('ctx is not defined') }, fiber: undefined },
    ])
    expect(rows).toEqual({ active: 1, inactive: [
      { id: 'crash', module: '@x/crash', state: 'failed', reason: 'apply threw' },
      { id: 'wait', module: '@x/wait', state: 'waiting', reason: 'waiting for service: speech' },
      { id: 'missing', module: '@x/missing', state: 'failed', reason: 'failed to import' },
      { id: 'expr', module: 'e', state: 'failed', reason: 'its disabled expression failed: ctx is not defined' },
    ] })
  })

  it('reports failed rows with their bundle for /doctor, and tells the next session once what boot skipped', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dscode-plugin-status-'))
    roots.push(root)
    mkdirSync(join(root, 'profile'))
    writeFileSync(join(root, 'profile', 'package.json'), JSON.stringify({ private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-vanished'] } } }))
    const anchor = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url))
    const warnings: string[] = []
    const status = createPluginStatus({
      manager: () => ({ listBundles: async () => [{ ...installed('@deepseek-ai/dsh-experimental-auto-review', { enabled: true }) }],
        listPlugins: async () => [], setBundleEnabled: async () => ({ application: 'failed' }), setPluginEnabled: async () => ({ application: 'failed' }) }),
      loader: () => ({ entries: () => [loaderEntry('auto-review', { fiber: { state: 3, await: async () => { throw new Error('no model') } } }), loaderEntry('llm')] }),
      profile: () => ({ dir: join(root, 'profile'), installAnchor: anchor, startedBundles: ['@deepseek-ai/dsh-base'] }),
      logger: { warn: message => { warnings.push(message) } },
      env: { DSCODE_SOCKET: '/tmp/dscode-1-x.sock' },
    })
    expect(await status.findings()).toEqual([{ status: 'ERROR', name: 'Plugin row auto-review',
      detail: '@x/auto-review failed: no model. It belongs to @deepseek-ai/dsh-experimental-auto-review; /dsh disable @deepseek-ai/dsh-experimental-auto-review#auto-review turns it off.' }])
    expect(status.skipped()).toEqual([{ packageName: 'dsh-plugin-vanished', reason: expect.stringMatching(/^cannot resolve profile bundle "dsh-plugin-vanished"/) }])
    expect(status.notice.pending()).toBe(true)
    expect(status.notice.take()).toMatch(/^dscode started without a plugin bundle: dsh-plugin-vanished \(cannot resolve .*\)\. Run \/doctor .* Leader log: \/tmp\/dscode-1-x\.log$/)
    expect(status.notice.pending()).toBe(false)
    expect(status.notice.take()).toBeUndefined()
    expect(warnings).toEqual([])
  })

  it('says every row runs, and stays quiet without a profile or Loader', async () => {
    const quiet = createPluginStatus({ manager: () => undefined, loader: () => ({ entries: () => [loaderEntry('a'), loaderEntry('b')] }),
      profile: () => undefined, logger: { warn: () => {} } })
    expect(await quiet.findings()).toEqual([{ status: 'OK', name: 'Plugin rows', detail: '2 running; none failed or waiting for a service.' }])
    expect(quiet.notice.pending()).toBe(false)
    const bare = createPluginStatus({ manager: () => undefined, loader: () => undefined, profile: () => undefined, logger: { warn: () => {} } })
    expect(await bare.findings()).toEqual([{ status: 'INFO', name: 'Plugin rows', detail: 'Not checked: this leader runs no plugin Loader.' }])
  })
})
