import { createHash } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { once } from 'node:events'
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as tar } from 'tar'
import { expect, it } from 'vitest'
import { installationFilesMatch, installationMatches, withProfileLock } from '../bin/update.mjs'
import { fixtureEnvironment } from './fixtures/environment.ts'

const bridge = fileURLToPath(new URL('..', import.meta.url))
const current = JSON.parse(readFileSync(join(bridge, 'package.json'), 'utf8'))

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), 'dscode-launcher-tuple-'))
  const profile = join(root, 'profile'), remote = join(root, 'remote')
  const metadata = { ...current, dependencies: {}, dscode: { release: current.version } }
  const put = (path: string, value: string, mode = 0o644) => {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, value, { mode })
  }
  cpSync(join(bridge, 'bin'), join(root, 'launcher/bin'), { recursive: true })
  symlinkSync(join(bridge, 'node_modules'), join(root, 'launcher/node_modules'))
  put(join(root, 'launcher/package.json'), JSON.stringify(metadata))
  put(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-dscode', private: true, dependencies: {}, dsh: { profile: { bundles: [] } } }))
  const plugin = join(profile, 'node_modules', current.name)
  put(join(plugin, 'package.json'), JSON.stringify(metadata))
  put(join(plugin, 'bin/dscode.mjs'), '#!/usr/bin/env node\nconsole.log("tuple ready");\n', 0o755)
  put(join(profile, 'bin/dscode'), `#!/bin/sh\necho 'dscode ${current.version}'\n`, 0o755)
  const runtime = join(profile, 'runtime')
  put(join(runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), `#!/bin/sh\necho '${current.dsh.testedVersion}'\n`, 0o755)
  mkdirSync(join(runtime, 'bin'), { recursive: true })
  symlinkSync('../node_modules/@deepseek-ai/dsh/lib/bin.js', join(runtime, 'bin/dsh'))
  const descriptor = { schema: 1, platform: process.platform, arch: process.arch, sourceCommit: current.dsh.sourceCommit, dshVersion: current.dsh.testedVersion, sourcePatchSha256: current.dsh.sourcePatchSha256 }
  put(join(runtime, 'dscode-runtime.json'), JSON.stringify(descriptor))
  {
    const native = join(runtime, `node_modules/@deepseek-ai/node-addon-system-${process.platform}-${process.arch}`)
    put(join(native, 'bin/helper'), '#!/bin/sh\nexit 0\n', 0o755)
    put(join(native, 'prebuilds.json'), JSON.stringify({ platform: `${process.platform}-${process.arch}`, binaries: [{ path: 'bin/helper', kind: 'executable' }] }))
  }
  cpSync(plugin, join(remote, 'package'), { recursive: true })
  cpSync(runtime, join(remote, 'runtime'), { recursive: true, verbatimSymlinks: true })
  tar({ file: join(remote, 'dscode-plugin.tgz'), cwd: remote, gzip: true, sync: true }, ['package'])
  const asset = process.platform === 'darwin' ? 'dscode-macos-aarch64' : 'dscode-linux-x86_64'
  cpSync(join(profile, 'bin/dscode'), join(remote, asset))
  tar({ file: join(remote, asset.replace('dscode-', 'dscode-runtime-') + '.tar.gz'), cwd: join(remote, 'runtime'), gzip: true, sync: true }, ['.'])
  for (const name of ['dscode-plugin.tgz', asset, asset.replace('dscode-', 'dscode-runtime-') + '.tar.gz']) {
    put(join(remote, name + '.sha256'), createHash('sha256').update(readFileSync(join(remote, name))).digest('hex'))
  }
  const shim = join(root, 'network.mjs'), requests = join(root, 'requests')
  put(shim, `import {readFileSync,appendFileSync,existsSync} from 'node:fs';
globalThis.fetch = async url => {
  appendFileSync(${JSON.stringify(requests)}, String(url) + '\\n');
  if (String(url).startsWith('https://api.github.com/repos/HQ1995/deepseek-code/releases?'))
    return new Response(JSON.stringify([{tag_name:'v${current.version}',draft:false}]));
  const base = 'https://github.com/HQ1995/deepseek-code/releases/download/v${current.version}/';
  if (!String(url).startsWith(base)) throw Error('unexpected network access');
  const file = ${JSON.stringify(remote)} + '/' + String(url).slice(base.length);
  return existsSync(file) ? new Response(readFileSync(file)) : new Response('', {status:404});
};`)
  const run = (args: string[], overrides: NodeJS.ProcessEnv = {}, timeout = 20000) => spawnSync(process.execPath, ['--import', shim, join(root, 'launcher/bin/dscode.mjs'), ...args], {
    encoding: 'utf8', timeout,
    env: fixtureEnvironment(root, { DSH_HOME: join(root, 'home'), DSCODE_HOME: profile, ...overrides }),
  })
  return { root, profile, plugin, runtime, remote, descriptor, metadata, put, run, requests }
}

it.each(['old bridge', 'old runtime', 'old bridge patch', 'old runtime patch', 'missing TUI', 'missing native', 'wrong TUI version', 'wrong CLI version'])('reconciles an existing npx installation as a complete tuple: %s', scenario => {
  const f = fixture()
  try {
    if (scenario === 'old bridge') f.put(join(f.plugin, 'package.json'), JSON.stringify({ ...f.metadata, version: '0.0.1' }))
    if (scenario === 'old runtime') f.put(join(f.runtime, 'dscode-runtime.json'), JSON.stringify({ ...f.descriptor, sourceCommit: 'a'.repeat(40) }))
    const oldPatch = current.dsh.sourcePatchSha256 ? undefined : 'a'.repeat(64)
    if (scenario === 'old bridge patch') f.put(join(f.plugin, 'package.json'), JSON.stringify({ ...f.metadata, dsh: { ...current.dsh, sourcePatchSha256: oldPatch } }))
    if (scenario === 'old runtime patch') f.put(join(f.runtime, 'dscode-runtime.json'), JSON.stringify({ ...f.descriptor, sourcePatchSha256: oldPatch }))
    if (scenario === 'missing TUI') rmSync(join(f.profile, 'bin/dscode'))
    if (scenario === 'missing native') rmSync(join(f.runtime, `node_modules/@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/bin/helper`))
    if (scenario === 'wrong TUI version') f.put(join(f.profile, 'bin/dscode'), '#!/bin/sh\necho "dscode 0.0.1"\n', 0o755)
    if (scenario === 'wrong CLI version') f.put(join(f.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), '#!/bin/sh\necho "0.0.1"\n', 0o755)
    if (scenario.startsWith('wrong')) {
      expect(installationFilesMatch(f.profile, current.name, current.version, current.dsh)).toBe(true)
      expect(installationMatches(f.profile, current.name, current.version, current.dsh)).toBe(false)
    }
    const result = f.run([])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('tuple ready')
    expect(installationMatches(f.profile, current.name, current.version, current.dsh)).toBe(true)
    expect(readFileSync(f.requests, 'utf8')).toContain('dscode-runtime-')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

const trackProbes = (f: ReturnType<typeof fixture>) => {
  const probes = join(f.root, 'version-probes')
  f.put(join(f.profile, 'bin/dscode'), `#!/bin/sh
if [ "$1" = '--version' ]; then
  echo TUI >> '${probes}'
  echo 'dscode ${current.version}'
else
  echo BOOT_READY
fi
`, 0o755)
  f.put(join(f.runtime, 'node_modules/@deepseek-ai/dsh/lib/bin.js'), `#!/bin/sh
echo DSH >> '${probes}'
echo '${current.dsh.testedVersion}'
`, 0o755)
  return probes
}

it('probes healthy managed executables once and leaves the profile manifest unchanged', () => {
  const f = fixture()
  try {
    const probes = trackProbes(f)
    const manifest = join(f.profile, 'package.json')
    const contents = JSON.stringify({ private: true, dsh: { profile: { bundles: [current.name] } } })
    f.put(manifest, contents)
    utimesSync(manifest, 1234567890, 1234567890)
    const mtime = statSync(manifest).mtimeMs
    const result = f.run([])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('BOOT_READY')
    expect(readFileSync(probes, 'utf8').trim().split('\n')).toEqual(['TUI', 'DSH'])
    expect(existsSync(f.requests)).toBe(false)
    expect(readFileSync(manifest, 'utf8')).toBe(contents)
    expect(statSync(manifest).mtimeMs).toBe(mtime)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('does not probe executables or fetch releases while another process holds the profile lock', async () => {
  const f = fixture()
  try {
    const probes = trackProbes(f)
    await withProfileLock(f.profile, () => {
      const result = f.run([], {}, 1000)
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('waiting for the current profile update')
      expect(existsSync(probes)).toBe(false)
      expect(existsSync(f.requests)).toBe(false)
    })
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('still checks an explicit DSH_BIN after validating the managed runtime', () => {
  const f = fixture()
  try {
    const probes = trackProbes(f)
    const override = join(f.root, 'custom-dsh')
    f.put(override, '#!/bin/sh\necho "0.0.1"\n', 0o755)
    const result = f.run([], { DSH_BIN: override })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain(`DSH_BIN reports 0.0.1, expected ${current.dsh.testedVersion}`)
    expect(result.stdout).not.toContain('BOOT_READY')
    expect(readFileSync(probes, 'utf8').trim().split('\n')).toEqual(['TUI', 'DSH'])
    expect(existsSync(f.requests)).toBe(false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('leaves the entire old installation intact when rebootstrap downloads fail verification', () => {
  const f = fixture()
  try {
    const old = JSON.stringify({ ...f.metadata, version: '0.0.1' })
    f.put(join(f.plugin, 'package.json'), old)
    f.put(join(f.remote, 'dscode-plugin.tgz.sha256'), '0'.repeat(64))
    const result = f.run([])
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('SHA-256 mismatch')
    expect(readFileSync(join(f.plugin, 'package.json'), 'utf8')).toBe(old)
    expect(JSON.parse(readFileSync(join(f.runtime, 'dscode-runtime.json'), 'utf8'))).toEqual(f.descriptor)
    expect(existsSync(join(f.profile, 'bin/dscode'))).toBe(true)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['manual', 'manual dev', 'auto', 'auto stale target', 'force', 'repair', 'native repair', 'auto disabled'])('handles a same-version update without unnecessary installation: %s', scenario => {
  const f = fixture()
  try {
    if (scenario === 'repair') rmSync(join(f.runtime, 'bin/dsh'))
    if (scenario === 'native repair') rmSync(join(f.runtime, `node_modules/@deepseek-ai/node-addon-system-${process.platform}-${process.arch}/bin/helper`))
    if (scenario === 'manual dev') f.put(join(f.profile, 'bin/dscode'), `#!/bin/sh\necho 'dscode ${current.version}-dev'\n`, 0o755)
    if (scenario === 'auto disabled') f.put(join(f.profile, 'config.toml'), '[cli]\nauto_update=false\n')
    const args = ['update', '--alpha', ...(scenario.startsWith('auto') ? ['--auto'] : []), ...(scenario === 'force' ? ['--force'] : []), ...(scenario === 'auto stale target' ? ['--version', '0.0.1-alpha.1'] : [])]
    const result = f.run(args)
    expect(result.status, result.stderr).toBe(0)
    const requests = existsSync(f.requests) ? readFileSync(f.requests, 'utf8') : ''
    if (scenario === 'auto disabled') expect(requests).toBe('')
    else if (scenario === 'force' || scenario === 'repair' || scenario === 'native repair' || scenario === 'manual dev') {
      expect(requests).toContain('dscode-runtime-')
      expect(installationMatches(f.profile, current.name, current.version)).toBe(true)
    } else {
      expect(requests).not.toContain('/releases/download/')
      expect(result.stdout).toContain('already up to date')
      expect(readFileSync(join(f.profile, 'config.toml'), 'utf8')).toContain('alpha')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('preserves an unchanged channel config byte for byte during forced reinstall', () => {
  const f = fixture()
  try {
    const path = join(f.profile, 'config.toml')
    const config = '# user notes\n[cli]\nchannel = "alpha"\nchannel_format = 1\nauto_update = false\n'
    f.put(path, config, 0o600)
    const inode = lstatSync(path).ino
    const result = f.run(['update', '--alpha', '--force'])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(path, 'utf8')).toBe(config)
    expect(lstatSync(path).ino).toBe(inode)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it.each(['launch', 'background update'])('keeps a developer TUI during %s without downloading', scenario => {
  const f = fixture()
  try {
    const binary = `#!/bin/sh\necho 'dscode ${current.version}-dev'\n`
    f.put(join(f.profile, 'bin/dscode'), binary, 0o755)
    const result = f.run(scenario === 'launch' ? [] : ['update', '--auto', '--alpha'])
    expect(result.status, result.stderr).toBe(0)
    expect(readFileSync(join(f.profile, 'bin/dscode'), 'utf8')).toBe(binary)
    expect(existsSync(f.requests)).toBe(false)
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('lets normal startup repair native damage before the stable entrypoint loads a lock binding', () => {
  const f = fixture()
  try {
    cpSync(join(bridge, 'bin/bootstrap.mjs'), join(f.profile, 'dscode.mjs'))
    f.put(join(f.plugin, 'bin/update.mjs'), 'export const withProfileLock = async () => { throw Error("native binding missing") }; export const RECOVERY_VERSION = 1;\n')
    f.put(join(f.plugin, 'bin/dscode.mjs'), 'export const main = async () => { console.log("native repair admitted") };\n')
    const result = spawnSync(process.execPath, [join(f.profile, 'dscode.mjs')], {
      encoding: 'utf8', timeout: 5000,
      env: fixtureEnvironment(f.root, { DSCODE_HOME: f.profile }),
    })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('native repair admitted')
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})

it('recovers through the stable entrypoint after interruption while the plugin directory is absent', async () => {
  const f = fixture()
  // The crash worker's active profile and the real launcher share this exact owned fixture.
  const root = join(f.root, 'crash'), profile = join(root, 'active')
  mkdirSync(root)
  const unrelatedJournal = join(root, '.dscode-update-unrecognized', 'transaction.json')
  f.put(unrelatedJournal, '{unrecognized staging data')
  cpSync(f.profile, profile, { recursive: true, verbatimSymlinks: true })
  const plugin = join(profile, 'node_modules', current.name)
  cpSync(join(bridge, 'bin'), join(plugin, 'bin'), { recursive: true })
  symlinkSync(join(bridge, 'node_modules'), join(plugin, 'node_modules'))
  cpSync(join(bridge, 'bin/bootstrap.mjs'), join(profile, 'dscode.mjs'))
  f.put(join(profile, 'config.toml'), '[cli]\nchannel="alpha"\nchannel_format=1\n')
  f.put(join(profile, 'sessions/user'), 'preserved session')
  const stage = join(root, '.dscode-update-crash')
  cpSync(profile, join(stage, 'profile'), { recursive: true, verbatimSymlinks: true })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/update-worker.mjs', import.meta.url)), root, 'crash', new URL('../bin/update.mjs', import.meta.url).href], {
    env: fixtureEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  try {
    for (let attempt = 0; !existsSync(join(root, 'paused')); attempt++) {
      if (attempt > 500 || child.exitCode !== null) throw new Error('updater did not reach the interruption point')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(existsSync(join(plugin, 'bin/dscode.mjs'))).toBe(false)
    child.kill('SIGKILL')
    await exited
    const recovered = spawnSync(process.execPath, [join(profile, 'dscode.mjs'), 'doctor', '--runtime', '--json'], {
      env: fixtureEnvironment(f.root, { DSCODE_HOME: profile }), encoding: 'utf8', timeout: 20000,
    })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stderr).toContain('restored the previous installation')
    expect(JSON.parse(recovered.stdout).filter((finding: { status: string }) => finding.status === 'ERROR')).toEqual([])
    expect(readFileSync(join(profile, 'sessions/user'), 'utf8')).toBe('preserved session')
    expect(existsSync(stage)).toBe(false)
    expect(readFileSync(unrelatedJournal, 'utf8')).toBe('{unrecognized staging data')
    expect(installationMatches(profile, current.name, current.version, current.dsh)).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    rmSync(f.root, { recursive: true, force: true })
  }
})

it('recovers an interrupted update when the profile path is a symlink in another directory', async () => {
  const f = fixture()
  const realRoot = join(f.root, 'canonical-parent'), linkRoot = join(f.root, 'symlink-parent')
  const canonical = join(realRoot, 'active'), profile = join(linkRoot, 'active')
  mkdirSync(realRoot); mkdirSync(linkRoot)
  const unrelatedJournal = join(linkRoot, '.dscode-update-unrecognized', 'transaction.json')
  f.put(unrelatedJournal, '{unrecognized staging data')
  cpSync(f.profile, canonical, { recursive: true, verbatimSymlinks: true })
  symlinkSync(canonical, profile)
  const plugin = join(canonical, 'node_modules', current.name)
  cpSync(join(bridge, 'bin'), join(plugin, 'bin'), { recursive: true })
  symlinkSync(join(bridge, 'node_modules'), join(plugin, 'node_modules'))
  cpSync(join(bridge, 'bin/bootstrap.mjs'), join(canonical, 'dscode.mjs'))
  f.put(join(canonical, 'config.toml'), '[cli]\nchannel="alpha"\nchannel_format=1\n')
  f.put(join(canonical, 'sessions/user'), 'preserved session')
  const stage = join(linkRoot, '.dscode-update-crash')
  cpSync(canonical, join(stage, 'profile'), { recursive: true, verbatimSymlinks: true })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/update-worker.mjs', import.meta.url)), linkRoot, 'crash', new URL('../bin/update.mjs', import.meta.url).href], {
    env: fixtureEnvironment(f.root), stdio: ['ignore', 'pipe', 'pipe'],
  })
  const exited = once(child, 'exit')
  try {
    for (let attempt = 0; !existsSync(join(linkRoot, 'paused')); attempt++) {
      if (attempt > 500 || child.exitCode !== null) throw new Error('updater did not reach the interruption point')
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    expect(existsSync(join(plugin, 'bin/dscode.mjs'))).toBe(false)
    child.kill('SIGKILL')
    await exited
    const recovered = spawnSync(process.execPath, [join(profile, 'dscode.mjs'), 'doctor', '--runtime', '--json'], {
      env: fixtureEnvironment(f.root, { DSCODE_HOME: profile }), encoding: 'utf8', timeout: 20000,
    })
    expect(recovered.status, recovered.stderr).toBe(0)
    expect(recovered.stderr).toContain('restored the previous installation')
    expect(JSON.parse(recovered.stdout).filter((finding: { status: string }) => finding.status === 'ERROR')).toEqual([])
    expect(readFileSync(join(canonical, 'sessions/user'), 'utf8')).toBe('preserved session')
    expect(existsSync(stage)).toBe(false)
    expect(readFileSync(unrelatedJournal, 'utf8')).toBe('{unrecognized staging data')
    expect(installationMatches(canonical, current.name, current.version, current.dsh)).toBe(true)
  } finally {
    if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited }
    rmSync(f.root, { recursive: true, force: true })
  }
})
