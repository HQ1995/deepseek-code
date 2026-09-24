/** Human wording for dscode's browser tools: tool cards read "Browser: open
 * https://…" and approvals read "Allow the browser to open https://…?". The
 * raw arguments still travel beside it, so this text only summarizes them. */

const PREFIX = 'mcp__playwright-mcp__'
const MAX = 96

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? value as Record<string, unknown> : {}
const text = (value: unknown): string | undefined => {
  if (typeof value !== 'string') return undefined
  const clean = value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim()
  if (clean.length === 0) return undefined
  return clean.length > MAX ? clean.slice(0, MAX - 1) + '…' : clean
}
const quoted = (value: unknown): string | undefined => {
  const clean = text(value)
  return clean === undefined ? undefined : '"' + clean + '"'
}

/** Whether a tool name belongs to the dscode browser. */
export function isBrowserTool(name: string | undefined): boolean {
  return name?.startsWith(PREFIX) === true
}

/** What one browser call does, as a verb phrase ("open https://…"). */
export function browserAction(name: string, args: unknown): string | undefined {
  if (!isBrowserTool(name)) return undefined
  const a = record(args)
  const element = text(a.element) ?? (text(a.ref) === undefined ? 'an element' : 'element ' + text(a.ref))
  switch (name.slice(PREFIX.length)) {
    case 'browser_navigate': return 'open ' + (text(a.url) ?? 'a page')
    case 'browser_click': return (a.doubleClick === true ? 'double-click ' : 'click ') + element
    case 'browser_type': return 'type into ' + element + (a.submit === true ? ' and submit' : '')
    case 'browser_fill_form': {
      const count = Array.isArray(a.fields) ? a.fields.length : 0
      return 'fill ' + (count === 1 ? '1 form field' : String(count) + ' form fields')
    }
    case 'browser_select_option': {
      const values = Array.isArray(a.values) ? a.values.map(quoted).filter(Boolean).join(', ') : ''
      return 'choose ' + (values || 'an option') + ' in ' + element
    }
    case 'browser_hover': return 'hover over ' + element
    case 'browser_drag': return 'drag ' + (text(a.startElement) ?? 'an element') + ' to ' + (text(a.endElement) ?? 'another element')
    case 'browser_press_key': return 'press ' + (text(a.key) ?? 'a key')
    case 'browser_snapshot': return 'read the page'
    case 'browser_take_screenshot': return 'take a screenshot' + (text(a.element) === undefined ? '' : ' of ' + text(a.element))
    case 'browser_wait_for':
      if (text(a.text) !== undefined) return 'wait for ' + quoted(a.text)
      if (text(a.textGone) !== undefined) return 'wait for ' + quoted(a.textGone) + ' to disappear'
      return typeof a.time === 'number' ? 'wait ' + String(a.time) + ' s' : 'wait'
    case 'browser_resize':
      return typeof a.width === 'number' && typeof a.height === 'number'
        ? 'resize the window to ' + String(a.width) + '×' + String(a.height) : 'resize the window'
    case 'browser_close': return 'close the page'
    default: return 'run ' + name.slice(PREFIX.length).replace(/^browser_/, '').replace(/_/g, ' ')
  }
}

/** Tool card title: "Browser: open https://…". */
export function browserCardTitle(name: string, args: unknown): string | undefined {
  const action = browserAction(name, args)
  return action === undefined ? undefined : 'Browser: ' + action
}
