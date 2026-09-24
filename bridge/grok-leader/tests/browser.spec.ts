import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { NO_ORIGIN, browserCandidates, browserLaunchArgs, browserServerEnv, resolveBrowserExecutable, sandboxRestriction } from '../browser/executable.mjs'
import { browserOperation } from '../browser/operation.mjs'
import { browserDenial, hiddenTool, launchDenial, navigationPolicy, prefix, withoutAnsi } from '../browser/policy.mjs'
import { browserAction, browserCardTitle } from '../src/browser-actions.ts'

const policy = navigationPolicy(['http://127.0.0.1:3456'])
const deny = (name: string, args: unknown = {}, current = policy) => browserDenial({ name: prefix + name, arguments: args }, current)

describe('browser policy', () => {
  it('accepts only exact HTTP(S) origins', () => {
    for (const value of [['file:///tmp'], ['https://example.com/'], ['https://user@example.com'], ['invalid']]) {
      expect(() => navigationPolicy(value)).toThrow('Origins must be HTTP(S) origins')
    }
    expect(navigationPolicy([]).origins.size).toBe(0)
    expect([...navigationPolicy(['https://xn--e1afmkfd.xn--p1ai', 'http://[::1]:8080', 'http://10.0.0.1:3000', 'https://in_ternal.example']).origins])
      .toEqual(['https://xn--e1afmkfd.xn--p1ai', 'http://[::1]:8080', 'http://10.0.0.1:3000', 'https://in_ternal.example'])
  })

  it('refuses hosts that Playwright would split into more origins or turn into a glob', () => {
    // WHATWG URLs accept these as one host, so url.origin === value alone passes them.
    for (const value of ['https://good.example;evil', 'https://good.example;*', 'https://a.example,b', 'https://*.example', "https://ex'ample.com"]) {
      expect(() => navigationPolicy([value])).toThrow('plain host name')
    }
  })

  it('fails closed for unreviewed tools, host execution and transfers', () => {
    for (const tool of ['browser_run_code_unsafe', 'browser_evaluate', 'browser_file_upload', 'browser_drop', 'browser_tabs', 'browser_install', 'browser_future_tool']) {
      expect(deny(tool)).toMatch(/disabled/)
    }
    expect(browserDenial({ name: 'unrelated', arguments: {} }, policy)).toBeUndefined()
    for (const name of ['list_mcp_resources', 'list_mcp_resource_templates', 'read_mcp_resource']) {
      expect(browserDenial({ name, arguments: { server: 'playwright-mcp', uri: 'x' } }, policy)).toMatch(/resources are disabled/)
      expect(browserDenial({ name, arguments: { server: 'other' } }, policy)).toBeUndefined()
    }
    for (const key of ['filename', 'paths', '_meta']) expect(deny('browser_take_screenshot', { [key]: '' })).toMatch(/disabled/)
    expect(deny('browser_take_screenshot', {})).toBeUndefined()
  })

  it('checks direct navigation against exact origins, or any HTTP(S) origin when chosen', () => {
    expect(deny('browser_navigate', { url: 'http://127.0.0.1:3456/path?q=1' })).toBeUndefined()
    expect(deny('browser_navigate', { url: 'https://example.com' })).toContain('/browser origins add https://example.com and then start a new session with /new')
    for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'blob:http://127.0.0.1:3456/id', 'http://user@127.0.0.1:3456/', '//127.0.0.1:3456/', null]) {
      expect(typeof deny('browser_navigate', { url })).toBe('string')
    }
    const any = navigationPolicy([], true)
    expect(deny('browser_navigate', { url: 'https://example.com/x' }, any)).toBeUndefined()
    expect(deny('browser_navigate', { url: 'file:///etc/passwd' }, any)).toMatch(/HTTP\(S\)/)
    expect(deny('browser_navigate', { url: 'https://a:b@example.com' }, any)).toMatch(/credentials/)
  })
})

describe('browser session limits', () => {
  it('names an origin added after the session\'s browser started instead of a bare ERR_BLOCKED_BY_CLIENT', () => {
    const navigate = (url: string) => ({ name: prefix + 'browser_navigate', arguments: { url } })
    const launched = navigationPolicy(['http://127.0.0.1:3456'])
    expect(launchDenial(navigate('http://127.0.0.1:3456/a'), launched)).toBeUndefined()
    expect(launchDenial(navigate('https://example.com/'), launched)).toBe('https://example.com was allowed after this session\'s browser started,'
      + ' so its pages stay blocked here. The user can start a new session with /new to use it.')
    expect(launchDenial(navigate('https://example.com/'), navigationPolicy([], true))).toBeUndefined()
    expect(launchDenial(navigate('https://example.com/'), undefined)).toBeUndefined()
    expect(launchDenial({ name: prefix + 'browser_click', arguments: {} }, launched)).toBeUndefined()
  })

  it('hides only the refused operations from the model', () => {
    expect(hiddenTool(prefix + 'browser_evaluate')).toBe(true)
    expect(hiddenTool(prefix + 'browser_navigate')).toBe(false)
    expect(hiddenTool('list_mcp_resources')).toBe(false)
  })

  it('removes terminal colour codes from results without mutating them', () => {
    const result = { isError: true, content: [{ type: 'text', text: 'Call log:\u001b[2m  - navigating\u001b[22m' }, { type: 'image', data: 'x' }],
      error: { message: 'failed \u001b[31mred\u001b[39m' } }
    const clean = withoutAnsi(result)
    expect(clean).toEqual({ isError: true, content: [{ type: 'text', text: 'Call log:  - navigating' }, { type: 'image', data: 'x' }], error: { message: 'failed red' } })
    expect(result.content[0]!.text).toContain('\u001b[2m')
    expect(withoutAnsi(undefined)).toBeUndefined()
    // Private output paths shrink to their file names.
    const shot = withoutAnsi({ content: [{ type: 'text', text: 'Snapshot (../../../../var/folders/f5/x/T/dscode-browser-gbNWdR/page-1.yml) and /tmp/dscode-browser-Ab12/page-2.png' }] })
    expect(shot.content[0].text).toBe('Snapshot (page-1.yml) and page-2.png')
  })
})

describe('browser wording', () => {
  it('says what each call does for cards and approvals', () => {
    expect(browserCardTitle(prefix + 'browser_navigate', { url: 'http://127.0.0.1:3456/page' })).toBe('Browser: open http://127.0.0.1:3456/page')
    expect(browserAction(prefix + 'browser_click', { element: 'Submit button', ref: 'e3' })).toBe('click Submit button')
    expect(browserAction(prefix + 'browser_click', { ref: 'e3', doubleClick: true })).toBe('double-click element e3')
    expect(browserAction(prefix + 'browser_type', { element: 'Search', text: 'secret', submit: true })).toBe('type into Search and submit')
    expect(browserAction(prefix + 'browser_fill_form', { fields: [{}, {}] })).toBe('fill 2 form fields')
    expect(browserAction(prefix + 'browser_select_option', { element: 'Size', values: ['L'] })).toBe('choose "L" in Size')
    expect(browserAction(prefix + 'browser_press_key', { key: 'Enter' })).toBe('press Enter')
    expect(browserAction(prefix + 'browser_wait_for', { textGone: 'Loading' })).toBe('wait for "Loading" to disappear')
    expect(browserAction(prefix + 'browser_resize', { width: 800, height: 600 })).toBe('resize the window to 800×600')
    expect(browserAction(prefix + 'browser_snapshot', {})).toBe('read the page')
    expect(browserAction(prefix + 'browser_evaluate', {})).toBe('run evaluate')
    // Model text never breaks the card: control characters fold and long values clip.
    expect(browserAction(prefix + 'browser_navigate', { url: 'https://x.test/\n' + 'a'.repeat(200) })).toMatch(/^open https:\/\/x\.test\/ a+…$/)
    expect(browserAction('bash', { command: 'ls' })).toBeUndefined()
  })
})

describe('browser operation', () => {
  it('awaits cleanup on active cancellation and closes only that owner', async () => {
    const cleaned = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), abort = new AbortController()
    let closes = 0, returned = false
    const state = { closed: false, close: async () => { closes++; await cleaned.promise } }
    const pending = browserOperation(state, abort.signal, async (signal: AbortSignal) => {
      entered.resolve()
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    }, 1000).finally(() => { returned = true })
    const rejected = expect(pending).rejects.toBeDefined()
    await entered.promise; abort.abort()
    await setImmediate()
    expect([returned, state.closed, closes]).toEqual([false, true, 1])
    cleaned.resolve(); await rejected
    await expect(browserOperation(state, new AbortController().signal, async () => {}, 1000)).rejects.toThrow('reopen')
  })

  it('never touches a pre-cancelled owner, keeps it on success and closes it on timeout', async () => {
    let closes = 0
    const state = { closed: false, close: async () => { closes++ } }
    await expect(browserOperation(state, AbortSignal.abort(), async () => { throw new Error('ran') }, 1000)).rejects.toBeDefined()
    expect(closes).toBe(0)
    expect(await browserOperation(state, new AbortController().signal, async () => 42, 1000)).toBe(42)
    await expect(browserOperation(state, new AbortController().signal, async (signal: AbortSignal) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    }, 10)).rejects.toThrow('timed out')
    expect(closes).toBe(1)
  })

  it('reports a failed cleanup as an error, never as a settled browser', async () => {
    await expect(browserOperation({ closed: false, close: async () => { throw new Error('cleanup failed') } }, new AbortController().signal, async (signal: AbortSignal) => {
      await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }))
    }, 10)).rejects.toThrow('cleanup failed')
  })
})

describe('browser executable', () => {
  it('prefers a configured absolute executable and refuses relative or unusable ones', () => {
    const exists = (path: string) => path === '/opt/chrome'
    const realpath = (path: string) => path
    expect(resolveBrowserExecutable('/opt/chrome', { exists, realpath })).toEqual({ path: '/opt/chrome', source: 'configured' })
    expect(resolveBrowserExecutable('chrome', { exists, realpath }).error).toContain('absolute path')
    expect(resolveBrowserExecutable('/missing', { exists, realpath }).error).toContain('not a usable executable')
  })

  it('discovers system browsers first, then the newest Playwright build, and skips snap wrappers', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-browser-home-'))
    try {
      const cache = join(home, '.cache/ms-playwright')
      for (const revision of ['chromium-1200', 'chromium-1243']) {
        mkdirSync(join(cache, revision, 'chrome-linux64'), { recursive: true })
        writeFileSync(join(cache, revision, 'chrome-linux64', 'chrome'), '', { mode: 0o755 })
      }
      const options = { platform: 'linux', home, env: {} }
      const candidates = browserCandidates(options)
      expect(candidates.slice(0, 4)).toEqual(['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium'])
      expect(candidates.slice(4, 6)).toEqual([join(cache, 'chromium-1243/chrome-linux64/chrome'), join(cache, 'chromium-1243/chrome-linux/chrome')])
      const snap = resolveBrowserExecutable(undefined, { ...options, exists: (path: string) => path === '/usr/bin/chromium' || path.includes('ms-playwright'),
        realpath: (path: string) => path === '/usr/bin/chromium' ? '/snap/bin/chromium' : path })
      expect(snap).toEqual({ path: join(cache, 'chromium-1243/chrome-linux64/chrome'), source: 'discovered' })
      expect(resolveBrowserExecutable(undefined, { platform: 'linux', home: join(home, 'none'), env: {}, exists: () => false }).error).toContain('No Chrome or Chromium')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('warns only where AppArmor restricts user namespaces and no profile covers the browser', () => {
    const files: Record<string, string> = {
      '/proc/sys/kernel/apparmor_restrict_unprivileged_userns': '1\n',
      '/etc/apparmor.d/chrome': 'abi <abi/4.0>,\ninclude <tunables/global>\n\nprofile chrome /opt/google/chrome/chrome flags=(unconfined) {\n  userns,\n}\n',
      '/etc/apparmor.d/opera': 'profile opera /usr/lib/@{multiarch}/opera/opera flags=(unconfined) {\n}\n',
    }
    const read = (path: string) => { if (!(path in files)) throw new Error('EISDIR'); return files[path]! }
    const options = { platform: 'linux', read, list: () => ['abstractions', 'chrome', 'opera'],
      realpath: (path: string) => path === '/usr/bin/google-chrome' ? '/opt/google/chrome/google-chrome' : path }
    // The launcher script execs the profiled binary beside it.
    expect(sandboxRestriction('/usr/bin/google-chrome', options)).toBeUndefined()
    expect(sandboxRestriction('/opt/google/chrome/chrome', options)).toBeUndefined()
    const managed = '/home/u/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome'
    expect(sandboxRestriction(managed, options)).toContain('no AppArmor profile names ' + managed)
    expect(sandboxRestriction(managed, { ...options, platform: 'darwin' })).toBeUndefined()
    expect(sandboxRestriction(undefined, options)).toBeUndefined()
    files['/proc/sys/kernel/apparmor_restrict_unprivileged_userns'] = '0\n'
    expect(sandboxRestriction(managed, options)).toBeUndefined()
    delete files['/proc/sys/kernel/apparmor_restrict_unprivileged_userns']
    expect(sandboxRestriction(managed, options)).toBeUndefined()
  })

  it('always states the sandbox choice and keeps artifacts in a private directory', () => {
    const base = { cli: '/cli.js', executablePath: '/opt/chrome', outputDir: '/tmp/private' }
    expect(browserLaunchArgs({ ...base, sandbox: true, anyOrigin: true })).toEqual(['/cli.js', '--browser', 'chromium', '--isolated', '--headless', '--executable-path', '/opt/chrome', '--sandbox', '--output-dir', '/tmp/private'])
    expect(browserLaunchArgs({ ...base, sandbox: undefined })).toContain('--sandbox')
    expect(browserLaunchArgs({ ...base, sandbox: false })).toContain('--no-sandbox')
    expect(browserLaunchArgs({ ...base, sandbox: true, origins: ['https://a.example', 'http://127.0.0.1:3000'] }).slice(-3))
      .toEqual(['--allowed-origins', 'https://a.example;http://127.0.0.1:3000', '--block-service-workers'])
    // The request filter is fixed at launch: no origins yet means nothing loads, not everything.
    expect(browserLaunchArgs({ ...base, sandbox: true }).slice(-3)).toEqual(['--allowed-origins', NO_ORIGIN, '--block-service-workers'])
  })

  it('blanks inherited Playwright MCP settings and keeps Chromium\'s socket path within the Unix limit', () => {
    const env = { PLAYWRIGHT_MCP_BROWSER: 'firefox', playwright_mcp_headless: 'false', PATH: '/bin' }
    expect(browserServerEnv({ env, tmp: '/tmp' })).toEqual({ PLAYWRIGHT_MCP_BROWSER: '', playwright_mcp_headless: '' })
    expect(browserServerEnv({ env: {}, tmp: '/t'.padEnd(60, 'x') })).toEqual({})
    // One byte longer and Chromium's singleton socket would exceed 107 bytes.
    expect(browserServerEnv({ env: {}, tmp: '/t'.padEnd(61, 'x') })).toEqual({ TMPDIR: '/tmp' })
  })
})

describe('browser plugin module', () => {
  it('loads as the plugin row imports it', async () => {
    const plugin = await import('../browser/index.mjs')
    expect(plugin.name).toBe('dscode-browser')
    expect(typeof plugin.apply).toBe('function')
    expect(plugin.ALWAYS_APPROVE).toContain('always-approve mode')
  })
})
