/** Find the Chromium-family browser the Playwright MCP server launches.
 * Never a daily profile: the server always runs isolated and headless. */
import { accessSync, constants, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join } from 'node:path'

const executableFile = path => {
  try { accessSync(path, constants.X_OK); return statSync(path).isFile() } catch { return false }
}

/** Playwright-managed Chromium builds, newest revision first. */
function managedBuilds(root, platform) {
  let names = []
  try { names = readdirSync(root).filter(name => /^chromium-\d+$/.test(name)) } catch { return [] }
  names.sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)))
  return names.flatMap(name => platform === 'darwin'
    ? ['chrome-mac-arm64', 'chrome-mac', 'chrome-mac-x64'].flatMap(dir => [
      join(root, name, dir, 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'),
      join(root, name, dir, 'Chromium.app/Contents/MacOS/Chromium'),
    ])
    : [join(root, name, 'chrome-linux64', 'chrome'), join(root, name, 'chrome-linux', 'chrome')])
}

/** Candidate paths in preference order: system browsers, then Playwright's cache. */
export function browserCandidates({ platform = process.platform, home = homedir(), env = process.env } = {}) {
  const managedRoot = env.PLAYWRIGHT_BROWSERS_PATH && env.PLAYWRIGHT_BROWSERS_PATH !== '0'
    ? env.PLAYWRIGHT_BROWSERS_PATH
    : platform === 'darwin' ? join(home, 'Library/Caches/ms-playwright') : join(home, '.cache/ms-playwright')
  const system = platform === 'darwin'
    ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', join(home, 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
      '/Applications/Chromium.app/Contents/MacOS/Chromium']
    : ['/opt/google/chrome/chrome', '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium']
  return [...system, ...managedBuilds(managedRoot, platform)]
}

/** The configured executable, or the first usable candidate. Snap wrappers are
 * refused: they cannot start inside the MCP server's isolated profile.
 * @returns `{ path, source }`, or `{ error }` with a message for the user. */
export function resolveBrowserExecutable(configured, options = {}) {
  const exists = options.exists ?? executableFile
  const realpath = options.realpath ?? realpathSync
  const usable = path => {
    if (!exists(path)) return false
    try { return !realpath(path).startsWith('/snap/') } catch { return false }
  }
  if (configured !== undefined && configured !== '') {
    if (!isAbsolute(configured)) return { error: 'The browser executable must be an absolute path: ' + configured }
    return usable(configured) ? { path: configured, source: 'configured' } : { error: 'The configured browser is not a usable executable: ' + configured }
  }
  const found = browserCandidates(options).find(usable)
  return found === undefined
    ? { error: 'No Chrome or Chromium was found. Install Google Chrome, or set one with /browser on --executable <absolute path>.' }
    : { path: found, source: 'discovered' }
}

/** Ubuntu 23.10+ restricts unprivileged user namespaces through AppArmor; a
 * browser without its own AppArmor profile then cannot start Chromium's
 * namespace sandbox. Best effort: an unreadable setting means no warning.
 * @returns a warning for the user, or undefined. */
export function sandboxRestriction(executablePath, options = {}) {
  const { platform = process.platform, read = path => readFileSync(path, 'utf8'), list = dir => readdirSync(dir), realpath = realpathSync } = options
  if (platform !== 'linux' || executablePath === undefined) return undefined
  try { if (read('/proc/sys/kernel/apparmor_restrict_unprivileged_userns').trim() !== '1') return undefined } catch { return undefined }
  let binary = executablePath
  try { binary = realpath(executablePath) } catch { /* keep the configured spelling */ }
  // Google Chrome's launcher script execs the profiled `chrome` beside it.
  const covered = new Set([binary, join(dirname(binary), 'chrome')])
  let names = []
  try { names = list('/etc/apparmor.d') } catch { /* no readable profiles: warn */ }
  for (const name of names) {
    let text
    try { text = read(join('/etc/apparmor.d', name)) } catch { continue }
    for (const match of text.matchAll(/^\s*profile\s+\S+\s+(\/\S+)/gm)) if (covered.has(match[1])) return undefined
  }
  return 'this host restricts unprivileged user namespaces (AppArmor) and no AppArmor profile names ' + binary
    + '. Use Google Chrome from /opt/google/chrome, or give this browser an AppArmor profile.'
}

/** Stands in for an empty allowlist: `.invalid` never resolves (RFC 6761). */
export const NO_ORIGIN = 'https://no-origin.invalid'

/** Playwright MCP arguments. The sandbox is always requested explicitly:
 * Playwright's Linux Chromium channel otherwise launches with --no-sandbox.
 * Unless any origin is allowed, Playwright refuses page requests outside the
 * validated origins (request routing, not an OS network sandbox) and blocks
 * service workers, which routing cannot see. The filter is fixed at launch, so
 * an empty allowlist blocks everything rather than filtering nothing. */
export function browserLaunchArgs({ cli, executablePath, sandbox, outputDir, origins = [], anyOrigin = false }) {
  const allowed = origins.length > 0 ? origins : [NO_ORIGIN]
  return [cli, '--browser', 'chromium', '--isolated', '--headless', '--executable-path', executablePath,
    sandbox === false ? '--no-sandbox' : '--sandbox', '--output-dir', outputDir,
    ...anyOrigin === true ? [] : ['--allowed-origins', allowed.join(';'), '--block-service-workers']]
}
