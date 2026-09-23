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
      return 'Direct navigation to ' + url.origin + ' is outside the allowed origins; add it with /browser origins add ' + url.origin + '.'
    }
  }
  return undefined
}
