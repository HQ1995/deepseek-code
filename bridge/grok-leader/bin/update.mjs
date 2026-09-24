import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { chmodSync, closeSync, constants, cpSync, createWriteStream, existsSync, fsync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { promisify } from 'node:util'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createGunzip } from 'node:zlib'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { parse, stringify } from 'smol-toml'
import { list, extract as extractTar } from 'tar'
import { nativePackages, validateNativeArtifacts } from './native-runtime.mjs'
import { atomicWrite, syncDirectory, healLauncherLink } from './launcher-files.mjs'
export { atomicWrite } from './launcher-files.mjs'

const repo = 'HQ1995/deepseek-code'
export const unsupportedPlatformMessage = (platform = process.platform, arch = process.arch) =>
  `no prebuilt dscode runtime/TUI for ${platform}/${arch}; ${platform === 'darwin' && arch === 'x64'
    ? 'on Apple Silicon, use a native arm64 Node.js >=22.19.0 and retry (check node -p process.arch). Intel Macs require a source build'
    : 'build from the repo (scripts/build-deepseek-tui.sh)'}`
export const RECOVERY_VERSION = 1
/** Anonymous GitHub API calls are capped at 60/hour per address, which a
 *  release day or a shared egress address can exhaust; use a token when the
 *  environment already provides one and stay anonymous otherwise. */
const githubAuth = () => {
  const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN
  return token ? { headers: { authorization: `Bearer ${token}` } } : {}
}
/** GitHub answers 401 for a rejected token and 403 when that token's own limit
 *  is spent; the anonymous call may still have headroom, so fall back to it. */
const githubFetch = async (url, fetcher = fetch) => {
  const auth = githubAuth()
  const response = await fetcher(url, { signal: AbortSignal.timeout(120000), ...auth })
  if (!auth.headers || ![401, 403].includes(response.status)) return response
  return fetcher(url, { signal: AbortSignal.timeout(120000) })
}
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
    const response = await githubFetch(`https://api.github.com/repos/${repo}/releases?per_page=100&page=${page}`, fetcher)
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
export const parseCliVersion = output => /(?:^|\s)(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\s|$)/.exec(output)?.[1]
const binaryVersion = path => parseCliVersion(run(path, ['--version'], { timeout: 15000 }))
export const downloadVerified = async (base, name, dest, fetcher = fetch, compressed = false) => {
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15 * 60000)])
  let idleTimer
  const activity = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(() => controller.abort(new Error(`download stalled for ${name}; retry the update`)), 120000)
  }
  activity()
  console.error(`dscode: downloading ${name}...`)
  try {
  let response = await fetcher(`${base}/${name}${compressed ? '.gz' : ''}`, { signal })
  let gzip = compressed
  if (compressed && response.status === 404) { response = await fetcher(`${base}/${name}`, { signal }); gzip = false }
  if (!response.ok) throw new Error(`missing release asset ${name}: ${response.status}`)
  if (!response.body) throw new Error(`empty release asset ${name}`)
  const input = Readable.fromWeb(response.body)
  let received = 0, progressAt = performance.now()
  input.on('data', chunk => {
    activity()
    received += chunk.length
    if (performance.now() - progressAt >= 2000) {
      console.error(`dscode: ${name}: ${(received / 1024 / 1024).toFixed(1)} MiB received`)
      progressAt = performance.now()
    }
  })
  const hash = createHash('sha256')
  const digest = new Transform({ transform(chunk, _encoding, done) { hash.update(chunk); done(null, chunk) } })
  if (gzip) await pipeline(input, createGunzip(), digest, createWriteStream(dest), { signal })
  else await pipeline(input, digest, createWriteStream(dest), { signal })
  activity()
  const checksum = await fetcher(`${base}/${name}.sha256`, { signal })
  let expected
  if (checksum.ok) {
    expected = (await checksum.text()).trim().split(/\s+/)[0]
  } else {
    const prefix = `https://github.com/${repo}/releases/download/v`
    const version = base.startsWith(prefix) ? base.slice(prefix.length) : ''
    if (checksum.status !== 404 || name !== 'dscode-plugin.tgz' || !versionPattern.test(version)) throw new Error(`missing checksum for ${name}`)
    const releaseResponse = await githubFetch(`https://api.github.com/repos/${repo}/releases/tags/v${version}`, fetcher)
    if (!releaseResponse.ok) throw new Error(`missing verifiable digest for ${name}: ${releaseResponse.status}`)
    const release = await releaseResponse.json()
    const asset = release.tag_name === `v${version}` && !release.draft && Array.isArray(release.assets)
      ? release.assets.find(asset => asset.name === name && asset.browser_download_url === `${base}/${name}`)
      : undefined
    const digest = typeof asset?.digest === 'string' ? /^sha256:([0-9a-f]{64})$/i.exec(asset.digest) : null
    if (!digest) throw new Error(`missing verifiable digest for ${name}`)
    expected = digest[1]
  }
  signal.throwIfAborted()
  if (!/^[0-9a-f]{64}$/i.test(expected) || hash.digest('hex') !== expected.toLowerCase()) throw new Error(`SHA-256 mismatch for ${name}`)
  console.error(`dscode: verified ${name}`)
  } finally { clearTimeout(idleTimer) }
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

const validateRuntimeFiles = (runtime, metadata, platform, arch) => {
  const descriptor = json(join(runtime, 'dscode-runtime.json'))
  if (descriptor.schema !== 1 || descriptor.platform !== platform || descriptor.arch !== arch
    || descriptor.sourceCommit !== metadata.dsh.sourceCommit || descriptor.dshVersion !== metadata.dsh.testedVersion
    || descriptor.sourcePatchSha256 !== metadata.dsh.sourcePatchSha256) throw new Error('runtime provenance/platform mismatch')
  if (!existsSync(join(runtime, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'))
    || !existsSync(join(runtime, 'bin', 'dsh'))) throw new Error('runtime CLI entrypoint missing')
  validateNativeArtifacts(runtime, platform, arch)
}
export const validateRuntime = (runtime, metadata, platform = process.platform, arch = process.arch) => {
  validateRuntimeFiles(runtime, metadata, platform, arch)
  if (binaryVersion(join(runtime, 'bin', 'dsh')) !== metadata.dsh.testedVersion) throw new Error('runtime CLI version mismatch')
}
const matchesInstallation = (profile, packageName, version, expectedDsh, probeVersions, tuiVersion) => {
  try {
    const plugin = join(profile, 'node_modules', ...packageName.split('/'))
    const metadata = json(join(plugin, 'package.json'))
    if (metadata.name !== packageName || metadata.version !== version
      || !existsSync(join(plugin, 'bin/dscode.mjs'))
      || !existsSync(join(profile, 'bin/dscode'))
      || (probeVersions && (tuiVersion ?? binaryVersion(join(profile, 'bin/dscode'))) !== version)) return false
    if (expectedDsh && ['testedVersion', 'sourceCommit', 'supportedRange', 'sourcePatchSha256'].some(key => metadata.dsh?.[key] !== expectedDsh[key])) return false
    const runtime = join(profile, 'runtime')
    if (metadata.dsh?.sourceCommit) validateRuntimeFiles(runtime, metadata, process.platform, process.arch)
    if (!metadata.dsh?.testedVersion || !existsSync(join(runtime, 'bin/dsh'))
      || (probeVersions && binaryVersion(join(runtime, 'bin/dsh')) !== metadata.dsh.testedVersion)) return false
    return true
  } catch { return false }
}
/** Cheap preflight only: does not prove executability or actual CLI versions.
 * Detect missing native files before trying to load the profile's lock binding. */
export const installationFilesMatch = (profile, packageName, version, expectedDsh) =>
  matchesInstallation(profile, packageName, version, expectedDsh, false)
/** Inspect the entire managed installation, including actual CLI versions. */
export const installationMatches = (profile, packageName, version, expectedDsh, tuiVersion) =>
  matchesInstallation(profile, packageName, version, expectedDsh, true, tuiVersion)
const canonicalProfile = profile => existsSync(profile) ? realpathSync(profile) : join(realpathSync(dirname(profile)), basename(profile))
const syncFd = promisify(fsync)
const syncTrees = async paths => {
  const levels = []
  const visit = (path, depth) => {
    const stat = lstatSync(path, { throwIfNoEntry: false })
    if (!stat || stat.isSymbolicLink()) return
    ;(levels[depth] ??= []).push(path)
    if (stat.isDirectory()) for (const name of readdirSync(path)) visit(join(path, name), depth + 1)
  }
  for (const path of paths) visit(path, 0)
  // macOS fsync includes a drive-cache flush. Bound concurrent descriptors to
  // the default libuv pool size, while keeping children durable before parents.
  for (const level of levels.reverse()) {
    let next = 0, failure
    const worker = async () => {
      while (next < level.length && !failure) {
        const path = level[next++]
        try {
          const fd = openSync(path, constants.O_RDONLY)
          try { await syncFd(fd) } finally { closeSync(fd) }
        } catch (error) { failure ??= error }
      }
    }
    // Drain every admitted flush before rejecting: the caller may remove the
    // staging tree and release its profile lock as soon as this settles.
    await Promise.all(Array.from({ length: Math.min(4, level.length) }, worker))
    if (failure) throw failure
  }
}
const writeJournal = (stage, transaction) => atomicWrite(join(stage, 'transaction.json'), JSON.stringify(transaction) + '\n', 0o600)
const validEntry = entry => typeof entry === 'string' && entry !== '' && !isAbsolute(entry)
  && !entry.split(/[\\/]/).some(part => part === '..' || part === '.' || part === '')
/** Only our private, identified stages are candidates for recovery or cleanup. */
const installationStages = profile => {
  let canonical
  try { canonical = canonicalProfile(profile) } catch { canonical = profile }
  // A stage can sit beside either spelling of the profile directory: an
  // updater that runs before the symlink exists stages next to the link, one
  // that runs after it stages next to the target. Resolve both spellings
  // first, because a symlinked ancestor (macOS `/var` vs `/private/var`)
  // makes two spellings of one directory, and recovering a stage twice would
  // retry a rollback whose backup is already gone.
  const parents = new Set()
  for (const parent of [dirname(profile), dirname(canonical)]) {
    try { parents.add(realpathSync(parent)) } catch { parents.add(parent) }
  }
  const stages = [], seen = new Set()
  for (const parent of parents) {
    let names
    try { names = readdirSync(parent) } catch (error) { if (error.code !== 'ENOENT') throw error; continue }
    for (const name of names) {
      if (!name.startsWith('.dscode-update-')) continue
      const stage = join(parent, name)
      const key = realpathSync(stage, { throwIfNoEntry: false }) ?? stage
      if (seen.has(key)) continue
      seen.add(key)
      try {
        const stat = lstatSync(stage)
        if (!stat.isDirectory() || stat.uid !== process.getuid()) continue
        const transaction = json(join(stage, 'transaction.json'))
        if (transaction.schema !== 1 || transaction.profile !== canonical || !Number.isInteger(transaction.pid) || transaction.pid <= 0
          || !['preparing', 'pending', 'committed', 'rolled-back'].includes(transaction.state)) continue
        if (transaction.state === 'pending' && (!Array.isArray(transaction.entries)
          || !transaction.entries.every(entry => validEntry(entry.path) && typeof entry.existed === 'boolean'))) continue
        stages.push({ stage, transaction })
      } catch (error) {
        if (error.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
      }
    }
  }
  return stages
}
/** Idempotent rollback: the journal precedes every rename; backups survive failure. */
const rollback = (profile, stage, transaction) => {
  for (const entry of [...transaction.entries].reverse()) {
    const active = join(profile, entry.path), old = join(stage, 'backup', entry.path)
    if (lstatSync(old, { throwIfNoEntry: false })) {
      rmSync(active, { recursive: true, force: true })
      mkdirSync(dirname(active), { recursive: true })
      renameSync(old, active)
      syncDirectory(dirname(active))
      syncDirectory(dirname(old))
    } else if (!entry.existed) {
      rmSync(active, { recursive: true, force: true })
      if (existsSync(dirname(active))) syncDirectory(dirname(active))
    } else if (!lstatSync(active, { throwIfNoEntry: false })) {
      throw new Error(`update recovery needs the missing backup for ${entry.path}; retained ${stage}`)
    }
  }
  writeJournal(stage, { ...transaction, state: 'rolled-back' })
}
const recoverInstallations = profile => {
  for (const { stage, transaction } of installationStages(profile)) {
    if (transaction.state === 'preparing') {
      try { process.kill(transaction.pid, 0); continue } catch (error) { if (error.code !== 'ESRCH') continue }
    }
    if (transaction.state === 'pending') {
      rollback(profile, stage, transaction)
      console.error('dscode: restored the previous installation after an interrupted update')
    }
    rmSync(stage, { recursive: true, force: true })
  }
}
/** Use the pinned runtime's existing POSIX lock binding. The persistent inode
 * lives outside the replaceable profile; process death releases its lock. */
export const withProfileLock = async (profile, action, runtime = join(profile, 'runtime')) => {
  mkdirSync(dirname(profile), { recursive: true })
  const canonical = canonicalProfile(profile)
  const runtimes = [runtime, join(canonical, 'runtime'), ...installationStages(profile)
    .flatMap(({ stage }) => [join(stage, 'backup/runtime'), join(stage, 'profile/runtime')])]
  const locations = [...runtimes.map(path => join(path, 'package.json')), import.meta.url]
  if (process.env.DSH_BIN && existsSync(process.env.DSH_BIN)) locations.push(realpathSync(process.env.DSH_BIN))
  let bindingError, locked = false
  const attempted = new Set()
  // The lock guards the profile, so a flock binding from the runtime being
  // installed or from the one already running is equally usable.
  const families = new Set(runtimes.flatMap(nativePackages))
  const specifiers = ['@deepseek-ai/node-addon-system/flock', ...[...families].map(name => `@deepseek-ai/${name}/flock`)]
  const fd = openSync(join(dirname(canonical), `.${basename(canonical)}.install.lock`), constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600)
  try {
    const deadline = performance.now() + 60000
    let announced = false
    const acquire = async tryLockExclusive => {
      for (;;) {
        try { await tryLockExclusive(fd); return true } catch (error) {
          // The pinned SDK loads .node lazily on the first lock attempt.
          // Native admission failure may try another runtime; a real flock
          // error or anything thrown by the action must never trigger fallback.
          if (error?.syscall !== 'flock' && ['ERR_DLOPEN_FAILED', 'MODULE_NOT_FOUND', 'ERR_MODULE_NOT_FOUND'].includes(error?.code)) {
            bindingError = error
            return false
          }
          if (!['EAGAIN', 'EWOULDBLOCK'].includes(error?.code)) throw error
          if (performance.now() >= deadline) throw new Error('timed out waiting for the dscode profile update; retry after it finishes', { cause: error })
          if (!announced) { console.error('dscode: waiting for the current profile update...'); announced = true }
          await delay(100)
        }
      }
    }
    for (const location of locations) {
      for (const specifier of specifiers) {
        let tryLockExclusive
        try {
          const binding = createRequire(location).resolve(specifier)
          if (attempted.has(binding)) continue
          attempted.add(binding)
          const loaded = await import(pathToFileURL(binding).href)
          if (typeof loaded.tryLockExclusive !== 'function') throw new Error('runtime lock binding has no tryLockExclusive export')
          tryLockExclusive = loaded.tryLockExclusive
        } catch (error) {
          if (bindingError === undefined || error?.code !== 'MODULE_NOT_FOUND') bindingError = error
          continue
        }
        if (await acquire(tryLockExclusive)) { locked = true; break }
      }
      if (locked) break
    }
    if (!locked) throw Object.assign(
      new Error('cannot lock dscode profile: the pinned runtime native addon is unavailable', { cause: bindingError }),
      { code: 'DSCODE_PROFILE_LOCK_UNAVAILABLE' },
    )
    recoverInstallations(profile)
    return await action()
  } finally { closeSync(fd) }
}

export const commitInstallation = (profile, stage, entries) => withProfileLock(profile, () => commit(profile, stage, entries))

export const saveUpdateChannel = (profile, channel) => withProfileLock(profile, () => {
  const { config } = readChannelConfig(profile)
  if (config.cli?.channel === channel && config.cli?.channel_format === 1) return
  config.cli = { ...config.cli, channel, channel_format: 1 }
  atomicWrite(join(profile, 'config.toml'), stringify(config))
})

/** Config commits last; ordinary failures restore every moved entry. Missing staged entries are deletions. */
const commit = async (profile, stage, entries) => {
  if (entries.some(entry => !validEntry(entry)) || new Set(entries).size !== entries.length
    || entries.some(entry => entries.some(other => other.startsWith(entry + '/')))) throw new Error('invalid installation entries')
  const backup = join(stage, 'backup')
  mkdirSync(backup)
  const transaction = { schema: 1, profile: canonicalProfile(profile), pid: process.pid, state: 'pending',
    entries: entries.map(path => ({ path, existed: !!lstatSync(join(profile, path), { throwIfNoEntry: false }) })) }
  await syncTrees(entries.map(entry => join(stage, 'profile', entry)))
  writeJournal(stage, transaction)
  try {
    for (const entry of transaction.entries) {
      const active = join(profile, entry.path), prepared = join(stage, 'profile', entry.path), old = join(backup, entry.path)
      mkdirSync(dirname(active), { recursive: true })
      mkdirSync(dirname(old), { recursive: true })
      syncDirectory(backup)
      if (entry.existed) {
        renameSync(active, old)
        syncDirectory(dirname(old))
        syncDirectory(dirname(active))
      }
      if (lstatSync(prepared, { throwIfNoEntry: false })) renameSync(prepared, active)
      syncDirectory(dirname(active))
    }
    writeJournal(stage, { ...transaction, state: 'committed' })
  } catch (error) {
    try { rollback(profile, stage, transaction) } catch (recoveryError) {
      throw new AggregateError([error, recoveryError], `installation and rollback failed; kept recovery files at ${stage}`)
    }
    throw error
  }
}
export const installRelease = async ({ profile, packageName, version, channel, asset, fetcher = fetch, base = `https://github.com/${repo}/releases/download/v${version}` }) => {
  if (!asset) throw new Error(unsupportedPlatformMessage())
  mkdirSync(dirname(profile), { recursive: true })
  const canonical = canonicalProfile(profile)
  mkdirSync(dirname(canonical), { recursive: true })
  const stage = mkdtempSync(join(dirname(canonical), '.dscode-update-'))
  writeJournal(stage, { schema: 1, profile: canonical, pid: process.pid, state: 'preparing' })
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
    if (metadata.dsh.sourcePatchSha256 !== undefined && (!source || !/^[0-9a-f]{64}$/.test(metadata.dsh.sourcePatchSha256))) throw new Error('invalid runtime source patch')
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
    // Downloads are private. Lock before reading/copying ANY active component,
    // and retain ownership through commit or rollback.
    await withProfileLock(profile, async () => {
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
    const channelChanged = config.cli?.channel !== channel || config.cli?.channel_format !== 1
    if (channelChanged) {
      config.cli = { ...config.cli, channel, channel_format: 1 }
      writeFileSync(join(prepared, 'config.toml'), stringify(config), { mode: (lstatSync(join(profile, 'config.toml'), { throwIfNoEntry: false })?.mode ?? 0o600) & 0o777 })
    }
    const entries = ['node_modules', 'package.json', 'runtime', 'bin/dscode', 'package-lock.json', 'npm-shrinkwrap.json']
    const patchPath = join(profile, 'cordis.patch.yml')
    const emptyLegacyPatch = '# Your patch layer for this dsh profile'
    if (!existsSync(patchPath) || readFileSync(patchPath, 'utf8').trim() === emptyLegacyPatch) {
      writeFileSync(join(prepared, 'cordis.patch.yml'), emptyLegacyPatch + '\n[]\n')
      entries.push('cordis.patch.yml')
    }
    if (channelChanged) entries.push('config.toml')
    // Retarget the managed link before moving its plugin directory, so the
    // next invocation can still load recovery code from this transaction.
    healLauncherLink({ profile, packageName, sourceBin: dirname(fileURLToPath(import.meta.url)) })
    await commit(profile, stage, entries)
    }, runtime)
  } finally {
    // A failed rollback can leave the only good copy here. The next lock owner
    // recovers it; ordinary preparation failures and completed commits are disposable.
    // An unreadable journal keeps the stage: recovery cannot identify it, but
    // deleting it here would also mask the original failure with a JSON error.
    let pending = true
    try { pending = json(join(stage, 'transaction.json')).state === 'pending' } catch { /* keep the stage */ }
    if (!pending) rmSync(stage, { recursive: true, force: true })
  }
}
