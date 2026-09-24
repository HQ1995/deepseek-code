import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import { describe, expect, it, vi } from 'vitest'
import {
  TUI_ASSETS,
  dshRuntimeBin,
  nodeVersionSupported,
  launcherTargetIn,
  ownedLauncherTarget,
  packageNeedsInstall,
  parseCliVersion,
  profileDir,
  profileLauncher,
  updateCommandIndex,
  tuiAssetName,
  tuiHome,
} from '../bin/dscode.mjs'
import { downloadVerified, updateOptions } from '../bin/update.mjs'

describe('tuiAssetName', () => {
  it('aborts a stalled raw fallback instead of waiting indefinitely', async () => {
    vi.useFakeTimers()
    const dir = mkdtempSync(join(tmpdir(), 'dscode-timeout-'))
    try {
      const fetcher = async (url: string, { signal }: { signal: AbortSignal }) => {
        if (url.endsWith('.gz')) return new Response(null, { status: 404 })
        return await new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      }
      const result = expect(downloadVerified('https://release.invalid', 'dscode', join(dir, 'binary'), fetcher, true)).rejects.toThrow('download stalled')
      await vi.advanceTimersByTimeAsync(120000)
      await result
    } finally { vi.useRealTimers(); rmSync(dir, { recursive: true, force: true }) }
  })

  it('maps the two shipped prebuilts', () => {
    expect(tuiAssetName('linux', 'x64')).toBe('dscode-linux-x86_64')
    expect(tuiAssetName('darwin', 'arm64')).toBe('dscode-macos-aarch64')
  })

  it('expands the compressed release asset before checksum verification', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dscode-gzip-'))
    const dest = join(dir, 'dscode')
    try {
      const compressed = gzipSync('dscode-binary')
      const fetcher = async (url: string) => new Response(url.endsWith('.sha256') ? createHash('sha256').update('dscode-binary').digest('hex') : compressed)
      await downloadVerified('https://release.invalid', 'dscode', dest, fetcher, true)
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

  it('recognizes the owned launcher through a symlinked directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'dscode-link-'))
    try {
      mkdirSync(join(root, 'real'))
      writeFileSync(join(root, 'real', 'dscode.mjs'), '')
      writeFileSync(join(root, 'real', 'other.mjs'), '')
      symlinkSync(join(root, 'real'), join(root, 'alias'))
      const owned = [join(root, 'real', 'dscode.mjs')]
      expect(launcherTargetIn(join(root, 'alias', 'dscode.mjs'), owned)).toBe(true)
      expect(launcherTargetIn(join(root, 'real', 'dscode.mjs'), [join(root, 'alias', 'dscode.mjs')])).toBe(true)
      expect(launcherTargetIn(join(root, 'alias', 'other.mjs'), owned)).toBe(false)
      expect(launcherTargetIn(join(root, 'missing', 'dscode.mjs'), owned)).toBe(false)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
