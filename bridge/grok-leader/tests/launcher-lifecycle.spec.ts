import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const launcher = fileURLToPath(new URL('../bin/dscode.mjs', import.meta.url))
const packageVersion = (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version
const homes: string[] = []

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('launcher lifecycle', () => {
  it('reconciles a stale profile package to the launcher version', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-upgrade-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    const fakeBin = join(home, 'fake-bin')
    const fakeNpm = join(fakeBin, 'npm')

    mkdirSync(plugin, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@hqzhao95/dscode', version: '0.0.9' }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: { '@hqzhao95/dscode': '0.0.9' },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    writeFileSync(fakeNpm, `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules/@hqzhao95/dscode"
printf '%s' '{"name":"@hqzhao95/dscode","version":"${packageVersion}"}' > "$prefix/node_modules/@hqzhao95/dscode/package.json"
`)
    chmodSync(fakeNpm, 0o755)

    const script = `import { ensureProfilePlugin } from ${JSON.stringify(pathToFileURL(launcher).href)}; ensureProfilePlugin()`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DSH_HOME: dshHome,
        PATH: `${fakeBin}:${process.env.PATH ?? ''}`,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version).toBe(packageVersion)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toContain('@hqzhao95/dscode')
  })

  it('uninstalls owned state and preserves shared dsh data', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-uninstall-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    const profileLauncher = join(plugin, 'bin', 'dscode.mjs')
    const launcherLink = join(home, '.local', 'bin', 'dscode')
    const sharedSession = join(dshHome, 'sessions', 'keep-me')

    mkdirSync(dirname(profileLauncher), { recursive: true })
    mkdirSync(dirname(launcherLink), { recursive: true })
    mkdirSync(dirname(sharedSession), { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@hqzhao95/dscode', version: '0.0.10' }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode'] } },
    }))
    writeFileSync(profileLauncher, '#!/usr/bin/env node\n')
    writeFileSync(sharedSession, 'preserve')
    symlinkSync(profileLauncher, launcherLink)

    const result = spawnSync(process.execPath, [launcher, 'uninstall'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: dshHome },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(profile)).toBe(false)
    expect(existsSync(launcherLink)).toBe(false)
    expect(existsSync(sharedSession)).toBe(true)
  })

  it('removes a partial owned profile left by a failed first install', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-partial-uninstall-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')

    mkdirSync(profile, { recursive: true })
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))

    const result = spawnSync(process.execPath, [launcher, 'uninstall'], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: dshHome },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(profile)).toBe(false)
  })
})
