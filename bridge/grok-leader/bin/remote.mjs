/** `dscode remote`: turn the dscode profile of a dedicated DSH_HOME into one
 * remote workspace. That profile's leader runs every tool over one SSH
 * connection (the shipped `@hqzhao95/dscode/ssh` row); local workspaces keep
 * the default home. The rows are literals in the profile patch, so a shared
 * leader reads the same configuration whoever starts it. The patch is edited
 * as text: it may hold `!!js` entries this launcher cannot round-trip. The
 * block is found by whole marker lines only, so a value quoting a marker cannot
 * move it. Writes are atomic and take the profile lock when the home has a
 * runtime; a running leader keeps its configuration until it exits. */
import { existsSync, readFileSync } from 'node:fs'
import { posix } from 'node:path'
import { checkRemote, installedPaths } from './remote-check.mjs'

const BEGIN = '# >>> dscode remote workspace (managed by `dscode remote`; edit with care)'
const END = '# <<< dscode remote workspace'
const HASH = /^[0-9a-f]{64}$/

export const REMOTE_USAGE = `Usage: DSH_HOME=DIR dscode remote init --host ALIAS --workspace DIR --node PATH --dsh DIR [--no-check]
       DSH_HOME=DIR dscode remote status [--check]
       DSH_HOME=DIR dscode remote remove

  --host       an OpenSSH alias that connects with \`ssh -o BatchMode=yes ALIAS\` and a known host key
  --workspace  the remote directory every session works in
  --node       absolute path to Node 22 or newer on the host
  --dsh        the remote directory where @deepseek-ai/dsh-ssh and @deepseek-ai/dsh-ptc-runtime-node
               of this dscode's DSH release are npm-installed (or give --helper and --bootstrap)
  --helper-hash, --bootstrap-hash
               digests to pin; they default to this dscode's own copies of those files
  --no-check   write the profile without connecting to the host first`

const FLAGS = { '--host': 'host', '--workspace': 'workspace', '--node': 'node', '--dsh': 'dshDir', '--helper': 'helper', '--helper-hash': 'helperHash',
  '--bootstrap': 'bootstrapPath', '--bootstrap-hash': 'bootstrapHash' }

const absolute = value => {
  if (!posix.isAbsolute(value) || /[\0\n\r]/.test(value)) throw new Error(`remote paths must be absolute POSIX paths: ${value}`)
  return posix.normalize(value)
}

/** Parse and validate `init` flags. `--dsh` names the remote npm directory of
 * both packages; digests default to `local` (this dscode's runtime copies). */
export function remoteConfig(args, local) {
  const config = {}
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '--no-check') continue
    const key = FLAGS[args[index]]
    const value = args[index + 1]
    if (key === undefined) throw new Error(`unknown option ${args[index]}\n${REMOTE_USAGE}`)
    if (value === undefined || value.startsWith('--')) throw new Error(`${args[index]} needs a value\n${REMOTE_USAGE}`)
    if (config[key] !== undefined) throw new Error(`${args[index]} was given twice`)
    config[key] = value
    index++
  }
  if (config.dshDir !== undefined) {
    if (config.helper !== undefined || config.bootstrapPath !== undefined) throw new Error('give either --dsh or --helper and --bootstrap, not both')
    Object.assign(config, installedPaths(absolute(config.dshDir).replace(/(.)\/$/, '$1')))
    delete config.dshDir
  }
  config.helperHash ??= local?.helperHash
  config.bootstrapHash ??= local?.bootstrapHash
  const missing = ['--host', '--workspace', '--node'].filter(flag => config[FLAGS[flag]] === undefined)
  if (config.helper === undefined || config.bootstrapPath === undefined) missing.push('--dsh (or --helper and --bootstrap)')
  if (config.helperHash === undefined || config.bootstrapHash === undefined) {
    missing.push('--helper-hash and --bootstrap-hash (this home has no DSH runtime to take them from)')
  }
  if (missing.length > 0) throw new Error(`missing ${missing.join(', ')}\n${REMOTE_USAGE}`)
  // An alias is passed to ssh as one argument; it must not read as an option.
  if (!/^[A-Za-z0-9._@-]+$/.test(config.host) || config.host.startsWith('-')) throw new Error(`--host must be an OpenSSH alias: ${config.host}`)
  for (const key of ['workspace', 'node', 'helper', 'bootstrapPath']) config[key] = absolute(config[key])
  if (config.workspace.length > 1 && config.workspace.endsWith('/')) config.workspace = config.workspace.slice(0, -1)
  for (const key of ['helperHash', 'bootstrapHash']) {
    config[key] = config[key].toLowerCase()
    if (!HASH.test(config[key])) throw new Error(`${key === 'helperHash' ? '--helper-hash' : '--bootstrap-hash'} must be a SHA-256 hex digest`)
  }
  return config
}

const quote = value => JSON.stringify(value)

/** The managed rows: remote providers replace the local ones as a unit. */
export function remoteBlock(config) {
  return [BEGIN,
    ...['subprocess', 'sandbox', 'fs-sandbox', 'ptc-runtime'].flatMap(id => [`- id: ${id}`, '  disabled: true']),
    '- id: sandbox-policy', '  config:', '    mode: workspace-write', `    workspaceRoot: ${quote(config.workspace)}`,
    '- insert:', '    - id: dscode-ssh', "      name: '@hqzhao95/dscode/ssh'", '      config:',
    ...['host', 'node', 'helper', 'helperHash', 'workspace', 'bootstrapPath', 'bootstrapHash'].map(key => `        ${key}: ${quote(config[key])}`),
    END].join('\n') + '\n'
}

/** Offset of the line that is exactly `marker`, or -1. */
const markerLine = (text, marker) => {
  const match = new RegExp('^' + marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'm').exec(text)
  return match === null ? -1 : match.index
}

const withoutBlock = text => {
  const start = markerLine(text, BEGIN), end = markerLine(text, END)
  if (start === -1 && end === -1) return { text, found: false }
  if (start === -1 || end < start) throw new Error('the profile patch has a damaged dscode remote block; fix it by hand')
  return { text: text.slice(0, start) + text.slice(end + END.length).replace(/^\n/, ''), found: true }
}

const entryLines = text => text.split('\n').filter(line => line.trim() !== '' && !line.trimStart().startsWith('#'))

/** Insert or replace the managed block. Only an empty (`[]`) or block-style
 * patch is edited; anything else is left for the user. */
export function applyRemote(text, config) {
  const base = withoutBlock(text).text
  const entries = entryLines(base)
  if (entries.length === 1 && entries[0].trim() === '[]') {
    return base.replace(/^\s*\[\]\s*$/m, '').replace(/\n*$/, '\n') + remoteBlock(config)
  }
  if (entries.length > 0 && !entries[0].startsWith('- ')) {
    throw new Error('the profile patch is not a block-style list; add the rows from `dscode remote init --print` by hand')
  }
  return base.replace(/\n*$/, '\n') + remoteBlock(config)
}

/** Remove the managed block; an emptied patch becomes `[]` again. */
export function removeRemote(text) {
  const { text: base, found } = withoutBlock(text)
  if (!found) return { text, removed: false }
  return { text: entryLines(base).length === 0 ? base.replace(/\n*$/, '\n') + '[]\n' : base, removed: true }
}

/** The managed configuration's identity, when this profile is remote. */
export function remoteStatus(text) {
  const settings = remoteSettings(text)
  return settings === undefined ? undefined : { host: settings.host, workspace: settings.workspace, helperHash: settings.helperHash }
}

/** Every configured value, for a connection check of an existing profile. */
export function remoteSettings(text) {
  const start = markerLine(text, BEGIN), end = markerLine(text, END)
  if (start === -1 || end < start) return undefined
  const block = text.slice(start, end)
  const value = key => { const match = new RegExp(`^ {8}${key}: (".*")$`, 'm').exec(block); return match === null ? undefined : JSON.parse(match[1]) }
  return Object.fromEntries(['host', 'workspace', 'node', 'helper', 'helperHash', 'bootstrapPath', 'bootstrapHash'].map(key => [key, value(key)]))
}

/**
 * Run `dscode remote <init|status|remove>` against one profile directory.
 * @param options.local - this dscode's helper digests and DSH version, when a runtime is installed.
 * @param options.probe - the SSH probe (tests replace it).
 */
export async function remoteCommand(args, { profileDir, dedicatedHome, withLock, scaffold, write, log, local, probe }) {
  const [verb, ...rest] = args
  const patchPath = `${profileDir}/cordis.patch.yml`
  if (verb === undefined || ['help', '--help', '-h'].includes(verb)) {
    log(REMOTE_USAGE)
    return
  }
  const install = dir => local === undefined ? undefined : { dir, version: local.version }
  const connected = (config, dir) => {
    const checked = checkRemote(config, { install: install(dir), ...probe === undefined ? {} : { probe } })
    return { ...checked, text: `Checked ssh ${config.host}: Node ${checked.node}, the workspace, and a helper and bootstrap matching this dscode.` }
  }
  if (verb === 'status' && (rest.length === 0 || (rest.length === 1 && rest[0] === '--check'))) {
    const text = existsSync(patchPath) ? readFileSync(patchPath, 'utf8') : ''
    const status = remoteStatus(text)
    log(status === undefined ? `${profileDir}: local workspace profile` : `${profileDir}: remote workspace ssh ${status.host}:${status.workspace} (helper sha256 ${status.helperHash})`)
    if (status !== undefined && rest[0] === '--check') {
      const settings = remoteSettings(text), checked = connected(settings)
      log(checked.text)
      if (checked.workspace !== settings.workspace) log(`${settings.workspace} resolves to ${checked.workspace} on ${settings.host}; run \`dscode remote init\` again to store that path.`)
    }
    return
  }
  if (verb === 'init' && rest[0] === '--print') {
    log(remoteBlock(remoteConfig(rest.slice(1), local)))
    return
  }
  if (!dedicatedHome) {
    throw new Error('use a dedicated DSH_HOME for each remote workspace (for example DSH_HOME=~/.dsh-remote/<name>); the default home keeps local workspaces')
  }
  if (verb === 'init') {
    const config = remoteConfig(rest, local)
    // Fail here, where the fix is obvious, rather than at the first session.
    if (!rest.includes('--no-check')) {
      const checked = connected(config, rest.includes('--dsh') ? rest[rest.indexOf('--dsh') + 1] : undefined)
      log(checked.text)
      // Remote tools report resolved paths, so store the one they will see.
      if (checked.workspace !== config.workspace) {
        log(`Using ${checked.workspace}, the path ${config.workspace} resolves to on ${config.host}.`)
        config.workspace = checked.workspace
      }
    }
    await withLock(async () => {
      scaffold()
      write(patchPath, applyRemote(readFileSync(patchPath, 'utf8'), config))
    })
    log(`${profileDir} now runs tools in ssh ${config.host}:${config.workspace}. Start it with DSH_HOME set to the same home; a running leader keeps its old configuration until it exits.`)
    return
  }
  if (verb === 'remove' && rest.length === 0) {
    const removed = await withLock(async () => {
      const next = existsSync(patchPath) ? removeRemote(readFileSync(patchPath, 'utf8')) : { removed: false }
      if (next.removed) write(patchPath, next.text)
      return next.removed
    })
    log(removed ? `${profileDir} is a local workspace profile again; restart its leader.` : `${profileDir}: local workspace profile`)
    return
  }
  throw new Error(REMOTE_USAGE)
}
