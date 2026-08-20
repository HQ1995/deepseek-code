#!/usr/bin/env node
// dscode launcher — the plugin-native install path.
//
// This package IS the dscode dsh plugin: the grok-leader bridge (loaded by
// the dsh profile) plus this launcher. The launcher self-installs, so the
// whole install is one command:
//
//   npx @hqzhao95/dscode
//
// On first run it registers this plugin into the dscode dsh
// profile, provisions the tested dsh CLI inside that profile when no compatible
// CLI is on PATH, materializes the matching TUI binary from GitHub Releases,
// and links `dscode` into ~/.local/bin; afterwards plain `dscode` is the command.
// The profile name is an internal detail the user never types. The TUI
// must not be left to `npx` the leader after it has entered the alt screen.
//
// TUI binary + grok-home state live in the dscode profile directory
// itself (`~/.dsh/profiles/dscode`), the same place dsh already gives the
// plugin. Not node_modules (reinstalls wipe it), not a sibling ~/.dsh/dsc-tui,
// and not an extra tui/ folder inside the profile.
//
// Version policy mirrors the Rust updater's dev guard: the pinned release
// comes from package.json `dscode.release` (stamped by scripts/release.sh);
// the cached binary's REAL version is read from `dscode --version` (no
// marker files to drift). Older cache → download the pin; newer or -dev
// cache → left alone (developer-managed).
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

const RELEASE_REPO = 'HQ1995/deepseek-code'
const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8'))

const fail = (message) => {
  console.error(`dscode: ${message}`)
  process.exit(1)
}

// Supported prebuilts: Linux x86_64 and macOS Apple Silicon (Intel macs
// and other arches build from a checkout). Keys are node
// `${process.platform}-${process.arch}`.
export const TUI_ASSETS = {
  'linux-x64': 'dscode-linux-x86_64',
  'darwin-arm64': 'dscode-macos-aarch64',
}
export const tuiAssetName = (platform, arch) => TUI_ASSETS[`${platform}-${arch}`]
const assetName = () => tuiAssetName(process.platform, process.arch)

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
// The dsh profile the TUI spawns its leader with (xai-grok-pager
// dsh_leader.rs hardcodes the same name) — internal, never user-typed.
const PROFILE_NAME = 'dscode'
export const profileDir = join(dshHome, 'profiles', PROFILE_NAME)
/** DSCODE_HOME defaults to the profile dsh already owns. */
export const tuiHome = profileDir
const binDir = join(profileDir, 'bin')
const binPath = join(binDir, 'dscode')
export const profileLauncher = join(profileDir, 'node_modules', ...pkg.name.split('/'), 'bin', 'dscode.mjs')
const runtimeDir = join(profileDir, 'runtime')
export const dshRuntimeBin = join(runtimeDir, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')

/** The exact dsh version this release was tested against. */
const dshTestedVersion = pkg.dsh?.testedVersion

export const nodeVersionSupported = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const major = Number(match[1])
  const minor = Number(match[2])
  return (major === 22 && minor >= 19) || major >= 24
}

export const parseCliVersion = (output) =>
  /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1]

/** POSIX `command -v`: the shell's PATH lookup, not a handwritten split. */
const commandV = (name) => {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', name], {
    encoding: 'utf8',
  })
  const path = typeof probe.stdout === 'string' ? probe.stdout.trim() : ''
  return probe.status === 0 && path !== '' ? path : undefined
}

const cliVersion = (binary) => {
  if (!existsSync(binary)) return undefined
  const probe = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 15000 })
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined
  return parseCliVersion(probe.stdout.trim())
}

const installOwnedDsh = (spec) => {
  mkdirSync(runtimeDir, { recursive: true })
  const argv = ['install', '--prefix', runtimeDir, spec, '--omit=dev', '--no-audit', '--no-fund']
  console.error(`dscode: installing the tested dsh runtime — npm ${argv.join(' ')}`)
  const result = spawnSync('npm', argv, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 600000,
  })
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`dsh install timed out; run manually: npm ${argv.join(' ')}`)
  }
  if (result.status !== 0) {
    throw new Error(`dsh install failed; run manually: npm ${argv.join(' ')}`)
  }
}

/** Use an explicit override, a tested dsh on PATH, or the profile-owned pin. */
export const ensureDshCli = () => {
  const envBin = process.env.DSH_BIN
  if (envBin !== undefined && envBin !== '' && existsSync(envBin)) return envBin

  const existing = commandV('dsh')
  if (existing !== undefined && cliVersion(existing) === dshTestedVersion) return existing

  const spec = dshTestedVersion ? `@deepseek-ai/dsh@${dshTestedVersion}` : '@deepseek-ai/dsh'
  if (cliVersion(dshRuntimeBin) !== dshTestedVersion) installOwnedDsh(spec)
  const installedVersion = cliVersion(dshRuntimeBin)
  if (installedVersion !== dshTestedVersion) {
    throw new Error(`dsh runtime reports ${installedVersion ?? 'no version'}, expected ${dshTestedVersion}`)
  }
  return dshRuntimeBin
}

/** Pull an old TUI home (sibling ~/.dsh/dsc-tui, or profile/tui/) into the profile. */
export const migrateLegacyTuiHome = () => {
  mkdirSync(profileDir, { recursive: true })
  const destRoot = realpathSync(profileDir)
  for (const from of [join(dshHome, 'dsc-tui'), join(profileDir, 'tui')]) {
    if (!existsSync(from) || realpathSync(from) === destRoot) continue
    for (const name of readdirSync(from)) {
      const src = join(from, name)
      const dest = join(profileDir, name)
      if (!existsSync(dest)) renameSync(src, dest)
    }
    rmSync(from, { recursive: true, force: true })
  }
}

const spawnAndExit = (bin, args, env) => {
  const child = spawn(bin, args, { stdio: 'inherit', env })
  child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : code ?? 1))
}

const spawnTui = (bin, env) => spawnAndExit(bin, process.argv.slice(2), env)

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

const pluginDir = join(profileDir, 'node_modules', ...pkg.name.split('/'))
const pluginManifestPath = join(pluginDir, 'package.json')
const profileManifestPath = join(profileDir, 'package.json')

const readJsonFile = (path) => {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}

export const packageNeedsInstall = (installedVersion, desiredVersion) =>
  installedVersion !== desiredVersion

const installedProfileVersion = () => {
  const installed = readJsonFile(pluginManifestPath)
  return typeof installed?.version === 'string' ? installed.version : undefined
}

const scaffoldProfile = () => {
  mkdirSync(profileDir, { recursive: true })
  if (!existsSync(profileManifestPath)) {
    writeFileSync(profileManifestPath, JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n')
  }
  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)
}

const reconcileProfileManifest = () => {
  const manifest = readJsonFile(profileManifestPath)
  if (manifest === undefined) throw new Error(`invalid profile manifest: ${profileManifestPath}`)
  const bundles = manifest.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base']
  if (!bundles.includes(pkg.name)) bundles.push(pkg.name)
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles },
  }
  writeFileSync(profileManifestPath, JSON.stringify(manifest, null, 2) + '\n')
}

/** First run: register this plugin into the dscode dsh profile without
 *  requiring the dsh CLI or pnpm. This mirrors what `dsh plugin add` does,
 *  but uses npm with --legacy-peer-deps so the dsh-provided peer packages
 *  are not downloaded again. */
export const ensureProfilePlugin = ({
  spec = `${pkg.name}@${pkg.version}`,
  expectedVersion = pkg.version,
  force = false,
} = {}) => {
  scaffoldProfile()
  const before = installedProfileVersion()
  if (!force && !packageNeedsInstall(before, pkg.version)) {
    reconcileProfileManifest()
    return { changed: false, version: before }
  }

  console.error(`dscode: ${before === undefined ? 'installing' : `upgrading ${pkg.name} ${before}`} → ${spec} in the ${PROFILE_NAME} profile...`)
  const argv = ['install', '--prefix', profileDir, spec, '--no-audit', '--no-fund', '--legacy-peer-deps']
  if (process.env.DSCODE_DEBUG !== undefined) console.error(`dscode: running: npm ${argv.join(' ')}`)
  const result = spawnSync('npm', argv, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120000,
  })
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`plugin install timed out; run manually: npm ${argv.join(' ')}`)
  }
  const installedVersion = installedProfileVersion()
  if (result.status !== 0 || installedVersion === undefined) {
    throw new Error(`plugin install failed; run manually: npm ${argv.join(' ')}`)
  }
  if (expectedVersion !== null && installedVersion !== expectedVersion) {
    throw new Error(`plugin install resolved ${installedVersion}, expected ${expectedVersion}`)
  }

  reconcileProfileManifest()
  return { changed: before !== installedVersion, version: installedVersion }
}

/** Pinned release for this package build: X.Y.Z, no leading v. */
const pinnedRelease = () => {
  const release = pkg.dscode?.release
  if (typeof release === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(release)) return release
  return undefined
}

const versionTriple = (version) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version)
  return m === null ? undefined : [Number(m[1]), Number(m[2]), Number(m[3])]
}

const tripleLess = (a, b) => {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i]
  }
  return false
}

/** The cached binary's actual version ("0.0.5" / "0.0.5-dev"), or undefined. */
const cachedVersion = () => {
  if (!existsSync(binPath)) return undefined
  const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15000 })
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined
  // "dscode 0.0.5-dev (abc123) [stable]"
  return probe.stdout.trim().split(/\s+/)[1]
}

const sha256File = async (path) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

const download = async (url, dest) => {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(120000) })
  if (!res.ok || res.body === null) throw new Error(`${res.status} ${res.statusText} for ${url}`)
  await pipeline(Readable.fromWeb(res.body), createWriteStream(dest))
}

const installBinary = async (release, asset) => {
  mkdirSync(binDir, { recursive: true })
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${release}`
  const tmp = `${binPath}.download-${process.pid}`
  console.error(`dscode: downloading v${release} (${asset}) from GitHub Releases...`)
  try {
    await download(`${base}/${asset}`, tmp)
    const shaRes = await fetch(`${base}/${asset}.sha256`, { redirect: 'follow' })
    if (shaRes.ok) {
      const expected = (await shaRes.text()).trim().split(/\s+/)[0]
      const actual = await sha256File(tmp)
      if (expected !== actual) throw new Error(`SHA-256 mismatch (got ${actual}, want ${expected})`)
    } else {
      throw new Error(`release v${release} has no ${asset}.sha256 asset`)
    }
    chmodSync(tmp, 0o755)
    renameSync(tmp, binPath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

/** Point ~/.local/bin/dscode at the profile install's launcher (the stable
 *  copy — an npx temp-store copy of this file may be garbage-collected), or
 *  at this file when the profile copy is absent. Polite: create the link
 *  when missing, retarget only a symlink that points at a plugin launcher
 *  (a node_modules .../bin/dscode.mjs). A repo dev symlink
 *  (target/release/dscode) or anything user-made is left alone. */
export const healLauncherLink = () => {
  try {
    const linkDir = join(homedir(), '.local', 'bin')
    const link = join(linkDir, 'dscode')
    const preferred = existsSync(profileLauncher) ? profileLauncher : join(here, 'dscode.mjs')
    let existing
    try {
      existing = lstatSync(link)
    } catch {
      mkdirSync(linkDir, { recursive: true })
      symlinkSync(preferred, link)
      return
    }
    if (!existing.isSymbolicLink()) return
    const target = readlinkSync(link)
    if (target === preferred) return
    if (!(target.includes('node_modules') && target.endsWith('/bin/dscode.mjs'))) return
    rmSync(link)
    symlinkSync(preferred, link)
  } catch {
    // Best-effort: a broken ~/.local/bin never blocks a launch.
  }
}

export const ownedLauncherTarget = (target) => resolve(target) === resolve(profileLauncher)

const profileIsOwned = () => {
  const installed = readJsonFile(pluginManifestPath)
  if (installed?.name === pkg.name) return true
  const manifest = readJsonFile(profileManifestPath)
  if (manifest?.name === `dsh-profile-${PROFILE_NAME}` && manifest.private === true) return true
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.includes(pkg.name)
}

/** Remove only product-owned state. Shared dsh sessions/storages stay intact. */
export const uninstallInstallation = () => {
  if (existsSync(profileDir) && !profileIsOwned()) {
    throw new Error(`refusing to remove ${profileDir}; it is not an owned dscode profile`)
  }

  const launcher = join(homedir(), '.local', 'bin', 'dscode')
  let launcherStat
  try {
    launcherStat = lstatSync(launcher)
  } catch {
    launcherStat = undefined
  }
  if (launcherStat !== undefined) {
    const stat = launcherStat
    if (stat.isSymbolicLink()) {
      const target = readlinkSync(launcher)
      const absoluteTarget = resolve(dirname(launcher), target)
      if (ownedLauncherTarget(absoluteTarget)) {
        rmSync(launcher)
        console.error(`dscode: removed ${launcher}`)
      } else {
        console.error(`dscode: kept ${launcher}; it points outside this installation`)
      }
    } else {
      console.error(`dscode: kept ${launcher}; it is not a symlink`)
    }
  }

  if (existsSync(profileDir)) {
    rmSync(profileDir, { recursive: true, force: true })
    console.error(`dscode: removed ${profileDir}`)
  }

  const legacyHome = join(dshHome, 'dsc-tui')
  if (existsSync(legacyHome) && !lstatSync(legacyHome).isSymbolicLink()) {
    rmSync(legacyHome, { recursive: true, force: true })
    console.error(`dscode: removed legacy state ${legacyHome}`)
  }
  console.error(`dscode: kept shared state under ${join(dshHome, 'sessions')} and ${join(dshHome, 'storages')}`)
}

export const ensureBinary = async () => {
  const asset = assetName()
  if (asset === undefined) {
    throw new Error(`no prebuilt TUI for ${process.platform}/${process.arch}; build from the repo (scripts/build-deepseek-tui.sh)`)
  }
  const pinned = pinnedRelease()
  const current = cachedVersion()
  if (current !== undefined) {
    // -dev builds are developer-managed (same rule as the TUI's updater):
    // never replace one automatically.
    if (current.includes('-dev')) return binPath
    if (pinned === undefined) return binPath
    const cur = versionTriple(current)
    const want = versionTriple(pinned)
    if (cur !== undefined && want !== undefined && !tripleLess(cur, want)) return binPath
  } else if (pinned === undefined) {
    throw new Error('no cached TUI binary and this package carries no release pin; reinstall from a release tarball')
  }
  await installBinary(pinned, asset)
  return binPath
}

const refreshPackageForUpdate = () => {
  if (process.argv[2] !== 'update' || process.env.DSCODE_PACKAGE_RECONCILED === '1') return false
  const updateRef = packageUpdateRef(process.argv.slice(3))
  const installed = ensureProfilePlugin({
    spec: `${pkg.name}@${updateRef}`,
    expectedVersion: null,
    force: true,
  })
  if (installed.version === pkg.version) return false
  if (!existsSync(profileLauncher)) throw new Error('updated profile launcher is missing')
  spawnAndExit(profileLauncher, process.argv.slice(2), {
    ...process.env,
    DSCODE_PACKAGE_RECONCILED: '1',
  })
  return true
}

export const packageUpdateRef = (args) => {
  const versionIndex = args.indexOf('--version')
  const version = versionIndex === -1 ? undefined : args[versionIndex + 1]
  if (version !== undefined && version !== '') return version
  return args.includes('--beta') ? 'beta' : 'latest'
}

const main = async () => {
  if (process.argv[2] === 'uninstall') {
    uninstallInstallation()
    return
  }
  if (!nodeVersionSupported(process.versions.node)) {
    throw new Error(`node ^22.19.0 or >=24.0.0 is required; found ${process.versions.node}`)
  }
  if (process.env.DSCODE_BIN === undefined || process.env.DSCODE_BIN === '') {
    if (refreshPackageForUpdate()) return
    ensureProfilePlugin()
    healLauncherLink()
    migrateLegacyTuiHome()
  }
  const dshBin = ensureDshCli()
  const localBin = join(homedir(), '.local', 'bin')
  const path = process.env.PATH ?? ''
  const pathParts = path.split(delimiter)
  const extraBins = [dirname(dshBin), localBin].filter(dir => !pathParts.includes(dir))
  const env = {
    ...process.env,
    PATH: [...extraBins, ...pathParts].join(delimiter),
    DSH_BIN: dshBin,
    DSCODE_HOME: tuiHome,
    // 0.0.10 TUI only reads DSC_HOME; drop after that binary is gone.
    DSC_HOME: tuiHome,
    DSH_PROFILE_DIR: profileDir,
  }
  if (process.env.DSCODE_BIN !== undefined && process.env.DSCODE_BIN !== '') {
    spawnTui(process.env.DSCODE_BIN, env)
    return
  }
  const bin = await ensureBinary()
  spawnTui(bin, env)
}

const invokedDirectly = (() => {
  if (process.argv[1] === undefined) return false
  try {
    return fileURLToPath(import.meta.url) === realpathSync(process.argv[1])
  } catch {
    return false
  }
})()
if (invokedDirectly) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)))
}
