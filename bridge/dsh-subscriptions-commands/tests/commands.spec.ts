import { describe, expect, it } from 'vitest'
import { apply } from '../src/index.ts'

type Result = { kind: 'success'; text?: string } | { kind: 'error'; text: string }
interface Registered {
  name: string
  description: string
  input?: { hint: string }
  handler: (invocation: { agent: unknown; rawInput: string; signal: AbortSignal }) => Promise<Result> | Result
}

/** Minimal structural ctx: a commands registry capture plus effect passthrough. */
function makeCtx() {
  const registered: Registered[] = []
  const ctx = {
    get: (name: string) => name === 'commands'
      ? { register: (definition: Registered) => { registered.push(definition); return () => undefined } }
      : undefined,
    effect: (fn: () => () => void) => { fn(); return () => undefined },
  }
  return { ctx: ctx as never, registered }
}

const invoke = (registered: Registered[], name: string, rawInput: string): Promise<Result> | Result =>
  registered.find(cmd => cmd.name === name)!.handler({ agent: {} as never, rawInput, signal: new AbortController().signal })

describe('dsh-subscriptions-commands', () => {
  it('registers the four terminal commands with hints', () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    expect(registered.map(cmd => cmd.name).sort()).toEqual(['code', 'login', 'logout', 'subscriptions-status'])
    expect(registered.find(cmd => cmd.name === 'login')!.input!.hint).toBe('codex | claude | grok')
  })

  it('is a no-op without a command registry (headless-safe)', () => {
    const bare = { get: () => undefined, effect: () => () => undefined }
    expect(() => apply(bare as never)).not.toThrow()
  })

  it('rejects unknown providers with usage', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    expect(await invoke(registered, 'login', 'bogus')).toEqual({ kind: 'error', text: 'Usage: /login <codex|claude|grok>' })
    expect(await invoke(registered, 'logout', '')).toEqual({ kind: 'error', text: 'Usage: /logout <codex|claude|grok>' })
  })

  it('degrades to an actionable error when the subscriptions plugin is absent', async () => {
    // This dev tree does not install dsh-plugin-subscriptions, so resolution
    // fails — exactly the runtime shape on a profile without the plugin.
    const { ctx, registered } = makeCtx()
    apply(ctx)
    const result = await invoke(registered, 'login', 'codex')
    expect(result.kind).toBe('error')
    expect((result as { text: string }).text).toContain('/dsh add dsh-plugin-subscriptions')
    const status = await invoke(registered, 'subscriptions-status', '')
    expect(status.kind).toBe('error')
  })

  it('refuses /code with no login in progress', async () => {
    const { ctx, registered } = makeCtx()
    apply(ctx)
    expect(await invoke(registered, 'code', 'https://cb?code=x')).toEqual({
      kind: 'error',
      text: 'No login is in progress — run /login <codex|claude|grok> first.',
    })
  })
})
