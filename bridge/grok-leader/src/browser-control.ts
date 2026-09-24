/** `/browser`: turn dscode's isolated browser on or off and edit its settings.
 * The browser row ships disabled; its settings are volatile, so origins apply
 * to the next call and the executable and sandbox to the next Session. */
import { invalidParams, internalError } from './acp.ts'
import type { SettingsLike } from './native-seams.ts'
import type { PluginRows } from './plugin-rows.ts'
import { parseCommandLine } from './profile-plugins.ts'

export const BROWSER_ROW = { id: 'dscode-browser', module: '@hqzhao95/dscode/browser', label: 'browser' }

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

export const BROWSER_USAGE = 'Usage: /browser [status] | /browser on [--executable <path>] [--origin <origin>]... [--any-origin]'
  + ' [--sandbox | --no-sandbox --accept-risk] | /browser off | /browser origins add|remove <origin>'

const SECURITY = 'Browser state is isolated per Session, but the browser is not an OS network or host sandbox.'
  + ' Unless --any-origin is chosen, Playwright also refuses page requests outside the allowed origins and blocks'
  + ' service workers; that filter is fixed when a Session starts. With --any-origin, pages, redirects, subresources'
  + ' and downloads can reach any host, including localhost. Every browser action asks for approval, also in'
  + ' always-approve mode.'

/** A plain DNS name, IPv4 or bracketed IPv6 host. WHATWG URLs also accept
 * `;`, `,` and `*` in hosts; Playwright would split or glob those. */
const PLAIN_HOST = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/

/** Same rule as the plugin's policy: HTTP(S), a plain host, no credentials, path or trailing slash. */
export function browserOrigin(value: string): string {
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
      if (next === undefined || next.startsWith('--')) throw invalidParams(word + ' needs a value. ' + BROWSER_USAGE)
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
    else throw invalidParams('Unknown /browser on option "' + word + '". ' + BROWSER_USAGE)
  }
  if (request.sandbox === false && !acceptRisk) {
    throw invalidParams('--no-sandbox gives every page renderer your full user privileges. Rerun with --no-sandbox --accept-risk to allow it.')
  }
  return request
}

export function describeBrowser(status: BrowserStatus | undefined): string {
  if (status === undefined) return 'Browser: on, but the browser plugin is not active yet; run /browser again after it starts.'
  const lines = ['Browser: on (' + String(status.sessions) + ' open)']
  lines.push(status.executable !== undefined
    ? '  executable: ' + status.executable + (status.executableSource === 'discovered' ? ' (discovered)' : '')
    : '  executable: none. ' + (status.executableError ?? ''))
  lines.push('  sandbox: ' + (status.sandbox ? 'on' : 'OFF (--no-sandbox accepted)'))
  if (status.sandboxWarning !== undefined) lines.push('  sandbox may not start: ' + status.sandboxWarning)
  lines.push('  allowed origins: ' + (status.anyOrigin ? 'any HTTP(S) origin (page requests not filtered)' : status.origins.length > 0 ? status.origins.join(', ') : 'none; navigation is denied until you add one'))
  if (status.originError !== undefined) lines.push('  origins are invalid, so navigation is denied: ' + status.originError)
  if (status.lastError !== undefined) lines.push('  last start failure: ' + status.lastError)
  return lines.join('\n')
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
    return 'Browser turned on. It applies to new or resumed Sessions.\n' + describeBrowser(dependencies.status()) + '\n\n' + SECURITY
  }
  const origins = async (words: string[]): Promise<string> => {
    const [action, value, ...rest] = words
    if ((action !== 'add' && action !== 'remove') || value === undefined || rest.length > 0) throw invalidParams(BROWSER_USAGE)
    if (!await dependencies.rows.enabled(BROWSER_ROW)) throw invalidParams('The browser is off. Turn it on with /browser on first.')
    const origin = browserOrigin(value)
    const current = dependencies.status()?.origins ?? []
    const next = action === 'add' ? [...new Set([...current, origin])] : current.filter(item => item !== origin)
    await settings().mutate(BROWSER_ROW.id, [{ op: 'set', path: ['navigationOrigins'], value: next }])
    return (action === 'add' ? 'Added ' : 'Removed ') + origin + '. Navigation checks use it now; page-request filtering'
      + ' changes for Sessions started after this.\n' + describeBrowser(dependencies.status())
  }
  return {
    async execute(text: string): Promise<string> {
      let words: string[]
      try { words = parseCommandLine(text).slice(1) } catch (error) {
        throw invalidParams('Could not parse /browser command: ' + (error instanceof Error ? error.message : String(error)))
      }
      const [verb = 'status', ...rest] = words
      switch (verb) {
        case 'status':
          if (rest.length > 0) throw invalidParams(BROWSER_USAGE)
          return await dependencies.rows.enabled(BROWSER_ROW)
            ? describeBrowser(dependencies.status()) + '\n\n' + SECURITY
            : 'Browser: off. Turn it on with /browser on [--origin <origin>]; see /browser help.'
        case 'on': return on(rest)
        case 'off':
          if (rest.length > 0) throw invalidParams(BROWSER_USAGE)
          await dependencies.rows.set(BROWSER_ROW, false)
          return 'Browser turned off. Open browsers were closed; browser tools leave every Session.'
        case 'origins': return origins(rest)
        case 'help': return BROWSER_USAGE + '\n\n' + SECURITY
        default: throw invalidParams('Unknown /browser subcommand "' + verb + '". ' + BROWSER_USAGE)
      }
    },
  }
}

export type BrowserControl = ReturnType<typeof createBrowserControl>
