import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setImmediate } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { NO_ORIGIN, browserCandidates, browserLaunchArgs, resolveBrowserExecutable, sandboxRestriction } from '../browser/executable.mjs'
import { browserOperation } from '../browser/operation.mjs'
import { browserDenial, navigationPolicy, prefix } from '../browser/policy.mjs'

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
    expect(deny('browser_navigate', { url: 'https://example.com' })).toContain('/browser origins add https://example.com')
    for (const url of ['file:///tmp/a', 'javascript:alert(1)', 'blob:http://127.0.0.1:3456/id', 'http://user@127.0.0.1:3456/', '//127.0.0.1:3456/', null]) {
      expect(typeof deny('browser_navigate', { url })).toBe('string')
    }
    const any = navigationPolicy([], true)
    expect(deny('browser_navigate', { url: 'https://example.com/x' }, any)).toBeUndefined()
    expect(deny('browser_navigate', { url: 'file:///etc/passwd' }, any)).toMatch(/HTTP\(S\)/)
    expect(deny('browser_navigate', { url: 'https://a:b@example.com' }, any)).toMatch(/credentials/)
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
})
