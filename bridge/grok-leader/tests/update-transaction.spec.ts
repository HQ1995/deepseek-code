import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, symlinkSync, lstatSync, rmSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { fixtureEnvironment } from './fixtures/environment.ts'
import { installationReport } from '../bin/doctor.mjs'
import { commitInstallation, saveUpdateChannel, validateRuntime, withProfileLock } from '../bin/update.mjs'

it('retains the only backup when rollback fails and retries recovery at the next lock', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-rollback-recovery-'))
  const profile = join(root, 'active'), stage = join(root, '.dscode-update-rollback-failure')
  try {
    for (const base of [profile, join(stage, 'profile')]) {
      mkdirSync(join(base, 'bin'), { recursive: true })
      for (const entry of ['node_modules', 'runtime', 'bin/dscode', 'config.toml']) writeFileSync(join(base, entry), base)
    }
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/update-worker.mjs', import.meta.url)), root, 'rollback-failure', new URL('../bin/update.mjs', import.meta.url).href], {
      env: fixtureEnvironment(root), encoding: 'utf8', timeout: 15000,
    })
    expect(child.status).not.toBe(0)
    expect(child.stderr).toContain('kept recovery files')
    expect(readFileSync(join(stage, 'backup/node_modules'), 'utf8')).toBe(profile)
    expect(JSON.parse(readFileSync(join(stage, 'transaction.json'), 'utf8')).state).toBe('pending')
    await withProfileLock(profile, () => {})
    for (const entry of ['node_modules', 'runtime', 'bin/dscode', 'config.toml']) expect(readFileSync(join(profile, entry), 'utf8')).toBe(profile)
    expect(existsSync(stage)).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('preserves restrictive config permissions when saving the update channel', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-channel-permissions-'))
  try {
    const path = join(root, 'config.toml')
    writeFileSync(path, '[cli]\nchannel="beta"\nchannel_format=1\n', { mode: 0o600 })
    await saveUpdateChannel(root, 'alpha')
    expect(lstatSync(path).mode & 0o777).toBe(0o600)
    expect(readFileSync(path, 'utf8')).toContain('alpha')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('excludes a second process throughout tuple commit and releases locks after a crash', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-concurrent-update-'))
  const children: ReturnType<typeof spawn>[] = []
  const start = (lane: string) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/update-worker.mjs', import.meta.url)), root, lane, new URL('../bin/update.mjs', import.meta.url).href], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], env: fixtureEnvironment(root) })
    children.push(child)
    return child
  }
  try {
    for (const lane of ['active', 'A/profile', 'B/profile']) {
      mkdirSync(join(root, lane, 'bin'), { recursive: true })
      for (const entry of ['node_modules', 'runtime', 'bin/dscode', 'config.toml']) writeFileSync(join(root, lane, entry), lane)
    }
    const a = start('A'), aDone = once(a, 'exit')
    for (let i = 0; !existsSync(join(root, 'paused')); i++) {
      if (i > 500 || a.exitCode !== null) throw new Error('first updater did not reach commit')
      await delay(10)
    }
    const b = start('B'), bDone = once(b, 'exit')
    let error = ''
    b.stderr!.on('data', bytes => { error += String(bytes) })
    await delay(200)
    expect(b.exitCode).toBeNull()
    expect(error).toContain('waiting for the current profile update')
    writeFileSync(join(root, 'resume'), '')
    expect((await aDone)[0]).toBe(0)
    expect((await bDone)[0]).toBe(0)
    for (const entry of ['node_modules', 'runtime', 'bin/dscode', 'config.toml']) expect(readFileSync(join(root, 'active', entry), 'utf8')).toBe('B/profile')

    const owner = start('hold')
    expect((await once(owner, 'message'))[0]).toBe('locked')
    let entered = false
    const waiting = withProfileLock(join(root, 'active'), () => { entered = true; return 'recovered' })
    await delay(150)
    expect(entered).toBe(false)
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    await expect(waiting).resolves.toBe('recovered')
  } finally {
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    await Promise.all(children.filter(child => child.exitCode === null && child.signalCode === null).map(child => once(child, 'exit')))
    rmSync(root, { recursive: true, force: true })
  }
})

it.each(['landlock-run', 'system', 'upstream-renamed'])('accepts a complete %s runtime and rejects a missing required native artifact', family => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-native-runtime-'))
  // The renamed family also renames every identifier inside prebuilds.json.
  const renamed = family === 'upstream-renamed'
  const artifact = renamed ? 'bin/system-exec' : 'bin/landlock-run'
  const metadata = { dsh: { sourceCommit: 'a'.repeat(40), testedVersion: '0.1.5-alpha.1' } }
  const native = join(root, `node_modules/@deepseek-ai/node-addon-${family}-linux-x64`)
  try {
    mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '#!/bin/sh\nprintf "0.1.5-alpha.1\\n"\n', { mode: 0o755 })
    symlinkSync('../node_modules/@deepseek-ai/dsh/lib/bin.js', join(root, 'bin/dsh'))
    writeFileSync(join(root, 'dscode-runtime.json'), JSON.stringify({ schema: 1, platform: 'linux', arch: 'x64', sourceCommit: metadata.dsh.sourceCommit, dshVersion: metadata.dsh.testedVersion }))
    mkdirSync(join(native, 'bin'), { recursive: true })
    writeFileSync(join(native, artifact), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const binaries: object[] = [{ tool: renamed ? 'system-exec' : 'landlock-run', kind: renamed ? 'executable' : 'static-musl', path: artifact }]
    if (family === 'system') {
      for (const libc of ['glibc', 'musl']) {
        mkdirSync(join(native, `bin/${libc}`))
        writeFileSync(join(native, `bin/${libc}/system.node`), 'fixture addon')
        binaries.push({ tool: 'flock', kind: 'node-api', libc, path: `bin/${libc}/system.node` })
      }
    }
    writeFileSync(join(native, 'prebuilds.json'), JSON.stringify({ platform: 'linux-x64', binaries }))
    expect(() => validateRuntime(root, metadata, 'linux', 'x64')).not.toThrow()
    rmSync(join(native, family === 'system' ? 'bin/glibc/system.node' : artifact))
    expect(() => validateRuntime(root, metadata, 'linux', 'x64')).toThrow()
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('restores moved components and removed locks when a later commit entry fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-rollback-'))
  const profile = join(root, 'active'), stage = join(root, 'stage')
  try {
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    for (const [name, value] of Object.entries({ 'package.json': 'old package', runtime: 'old runtime', 'config.toml': 'old channel', blocker: 'not a directory' })) writeFileSync(join(profile, name), value)
    symlinkSync('missing-old-lock', join(profile, 'package-lock.json'))
    for (const [name, value] of Object.entries({ 'package.json': 'new package', runtime: 'new runtime', 'config.toml': 'new channel' })) writeFileSync(join(stage, 'profile', name), value)
    await expect(commitInstallation(profile, stage, ['package.json', 'package-lock.json', 'runtime', 'blocker/child', 'config.toml'])).rejects.toThrow()
    expect(readFileSync(join(profile, 'package.json'), 'utf8')).toBe('old package')
    expect(readFileSync(join(profile, 'runtime'), 'utf8')).toBe('old runtime')
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe('old channel')
    expect(readlinkSync(join(profile, 'package-lock.json'))).toBe('missing-old-lock')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

it('removes an obsolete dangling npm lock during a successful commit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-lock-cutover-'))
  const profile = join(root, 'active'), stage = join(root, 'stage')
  try {
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    symlinkSync('missing-old-lock', join(profile, 'package-lock.json'))
    writeFileSync(join(profile, 'config.toml'), 'old channel')
    writeFileSync(join(stage, 'profile/config.toml'), 'new channel')
    await commitInstallation(profile, stage, ['package-lock.json', 'config.toml'])
    expect(lstatSync(join(profile, 'package-lock.json'), { throwIfNoEntry: false })).toBeUndefined()
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe('new channel')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

// Diagnostics describe the running host; native artifact validation above has
// deliberately explicit Linux fixtures and must not leak into this check.
it.each(['host', 'darwin-arm64'])('reports a matching %s runtime and detects a mismatched tuple', host => {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!
  const arch = Object.getOwnPropertyDescriptor(process, 'arch')!
  if (host === 'darwin-arm64') {
    Object.defineProperty(process, 'platform', { ...platform, value: 'darwin' })
    Object.defineProperty(process, 'arch', { ...arch, value: 'arm64' })
  }
  const root = mkdtempSync(join(tmpdir(), 'dscode-host-runtime-'))
  const metadata = { dsh: { sourceCommit: 'a'.repeat(40), testedVersion: '0.1.5-alpha.1' } }
  try {
    mkdirSync(join(root, 'node_modules/@deepseek-ai/dsh/lib'), { recursive: true })
    mkdirSync(join(root, 'bin'))
    writeFileSync(join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '#!/bin/sh\nprintf "0.1.5-alpha.1\\n"\n', { mode: 0o755 })
    symlinkSync('../node_modules/@deepseek-ai/dsh/lib/bin.js', join(root, 'bin/dsh'))
    const descriptor = { schema: 1, platform: process.platform, arch: process.arch, sourceCommit: metadata.dsh.sourceCommit, dshVersion: metadata.dsh.testedVersion }
    writeFileSync(join(root, 'dscode-runtime.json'), JSON.stringify(descriptor))
    if (process.platform === 'linux') {
      const native = join(root, `node_modules/@deepseek-ai/node-addon-landlock-run-linux-${process.arch}`)
      mkdirSync(join(native, 'bin'), { recursive: true })
      writeFileSync(join(native, 'bin/landlock-run'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
      writeFileSync(join(native, 'prebuilds.json'), JSON.stringify({ platform: `linux-${process.arch}`, binaries: [{ tool: 'landlock-run', kind: 'static-musl', path: 'bin/landlock-run' }] }))
    }
    const dir = join(root, 'package'), profile = join(root, 'profile')
    mkdirSync(dir)
    mkdirSync(join(profile, 'node_modules/test-package'), { recursive: true })
    const pkg = { ...metadata, name: 'test-package', version: '1.2.3' }
    for (const path of [join(dir, 'package.json'), join(profile, 'node_modules/test-package/package.json')]) writeFileSync(path, JSON.stringify(pkg))
    const report = (tuiVersion = '1.2.3') => installationReport({ dir, profile, tuiVersion, dshBin: join(root, 'bin/dsh'), optional: false })
    expect(report().filter(f => f.status === 'ERROR')).toEqual([])
    expect(report('1.2.3-dev').find(f => f.name === 'TUI')?.status).toBe('INFO')
    expect(report('0.9.0').find(f => f.name === 'TUI')?.status).toBe('ERROR')
    writeFileSync(join(root, 'dscode-runtime.json'), JSON.stringify({ ...descriptor, platform: 'wrong-platform' }))
    expect(report().find(f => f.name === 'Runtime provenance')?.status).toBe('ERROR')
  } finally {
    Object.defineProperty(process, 'platform', platform)
    Object.defineProperty(process, 'arch', arch)
    rmSync(root, { recursive: true, force: true })
  }
})
