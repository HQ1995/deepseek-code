import { describe, expect, it, vi } from 'vitest'
import { createBrowserControl, describeBrowser, type BrowserStatus } from '../src/browser-control.ts'
import type { SettingsLike } from '../src/native-seams.ts'
import type { PluginRows } from '../src/plugin-rows.ts'
import { navigationPolicy } from '../browser/policy.mjs'

function fixture(options: { executable?: string; startOpen?: boolean } = {}) {
  let enabled = false
  const config: Record<string, unknown> = {}, order: string[] = []
  const rows: PluginRows = {
    enabled: vi.fn(async () => enabled),
    set: vi.fn(async (_row, next: boolean) => { enabled = next }),
  }
  const settings: SettingsLike = {
    mutate: vi.fn(async (ns: string, ops: unknown) => {
      expect(ns).toBe('dscode-browser')
      order.push('settings')
      for (const op of ops as Array<{ op: string; path: string[]; value?: unknown }>) {
        if (op.op === 'unset') delete config[op.path[0]!]
        else config[op.path[0]!] = op.value
      }
    }),
  }
  const status = (): BrowserStatus | undefined => enabled ? {
    ...options.executable === undefined ? { executableError: 'No Chrome or Chromium was found.' } : { executable: options.executable, executableSource: 'discovered' },
    sandbox: config.sandbox !== false, anyOrigin: config.anyOrigin === true,
    origins: (config.navigationOrigins as string[] | undefined) ?? [], sessions: 0,
  } : undefined
  const startOpen = vi.fn(async () => { order.push('start open sessions') })
  const control = createBrowserControl({ rows, settings: () => settings, status, ...options.startOpen === false ? {} : { startOpen } })
  return { control, rows, settings, config, order, startOpen, isEnabled: () => enabled }
}

describe('/browser', () => {
  it('reports off, then turns on with origins and states the security boundary', async () => {
    const f = fixture({ executable: '/opt/chrome' })
    expect(await f.control.execute('/browser')).toContain('Browser: off')
    const report = await f.control.execute('/browser on --origin https://example.com --origin https://example.com')
    expect(f.isEnabled()).toBe(true)
    expect(f.config).toEqual({ navigationOrigins: ['https://example.com'] })
    // The row reaches running sessions too, so no /new is needed.
    expect(report).toContain('Browser turned on. Open sessions get the browser tools at their next step, and new sessions start with them.')
    expect(report).not.toContain('/new')
    expect(report).toContain('\n- executable: /opt/chrome (discovered)\n')
    expect(report).toContain('- allowed origins: https://example.com')
    expect(report).toContain('it is not a network sandbox')
    const status = await f.control.execute('/browser status')
    expect(status).toContain('- sandbox: on')
    // The security note belongs to on and help, not every status check.
    expect(status).not.toContain('network sandbox')
    expect(await f.control.execute('/browser help')).toContain('network sandbox')
  })

  it('writes Markdown the TUI renders line by line, with literal placeholders', async () => {
    const f = fixture({ executable: '/opt/chrome' })
    const help = await f.control.execute('/browser help')
    // A bare <word> is raw HTML in Markdown; placeholders stay inside code spans.
    expect(help).not.toMatch(/<[a-z]+>/)
    expect(help).toMatch(/^Usage:\n- `\/browser` shows the status\.\n- `\/browser on /)
    expect(help).toContain('turns it on for open and new sessions.')
    expect(help).not.toMatch(/on for new sessions/)
    await expect(f.control.execute('/browser on --bogus')).rejects.toThrow('Unknown /browser on option "--bogus".\n\nUsage:\n- ')
    expect(await f.control.execute('/browser on')).toContain('- allowed origins: none, so every page is blocked. Add one with `/browser origins add URL`')
  })

  it('starts open sessions\' browsers only after writing the settings they launch with', async () => {
    const f = fixture({ executable: '/opt/chrome' })
    await f.control.execute('/browser on --executable /opt/chrome --origin https://example.com')
    // The row loads first (settings need it), then the settings, then the open sessions' browsers.
    expect(f.order).toEqual(['settings', 'start open sessions'])
    await f.control.execute('/browser on')
    expect(f.startOpen).toHaveBeenCalledTimes(2)
    await f.control.execute('/browser origins add https://example.org')
    await f.control.execute('/browser off')
    expect(f.startOpen).toHaveBeenCalledTimes(2)
    // A host without the hook still turns the browser on; open sessions then catch up at their next step.
    expect(await fixture({ startOpen: false }).control.execute('/browser on')).toContain('Browser turned on.')
  })

  it('shows why the requested sandbox may not start', () => {
    const text = describeBrowser({ executable: '/opt/c', sandbox: true, sandboxWarning: 'this host restricts user namespaces', anyOrigin: false, origins: [], sessions: 0 })
    expect(text).toContain('- sandbox: on\n- sandbox may not start: this host restricts user namespaces')
  })

  it('edits origins live and refuses them while the browser is off', async () => {
    const f = fixture({ executable: '/opt/chrome' })
    await expect(f.control.execute('/browser origins add https://example.com')).rejects.toThrow('The browser is off')
    await f.control.execute('/browser on')
    expect(await f.control.execute('/browser origins add http://127.0.0.1:3000')).toContain('Added http://127.0.0.1:3000')
    expect(await f.control.execute('/browser origins add https://example.com')).toContain('allowed origins: http://127.0.0.1:3000, https://example.com')
    expect(await f.control.execute('/browser origins remove http://127.0.0.1:3000')).toContain('allowed origins: https://example.com')
    await expect(f.control.execute('/browser origins add https://example.com/path')).rejects.toThrow('without credentials, paths')
    for (const origin of ['https://good.example;evil', 'https://good.example;*', 'https://a.example,b']) {
      await expect(f.control.execute('/browser origins add ' + origin)).rejects.toThrow('plain host name')
    }
    // An open browser keeps its launch origins; the reply names both ways to a fresh one.
    expect(await f.control.execute('/browser origins add https://example.org'))
      .toContain('Added https://example.org for new sessions. Start one with /new to open it, or restart the open browsers with /browser off and /browser on.')
    expect(await f.control.execute('/browser origins remove https://example.org')).toContain('No session can navigate to it any more')
    expect(describeBrowser({ executable: '/opt/c', sandbox: true, anyOrigin: false, origins: ['https://example.com'], sessions: 2 }))
      .toContain('- open sessions keep the origins their browser started with')
  })

  it('requires explicit risk acceptance to drop the sandbox and restores it with --sandbox', async () => {
    const f = fixture({ executable: '/opt/chrome' })
    await expect(f.control.execute('/browser on --no-sandbox')).rejects.toThrow('--accept-risk')
    expect(f.isEnabled()).toBe(false)
    expect(await f.control.execute('/browser on --no-sandbox --accept-risk')).toContain('sandbox: OFF')
    expect(await f.control.execute('/browser on --sandbox')).toContain('sandbox: on')
    expect(f.config).toEqual({})
  })

  it('validates options before any profile write and explains a missing browser', async () => {
    const f = fixture()
    for (const text of ['/browser on --executable chrome', '/browser on --origin', '/browser on --origin ftp://x', '/browser on --bogus', '/browser nope', '/browser off now']) {
      await expect(f.control.execute(text)).rejects.toThrow()
    }
    expect(f.rows.set).not.toHaveBeenCalled()
    const report = await f.control.execute('/browser on --executable /Applications/Chrome --any-origin')
    expect(f.config).toEqual({ executablePath: '/Applications/Chrome', anyOrigin: true })
    expect(report).toContain('executable: none. No Chrome or Chromium was found.')
    expect(report).toContain('allowed origins: any HTTP(S) origin')
    expect(await f.control.execute('/browser off')).toContain('Browser turned off')
    expect(f.isEnabled()).toBe(false)
  })

  // /browser validates origins in the leader; the browser row re-validates them
  // at launch in browser/policy.mjs, which src cannot import. The two copies of
  // the rule must agree, or a saved origin would fail every browser start.
  it('accepts exactly the origins the browser row accepts', async () => {
    const origins = ['https://example.com', 'http://127.0.0.1:3000', 'http://[::1]:8080', 'http://localhost', 'https://ex_ample.test',
      'https://example.com/', 'https://example.com/path', 'https://example.com:443', 'https://EXAMPLE.com', 'https://user@example.com',
      'ftp://example.com', 'file:///tmp', 'https://a;b.example', 'https://a,b.example', 'https://*.example.com', 'example.com', 'https://']
    for (const origin of origins) {
      let policy = true
      try { navigationPolicy([origin]) } catch { policy = false }
      const control = await fixture().control.execute('/browser on --origin ' + origin).then(() => true, () => false)
      expect(control, origin).toBe(policy)
    }
  })
})
