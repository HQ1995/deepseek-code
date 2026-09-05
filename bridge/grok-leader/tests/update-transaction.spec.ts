import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, lstatSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { commitInstallation } from '../bin/update.mjs'

it('restores moved components and removed locks when a later commit entry fails', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-rollback-'))
  const profile = join(root, 'active'), stage = join(root, 'stage')
  try {
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    for (const [name, value] of Object.entries({ 'package.json': 'old package', runtime: 'old runtime', 'config.toml': 'old channel', blocker: 'not a directory' })) writeFileSync(join(profile, name), value)
    symlinkSync('missing-old-lock', join(profile, 'package-lock.json'))
    for (const [name, value] of Object.entries({ 'package.json': 'new package', runtime: 'new runtime', 'config.toml': 'new channel' })) writeFileSync(join(stage, 'profile', name), value)
    expect(() => commitInstallation(profile, stage, ['package.json', 'package-lock.json', 'runtime', 'blocker/child', 'config.toml'])).toThrow()
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('old package')
    expect(readFileSync(join(profile, 'runtime'), 'utf8')).toBe('old runtime')
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe('old channel')
    expect(readlinkSync(join(profile, 'package-lock.json'))).toBe('missing-old-lock')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('removes an obsolete dangling npm lock during a successful commit', () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-lock-cutover-'))
  const profile = join(root, 'active'), stage = join(root, 'stage')
  try {
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    symlinkSync('missing-old-lock', join(profile, 'package-lock.json'))
    writeFileSync(join(profile, 'config.toml'), 'old channel')
    writeFileSync(join(stage, 'profile/config.toml'), 'new channel')
    commitInstallation(profile, stage, ['package-lock.json', 'config.toml'])
    expect(lstatSync(join(profile, 'package-lock.json'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe('new channel')
  } finally { rmSync(root, { recursive: true, force: true }) }
})
