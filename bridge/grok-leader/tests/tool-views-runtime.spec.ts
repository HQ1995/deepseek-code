/**
 * Tool views from the real rc.2 tools: the standard preset's tool rows are
 * mounted as the preset mounts them, and the leader projects their presenters
 * live and on resume. Execution services are stubs: presenters read only a
 * call's arguments and its durable result.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { load } from 'js-yaml'
import type { Context } from '@deepseek-ai/cordis'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import { importRuntime } from '../shared/runtime-modules.mjs'
import { makeClient, register, useLeaderHarness, waitFor } from './support/leader-harness.ts'

const TOOL_ROWS = ['tool-bash', 'tool-fs', 'tool-fs-search', 'tool-web']

async function mountStandardTools(ctx: Context): Promise<void> {
  const { default: SystemPrompt } = await importRuntime('@deepseek-ai/dsh-system-prompt')
  const { default: Tools } = await importRuntime('@deepseek-ai/dsh-tools')
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  for (const service of ['shell', 'shellEnv', 'fs', 'subprocess', 'web']) ctx.provide(service as never, {} as never)
  const patch = load(readFileSync(new URL('../presets/standard.patch.yml', import.meta.url), 'utf8').replace(/!!js\b/g, '')) as
    Array<{ insert: Array<{ config: { plugins: Array<{ id: string; name: string; config?: unknown }> } }> }>
  const rows = patch[0]!.insert[0]!.config.plugins
  for (const id of TOOL_ROWS) {
    const row = rows.find(entry => entry.id === id)!
    await ctx.plugin(await importRuntime(row.name), row.config ?? {})
  }
}

const source = 'const a = 1'
/** One call and its durable result per tool, as the tools record them. */
const calls: Array<{ name: string; args: Record<string, unknown>; text: string; meta?: unknown }> = [
  { name: 'bash', args: { command: 'echo hi', description: 'Say hi' }, text: 'hi\n' },
  { name: 'read', args: { file_path: '/w/a.ts' }, text: `<path>/w/a.ts</path>\n<type>file</type>\n<content>\n1: ${source}\n</content>`,
    meta: { path: '/w/a.ts', offset: 1, lines: [{ number: 1, text: source }], totalLines: 1, lang: 'ts' } },
  { name: 'edit', args: { file_path: '/w/a.ts', old_string: '1', new_string: '2' }, text: 'Edited /w/a.ts',
    meta: { diffs: [{ path: '/w/a.ts', oldText: source, newText: 'const a = 2' }] } },
  { name: 'grep', args: { pattern: 'const' }, text: 'Found 1 match\n\na.ts:1: const a = 2',
    meta: { shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'const a = 2' }] }], truncated: false, total: 1 } },
  { name: 'glob', args: { pattern: '**/*.ts' }, text: 'a.ts', meta: { shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 } },
  { name: 'web_fetch', args: { url: 'https://example.test/' }, text: '# Example', meta: { url: 'https://example.test/', statusCode: 200, truncated: false } },
]
const events = calls.flatMap(({ name, args, text, meta }, index): SessionEvent[] => [
  { type: 'tool/call', seq: index * 2, time: 10 + index, data: { turn: 1, step: index, callId: 'call-' + name, name, arguments: JSON.stringify(args) } },
  { type: 'tool/result', seq: index * 2 + 1, time: 10 + index, data: { ...meta === undefined ? {} : { meta }, message: { role: 'tool', toolCallId: 'call-' + name, content: [{ type: 'text', text }] } } },
] as unknown as SessionEvent[])

type Row = Record<string, unknown> & { method?: string; params?: { update?: { sessionUpdate?: string; toolCallId?: string; kind?: string; _meta?: Record<string, unknown> } } }
const views = (rows: Row[]) => rows.flatMap(row => {
  const update = row.method === 'session/update' ? row.params?.update : undefined
  if (update?.sessionUpdate !== 'tool_call' && update?.sessionUpdate !== 'tool_call_update') return []
  return [{ id: update.toolCallId, update: update.sessionUpdate, name: (update._meta?.['x.ai/tool'] as { name?: string } | undefined)?.name, view: update._meta?.['dscode/view'] }]
})

describe('tool views from the mounted standard preset', () => {
  const start = useLeaderHarness()

  it('projects the real presenters of bash, read, edit, grep, glob and web_fetch, live and on resume alike', async () => {
    const { ctx, pluginCtx, registry, persistence, socketPath, client: c } = await start()
    await mountStandardTools(ctx)
    register(c); await c.next()
    const created = await c.request(1, 'session/new', { cwd: '/w', mcpServers: [] })
    const agent = registry.byId.get((created.result as { sessionId: string }).sessionId)!
    for (const event of events) pluginCtx.emit('session/event', agent.session, event)
    await waitFor(() => views(c.all as Row[]).length === events.length)
    const live = views(c.all as Row[])
    expect(live.map(row => row.view && (row.view as { card: string }).card)).toEqual([
      'terminal', 'terminal', 'generic', 'read', 'diff', 'diff', 'generic', 'search', 'generic', 'search', 'generic', 'web',
    ])
    expect(live.filter(row => row.update === 'tool_call').map(row => row.name)).toEqual(calls.map(entry => entry.name))
    // The views title and kind the cards; no typed rawOutput is rebuilt from names.
    const updates = (c.all as Row[]).filter(row => row.method === 'session/update').map(row => row.params!.update as Record<string, unknown>)
    expect(updates.filter(update => update.sessionUpdate === 'tool_call').map(update => [update.title, update.kind])).toEqual([
      ['echo hi', 'execute'], ['Read /w/a.ts', 'read'], ['Edit /w/a.ts', 'edit'], ['Grep const', 'search'], ['Glob **/*.ts', 'search'], ['https://example.test/', 'fetch'],
    ])
    expect(updates.filter(update => update.sessionUpdate === 'tool_call_update' && 'rawOutput' in update)).toEqual([])
    expect(updates.find(update => update.toolCallId === 'call-edit' && update.sessionUpdate === 'tool_call_update')).toMatchObject({
      content: [{ type: 'content' }, { type: 'diff', path: '/w/a.ts', oldText: source, newText: 'const a = 2' }] })
    const byId = (id: string) => live.filter(row => row.id === id).map(row => row.view)
    expect(byId('call-bash')).toEqual([{ card: 'terminal', title: 'echo hi', description: 'Say hi' }, { card: 'terminal', output: 'hi\n', exitCode: 0 }])
    expect(byId('call-read')).toEqual([
      { card: 'generic', title: 'Read /w/a.ts', kind: 'read', locations: [{ path: '/w/a.ts', line: 1 }] },
      { card: 'read', path: '/w/a.ts', offset: 1, lines: [{ number: 1, text: source }], totalLines: 1, lang: 'ts', content: [{ type: 'text', text: '1: ' + source }] },
    ])
    expect(byId('call-edit')).toEqual([
      { card: 'diff', title: 'Edit /w/a.ts', diffs: [{ path: '/w/a.ts', oldText: '1', newText: '2' }], locations: [{ path: '/w/a.ts' }] },
      { card: 'diff', title: 'Edit /w/a.ts', diffs: [{ path: '/w/a.ts', oldText: source, newText: 'const a = 2' }] },
    ])
    expect(byId('call-grep')).toEqual([{ card: 'generic', title: 'Grep const', kind: 'search', rawInput: 'const' },
      { card: 'search', shape: 'matches', files: [{ path: 'a.ts', matches: [{ lineNumber: 1, line: 'const a = 2' }] }], truncated: false, total: 1 }])
    expect(byId('call-glob')).toEqual([{ card: 'generic', title: 'Glob **/*.ts', kind: 'search', rawInput: '**/*.ts' },
      { card: 'search', shape: 'paths', paths: ['a.ts'], truncated: false, total: 1 }])
    expect(byId('call-web_fetch')).toEqual([{ card: 'generic', title: 'https://example.test/', kind: 'fetch', rawInput: 'https://example.test/' },
      { card: 'web', kind: 'fetch', title: 'https://example.test/', url: 'https://example.test/', statusCode: 200, truncated: false }])

    // The same durable log, resumed by another client, carries the same views.
    persistence.events.push(...events)
    const other = await makeClient(socketPath)
    try {
      register(other); await other.next()
      expect((await other.request(1, 'session/load', { sessionId: 'persisted-session', cwd: '/w', mcpServers: [] })).error).toBeUndefined()
      await waitFor(() => views(other.all as Row[]).length === events.length)
      expect(views(other.all as Row[])).toEqual(live)
    } finally { other.socket.destroy() }
  })
})
