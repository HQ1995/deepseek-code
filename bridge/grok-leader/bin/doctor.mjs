// Read-only installation checks, shared by /doctor and the pre-startup CLI.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir, release } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseCliVersion, unsupportedPlatformMessage, validateRuntime } from './update.mjs'

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const json = path => JSON.parse(readFileSync(path, 'utf8'))
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

// Runs the runtime's own app-boot rule, so doctor and startup agree on which
// profile bundles DSH 0.1.7 skips for incompatible dsh peers.
const COMPATIBILITY_PROBE = `
import { createRequire } from 'node:module'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
const [runtime, profile] = process.argv.slice(1)
const anchor = join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json')
const boot = await import(pathToFileURL(createRequire(anchor).resolve('@deepseek-ai/dsh-app-boot')).href)
if (typeof boot.evaluatePluginCompatibility !== 'function') { console.log('null'); process.exit(0) }
const manifest = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined } }
const compatibility = boot.readProfileCompatibility(profile)
const issues = []
let checked = 0
for (const name of manifest(join(profile, 'package.json'))?.dsh?.profile?.bundles ?? []) {
  const parts = name.split('/')
  const pkg = manifest(join(profile, 'node_modules', ...parts, 'package.json')) ?? manifest(join(runtime, 'node_modules', ...parts, 'package.json'))
  if (pkg === undefined) continue
  checked++
  try {
    const issue = boot.evaluatePluginCompatibility(pkg, compatibility.exemptions)
    if (issue !== undefined) issues.push({ ...issue, warning: boot.pluginCompatibilityWarning(issue) })
  } catch (error) { issues.push({ name, error: error.message }) }
}
console.log(JSON.stringify({ runtimeVersion: boot.getDshRuntimeVersion(), checked, issues, warnings: compatibility.warnings }))
`

/** Profile bundles the runtime would skip or run only under an exact-version
 * exemption. Runtimes without the 0.1.7 compatibility API are not judged. */
export const profileBundleFindings = ({ runtime, profile }) => {
  if (!existsSync(join(runtime, 'node_modules/@deepseek-ai/dsh-app-boot/package.json'))) return []
  const probe = spawnSync(process.execPath, ['--input-type=module', '-e', COMPATIBILITY_PROBE, runtime, profile],
    { encoding: 'utf8', timeout: 15000, maxBuffer: 1 << 20 })
  if (probe.error || probe.status !== 0) {
    const reason = (probe.error?.message ?? probe.stderr ?? '').trim().split('\n').at(-1)
    return [{ status: 'WARN', name: 'Profile bundles', detail: `Could not evaluate bundle compatibility: ${reason}` }]
  }
  const result = JSON.parse(probe.stdout)
  if (result === null) return []
  const findings = result.issues.map(issue => issue.error !== undefined
    ? { status: 'ERROR', name: `Profile bundle ${issue.name}`, detail: `Cannot evaluate its dsh peers: ${issue.error}` }
    : { status: issue.exempted ? 'WARN' : 'ERROR', name: `Profile bundle ${issue.name}`, detail: issue.exempted ? issue.warning
      : `${issue.warning} The runtime skips this bundle at startup. Update or remove it, or run: dsh plugin --profile dscode allow-version ${issue.name}@${issue.version} --dsh-version ${issue.runtimeVersion} --accept-risk` })
  findings.push(...result.warnings.map(detail => ({ status: 'WARN', name: 'Profile compatibility file', detail })))
  return findings.length > 0 ? findings
    : [{ status: 'OK', name: 'Profile bundles', detail: `${result.checked} bundle(s) satisfy dsh ${result.runtimeVersion} peer requirements` }]
}

export const installationReport = ({
  dir = packageDir,
  profile = process.env.DSH_PROFILE_DIR ?? process.env.DSCODE_HOME ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'profiles', 'dscode'),
  dshBin = process.env.DSH_BIN,
  tuiVersion = process.env.DSCODE_DOCTOR_TUI_VERSION,
  optional = true,
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
    findings.push(...profileBundleFindings({ runtime, profile }))
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
