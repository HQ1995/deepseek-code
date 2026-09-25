/** Leader socket spec: leader plugin inspection, /dsh command and bundle management. */
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { register, sendRequest, useLeaderHarness, waitFor, waitForId } from './support/leader-harness.ts'

describe('leader plugin inspection, /dsh command and bundle management', () => {
  const start = useLeaderHarness()

  it('reports the services and effects a loaded plugin brought, generically', async () => {
    const profileDir = resolve(tmpdir(), 'dsh-profile-inspect-' + randomUUID())
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: { 'dsh-plugin-example': '^1.0.0' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-example'] } },
    }))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { pluginCtx, client: c } = await start()
      register(c)
      await c.next()
      // Mount an arbitrary third-party-shaped plugin into the live context:
      // the report must attribute its service and effects with zero
      // plugin-specific knowledge (pure reflect.store + fiber parentage).
      await pluginCtx.plugin({
        name: 'dsh-plugin-example',
        apply(inner: Context) {
          inner.provide('exampleThing', { hello: true })
          ;(inner as unknown as { on(event: string, listener: () => void): void }).on('commands/change', () => {})
        },
      } as never)

      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh inspect dsh-plugin-example' }], _meta: { promptId: 'ins-1' } })
      const settled = await waitForId(c, 2)
      expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'ins-1' } })
      await waitFor(() => c.all.some(m => {
        if (m.method !== 'session/update') return false
        const text = String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '')
        return text.includes('provides services: exampleThing') && text.includes('registered effects:')
      }))

      // Unknown plugin: actionable, not a crash.
      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh inspect dsh-plugin-ghost' }] })
      await waitForId(c, 3)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('is not installed')))
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('advertises the /dsh command and interprets it in the bridge, never the model', async () => {
    const profileDir = resolve(tmpdir(), 'dsh-profile-test-' + randomUUID())
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      dependencies: {
        '@hqzhao95/dscode': 'file:/x',
        'dsh-plugin-example': '^1.0.0',
      },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-example', '@hqzhao95/dscode'] } },
    }, null, 2))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { registry, client: c } = await start()
      register(c)
      await c.next()

      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const agent = registry.byId.get(sessionId)!

      const listed = await c.request(2, 'x.ai/commands/list', {})
      const names = ((listed.result as { commands: Array<{ name: string }> }).commands).map(entry => entry.name)
      expect(names).toContain('dsh')

      // /dsh plugins settles as its own end_turn without ever reaching the
      // model, and streams the profile bundle list as an agent message.
      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh plugins' }], _meta: { promptId: 'dsh-1' } })
      const settled = await waitForId(c, 3)
      expect(settled.result).toMatchObject({ stopReason: 'end_turn', _meta: { promptId: 'dsh-1' } })
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('dsh-plugin-example')))
      expect(agent.internals.followups).toEqual([])

      // Core components refuse removal.
      sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh remove @hqzhao95/dscode' }] })
      await waitForId(c, 4)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('refusing to remove')))
      expect(agent.internals.followups).toEqual([])

      // Unknown subcommands reply with usage instead of reaching the model.
      sendRequest(c, 5, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh frobnicate' }] })
      await waitForId(c, 5)
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('Usage: /dsh')))
      expect(agent.internals.followups).toEqual([])
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('tells the first opened session once which bundles this start skipped', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const profileDir = resolve(tmpdir(), 'dsh-profile-skipped-' + randomUUID())
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({ private: true, dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-vanished'] } } }))
    const installAnchor = fileURLToPath(new URL('../node_modules/@deepseek-ai/dsh/package.json', import.meta.url))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { client: c } = await start({ profileContext: { name: 'dscode', dir: profileDir, patchPath: resolve(profileDir, 'cordis.patch.yml'), installAnchor,
        cwd: process.cwd(), home: profileDir, startedBundles: ['@deepseek-ai/dsh-base'], overlays: [], telemetryDisabledEnv: '1' } })
      register(c)
      await c.next()
      const notes = () => c.all.filter(m => m.method === 'x.ai/session_notification')
        .flatMap(m => (m.params as { update: { sessionUpdate: string; notes?: string[] } }).update.notes ?? [])
        .filter(note => note.includes('dscode started without'))
      const first = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      await waitFor(() => notes().length === 1)
      expect(notes()[0]).toMatch(/^dscode started without a plugin bundle: dsh-plugin-vanished \(cannot resolve profile bundle "dsh-plugin-vanished".*\)\. Run \/doctor for details, or \/dsh disable dsh-plugin-vanished to stop loading it\./)
      expect(notes()[0]).not.toContain("run 'dsh plugin")
      const noteSession = c.all.find(m => m.method === 'x.ai/session_notification' && JSON.stringify(m).includes('dscode started without'))
      expect((noteSession!.params as { sessionId: string }).sessionId).toBe((first.result as { sessionId: string }).sessionId)
      await c.request(2, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      await new Promise(resolve => setTimeout(resolve, 150))
      expect(notes()).toHaveLength(1)
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('switches a bundle through the plugin manager and turns it off again when the leader cannot apply it', async () => {
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    const profileDir = resolve(tmpdir(), 'dsh-profile-switch-' + randomUUID())
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({ private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } } }))
    const selected: boolean[] = []
    const manager = {
      listPlugins: async () => [],
      listBundles: async () => [{ name: '@deepseek-ai/dsh-experimental-auto-review', version: '0.1.7-rc.2', meta: { title: { en: 'Auto Authorization Review' } },
        enabled: selected.at(-1) ?? false, installed: false, optional: true, removable: false, rows: [{ rowId: 'auto-review', moduleName: '@deepseek-ai/dsh-experimental-auto-review' }], overrides: [] }],
      setBundleEnabled: async (_name: string, enabled: boolean) => { selected.push(enabled); return { changed: true, application: 'restart-required' } },
      setPluginEnabled: async () => ({ application: 'failed' }),
    }
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      // No launcher profile context: the leader cannot reconcile, so the enable is undone.
      const { client: c } = await start({ pluginManager: manager })
      register(c)
      await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh enable @deepseek-ai/dsh-experimental-auto-review' }] })
      expect((await waitForId(c, 2)).error).toBeUndefined()
      await waitFor(() => c.all.some(m => m.method === 'session/update'
        && String((m.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '')
          .startsWith('Could not enable: no profile context: restart dscode to apply the change; restart dscode to unload what did start')))
      expect(JSON.stringify(c.all)).toContain('It was switched off again, so the next start is unaffected.')
      expect(selected).toEqual([true, false])
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(profileDir, { recursive: true, force: true })
    }
  })

  it('pre-audits local bundle plugins, requires trust, and removes them with npm', async () => {
    const root = resolve(tmpdir(), 'dsh-plugin-flow-' + randomUUID())
    const profileDir = resolve(root, 'profile')
    const pluginDir = resolve(root, 'plugin with spaces')
    const { mkdirSync, writeFileSync, rmSync } = await import('node:fs')
    mkdirSync(profileDir, { recursive: true })
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(resolve(profileDir, 'package.json'), JSON.stringify({
      name: 'dsh-profile-test',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode'] } },
    }, null, 2))
    writeFileSync(resolve(pluginDir, 'package.json'), JSON.stringify({
      name: 'dsh-plugin-local-bundle',
      version: '1.0.0',
      dsh: { bundle: { patch: './cordis.patch.yml' } },
    }, null, 2))
    writeFileSync(resolve(pluginDir, 'cordis.patch.yml'), [
      '- insert:',
      '    - id: plugin-feature',
      "      name: 'dsh-plugin-local-bundle/feature'",
    ].join('\n'))
    process.env.DSH_PROFILE_DIR = profileDir
    try {
      const { client: c } = await start()
      register(c)
      await c.next()
      const created = await c.request(1, 'session/new', { cwd: process.cwd(), mcpServers: [] })
      const sessionId = (created.result as { sessionId: string }).sessionId
      const spec = 'file:' + pluginDir

      const { withProfileLock } = await import('../bin/update.mjs')
      const before = readFileSync(resolve(profileDir, 'package.json'), 'utf8')
      await withProfileLock(profileDir, async () => {
        sendRequest(c, 90, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh add ' + JSON.stringify(spec) }] })
        await new Promise(resolve => setTimeout(resolve, 150))
        expect(c.all.some(message => message.id === 90)).toBe(false)
        expect(readFileSync(resolve(profileDir, 'package.json'), 'utf8')).toBe(before)
      })
      expect((await waitForId(c, 90)).error).toBeUndefined()
      expect(readFileSync(resolve(profileDir, 'package.json'), 'utf8')).toBe(before)

      sendRequest(c, 2, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh add ' + JSON.stringify(spec) }] })
      const refused = await waitForId(c, 2)
      expect(refused.error).toBeUndefined()
      await waitFor(() => c.all.some(message => message.method === 'session/update'
        && String((message.params as { update?: { content?: { text?: string } } }).update?.content?.text ?? '').includes('Not installed. Review the requested composition changes')))
      let manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
      expect((manifest.dependencies ?? {})['dsh-plugin-local-bundle']).toBeUndefined()

      sendRequest(c, 3, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh add --trust ' + JSON.stringify(spec) }] })
      const installed = await waitForId(c, 3)
      expect(installed.error).toBeUndefined()
      manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as typeof manifest
      expect(manifest.dependencies['dsh-plugin-local-bundle']).toBeDefined()
      expect(manifest.dsh.profile.bundles).toContain('dsh-plugin-local-bundle')

      sendRequest(c, 4, 'session/prompt', { sessionId, prompt: [{ type: 'text', text: '/dsh remove dsh-plugin-local-bundle' }] })
      const removed = await waitForId(c, 4)
      expect(removed.error).toBeUndefined()
      manifest = JSON.parse(readFileSync(resolve(profileDir, 'package.json'), 'utf8')) as typeof manifest
      expect((manifest.dependencies ?? {})['dsh-plugin-local-bundle']).toBeUndefined()
      expect(manifest.dsh.profile.bundles).not.toContain('dsh-plugin-local-bundle')
    } finally {
      delete process.env.DSH_PROFILE_DIR
      rmSync(root, { recursive: true, force: true })
    }
  }, 30_000)
})
