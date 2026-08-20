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
// profile, installs the official dsh CLI with `npm i -g` if `dsh` is not
// on PATH, materializes the matching TUI binary from GitHub Releases, and
// links `dscode` into ~/.local/bin; afterwards plain `dscode` is the command.
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
import { dirname, join } from 'node:path'
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
const profileLauncher = join(profileDir, 'node_modules', ...pkg.name.split('/'), 'bin', 'dscode.mjs')

/** The exact dsh version this release was tested against. */
const dshTestedVersion = pkg.dsh?.testedVersion

/** POSIX `command -v`: the shell's PATH lookup, not a handwritten split. */
const commandV = (name) => {
  const probe = spawnSync('/bin/sh', ['-c', 'command -v -- "$1"', 'sh', name], {
    encoding: 'utf8',
  })
  const path = typeof probe.stdout === 'string' ? probe.stdout.trim() : ''
  return probe.status === 0 && path !== '' ? path : undefined
}

const npmInstallDsh = (spec, extraArgs = []) => {
  const argv = ['install', '-g', spec, '--no-audit', '--no-fund', ...extraArgs]
  console.error(`dscode: first run — npm ${argv.join(' ')}`)
  const result = spawnSync('npm', argv, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 600000,
  })
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`dsh install timed out; run manually: npm ${argv.join(' ')}`)
  }
  return result.status === 0
}

/** Official dsh on PATH, else `npm i -g`. If /usr/local is not writable,
 *  install into ~/.local (same prefix as the dscode symlink). */
export const ensureDshCli = () => {
  const envBin = process.env.DSH_BIN
  if (envBin !== undefined && envBin !== '' && existsSync(envBin)) return envBin

  const existing = commandV('dsh')
  if (existing !== undefined) return existing

  const spec = dshTestedVersion ? `@deepseek-ai/dsh@${dshTestedVersion}` : '@deepseek-ai/dsh'
  const userPrefix = join(homedir(), '.local')
  const userBin = join(userPrefix, 'bin', 'dsh')
  if (!npmInstallDsh(spec) || commandV('dsh') === undefined) {
    if (!npmInstallDsh(spec, ['--prefix', userPrefix]) || !existsSync(userBin)) {
      throw new Error(`dsh install failed; run: npm install -g ${spec}`)
    }
  }
  const installed = commandV('dsh') ?? (existsSync(userBin) ? userBin : undefined)
  if (installed === undefined) {
    throw new Error(`dsh installed but not on PATH; add ${join(homedir(), '.local', 'bin')} to PATH`)
  }
  return installed
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

const spawnTui = (bin, env) => {
  const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit', env })
  child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : code ?? 1))
}

const PROFILE_PATCH_TEMPLATE = `# Your patch layer for this dsh profile, applied after every bundle layer:
# a top-level YAML array of loader patch entries (id-targeted config
# overrides, disables, and insert lists; \`!!js\` expressions allowed).
[]
`

/** First run: register this plugin into the dscode dsh profile without
 *  requiring the dsh CLI or pnpm. This mirrors what `dsh plugin add` does,
 *  but uses npm with --legacy-peer-deps so the dsh-provided peer packages
 *  are not downloaded again. */
export const ensureProfilePlugin = () => {
  const pluginDir = join(profileDir, 'node_modules', ...pkg.name.split('/'))
  if (existsSync(join(pluginDir, 'package.json'))) return

  mkdirSync(profileDir, { recursive: true })

  const manifestPath = join(profileDir, 'package.json')
  if (!existsSync(manifestPath)) {
    writeFileSync(manifestPath, JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }, null, 2) + '\n')
  }

  const patchPath = join(profileDir, 'cordis.patch.yml')
  if (!existsSync(patchPath)) writeFileSync(patchPath, PROFILE_PATCH_TEMPLATE)

  const spec = `${pkg.name}@${pkg.version}`
  console.error(`dscode: first run — installing ${spec} into the ${PROFILE_NAME} dsh profile...`)
  const argv = ['install', '--prefix', profileDir, spec, '--no-audit', '--no-fund', '--legacy-peer-deps']
  if (process.env.DSCODE_DEBUG !== undefined) console.error(`dscode: running: npm ${argv.join(' ')}`)
  const result = spawnSync('npm', argv, {
    stdio: ['ignore', 'inherit', 'inherit'],
    timeout: 120000,
  })
  if (result.error?.code === 'ETIMEDOUT') {
    throw new Error(`plugin install timed out; run manually: npm ${argv.join(' ')}`)
  }
  if (result.status !== 0 || !existsSync(join(pluginDir, 'package.json'))) {
    throw new Error(`plugin install failed; run manually: npm ${argv.join(' ')}`)
  }

  // Reconcile the profile manifest: add this plugin as a bundle layer.
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base']
  if (!bundles.includes(pkg.name)) bundles.push(pkg.name)
  manifest.dsh = {
    ...manifest.dsh,
    profile: { ...manifest.dsh?.profile, bundles },
  }
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + '\n')
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
      console.error('dscode: warning: no .sha256 asset published for this release; skipping verification')
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

const main = async () => {
  if (process.env.DSCODE_BIN === undefined || process.env.DSCODE_BIN === '') {
    ensureProfilePlugin()
    healLauncherLink()
    migrateLegacyTuiHome()
  }
  const dshBin = ensureDshCli()
  const localBin = join(homedir(), '.local', 'bin')
  const path = process.env.PATH ?? ''
  const env = {
    ...process.env,
    PATH: path.split(':').includes(localBin) ? path : `${localBin}:${path}`,
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
