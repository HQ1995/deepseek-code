import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeVersionSupported, packageUpdateRef } from '../bin/dscode.mjs'

const launcher = fileURLToPath(new URL('../bin/dscode.mjs', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dsh: { testedVersion: string }
}
const packageVersion = packageJson.version
const dshVersion = packageJson.dsh.testedVersion
const [packageMajor, packageMinor, packagePatch] = packageVersion.split(/[.-]/).slice(0, 3).map(Number)
const updatedPackageVersion = `${packageMajor}.${packageMinor}.${packagePatch + 1}-beta.1`
const homes: string[] = []
const productNode = process.env.DSCODE_E2E_NODE_BIN
  ?? (nodeVersionSupported(process.versions.node) ? process.execPath : undefined)

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('launcher lifecycle', () => {
  it('uses beta as the public channel name and keeps alpha compatible', () => {
    expect(packageUpdateRef(['--beta'])).toBe('beta')
    expect(packageUpdateRef(['--alpha'])).toBe('beta')
  })

  it.skipIf(productNode === undefined)('bootstraps an isolated profile, runtime, launcher, and cached TUI', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-first-run-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')
    const cachedTui = join(profile, 'bin', 'dscode')
    const fakeBin = join(home, 'fake-bin')
    const fakeNpm = join(fakeBin, 'npm')
    const tuiLog = join(home, 'tui.log')
    const npmLog = join(home, 'npm.log')
    mkdirSync(dirname(cachedTui), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(cachedTui, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo 'dscode ${packageVersion}-dev (e2e)'
  exit 0
fi
{
  printf 'DSH_BIN=%s\n' "\${DSH_BIN:-}"
  printf 'DSCODE_HOME=%s\n' "\${DSCODE_HOME:-}"
  printf 'DSH_PROFILE_DIR=%s\n' "\${DSH_PROFILE_DIR:-}"
  printf 'ARGS='
  printf '<%s>' "$@"
  printf '\n'
} > ${JSON.stringify(tuiLog)}
`)
    chmodSync(cachedTui, 0o755)
    writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(npmLog)}
prefix=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--prefix' ]; then prefix="$2"; shift 2; else shift; fi
done
case "$prefix" in
  */runtime)
    mkdir -p "$prefix/bin"
    cat > "$prefix/bin/dsh" <<'EOF'
#!/bin/sh
echo '${dshVersion}'
EOF
    chmod +x "$prefix/bin/dsh"
    ;;
  *)
    mkdir -p "$prefix/node_modules/@hqzhao95/dscode/bin"
    printf '%s' '{"name":"@hqzhao95/dscode","version":"${packageVersion}"}' > "$prefix/node_modules/@hqzhao95/dscode/package.json"
    cat > "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs" <<'EOF'
#!/bin/sh
exit 0
EOF
    chmod +x "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs"
    ;;
esac
`)
    chmodSync(fakeNpm, 0o755)

    const result = spawnSync(productNode!, [launcher, 'inspect', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DSH_HOME: dshHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSCODE_BIN: '',
        DSH_BIN: '',
      },
    })

    expect(result.status, result.stderr).toBe(0)
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    expect(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version).toBe(packageVersion)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toContain('@hqzhao95/dscode')
    expect(existsSync(join(profile, 'runtime', 'bin', 'dsh'))).toBe(true)
    const launcherLink = join(home, '.local', 'bin', 'dscode')
    expect(readlinkSync(launcherLink)).toBe(join(plugin, 'bin', 'dscode.mjs'))
    const launched = readFileSync(tuiLog, 'utf8')
    expect(launched).toContain(`DSH_BIN=${join(profile, 'runtime', 'bin', 'dsh')}`)
    expect(launched).toContain(`DSCODE_HOME=${profile}`)
    expect(launched).toContain(`DSH_PROFILE_DIR=${profile}`)
    expect(launched).toContain('ARGS=<inspect><--json>')
    expect(readFileSync(npmLog, 'utf8')).toContain(`@hqzhao95/dscode@${packageVersion}`)
    expect(readFileSync(npmLog, 'utf8')).toContain(`@deepseek-ai/dsh@${dshVersion}`)
  })

  it.skipIf(productNode === undefined)('reconciles the requested update channel and re-execs the installed launcher', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-update-e2e-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    const installedLauncher = join(plugin, 'bin', 'dscode.mjs')
    const fakeBin = join(home, 'fake-bin')
    const fakeNpm = join(fakeBin, 'npm')
    const reexecLog = join(home, 'reexec.log')
    mkdirSync(dirname(installedLauncher), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({ name: '@hqzhao95/dscode', version: packageVersion }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: { '@hqzhao95/dscode': packageVersion },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@hqzhao95/dscode'] } },
    }))
    writeFileSync(installedLauncher, `#!/bin/sh
printf 'RECONCILED=%s\nARGS=' "\${DSCODE_PACKAGE_RECONCILED:-}" > ${JSON.stringify(reexecLog)}
printf '<%s>' "$@" >> ${JSON.stringify(reexecLog)}
printf '\n' >> ${JSON.stringify(reexecLog)}
`)
    chmodSync(installedLauncher, 0o755)
    writeFileSync(fakeNpm, `#!/bin/sh
prefix=''
while [ "$#" -gt 0 ]; do
  if [ "$1" = '--prefix' ]; then prefix="$2"; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules/@hqzhao95/dscode/bin"
printf '%s' '{"name":"@hqzhao95/dscode","version":"${updatedPackageVersion}"}' > "$prefix/node_modules/@hqzhao95/dscode/package.json"
cat > "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs" <<'EOF'
#!/bin/sh
printf 'RECONCILED=%s\nARGS=' "\${DSCODE_PACKAGE_RECONCILED:-}" > ${reexecLog}
printf '<%s>' "$@" >> ${reexecLog}
printf '\n' >> ${reexecLog}
EOF
chmod +x "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs"
`)
    chmodSync(fakeNpm, 0o755)

    const result = spawnSync(productNode!, [launcher, '--debug', 'update', '--beta'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DSH_HOME: dshHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version).toBe(updatedPackageVersion)
    expect(readFileSync(reexecLog, 'utf8')).toBe('RECONCILED=1\nARGS=<--debug><update><--beta>\n')
  })

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
