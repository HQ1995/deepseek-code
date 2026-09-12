import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { create as tar } from 'tar'
import { expect, it } from 'vitest'
import { installationMatches } from '../bin/update.mjs'

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
  const descriptor = { schema: 1, platform: process.platform, arch: process.arch, sourceCommit: current.dsh.sourceCommit, dshVersion: current.dsh.testedVersion }
  put(join(runtime, 'dscode-runtime.json'), JSON.stringify(descriptor))
  if (process.platform === 'linux') {
    const native = join(runtime, `node_modules/@deepseek-ai/node-addon-system-linux-${process.arch}`)
    put(join(native, 'bin/helper'), '#!/bin/sh\nexit 0\n', 0o755)
    put(join(native, 'prebuilds.json'), JSON.stringify({ binaries: [{ path: 'bin/helper', kind: 'static-musl' }] }))
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
  const run = (args: string[]) => spawnSync(process.execPath, ['--import', shim, join(root, 'launcher/bin/dscode.mjs'), ...args], {
    encoding: 'utf8', timeout: 20000,
    env: { ...process.env, HOME: root, DSH_HOME: join(root, 'home'), DSCODE_HOME: profile, DSCODE_BIN: '', DSH_BIN: '' },
  })
  return { root, profile, plugin, runtime, remote, descriptor, metadata, put, run, requests }
}

it.each(['old bridge', 'old runtime', 'missing TUI'])('reconciles an existing npx installation as a complete tuple: %s', scenario => {
  const f = fixture()
  try {
    if (scenario === 'old bridge') f.put(join(f.plugin, 'package.json'), JSON.stringify({ ...f.metadata, version: '0.0.1' }))
    if (scenario === 'old runtime') f.put(join(f.runtime, 'dscode-runtime.json'), JSON.stringify({ ...f.descriptor, sourceCommit: 'a'.repeat(40) }))
    if (scenario === 'missing TUI') rmSync(join(f.profile, 'bin/dscode'))
    const result = f.run([])
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('tuple ready')
    expect(installationMatches(f.profile, current.name, current.version, current.dsh)).toBe(true)
    expect(readFileSync(f.requests, 'utf8')).toContain('dscode-runtime-')
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

it.each(['manual', 'manual dev', 'auto', 'auto stale target', 'force', 'repair', 'auto disabled'])('handles a same-version update without unnecessary installation: %s', scenario => {
  const f = fixture()
  try {
    if (scenario === 'repair') rmSync(join(f.runtime, 'bin/dsh'))
    if (scenario === 'manual dev') f.put(join(f.profile, 'bin/dscode'), `#!/bin/sh\necho 'dscode ${current.version}-dev'\n`, 0o755)
    if (scenario === 'auto disabled') f.put(join(f.profile, 'config.toml'), '[cli]\nauto_update=false\n')
    const args = ['update', '--alpha', ...(scenario.startsWith('auto') ? ['--auto'] : []), ...(scenario === 'force' ? ['--force'] : []), ...(scenario === 'auto stale target' ? ['--version', '0.0.1-alpha.1'] : [])]
    const result = f.run(args)
    expect(result.status, result.stderr).toBe(0)
    const requests = existsSync(f.requests) ? readFileSync(f.requests, 'utf8') : ''
    if (scenario === 'auto disabled') expect(requests).toBe('')
    else if (scenario === 'force' || scenario === 'repair' || scenario === 'manual dev') {
      expect(requests).toContain('dscode-runtime-')
      expect(installationMatches(f.profile, current.name, current.version)).toBe(true)
    } else {
      expect(requests).not.toContain('/releases/download/')
      expect(result.stdout).toContain('already up to date')
      expect(readFileSync(join(f.profile, 'config.toml'), 'utf8')).toContain('alpha')
    }
  } finally { rmSync(f.root, { recursive: true, force: true }) }
})
