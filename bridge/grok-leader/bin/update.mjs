import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { accessSync, chmodSync, constants, cpSync, createReadStream, createWriteStream, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createGunzip } from 'node:zlib'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { parse, stringify } from 'smol-toml'
import { list, extract as extractTar } from 'tar'

const repo = 'HQ1995/deepseek-code'
const versionPattern = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/
export const channelAccepts = (channel, version) => {
  const match = versionPattern.exec(version)
  return !!match && (!match[4] || (channel !== 'stable' && match[4].startsWith(`${channel}.`)))
}
export const compareVersions = (a, b) => {
  const left = versionPattern.exec(a), right = versionPattern.exec(b)
  if (!left || !right) throw new Error('invalid release version')
  for (let i = 1; i <= 3; i++) if (+left[i] !== +right[i]) return +left[i] - +right[i]
  if (!left[4] || !right[4]) return left[4] ? -1 : right[4] ? 1 : 0
  const x = left[4].split('.'), y = right[4].split('.')
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] === y[i]) continue
    if (x[i] === undefined) return -1
    if (y[i] === undefined) return 1
    const xn = /^\d+$/.test(x[i]), yn = /^\d+$/.test(y[i])
    if (xn && yn) return Number(x[i]) - Number(y[i])
    if (xn !== yn) return xn ? -1 : 1
    return x[i] < y[i] ? -1 : 1
  }
  return 0
}
/** Matches Rust needs_update(..., allow_downgrade=false), used by public checks. */
export const needsUpdateWithChannel = (current, target, channel) => {
  const comparison = compareVersions(target, current)
  if (!['stable', 'beta', 'alpha', 'enterprise'].includes(channel)) throw new Error(`unsupported release channel: ${channel}`)
  const lane = channel === 'enterprise' ? 'stable' : channel
  if (!channelAccepts(lane, target)) return false
  if (!channelAccepts(lane, current)) return true
  return comparison > 0
}
export const readChannelConfig = profile => {
  const path = join(profile, 'config.toml')
  const config = existsSync(path) ? parse(readFileSync(path, 'utf8')) : {}
  const channel = config.cli?.channel, format = config.cli?.channel_format
  if (channel !== undefined && !['stable', 'beta', 'alpha', 'enterprise'].includes(channel)) throw new Error(`invalid cli.channel: ${channel}`)
  if (format !== undefined && (!Number.isInteger(format) || ![0, 1].includes(format))) throw new Error(`invalid cli.channel_format: ${format}`)
  return { config, channel: channel === 'alpha' && format !== 1 ? 'beta' : channel }
}
export const updateOptions = (args, profile, currentVersion) => {
  const { config, channel: saved } = readChannelConfig(profile)
  const channels = ['stable', 'beta', 'alpha', 'enterprise'].filter(value => args.includes(`--${value}`))
  if (channels.length > 1) throw new Error('choose only one of --stable, --beta, --alpha, --enterprise')
  let version
  let trigger = args.includes('--auto') ? 'auto_background' : 'user_command'
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === '--version' || arg.startsWith('--version=')) {
      if (version !== undefined) throw new Error('duplicate --version')
      version = (arg === '--version' ? args[++i] : arg.slice(10))?.replace(/^v/, '')
      if (!version || !versionPattern.test(version)) throw new Error('invalid --version')
    } else if (arg === '--trigger' || arg.startsWith('--trigger=')) {
      trigger = arg === '--trigger' ? args[++i] : arg.slice('--trigger='.length)
      if (!['user_command', 'auto_background', 'leader_converge'].includes(trigger)) throw new Error('invalid --trigger')
    } else if (!['--stable', '--beta', '--alpha', '--enterprise', '--check', '--force', '--force-reinstall', '--json', '--debug', '--auto'].includes(arg)) throw new Error(`unknown update argument: ${arg}`)
  }
  return { channel: channels[0] ?? saved ?? /-(alpha|beta|enterprise)(?:\.|$)/.exec(currentVersion)?.[1] ?? 'stable', version, check: args.includes('--check'), json: args.includes('--json'), force: args.includes('--force') || args.includes('--force-reinstall'), trigger, autoUpdate: typeof config.cli?.auto_update === 'boolean' ? config.cli.auto_update : null }
}
export const resolveRelease = async ({ channel, version }, fetcher = fetch) => {
  if (version !== undefined) return version
  const versions = []
  for (let page = 1; ; page++) {
    const response = await fetcher(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, { signal: AbortSignal.timeout(120000) })
    if (!response.ok) throw new Error(`release lookup failed: ${response.status}`)
    const releases = await response.json()
    if (!Array.isArray(releases)) throw new Error('invalid release listing')
    for (const release of releases) {
      const candidate = release.tag_name?.replace(/^v/, '')
      if (!release.draft && typeof candidate === 'string' && channelAccepts(channel, candidate)) versions.push(candidate)
    }
    if (releases.length < 100) break
  }
  versions.sort(compareVersions)
  if (!versions.length) throw new Error(`no release available for ${channel}`)
  return versions.at(-1)
}
const json = path => JSON.parse(readFileSync(path, 'utf8'))
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: 'utf8', timeout: 600000, maxBuffer: 64 * 1024 * 1024, ...options })
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`)
  return result.stdout
}
const binaryVersion = path => /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(run(path, ['--version'], { timeout: 15000 }))?.[1]
const downloadVerified = async (base, name, dest, fetcher, compressed = false) => {
  let response = await fetcher(`${base}/${name}${compressed ? '.gz' : ''}`, { signal: AbortSignal.timeout(120000) })
  let gzip = compressed
  if (compressed && response.status === 404) { response = await fetcher(`${base}/${name}`); gzip = false }
  if (!response.ok) throw new Error(`missing release asset ${name}: ${response.status}`)
  if (!response.body) throw new Error(`empty release asset ${name}`)
  const input = Readable.fromWeb(response.body)
  if (gzip) await pipeline(input, createGunzip(), createWriteStream(dest))
  else await pipeline(input, createWriteStream(dest))
  const checksum = await fetcher(`${base}/${name}.sha256`, { signal: AbortSignal.timeout(120000) })
  let expected
  if (checksum.ok) {
    expected = (await checksum.text()).trim().split(/\s+/)[0]
  } else {
    const prefix = `https://github.com/${repo}/releases/download/v`
    const version = base.startsWith(prefix) ? base.slice(prefix.length) : ''
    if (checksum.status !== 404 || name !== 'dscode-plugin.tgz' || !versionPattern.test(version)) throw new Error(`missing checksum for ${name}`)
    const releaseResponse = await fetcher(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, { signal: AbortSignal.timeout(120000) })
    if (!releaseResponse.ok) throw new Error(`missing verifiable digest for ${name}: ${releaseResponse.status}`)
    const release = await releaseResponse.json()
    const asset = release.tag_name === `v${version}` && !release.draft && Array.isArray(release.assets)
      ? release.assets.find(asset => asset.name === name && asset.browser_download_url === `${base}/${name}`)
      : undefined
    const digest = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null
    if (!digest) throw new Error(`missing verifiable digest for ${name}`)
    expected = digest[1]
  }
  const hash = createHash('sha256')
  await pipeline(createReadStream(dest), hash)
  if (!/^[0-9a-f]{64}$/i.test(expected) || hash.digest('hex') !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${name}`)
}
export const extractArchive = (archive, dest) => {
  const entries = new Map()
  const contained = path => {
    if (isAbsolute(path)) throw new Error('unsafe archive path')
    const result = relative(dest, resolve(dest, path))
    if (result === '..' || result.startsWith('../')) throw new Error('unsafe archive path')
    return result
  }
  list({ file: archive, sync: true, strict: true, onReadEntry: entry => {
    if (!['File', 'OldFile', 'Directory', 'SymbolicLink', 'Link'].includes(entry.type)) throw new Error('unsupported archive entry')
    const path = contained(entry.path)
    if (entry.path.split('/').includes('..') || entries.has(path)) throw new Error('unsafe or duplicate archive path')
    entries.set(path, { type: entry.type, link: entry.linkpath })
  } })
  for (const [path, entry] of entries) {
    for (let parent = dirname(path); parent !== '.'; parent = dirname(parent)) {
      if (entries.has(parent) && entries.get(parent).type !== 'Directory') throw new Error('archive writes through non-directory entry')
    }
    if (entry.type === 'SymbolicLink' || entry.type === 'Link') {
      if (isAbsolute(entry.link)) throw new Error('unsafe archive link')
      const target = contained(entry.type === 'SymbolicLink' ? join(dirname(path), entry.link) : entry.link)
      if (entry.type === 'Link' && !['File', 'OldFile'].includes(entries.get(target)?.type)) throw new Error('unsafe archive hardlink')
    }
  }
  mkdirSync(dest, { recursive: true })
  extractTar({ file: archive, cwd: dest, sync: true, strict: true, preservePaths: false, preserveOwner: false, chmod: true })
}
export const validateRuntime = (runtime, metadata, platform = process.platform, arch = process.arch) => {
  const descriptor = json(join(runtime, 'dscode-runtime.json'))
  if (descriptor.schema !== 1 || descriptor.platform !== platform || descriptor.arch !== arch
    || descriptor.sourceCommit !== metadata.dsh.sourceCommit || descriptor.dshVersion !== metadata.dsh.testedVersion) throw new Error('runtime provenance/platform mismatch')
  if (!existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))) throw new Error('runtime CLI entrypoint missing')
  if (platform === 'linux') {
    const native = join(runtime, 'node_modules', `@deepseek-ai/node-addon-landlock-run-${platform}-${arch}`)
    const prebuilds = json(join(native, 'prebuilds.json'))
    if (prebuilds.platform !== `${platform}-${arch}` || !prebuilds.binaries?.some(binary => binary.tool === 'landlock-run' && binary.kind === 'static-musl' && binary.path === 'bin/landlock-run')) throw new Error('runtime native helper metadata mismatch')
    accessSync(join(native, 'bin', 'landlock-run'), constants.X_OK)
  }
  if (binaryVersion(join(runtime, 'bin', 'dsh')) !== metadata.dsh.testedVersion) throw new Error('runtime CLI version mismatch')
}
/** Config commits last; ordinary failures restore every moved entry. Missing staged entries are deletions. */
export const commitInstallation = (profile, stage, entries) => {
  const backup = join(stage, 'backup')
  mkdirSync(backup)
  const moved = []
  try {
    for (const entry of entries) {
      const active = join(profile, entry), prepared = join(stage, 'profile', entry), old = join(backup, entry)
      mkdirSync(dirname(active), { recursive: true })
      mkdirSync(dirname(old), { recursive: true })
      const record = { active, old, existed: !!lstatSync(active, { throwIfNoEntry: false }), installed: false }
      if (record.existed) renameSync(active, old)
      moved.push(record)
      if (existsSync(prepared)) { renameSync(prepared, active); record.installed = true }
    }
  } catch (error) {
    for (const record of moved.reverse()) {
      if (record.installed) rmSync(record.active, { recursive: true, force: true })
      if (record.existed) renameSync(record.old, record.active)
    }
    throw error
  }
}
export const installRelease = async ({ profile, packageName, version, channel, asset, fetcher = fetch, base = `https://github.com/${repo}/releases/download/v${version}` }) => {
  if (!asset) throw new Error(`unsupported platform ${process.platform}/${process.arch}`)
  mkdirSync(dirname(profile), { recursive: true })
  const stage = mkdtempSync(join(dirname(profile), '.dscode-update-'))
  const prepared = join(stage, 'profile')
  try {
    mkdirSync(join(prepared, 'bin'), { recursive: true })
    const archive = join(stage, 'plugin.tgz')
    await downloadVerified(base, 'dscode-plugin.tgz', archive, fetcher)
    extractArchive(archive, join(stage, 'plugin'))
    const unpacked = join(stage, 'plugin', 'package'), metadata = json(join(unpacked, 'package.json'))
    if (metadata.name !== packageName || metadata.version !== version || metadata.dscode?.release !== version) throw new Error('plugin product version mismatch')
    if (!versionPattern.test(metadata.dsh?.testedVersion ?? '')) throw new Error('missing exact dsh runtime version')
    const source = metadata.dsh.sourceCommit
    if (source !== undefined && !/^[0-9a-f]{40}$/.test(source)) throw new Error('invalid runtime source commit')
    const tui = join(prepared, 'bin', 'dscode')
    await downloadVerified(base, asset, tui, fetcher, true)
    chmodSync(tui, 0o755)
    if (binaryVersion(tui) !== version) throw new Error('TUI product version mismatch')
    const runtime = join(prepared, 'runtime')
    if (source) {
      const runtimeAsset = `${asset.replace('dscode-', 'dscode-runtime-')}.tar.gz`, runtimeArchive = join(stage, 'runtime.tar.gz')
      await downloadVerified(base, runtimeAsset, runtimeArchive, fetcher)
      extractArchive(runtimeArchive, runtime)
      validateRuntime(runtime, metadata)
    } else {
      run('npm', ['install', '--global', '--prefix', runtime, `@deepseek-ai/dsh@${metadata.dsh.testedVersion}`, '--omit=dev', '--no-audit', '--no-fund'])
      if (binaryVersion(join(runtime, 'bin', 'dsh')) !== metadata.dsh.testedVersion) throw new Error('runtime CLI version mismatch')
    }
    const manifestPath = join(profile, 'package.json')
    const manifest = existsSync(manifestPath) ? json(manifestPath) : { name: 'dsh-profile-dscode', private: true }
    manifest.dependencies = { ...manifest.dependencies, [packageName]: source ? `${base}/dscode-plugin.tgz` : version }
    const bundles = manifest.dsh?.profile?.bundles ?? ['@deepseek-ai/dsh-base']
    if (!bundles.includes(packageName)) bundles.push(packageName)
    manifest.dsh = { ...manifest.dsh, profile: { ...manifest.dsh?.profile, bundles } }
    const modules = join(prepared, 'node_modules')
    if (existsSync(join(profile, 'node_modules'))) cpSync(join(profile, 'node_modules'), modules, { recursive: true, verbatimSymlinks: true })
    const destination = join(modules, ...packageName.split('/'))
    rmSync(destination, { recursive: true, force: true })
    mkdirSync(dirname(destination), { recursive: true })
    cpSync(unpacked, destination, { recursive: true, verbatimSymlinks: true })
    if (source) {
      for (const dependency of Object.keys(metadata.dependencies ?? {})) {
        if (!existsSync(join(destination, 'node_modules', ...dependency.split('/'), 'package.json'))) throw new Error(`missing bundled dependency ${dependency}`)
      }
    }
    writeFileSync(join(prepared, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    if (!source) {
      run('npm', ['install', '--prefix', prepared, archive, '--omit=dev', '--legacy-peer-deps', '--no-audit', '--no-fund', '--package-lock=false'])
      writeFileSync(join(prepared, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    }
    if (!existsSync(join(destination, 'bin', 'dscode.mjs'))) throw new Error('plugin launcher missing')
    const { config } = readChannelConfig(profile)
    config.cli = { ...config.cli, channel, channel_format: 1 }
    writeFileSync(join(prepared, 'config.toml'), stringify(config))
    const entries = ['node_modules', 'package.json', 'runtime', 'bin/dscode', 'package-lock.json', 'npm-shrinkwrap.json']
    if (!existsSync(join(profile, 'cordis.patch.yml'))) {
      writeFileSync(join(prepared, 'cordis.patch.yml'), '# Your patch layer for this dsh profile\n')
      entries.push('cordis.patch.yml')
    }
    entries.push('config.toml')
    commitInstallation(profile, stage, entries)
  } finally { rmSync(stage, { recursive: true, force: true }) }
}
