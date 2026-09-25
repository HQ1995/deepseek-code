/** `/dsh config` over DSH's settings service: namespaces, fields and path edits. */
import { fileURLToPath } from 'node:url'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'
import { createPluginSettings } from '../src/plugin-settings.ts'
import { fakeSettingsService } from './support/settings-fake.ts'

/** The module over the shared fake, as `/dsh` builds it. */
function fakeSettings(options: Parameters<typeof fakeSettingsService>[0] = {}) {
  const fake = fakeSettingsService(options)
  return { ...fake, settings: createPluginSettings({ settings: () => fake.service, bundles: async () => fake.bundles }) }
}

describe('/dsh config', () => {
  it('compiles the runtime settings service against the structural seam it is read through', () => {
    const file = fileURLToPath(new URL('./settings-seam.mts', import.meta.url))
    const source = `
      import type { SettingsForms } from '@deepseek-ai/dsh-settings'
      import type { SettingsLike } from '../src/native-seams.ts'
      export const seam = (forms: SettingsForms): SettingsLike => forms
    `
    const compilerOptions: ts.CompilerOptions = { noEmit: true, skipLibCheck: true, strict: true, target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext, allowImportingTsExtensions: true, types: ['node'] }
    const host = ts.createCompilerHost(compilerOptions), readSource = host.getSourceFile.bind(host)
    host.getSourceFile = (path, ...args) => path === file ? ts.createSourceFile(path, source, ts.ScriptTarget.ES2022, true) : readSource(path, ...args)
    const program = ts.createProgram([file], compilerOptions, host)
    expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))).toEqual([])
  })

  it('lists the namespaces loaded plugins serve, with their plugin, field and override counts', async () => {
    const f = fakeSettings()
    expect(await f.settings.execute('/dsh config')).toBe([
      'Settings served by loaded plugins: 2 namespaces · 1 overridden', '',
      '| Namespace | Plugin | Fields | Overridden |', '| --- | --- | --- | --- |',
      '| `bash-sandbox` | Base | 5 | 1 |',
      '| `web-search` | Base | 4 | 0 |', '',
      'Show one: `/dsh config <namespace>`. Change a field: `/dsh config set <namespace> <field> <json>`; back to its default: `/dsh config reset <namespace> <field>`.',
    ].join('\n'))
    expect(f.describe).toHaveBeenCalledWith({ redactSecrets: true })
  })

  it('lists one namespace: values, defaults, overrides, objects as compact JSON and secrets as set or unset', async () => {
    const f = fakeSettings()
    f.user['bash-sandbox']!.env = Object.fromEntries(Array.from({ length: 12 }, (_, index) => ['VARIABLE_' + String(index), 'value|' + String(index)]))
    const view = await f.settings.execute('/dsh config bash-sandbox')
    const lines = view.split('\n')
    expect(lines[0]).toBe('**bash-sandbox** (Base): 5 fields · 2 overridden · changes apply to the running leader')
    expect(lines.slice(2, 4)).toEqual(['| Field | Value | Default | Description |', '| --- | --- | --- | --- |'])
    expect(lines[4]).toBe('| `cwd` | - | - | Working directory for commands |')
    expect(lines[5]).toBe('| `timeoutMs` | `60000` | `60000` |  |')
    // Wide values are clipped compact JSON; a pipe cannot break the table.
    expect(lines[6]).toMatch(/^\| `env` \| `\{"VARIABLE_0":"value\\\|0",.{40,}…` · overridden \| `\{\}` \|  \|$/)
    expect(lines[7]).toBe('| `limits.maxOutputBytes` | `64000` | `64000` |  |')
    expect(lines[8]).toBe('| `limits.graceMs` | `5000` · overridden | `3000` |  |')
    const secrets = await f.settings.execute('/dsh config web-search')
    expect(secrets).toContain('| `apiKey` | set · secret | - |')
    expect(secrets).toContain('| `apiKeyEnv` | `"DEEPSEEK_API_KEY"` | `"DEEPSEEK_API_KEY"` |')
    expect(secrets).not.toContain('sk-live-secret')
  })

  it('sets a field through settings.mutate at the described revision and says it applies live', async () => {
    const f = fakeSettings()
    expect(await f.settings.execute('/dsh config set bash-sandbox timeoutMs 30000')).toBe('Set `timeoutMs` of `bash-sandbox` to `30000`; applied to the running leader.')
    expect(f.mutate).toHaveBeenLastCalledWith('bash-sandbox', [{ op: 'set', path: ['timeoutMs'], value: 30000 }], 3)
    // Text that is not JSON is a string; a JSON string keeps its spaces; objects are JSON.
    expect(await f.settings.execute('/dsh config set bash-sandbox cwd /srv/work')).toContain('to `"/srv/work"`')
    expect(await f.settings.execute('/dsh config set bash-sandbox cwd "/srv/my work"')).toContain('to `"/srv/my work"`')
    expect(await f.settings.execute('/dsh config set bash-sandbox env {"A": "1", "B": "it\'s"}')).toContain('to `{"A":"1","B":"it\'s"}`')
    expect(await f.settings.execute('/dsh config set bash-sandbox ["limits","graceMs"] 100')).toBe('Set `limits.graceMs` of `bash-sandbox` to `100`; applied to the running leader.')
    expect(f.user['bash-sandbox']).toEqual({ limits: { graceMs: 100 }, timeoutMs: 30000, cwd: '/srv/my work', env: { A: '1', B: 'it\'s' } })
  })

  it('reports a change made elsewhere between the read and the write', async () => {
    const f = fakeSettings()
    const original = f.describe.getMockImplementation()!
    f.describe.mockImplementationOnce(options => {
      const described = original(options)
      f.revisions['bash-sandbox'] = 7
      return described
    })
    expect(await f.settings.execute('/dsh config set bash-sandbox timeoutMs 1')).toBe('`bash-sandbox` changed elsewhere; run `/dsh config bash-sandbox` again.')
    expect(f.user['bash-sandbox']).toEqual({ limits: { graceMs: 5000 } })
  })

  it('shows the service\'s validation error plainly and changes nothing', async () => {
    const f = fakeSettings()
    expect(await f.settings.execute('/dsh config set bash-sandbox timeoutMs abc')).toBe('Not saved: $.timeoutMs expected number but got abc')
    expect(f.user['bash-sandbox']).toEqual({ limits: { graceMs: 5000 } })
  })

  it('resets an overridden field to its default and refuses one that is not overridden', async () => {
    const f = fakeSettings()
    expect(await f.settings.execute('/dsh config reset bash-sandbox limits.graceMs')).toBe('Reset `limits.graceMs` of `bash-sandbox` to its default `3000`; applied to the running leader.')
    expect(f.mutate).toHaveBeenLastCalledWith('bash-sandbox', [{ op: 'unset', path: ['limits', 'graceMs'] }], 3)
    expect(await f.settings.execute('/dsh config reset bash-sandbox timeoutMs')).toBe('`timeoutMs` of `bash-sandbox` is not overridden; it is `60000`.')
    expect(f.mutate).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['/dsh config set web-search apiKey sk-new', 'Name a credential instead with `/dsh config set web-search apiKeyEnv <NAME>`'],
    ['/dsh config reset web-search apiKey', 'is or holds a secret'],
    // A value there could carry a secret, or silently drop the stored one.
    ['/dsh config set web-search endpoints {"a": {"url": "https://x", "token": "t"}}', 'Set it through the plugin\'s own flow'],
    ['/dsh config set web-search endpoints.a.token t', 'is or holds a secret'],
  ])('never writes a secret: %s', async (text, reply) => {
    const f = fakeSettings()
    expect(await f.settings.execute(text)).toContain(reply)
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it.each([
    ['/dsh config nope', '`nope` is not a settings namespace of a loaded plugin. `/dsh config` lists them.'],
    ['/dsh config set nope a 1', '`nope` is not a settings namespace of a loaded plugin.'],
    ['/dsh config set bash-sandbox timeout 1', '`bash-sandbox` has no field `timeout`. Fields: `cwd`, `timeoutMs`, `env`, `limits.maxOutputBytes`, `limits.graceMs`.'],
    ['/dsh config set bash-sandbox a..b 1', '`bash-sandbox` has no field `a..b`.'],
    ['/dsh config set bash-sandbox timeoutMs', 'Usage: `/dsh config set <namespace> <field> <json>`'],
    ['/dsh config reset bash-sandbox', 'Usage: `/dsh config reset <namespace> <field>`'],
    ['/dsh config reset bash-sandbox timeoutMs 1', 'Usage: `/dsh config reset <namespace> <field>`'],
    ['/dsh config bash-sandbox extra', 'Usage: `/dsh config [<namespace>]`'],
  ])('refuses %s before any write', async (text, reply) => {
    const f = fakeSettings()
    expect(await f.settings.execute(text)).toContain(reply)
    expect(f.mutate).not.toHaveBeenCalled()
  })

  it('says when a change waits for a restart, and refuses a profile that takes no writes', async () => {
    expect(await fakeSettings({ applies: 'restart' }).settings.execute('/dsh config set bash-sandbox timeoutMs 5'))
      .toBe('Set `timeoutMs` of `bash-sandbox` to `5`; saved; restart dscode to apply it.')
    expect(await fakeSettings({ applies: 'restart' }).settings.execute('/dsh config bash-sandbox')).toContain('changes apply when dscode restarts')
    const locked = fakeSettings({ writable: false })
    expect(await locked.settings.execute('/dsh config set bash-sandbox timeoutMs 5')).toBe('This profile does not accept settings changes.')
    expect(locked.mutate).not.toHaveBeenCalled()
  })

  it('answers without a settings service, and lists nothing to choose', async () => {
    const settings = createPluginSettings({ settings: () => undefined, bundles: async () => [] })
    expect(await settings.execute('/dsh config')).toBe('The DSH settings service is not running in this leader; restart dscode and retry.')
    expect(await settings.options('config')).toEqual([])
  })

  it('offers the namespaces, then a namespace\'s view and a confirmed reset per override', async () => {
    const f = fakeSettings()
    expect(await f.settings.options('config')).toEqual([
      { id: 'config bash-sandbox', label: 'bash-sandbox', next: true, detail: 'Base · 5 fields · 1 overridden' },
      { id: 'config web-search', label: 'web-search', next: true, detail: 'Base · 4 fields · 0 overridden' },
    ])
    expect(await f.settings.options('config bash-sandbox')).toEqual([
      { id: 'config bash-sandbox', label: 'Show every field', detail: '5 fields · 1 overridden' },
      { id: 'config reset bash-sandbox limits.graceMs', label: 'Reset limits.graceMs', detail: 'now 5000 · default 3000',
        confirmation: expect.objectContaining({ title: 'Reset limits.graceMs?', description: 'It returns to its default, 3000.', confirmLabel: 'Reset' }) },
    ])
    expect(await f.settings.options('config nope')).toEqual([])
    expect(f.mutate).not.toHaveBeenCalled()
  })
})
