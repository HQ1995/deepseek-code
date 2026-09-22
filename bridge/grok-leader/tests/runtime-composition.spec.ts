import { readFileSync } from 'node:fs'
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
    if (Array.isArray(row.config)) flatten(row.config as Row[], acc)
  }
  return acc
}
const rows = (path: string): Row[] => flatten(load(readFileSync(new URL(path, import.meta.url), 'utf8').replace(/!!js\b/g, '')) as Row[])

describe('0.1.6 runtime composition', () => {
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
    expect(patch.find(row => row.id === 'session-log-deepseek')?.config).toEqual({ enabled: false })
  })

  it.each(['history', 'lsp', 'terminal'])('keeps %s workflows inside their own realm', preset => {
    const delegation = rows(`../presets/${preset}/agent.cordis.yml`).find(row => row.id === 'delegation')!
    expect(delegation.isolate).toMatchObject({ workflowEngine: true })
    const entries = delegation.config as Row[]
    expect(entries.find(row => row.id === 'workflow-ptc')).toMatchObject({
      name: '@deepseek-ai/dsh-workflow-ptc', config: { provider: 'spawn' },
    })
    expect(entries.some(row => row.name === '@deepseek-ai/dsh-workflow-worker-thread')).toBe(false)
  })

  it.each(['history', 'lsp', 'terminal'])('keeps %s ahead of the shipped roster rows', preset => {
    const owned = rows(`../presets/${preset}/agent.cordis.yml`)
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
