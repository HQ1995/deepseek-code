/** Reviewed operations for the pinned Playwright MCP 0.0.80 browser. */
export const serverName = 'playwright-mcp'
export const prefix = 'mcp__' + serverName + '__'
const resourceTools = new Set(['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource'])
export const allowedTools = new Set([
  'browser_snapshot', 'browser_click', 'browser_drag', 'browser_hover',
  'browser_select_option', 'browser_close', 'browser_resize',
  'browser_fill_form', 'browser_press_key', 'browser_type',
  'browser_navigate', 'browser_take_screenshot', 'browser_wait_for',
])

/** A plain DNS name, IPv4 or bracketed IPv6 host. WHATWG URLs also accept
 * `;`, `,` and `*` in hosts; Playwright would split or glob those. */
const plainHost = /^(?:\[[0-9a-f:.]+\]|[a-z0-9_-]+(?:\.[a-z0-9_-]+)*)$/

/** One configured direct-navigation origin: HTTP(S), a plain host, no credentials, path or trailing slash. */
export function navigationOrigin(value) {
  let url
  try { url = new URL(value) } catch { url = undefined }
  if (url === undefined || !['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password
    || !plainHost.test(url.hostname)) {
    throw new Error('Origins must be HTTP(S) origins with a plain host name or IP address, without credentials, paths or trailing slashes: ' + String(value))
  }
  return url.origin
}

/** Direct-navigation policy: exact origins, or any HTTP(S) origin when explicitly chosen.
 * This checks only the model's navigate calls; page requests are filtered by
 * Playwright's --allowed-origins at launch (see executable.mjs). */
export function navigationPolicy(origins = [], anyOrigin = false) {
  return { any: anyOrigin === true, origins: new Set(origins.map(navigationOrigin)) }
}

/** A denial is enforced by tools.guard even if another policy returns allow. */
export function browserDenial(exec, policy) {
  // The generic MCP resource tools name their server in an argument.
  if (resourceTools.has(exec.name) && exec.arguments?.server === serverName) return 'Browser MCP resources are disabled in dscode.'
  if (!exec.name.startsWith(prefix)) return undefined
  const tool = exec.name.slice(prefix.length)
  if (!allowedTools.has(tool)) return 'This browser operation is disabled in dscode.'
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'Browser arguments must be an object.'
  if (['_meta', 'filename', 'paths'].some(key => Object.hasOwn(args, key))) {
    return 'Custom browser metadata, output paths and file transfers are disabled.'
  }
  if (tool === 'browser_navigate') {
    let url
    try { url = typeof args.url === 'string' ? new URL(args.url) : undefined } catch { url = undefined }
    if (url === undefined || !['http:', 'https:'].includes(url.protocol)) return 'Direct navigation requires an absolute HTTP(S) URL.'
    if (url.username || url.password) return 'Direct navigation URLs may not carry credentials.'
    if (!policy.any && !policy.origins.has(url.origin)) {
      return 'Direct navigation to ' + url.origin + ' is outside the allowed origins. The user can allow it with'
        + ' /browser origins add ' + url.origin + ' and then start a new session with /new.'
    }
  }
  return undefined
}

/** Playwright filters page requests with the origins a session's browser
 * started with, so an origin added later would fail there with a bare
 * net::ERR_BLOCKED_BY_CLIENT. Say why instead. */
export function launchDenial(exec, launched) {
  if (launched === undefined || launched.any || exec.name !== prefix + 'browser_navigate') return undefined
  let url
  try { url = new URL(exec.arguments?.url) } catch { return undefined }
  if (launched.origins.has(url.origin)) return undefined
  return url.origin + ' was allowed after this session\'s browser started, so its pages stay blocked here.'
    + ' The user can start a new session with /new to use it.'
}

/** Whether a model-facing tool is a browser operation dscode always refuses. */
export function hiddenTool(name) {
  return name.startsWith(prefix) && !allowedTools.has(name.slice(prefix.length))
}

/** Prefix of each Session's private output directory (see session-browser.mjs). */
export const OUTPUT_PREFIX = 'dscode-browser-'
/** Terminal colour codes Playwright leaves in its error text. */
const ansi = /\u001b\[[0-9;]*[A-Za-z]/g
/** Playwright names snapshot and screenshot files relative to the workspace,
 * which for a private temp directory reads `../../../../var/folders/…`. */
const outputPath = new RegExp('[^\\s()`\'"]*' + OUTPUT_PREFIX + '[A-Za-z0-9]+/', 'g')
/** A tool result without terminal escapes or private directory paths, as a new object. */
export function withoutAnsi(result) {
  if (result === null || typeof result !== 'object' || !Array.isArray(result.content)) return result
  const clean = value => typeof value === 'string' ? value.replace(ansi, '').replace(outputPath, '') : value
  const content = result.content.map(block => block?.type === 'text' ? { ...block, text: clean(block.text) } : block)
  const error = result.error !== null && typeof result.error === 'object' && typeof result.error.message === 'string'
    ? { ...result.error, message: clean(result.error.message) } : result.error
  return { ...result, content, ...result.error === undefined ? {} : { error } }
}
