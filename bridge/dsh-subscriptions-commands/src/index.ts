/**
 * Terminal commands for dsh-plugin-subscriptions.
 *
 * The subscriptions plugin (0.3.x) ships its login UI only in the dsh web
 * profile; its OAuth engine (loopback server + manual paste + 0600 token
 * store) is UI-agnostic node code. This package is the plugin-space adapter:
 * it registers `/login`, `/logout`, `/code`, and `/subscriptions-status` in
 * the dsh command registry, so ANY command-capable surface (dscode, other
 * terminals) gets subscription logins with zero host/bridge/TUI knowledge of
 * this plugin. This is the "wrap a plugin in plugin space" pattern: weird
 * plugins get adapted next to them, never inside a product.
 *
 * Internals are pinned against dsh-plugin-subscriptions 0.3.x (its export
 * map exposes only the entry, so lib paths are derived from the resolved
 * entry — the same seam deepseek-code's scripts/subscriptions-login.mjs
 * uses). If an upgrade breaks this package, re-check lib/auth and
 * lib/providers shapes.
 *
 * @module @hqzhao95/dsh-subscriptions-commands
 */
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export const name = 'dsh-subscriptions-commands'

const PROVIDERS = ['codex', 'claude', 'grok'] as const
type Provider = typeof PROVIDERS[number]

/** Structural read of the dsh command registry (optional composition member). */
interface CommandsLike {
  register(definition: {
    name: string
    description: string
    input?: { hint: string }
    handler: (invocation: { agent: Agent; rawInput: string; signal: AbortSignal }) => Promise<CommandResultLike> | CommandResultLike
  }): () => void
}
type CommandResultLike = { kind: 'success'; text?: string } | { kind: 'error'; text: string }

/** One in-flight OAuth attempt (subscriptions OAuthFlowManager shape). */
interface AttemptLike {
  authorizeUrl: string
  redirectUri: string
  state: string
  pkce: { verifier: string; challenge: string }
  waitCode(): Promise<string>
  manual(input: string): void
  cancel(): void
}

/** The installed subscriptions plugin's lib dir, resolved from wherever this
 *  package sits (profile-hoisted node_modules), or undefined when absent. */
const subscriptionsLib = (): string | undefined => {
  try {
    const entry = createRequire(import.meta.url).resolve('dsh-plugin-subscriptions')
    return dirname(entry)
  } catch {
    return undefined
  }
}

const subscriptionsModule = async (rel: string): Promise<Record<string, any> | undefined> => {
  const lib = subscriptionsLib()
  if (lib === undefined) return undefined
  try {
    return await import(pathToFileURL(join(lib, rel)).href) as Record<string, any>
  } catch {
    return undefined
  }
}

const NOT_INSTALLED: CommandResultLike = {
  kind: 'error',
  text: 'dsh-plugin-subscriptions is not installed in this profile — install it first (in dscode: /dsh add dsh-plugin-subscriptions), then restart.',
}

/** Turnless user-visible notice for background completion; the agent may be
 *  gone by then, so failures are swallowed. */
const notify = (agent: Agent, text: string): void => {
  try {
    agent.inject(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
  } catch {
    // Session ended before the background exchange settled.
  }
}

export function apply(ctx: Context): void {
  const commands = ctx.get('commands') as CommandsLike | undefined
  if (commands === undefined) return

  let pending: { provider: Provider; attempt: AttemptLike } | undefined

  const disposers = [
    commands.register({
      name: 'login',
      description: 'Log in to a ChatGPT/Claude/Grok subscription (dsh-plugin-subscriptions)',
      input: { hint: 'codex | claude | grok' },
      handler: async ({ agent, rawInput }) => {
        const provider = rawInput.trim() as Provider
        if (!(PROVIDERS as readonly string[]).includes(provider)) {
          return { kind: 'error', text: 'Usage: /login <codex|claude|grok>' }
        }
        const flowMod = await subscriptionsModule('auth/oauth-flow.js')
        const providerMod = await subscriptionsModule('providers/' + provider + '.js')
        const storeMod = await subscriptionsModule('auth/store.js')
        if (flowMod === undefined || providerMod === undefined || storeMod === undefined) return NOT_INSTALLED
        pending?.attempt.cancel()
        const spec = provider === 'codex' ? providerMod.codexFlow
          : provider === 'claude' ? providerMod.claudeFlow
          : await providerMod.grokFlow()
        const manager = new flowMod.OAuthFlowManager()
        const attempt = await manager.start(provider, spec) as AttemptLike
        pending = { provider, attempt }
        // The exchange settles in the background after this reply: the
        // loopback callback (same machine) or /code (remote) supplies the code.
        void (async () => {
          try {
            const code = await attempt.waitCode()
            const session = provider === 'codex'
              ? await providerMod.exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
              : provider === 'claude'
                ? await providerMod.exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
                : await providerMod.exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
            await storeMod.saveSession(provider, session)
            notify(agent, '[subscriptions] ' + provider + ': logged in. Models appear after the providers refresh (reopen /model, or restart dscode).')
          } catch (error) {
            notify(agent, '[subscriptions] ' + provider + ': login failed — ' + (error instanceof Error ? error.message : String(error)))
          } finally {
            if (pending?.attempt === attempt) pending = undefined
          }
        })()
        return {
          kind: 'success',
          text: 'Open this URL in a browser to log in to ' + provider + ':\n\n  ' + attempt.authorizeUrl
            + '\n\nSame machine: the browser redirect completes the login automatically.'
            + '\nRemote/SSH: run /code <pasted-callback-url> here afterwards.',
        }
      },
    }),
    commands.register({
      name: 'code',
      description: 'Finish a subscription login over SSH (paste the callback URL or bare code)',
      input: { hint: '<pasted-callback-url>' },
      handler: ({ rawInput }) => {
        const input = rawInput.trim()
        if (input.length === 0) return { kind: 'error', text: 'Usage: /code <pasted-callback-url>' }
        if (pending === undefined) return { kind: 'error', text: 'No login is in progress — run /login <codex|claude|grok> first.' }
        try {
          pending.attempt.manual(input)
          return { kind: 'success', text: 'Callback accepted for ' + pending.provider + '; completing the login in the background.' }
        } catch (error) {
          return { kind: 'error', text: error instanceof Error ? error.message : String(error) }
        }
      },
    }),
    commands.register({
      name: 'logout',
      description: 'Delete a stored subscription login (dsh-plugin-subscriptions)',
      input: { hint: 'codex | claude | grok' },
      handler: async ({ rawInput }) => {
        const provider = rawInput.trim() as Provider
        if (!(PROVIDERS as readonly string[]).includes(provider)) {
          return { kind: 'error', text: 'Usage: /logout <codex|claude|grok>' }
        }
        const storeMod = await subscriptionsModule('auth/store.js')
        if (storeMod === undefined) return NOT_INSTALLED
        await storeMod.deleteSession(provider)
        return { kind: 'success', text: provider + ': session deleted.' }
      },
    }),
    commands.register({
      name: 'subscriptions-status',
      description: 'Show subscription login state (dsh-plugin-subscriptions)',
      handler: async () => {
        const storeMod = await subscriptionsModule('auth/store.js')
        if (storeMod === undefined) return NOT_INSTALLED
        const store = await storeMod.loadStore() as Record<string, { expiresAt?: number } | undefined>
        const lines = PROVIDERS.map((provider) => {
          const session = store[provider]
          const expiry = session?.expiresAt !== undefined ? ' (access token expires ' + new Date(session.expiresAt).toISOString() + ')' : ''
          return '- ' + provider + ': ' + (session !== undefined ? 'logged in' + expiry : 'not logged in')
        })
        return { kind: 'success', text: lines.join('\n') + '\nstore: ' + String(storeMod.authFilePath()) }
      },
    }),
  ]
  ctx.effect(() => () => {
    pending?.attempt.cancel()
    for (const dispose of disposers) dispose()
  }, 'dsh-subscriptions-commands.registrations')
}
