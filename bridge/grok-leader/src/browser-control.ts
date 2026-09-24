/** `/browser`: turn dscode's isolated browser on or off and edit its settings.
 * The browser row ships disabled; its settings are volatile. A session's
 * browser keeps the origins, executable and sandbox it started with; removing
 * an origin also stops navigation there at once. Replies are Markdown. */
import { invalidParams, internalError } from './acp.ts'
import { errorMessage } from './guards.ts'
import type { SettingsLike } from './native-seams.ts'
import type { PluginRows } from './plugin-rows.ts'
import { parseCommandLine } from './profile-plugins.ts'

const BROWSER_ROW = { id: 'dscode-browser', module: '@hqzhao95/dscode/browser', label: 'browser' }

/** Live facts the browser plugin reports (its `dscodeBrowser` service). */
export interface BrowserStatus {
  executable?: string
  executableSource?: string
  executableError?: string
  sandbox: boolean
  /** Why the requested sandbox may not start on this host. */
  sandboxWarning?: string
  anyOrigin: boolean
  origins: string[]
  originError?: string
  sessions: number
  lastError?: string
}

export interface BrowserControlDependencies {
  rows: PluginRows
  settings(): SettingsLike | undefined
  status(): BrowserStatus | undefined
}

// Code spans keep placeholders literal: a bare <word> is raw HTML in Markdown.
const BROWSER_USAGE = 'Usage:\n'
  + '- `/browser` shows the status.\n'
  + '- `/browser on [--origin URL]... [--any-origin] [--executable PATH] [--sandbox | --no-sandbox --accept-risk]` turns it on for new sessions.\n'
  + '- `/browser origins add URL` and `/browser origins remove URL` edit the allowed origins.\n'
  + '- `/browser off` turns it off and closes open browsers.'

const SECURITY = 'Each session gets its own private headless browser, but it is not a network sandbox: the origin'
  + ' filter does not cover redirects, and with --any-origin pages can reach any host, including localhost.'
  + ' Every browser action asks for your approval, so always-approve mode refuses them.'
const usageError = (message: string) => invalidParams(message + '\n\n' + BROWSER_USAGE)

/** A plain DNS name, IPv4 or bracketed IPv6 host. WHATWG URLs also accept
 * `;`, `,` and `*` in hosts; Playwright would split or glob those. */
const PLAIN_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/

/** Same rule as the plugin's policy: HTTP(S), a plain host, no credentials, path or trailing slash. */
function browserOrigin(value: string): string {
  let url: URL | undefined
  try { url = new URL(value) } catch { url = undefined }
  if (url === undefined || !['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username !== '' || url.password !== ''
    || !PLAIN_HOST.test(url.hostname)) {
    throw invalidParams('Origins must be HTTP(S) origins with a plain host name or IP address, without credentials, paths or trailing slashes: ' + value)
  }
  return url.origin
}

interface OnRequest { executable?: string; origins?: string[]; anyOrigin?: boolean; sandbox?: boolean }

function parseOn(words: string[]): OnRequest {
  const request: OnRequest = {}
  let acceptRisk = false
  for (let index = 0; index < words.length; index++) {
    const word = words[index]!
    const value = (): string => {
      const next = words[++index]
      if (next === undefined || next.startsWith('--')) throw usageError(word + ' needs a value.')
      return next
    }
    if (word === '--executable') {
      const path = value()
      if (!path.startsWith('/')) throw invalidParams('The browser executable must be an absolute path: ' + path)
      request.executable = path
    } else if (word === '--origin') (request.origins ??= []).push(browserOrigin(value()))
    else if (word === '--any-origin') request.anyOrigin = true
    else if (word === '--sandbox') request.sandbox = true
    else if (word === '--no-sandbox') request.sandbox = false
    else if (word === '--accept-risk') acceptRisk = true
    else throw usageError('Unknown /browser on option "' + word + '".')
  }
  if (request.sandbox === false && !acceptRisk) {
    throw invalidParams('--no-sandbox gives every page renderer your full user privileges. Rerun with --no-sandbox --accept-risk to allow it.')
  }
  return request
}

/** Status facts, one per item: `/browser` lists them and `/doctor` folds them into one line. */
export function browserFacts(status: BrowserStatus): string[] {
  const facts = [status.executable !== undefined
    ? 'executable: ' + status.executable + (status.executableSource === 'discovered' ? ' (discovered)' : '')
    : 'executable: none. ' + (status.executableError ?? '')]
  facts.push('sandbox: ' + (status.sandbox ? 'on' : 'OFF (--no-sandbox accepted)'))
  if (status.sandboxWarning !== undefined) facts.push('sandbox may not start: ' + status.sandboxWarning)
  facts.push('allowed origins: ' + (status.anyOrigin ? 'any HTTP(S) origin (page requests not filtered)' : status.origins.length > 0 ? status.origins.join(', ')
    : 'none, so every page is blocked. Add one with `/browser origins add URL`'))
  if (status.originError !== undefined) facts.push('origins are invalid, so navigation is denied: ' + status.originError)
  if (status.lastError !== undefined) facts.push('last start failure: ' + status.lastError)
  return facts.map(fact => fact.trim())
}

/** Status as a Markdown list. */
export function describeBrowser(status: BrowserStatus | undefined): string {
  if (status === undefined) return 'Browser: on, but the browser plugin has not started yet. Run /browser again in a moment.'
  const items = browserFacts(status)
  if (status.sessions > 0) items.push('open sessions keep the origins their browser started with; new ones use this list')
  return 'Browser: on (' + String(status.sessions) + ' open)\n\n' + items.map(item => '- ' + item).join('\n')
}

export function createBrowserControl(dependencies: BrowserControlDependencies) {
  const settings = (): SettingsLike => {
    const service = dependencies.settings()
    if (service === undefined) throw internalError('the settings service is unavailable; cannot configure the browser')
    return service
  }
  const on = async (words: string[]): Promise<string> => {
    const request = parseOn(words)
    await dependencies.rows.set(BROWSER_ROW, true)
    const ops: Array<{ op: string; path: string[]; value?: unknown }> = []
    if (request.executable !== undefined) ops.push({ op: 'set', path: ['executablePath'], value: request.executable })
    if (request.origins !== undefined) ops.push({ op: 'set', path: ['navigationOrigins'], value: [...new Set(request.origins)] })
    if (request.anyOrigin !== undefined) ops.push({ op: 'set', path: ['anyOrigin'], value: request.anyOrigin })
    if (request.sandbox === false) ops.push({ op: 'set', path: ['sandbox'], value: false })
    if (request.sandbox === true) ops.push({ op: 'unset', path: ['sandbox'] })
    if (ops.length > 0) await settings().mutate(BROWSER_ROW.id, ops)
    return 'Browser turned on for new sessions. Start one with /new.\n\n' + describeBrowser(dependencies.status()) + '\n\n' + SECURITY
  }
  const origins = async (words: string[]): Promise<string> => {
    const [action, value, ...rest] = words
    if ((action !== 'add' && action !== 'remove') || value === undefined || rest.length > 0) throw usageError('Unknown /browser origins command.')
    if (!await dependencies.rows.enabled(BROWSER_ROW)) throw invalidParams('The browser is off. Turn it on with /browser on first.')
    const origin = browserOrigin(value)
    const current = dependencies.status()?.origins ?? []
    const next = action === 'add' ? [...new Set([...current, origin])] : current.filter(item => item !== origin)
    await settings().mutate(BROWSER_ROW.id, [{ op: 'set', path: ['navigationOrigins'], value: next }])
    return (action === 'add'
      ? 'Added ' + origin + ' for new sessions. Start one with /new to open it.'
      : 'Removed ' + origin + '. No session can navigate to it any more.') + '\n\n' + describeBrowser(dependencies.status())
  }
  return {
    async execute(text: string): Promise<string> {
      let words: string[]
      try { words = parseCommandLine(text).slice(1) } catch (error) {
        throw invalidParams('Could not parse /browser command: ' + errorMessage(error))
      }
      const [verb = 'status', ...rest] = words
      switch (verb) {
        case 'status':
          if (rest.length > 0) throw usageError('/browser status takes no options.')
          return await dependencies.rows.enabled(BROWSER_ROW)
            ? describeBrowser(dependencies.status())
            : 'Browser: off. Turn it on with `/browser on --origin URL`; see `/browser help`.'
        case 'on': return on(rest)
        case 'off':
          if (rest.length > 0) throw usageError('/browser off takes no options.')
          await dependencies.rows.set(BROWSER_ROW, false)
          return 'Browser turned off. Open browsers were closed, and no session has browser tools any more.'
        case 'origins': return origins(rest)
        case 'help': return BROWSER_USAGE + '\n\n' + SECURITY
        default: throw usageError('Unknown /browser subcommand "' + verb + '".')
      }
    },
  }
}
