#!/usr/bin/env node
// CLI OAuth login for dsh-plugin-subscriptions — no web profile needed.
//
// The plugin's login UI lives in the dsh web profile's Settings page, but its
// OAuth engine (loopback callback server + manual code paste + token store)
// is UI-agnostic node code. This script drives that engine directly from the
// leader profile's installed copy, so a dscode-only setup can log in from the
// terminal:
//
//   node scripts/subscriptions-login.mjs codex    # ChatGPT (Codex)
//   node scripts/subscriptions-login.mjs claude   # Claude (Subscription)
//   node scripts/subscriptions-login.mjs grok     # Grok (X Premium)
//   node scripts/subscriptions-login.mjs status   # show login state
//   node scripts/subscriptions-login.mjs logout <provider>
//
// Flow: it prints the authorize URL — open it in any browser (same machine:
// the loopback callback completes the login automatically; remote/SSH: paste
// the full callback URL or the bare code back into this prompt). Tokens land
// in the plugin's own 0600 store, shared by every dsh profile. Restart dscode
// afterwards so the leader reloads the providers.
//
// Pinned against dsh-plugin-subscriptions 0.3.x internals (absolute-path
// imports bypass the package export map on purpose); if an upgrade breaks
// this script, re-check lib/auth and lib/providers shapes.
import { homedir } from 'node:os'
import { existsSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { pathToFileURL } from 'node:url'

const PROFILE_LIB = `${homedir()}/.dsh/profiles/dscode/node_modules/dsh-plugin-subscriptions/lib`
if (!PROFILE_LIB) {
  console.error('dsh-plugin-subscriptions is not installed in the dscode profile.')
  console.error('Install it first:  dsh plugin --profile dscode add dsh-plugin-subscriptions')
  process.exit(1)
}
const mod = (rel) => import(pathToFileURL(`${PROFILE_LIB}/${rel}`).href)

const [, , command, extra] = process.argv
const PROVIDERS = ['codex', 'claude', 'grok']

const store = await mod('auth/store.js')

if (command === 'status') {
  const map = await store.loadStore()
  for (const p of PROVIDERS) {
    const s = map[p]
    console.log(`${p.padEnd(7)} ${s ? 'logged in' + (s.expiresAt ? ` (access token expires ${new Date(s.expiresAt).toISOString()})` : '') : '-'}`)
  }
  console.log(`store: ${store.authFilePath()}`)
  process.exit(0)
}
if (command === 'logout') {
  if (!PROVIDERS.includes(extra)) { console.error(`usage: logout <${PROVIDERS.join('|')}>`); process.exit(1) }
  await store.deleteSession(extra)
  console.log(`${extra}: session deleted`)
  process.exit(0)
}
if (!PROVIDERS.includes(command)) {
  console.error(`usage: subscriptions-login.mjs <${PROVIDERS.join('|')}|status|logout>`)
  process.exit(1)
}

const { OAuthFlowManager } = await mod('auth/oauth-flow.js')
const provider = await mod(`providers/${command}.js`)
const spec = command === 'codex' ? provider.codexFlow
  : command === 'claude' ? provider.claudeFlow
  : await provider.grokFlow()

const mgr = new OAuthFlowManager()
const attempt = await mgr.start(command, spec)
console.log(`\nOpen this URL in a browser to log in to ${command}:\n`)
console.log(`  ${attempt.authorizeUrl}\n`)
console.log('Same machine: the browser redirect completes the login automatically.')
console.log('Remote/SSH: paste the full callback URL (or the bare code) here and press Enter.\n')

// Manual paste path runs alongside the loopback wait; whichever wins settles it.
const rl = createInterface({ input: process.stdin })
rl.on('line', (line) => {
  const input = line.trim()
  if (!input) return
  try { attempt.manual(input) } catch (error) {
    console.error(`  ${error instanceof Error ? error.message : String(error)}`)
  }
})

let code
try {
  code = await attempt.waitCode()
} catch (error) {
  console.error(`login failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
} finally {
  rl.close()
}

const session = command === 'codex'
  ? await provider.exchangeCodexCode(code, attempt.pkce.verifier, attempt.redirectUri)
  : command === 'claude'
    ? await provider.exchangeClaudeCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.state)
    : await provider.exchangeGrokCode(code, attempt.pkce.verifier, attempt.redirectUri, attempt.pkce.challenge)
await store.saveSession(command, session)
console.log(`\n${command}: logged in. Tokens stored at ${store.authFilePath()} (0600).`)
console.log('Restart dscode so the leader reloads the subscription providers.')
process.exit(0)
