#!/usr/bin/env node
// Actual launcher subprocesses against a local release server. No user profile or publication.
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFile } from 'node:child_process'
import { createServer } from 'node:http'
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { promisify, parseArgs } from 'node:util'
import { pathToFileURL } from 'node:url'

const execute = promisify(execFile)
const { values } = parseArgs({ options: { plugin: { type: 'string' }, runtime: { type: 'string' }, tui: { type: 'string' }, keep: { type: 'boolean' } } })
assert.ok(values.plugin && values.runtime && values.tui, 'Use --plugin <built dscode-plugin.tgz> --runtime <built runtime.tar.gz> --tui <matching compiled TUI>')
const root = await mkdtemp(join(tmpdir(), 'dscode-channel-e2e-'))
const home = join(root, 'home'), profile = join(home, '.dsh/profiles/dscode')
const packageName = '@hqzhao95/dscode'
const plugin = join(profile, 'node_modules', packageName)
const source = join(root, 'source')
await mkdir(source, { recursive: true })
await execute('tar', ['-xzf', resolve(values.plugin), '-C', source])
const original = JSON.parse(await readFile(join(source, 'package/package.json'), 'utf8'))
assert.equal(original.name, packageName)
const require = createRequire(join(source, 'package/package.json'))
const { parse } = await import(pathToFileURL(require.resolve('smol-toml')).href)
const platform = { 'linux/x64': 'linux-x86_64', 'darwin/arm64': 'macos-aarch64' }[`${process.platform}/${process.arch}`]
assert.ok(platform, 'Unsupported acceptance host')
const asset = `dscode-${platform}`, runtimeName = `dscode-runtime-${platform}.tar.gz`
const runtimeBytes = await readFile(resolve(values.runtime))
const releases = new Map(), assets = new Map(), requests = []
const digest = bytes => createHash('sha256').update(bytes).digest('hex')
const put = (version, name, bytes) => {
  assets.set(`${version}/${name}`, bytes)
  assets.set(`${version}/${name}.sha256`, Buffer.from(`${digest(bytes)}  ${name}\n`))
}
const banner = version => Buffer.from(`#!/bin/sh\nprintf '%s\\n' 'dscode ${version} (controlled release fixture)'\n`)
async function release(version) {
  const directory = join(root, version)
  await mkdir(directory)
  await cp(join(source, 'package'), join(directory, 'package'), { recursive: true })
  const manifest = { ...original, version, dscode: { ...original.dscode, release: version } }
  await writeFile(join(directory, 'package/package.json'), JSON.stringify(manifest))
  const archive = join(directory, 'plugin.tgz')
  await execute('tar', ['-czf', archive, '-C', directory, 'package'])
  put(version, 'dscode-plugin.tgz', await readFile(archive))
  put(version, asset, banner(version))
  put(version, runtimeName, runtimeBytes)
  releases.set(version, { tag_name: `v${version}`, draft: false, prerelease: version.includes('-') })
}
const stable = '0.0.13', beta = '0.0.14-beta.2', alpha = '0.0.15-alpha.3'
await release(stable)
await release(beta)
await release(alpha)
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture')
  requests.push(url.pathname + url.search)
  if (url.pathname.endsWith('/releases')) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify(url.searchParams.get('page') === '1' ? [...releases.values()] : []))
    return
  }
  const version = url.pathname.split('/releases/tags/v')[1]
  if (version && releases.has(version)) {
    response.setHeader('content-type', 'application/json')
    response.end(JSON.stringify({ ...releases.get(version), assets: [{ name: 'dscode-plugin.tgz', browser_download_url: `https://github.com/HQ1995/deepseek-code/releases/download/v${version}/dscode-plugin.tgz`, digest: `sha256:${digest(assets.get(`${version}/dscode-plugin.tgz`))}` }] }))
    return
  }
  const key = url.pathname.split('/releases/download/v')[1]
  const bytes = assets.get(key)
  response.writeHead(bytes ? 200 : 404)
  response.end(bytes ?? 'missing controlled asset')
})
await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
const address = server.address()
const origin = `http://127.0.0.1:${address.port}`
const hook = join(root, 'release-network.mjs')
await writeFile(hook, `const original = globalThis.fetch;\nglobalThis.fetch = (input, options) => {\n  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n  if (!['api.github.com', 'github.com'].includes(url.hostname)) throw new Error('Unexpected external fetch: ' + url);\n  return original(new URL(url.pathname + url.search, process.env.DSCODE_TEST_RELEASE_ORIGIN), options);\n};\n`)
const env = { ...process.env, HOME: home, DSH_HOME: join(home, '.dsh'), DSC_HOME: profile, DSCODE_HOME: profile, DSCODE_TEST_RELEASE_ORIGIN: origin, NODE_OPTIONS: `--import=${pathToFileURL(hook).href}`, NPM_CONFIG_OFFLINE: 'true', NPM_CONFIG_CACHE: join(root, 'npm-cache'), NPM_CONFIG_USERCONFIG: join(root, 'npmrc'), DSH_TELEMETRY_DISABLED: '1', NO_COLOR: '1' }
for (const key of ['DSH_BIN', 'DSCODE_BIN', 'DSCODE_PACKAGE_RECONCILED', 'DSCODE_MANAGED_LAUNCHER', 'DSCODE_LEGACY_BIN', 'NODE_COMPILE_CACHE']) delete env[key]
await writeFile(env.NPM_CONFIG_USERCONFIG, '')
const launcher = () => join(plugin, 'bin/dscode.mjs')
async function invoke(args, succeeds = true) {
  try {
    const result = await execute(process.execPath, [launcher(), ...args], { env, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
    assert.ok(succeeds, `Expected failure: ${args.join(' ')}`)
    return result
  } catch (error) {
    if (succeeds || error.code === undefined) throw error
    assert.equal(typeof error.code, 'number', 'The updater must exit, not hang or be killed')
    return error
  }
}
async function snapshot() {
  const entries = []
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await walk(path)
      else {
        const info = await stat(path)
        entries.push([path.slice(profile.length), info.size, info.mtimeMs, info.mode])
      }
    }
  }
  await walk(profile)
  const exact = {}
  for (const file of ['config.toml', 'package.json', 'bin/dscode', 'sessions/retained.txt', 'node_modules/user-plugin/retained.txt', `node_modules/${packageName}/package.json`, 'runtime/dscode-runtime.json']) exact[file] = digest(await readFile(join(profile, file)))
  return { entries: entries.sort((a, b) => a[0].localeCompare(b[0])), exact }
}
async function unchanged(action) {
  const before = await snapshot()
  await action()
  assert.deepEqual(await snapshot(), before, 'Active installation or user data changed')
}
const checks = []
async function check(label, action) { await action(); checks.push(label); console.log(`PASS ${label}`) }
let passed = false
try {
  await mkdir(dirname(plugin), { recursive: true })
  await cp(join(source, 'package'), plugin, { recursive: true })
  const bootstrapVersion = '0.0.13-beta.1'
  await writeFile(join(plugin, 'package.json'), JSON.stringify({ ...original, version: bootstrapVersion, dscode: { release: bootstrapVersion } }))
  await mkdir(join(profile, 'bin'), { recursive: true })
  await writeFile(join(profile, 'bin/dscode'), banner(bootstrapVersion), { mode: 0o755 })
  await mkdir(join(profile, 'runtime'))
  await execute('tar', ['-xzf', resolve(values.runtime), '-C', join(profile, 'runtime')])
  await mkdir(join(profile, 'sessions'))
  await mkdir(join(profile, 'node_modules/user-plugin'))
  await writeFile(join(profile, 'sessions/retained.txt'), 'durable user session; never update this\n')
  await writeFile(join(profile, 'node_modules/user-plugin/retained.txt'), 'unrelated installed plugin\n')
  await writeFile(join(profile, 'node_modules/user-plugin/package.json'), '{"name":"user-plugin","version":"1.0.0"}\n')
  await writeFile(join(profile, 'package.json'), JSON.stringify({ name: 'dsh-profile-dscode', private: true, dependencies: { [packageName]: bootstrapVersion, 'user-plugin': '1.0.0' }, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', packageName, 'user-plugin'] } } }))
  await writeFile(join(profile, 'config.toml'), '[cli]\nchannel = "alpha"\nauto_update = false\n[ui]\ncompact_mode = true\n')
  await check('legacy preview stays beta and check is read-only', () => unchanged(async () => {
    const report = JSON.parse((await invoke(['update', '--check', '--json'])).stdout)
    assert.deepEqual(Object.keys(report).sort(), ['autoUpdate', 'channel', 'currentVersion', 'error', 'installer', 'latestVersion', 'updateAvailable'])
    assert.equal(report.installer, 'dscode')
    assert.equal(report.autoUpdate, false)
    assert.equal(report.error, null)
    assert.equal(report.updateAvailable, true)
    assert.equal(report.channel, 'beta')
    assert.equal(report.latestVersion, beta)
  }))
  await check('explicit alpha check selects alpha without persisting it', () => unchanged(async () => {
    const report = JSON.parse((await invoke(['update', '--alpha', '--check', '--json'])).stdout)
    assert.equal(report.channel, 'alpha')
    assert.equal(report.latestVersion, alpha)
  }))
  await check('empty release listing returns a read-only structured error', () => unchanged(async () => {
    const saved = [...releases]
    releases.clear()
    try {
      const report = JSON.parse((await invoke(['update', '--alpha', '--check', '--json'])).stdout)
      assert.equal(report.latestVersion, null)
      assert.equal(report.updateAvailable, false)
      assert.match(report.error, /no release available/)
    } finally { for (const [version, release] of saved) releases.set(version, release) }
  }))
  await check('alpha installs one exact product and source runtime', async () => {
    await invoke(['update', '--alpha'])
    assert.equal(JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).version, alpha)
    assert.match((await execute(join(profile, 'bin/dscode'), ['--version'])).stdout, new RegExp(alpha.replaceAll('.', '\\.')))
    const settings = parse(await readFile(join(profile, 'config.toml'), 'utf8'))
    assert.equal(settings.cli.channel, 'alpha')
    assert.equal(settings.cli.channel_format, 1)
    assert.equal(settings.ui.compact_mode, true)
    const runtime = JSON.parse(await readFile(join(profile, 'runtime/dscode-runtime.json'), 'utf8'))
    assert.equal(runtime.sourceCommit, original.dsh.sourceCommit)
    assert.equal(runtime.dshVersion, original.dsh.testedVersion)
    assert.equal((await execute(join(profile, 'runtime/bin/dsh'), ['--version'], { env })).stdout.trim(), original.dsh.testedVersion)
    assert.equal(await readFile(join(profile, 'node_modules/user-plugin/retained.txt'), 'utf8'), 'unrelated installed plugin\n')
  })
  await check('default update check follows the saved alpha lane', () => unchanged(async () => {
    const report = JSON.parse((await invoke(['update', '--check', '--json'])).stdout)
    assert.equal(report.channel, 'alpha')
    assert.equal(report.currentVersion, alpha)
    assert.equal(report.latestVersion, alpha)
  }))
  await check('historical plugin without sidecar uses verified GitHub asset digest', async () => {
    const checksum = assets.get(`${alpha}/dscode-plugin.tgz.sha256`)
    assets.delete(`${alpha}/dscode-plugin.tgz.sha256`)
    requests.length = 0
    await invoke(['update', '--version', alpha, '--alpha'])
    assert.ok(requests.some(path => path.endsWith(`/releases/tags/v${alpha}`)))
    assert.equal(JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).version, alpha)
    assets.set(`${alpha}/dscode-plugin.tgz.sha256`, checksum)
  })
  const broken = '0.0.16-alpha.1'
  await release(broken)
  await check('invalid plugin checksum never falls back to release metadata', () => unchanged(async () => {
    const checksum = assets.get(`${broken}/dscode-plugin.tgz.sha256`)
    assets.set(`${broken}/dscode-plugin.tgz.sha256`, Buffer.from('0'.repeat(64)))
    requests.length = 0
    const result = await invoke(['update', '--alpha'], false)
    assert.match(result.stderr, /SHA-256 mismatch/)
    assert.ok(!requests.some(path => path.includes('/releases/tags/')))
    assets.set(`${broken}/dscode-plugin.tgz.sha256`, checksum)
  }))
  await check('checksum failure retains old tuple and channel', () => unchanged(async () => {
    assets.set(`${broken}/${asset}.sha256`, Buffer.from('0'.repeat(64)))
    const result = await invoke(['update', '--alpha'], false)
    assert.match(result.stderr, /SHA-256 mismatch/)
  }))
  put(broken, asset, banner(broken))
  await check('missing runtime retains old tuple and channel', () => unchanged(async () => {
    assets.delete(`${broken}/${runtimeName}`)
    const result = await invoke(['update', '--alpha'], false)
    assert.match(result.stderr, /missing release asset/)
  }))
  put(broken, runtimeName, runtimeBytes)
  await check('mismatched TUI version retains old tuple and channel', () => unchanged(async () => {
    put(broken, asset, banner('0.0.1'))
    const result = await invoke(['update', '--alpha'], false)
    assert.match(result.stderr, /TUI product version mismatch/)
  }))
  put(broken, asset, banner(broken))
  await check('wrong runtime provenance retains old tuple and channel', () => unchanged(async () => {
    const wrong = join(root, 'wrong-runtime')
    await mkdir(wrong)
    await writeFile(join(wrong, 'dscode-runtime.json'), JSON.stringify({ schema: 1, dshVersion: original.dsh.testedVersion, sourceCommit: '0'.repeat(40), platform: process.platform, arch: process.arch }))
    const archive = join(root, 'wrong-runtime.tgz')
    await execute('tar', ['-czf', archive, '-C', wrong, '.'])
    put(broken, runtimeName, await readFile(archive))
    const result = await invoke(['update', '--alpha'], false)
    assert.match(result.stderr, /runtime provenance\/platform mismatch/)
  }))
  releases.delete(broken)
  await check('beta switch excludes the higher alpha release', async () => {
    await unchanged(async () => {
      const report = JSON.parse((await invoke(['update', '--beta', '--check', '--json'])).stdout)
      assert.equal(report.latestVersion, beta)
      assert.equal(report.updateAvailable, true, 'An explicit lane switch can select an older version')
    })
    await invoke(['update', '--beta'])
    assert.equal(JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).version, beta)
    assert.equal(parse(await readFile(join(profile, 'config.toml'), 'utf8')).cli.channel, 'beta')
  })
  await check('stable downgrade preserves sessions and unrelated plugins', async () => {
    await invoke(['update', '--stable'])
    assert.equal(JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).version, stable)
    assert.equal(parse(await readFile(join(profile, 'config.toml'), 'utf8')).cli.channel, 'stable')
    assert.equal(await readFile(join(profile, 'sessions/retained.txt'), 'utf8'), 'durable user session; never update this\n')
    assert.equal(await readFile(join(profile, 'node_modules/user-plugin/retained.txt'), 'utf8'), 'unrelated installed plugin\n')
  })
  await check('explicit target does not resolve latest again', async () => {
    requests.length = 0
    await invoke(['update', '--version', alpha, '--alpha'])
    assert.ok(!requests.some(path => path.includes('/releases?')), 'Exact target performed another release lookup')
    assert.equal(JSON.parse(await readFile(join(plugin, 'package.json'), 'utf8')).version, alpha)
  })
  await check('cold npm bootstrap installs the real matching TUI and source runtime', async () => {
    await release(original.version)
    put(original.version, asset, await readFile(resolve(values.tui)))
    const coldHome = join(root, 'cold-home'), coldProfile = join(coldHome, '.dsh/profiles/dscode')
    await mkdir(coldHome)
    const coldEnv = { ...env, HOME: coldHome, DSH_HOME: join(coldHome, '.dsh'), DSC_HOME: coldProfile, DSCODE_HOME: coldProfile, NPM_CONFIG_CACHE: join(coldHome, 'npm-cache') }
    const result = await execute('npm', ['exec', '--offline', '--yes', `--package=${resolve(values.plugin)}`, '--', 'dscode', '--version'], { cwd: coldHome, env: coldEnv, timeout: 180000, maxBuffer: 4 * 1024 * 1024 })
    assert.match(result.stdout, new RegExp(`dscode ${original.version.replaceAll('.', '\\.')}`))
    assert.equal(JSON.parse(await readFile(join(coldProfile, 'node_modules', packageName, 'package.json'), 'utf8')).version, original.version)
    assert.equal(digest(await readFile(join(coldProfile, 'bin/dscode'))), digest(await readFile(resolve(values.tui))))
    assert.equal(JSON.parse(await readFile(join(coldProfile, 'runtime/dscode-runtime.json'), 'utf8')).sourceCommit, original.dsh.sourceCommit)
    assert.equal((await execute(join(coldProfile, 'runtime/bin/dsh'), ['--version'], { env: coldEnv })).stdout.trim(), original.dsh.testedVersion)
  })
  await writeFile(join(root, 'PASS.json'), JSON.stringify({ checks, sourceCommit: original.dsh.sourceCommit, dshVersion: original.dsh.testedVersion, profile }, null, 2) + '\n')
  passed = true
  console.log(`PASS independent update channels (${checks.length} cases): ${root}`)
} finally {
  await new Promise(resolveClose => server.close(resolveClose))
  if (passed && !values.keep) await rm(root, { recursive: true, force: true })
  else console.log(`Retained acceptance artifacts: ${root}`)
}
