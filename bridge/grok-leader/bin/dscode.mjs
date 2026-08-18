#!/usr/bin/env node
// dscode launcher — the plugin-native install path.
//
// This package IS the dscode dsh plugin: the grok-leader bridge (loaded by
// the dsh profile) plus this launcher, which materializes the matching TUI
// binary from GitHub Releases on first run. Installing the plugin is the
// whole install:
//
//   dsh plugin --profile deepseek-leader add \
//     https://github.com/HQ1995/deepseek-code/releases/latest/download/dscode-plugin.tgz
//   ~/.dsh/profiles/deepseek-leader/node_modules/.bin/dscode
//
// The binary lives in the dsc-tui home (~/.dsh/dsc-tui/bin/dscode), NOT in
// the package dir, so profile reinstalls never re-download 200MB — and the
// TUI's own updater (`dscode update` writes to canonicalize(current_exe))
// lands in the same file, keeping one source of truth.
//
// Version policy mirrors the Rust updater's dev guard: the pinned release
// comes from package.json `dscode.release` (stamped by scripts/release.sh);
// the cached binary's REAL version is read from `dscode --version` (no
// marker files to drift). Older cache → download the pin; newer or -dev
// cache → left alone (developer-managed).
import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync } from 'node:fs'
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

const assetName = () => {
  if (process.platform === 'linux' && process.arch === 'x64') return 'dscode-linux-x86_64'
  return undefined
}

const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
const binDir = join(dshHome, 'dsc-tui', 'bin')
const binPath = join(binDir, 'dscode')

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
  const res = await fetch(url, { redirect: 'follow' })
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

/** Point ~/.local/bin/dscode at this launcher. Polite: create it when
 *  missing, retarget only a symlink that points at a PREVIOUS plugin
 *  install's launcher (a node_modules .../bin/dscode.mjs). A repo dev
 *  symlink (target/release/dscode) or anything user-made is left alone. */
export const healLauncherLink = () => {
  try {
    const linkDir = join(homedir(), '.local', 'bin')
    const link = join(linkDir, 'dscode')
    const self = join(here, 'dscode.mjs')
    let existing
    try {
      existing = lstatSync(link)
    } catch {
      mkdirSync(linkDir, { recursive: true })
      symlinkSync(self, link)
      return
    }
    if (!existing.isSymbolicLink()) return
    const target = readlinkSync(link)
    if (target === self) return
    if (!(target.includes('node_modules') && target.endsWith('/bin/dscode.mjs'))) return
    rmSync(link)
    symlinkSync(self, link)
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
  if (process.env.DSCODE_BIN !== undefined && process.env.DSCODE_BIN !== '') {
    const child = spawn(process.env.DSCODE_BIN, process.argv.slice(2), { stdio: 'inherit' })
    child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : code ?? 1))
    return
  }
  healLauncherLink()
  const bin = await ensureBinary()
  const child = spawn(bin, process.argv.slice(2), { stdio: 'inherit' })
  child.on('exit', (code, signal) => process.exit(signal !== null ? 1 : code ?? 1))
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
