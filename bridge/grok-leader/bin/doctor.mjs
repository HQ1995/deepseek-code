// Read-only installation checks, shared by /doctor and the pre-startup CLI.
import { spawnSync } from 'node:child_process'
import { accessSync, constants, existsSync, readFileSync, realpathSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateRuntime } from './update.mjs'

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
  const value = /(?:^|\s)(\d+\.\d+\.\d+(?:-[\w.-]+)?)(?:\s|$)/.exec(result.stdout)?.[1]
  if (!value) throw new Error(`Invalid version from ${bin}`)
  return value
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
  add('INFO', 'Bridge', `${pkg.version} · ${dir}`)
  check('Installed bridge', () => {
    const installed = json(join(profile, 'node_modules', ...pkg.name.split('/'), 'package.json'))
    if (installed.version !== pkg.version || installed.dsh?.testedVersion !== pkg.dsh?.testedVersion || installed.dsh?.sourceCommit !== pkg.dsh?.sourceCommit) throw new Error('Installed bridge differs from the loaded package')
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
        return `${pkg.dsh.sourceCommit} · ${process.platform}/${process.arch} · native artifacts verified`
      }, repair)
    }
  }
  if (optional) {
    const missing = ['typescript-language-server', 'tsc'].filter(command => !executable(command))
    add(missing.length ? 'INFO' : 'OK', 'Shipped LSP preset', missing.length
      ? `Optional dependencies missing: ${missing.join(', ')}. Install typescript-language-server and typescript on PATH before selecting /preset lsp; e.g. npm install -g typescript-language-server typescript. Standard works without them.`
      : 'typescript-language-server and tsc found on PATH; servers start on the first LSP query.')
    add(executable('/bin/bash') ? 'OK' : 'INFO', 'Shipped terminal preset', executable('/bin/bash')
      ? '/bin/bash is executable. /doctor in a session also checks the registered PTY backend.'
      : 'Optional shell /bin/bash is missing. Install bash or configure terminal-bash.shellPath in the profile.')
  }
  return findings
}
export const formatInstallationReport = findings => ['Dscode runtime diagnostics', ...findings.map(f => `[${f.status}] ${f.name}: ${f.detail}`)].join('\n\n')

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const findings = installationReport({ optional: !process.argv.includes('--runtime-only') })
  console.log(process.argv.includes('--json') ? JSON.stringify(findings) : formatInstallationReport(findings))
}
