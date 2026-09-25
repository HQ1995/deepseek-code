import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Row {
  id?: string
  name?: string
  disabled?: boolean
  config?: unknown
  isolate?: Record<string, unknown>
  insert?: Row[]
}
// Inspect shipped YAML without evaluating its trusted runtime expressions.
// Group rows carry their entries in `config`, so descend into every array-valued
// configuration to see the roster a preset actually mounts.
const flatten = (rows: readonly Row[], acc: Row[] = []): Row[] => {
  for (const row of rows) {
    acc.push(row)
    if (row.insert) flatten(row.insert, acc)
    if (Array.isArray(row.config)) flatten(row.config as Row[], acc)
    const plugins = (row.config as { plugins?: Row[] } | undefined)?.plugins
    if (plugins) flatten(plugins, acc)
  }
  return acc
}
const parse = (text: string): Row[] => flatten(load(text.replace(/!!js\b/g, '')) as Row[])
const rows = (path: string): Row[] => parse(readFileSync(new URL(path, import.meta.url), 'utf8'))
/** The base layer of the installed runtime, which dscode's patch applies over. */
const baseRows = (): Row[] => parse(readFileSync(createRequire(import.meta.url).resolve('@deepseek-ai/dsh-base/cordis.patch.yml'), 'utf8'))

describe('0.1.7 runtime composition', () => {
  it('inherits the base PTC provider and keeps workflow execution preset-owned', () => {
    const patch = rows('../cordis.patch.yml')
    const inserted = patch.flatMap(row => row.insert ?? [])
    expect(inserted.some(row => /(?:code|ptc)-runtime/.test(row.name ?? ''))).toBe(false)
    expect(patch.find(row => row.id === 'workflow-ptc')).toMatchObject({ disabled: true })
    expect(patch.some(row => row.id === 'workflow-worker-thread')).toBe(false)
  })

  it('retains empty default routes and opts out of native session-log request contributions', () => {
    const patch = rows('../cordis.patch.yml')
    expect(patch.find(row => row.id === 'agent-default-model')?.config).toEqual({ provider: '', model: '' })
    expect(patch.find(row => row.id === 'llm-deepseek')).toMatchObject({ disabled: true })
    // 0.1.7-rc.2's account route ships on and registers "DeepSeek Account".
    expect(patch.find(row => row.id === 'llm-deepseek-account')).toMatchObject({ disabled: true })
    expect(patch.find(row => row.id === 'session-log-deepseek')?.config).toEqual({ enabled: false })
  })

  it('leaves no native DeepSeek route of the installed base switched on', () => {
    const disabled = new Set(rows('../cordis.patch.yml').filter(row => row.id !== undefined && row.disabled === true).map(row => row.id))
    const native = baseRows().filter(row => row.name?.startsWith('@deepseek-ai/dsh-llm-deepseek') === true && row.disabled !== true)
    expect(native.map(row => row.id).sort()).toEqual(['llm-deepseek', 'llm-deepseek-account'])
    expect(native.filter(row => !disabled.has(row.id))).toEqual([])
  })

  it('keeps the base Remote gateway rows and the lookups it resolves sessions through', () => {
    // x.ai/remote/invoke runs plugin Remote methods through DSH's in-process
    // Typert gateway; the agent and session rows register its agentId and
    // sessionId lookups. dscode inherits all five from the base layer.
    const remoteRows: Record<string, string> = {
      typert: '@deepseek-ai/dsh-typert-registry', 'typert-loader': '@deepseek-ai/dsh-typert-loader',
      'typert-gateway': '@deepseek-ai/dsh-api-gateway', agent: '@deepseek-ai/dsh-agent', session: '@deepseek-ai/dsh-session',
    }
    const base = baseRows()
    for (const [id, name] of Object.entries(remoteRows)) {
      expect(base.filter(row => row.id === id)).toEqual([expect.objectContaining({ name })])
      expect(base.find(row => row.id === id)).not.toHaveProperty('disabled')
    }
    // No dscode bundle patch addresses them: a patch row replaces the whole
    // row's config, and `disabled` would switch the channel off.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { dsh: { bundle: { patch: string[] } } }
    const hostRows = manifest.dsh.bundle.patch.flatMap(path => (load(readFileSync(new URL('../' + path, import.meta.url), 'utf8')
      .replace(/!!js\b/g, '')) as Row[]).flatMap(row => [row, ...row.insert ?? []]))
    expect(hostRows.length).toBeGreaterThan(0)
    expect(hostRows.filter(row => row.id !== undefined && Object.hasOwn(remoteRows, row.id))).toEqual([])
  })

  it.each(['history', 'lsp', 'terminal'])('keeps %s workflows inside their own realm', preset => {
    const delegation = rows(`../presets/${preset}.patch.yml`).find(row => row.id === 'delegation')!
    expect(delegation.isolate).toMatchObject({ workflowEngine: true })
    const entries = delegation.config as Row[]
    expect(entries.find(row => row.id === 'workflow-ptc')).toMatchObject({
      name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' },
    })
    expect(entries.some(row => row.name === '@deepseek-ai/dsh-workflow-worker-thread')).toBe(false)
  })

  it.each(['history', 'lsp', 'terminal'])('keeps %s ahead of the shipped roster rows', preset => {
    const owned = rows(`../presets/${preset}.patch.yml`)
    // 0.1.6 ships `tool-ralph` disabled in every preset it owns. These three are
    // dscode copies of `standard`, which upstream tells a deployment to fork
    // when it wants the tool back; `ralph` therefore stays in the owned roster.
    expect(owned.find(row => row.id === 'tool-ralph')).not.toHaveProperty('disabled')
    // `plugin_manager` is Creator-mode only upstream; a copy states it explicitly.
    expect(owned.find(row => row.id === 'tool-plugin-manager')).toMatchObject({
      name: '@deepseek-ai/dsh-plugin-manager/tools', disabled: true,
    })
  })
})
