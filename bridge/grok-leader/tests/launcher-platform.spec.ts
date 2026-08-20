import { describe, expect, it } from 'vitest'
import {
  TUI_ASSETS,
  dshRuntimeBin,
  nodeVersionSupported,
  ownedLauncherTarget,
  packageNeedsInstall,
  packageUpdateRef,
  parseCliVersion,
  profileDir,
  profileLauncher,
  tuiAssetName,
  tuiHome,
} from '../bin/dscode.mjs'

describe('tuiAssetName', () => {
  it('maps the two shipped prebuilts', () => {
    expect(tuiAssetName('linux', 'x64')).toBe('dscode-linux-x86_64')
    expect(tuiAssetName('darwin', 'arm64')).toBe('dscode-macos-aarch64')
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
    expect(packageUpdateRef(['--version', '0.0.8'])).toBe('0.0.8')
  })

  it('parses the official dsh version output', () => {
    expect(parseCliVersion('0.1.0-rc.8')).toBe('0.1.0-rc.8')
    expect(parseCliVersion('dsh 0.1.0-rc.8\n')).toBe('0.1.0-rc.8')
    expect(parseCliVersion('unknown')).toBeUndefined()
  })

  it('enforces the dsh node floor while keeping future majors valid', () => {
    expect(nodeVersionSupported('22.18.0')).toBe(false)
    expect(nodeVersionSupported('22.19.0')).toBe(true)
    expect(nodeVersionSupported('23.9.0')).toBe(false)
    expect(nodeVersionSupported('24.0.0')).toBe(true)
  })

  it('recognizes only the profile-owned launcher shape', () => {
    expect(ownedLauncherTarget(profileLauncher)).toBe(true)
    expect(ownedLauncherTarget(`${profileLauncher}.foreign`)).toBe(false)
    expect(ownedLauncherTarget('/tmp/other/node_modules/@hqzhao95/dscode/bin/dscode.mjs')).toBe(false)
  })
})
