/** Reviewed operations for the pinned Playwright MCP 0.0.80 experiment. */
export const prefix = 'mcp__playwright-mcp__'
const allowed = new Set([
  'browser_snapshot', 'browser_click', 'browser_drag', 'browser_hover',
  'browser_select_option', 'browser_close', 'browser_resize',
  'browser_fill_form', 'browser_press_key', 'browser_type',
  'browser_navigate', 'browser_take_screenshot', 'browser_wait_for',
])

/** Validate the explicit direct-navigation origins, not a network policy. */
export function navigationOrigins(values) {
  if (!Array.isArray(values) || values.length === 0) throw new Error('Explicit navigationOrigins are required')
  return new Set(values.map(value => {
    const url = new URL(value)
    if (!['http:', 'https:'].includes(url.protocol) || url.origin !== value || url.username || url.password) {
      throw new Error('navigationOrigins must contain HTTP(S) origins without credentials, paths or trailing slashes')
    }
    return url.origin
  }))
}

/** A denial is enforced by tools.guard even if another policy returns allow. */
export function browserDenial(exec, origins) {
  if (!exec.name.startsWith(prefix)) return undefined
  const tool = exec.name.slice(prefix.length)
  if (!allowed.has(tool)) return 'This browser operation is disabled in the dscode Playwright experiment.'
  const args = exec.arguments
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return 'Browser arguments must be an object.'
  if (['_meta', 'filename', 'paths'].some(key => Object.hasOwn(args, key))) {
    return 'Custom browser metadata, output paths and file transfers are disabled.'
  }
  if (tool === 'browser_navigate') {
    try {
      const url = new URL(args.url)
      if (typeof args.url !== 'string' || !['http:', 'https:'].includes(url.protocol) || !origins.has(url.origin) || url.username || url.password) {
        return 'Direct navigation is outside the configured HTTP(S) origins.'
      }
    } catch {
      return 'Direct navigation requires an absolute HTTP(S) URL.'
    }
  }
  return undefined
}
