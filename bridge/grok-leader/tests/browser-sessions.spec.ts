import { afterEach, describe, expect, it, vi } from 'vitest'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { importRuntime } from '../shared/runtime-modules.mjs'
import { mountBrowserSessions } from '../browser/session-browser.mjs'
import { navigationPolicy, prefix } from '../browser/policy.mjs'

// A stdio MCP server with one `echo` tool stands in for Playwright MCP: this
// covers which Sessions get a browser and when, not what the browser does.
const server = fileURLToPath(new URL('./fixtures/mcp-server.mjs', import.meta.url))
const { default: SystemPrompt } = await importRuntime('@deepseek-ai/dsh-system-prompt')
const { default: Tools } = await importRuntime('@deepseek-ai/dsh-tools')
const { default: BrowserUse } = await importRuntime('@deepseek-ai/dsh-browser-use')

interface FakeAgent { id: string; ctx: Context; owner?: string; session: { header: { parentSession?: string } } }
const contexts: Context[] = []
afterEach(async () => { await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose())) })

/** Real tool and prompt registries; live agents in registration order, as the native registry lists them. */
async function fixture() {
  const ctx = new Context()
  contexts.push(ctx)
  const live = new Map<string, FakeAgent>()
  ctx.provide('agents', { get: (id: string) => live.get(id), list: () => [...live.values()],
    roots: () => [...live.values()].filter(agent => agent.owner === undefined) } as never)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(Tools)
  await ctx.plugin(BrowserUse)
  /** `owner`: a subagent's owning agent; `forkOf`: a fork's source Session, a top-level agent. */
  const agent = (id: string, owner?: string, forkOf?: string): FakeAgent => {
    const scope = ctx.plugin({ name: 'agent-' + id, apply() {} })
    const parentSession = owner ?? forkOf
    const value = { id, ctx: scope.ctx, ...owner === undefined ? {} : { owner },
      session: { header: parentSession === undefined ? {} : { parentSession } } }
    live.set(id, value)
    return value
  }
  const counts: number[] = [], errors: string[] = []
  let launches = 0, failNext = false
  const mount = async () => {
    let mounted!: ReturnType<typeof mountBrowserSessions>
    const fiber = ctx.plugin({ name: 'browser-sessions', inject: ['browserUse', 'agents', 'tools', 'systemPrompt'], apply(owner: Context) {
      mounted = mountBrowserSessions(owner, {
        // Reads the live settings, as the plugin's launch does.
        launch: () => {
          launches++
          if (failNext) { failNext = false; throw new Error('No Chrome or Chromium was found.') }
          return { policy: navigationPolicy(['http://127.0.0.1:1']), args: [server] }
        },
        toolCallTimeoutMs: 5000,
        onChange: (count: number) => counts.push(count),
        onError: (message: string) => errors.push(message),
      })
    } })
    await fiber
    return { fiber, mounted }
  }
  const browserTools = (target: FakeAgent) => ctx.get('tools')!.schemas(target).map((tool: { name: string }) => tool.name)
    .filter((name: string) => name.startsWith(prefix))
  const create = (target: FakeAgent) => ctx.serial('agent/created' as never, { agent: target, source: 'new' } as never)
  const step = (target: FakeAgent) => ctx.get('systemPrompt')!.assemble({ agent: target, scope: target })
  return { agent, mount, browserTools, create, step, counts, errors, launches: () => launches, fail: () => { failNext = true } }
}

describe('browser sessions', () => {
  it('starts browsers for top-level Sessions already running once asked, with the settings of that moment', async () => {
    const f = await fixture()
    const running = f.agent('running'), child = f.agent('child', 'running'), other = f.agent('other', undefined, 'running')
    const { mounted } = await f.mount()
    // `/browser on` writes its settings after the row loads, so nothing launches at mount.
    expect(f.launches()).toBe(0)
    expect(f.browserTools(running)).toEqual([])
    await mounted.startOpen()
    expect(f.browserTools(running)).toEqual([prefix + 'echo'])
    expect(f.browserTools(other)).toEqual([prefix + 'echo'])
    // Two browsers, one for the fork too: the subagent shares its parent's tools instead.
    expect(f.launches()).toBe(2); expect(f.counts.at(-1)).toBe(2)
    expect(mounted.launched(running as never)).toMatchObject({ any: false })
    expect(mounted.launched(child as never)).toBeUndefined()
    // Asking again starts nothing new, and a later step does not either.
    await mounted.startOpen(); await f.step(running)
    expect(f.launches()).toBe(2)
  })

  it('starts a running Session\'s browser at its next step when nothing asked, for the step after', async () => {
    const f = await fixture()
    const running = f.agent('running'), child = f.agent('child', 'running')
    await f.mount()
    await f.step(child)
    expect(f.launches()).toBe(0)
    await f.step(running)
    await vi.waitFor(() => expect(f.browserTools(running)).toEqual([prefix + 'echo']))
    await f.step(running)
    expect(f.launches()).toBe(1)
  })

  it('still attaches Sessions created after it turned on, once each', async () => {
    const f = await fixture()
    const { mounted } = await f.mount()
    const later = f.agent('later')
    await f.create(later)
    expect(f.browserTools(later)).toEqual([prefix + 'echo'])
    await mounted.startOpen()
    expect(f.launches()).toBe(1); expect(f.counts.at(-1)).toBe(1)
  })

  it('reports an open Session whose browser cannot start without failing the others, and retries when asked again', async () => {
    const f = await fixture()
    const sessions = [f.agent('one'), f.agent('two')]
    const { mounted } = await f.mount()
    // Only the first launch fails, whichever session reaches it.
    f.fail()
    await mounted.startOpen()
    expect(f.errors).toEqual(['No Chrome or Chromium was found.'])
    expect(sessions.map(session => f.browserTools(session).length).sort()).toEqual([0, 1])
    await mounted.startOpen()
    expect(sessions.map(session => f.browserTools(session))).toEqual([[prefix + 'echo'], [prefix + 'echo']])
    expect(f.launches()).toBe(3)
  })

  it('removes the tools from running Sessions when it turns off', async () => {
    const f = await fixture()
    const running = f.agent('running')
    const { fiber, mounted } = await f.mount()
    await mounted.startOpen()
    expect(f.browserTools(running)).toEqual([prefix + 'echo'])
    await fiber.dispose()
    expect(f.browserTools(running)).toEqual([])
    await vi.waitFor(() => expect(f.counts.at(-1)).toBe(0))
  })
})
