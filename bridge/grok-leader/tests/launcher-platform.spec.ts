import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { TUI_ASSETS, profileDir, tuiAssetName, tuiHome } from '../bin/dscode.mjs'

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

describe('tui home', () => {
  it('is the dscode profile (DSCODE_HOME), not a nested tui/ or ~/.dsh/dsc-tui', () => {
    expect(profileDir).toBe(join(homedir(), '.dsh', 'profiles', 'dscode'))
    expect(tuiHome).toBe(profileDir)
    expect(tuiHome.includes('node_modules')).toBe(false)
  })
})
