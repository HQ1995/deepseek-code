import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import {
  TUI_ASSETS,
  downloadGzipIfAvailable,
  dshRuntimeBin,
  nodeVersionSupported,
  ownedLauncherTarget,
  packageNeedsInstall,
  packageUpdateRef,
  parseCliVersion,
  profileDir,
  profileLauncher,
  shouldReconcilePackageUpdate,
  tuiAssetName,
  tuiHome,
} from '../bin/dscode.mjs'

describe('tuiAssetName', () => {
  it('maps the two shipped prebuilts', () => {
    expect(tuiAssetName('linux', 'x64')).toBe('dscode-linux-x86_64')
    expect(tuiAssetName('darwin', 'arm64')).toBe('dscode-macos-aarch64')
  })

  it('expands the compressed release asset before checksum verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dscode-gzip-'))
    const dest = join(dir, 'dscode')
    try {
      const compressed = gzipSync('dscode-binary')
      const url = `data:application/gzip;base64,${compressed.toString('base64')}`
      await expect(downloadGzipIfAvailable(url, dest)).resolves.toBe(true)
      expect(readFileSync(dest, 'utf8')).toBe('dscode-binary')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('leaves Intel Mac and other arches to a from-source build', () => {
    expect(tuiAssetName('darwin', 'x64')).toBeUndefined()
    expect(tuiAssetName('linux', 'arm64')).toBeUndefined()
    expect(tuiAssetName('win32', 'x64')).toBeUndefined()
  })

  it('keeps asset names aligned with the rust updater (dscode-{os}-{arch})', () => {
    expect(Object.values(TUI_ASSETS).sort()).toEqual([
      'dscode-linux-x86_64',
      'dscode-macos-aarch64',
    ])
  })
})

describe('home', () => {
  it('puts TUI state in the dsh profile directory', () => {
    expect(tuiHome).toBe(profileDir)
    expect(profileDir).toMatch(/profiles[/\\]dscode$/)
    expect(dshRuntimeBin).toContain(`${profileDir}/runtime/`)
  })
})

describe('installation lifecycle', () => {
  it('reinstalls a missing or stale profile package', () => {
    expect(packageNeedsInstall(undefined, '0.0.11')).toBe(true)
    expect(packageNeedsInstall('0.0.10', '0.0.11')).toBe(true)
    expect(packageNeedsInstall('0.0.11', '0.0.11')).toBe(false)
  })

  it('keeps the npm package on the requested update channel', () => {
    expect(packageUpdateRef([])).toBe('latest')
    expect(packageUpdateRef(['--beta'])).toBe('beta')
    expect(packageUpdateRef(['--alpha'])).toBe('beta')
    expect(packageUpdateRef(['--version', '0.0.8'])).toBe('0.0.8')
    expect(packageUpdateRef(['--version=0.0.9'])).toBe('0.0.9')
    expect(packageUpdateRef(['--stable'])).toBe('latest')
    expect(packageUpdateRef(['--enterprise'])).toBe('enterprise')
  })

  it('finds update after global flags but keeps --check observational', () => {
    expect(shouldReconcilePackageUpdate(['--debug', 'update', '--alpha'])).toBe(true)
    expect(shouldReconcilePackageUpdate(['update', '--check'])).toBe(false)
    expect(shouldReconcilePackageUpdate(['--debug'])).toBe(false)
    expect(shouldReconcilePackageUpdate(['-p', 'update'])).toBe(false)
    expect(shouldReconcilePackageUpdate(['--model', 'update'])).toBe(false)
    expect(shouldReconcilePackageUpdate(['wrap', 'update'])).toBe(false)
  })

  it('parses the official dsh version output', () => {
    expect(parseCliVersion('0.1.0-rc.8')).toBe('0.1.0-rc.8')
    expect(parseCliVersion('dsh 0.1.0-rc.8\n')).toBe('0.1.0-rc.8')
    expect(parseCliVersion('unknown')).toBeUndefined()
  })

  it('mirrors the pinned dsh dependency tree node floor', () => {
    expect(nodeVersionSupported('22.18.9')).toBe(false)
    expect(nodeVersionSupported('22.19.0')).toBe(true)
    expect(nodeVersionSupported('23.0.0')).toBe(true)
    expect(nodeVersionSupported('24.0.0')).toBe(true)
  })

  it('recognizes only the profile-owned launcher shape', () => {
    expect(ownedLauncherTarget(profileLauncher)).toBe(true)
    expect(ownedLauncherTarget(`${profileLauncher}.foreign`)).toBe(false)
    expect(ownedLauncherTarget('/tmp/other/node_modules/@hqzhao95/dscode/bin/dscode.mjs')).toBe(false)
  })
})
