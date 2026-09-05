import { spawnSync } from 'node:child_process'
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { nodeVersionSupported } from '../bin/dscode.mjs'
import { channelAccepts, commitInstallation, extractArchive, resolveRelease, updateOptions } from '../bin/update.mjs'
import { create as createTar } from 'tar'

const launcher = fileURLToPath(new URL('../bin/dscode.mjs', import.meta.url))
const packageJson = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string
  dsh: { testedVersion: string }
}
const packageVersion = packageJson.version
const dshVersion = packageJson.dsh.testedVersion
const homes: string[] = []
const productNode = process.env.DSCODE_E2E_NODE_BIN
  ?? (nodeVersionSupported(process.versions.node) ? process.execPath : undefined)

afterEach(() => {
  for (const home of homes.splice(0)) rmSync(home, { recursive: true, force: true })
})

describe('launcher lifecycle', () => {
  it('preserves relative archive links and rejects absolute links before extraction', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-archive-'))
    homes.push(home)
    const input = join(home, 'input'), archive = join(home, 'payload.tgz')
    mkdirSync(input)
    writeFileSync(join(input, 'tool'), '#!/bin/sh\necho version\n')
    chmodSync(join(input, 'tool'), 0o755)
    symlinkSync('tool', join(input, 'relative'))
    createTar({ file: archive, cwd: input, gzip: true, sync: true }, ['tool', 'relative'])
    const output = join(home, 'output')
    extractArchive(archive, output)
    expect(readlinkSync(join(output, 'relative'))).toBe('tool')
    expect(readFileSync(join(output, 'relative'), 'utf8')).toContain('echo version')
    symlinkSync(join(input, 'tool'), join(input, 'absolute'))
    createTar({ file: archive, cwd: input, gzip: true, sync: true }, ['tool', 'absolute'])
    const rejected = join(home, 'rejected')
    expect(() => extractArchive(archive, rejected)).toThrow('unsafe archive link')
    expect(existsSync(rejected)).toBe(false)
  })

  it('commits a prepared tuple and channel while preserving unrelated profile files', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-commit-'))
    homes.push(home)
    const profile = join(home, 'active'), stage = join(home, 'stage')
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    writeFileSync(join(profile, 'binary'), 'old')
    writeFileSync(join(profile, 'user-settings'), 'preserved')
    writeFileSync(join(stage, 'profile', 'binary'), 'new')
    writeFileSync(join(stage, 'profile', 'config.toml'), '[cli]\nchannel="alpha"\nchannel_format=1\n')
    commitInstallation(profile, stage, ['binary', 'config.toml'])
    expect(readFileSync(join(profile, 'binary'), 'utf8')).toBe('new')
    expect(updateOptions([], profile, '1.0.0').channel).toBe('alpha')
    expect(readFileSync(join(profile, 'user-settings'), 'utf8')).toBe('preserved')
  })


  it.skipIf(productNode === undefined)('bootstraps an isolated profile, runtime, launcher, and cached TUI', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-first-run-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const normalLauncher = join(home, 'launcher', 'bin', 'dscode.mjs')
    mkdirSync(dirname(normalLauncher), { recursive: true })
    copyFileSync(launcher, normalLauncher)
    symlinkSync(fileURLToPath(new URL('../bin/update.mjs', import.meta.url)), join(dirname(normalLauncher), 'update.mjs'))
    writeFileSync(join(home, 'launcher', 'package.json'), JSON.stringify({ ...packageJson, dsh: { ...packageJson.dsh, sourceCommit: undefined } }))
    const profile = join(dshHome, 'profiles', 'dscode')
    const cachedTui = join(profile, 'bin', 'dscode')
    const fakeBin = join(home, 'fake-bin')
    const fakeNpm = join(fakeBin, 'npm')
    const tuiLog = join(home, 'tui.log')
    const npmLog = join(home, 'npm.log')
    const launcherLink = join(home, '.local', 'bin', 'dscode')
    const legacyRealBin = join(home, 'legacy-real', 'dscode')
    const legacyAliasDir = join(home, 'legacy-alias')
    const legacyBin = join(legacyAliasDir, 'dscode')
    mkdirSync(dirname(cachedTui), { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    mkdirSync(dirname(launcherLink), { recursive: true })
    mkdirSync(dirname(legacyRealBin), { recursive: true })
    writeFileSync(legacyRealBin, '#!/bin/sh\n')
    symlinkSync(dirname(legacyRealBin), legacyAliasDir)
    symlinkSync(legacyBin, launcherLink)
    writeFileSync(cachedTui, `#!/bin/sh
if [ "\${1:-}" = "--version" ]; then
  echo 'dscode ${packageVersion}-dev (e2e)'
  exit 0
fi
{
  printf 'DSH_BIN=%s\n' "\${DSH_BIN:-}"
  printf 'DSCODE_HOME=%s\n' "\${DSCODE_HOME:-}"
  printf 'DSH_PROFILE_DIR=%s\n' "\${DSH_PROFILE_DIR:-}"
  printf 'DSCODE_MANAGED_LAUNCHER=%s\n' "\${DSCODE_MANAGED_LAUNCHER:-}"
  printf 'ARGS='
  printf '<%s>' "$@"
  printf '\n'
} > ${JSON.stringify(tuiLog)}
`)
    chmodSync(cachedTui, 0o755)
    writeFileSync(fakeNpm, `#!/bin/sh
printf '%s\n' "$*" >> ${JSON.stringify(npmLog)}
printf 'npm chatter\n'
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
    printf '%s' '${JSON.stringify(packageJson)}' > "$prefix/node_modules/@hqzhao95/dscode/package.json"
    cat > "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs" <<'EOF'
#!/bin/sh
exit 0
EOF
    chmod +x "$prefix/node_modules/@hqzhao95/dscode/bin/dscode.mjs"
    ;;
esac
`)
    chmodSync(fakeNpm, 0o755)

    const result = spawnSync(productNode!, [normalLauncher, 'inspect', '--json'], {
      encoding: 'utf8',
      env: {
        ...process.env,
        HOME: home,
        DSH_HOME: dshHome,
        PATH: `${fakeBin}:/usr/bin:/bin`,
        DSCODE_BIN: '',
        DSH_BIN: '',
        DSCODE_LEGACY_BIN: legacyRealBin,
      },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('')
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    expect(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).version).toBe(packageVersion)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toContain('@hqzhao95/dscode')
    expect(existsSync(join(profile, 'runtime', 'bin', 'dsh'))).toBe(true)
    expect(readlinkSync(launcherLink)).toBe(join(plugin, 'bin', 'dscode.mjs'))
    const launched = readFileSync(tuiLog, 'utf8')
    expect(launched).toContain(`DSH_BIN=${join(profile, 'runtime', 'bin', 'dsh')}`)
    expect(launched).toContain(`DSCODE_HOME=${profile}`)
    expect(launched).toContain(`DSH_PROFILE_DIR=${profile}`)
    expect(launched).toContain('DSCODE_MANAGED_LAUNCHER=1')
    expect(launched).toContain('ARGS=<inspect><--json>')
    expect(readFileSync(npmLog, 'utf8')).toContain(`@hqzhao95/dscode@${packageVersion}`)
    expect(readFileSync(npmLog, 'utf8')).toContain(`@deepseek-ai/dsh@${dshVersion}`)
  })

  it('keeps channel checks read-only and separates legacy alpha from explicit alpha', async () => {
    const profile = mkdtempSync(join(tmpdir(), 'dscode-channel-'))
    homes.push(profile)
    const config = '[cli]\nchannel = "alpha"\n[other]\nsetting = "preserved"\n'
    writeFileSync(join(profile, 'config.toml'), config)
    expect(updateOptions(['--check'], profile, '1.0.0-alpha.1').channel).toBe('beta')
    const options = updateOptions(['--alpha', '--check'], profile, '1.0.0')
    const fetcher = async () => new Response(JSON.stringify([
      { tag_name: 'v1.0.1-beta.9' }, { tag_name: 'v1.0.1-alpha.2' },
      { tag_name: 'v1.0.1-alpha.10' }, { tag_name: 'v1.0.0' },
    ]))
    expect(await resolveRelease(options, fetcher)).toBe('1.0.1-alpha.10')
    expect(await resolveRelease({ channel: 'beta' }, fetcher)).toBe('1.0.1-beta.9')
    expect(await resolveRelease({ channel: 'stable' }, fetcher)).toBe('1.0.0')
    expect(await resolveRelease({ channel: 'alpha', version: '1.0.0' }, () => { throw new Error('unexpected lookup') })).toBe('1.0.0')
    expect(channelAccepts('beta', '1.0.1-alpha.99')).toBe(false)
    expect(readFileSync(join(profile, 'config.toml'), 'utf8')).toBe(config)
    expect(() => updateOptions(['--alpha', '--beta'], profile, '1.0.0')).toThrow('choose only one')
    writeFileSync(join(profile, 'config.toml'), '[cli]\nchannel = "alpha"\nchannel_format = 1\n')
    expect(updateOptions([], profile, '1.0.0').channel).toBe('alpha')
    writeFileSync(join(profile, 'config.toml'), '[cli]\nchannel_format = 2\n')
    expect(() => updateOptions([], profile, '1.0.0')).toThrow('invalid cli.channel_format')
  })

  it('rolls back previously committed components when a later rename fails', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-rollback-'))
    homes.push(home)
    const profile = join(home, 'active'), stage = join(home, 'stage')
    mkdirSync(profile)
    mkdirSync(join(stage, 'profile'), { recursive: true })
    writeFileSync(join(profile, 'binary'), 'old')
    writeFileSync(join(profile, 'blocked'), 'not a directory')
    writeFileSync(join(stage, 'profile', 'binary'), 'new')
    expect(() => commitInstallation(profile, stage, ['binary', 'blocked/config.toml'])).toThrow()
    expect(readFileSync(join(profile, 'binary'), 'utf8')).toBe('old')
    expect(readFileSync(join(profile, 'blocked'), 'utf8')).toBe('not a directory')
  })

  it.each(['stale version', 'same version with stale baseline', 'same version with missing baseline'])('reconciles a profile package: %s', (scenario) => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-upgrade-'))
    homes.push(home)
    const dshHome = join(home, '.dsh')
    const profile = join(dshHome, 'profiles', 'dscode')
    const plugin = join(profile, 'node_modules', '@hqzhao95', 'dscode')
    const fakeBin = join(home, 'fake-bin')
    const fakeNpm = join(fakeBin, 'npm')

    mkdirSync(plugin, { recursive: true })
    mkdirSync(fakeBin, { recursive: true })
    const oldVersion = scenario === 'stale version' ? '0.0.9' : packageVersion
    writeFileSync(join(plugin, 'package.json'), JSON.stringify({
      ...packageJson,
      version: oldVersion,
      dsh: scenario === 'same version with missing baseline' ? undefined : {
        ...packageJson.dsh, testedVersion: '0.1.3-rc.1',
      },
    }))
    writeFileSync(join(profile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-dscode',
      private: true,
      dependencies: { '@hqzhao95/dscode': oldVersion },
      dsh: { profile: { bundles: ['@deepseek-ai/dsh-base'] } },
    }))
    writeFileSync(fakeNpm, `#!/bin/sh
prefix=""
while [ "$#" -gt 0 ]; do
  if [ "$1" = "--prefix" ]; then prefix="$2"; shift 2; else shift; fi
done
mkdir -p "$prefix/node_modules/@hqzhao95/dscode"
printf '%s' '${JSON.stringify(packageJson)}' > "$prefix/node_modules/@hqzhao95/dscode/package.json"
`)
    chmodSync(fakeNpm, 0o755)

    const script = `import { ensureProfilePlugin } from ${JSON.stringify(pathToFileURL(launcher).href)}; console.log(JSON.stringify(ensureProfilePlugin())); console.log(JSON.stringify(ensureProfilePlugin()))`
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
    expect(result.stdout.trim().split('\n').map(line => JSON.parse(line).changed)).toEqual([true, false])
    expect(JSON.parse(readFileSync(join(plugin, 'package.json'), 'utf8')).dsh).toEqual(packageJson.dsh)
    const manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) as { dsh: { profile: { bundles: string[] } } }
    expect(manifest.dsh.profile.bundles).toContain('@hqzhao95/dscode')
  })

  it.each([dshVersion, '0.1.3-rc.1', 'unversioned'])('checks explicit DSH_BIN version %s without installing', (version) => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-explicit-dsh-'))
    homes.push(home)
    const binary = join(home, 'dsh')
    writeFileSync(binary, `#!/bin/sh\necho '${version}'\n`)
    chmodSync(binary, 0o755)
    const script = `import { ensureDshCli } from ${JSON.stringify(pathToFileURL(launcher).href)}; console.log(await ensureDshCli())`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), DSH_BIN: binary, PATH: home },
    })
    if (version === dshVersion) {
      expect(result.status, result.stderr).toBe(0)
      expect(result.stdout.trim()).toBe(binary)
    } else {
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain(`expected ${dshVersion}`)
      expect(result.stderr).toContain('DSH_BIN')
    }
    expect(existsSync(join(home, '.dsh'))).toBe(false)
  })

  it('rejects missing baseline metadata before probing or installing a runtime', () => {
    const home = mkdtempSync(join(tmpdir(), 'dscode-missing-baseline-'))
    homes.push(home)
    const copiedLauncher = join(home, 'bin', 'dscode.mjs')
    mkdirSync(dirname(copiedLauncher))
    copyFileSync(launcher, copiedLauncher)
    symlinkSync(fileURLToPath(new URL('../bin/update.mjs', import.meta.url)), join(dirname(copiedLauncher), 'update.mjs'))
    writeFileSync(join(home, 'package.json'), JSON.stringify({ ...packageJson, dsh: {} }))
    const script = `import { ensureDshCli } from ${JSON.stringify(pathToFileURL(copiedLauncher).href)}; await ensureDshCli()`
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
      encoding: 'utf8',
      env: { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), DSH_BIN: '', PATH: home },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('missing dsh.testedVersion')
    expect(existsSync(join(home, '.dsh'))).toBe(false)
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
