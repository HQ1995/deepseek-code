// Read-only installation checks, shared by /doctor and the pre-startup CLI.
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { accessSync, constants, existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { json, parseCliVersion, unsupportedPlatformMessage, validateRuntime } from './update.mjs'
import { remoteSettings } from './remote.mjs'
import { checkRemote, localHelpers } from './remote-check.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const executable = command => {
  for (const path of isAbsolute(command) ? [command] : (process.env.PATH ?? '').split(delimiter).map(dir => resolve(dir, command))) {
    try { accessSync(path, constants.X_OK); if (statSync(path).isFile()) return path } catch {}
  }
}
const version = bin => {
  const result = spawnSync(bin, ['--version'], { encoding: 'utf8', timeout: 15000, maxBuffer: 65536 })
  if (result.error || result.status !== 0) throw new Error(`Cannot read version from ${bin}`)
  const value = parseCliVersion(result.stdout)
  if (!value) throw new Error(`Invalid version from ${bin}`)
  return value
}

// Runs the runtime's own app-boot rules, so doctor and startup agree on which
// profile bundles (and which rows they insert) DSH 0.1.7 skips or disables for
// incompatible dsh peers. Resolution matches boot: the DSH installation first.
const COMPATIBILITY_MARKER = 'DSCODE_BUNDLE_COMPATIBILITY '
const COMPATIBILITY_PROBE = `
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
const [anchor, profile] = process.argv.slice(1)
const boot = await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')).href)
const emit = value => console.log(${JSON.stringify(COMPATIBILITY_MARKER)} + JSON.stringify(value))
if (typeof boot.evaluatePluginCompatibility !== 'function' || typeof boot.resolveBundleDir !== 'function') { emit(null); process.exit(0) }
const packageOf = name => name.split('/').slice(0, name.startsWith('@') ? 2 : 1).join('/')
const components = (manifest, dir) => {
  const bundle = manifest.dsh?.bundle
  if (bundle === undefined) return []
  const patches = boot.bundlePatchPaths(dir, bundle).flatMap(file => boot.loadOverlayPatches('dscode', file))
  const names = new Set()
  const visit = rows => {
    for (const row of rows) {
      if (row.group && Array.isArray(row.config)) visit(row.config)
      if (typeof row.name !== 'string' || row.name.startsWith('.') || row.name.startsWith('/') || row.name.includes(':')) continue
      names.add(packageOf(row.name))
    }
  }
  visit(boot.composeEntries([patches.filter(patch => patch.insert !== undefined)]))
  return [...names].flatMap(name => {
    try { return [boot.readProfileManifest('dscode', boot.resolveBundleDir('dscode', name, anchor, dir))] } catch { return [] }
  })
}
let bundles = []
try { bundles = JSON.parse(readFileSync(profile + '/package.json', 'utf8')).dsh?.profile?.bundles ?? [] } catch {}
const compatibility = boot.readProfileCompatibility(profile)
const issues = []
let checked = 0
for (const bundle of bundles) {
  let dir
  try { dir = boot.resolveBundleDir('dscode', bundle, anchor, profile) } catch { continue }
  checked++
  try {
    const manifest = boot.readProfileManifest('dscode', dir)
    const seen = new Set()
    for (const [index, candidate] of [manifest, ...components(manifest, dir)].entries()) {
      const issue = boot.evaluatePluginCompatibility(candidate, compatibility.exemptions)
      // A bundle whose rows load its own package reports that package once.
      if (issue === undefined || seen.has(issue.name + '@' + issue.version)) continue
      seen.add(issue.name + '@' + issue.version)
      issues.push({ ...issue, bundle, component: index > 0, warning: boot.pluginCompatibilityWarning(issue) })
    }
  } catch (error) { issues.push({ bundle, error: String(error?.message ?? error) }) }
}
// What boot itself skips (unresolvable, unreadable or incompatible bundles),
// and whether the user patch layer loads at all: when it does not, boot fails.
let skipped = []
try {
  if (typeof boot.loadProfileDirectory === 'function') {
    skipped = boot.loadProfileDirectory('dscode', profile, anchor, { userLayer: false }).skippedBundles
      .map(({ packageName, reason }) => ({ packageName, reason: String(reason) }))
  }
} catch {}
let patchError
try { if (typeof boot.loadOptionalPatches === 'function') boot.loadOptionalPatches('dscode', profile + '/cordis.patch.yml') }
catch (error) { patchError = String(error?.message ?? error) }
emit({ runtimeVersion: boot.getDshRuntimeVersion(), checked, issues, warnings: compatibility.warnings, skipped, patchError })
`

/** The DSH installation (package.json of `@deepseek-ai/dsh`) behind an executable. */
export const dshInstallAnchor = bin => {
  let dir
  try { dir = dirname(realpathSync(bin)) } catch { return undefined }
  for (;;) {
    const manifest = join(dir, 'package.json')
    try { if (json(manifest).name === '@deepseek-ai/dsh') return manifest } catch {}
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

const failureReason = text => {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean)
  return lines.find(line => /^[A-Za-z]*Error\b/.test(line)) ?? lines[0] ?? 'no diagnostics'
}

/** A boot skip reason without the error class, the CLI prefix, or DSH's pnpm
 * repair hint (dscode manages this profile with npm through /dsh). */
const skipReason = reason => reason.replace(/^\w*Error: /, '').replace(/^(?:dsh|dscode): /, '').replace(/; run 'dsh plugin [^']*'.*$/, '')
const bundleRepair = name => `Inside dscode, /dsh disable ${name} stops loading it and /dsh remove ${name} uninstalls it.`

/** Profile bundles the runtime would skip, rows it would disable, and exempted
 * ones; a user patch that stops boot. Runtimes without the 0.1.7 compatibility
 * API are not judged. */
export const profileBundleFindings = ({ anchor, profile }) => {
  let appBoot
  try { appBoot = createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot') } catch { return [] }
  if (!appBoot) return []
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', COMPATIBILITY_PROBE, anchor, profile],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 })
  const line = (probe.stdout ?? '').split('\n').find(text => text.startsWith(COMPATIBILITY_MARKER))
  let result
  try { result = line === undefined ? undefined : JSON.parse(line.slice(COMPATIBILITY_MARKER.length)) } catch {}
  if (probe.error || probe.status !== 0 || result === undefined) {
    const reason = probe.error?.message ?? failureReason(`${probe.stderr ?? ''}\n${probe.stdout ?? ''}`)
    return [{ status: 'WARN', name: 'Profile bundles', detail: `Could not evaluate bundle compatibility: ${reason}` }]
  }
  if (result === null) return []
  const findings = result.issues.map(issue => {
    const name = `Profile bundle ${issue.bundle}`
    if (issue.error !== undefined) return { status: 'ERROR', name, detail: `Cannot evaluate its dsh peers: ${issue.error}` }
    if (issue.exempted) return { status: 'WARN', name, detail: issue.warning }
    const effect = issue.component ? 'The runtime disables the rows of this bundle that load it.' : 'The runtime skips this bundle at startup.'
    return { status: 'ERROR', name, detail: `${issue.warning} ${effect} Update or remove it, or run /dsh allow-version ${issue.name}@${issue.version} --accept-risk inside dscode.` }
  })
  findings.push(...result.warnings.map(detail => ({ status: 'WARN', name: 'Profile compatibility file', detail })))
  // An incompatible bundle is already reported above with its exemption command.
  const reported = new Set(result.issues.filter(issue => !issue.component).map(issue => issue.bundle))
  for (const { packageName, reason } of result.skipped ?? []) {
    if (!reported.has(packageName)) findings.push({ status: 'ERROR', name: `Profile bundle ${packageName}`, detail: `Skipped at startup: ${skipReason(reason)}. ${bundleRepair(packageName)}` })
  }
  if (result.patchError !== undefined) {
    findings.push({ status: 'ERROR', name: 'Profile patch', detail: `${result.patchError}. The leader cannot start until it loads: fix the file, or run dscode doctor --reset-plugins to move it aside.` })
  }
  return findings.length > 0 ? findings
    : [{ status: 'OK', name: 'Profile bundles', detail: `${result.checked} bundle(s) satisfy dsh ${result.runtimeVersion} peer requirements` }]
}

/** The leader log the TUI writes (xai-grok-pager dsh_leader.rs): DSCODE_LOG, or
 * the leader socket's `.log` sibling, exact inside a leader. A shell has only
 * this user's newest `/tmp/dscode-<uid>-*.log`, named by profile and build. */
export const leaderLog = (env = process.env, directory = '/tmp') => {
  if (env.DSCODE_LOG) return { path: env.DSCODE_LOG, exact: true }
  const socket = env.DSCODE_SOCKET
  if (socket) {
    const slash = socket.lastIndexOf('/'), dot = socket.lastIndexOf('.')
    return { path: (dot > slash + 1 ? socket.slice(0, dot) : socket) + '.log', exact: true }
  }
  const prefix = `dscode-${process.getuid?.() ?? 0}-`
  let newest
  try {
    for (const name of readdirSync(directory)) {
      if (!name.startsWith(prefix) || !name.endsWith('.log')) continue
      const path = join(directory, name), mtime = statSync(path).mtimeMs
      if (newest === undefined || mtime > newest.mtime) newest = { path, mtime }
    }
  } catch {}
  return newest === undefined ? undefined : { path: newest.path, exact: false }
}

export const installationReport = ({
  dir = packageDir,
  profile = process.env.DSH_PROFILE_DIR ?? process.env.DSCODE_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'dscode'),
  dshBin = process.env.DSH_BIN,
  tuiVersion = process.env.DSCODE_DOCTOR_TUI_VERSION,
  optional = true,
  // Connects to a remote workspace's host; only the shell doctor does, since
  // a session's /doctor already reports its live connection.
  remote = false,
  probe,
  env = process.env,
} = {}) => {
  const findings = []
  const add = (status, name, detail) => findings.push({ status, name, detail })
  const check = (name, run, fix) => {
    try { add('OK', name, run()) } catch (error) { add('ERROR', name, `${error.message}. ${fix}`) }
  }
  const pkg = json(join(dir, 'package.json'))
  const expected = pkg.dscode?.release ?? pkg.version
  const repair = `Run dscode update --version ${expected} --force-reinstall, then restart dscode.`
  add('INFO', 'Host', `${process.platform} ${release()} · Node ${process.versions.node} (${process.arch}) · ${process.execPath}`)
  if (process.platform === 'darwin' && process.arch === 'x64') add('WARN', 'macOS architecture', unsupportedPlatformMessage())
  add('INFO', 'Bridge', `${pkg.version} · ${dir}`)
  check('Installed bridge', () => {
    const installed = json(join(profile, 'node_modules', ...pkg.name.split('/'), 'package.json'))
    if (installed.version !== pkg.version || installed.dsh?.testedVersion !== pkg.dsh?.testedVersion || installed.dsh?.sourceCommit !== pkg.dsh?.sourceCommit
      || installed.dsh?.sourcePatchSha256 !== pkg.dsh?.sourcePatchSha256) throw new Error('Installed bridge differs from the loaded package')
    return `${installed.version} · ${profile}`
  }, repair)
  try {
    const actual = tuiVersion ?? version(process.env.DSCODE_BIN || join(profile, 'bin', 'dscode'))
    add(actual === expected ? 'OK' : actual === `${expected}-dev` ? 'INFO' : 'ERROR', 'TUI',
      `${actual} · expected ${expected}${actual === `${expected}-dev` ? ' (developer build)' : actual !== expected ? `. ${repair}` : ''}`)
  } catch (error) { add('ERROR', 'TUI', `${error.message}. ${repair}`) }
  const selected = dshBin || join(profile, 'runtime', 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  const resolved = executable(selected)
  check('DSH runtime', () => {
    if (!resolved) throw new Error(`DSH executable missing: ${selected}`)
    const actual = version(resolved)
    if (actual !== pkg.dsh?.testedVersion) throw new Error(`DSH ${actual}; expected ${pkg.dsh?.testedVersion}`)
    return `${actual} · ${resolved}`
  }, dshBin ? `Fix DSH_BIN to match ${pkg.dsh?.testedVersion}, or unset it. ${repair}` : repair)
  if (resolved) {
    let runtime = dirname(realpathSync(resolved))
    while (!existsSync(join(runtime, 'dscode-runtime.json')) && dirname(runtime) !== runtime) runtime = dirname(runtime)
    if (!existsSync(join(runtime, 'dscode-runtime.json')) && dshBin) {
      add('WARN', 'Runtime provenance', 'DSH_BIN override has no dscode-runtime.json; source and native artifacts are unverified. Use the managed runtime for a verified installation.')
    } else {
      check('Runtime provenance', () => {
        validateRuntime(runtime, pkg)
        return `${pkg.dsh.sourceCommit} · ${process.platform}/${process.arch} · declared native files present (not a load/PTY smoke test)`
      }, repair)
    }
  }
  if (resolved) {
    const anchor = dshInstallAnchor(resolved)
    if (anchor) findings.push(...profileBundleFindings({ anchor, profile }))
    else add('INFO', 'Profile bundles', 'Not evaluated: the DSH executable is not inside an @deepseek-ai/dsh installation.')
  }
  // dscode keeps this profile with npm (the launcher and /dsh add); a pnpm run
  // (dsh plugin --profile dscode, DSH's plugin manager) builds a second lockfile
  // and layout that the next npm run does not reconcile.
  const pnpmLock = join(profile, 'pnpm-lock.yaml')
  if (existsSync(pnpmLock)) {
    add('WARN', 'Profile package manager', `${pnpmLock} exists: pnpm installed into this dscode profile (dsh plugin --profile dscode, or DSH's plugin manager), `
      + 'which diverges from the package-lock.json npm keeps for dscode. Manage dscode plugins with /dsh add and /dsh remove only.')
  }
  const log = leaderLog(env)
  if (log !== undefined) add('INFO', 'Leader log', log.exact ? log.path : `${log.path} (this user's most recent; the TUI prints the exact path when the leader fails to start)`)
  const settings = remote ? remoteSettings(existsSync(join(profile, 'cordis.patch.yml')) ? readFileSync(join(profile, 'cordis.patch.yml'), 'utf8') : '') : undefined
  if (settings !== undefined) {
    const where = `ssh ${settings.host}:${settings.workspace}`
    const local = resolved ? localHelpers(resolved) : undefined
    try {
      const { node } = checkRemote(settings, { ...local === undefined ? {} : { install: { version: local.version } }, ...probe === undefined ? {} : { probe } })
      add('OK', 'Remote workspace', `${where} · Node ${node} · helper and bootstrap match their pinned digests`)
    } catch (error) {
      add('ERROR', 'Remote workspace', `${where}: ${error.message} No session can start until this works; \`dscode remote status --check\` repeats the check.`)
    }
  }
  if (optional) {
    const missing = ['typescript-language-server', 'tsc'].filter(command => !executable(command))
    add(missing.length ? 'INFO' : 'OK', 'Shipped LSP preset', missing.length
      ? `Optional dependencies missing: ${missing.join(', ')}. Install typescript-language-server and typescript on PATH before selecting /preset lsp; e.g. npm install -g typescript-language-server typescript. Standard works without them.`
      : 'typescript-language-server and tsc found on PATH; servers start on the first LSP query.')
    const bash = executable('/bin/bash')
    let bashVersion = '(version unavailable)'
    if (bash) {
      const probe = spawnSync(bash, ['--version'], { encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' }, timeout: 1000, maxBuffer: 65536 })
      if (probe.status === 0) bashVersion = /^GNU bash, version (\S+)/m.exec(probe.stdout)?.[1] ?? bashVersion
    }
    add(bash ? 'OK' : 'INFO', 'Shipped terminal preset', bash
      ? `/bin/bash ${bashVersion} · profile-free bash, not the login shell${process.env.SHELL ? ` (${process.env.SHELL})` : ''}. /doctor in a session also checks the registered PTY backend.`
      : 'Optional shell /bin/bash is missing. Install bash or configure terminal-bash.shellPath in the profile.')
  }
  return findings
}
export const formatInstallationReport = findings => ['Dscode runtime diagnostics', ...findings.map(f => `[${f.status}] ${f.name}: ${f.detail}`)].join('\n\n')

let invokedDirectly = false
try { invokedDirectly = !!process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url) }
catch { /* Imported from stdin, eval, or a launcher that has been replaced. */ }
if (invokedDirectly) {
  const findings = installationReport({ optional: !process.argv.includes('--runtime-only') })
  console.log(process.argv.includes('--json') ? JSON.stringify(findings) : formatInstallationReport(findings))
}
