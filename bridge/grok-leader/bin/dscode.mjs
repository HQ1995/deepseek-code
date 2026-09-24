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
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { installationReport, formatInstallationReport } from './doctor.mjs'
import { healLauncherLink as repairLauncherLink, readJsonFile } from './launcher-files.mjs'
import { atomicWrite, compareVersions, downloadVerified, parseCliVersion, installationFilesMatch, installationMatches, installRelease, needsUpdateWithChannel, resolveRelease, saveUpdateChannel, unsupportedPlatformMessage, updateOptions, validateRuntime, withProfileLock } from './update.mjs'

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
export const profileDir = process.env.DSCODE_HOME ?? join(dshHome, 'profiles', PROFILE_NAME)
/** DSCODE_HOME defaults to the profile dsh already owns. */
export const tuiHome = profileDir
const binDir = join(profileDir, 'bin')
const binPath = join(binDir, 'dscode')
export const profileLauncher = join(profileDir, 'node_modules', ...pkg.name.split('/'), 'bin', 'dscode.mjs')
const runtimeDir = join(profileDir, 'runtime')
export const dshRuntimeBin = join(runtimeDir, 'bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')

/** The exact dsh version this release was tested against. */
const dshTestedVersion = pkg.dsh?.testedVersion

/** Effective floor of the pinned dsh dependency tree (pi-ai 0.84.2). */
export const nodeVersionSupported = (version) => {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(version)
  if (match === null) return false
  const actual = match.slice(1, 4).map(Number)
  const minimum = [22, 19, 0]
  for (let index = 0; index < minimum.length; index += 1) {
    if (actual[index] !== minimum[index]) return actual[index] > minimum[index]
  }
  return true
}

export { parseCliVersion } from './update.mjs'

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

const runInstaller = (argv) => new Promise((resolveRun, rejectRun) => {
  const child = spawn('npm', argv, { stdio: ['ignore', 2, 2] })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, 600000)
  child.once('error', (error) => {
    clearTimeout(timer)
    rejectRun(error)
  })
  child.once('exit', (code, signal) => {
    clearTimeout(timer)
    if (timedOut) rejectRun(new Error('timed out'))
    else if (code === 0) resolveRun()
    else rejectRun(new Error(signal === null ? `exited with status ${code ?? 1}` : `terminated by ${signal}`))
  })
})

const installOwnedDsh = async (spec) => {
  rmSync(runtimeDir, { recursive: true, force: true })
  mkdirSync(runtimeDir, { recursive: true })
  // npm's normal project layout spends minutes resolving dsh's large peer
  // graph. Global layout under a private custom prefix resolves the same
  // complete runtime quickly without touching npm's real global prefix.
  const argv = ['install', '--global', '--prefix', runtimeDir, spec, '--omit=dev', '--no-audit', '--no-fund']
  console.error(`dscode: installing the tested dsh runtime — npm ${argv.join(' ')}`)
  try {
    await runInstaller(argv)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`dsh install failed (${message}); run manually: npm ${argv.join(' ')}; or set DSH_BIN to a source-built dsh executable reporting ${dshTestedVersion}`)
  }
}

/** Use an explicit override, a tested dsh on PATH, or the profile-owned pin. */
export const ensureDshCli = async () => {
  if (typeof dshTestedVersion !== 'string' || dshTestedVersion.trim() === '') {
    throw new Error('missing dsh.testedVersion in the launcher package; refusing to install an unpinned dsh runtime')
  }
  const envBin = process.env.DSH_BIN
  if (envBin !== undefined && envBin !== '') {
    const version = cliVersion(envBin)
    if (version !== dshTestedVersion) {
      throw new Error(`DSH_BIN reports ${version ?? 'no version'}, expected ${dshTestedVersion}; set DSH_BIN to a source-built dsh executable reporting ${dshTestedVersion}`)
    }
    return envBin
  }

  if (pkg.dsh?.sourceCommit) {
    if (!existsSync(dshRuntimeBin)) throw new Error(`source runtime missing; run dscode update --version ${pinnedRelease() ?? pkg.version}`)
    validateRuntime(runtimeDir, pkg)
    return dshRuntimeBin
  }
  const existing = commandV('dsh')
  if (existing !== undefined && cliVersion(existing) === dshTestedVersion) return existing

  const spec = `@deepseek-ai/dsh@${dshTestedVersion}`
  if (cliVersion(dshRuntimeBin) !== dshTestedVersion) await installOwnedDsh(spec)
  const installedVersion = cliVersion(dshRuntimeBin)
  if (installedVersion !== dshTestedVersion) {
    throw new Error(`dsh runtime reports ${installedVersion ?? 'no version'}, expected ${dshTestedVersion}`)
  }
  return dshRuntimeBin
}

/** Pull an old TUI home (sibling ~/.dsh/dsc-tui, or profile/tui/) into the profile. */
export const migrateLegacyTuiHome = (home = dshHome, profile = profileDir) => {
  mkdirSync(profile, { recursive: true })
  const destRoot = realpathSync(profile)
  const merge = (from, to) => {
    for (const name of readdirSync(from)) {
      const src = join(from, name)
      const dest = join(to, name)
      const existing = lstatSync(dest, { throwIfNoEntry: false })
      if (!existing) renameSync(src, dest)
      else if (existing.isDirectory() && lstatSync(src).isDirectory()) merge(src, dest)
    }
    if (readdirSync(from).length === 0) rmdirSync(from)
  }
  for (const from of [join(home, 'dsc-tui'), join(profile, 'tui')]) {
    if (!lstatSync(from, { throwIfNoEntry: false })?.isDirectory()) continue
    const source = realpathSync(from)
    if (destRoot === source || destRoot.startsWith(source + '/')) continue
    merge(from, profile)
    if (existsSync(from)) console.error(`dscode: kept conflicting legacy files in ${from}; review them before removing that directory`)
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
  if (bundles.includes(pkg.name)) return
  bundles.push(pkg.name)
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles },
  }
  atomicWrite(profileManifestPath, JSON.stringify(manifest, null, 2) + '\n')
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
  const installedDsh = readJsonFile(pluginManifestPath)?.dsh
  const baselineChanged = installedDsh?.testedVersion !== dshTestedVersion
    || installedDsh?.supportedRange !== pkg.dsh?.supportedRange
  if (!force && !packageNeedsInstall(before, pkg.version) && !baselineChanged) {
    reconcileProfileManifest()
    return { changed: false, version: before }
  }

  console.error(`dscode: ${before === undefined ? 'installing' : `upgrading ${pkg.name} ${before}`} → ${spec} in the ${PROFILE_NAME} profile...`)
  // npm otherwise treats the same product version as already installed.
  if (baselineChanged) rmSync(pluginDir, { recursive: true, force: true })
  const argv = ['install', '--prefix', profileDir, spec, '--no-audit', '--no-fund', '--legacy-peer-deps']
  if (process.env.DSCODE_DEBUG !== undefined) console.error(`dscode: running: npm ${argv.join(' ')}`)
  const result = spawnSync('npm', argv, {
    stdio: ['ignore', 2, 2],
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
  const resolvedDsh = readJsonFile(pluginManifestPath)?.dsh
  if (expectedVersion === pkg.version && (resolvedDsh?.testedVersion !== dshTestedVersion
    || resolvedDsh?.supportedRange !== pkg.dsh?.supportedRange)) {
    throw new Error(`plugin install resolved an incompatible dsh baseline; expected ${dshTestedVersion}`)
  }

  reconcileProfileManifest()
  return { changed: force || baselineChanged || before !== installedVersion, version: installedVersion }
}

/** Pinned release for this package build: X.Y.Z, no leading v. */
const pinnedRelease = () => {
  const release = pkg.dscode?.release
  if (typeof release === 'string' && /^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/.test(release)) return release
  return undefined
}


/** The cached binary's actual version ("0.0.5" / "0.0.5-dev"), or undefined. */
const cachedVersion = () => {
  if (!existsSync(binPath)) return undefined
  const probe = spawnSync(binPath, ['--version'], { encoding: 'utf8', timeout: 15000 })
  if (probe.status !== 0 || typeof probe.stdout !== 'string') return undefined
  // "dscode 0.0.5-dev (abc123) [stable]"
  return parseCliVersion(probe.stdout)
}

const installBinary = async (release, asset) => {
  mkdirSync(binDir, { recursive: true })
  const base = `https://github.com/${RELEASE_REPO}/releases/download/v${release}`
  const tmp = `${binPath}.download-${process.pid}`
  try {
    await downloadVerified(base, asset, tmp, fetch, true)
    chmodSync(tmp, 0o755)
    renameSync(tmp, binPath)
  } catch (error) {
    rmSync(tmp, { force: true })
    throw error
  }
}

export const healLauncherLink = (options = {}) => repairLauncherLink({ profile: profileDir, packageName: pkg.name, sourceBin: here, ...options })

export const ownedLauncherTarget = target => [profileLauncher, join(profileDir, 'dscode.mjs')].some(path => resolve(target) === resolve(path))

const profileIsOwned = () => {
  const installed = readJsonFile(pluginManifestPath)
  if (installed?.name === pkg.name) return true
  const manifest = readJsonFile(profileManifestPath)
  if (manifest?.name === `dsh-profile-${PROFILE_NAME}` && manifest.private === true) return true
  const bundles = manifest?.dsh?.profile?.bundles
  return Array.isArray(bundles) && bundles.includes(pkg.name)
}

/** Remove product executables; retain all profile and shared user data. */
export const uninstallInstallation = async (args = []) => {
  if (args.some(arg => arg !== '--remove-dsh')) throw new Error('Usage: dscode uninstall [--remove-dsh]')
  return withProfileLock(profileDir, async () => {
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
    const manifest = readJsonFile(profileManifestPath)
    if (manifest) {
      delete manifest.dependencies?.[pkg.name]
      const bundles = manifest.dsh?.profile?.bundles
      if (Array.isArray(bundles)) manifest.dsh.profile.bundles = bundles.filter(name => name !== pkg.name)
      atomicWrite(profileManifestPath, JSON.stringify(manifest, null, 2) + '\n')
    }
    for (const path of [dirname(dirname(profileLauncher)), runtimeDir, binPath, join(profileDir, 'dscode.mjs')]) rmSync(path, { recursive: true, force: true })
    console.error(`dscode: removed product binaries; kept sessions, settings and other user data in ${profileDir}`)
  }
  console.error(`dscode: kept shared state under ${dshHome}`)
  if (args.includes('--remove-dsh')) {
    await runInstaller(['uninstall', '--global', '@deepseek-ai/dsh'])
    console.error('dscode: removed the global @deepseek-ai/dsh package')
  }
  })
}


export const ensureBinary = async () => {
  const asset = assetName()
  if (asset === undefined) {
    throw new Error(unsupportedPlatformMessage())
  }
  const pinned = pinnedRelease()
  const current = cachedVersion()
  if (current !== undefined) {
    // -dev builds are developer-managed (same rule as the TUI's updater):
    // never replace one automatically.
    if (current.includes('-dev')) return binPath
    if (pinned === undefined) return binPath
    if (current === pinned || compareVersions(current, pinned) > 0) return binPath
  } else if (pinned === undefined) {
    throw new Error('no cached TUI binary and this package carries no release pin; reinstall from a release tarball')
  }
  await installBinary(pinned, asset)
  return binPath
}


export const updateCommandIndex = (args) => {
  let index = 0
  while (args[index] === '--debug') index += 1
  return args[index] === 'update' ? index : -1
}


export const main = async () => {
  const args = process.argv.slice(2)
  // Diagnostics must work even when provisioning/tuple validation would fail.
  if (args[0] === 'doctor' && args.includes('--runtime')) {
    if (args.some(arg => !['doctor', '--runtime', '--json'].includes(arg))) throw new Error('Usage: dscode doctor --runtime [--json]')
    const findings = installationReport({ profile: profileDir, remote: true })
    console.log(args.includes('--json') ? JSON.stringify(findings) : formatInstallationReport(findings))
    process.exitCode = findings.some(finding => finding.status === 'ERROR') ? 1 : 0
    return
  }
  const updateIndex = updateCommandIndex(args)
  if (updateIndex === -1 && args[0] !== 'remote' && (args.includes('--help') || args.includes('-h'))) {
    if (existsSync(binPath)) spawnAndExit(binPath, args, process.env)
    else console.log('Usage: dscode [OPTIONS] [PROMPT]\n       dscode update [--stable | --beta | --alpha] [--version VERSION] [--check] [--json] [--force-reinstall]\n       dscode remote init|status|remove\n       dscode uninstall')
    return
  }
  if (updateIndex !== -1) {
    const updateArgs = args.slice(updateIndex + 1)
    if (updateArgs.includes('--help') || updateArgs.includes('-h')) {
      console.log('Usage: dscode update [--stable | --beta | --alpha | --enterprise] [--version VERSION] [--check] [--json] [--force | --force-reinstall]')
      return
    }
    const options = updateOptions(updateArgs, profileDir, pkg.version)
    if (options.problem !== undefined) console.error(`dscode: warning: ${options.problem}; updating the ${options.channel} channel and leaving the file as it is`)
    if (options.channel !== 'enterprise') {
      const current = cachedVersion() ?? installedProfileVersion() ?? pkg.version
      if (options.check) {
        const result = { currentVersion: current, latestVersion: null, updateAvailable: false, installer: 'dscode', channel: options.channel, autoUpdate: options.autoUpdate, error: null }
        try {
          result.latestVersion = await resolveRelease(options)
          result.updateAvailable = options.version !== undefined
            ? compareVersions(result.latestVersion, current) !== 0
            : needsUpdateWithChannel(current, result.latestVersion, options.channel)
        } catch (error) {
          result.error = error instanceof Error ? error.message : String(error)
        }
        if (options.json) console.log(JSON.stringify(result))
        else if (result.error) console.error(`dscode: update check failed: ${result.error}`)
        else console.log(`dscode ${current} [${options.channel}]: ${result.updateAvailable ? `update available: ${result.latestVersion}` : `latest release: ${result.latestVersion}`}`)
        return
      }
      if (options.trigger === 'auto_background' && (options.autoUpdate === false || current.includes('-dev'))) return
      let version = await resolveRelease(options)
      const available = current.includes('-dev') || (options.version !== undefined && options.trigger !== 'auto_background'
        ? compareVersions(version, current) !== 0
        : needsUpdateWithChannel(current, version, options.channel))
      if (!options.force && !available && installationMatches(profileDir, pkg.name, current)) {
        await saveUpdateChannel(profileDir, options.channel)
        console.log(`dscode ${current} [${options.channel}]: already up to date`)
        return
      }
      if (!options.force && !available && (options.version === undefined || options.trigger === 'auto_background')) version = current
      if (!nodeVersionSupported(process.versions.node)) throw new Error('dscode requires node >=22.19.0')
      await installRelease({ profile: profileDir, packageName: pkg.name, version, channel: options.channel, asset: assetName() })
      healLauncherLink()
      console.log(`dscode updated to ${version} [${options.channel}]`)
      return
    }
    // Enterprise remains on its existing TUI updater; checks cannot provision anything.
    if (options.check) {
      if (!existsSync(binPath)) throw new Error('enterprise check requires an installed TUI')
      spawnAndExit(binPath, args, process.env)
      return
    }
  }
  if (process.argv[2] === 'uninstall') {
    await uninstallInstallation(args.slice(1))
    return
  }
  if (args[0] === 'remote') {
    const { remoteCommand } = await import('./remote.mjs')
    const { localHelpers } = await import('./remote-check.mjs')
    // Only an explicitly chosen home may become remote; ~/.dsh keeps local workspaces.
    const defaultProfile = join(homedir(), '.dsh', 'profiles', PROFILE_NAME)
    await remoteCommand(args.slice(1), {
      profileDir, dedicatedHome: resolve(profileDir) !== resolve(defaultProfile),
      local: localHelpers(process.env.DSH_BIN || dshRuntimeBin),
      withLock: async action => {
        try { return await withProfileLock(profileDir, action) } catch (error) {
          // Without an installed runtime no leader can run in this home, so
          // nothing else writes its patch: a first-time init needs no lock.
          if (error?.code !== 'DSCODE_PROFILE_LOCK_UNAVAILABLE') throw error
          return await action()
        }
      },
      scaffold: scaffoldProfile, write: atomicWrite, log: message => console.log(message),
    })
    return
  }
  if (!nodeVersionSupported(process.versions.node)) {
    throw new Error(`the pinned dsh runtime requires node >=22.19.0; found ${process.versions.node}. dscode will not install or switch node for you`)
  }
  const managedRelease = !process.env.DSCODE_BIN && pkg.dsh?.sourceCommit && pinnedRelease()
  const rebootstrapManaged = async () => {
    const options = updateOptions([], profileDir, pkg.version)
    await installRelease({ profile: profileDir, packageName: pkg.name, version: managedRelease, channel: options.channel, asset: assetName() })
    healLauncherLink()
    spawnAndExit(profileLauncher, args, process.env)
  }
  if (managedRelease && !installationFilesMatch(profileDir, pkg.name, managedRelease, pkg.dsh)) {
    await rebootstrapManaged()
    return
  }
  const prepared = await withProfileLock(profileDir, async () => {
    // Check actual versions once, under the same lock as profile preparation.
    // Repair must happen after unlocking: installRelease acquires its own lock.
    const tuiVersion = managedRelease ? cachedVersion() : undefined
    const managed = managedRelease && !tuiVersion?.includes('-dev')
    if (managed && !installationMatches(profileDir, pkg.name, managedRelease, pkg.dsh, tuiVersion)) return undefined
    if (!process.env.DSCODE_BIN) {
      // Published source-backed installs are reconciled as one transaction above.
      // Keep the npm bootstrap only for unpinned development/legacy packages.
      if (!managed) ensureProfilePlugin()
      else { scaffoldProfile(); reconcileProfileManifest() }
      healLauncherLink()
      migrateLegacyTuiHome()
    }
    return await Promise.all([
      managed && !process.env.DSH_BIN ? Promise.resolve(dshRuntimeBin) : ensureDshCli(),
      managed ? Promise.resolve(binPath) : process.env.DSCODE_BIN ? Promise.resolve(process.env.DSCODE_BIN) : ensureBinary(),
    ])
  }).catch(error => {
    // A present but corrupt native addon passes the file-only preflight.
    // A validated replacement runtime supplies the lock during rebootstrap.
    if (managedRelease && error?.code === 'DSCODE_PROFILE_LOCK_UNAVAILABLE') return undefined
    throw error
  })
  if (prepared === undefined) {
    await rebootstrapManaged()
    return
  }
  const [dshBin, bin] = prepared
  const localBin = join(homedir(), '.local', 'bin')
  const path = process.env.PATH ?? ''
  const pathParts = path.split(delimiter)
  const extraBins = [dirname(dshBin), localBin].filter(dir => !pathParts.includes(dir))
  const env = {
    ...process.env,
    PATH: [...extraBins, ...pathParts].join(delimiter),
    DSCODE_MANAGED_LAUNCHER: '1',

    DSH_BIN: dshBin,
    DSCODE_HOME: tuiHome,
    DSH_PROFILE_DIR: profileDir,
  }
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
