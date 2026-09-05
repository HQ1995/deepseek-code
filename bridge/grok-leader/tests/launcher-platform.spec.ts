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
  parseCliVersion,
  profileDir,
  profileLauncher,
  updateCommandIndex,
  tuiAssetName,
  tuiHome,
} from '../bin/dscode.mjs'
import { updateOptions } from '../bin/update.mjs'

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

  it('selects canonical channels and exact versions', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-options-'))
    try {
      expect(updateOptions([], home, '0.0.13-beta.1').channel).toBe('beta')
      expect(updateOptions([], home, '0.0.13-alpha.1').channel).toBe('alpha')
      expect(updateOptions([], home, '0.0.13').channel).toBe('stable')
      expect(updateOptions(['--alpha'], home, '0.0.13').channel).toBe('alpha')
      expect(updateOptions(['--stable'], home, '0.0.13-alpha.1').channel).toBe('stable')
      expect(updateOptions(['--version', '0.0.8'], home, '0.0.13').version).toBe('0.0.8')
      expect(updateOptions(['--version=0.0.9'], home, '0.0.13').version).toBe('0.0.9')
      expect(updateOptions(['--check'], home, '0.0.13').check).toBe(true)
      expect(updateOptions(['--check', '--json'], home, '0.0.13')).toMatchObject({ check: true, json: true })
      expect(updateOptions(['--force-reinstall'], home, '0.0.13').force).toBe(true)
      expect(updateOptions(['--force'], home, '0.0.13').force).toBe(true)
      expect(updateOptions(['--trigger', 'leader_converge'], home, '0.0.13').trigger).toBe('leader_converge')
      expect(updateOptions(['--trigger=auto_background'], home, '0.0.13').trigger).toBe('auto_background')
      expect(updateOptions(['--auto'], home, '0.0.13').trigger).toBe('auto_background')
    } finally { rmSync(home, { recursive: true, force: true }) }
  })

  it('finds update only in command position after global debug flags', () => {
    expect(updateCommandIndex(['--debug', 'update', '--alpha'])).toBe(1)
    expect(updateCommandIndex(['update', '--check'])).toBe(0)
    for (const args of [['--debug'], ['-p', 'update'], ['--model', 'update'], ['wrap', 'update']]) expect(updateCommandIndex(args)).toBe(-1)
  })

  it('parses the official dsh version output', () => {
    expect(parseCliVersion('0.1.1-rc.2')).toBe('0.1.1-rc.2')
    expect(parseCliVersion('dsh 0.1.1-rc.2\n')).toBe('0.1.1-rc.2')
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
